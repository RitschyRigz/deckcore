"""
WaveLinkDirect — schlanker JSON-RPC-Client für die lokale Wave-Link-Audio-App.

Damit kann eine Standalone-Host-App die Audio-Mischpult-App DIREKT steuern
(Mix-/Channel-Level, Mute, Monitor-Hauptausgang) und ihre Live-Pegel (VU-Meter)
auslesen — ohne externe SDKs. Der Client ist absichtlich generisch (kein Wissen über
eine konkrete Host-App) und host-agnostisch.

Protokoll (reverse-engineered, stabil seit App-Version 3.x):
  • Transport: WebSocket, JSON-RPC 2.0.
  • Port: dynamisch — steht in ``ws-info.json`` im LocalState der App (MSIX-Paket).
    Fallback: Port-Scan eines kleinen Bereichs. Override via ENV/Konstruktor möglich.
  • Handshake: der Server verlangt den Origin-Header ``streamdeck://`` (CORS-Allowlist),
    sonst lehnt er den WebSocket-Upgrade ab.
  • Der Server PUSHT fortlaufend ``levelMeterChanged`` (L/R-Pegel je Mix/Channel) — die
    Quelle der VU-Meter. Zustands-Änderungen kommen als ``*Changed``-Notifications.

Eigenschaften (analog ``ObsDirect``):
  • LAZY: ``websocket`` (websocket-client) wird erst beim ersten echten Zugriff importiert.
  • Hintergrund-Reader-Thread: hält EINE Verbindung, korreliert Antworten per JSON-RPC-id
    und verarbeitet die Push-Notifications (Meter/Statuswechsel) — thread-safe.
  • Reconnect-Cooldown: schlägt der Connect fehl (App aus), wird eine Weile nicht erneut
    verbunden -> kein Connect-Sturm, kein Hängen.
  • Idle-Stop: ist eine Weile niemand mehr interessiert (kein Zugriff), trennt der Reader
    die Verbindung und beendet sich -> kein Dauer-Stream ohne Zuhörer (Effizienz).
  • Graceful: jede Methode fängt Fehler ab und liefert ein klares Ergebnis statt zu werfen.
"""
from __future__ import annotations

import glob
import json
import logging
import os
import threading
import time
from typing import Any, Optional

log = logging.getLogger("deckcore.wavelink")

# Der Server verlangt diesen Origin beim WebSocket-Upgrade (sonst HTTP 4xx -> kein Connect).
_ORIGIN = "streamdeck://"
_DEFAULT_HOST = "127.0.0.1"
_FALLBACK_PORTS = tuple(range(1884, 1894))   # Scan-Bereich, falls ws-info.json fehlt
_CONNECT_TIMEOUT = 2.0      # s — WebSocket-Verbindungs-/Validierungs-Timeout
_REQ_TIMEOUT = 3.0          # s — Antwort-Timeout für getX-Anfragen
_RECONNECT_COOLDOWN = 8.0   # s — nach Connect-Fehler so lange nicht erneut verbinden
_IDLE_TIMEOUT = 30.0        # s — ohne Zugriff Verbindung trennen (kein Dauer-Meter-Stream)
_STATE_TTL = 1.5            # s — Cache für getMixes/getChannels/getOutputDevices
_METER_FRESH = 0.6         # s — älter ⇒ Meter gilt als 0 (kein eingefrorener Ausschlag)


def _clamp01(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f < 0 else 1.0 if f > 1 else f


class WaveLinkDirect:
    """Direkter Wave-Link-JSON-RPC-Client (Reader-Thread, thread-safe, Reconnect-Cooldown)."""

    def __init__(self, host: str = _DEFAULT_HOST, port: int | None = None,
                 package_glob: str = "Elgato.WaveLink_*"):
        self._host = str(host or _DEFAULT_HOST)
        self._port_override = int(port) if port else None
        self._pkg_glob = package_glob
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._stop = threading.Event()
        self._conn_evt = threading.Event()       # gesetzt, sobald verbunden + validiert
        self._reader: Optional[threading.Thread] = None
        self._ws = None
        self._port: Optional[int] = None          # tatsächlich verbundener Port
        self._app: dict = {}                      # getApplicationInfo-Ergebnis
        self._last_fail = 0.0
        self._last_access = 0.0
        self._lib_ok: Optional[bool] = None
        self._id = 0
        self._inline_id = -1                      # negative ids für Inline-Requests (vor dem Dispatch-Loop)
        self._pending: dict[int, tuple[threading.Event, dict]] = {}
        self._meters: dict[str, dict] = {}        # id -> {l, r, ts}
        self._cache: dict[str, tuple[Any, float]] = {}   # mixes/channels/outputs -> (val, ts)

    # ── Konfiguration ────────────────────────────────────────────────────
    def configure(self, host: str | None = None, port: int | None = None) -> None:
        """Host/Port ändern -> Verbindung verwerfen (nächster Zugriff verbindet neu).
        ``port=0`` setzt den Override zurück (wieder Auto-Discovery)."""
        with self._lock:
            if host is not None:
                self._host = str(host or _DEFAULT_HOST)
            if port is not None:
                self._port_override = int(port) if port else None
            self._teardown()
            self._last_fail = 0.0

    # ── Lib / Port-Discovery ─────────────────────────────────────────────
    def _lib_available(self) -> bool:
        if self._lib_ok is None:
            try:
                import websocket  # noqa: F401  (websocket-client)
                self._lib_ok = True
            except Exception:  # noqa: BLE001
                self._lib_ok = False
        return self._lib_ok

    def _info_port(self) -> Optional[int]:
        """Port aus ws-info.json (LocalState des MSIX-Pakets) lesen. None wenn nicht da."""
        env = os.environ.get("DECK_WAVELINK_PORT")
        if env and env.isdigit():
            return int(env)
        env_file = os.environ.get("DECK_WAVELINK_INFO")
        candidates = [env_file] if env_file else []
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates += sorted(glob.glob(os.path.join(
                local, "Packages", self._pkg_glob, "LocalState", "ws-info.json")))
        for path in candidates:
            try:
                with open(path, "r", encoding="utf-8-sig") as fh:
                    p = json.load(fh).get("port")
                if isinstance(p, int) and p > 0:
                    return p
            except Exception:  # noqa: BLE001
                continue
        return None

    def _candidate_ports(self) -> list[int]:
        if self._port_override:
            return [self._port_override]
        out: list[int] = []
        info = self._info_port()
        if info:
            out.append(info)
        out += [p for p in _FALLBACK_PORTS if p != info]
        return out

    # ── Reader-Thread / Verbindungs-Lifecycle ────────────────────────────
    def _ensure_started(self) -> None:
        """Reader-Thread starten, falls nicht aktiv und nicht im Cooldown."""
        with self._lock:
            self._last_access = time.monotonic()
            if self._reader is not None and self._reader.is_alive():
                return
            if not self._lib_available():
                return
            if self._last_fail and (time.monotonic() - self._last_fail) < _RECONNECT_COOLDOWN:
                return
            self._stop.clear()
            self._conn_evt.clear()
            self._reader = threading.Thread(target=self._reader_loop, name="wavelink-reader",
                                            daemon=True)
            self._reader.start()

    def _try_connect(self):
        """Ersten Kandidaten-Port finden, der echt mit der Wave-Link-API antwortet
        (validiert via getApplicationInfo -> schützt vor falschen WS-Servern auf Nachbarports)."""
        from websocket import create_connection
        for port in self._candidate_ports():
            ws = None
            try:
                ws = create_connection(f"ws://{self._host}:{port}", timeout=_CONNECT_TIMEOUT,
                                       origin=_ORIGIN)
                app = self._handshake(ws)
                if app and app.get("appID"):
                    with self._lock:
                        self._app = app
                        self._port = port
                    log.info("Wave Link verbunden auf Port %s (%s %s)", port,
                             app.get("name"), app.get("version"))
                    return ws
                ws.close()
            except Exception:  # noqa: BLE001
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:  # noqa: BLE001
                        pass
        return None

    def _inline_request(self, ws, method: str, params: Any = None,
                        timeout: float = _CONNECT_TIMEOUT) -> Optional[Any]:
        """Synchroner Request VOR dem Dispatch-Loop (eigenes Inline-Lesen, KEIN _pending/Reader →
        kein Self-Deadlock). Negative ids, damit sie nie mit echten _request-ids kollidieren.
        Notifications (Meter) werden dabei übersprungen."""
        rid = self._inline_id
        self._inline_id -= 1
        req = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            req["params"] = params
        ws.send(json.dumps(req))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ws.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                obj = json.loads(ws.recv())
            except Exception:  # noqa: BLE001
                return None
            if obj.get("id") == rid:
                return obj.get("result") if "error" not in obj else None
        return None

    def _handshake(self, ws) -> Optional[dict]:
        """getApplicationInfo synchron abfragen — bestätigt, dass dies der Wave-Link-Endpoint ist."""
        return self._inline_request(ws, "getApplicationInfo")

    def _init_subscriptions(self, ws) -> None:
        """Direkt nach Connect: Live-Pegel (``levelMeterChanged``) für ALLE Channels UND Mixes
        abonnieren. Wave Link (per Live-Probe an 3.2.x verifiziert) pusht von sich aus KEINE
        Meter — jedes Ziel muss explizit abonniert werden, sonst bleibt seine VU-Säule tot:
          • Channels (Hardware Mic/Capture-Card UND Software-App-Channels) → ``type="channel"``;
            der Pegel kommt danach unter der normalen Channel-id im ``channels``-Array. ``input``
            schicken wir zusätzlich mit (No-op für Software, kostet nichts) — so bleiben die schon
            laufenden Hardware-Meter garantiert unverändert.
          • Mixes (Personal/Stream/Game-Out/… Busse) → ``type="mix"`` (Pegel im ``mixes``-Array).
            Genau das fehlte bisher: Mix-Fader (z. B. „Mic Only") schlugen nie aus.
        Additiv + idempotent. Synchron VOR dem Dispatch-Loop (Inline-Reads, exklusiv)."""
        def _sub(tid: str, typ: str) -> None:
            self._inline_id -= 1
            ws.send(json.dumps({"jsonrpc": "2.0", "id": self._inline_id, "method": "setSubscription",
                                "params": {"levelMeterChanged": {"id": tid, "subId": "",
                                                                 "isEnabled": True, "type": typ}}}))
        try:
            for c in (self._inline_request(ws, "getChannels") or {}).get("channels", []):
                cid = c.get("id")
                if cid:
                    for typ in ("input", "channel"):   # Hardware + Software metern unter type="channel"
                        _sub(cid, typ)
            for m in (self._inline_request(ws, "getMixes") or {}).get("mixes", []):
                mid = m.get("id")
                if mid:
                    _sub(mid, "mix")                   # Mixes senden NUR mit explizitem type="mix"
        except Exception:  # noqa: BLE001
            pass

    def _reader_loop(self) -> None:
        ws = self._try_connect()
        if ws is None:
            with self._lock:
                self._last_fail = time.monotonic()
            return
        with self._lock:
            self._ws = ws
        self._init_subscriptions(ws)     # Hardware-Input-Meter (Mic/Capture) abonnieren — exklusiv, vor dem Dispatch
        self._conn_evt.set()
        try:
            while not self._stop.is_set():
                ws.settimeout(1.0)
                try:
                    raw = ws.recv()
                except Exception as e:  # noqa: BLE001
                    if _is_timeout(e):
                        if (time.monotonic() - self._last_access) > _IDLE_TIMEOUT:
                            break          # niemand mehr interessiert -> Verbindung schließen
                        continue
                    break                  # echter Verbindungsfehler
                if raw:
                    self._dispatch(raw)
        finally:
            self._conn_evt.clear()
            with self._lock:
                self._ws = None
                self._meters.clear()
                # ausstehende Anfragen freigeben (sonst hängen Wartende bis Timeout)
                for evt, _slot in self._pending.values():
                    evt.set()
                self._pending.clear()
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

    def _teardown(self) -> None:
        self._stop.set()
        self._conn_evt.clear()
        w = self._ws
        self._ws = None
        if w is not None:
            try:
                w.close()
            except Exception:  # noqa: BLE001
                pass

    # ── Nachrichten-Dispatch ─────────────────────────────────────────────
    def _dispatch(self, raw: str) -> None:
        try:
            obj = json.loads(raw)
        except Exception:  # noqa: BLE001
            return
        rid = obj.get("id")
        if rid is not None and "method" not in obj:        # JSON-RPC-Antwort
            with self._lock:
                pend = self._pending.pop(rid, None)
            if pend:
                evt, slot = pend
                slot["result"] = None if "error" in obj else obj.get("result")
                slot["error"] = obj.get("error")
                evt.set()
            return
        method = obj.get("method")                         # Notification
        if method == "levelMeterChanged":
            self._update_meters(obj.get("params") or {})
        elif method and method.endswith("Changed"):
            with self._lock:                               # Zustand evtl. veraltet -> neu holen
                self._cache.clear()

    def _update_meters(self, params: dict) -> None:
        now = time.monotonic()
        upd = {}
        for key in ("mixes", "channels", "inputs", "outputs", "localMixes", "streamMixes"):
            for it in params.get(key) or []:
                i = it.get("id")
                if i:
                    upd[i] = {"l": it.get("levelLeftPercentage"),
                              "r": it.get("levelRightPercentage"), "ts": now}
        if upd:
            with self._lock:
                self._meters.update(upd)

    # ── JSON-RPC senden ──────────────────────────────────────────────────
    def _request(self, method: str, params: Any = None, timeout: float = _REQ_TIMEOUT) -> Any:
        """Anfrage MIT Antwort (getX). None bei Fehler/Timeout/nicht verbunden."""
        self._ensure_started()
        if not self._conn_evt.wait(timeout):
            return None
        evt, slot = threading.Event(), {}
        with self._lock:
            self._id += 1
            rid = self._id
            self._pending[rid] = (evt, slot)
        req = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            req["params"] = params
        try:
            with self._send_lock:
                ws = self._ws
                if ws is None:
                    raise RuntimeError("nicht verbunden")
                ws.send(json.dumps(req))
        except Exception:  # noqa: BLE001
            with self._lock:
                self._pending.pop(rid, None)
            return None
        if not evt.wait(timeout):
            with self._lock:
                self._pending.pop(rid, None)
            return None
        return slot.get("result")

    def _command(self, method: str, params: Any = None) -> bool:
        """setX-Befehl als JSON-RPC-Request MIT id senden (die App ignoriert id-lose
        Notifications). Eine evtl. Antwort wird kurz abgewartet, um Fehler zu erkennen;
        bleibt sie aus, gilt der Befehl trotzdem als gesendet. True = ok."""
        self._ensure_started()
        if not self._conn_evt.wait(_REQ_TIMEOUT):
            return False
        evt, slot = threading.Event(), {}
        with self._lock:
            self._id += 1
            rid = self._id
            self._pending[rid] = (evt, slot)
        req = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            req["params"] = params
        try:
            with self._send_lock:
                ws = self._ws
                if ws is None:
                    raise RuntimeError("nicht verbunden")
                ws.send(json.dumps(req))
        except Exception:  # noqa: BLE001
            with self._lock:
                self._pending.pop(rid, None)
            return False
        ok = True
        if evt.wait(1.0):                   # Antwort da → auf Fehler prüfen
            ok = slot.get("error") is None
        with self._lock:
            self._pending.pop(rid, None)
            self._cache.clear()             # frisch geschriebener Wert ⇒ Cache verwerfen
        return ok

    # ── Status / Lesen ───────────────────────────────────────────────────
    def status(self, probe: bool = False) -> dict:
        """Verbindungs-/App-Status. ``probe=True`` erzwingt einen Verbindungsversuch
        (für einen „Testen"-Knopf — hebt den Cooldown auf)."""
        base = {"available": self._lib_available(), "host": self._host}
        if probe:
            with self._lock:
                self._last_fail = 0.0
            self._ensure_started()
            self._conn_evt.wait(_CONNECT_TIMEOUT + 0.5)
        connected = self._conn_evt.is_set()
        return {**base, "connected": connected, "port": self._port,
                "app": self._app if connected else {}}

    def app_info(self) -> dict:
        return dict(self._app) if self._conn_evt.is_set() else {}

    def _cached(self, kind: str, method: str, extract, ttl: float = _STATE_TTL) -> Any:
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(kind)
        if hit is not None and (now - hit[1]) < ttl:
            return hit[0]
        res = self._request(method)
        val = extract(res) if res is not None else (hit[0] if hit else None)
        with self._lock:
            self._cache[kind] = (val, now)
        return val

    def mixes(self) -> list:
        """Liste der Mixes/Busse: [{id,name,level,isMuted,image}]."""
        return self._cached("mixes", "getMixes",
                            lambda r: r.get("mixes", []) or []) or []

    def channels(self, with_images: bool = False) -> list:
        """Liste der Input-Channels inkl. Master-Level + per-Mix-Sends. Das große Base64-
        Icon (``image.imgData``) wird standardmäßig entfernt (klein halten)."""
        ch = self._cached("channels", "getChannels",
                          lambda r: r.get("channels", []) or []) or []
        if with_images:
            return ch
        out = []
        for c in ch:
            d = dict(c)
            if isinstance(d.get("image"), dict) and "imgData" in d["image"]:
                d = {**d, "image": {k: v for k, v in d["image"].items() if k != "imgData"}}
            out.append(d)
        return out

    def _outputs_raw(self) -> dict:
        return self._cached("outputs", "getOutputDevices", lambda r: r or {}) or {}

    def outputs(self) -> list:
        """Liste der Ausgabegeräte: [{id,name,deviceType,outputs:[...]}]."""
        return self._outputs_raw().get("outputDevices", []) or []

    def main_output(self) -> dict:
        """Aktueller Monitor-Hauptausgang: {outputDeviceId, outputId}."""
        return self._outputs_raw().get("mainOutput", {}) or {}

    def meter(self, target_id: str) -> Optional[float]:
        """Aktueller VU-Pegel (max(L,R), 0..1) eines Mix/Channel. None wenn unbekannt,
        0.0 wenn der letzte Ausschlag zu alt ist (kein eingefrorener Balken)."""
        with self._lock:
            m = self._meters.get(target_id)
        if not m:
            return None
        if (time.monotonic() - m["ts"]) > _METER_FRESH:
            return 0.0
        l, r = m.get("l") or 0.0, m.get("r") or 0.0
        return max(float(l), float(r))

    def meters(self, ids: Optional[list] = None) -> dict:
        """Alle aktuellen VU-Pegel {id: 0..1} (zu alte ⇒ 0.0) — das Frontend pollt das schnell
        für die Fader-/VU-Kacheln. ``ids`` filtert optional auf bestimmte Ziele."""
        now = time.monotonic()
        with self._lock:
            items = list(self._meters.items())
        out = {}
        for i, m in items:
            if ids and i not in ids:
                continue
            if (now - m["ts"]) > _METER_FRESH:
                out[i] = 0.0
                continue
            out[i] = max(float(m.get("l") or 0.0), float(m.get("r") or 0.0))
        return {"meters": out}

    # ── Einzel-Lookups (für Monitore: Regler-Stand + Mute-Status) ────────
    def _find_mix(self, mix_id: str) -> Optional[dict]:
        return next((m for m in self.mixes() if m.get("id") == mix_id), None)

    def _find_channel(self, channel_id: str) -> Optional[dict]:
        return next((c for c in self.channels() if c.get("id") == channel_id), None)

    def mix_level(self, mix_id: str) -> Optional[int]:
        m = self._find_mix(mix_id)
        return None if m is None else round(float(m.get("level") or 0) * 100)

    def mix_muted(self, mix_id: str) -> Optional[bool]:
        m = self._find_mix(mix_id)
        return None if m is None else bool(m.get("isMuted"))

    def channel_level(self, channel_id: str, mix_id: str = "") -> Optional[int]:
        c = self._find_channel(channel_id)
        if c is None:
            return None
        if mix_id and mix_id != "all":
            snd = next((x for x in c.get("mixes", []) if x.get("id") == mix_id), None)
            return None if snd is None else round(float(snd.get("level") or 0) * 100)
        return round(float(c.get("level") or 0) * 100)

    def channel_muted(self, channel_id: str, mix_id: str = "") -> Optional[bool]:
        c = self._find_channel(channel_id)
        if c is None:
            return None
        if mix_id and mix_id != "all":
            snd = next((x for x in c.get("mixes", []) if x.get("id") == mix_id), None)
            return None if snd is None else bool(snd.get("isMuted"))
        return bool(c.get("isMuted"))

    def snapshot(self, with_images: bool = False) -> dict:
        """Kompletter Lesezustand {app, mixes, channels, outputDevices, mainOutput} —
        für Editor-Auswahllisten und den Preset-Generator."""
        outs = self._outputs_raw()
        return {
            "app": self.app_info(),
            "mixes": self.mixes(),
            "channels": self.channels(with_images=with_images),
            "outputDevices": outs.get("outputDevices", []) or [],
            "mainOutput": outs.get("mainOutput", {}) or {},
        }

    # ── Setter ───────────────────────────────────────────────────────────
    def _mix_payload(self, mix_id: str, **fields) -> dict:
        """setMix-Payload wie die Referenz-App: {id, ...} plus redundantes ``mixId`` für
        einen konkreten Mix (nur ``id`` allein greift nicht); ``all`` ohne mixId."""
        p = {"id": mix_id, **fields}
        if mix_id and mix_id != "all":
            p["mixId"] = mix_id
        return p

    def set_mix_level(self, mix_id: str, level: float) -> dict:
        ok = self._command("setMix", self._mix_payload(mix_id, level=_clamp01(level)))
        return {"success": ok, "message": f"Mix {mix_id} -> {round(_clamp01(level) * 100)}%"}

    def set_mix_mute(self, mix_id: str, muted: Optional[bool] = None) -> dict:
        if muted is None:
            cur = next((m for m in self.mixes() if m.get("id") == mix_id), None)
            muted = not bool(cur.get("isMuted")) if cur else True
        ok = self._command("setMix", self._mix_payload(mix_id, isMuted=bool(muted)))
        return {"success": ok, "muted": bool(muted),
                "message": f"Mix {mix_id}: {'stumm' if muted else 'an'}"}

    def set_channel_level(self, channel_id: str, level: float, mix_id: str = "") -> dict:
        p: dict = {"id": channel_id}
        if mix_id and mix_id != "all":
            p["mixes"] = [{"id": mix_id, "level": _clamp01(level)}]
        else:
            p["level"] = _clamp01(level)
        ok = self._command("setChannel", p)
        return {"success": ok, "message": f"Channel {channel_id} -> {round(_clamp01(level) * 100)}%"}

    def set_channel_mute(self, channel_id: str, muted: Optional[bool] = None,
                         mix_id: str = "") -> dict:
        if muted is None:
            cur = next((c for c in self.channels() if c.get("id") == channel_id), None)
            if mix_id and mix_id != "all" and cur:
                snd = next((x for x in cur.get("mixes", []) if x.get("id") == mix_id), None)
                muted = not bool(snd.get("isMuted")) if snd else True
            else:
                muted = not bool(cur.get("isMuted")) if cur else True
        p: dict = {"id": channel_id}
        if mix_id and mix_id != "all":
            p["mixes"] = [{"id": mix_id, "isMuted": bool(muted)}]
        else:
            p["isMuted"] = bool(muted)
        ok = self._command("setChannel", p)
        return {"success": ok, "muted": bool(muted),
                "message": f"Channel {channel_id}: {'stumm' if muted else 'an'}"}

    def set_main_output(self, output_device_id: str, output_id: str = "") -> dict:
        oid = output_id or output_device_id
        ok = self._command("setOutputDevice",
                          {"mainOutput": {"outputDeviceId": output_device_id, "outputId": oid}})
        return {"success": ok, "message": f"Hauptausgang -> {output_device_id}"}

    def is_main_output(self, output_device_id: str) -> Optional[bool]:
        """True, wenn dieses Gerät aktuell der Monitor-Hauptausgang ist (für das Statuslicht)."""
        main = self.main_output()
        if not main:
            return None
        return main.get("outputDeviceId") == output_device_id

    def close(self) -> None:
        with self._lock:
            self._teardown()


# ── Modul-Helfer ─────────────────────────────────────────────────────────
def _is_timeout(e: Exception) -> bool:
    try:
        from websocket import WebSocketTimeoutException
        if isinstance(e, WebSocketTimeoutException):
            return True
    except Exception:  # noqa: BLE001
        pass
    return isinstance(e, (TimeoutError,)) or "timed out" in str(e).lower()
