"""
PresentMon-FPS-/Frametime-Quelle (generischer deckcore-Sampler) für Live-Verlaufsgraphen.

Quelle = **Intel PresentMon** (ETW, herstellerneutral NV/AMD/Intel, KEINE Injection ins Spiel →
anti-cheat-sicher). Andockt an den LAUFENDEN PresentMon-Service über `PresentMonAPI2.dll` — KEINE
Elevation nötig (der Service hält die privilegierte ETW-Session, wir sind nur Client). Ein eigener
Sampler-Thread pollt im ms-Bereich und füllt zwei Ringpuffer (`fps`, `frametime`); die Anzeige liest
gröber → „schnell sampeln / grob anzeigen", fängt Frame-Spikes.

Frametime = `PM_METRIC_CPU_FRAME_TIME` (ms) mit `PM_STAT_MAX` über ein kurzes Fenster → der schlimmste
Frame zwischen zwei Polls geht NICHT verloren (Spike-Erkennung). FPS = `PM_METRIC_PRESENTED_FPS` (AVG).

⚠ GRACEFUL + ERKANNT (harte Regel „muss auf allen Rechnern gehen"): fehlt DLL/Service oder läuft kein
Spiel (nichts präsentiert Frames) → `status.available=False` mit klarem Grund; die Graph-Kachel meldet
das, statt leer zu sein. PresentMon wird NIE vorausgesetzt — nur genutzt, wenn vorhanden. Getrackt wird
der **Vordergrund-Prozess** (das aktive Spiel); wechselt er, wird automatisch umgehängt.
"""
from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from collections import deque
from typing import Optional

log = logging.getLogger("deckcore.frametime")

# ── PresentMonAPI2 Konstanten (aus dem offiziellen Header, API 3.4) ──────────────
PM_STATUS_SUCCESS = 0
PM_METRIC_CPU_FRAME_TIME = 8     # ms — Gesamt-Frametime (CPU); Spikes = lange Frames
PM_METRIC_PRESENTED_FPS = 12     # fps
PM_STAT_AVG = 1
PM_STAT_MAX = 8

_DLL_CANDIDATES = [
    r"C:\Program Files\Intel\PresentMonSharedService\PresentMonAPI2.dll",
    r"C:\Program Files\Intel\Intel Graphics Software\PresentMonAPI2.dll",
]
_WINDOW_MS = 140.0       # Statistik-Fenster der dynamischen Query
_POLL_HZ = 30.0          # Sampler-Rate (fängt Spikes; CPU-billig)
_RING = 600              # Ringpuffer-Tiefe (~20 s @ 30 Hz)
_RECONNECT_COOLDOWN = 8.0
_BLOB = 16384            # großzügiger Poll-Blob (mehrere Swapchains)
_SC_CAP = 64             # ⚠ numSwapChains ist IN/OUT: VOR dem Poll die Blob-Kapazität (#Swapchains) setzen,
#                          sonst lehnt pmPollDynamicQuery mit BAD_ARGUMENT (Status 2) ab. Kostete 1 Debug-Runde.
# Sichtbare Prozesse, die KEIN Spiel sind (Browser/Deck/Shell) → nie als FPS-Quelle nehmen. So bleiben die
# Werte stehen, während man das Panel im Browser anschaut (das Spiel läuft borderless im Hintergrund weiter).
_DENY = ("chrome", "firefox", "msedge", "edge", "brave", "opera", "vivaldi", "iexplore", "explorer.exe",
         "rigzdeck", "python", "code.exe", "discord", "obs", "electron", "dwm.exe", "textinputhost",
         "searchhost", "applicationframehost", "shellexperiencehost", "widgets", "nvidia")


class PM_QUERY_ELEMENT(ctypes.Structure):
    _fields_ = [("metric", ctypes.c_uint32), ("stat", ctypes.c_uint32),
                ("deviceId", ctypes.c_uint32), ("arrayIndex", ctypes.c_uint32),
                ("dataOffset", ctypes.c_uint64), ("dataSize", ctypes.c_uint64)]


def _dll_path() -> Optional[str]:
    env = os.environ.get("PRESENTMON_API_DLL")
    if env and os.path.exists(env):
        return env
    for p in _DLL_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def _proc_name(pid: int) -> str:
    try:
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        b = ctypes.create_unicode_buffer(260)
        s = ctypes.c_uint32(260)
        k.QueryFullProcessImageNameW(h, 0, b, ctypes.byref(s))
        k.CloseHandle(h)
        return b.value.split("\\")[-1].lower()
    except Exception:  # noqa: BLE001
        return ""


def _visible_window_pids() -> set:
    """PIDs aller sichtbaren Top-Level-Fenster — Kandidaten für das laufende Spiel."""
    pids: set = set()
    try:
        user32 = ctypes.windll.user32

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def _cb(hwnd, _lparam):
            if user32.IsWindowVisible(hwnd):
                p = ctypes.c_uint32(0)
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
                if p.value:
                    pids.add(int(p.value))
            return True
        user32.EnumWindows(_cb, 0)
    except Exception:  # noqa: BLE001
        pass
    return pids


class FrametimeSource:
    """Sampelt FPS + Frametime des Vordergrund-Spiels via PresentMon in zwei Ringpuffer."""

    def __init__(self):
        self._lock = threading.Lock()
        self._fps = deque(maxlen=_RING)
        self._ft = deque(maxlen=_RING)
        self._fps_last: Optional[float] = None
        self._ft_last: Optional[float] = None
        self._tracked_pid = 0
        self._game_pid = 0           # aktuell gelocktes Spiel (sticky; via Scan gefunden, nicht Vordergrund)
        self._tracked: set = set()    # bereits an die PresentMon-Tracking-API gemeldete PIDs
        self._presenting = False
        self._available = False
        self._reason = "nicht gestartet"
        self._dll = None
        self._sess = None
        self._query = None
        self._fps_off = 0
        self._ft_off = 0
        self._blob = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ── Lifecycle (LAZY: Sampler startet erst bei erster Anfrage einer FPS/Frametime-Kachel) ──
    def _ensure(self) -> None:
        if self._thread is not None:
            return
        if not _dll_path():
            self._reason = "PresentMon nicht gefunden (Intel PresentMon installieren)"
            return   # kein Thread, wenn die DLL fehlt — nichts läuft unnötig
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="Frametime", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None

    # ── Öffentliche Lesezugriffe (lösen den Lazy-Start aus) ──────────────
    def status(self) -> dict:
        self._ensure()
        return {"available": self._available, "source": "presentmon",
                "presenting": self._presenting, "tracked_pid": self._tracked_pid,
                "fps": self._fps_last, "frametime": self._ft_last, "reason": self._reason}

    def series(self, kind: str) -> dict:
        self._ensure()
        with self._lock:
            data = list(self._ft if kind == "frametime" else self._fps)
        return {"available": self._available, "presenting": self._presenting,
                "kind": kind, "data": data, "reason": None if self._presenting else self._reason}

    def value(self, kind: str) -> Optional[float]:
        self._ensure()
        return self._ft_last if kind == "frametime" else self._fps_last

    # ── Sampler-Thread ───────────────────────────────────────────────────
    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._connect()           # DLL + Session + Query (wirft bei Fehler)
                self._available = True
                self._reason = "verbunden — warte auf ein Spiel (Vordergrund)"
                self._loop()
            except Exception as e:  # noqa: BLE001
                self._available = False
                self._presenting = False
                self._reason = _explain(e)
                self._teardown()
                self._stop.wait(_RECONNECT_COOLDOWN)

    def _connect(self) -> None:
        path = _dll_path()
        if not path:
            raise RuntimeError("PresentMon nicht gefunden")
        dll = ctypes.WinDLL(path)
        dll.pmOpenSession.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        dll.pmOpenSession.restype = ctypes.c_int
        dll.pmCloseSession.argtypes = [ctypes.c_void_p]
        dll.pmStartTrackingProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        dll.pmStopTrackingProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        dll.pmRegisterDynamicQuery.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
                                               ctypes.POINTER(PM_QUERY_ELEMENT), ctypes.c_uint64,
                                               ctypes.c_double, ctypes.c_double]
        dll.pmRegisterDynamicQuery.restype = ctypes.c_int
        dll.pmPollDynamicQuery.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                           ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(ctypes.c_uint32)]
        dll.pmPollDynamicQuery.restype = ctypes.c_int
        sess = ctypes.c_void_p()
        st = dll.pmOpenSession(ctypes.byref(sess))
        if st != PM_STATUS_SUCCESS or not sess.value:
            raise RuntimeError(f"pmOpenSession fehlgeschlagen (Status {st}) — läuft der PresentMon-Service?")
        elems = (PM_QUERY_ELEMENT * 2)()
        elems[0].metric, elems[0].stat = PM_METRIC_PRESENTED_FPS, PM_STAT_AVG
        elems[1].metric, elems[1].stat = PM_METRIC_CPU_FRAME_TIME, PM_STAT_MAX
        query = ctypes.c_void_p()
        st = dll.pmRegisterDynamicQuery(sess, ctypes.byref(query), elems, 2, _WINDOW_MS, 0.0)
        if st != PM_STATUS_SUCCESS or not query.value:
            dll.pmCloseSession(sess)
            raise RuntimeError(f"pmRegisterDynamicQuery fehlgeschlagen (Status {st})")
        self._dll, self._sess, self._query = dll, sess, query
        self._fps_off, self._ft_off = int(elems[0].dataOffset), int(elems[1].dataOffset)
        self._blob = (ctypes.c_ubyte * _BLOB)()

    def _poll(self, pid: int):
        """Einen Prozess pollen → (fps, frametime) oder (None, None). Trackt ihn beim ersten Mal."""
        dll = self._dll
        if pid not in self._tracked:
            try:
                dll.pmStartTrackingProcess(self._sess, pid)
            except Exception:  # noqa: BLE001
                pass
            self._tracked.add(pid)
        self._nsc.value = _SC_CAP   # IN/OUT-Kapazität! sonst BAD_ARGUMENT
        if dll.pmPollDynamicQuery(self._query, pid, self._blob, ctypes.byref(self._nsc)) != PM_STATUS_SUCCESS:
            return None, None
        fps = ctypes.c_double.from_buffer(self._blob, self._fps_off).value
        ft = ctypes.c_double.from_buffer(self._blob, self._ft_off).value
        return (fps if fps and fps > 0 else None), (ft if ft and ft > 0 else None)

    def _scan_for_game(self):
        """Alle sichtbaren (nicht-Browser/Deck/Shell) Fenster-Prozesse pollen → das mit den meisten FPS
        ist das Spiel. Findet das Spiel UNABHÄNGIG vom Vordergrund (Panel im Browser anschauen geht)."""
        best = (0, None, None)
        for pid in _visible_window_pids():
            if any(d in _proc_name(pid) for d in _DENY):
                continue
            f, t = self._poll(pid)
            if f and f > (best[1] or 0.0):
                best = (pid, f, t)
        return best

    def _loop(self) -> None:
        period = 1.0 / _POLL_HZ
        self._nsc = ctypes.c_uint32(0)
        last_scan = 0.0
        while not self._stop.is_set():
            fps = ft = None
            # 1) am gelockten Spiel dranbleiben (schnell + billig)
            if self._game_pid:
                fps, ft = self._poll(self._game_pid)
                if fps is None:
                    self._game_pid = 0   # Spiel weg → neu suchen
            # 2) kein Spiel gelockt → ~1×/s alle sichtbaren Fenster scannen (das mit den meisten FPS = Spiel)
            if fps is None and (time.monotonic() - last_scan) > 1.0:
                last_scan = time.monotonic()
                pid, fps, ft = self._scan_for_game()
                self._game_pid = pid
            if fps is not None:
                self._tracked_pid = self._game_pid
                with self._lock:
                    self._fps.append(round(fps, 1)); self._ft.append(round(ft, 2) if ft else 0.0)
                self._fps_last, self._ft_last = round(fps, 1), (round(ft, 2) if ft else None)
                self._presenting = True
                self._reason = "live"
            else:
                self._idle()
            self._stop.wait(period)

    def _idle(self) -> None:
        if self._presenting:
            self._presenting = False
            self._reason = "kein Spiel im Vordergrund (nichts präsentiert Frames)"
            self._fps_last = self._ft_last = None

    def _teardown(self) -> None:
        d, s, q = self._dll, self._sess, self._query
        self._dll = self._sess = self._query = None
        try:
            if d and q: d.pmFreeDynamicQuery(q)
        except Exception: pass  # noqa: BLE001
        try:
            if d and s: d.pmCloseSession(s)
        except Exception: pass  # noqa: BLE001


def _explain(e: Exception) -> str:
    msg = str(e).strip()
    if isinstance(e, OSError) and "PresentMonAPI2" in msg:
        return "PresentMon-DLL nicht ladbar"
    return msg[:140] if msg else f"PresentMon-Fehler ({type(e).__name__})"
