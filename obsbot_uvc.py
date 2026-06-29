"""
ObsBotUVC — Center-freie OBSBOT-Kamerasteuerung in REINEM Python (rohes UVC).

Steuert OBSBOT-Kameras (Tiny/Meet) Center-frei über rohes UVC. KEINE OBSBOT-Software nötig —
kein Center, kein Elgato-Plugin, kein Stream Deck, kein libdev/SDK/Compiler, keine
Checksumme. Wir sprechen die Kamera DIREKT über zwei Standard-Windows-Schnittstellen an:

  • **Tracking / AI-Modus** = USB-Video-Extension-Unit (Vendor-XU) via ``IKsControl``
    (KsProperty, Topologie-Node). Tracking AN/AUS = 60-Byte-Payload ``16 02 <modus> <sub>``
    auf XU-Unit 2 (GUID ``9A1E7291-…``), Selektor 6. ECHTES Readback: Selektor 6 GET,
    **Byte 24** = aktueller AI-Modus (0 = aus, 2 = Mensch-Einzel). Live kalt-verifiziert
    (2026-06-29, Power-Cycle, 0 OBSBOT-Prozesse): ``byte24 0→2`` + Cam folgt körperlich.
  • **PTZ / Zoom / Zentrieren** = Standard-UVC ``IAMCameraControl`` (Pan/Tilt/Zoom), bindet
    den Quell-Filter NUR zur Steuerung (kein Graph/Stream) → kämpft nicht mit OBS.

Eigenschaften (analog ``WaveLinkDirect`` — robuste Worker-Thread-Architektur,
sodass die Host-App / der Service nichts merkt außer „es funktioniert zuverlässig"):
  • **Ein dedizierter Worker-Thread** besitzt COM (eigenes ``CoInitialize`` STA) und ALLE
    COM-Objekte (Filter/IKsControl/IAMCameraControl, pro Cam gecacht). Jede öffentliche
    Methode reicht eine Aufgabe an den Worker und blockt kurz aufs Ergebnis — so gibt es
    nie Cross-Thread-COM-Marshaling (derselbe Stolperstein wie WASAPI im Sub-Thread).
  • **Echtes Status-Readback** (kein „Stats lügen" mehr): der Worker pollt zyklisch
    ``byte24`` je Cam und füllt einen Cache; ``status``/``cam_status``/``tracking_state``
    lesen nur den Cache (nicht-blockierend). Idle-Stop ohne Status-Leser.
  • **Graceful + lazy**: fehlen ``comtypes``/``pygrabber`` (Nicht-Windows / Minimal-Build),
    bleibt das Modul importierbar und meldet sauber „nicht verfügbar".
  • **Geräte-Adressierung**: ``device`` (0 = Cam 1, 1 = Cam 2 …) = Index in die gefilterte
    OBSBOT-Geräteliste (virtuelle Cam ausgeschlossen). Wie beim alten OSC-Index 0/1.

Was via UVC NOCH NICHT kartiert ist (liefert ehrlich ``success:False`` statt still zu
verpuffen): Presets, Framing-Modus, Tracking-Tempo, FOV/View, Mirror, Record/Snapshot,
Wecken/Schlafen erzwingen. Diese laufen in OBSBOT Center über das gerahmte ``aa 21``-XU-
Protokoll bzw. brauchen einen Video-Konsumenten — Folgeschritt „Rest kartieren".
"""
from __future__ import annotations

import logging
import threading
import time
import queue
from typing import Any, Optional

log = logging.getLogger("deckcore.obsbot")

# ── Lazy/graceful COM-Importe — deckcore bleibt OHNE diese Pakete importierbar ──────────
try:
    import ctypes
    from ctypes import (POINTER, c_ulong, c_long, c_void_p, sizeof,
                        create_string_buffer, addressof)
    import comtypes
    from comtypes import IUnknown, GUID, COMMETHOD, HRESULT, COMError
    from pygrabber.dshow_graph import SystemDeviceEnum
    from pygrabber.dshow_ids import DeviceCategories
    _UVC_OK = True
    _UVC_IMPORT_ERR = ""
except Exception as _e:  # noqa: BLE001  — Nicht-Windows / fehlende Pakete: sauber degradieren
    _UVC_OK = False
    _UVC_IMPORT_ERR = repr(_e)

# ── Vendor-XU / KsProperty-Konstanten (echte guidExtensionCodes der Tiny 3) ─────────────
_XU_U2 = "{9A1E7291-6843-4683-6D92-39BC7906EE49}"   # Unit 2 — der AI/Tracking-Kanal
_DEV_SPECIFIC = "{941C7AC0-C559-11D0-8A2B-00A0C9255AC1}"   # NodeType der DEV_SPECIFIC-Knoten
_KSP_GET = 0x00000001 | 0x10000000   # GET | TOPOLOGY
_KSP_SET = 0x00000002 | 0x10000000   # SET | TOPOLOGY
_SEL_AI = 6                          # Selektor 6 = AI-/Tracking-Control (``16 02 …``)
_AI_BYTE = 24                        # GET[24] = aktueller AI-Modus (0 = aus, 2 = Einzel)

# AI-Payloads (60 Byte). Verifiziert: Mensch-Einzel AN / AUS. Weitere Modi noch nicht
# kalt-verifiziert → konservativ nur das Gesicherte, Rest meldet „noch nicht kartiert".
_TRACK_OFF = bytes.fromhex("16020000") + b"\x00" * 56
_AI_MODE_PAYLOAD = {
    0: bytes.fromhex("16020200") + b"\x00" * 56,   # 0 = Mensch-Einzel (VERIFIZIERT)
}
_TRACK_ON = _AI_MODE_PAYLOAD[0]

# DirectShow CameraControlProperty-Enum (IAMCameraControl)
_CC = {"Pan": 0, "Tilt": 1, "Roll": 2, "Zoom": 3, "Exposure": 4, "Iris": 5, "Focus": 6}
_CC_MANUAL = 2

# Status-/Poll-Takt
_POLL_INTERVAL = 1.0     # s — Readback-Takt, solange ein Status-Leser Interesse zeigt
_POLL_IDLE = 12.0        # s — kein Leser mehr ⇒ Poller hört auf zu pollen (Thread bleibt billig)
_REACHABLE_TTL = 4.0     # s — länger kein erfolgreicher Readback ⇒ „nicht erreichbar"
_ENUM_TTL = 5.0          # s — Geräteliste so oft neu enumerieren
_IDLE_TICK = 0.3         # s — Leerlauf-Takt des Workers (wacht für Jobs sofort auf)
_JOB_TIMEOUT = 4.0       # s — max. Wartezeit einer öffentlichen Methode auf den Worker

# ⛔ SICHERHEIT: Wenn MEHRERE Consumer GLEICHZEITIG auf eine UVC-Kamera zugreifen (Hintergrund-Poll
# + ein startender Video-Konsument wie OBS o.ä.), kann der Windows Camera Frame Server / USB-Stack
# auf manchen Systemen überlasten — bis hin zu harten Treiber-/Geräte-Hängern (real beobachtet beim
# OBS-Start, während dieses Backend die Cams pollte). DESHALB als Default: KEIN Hintergrund-Polling
# der Kameras. Status/Readback NUR aus dem Cache (gefüllt durch explizite Steuer-Aktionen = diskrete,
# seltene Tastendrücke). Ein OBS-bewusster sanfter Live-Poll wäre ein bewusster, getesteter Opt-in.
_BACKGROUND_POLL = False

# ── Sleep-Detection (KALIBRIERT per Wach-vs-Schlaf-Selektor-Diff, 2026-06-29) ──────────
# Selektor-6-GET **Byte 2** = 0 (wach) → 1 (schläft). An BEIDEN Tiny 3 konsistent gemessen
# (wach vs. ~2 min ohne Video-Konsument, beide schlafend). Korroboriert vom selben Power-
# State-Wechsel in Byte 9 (1→3) und Byte 43 (2→3); Byte 24 (Tracking) bleibt davon unberührt.
_SLEEP_FLAG_BYTE = 2


if _UVC_OK:
    def _ksp_method():
        return [(["in"], c_void_p, "P"), (["in"], c_ulong, "PL"), (["in"], c_void_p, "D"),
                (["in"], c_ulong, "DL"), (["out"], POINTER(c_ulong), "BR")]

    class IKsControl(IUnknown):
        _iid_ = GUID("{28F54685-06FD-11D2-B27A-00A0C9223196}")
        _methods_ = [COMMETHOD([], HRESULT, "KsProperty", *_ksp_method()),
                     COMMETHOD([], HRESULT, "KsMethod", *_ksp_method()),
                     COMMETHOD([], HRESULT, "KsEvent", *_ksp_method())]

    class IKsTopologyInfo(IUnknown):
        _iid_ = GUID("{720D4AC0-7533-11D0-A5D6-28DB04C10000}")
        _methods_ = [
            COMMETHOD([], HRESULT, "get_NumCategories", (["out"], POINTER(c_ulong), "p")),
            COMMETHOD([], HRESULT, "get_Category", (["in"], c_ulong, "i"), (["out"], POINTER(GUID), "g")),
            COMMETHOD([], HRESULT, "get_NumConnections", (["out"], POINTER(c_ulong), "p")),
            COMMETHOD([], HRESULT, "get_ConnectionInfo", (["in"], c_ulong, "i"), (["in"], c_void_p, "p")),
            COMMETHOD([], HRESULT, "get_NodeName", (["in"], c_ulong, "n"), (["in"], c_void_p, "b"),
                      (["in"], c_ulong, "s"), (["out"], POINTER(c_ulong), "l")),
            COMMETHOD([], HRESULT, "get_NumNodes", (["out"], POINTER(c_ulong), "p")),
            COMMETHOD([], HRESULT, "get_NodeType", (["in"], c_ulong, "n"), (["out"], POINTER(GUID), "g")),
            COMMETHOD([], HRESULT, "CreateNodeInstance", (["in"], c_ulong, "n"),
                      (["in"], POINTER(GUID), "iid"), (["out"], POINTER(POINTER(IUnknown)), "o")),
        ]

    class IAMCameraControl(IUnknown):
        _iid_ = GUID("{C6E13370-30AC-11D0-A18C-00A0C9118956}")
        _methods_ = [
            COMMETHOD([], HRESULT, "GetRange",
                      (["in"], c_long, "Property"), (["out"], POINTER(c_long), "pMin"),
                      (["out"], POINTER(c_long), "pMax"), (["out"], POINTER(c_long), "pSteppingDelta"),
                      (["out"], POINTER(c_long), "pDefault"), (["out"], POINTER(c_long), "pCapsFlags")),
            COMMETHOD([], HRESULT, "Set", (["in"], c_long, "Property"),
                      (["in"], c_long, "lValue"), (["in"], c_long, "Flags")),
            COMMETHOD([], HRESULT, "Get", (["in"], c_long, "Property"),
                      (["out"], POINTER(c_long), "lValue"), (["out"], POINTER(c_long), "Flags")),
        ]

    class _KSPROPERTY(ctypes.Structure):
        _fields_ = [("Set", GUID), ("Id", c_ulong), ("Flags", c_ulong)]

    class _KSP_NODE(ctypes.Structure):
        _fields_ = [("Property", _KSPROPERTY), ("NodeId", c_ulong), ("Reserved", c_ulong)]


def _clampi(v: Any, lo: int, hi: int, default: int = 0) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return lo if n < lo else hi if n > hi else n


class _Cam:
    """Gecachte COM-Handles einer Kamera (nur auf dem Worker-Thread benutzt)."""
    __slots__ = ("di", "name", "kc", "node", "cc")

    def __init__(self, di: int, name: str, kc, node, cc):
        self.di = di
        self.name = name
        self.kc = kc            # IKsControl (XU/Tracking)
        self.node = node        # DEV_SPECIFIC-Node-Id für KsProperty
        self.cc = cc            # IAMCameraControl (PTZ) — kann None sein


class ObsBotUVC:
    """Direkter, Center-freier OBSBOT-Client über rohes UVC (rein Python, thread-safe, graceful).

    Spiegelt die Methoden-Oberfläche von ``ObsBotOSC`` 1:1, damit der Service unverändert
    bleibt. ``host``/``port`` werden nur zur Signatur-Kompatibilität angenommen (UVC ist
    lokales USB) und ignoriert."""

    def __init__(self, host: str | None = None, port: int | None = None):
        self._q: "queue.Queue" = queue.Queue()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._wlock = threading.Lock()
        # Status-Cache (vom Worker gefüllt, von Readern gelesen)
        self._clock = threading.Lock()
        self._dev: dict = {}            # idx -> {connected,name,awake,tracking,byte24}
        self._reachable_ts: float = -1e9
        self._want_ts: float = -1e9     # letzter Status-Leser (Idle-Stop)
        self._last_poll: float = -1e9
        self._last_send: float = 0.0
        # Worker-lokal (nur im Worker-Thread berührt)
        self._handles: dict = {}        # idx -> _Cam
        self._dis: list = []            # gefilterte DShow-Indizes der OBSBOT-Cams
        self._dis_ts: float = -1e9

    # ── Geräte-Index-Mapping ─────────────────────────────────────────────
    @staticmethod
    def _idx(device: Any) -> int:
        try:
            return int(device) if device not in (None, "") else 0
        except (TypeError, ValueError):
            return 0

    # ── Worker-Thread (COM-Besitzer) ─────────────────────────────────────
    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        with self._wlock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._stop.clear()
            t = threading.Thread(target=self._run, name="obsbot-uvc", daemon=True)
            self._worker = t
            t.start()

    def _run(self) -> None:
        """Einziger COM-Thread: Jobs ausführen + zyklisches Readback (wenn ein Leser Interesse hat)."""
        try:
            comtypes.CoInitialize()
        except Exception:  # noqa: BLE001
            pass
        try:
            while not self._stop.is_set():
                try:
                    job = self._q.get(timeout=_IDLE_TICK)
                except queue.Empty:
                    job = None
                if job is not None:
                    self._exec(job)
                    continue
                now = time.monotonic()
                interested = (now - self._want_ts) < _POLL_IDLE
                # ⛔ Hintergrund-Polling der Cams ist aus Sicherheitsgründen AUS (_BACKGROUND_POLL).
                # Der Worker bleibt nur für on-demand-Steuer-Jobs am Leben; er fasst die Kamera NIE
                # von selbst an. Cache wird allein durch explizite Aktionen gefüllt.
                if _BACKGROUND_POLL and interested and (now - self._last_poll) >= _POLL_INTERVAL:
                    self._readback_all()
                    self._last_poll = time.monotonic()
        finally:
            self._teardown()
            try:
                comtypes.CoUninitialize()
            except Exception:  # noqa: BLE001
                pass

    def _exec(self, job) -> None:
        fn, box, ev = job
        try:
            box["result"] = fn()
        except COMError as e:
            box["result"] = {"success": False, "message": f"UVC-COMError {hex(e.hresult & 0xffffffff)}"}
        except Exception as e:  # noqa: BLE001
            box["result"] = {"success": False, "message": f"UVC-Fehler: {e}"}
        finally:
            ev.set()

    def _submit(self, fn, timeout: float = _JOB_TIMEOUT) -> dict:
        """Eine COM-Aufgabe an den Worker geben und (kurz) aufs Ergebnis warten."""
        if not _UVC_OK:
            return {"success": False, "message": f"OBSBOT-UVC nicht verfügbar: {_UVC_IMPORT_ERR}"}
        self._ensure_worker()
        ev = threading.Event()
        box: dict = {}
        self._q.put((fn, box, ev))
        if not ev.wait(timeout):
            return {"success": False, "message": "OBSBOT-UVC: Zeitüberschreitung"}
        return box.get("result", {"success": False, "message": "kein Ergebnis"})

    def _teardown(self) -> None:
        self._handles.clear()

    # ── COM-Primitive (NUR im Worker-Thread aufrufen) ────────────────────
    def _ks(self, kc, node, guid, selector, flags, payload=None, length=60) -> bytes:
        ksp = _KSP_NODE()
        ksp.Property.Set = GUID(guid)
        ksp.Property.Id = selector
        ksp.Property.Flags = flags
        ksp.NodeId = node
        if payload is not None:
            buf = create_string_buffer(payload, len(payload)); ln = len(payload)
        else:
            buf = create_string_buffer(length); ln = length
        kc.KsProperty(addressof(ksp), sizeof(ksp), addressof(buf), ln)
        return buf.raw

    def _list_dis(self) -> list:
        """Gefilterte DShow-Indizes der OBSBOT-Cams (virtuelle Cam ausgeschlossen). Gecacht."""
        now = time.monotonic()
        if self._dis and (now - self._dis_ts) < _ENUM_TTL:
            return self._dis
        dis = []
        try:
            sde = SystemDeviceEnum()
            names = sde.get_available_filters(DeviceCategories.VideoInputDevice)
            dis = [i for i, n in enumerate(names)
                   if "obsbot" in n.lower() and "virtual" not in n.lower()]
        except Exception as e:  # noqa: BLE001
            log.debug("obsbot-uvc: Geräte-Enumeration fehlgeschlagen: %s", e)
            dis = []
        if dis != self._dis:                 # Liste änderte sich → Handles neu bauen
            self._handles.clear()
        self._dis = dis
        self._dis_ts = now
        return dis

    def _handle(self, idx: int) -> Optional[_Cam]:
        """COM-Handle der Cam ``idx`` (gefilterte Liste) holen/bauen. None = nicht vorhanden."""
        h = self._handles.get(idx)
        if h is not None:
            return h
        dis = self._list_dis()
        if idx >= len(dis):
            return None
        di = dis[idx]
        try:
            sde = SystemDeviceEnum()
            filt, name = sde.get_filter_by_index(DeviceCategories.VideoInputDevice, di)
            topo = filt.QueryInterface(IKsTopologyInfo)
            kc = filt.QueryInterface(IKsControl)
            node = self._dev_specific_node(topo)
            if node is None:
                return None
            try:
                cc = filt.QueryInterface(IAMCameraControl)
            except COMError:
                cc = None
            h = _Cam(di, name, kc, node, cc)
            self._handles[idx] = h
            return h
        except COMError as e:
            log.debug("obsbot-uvc: Handle %s bauen fehlgeschlagen: %s", idx, e)
            self._handles.pop(idx, None)
            return None

    @staticmethod
    def _dev_specific_node(topo) -> Optional[int]:
        t = _DEV_SPECIFIC.strip("{}").upper()
        for i in range(topo.get_NumNodes()):
            if str(topo.get_NodeType(i)).strip("{}").upper() == t:
                return i
        return None

    def _invalidate(self, idx: int) -> None:
        self._handles.pop(idx, None)

    # ── Sleep-Detection (kalibriert per Diff) ────────────────────────────
    @staticmethod
    def _awake_from(d: Optional[bytes]) -> bool:
        """Ist die Cam wach? ``d`` = Selektor-6-GET (None bei Lesefehler ⇒ nicht wach).
        Schlaf-Indikator = Byte 2 (0 = wach, 1 = geparkt/schläft) — kalibriert 2026-06-29."""
        if d is None or len(d) <= _SLEEP_FLAG_BYTE:
            return False
        return d[_SLEEP_FLAG_BYTE] == 0

    # ── Readback (Worker-Thread) ─────────────────────────────────────────
    def _readback_all(self) -> None:
        dis = self._list_dis()
        any_ok = False
        snapshot: dict = {}
        for idx in range(len(dis)):
            h = self._handle(idx)
            if h is None:
                snapshot[idx] = {"connected": False, "name": "", "awake": False,
                                 "tracking": False, "byte24": None}
                continue
            try:
                d = self._ks(h.kc, h.node, _XU_U2, _SEL_AI, _KSP_GET)
            except COMError:
                self._invalidate(idx)
                snapshot[idx] = {"connected": False, "name": h.name, "awake": False,
                                 "tracking": False, "byte24": None}
                continue
            b24 = d[_AI_BYTE] if d and len(d) > _AI_BYTE else None
            awake = self._awake_from(d)
            snapshot[idx] = {"connected": True, "name": h.name, "awake": awake,
                             "tracking": bool(b24), "byte24": b24}
            any_ok = True
        with self._clock:
            self._dev = snapshot
            if any_ok:
                self._reachable_ts = time.monotonic()

    def _mark_interest(self) -> None:
        self._want_ts = time.monotonic()
        self._ensure_worker()

    def _update_track(self, device: Any, byte24: Optional[int]) -> None:
        """Cache nach einem Schalt-Befehl sofort nachziehen (ohne auf den Poll zu warten)."""
        idx = self._idx(device)
        with self._clock:
            info = self._dev.setdefault(idx, {})
            info["byte24"] = byte24
            info["tracking"] = bool(byte24)
            info["connected"] = True
            if byte24 is not None:
                self._reachable_ts = time.monotonic()

    # ── Öffentliche Steuer-API (spiegelt ObsBotOSC) ──────────────────────
    def set_config(self, host: str | None = None, port: int | None = None) -> dict:
        """No-Op (UVC ist lokales USB) — nur Signatur-Kompatibilität zum alten OSC-Client."""
        return {"success": True, "message": "UVC-Modus: lokale USB-Steuerung (kein Host/Port)"}

    def send(self, address: str, *args) -> dict:
        """Roh-OSC gibt es im UVC-Modus nicht — ehrlich melden statt still verpuffen."""
        return {"success": False, "message": "Roh-OSC nicht verfügbar im UVC-Modus"}

    def connected(self) -> dict:
        self._mark_interest()
        return {"success": True, "message": "UVC aktiv"}

    def select_device(self, index: Any) -> dict:
        """UVC adressiert jede Cam direkt über ``device`` — kein globales „Auswählen" nötig."""
        return {"success": True, "message": "UVC: Kameras werden direkt adressiert"}

    # Tracking / AI -------------------------------------------------------
    def tracking(self, on: Any, device: Any = None, mode: Any = 0) -> dict:
        """Auto-Follow AN/AUS über XU-Selektor 6 (``16 02 <modus>``), mit echtem byte24-Readback."""
        return self._submit(lambda: self._do_tracking(bool(on), device, mode))

    def _do_tracking(self, on: bool, device: Any, mode: Any) -> dict:
        h = self._handle(self._idx(device))
        if h is None:
            return {"success": False, "message": "OBSBOT-Kamera nicht gefunden"}
        if on:
            payload = _AI_MODE_PAYLOAD.get(_clampi(mode, 0, 5))
            if payload is None:
                return {"success": False, "message": f"AI-Modus {mode} via UVC noch nicht kartiert"}
        else:
            payload = _TRACK_OFF
        self._ks(h.kc, h.node, _XU_U2, _SEL_AI, _KSP_SET, payload)
        self._last_send = time.monotonic()
        time.sleep(0.15)
        try:
            d = self._ks(h.kc, h.node, _XU_U2, _SEL_AI, _KSP_GET)
            b24 = d[_AI_BYTE] if d and len(d) > _AI_BYTE else None
        except COMError:
            b24 = None
        self._update_track(device, b24)
        return {"success": True, "message": f"Tracking {'AN' if on else 'AUS'} (byte24={b24})"}

    def tracking_toggle(self, device: Any = None, mode: Any = 0) -> dict:
        """Umschalten anhand des ECHTEN Zustands (byte24), nicht optimistisch."""
        return self._submit(lambda: self._do_toggle(device, mode))

    def _do_toggle(self, device: Any, mode: Any) -> dict:
        h = self._handle(self._idx(device))
        if h is None:
            return {"success": False, "message": "OBSBOT-Kamera nicht gefunden"}
        try:
            d = self._ks(h.kc, h.node, _XU_U2, _SEL_AI, _KSP_GET)
            cur = bool(d[_AI_BYTE]) if d and len(d) > _AI_BYTE else False
        except COMError:
            cur = False
        return self._do_tracking(not cur, device, mode)

    def tracking_state(self, device: Any = None):
        """ECHTER Follow-Zustand aus dem Readback-Cache (byte24 != 0). None = unbekannt."""
        self._mark_interest()
        with self._clock:
            info = self._dev.get(self._idx(device))
        if not info:
            return None
        b = info.get("byte24")
        return None if b is None else bool(b)

    def ai_mode(self, mode: Any, device: Any = None) -> dict:
        """AI-Modus setzen (= Tracking AN in diesem Modus)."""
        return self.tracking(True, device, mode)

    # PTZ / Gimbal / Zoom (IAMCameraControl) ------------------------------
    def recenter(self, device: Any = None) -> dict:
        """Gimbal auf die UVC-Default-Position (Pan/Tilt) zurückfahren = „Zentrieren"."""
        return self._submit(lambda: self._do_recenter(device))

    def _do_recenter(self, device: Any) -> dict:
        h = self._handle(self._idx(device))
        if h is None:
            return {"success": False, "message": "OBSBOT-Kamera nicht gefunden"}
        # „Zentrieren" = Auto-Follow STOPPEN (sonst überfährt die AI das Recenter sofort → es sieht
        # aus, als passiere nichts) UND den Gimbal auf die MITTE der Pan/Tilt-Range fahren (echtes
        # mechanisches Zentrum — robuster als der „Default", den manche UVC-Cams = aktuelle Position
        # melden). Spiegelt das alte OSC-ResetGimbal (Follow aus + Home).
        track_off = False
        try:
            self._ks(h.kc, h.node, _XU_U2, _SEL_AI, _KSP_SET, _TRACK_OFF)
            track_off = True
        except COMError:
            pass
        done = []
        if h.cc is not None:
            for prop in ("Pan", "Tilt"):
                try:
                    mn, mx, _st, _df, _caps = h.cc.GetRange(_CC[prop])
                    h.cc.Set(_CC[prop], (mn + mx) // 2, _CC_MANUAL)
                    done.append(prop)
                except COMError:
                    pass
        self._last_send = time.monotonic()
        if track_off:
            self._update_track(device, 0)
        if not done and not track_off:
            return {"success": False, "message": "Zentrieren nicht möglich (kein PTZ/AI-Kanal)"}
        return {"success": True, "message": f"Zentriert (Follow aus{', PTZ ' + '+'.join(done) if done else ''})"}

    def gimbal_move(self, pan: Any, pitch: Any, speed: Any = 1, device: Any = None) -> dict:
        """Gimbal absolut: Pan/Tilt auf Geräte-Range geklemmt setzen (UVC-Einheiten)."""
        return self._submit(lambda: self._do_set_props(device, {"Pan": pan, "Tilt": pitch}))

    def gimbal_dir(self, direction: str, speed: Any = 50, device: Any = None) -> dict:
        """Gimbal relativ anstupsen (Lesen → +/- Delta → Setzen). speed skaliert das Delta."""
        return self._submit(lambda: self._do_nudge(device, direction, speed))

    def _do_nudge(self, device: Any, direction: str, speed: Any) -> dict:
        h = self._handle(self._idx(device))
        if h is None or h.cc is None:
            return {"success": False, "message": "PTZ nicht verfügbar"}
        prop = {"up": "Tilt", "down": "Tilt", "left": "Pan", "right": "Pan"}.get(
            str(direction).strip().lower())
        if not prop:
            return {"success": False, "message": f"Unbekannte Richtung: {direction}"}
        sign = -1 if str(direction).strip().lower() in ("down", "left") else 1
        try:
            mn, mx, st, _df, _caps = h.cc.GetRange(_CC[prop])
            val, _fl = h.cc.Get(_CC[prop])
            span = mx - mn
            delta = max(st or 1, int(span * _clampi(speed, 1, 100, 50) / 100 / 8) or (st or 1))
            target = max(mn, min(mx, val + sign * delta))
            h.cc.Set(_CC[prop], target, _CC_MANUAL)
        except COMError as e:
            return {"success": False, "message": f"PTZ-Fehler {hex(e.hresult & 0xffffffff)}"}
        self._last_send = time.monotonic()
        return {"success": True, "message": f"{prop} → {target}"}

    def _do_set_props(self, device: Any, props: dict) -> dict:
        h = self._handle(self._idx(device))
        if h is None or h.cc is None:
            return {"success": False, "message": "PTZ nicht verfügbar"}
        done = []
        for prop, raw in props.items():
            try:
                mn, mx, _st, _df, _caps = h.cc.GetRange(_CC[prop])
                h.cc.Set(_CC[prop], _clampi(raw, mn, mx), _CC_MANUAL)
                done.append(prop)
            except COMError:
                pass
        self._last_send = time.monotonic()
        return {"success": bool(done), "message": f"Gesetzt: {'+'.join(done) or 'nichts'}"}

    def set_zoom(self, percent: Any, device: Any = None) -> dict:
        """Zoom 0–100 % → auf die Geräte-Zoom-Range abgebildet."""
        return self._submit(lambda: self._do_zoom(device, percent))

    def _do_zoom(self, device: Any, percent: Any) -> dict:
        h = self._handle(self._idx(device))
        if h is None or h.cc is None:
            return {"success": False, "message": "Zoom nicht verfügbar"}
        try:
            mn, mx, _st, _df, _caps = h.cc.GetRange(_CC["Zoom"])
            target = mn + (mx - mn) * _clampi(percent, 0, 100) // 100
            h.cc.Set(_CC["Zoom"], target, _CC_MANUAL)
        except COMError as e:
            return {"success": False, "message": f"Zoom-Fehler {hex(e.hresult & 0xffffffff)}"}
        self._last_send = time.monotonic()
        return {"success": True, "message": f"Zoom {percent}% → {target}"}

    # Noch nicht via UVC kartiert — ehrlich melden (statt still verpuffen) -
    def _not_mapped(self, what: str) -> dict:
        return {"success": False, "message": f"{what} via UVC noch nicht kartiert (OBSBOT-Center-Funktion)"}

    def set_view(self, mode: Any, device: Any = None) -> dict:
        return self._not_mapped("FOV/View")

    def set_mirror(self, on: Any, device: Any = None) -> dict:
        return self._not_mapped("Mirror")

    def framing(self, mode: Any, device: Any = None) -> dict:
        return self._not_mapped("Framing-Modus")

    def tracking_speed(self, mode: Any, device: Any = None) -> dict:
        return self._not_mapped("Tracking-Tempo")

    def preset(self, index: Any, device: Any = None) -> dict:
        return self._not_mapped("Preset")

    def record(self, on: Any, device: Any = None) -> dict:
        return self._not_mapped("Aufnahme")

    def snapshot(self, device: Any = None) -> dict:
        return self._not_mapped("Schnappschuss")

    def wake(self, device: Any = None) -> dict:
        """UVC kann die Cam nicht eigenständig wecken — das macht der Video-Konsument (OBS)."""
        return {"success": False, "message": "Wecken übernimmt OBS (UVC kann nicht eigenständig wecken)"}

    def sleep(self, device: Any = None) -> dict:
        return self._not_mapped("Schlafen erzwingen")

    # ── Status-Readback (nicht-blockierend, aus dem Cache) ───────────────
    def reachable(self) -> bool:
        self._mark_interest()
        return (time.monotonic() - self._reachable_ts) < _REACHABLE_TTL

    def cam_status(self, device: Any = None) -> str:
        """„off" (nicht erreichbar / Cam weg) · „sleep" (Linse geparkt) · „on" (bereit)."""
        self._mark_interest()
        now = time.monotonic()
        with self._clock:
            if (now - self._reachable_ts) >= _REACHABLE_TTL:
                return "off"
            info = self._dev.get(self._idx(device))
        if info is None or info.get("connected") is False:
            return "off"
        if info.get("awake") is False:
            return "sleep"
        return "on"

    def status(self) -> dict:
        """Status für die UI. ``state``:
          • ``ready``        — UVC aktiv + mind. 1 OBSBOT-Cam lesbar (Steuerung + echtes Readback gehen).
          • ``no_cam``       — UVC verfügbar, aber keine OBSBOT-Kamera gefunden (USB? in OBS wach?).
          • ``unavailable``  — comtypes/pygrabber fehlen (Nicht-Windows / Minimal-Build).
        ``reachable`` = kürzlich erfolgreich gelesen; ``devices`` = pro Cam verbunden/wach/tracking."""
        if not _UVC_OK:
            return {"transport": "uvc", "reachable": False, "state": "unavailable",
                    "app_running": False, "devices": {}, "error": _UVC_IMPORT_ERR,
                    "last_send_age": None}
        self._mark_interest()
        now = time.monotonic()
        with self._clock:
            reachable = (now - self._reachable_ts) < _REACHABLE_TTL
            devices = {d: dict(info) for d, info in self._dev.items()}
        connected_any = any(i.get("connected") for i in devices.values())
        state = "ready" if (reachable and connected_any) else "no_cam"
        return {"transport": "uvc", "reachable": reachable, "state": state,
                "app_running": connected_any,    # „App" gibt es im UVC-Modus nicht; = Cam(s) da
                "devices": devices,
                "last_send_age": (round(now - self._last_send, 1) if self._last_send else None)}
