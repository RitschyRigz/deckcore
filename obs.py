"""
ObsDirect — schlanker, synchroner obs-websocket-v5-Client für den DeckCore-Kern.

Damit kann eine Standalone-Host-App OBS DIREKT steuern (Szene wechseln, Quelle ein-/
ausblenden, Stream/Aufnahme), ohne einen HTTP-Selfcall an eine größere Host-App. Der
Client ist absichtlich generisch (kein Wissen über eine konkrete Host-App) und
host-agnostisch — Zugangsdaten kommen über den Konstruktor / ``configure()``.

Eigenschaften:
  • LAZY: ``obsws_python`` wird erst beim ersten echten OBS-Zugriff importiert — ``import
    deckcore.obs`` zieht die Lib NICHT (Kern bleibt schlank + überall importierbar).
  • Persistente Verbindung (ein ``ReqClient``), wiederverwendet über einen Lock — die
    Deck-Aktionen (press) UND die Monitor-Auswertung (Eval-Loop) laufen synchron in Threads.
  • Reconnect-Cooldown: schlägt der Connect fehl (OBS aus / WS-Port zu / falsches Passwort),
    wird für ``_RECONNECT_COOLDOWN`` Sekunden NICHT erneut verbunden → kein Hängen des Decks
    und kein Connect-Sturm, wenn OBS gerade nicht läuft.
  • Graceful: jede Methode fängt Fehler ab und liefert ein klares Ergebnis statt zu werfen.
    Request-Fehler (z.B. „Quelle nicht in dieser Szene") trennen die Verbindung NICHT;
    nur echte Verbindungsfehler lösen Drop + Cooldown aus.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

log = logging.getLogger("deckcore.obs")

# obsws_python loggt jeden fehlgeschlagenen Request/Connect selbst als ERROR mit Traceback,
# BEVOR es die Exception wirft. Wir behandeln die Fehler bewusst (z.B. „Quelle nicht in dieser
# Szene" ist ein normaler Zustand; „OBS aus" ist erwartbar) und loggen echte Fehler selbst →
# den gesamten obsws_python-Logger-Baum dämpfen, sonst flutet OBS-aus das Host-Log mit Tracebacks.
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)

# Default-Host bewusst 127.0.0.1 (nicht „localhost"): „localhost" probiert unter Windows zuerst
# IPv6 ::1 — ist OBS aus, läuft dieser SYN ins Timeout (Sekunden), bevor IPv4 sofort ablehnt.
# 127.0.0.1 lehnt sofort ab, wenn OBS aus ist → das Deck hängt nie.
_DEFAULT_HOST = "127.0.0.1"
_CONNECT_TIMEOUT = 2.5      # s — Verbindungs-/Request-Timeout (kurz: das Deck darf nicht hängen)
_RECONNECT_COOLDOWN = 8.0   # s — nach Connect-Fehler so lange nicht erneut verbinden


class ObsDirect:
    """Direkter obs-websocket-Client (synchron, thread-safe, mit Reconnect-Cooldown)."""

    def __init__(self, host: str = _DEFAULT_HOST, port: int = 4455, password: str = ""):
        self._host = str(host or _DEFAULT_HOST)
        try:
            self._port = int(port or 4455)
        except (TypeError, ValueError):
            self._port = 4455
        self._password = str(password or "")
        self._lock = threading.RLock()
        self._req = None                 # gecachter ReqClient (oder None)
        self._connected = False
        self._last_fail = 0.0            # monotonic des letzten Connect-Fehlers (Cooldown)
        self._lib_ok: Optional[bool] = None   # obsws_python importierbar? (gecacht)

    # ── Konfiguration ────────────────────────────────────────────────────
    def configure(self, host: str = None, port: int = None, password: str = None) -> None:
        """Zugangsdaten ändern → bestehende Verbindung verwerfen (nächster Zugriff verbindet neu).
        ``None`` = Feld unverändert lassen."""
        with self._lock:
            if host is not None:
                self._host = str(host or _DEFAULT_HOST)
            if port is not None:
                try:
                    self._port = int(port or 4455)
                except (TypeError, ValueError):
                    self._port = 4455
            if password is not None:
                self._password = str(password or "")
            self._teardown()
            self._last_fail = 0.0   # explizite Umkonfiguration → Cooldown aufheben (sofort testen)

    # ── Verbindungs-Lifecycle (immer unter Lock) ─────────────────────────
    def _lib_available(self) -> bool:
        if self._lib_ok is None:
            try:
                import obsws_python  # noqa: F401
                self._lib_ok = True
            except Exception:  # noqa: BLE001
                self._lib_ok = False
        return self._lib_ok

    def _ensure(self):
        """Verbundenen ReqClient liefern oder werfen. Innerhalb des Cooldowns nach einem
        Fehler sofort werfen (kein Connect-Versuch)."""
        if self._req is not None:
            return self._req
        if not self._lib_available():
            raise RuntimeError("obsws-python nicht installiert")
        now = time.monotonic()
        if self._last_fail and (now - self._last_fail) < _RECONNECT_COOLDOWN:
            raise RuntimeError("OBS nicht verbunden")
        try:
            from obsws_python import ReqClient
            self._req = ReqClient(host=self._host, port=self._port,
                                  password=self._password, timeout=_CONNECT_TIMEOUT)
            self._connected = True
            self._last_fail = 0.0
            return self._req
        except Exception:
            self._connected = False
            self._last_fail = time.monotonic()
            raise

    def _teardown(self) -> None:
        c, self._req, self._connected = self._req, None, False
        if c is not None:
            try:
                c.disconnect()
            except Exception:  # noqa: BLE001
                pass

    def _on_error(self, e: Exception) -> None:
        """Fehler einordnen: Request-Fehler (Quelle fehlt o.ä.) → Verbindung behalten;
        echter Verbindungsfehler → Drop + Cooldown."""
        if _is_request_error(e):
            return
        self._teardown()
        self._last_fail = time.monotonic()

    # ── Status ───────────────────────────────────────────────────────────
    def status(self, probe: bool = False) -> dict:
        """Verbindungs-/Konfig-Status. ``probe=True`` erzwingt einen frischen Verbindungs-
        versuch (für einen „Testen"-Knopf — hebt den Cooldown auf)."""
        base = {"available": self._lib_available(), "host": self._host,
                "port": self._port, "has_password": bool(self._password)}
        if not probe:
            return {**base, "connected": bool(self._connected)}
        with self._lock:
            self._teardown()
            self._last_fail = 0.0
            try:
                c = self._ensure()
                ver = c.get_version()
                base["obs_version"] = getattr(ver, "obs_version", None)
                return {**base, "connected": True}
            except Exception as e:  # noqa: BLE001
                return {**base, "connected": False, "error": _explain(e)}

    # ── Szenen ───────────────────────────────────────────────────────────
    def current_scene(self) -> Optional[str]:
        """Name der aktiven Programm-Szene (für den obs_scene-Monitor). None bei Fehler."""
        with self._lock:
            try:
                r = self._ensure().get_current_program_scene()
                return (getattr(r, "current_program_scene_name", None)
                        or getattr(r, "scene_name", None))
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return None

    def scenes(self) -> dict:
        """{scenes:[Namen…], current:Name}. OBS liefert die oberste Szene zuletzt → umdrehen,
        damit die Reihenfolge der OBS-Szenenliste entspricht. Bei Fehler leere Liste."""
        with self._lock:
            try:
                r = self._ensure().get_scene_list()
                names = [s.get("sceneName") for s in getattr(r, "scenes", []) if s.get("sceneName")]
                names.reverse()
                return {"scenes": names,
                        "current": getattr(r, "current_program_scene_name", None)}
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return {"scenes": [], "current": None}

    def set_scene(self, name: str) -> dict:
        name = str(name or "")
        if not name:
            return {"success": False, "message": "Keine Szene gewählt"}
        with self._lock:
            try:
                self._ensure().set_current_program_scene(name)
                return {"success": True, "message": f"Szene: {name}"}
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return {"success": False, "message": _explain(e)}

    # ── Quellen-Sichtbarkeit (generischer Source-Toggle) ─────────────────
    def scene_items(self) -> dict:
        """Alle (Szene, Quelle)-Paare + unique Quellennamen — fürs Source-Dropdown im Editor."""
        pairs, sources = [], []
        with self._lock:
            try:
                c = self._ensure()
                scenes = [s.get("sceneName") for s in getattr(c.get_scene_list(), "scenes", [])
                          if s.get("sceneName")]
                for sc in scenes:
                    try:
                        items = getattr(c.get_scene_item_list(sc), "scene_items", []) or []
                    except Exception:  # noqa: BLE001
                        continue
                    for it in items:
                        src = it.get("sourceName")
                        if not src:
                            continue
                        pairs.append({"scene": sc, "source": src})
                        if src not in sources:
                            sources.append(src)
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
        return {"items": pairs, "sources": sorted(sources)}

    def _resolve_items_all(self, c, source: str) -> list:
        """ALLE (Szene, item_id)-Vorkommen einer Quelle — eine Quelle in mehreren Szenen hat
        pro Szene ein EIGENES Sichtbarkeits-Häkchen."""
        out = []
        scenes = [s.get("sceneName") for s in getattr(c.get_scene_list(), "scenes", [])
                  if s.get("sceneName")]
        for sc in scenes:
            try:
                items = getattr(c.get_scene_item_list(sc), "scene_items", []) or []
            except Exception:  # noqa: BLE001
                continue
            for it in items:
                if it.get("sourceName") == source and it.get("sceneItemId") is not None:
                    out.append((sc, it.get("sceneItemId")))
        return out

    def _resolve_item(self, c, source: str, scene: str = ""):
        """(Szene, item_id) einer Quelle. scene leer = erste Szene, die die Quelle enthält."""
        scenes = ([scene] if scene else
                  [s.get("sceneName") for s in getattr(c.get_scene_list(), "scenes", [])
                   if s.get("sceneName")])
        for sc in scenes:
            try:
                iid = getattr(c.get_scene_item_id(sc, source), "scene_item_id", None)
            except Exception:  # noqa: BLE001
                iid = None
            if iid is not None:
                return sc, iid
        return None, None

    def source_visible(self, source: str, scene: str = "") -> Optional[bool]:
        """Sichtbarkeit einer Quelle (für das Statuslicht). scene="*" → sichtbar = irgendwo
        sichtbar. None bei Fehler/nicht gefunden (Button zeigt dann Default)."""
        source = str(source or "")
        if not source:
            return None
        with self._lock:
            try:
                c = self._ensure()
                if scene == "*":
                    items = self._resolve_items_all(c, source)
                    if not items:
                        return None
                    return any(bool(getattr(c.get_scene_item_enabled(sc, iid),
                                            "scene_item_enabled", False))
                               for sc, iid in items)
                sc, iid = self._resolve_item(c, source, scene)
                if iid is None:
                    return None
                return bool(getattr(c.get_scene_item_enabled(sc, iid),
                                    "scene_item_enabled", False))
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return None

    def set_source_visible(self, source: str, mode: str = "toggle", scene: str = "") -> dict:
        """Quelle ein-/ausblenden (echtes OBS-Häkchen). mode: toggle|show|hide.
        scene="*" → ATOMAR über alle Szenen mit der Quelle (ein gemeinsamer Zielzustand →
        kein gegenphasiges Verhaken auseinandergelaufener Häkchen)."""
        source = str(source or "")
        if not source:
            return {"success": False, "message": "Keine Quelle gewählt"}
        with self._lock:
            try:
                c = self._ensure()
                if scene == "*":
                    items = self._resolve_items_all(c, source)
                    if not items:
                        return {"success": False, "message": f"Quelle nicht gefunden: {source}"}
                    target = _target_state(
                        mode, lambda: any(bool(getattr(c.get_scene_item_enabled(sc, iid),
                                                        "scene_item_enabled", False))
                                          for sc, iid in items))
                    for sc, iid in items:
                        c.set_scene_item_enabled(sc, iid, target)
                    return {"success": True, "visible": target,
                            "message": f"{source}: {'an' if target else 'aus'} ({len(items)} Szenen)"}
                sc, iid = self._resolve_item(c, source, scene)
                if iid is None:
                    return {"success": False, "message": f"Quelle nicht gefunden: {source}"}
                target = _target_state(
                    mode, lambda: bool(getattr(c.get_scene_item_enabled(sc, iid),
                                               "scene_item_enabled", False)))
                c.set_scene_item_enabled(sc, iid, target)
                return {"success": True, "visible": target,
                        "message": f"{source}: {'an' if target else 'aus'}"}
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return {"success": False, "message": _explain(e)}

    # ── Stream / Aufnahme ────────────────────────────────────────────────
    def stream(self, mode: str = "toggle") -> dict:
        return self._output("stream", mode)

    def record(self, mode: str = "toggle") -> dict:
        return self._output("record", mode)

    def _output(self, kind: str, mode: str) -> dict:
        mode = str(mode or "toggle")
        with self._lock:
            try:
                c = self._ensure()
                if kind == "stream":
                    active = bool(getattr(c.get_stream_status(), "output_active", False))
                    start_fn, stop_fn = c.start_stream, c.stop_stream
                else:
                    active = bool(getattr(c.get_record_status(), "output_active", False))
                    start_fn, stop_fn = c.start_record, c.stop_record
                do = ("stop" if active else "start") if mode == "toggle" else mode
                (start_fn if do == "start" else stop_fn)()
                noun = "Stream" if kind == "stream" else "Aufnahme"
                return {"success": True, "did": do,
                        "message": f"{noun} {'gestartet' if do == 'start' else 'gestoppt'}"}
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
                return {"success": False, "message": _explain(e)}

    def close(self) -> None:
        with self._lock:
            self._teardown()


# ── Modul-Helfer ─────────────────────────────────────────────────────────
def _target_state(mode: str, current_fn) -> bool:
    """Zielzustand für show/hide/toggle. toggle = NICHT(aktueller Zustand)."""
    if mode == "show":
        return True
    if mode == "hide":
        return False
    return not bool(current_fn())


def _is_request_error(e: Exception) -> bool:
    """OBS-Request-Fehler (Request mit non-100-Status, z.B. unbekannte Quelle) — KEIN
    Verbindungsfehler. Diese trennen die Verbindung nicht."""
    try:
        from obsws_python.error import OBSSDKRequestError
        return isinstance(e, OBSSDKRequestError)
    except Exception:  # noqa: BLE001
        return False


def _explain(e: Exception) -> str:
    """Kurze, verständliche Fehlermeldung für die Button-Rückmeldung."""
    if isinstance(e, RuntimeError) and str(e) in ("OBS nicht verbunden", "obsws-python nicht installiert"):
        return str(e)
    name = type(e).__name__
    if "ConnectionRefused" in name or "Refused" in str(e):
        return "OBS nicht erreichbar (läuft OBS? WebSocket-Server an?)"
    if "Timeout" in name:
        return "OBS-Zeitüberschreitung"
    msg = str(e).strip()
    return f"OBS-Fehler: {msg[:120]}" if msg else f"OBS-Fehler ({name})"
