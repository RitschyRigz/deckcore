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
Spiel (nichts präsentiert Frames) → `status.available=False`/`presenting=False` mit klarem Grund; die
Graph-Kachel meldet das, statt leer zu sein. PresentMon wird NIE vorausgesetzt — nur genutzt, wenn
vorhanden. **Stirbt der PresentMon-Service zur Laufzeit** (er ist selbst abstürzbar — schon passiert),
wird das binnen Sekunden erkannt → klarer Grund + automatischer Reconnect, statt fälschlich „kein Spiel".

Das Spiel wird per **Fenster-Scan** gefunden (nicht über den Vordergrund — so bleibt die Anzeige stabil,
während man das Panel im Browser anschaut und das Spiel borderless im Hintergrund weiterläuft): alle
sichtbaren Nicht-Browser/Deck/Shell-Fenster werden kurz gepollt, das mit den meisten FPS = Spiel. Nur
DIESER eine Prozess bleibt beim PresentMon-Service getrackt — alle Scan-Nieten werden sofort wieder
freigegeben (kein Tracking-Leak, der bei vielen Fenstern unnötig Last erzeugt).
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
_DEAD_TIMEOUT = 6.0      # so lange JEDER Poll fehlschlägt (trotz Versuchen) → Service tot → Reconnect
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
    """Sampelt FPS + Frametime des laufenden Spiels via PresentMon in zwei Ringpuffer (Spiel per Scan)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._fps = deque(maxlen=_RING)
        self._ft = deque(maxlen=_RING)
        self._fps_last: Optional[float] = None
        self._ft_last: Optional[float] = None
        self._tracked_pid = 0
        self._game_pid = 0           # aktuell gelocktes Spiel (sticky; via Scan gefunden, nicht Vordergrund)
        self._tracked: set = set()    # aktuell an die PresentMon-Tracking-API gemeldete PIDs (nur Spiel bleibt drin)
        self._presenting = False
        self._available = False
        self._reason = "nicht gestartet"
        self._dll = None
        self._sess = None
        self._query = None
        self._fps_off = 0
        self._ft_off = 0
        self._blob = None
        self._nsc = ctypes.c_uint32(0)
        self._last_ok = 0.0          # monotonic: letzter erfolgreicher Poll-CALL (Service-Lebensbeweis)
        self._fail_streak = 0        # Poll-Versuche seit dem letzten erfolgreichen Call
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
        t = self._thread
        self._thread = None
        if t and t.is_alive():
            t.join(timeout=2.0)   # Sampler beendet seine Schleife + schließt die Session sauber (finally)

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
        try:
            while not self._stop.is_set():
                try:
                    self._connect()           # DLL + Session + Query (wirft bei Fehler)
                    self._available = True
                    self._reason = "verbunden — warte auf ein Spiel"
                    self._loop()              # läuft bis Stop ODER Service-Tod (wirft) → Reconnect
                except Exception as e:  # noqa: BLE001
                    self._available = False
                    self._presenting = False
                    self._reason = _explain(e)
                    self._teardown()
                    self._stop.wait(_RECONNECT_COOLDOWN)
        finally:
            self._teardown()                  # sauberer Session-Close auch bei stop()

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

    # ── Tracking-Verwaltung: nur das Spiel bleibt getrackt (kein Leak) ───
    def _track(self, pid: int) -> None:
        if pid and pid not in self._tracked:
            try:
                self._dll.pmStartTrackingProcess(self._sess, pid)
            except Exception:  # noqa: BLE001
                pass
            self._tracked.add(pid)

    def _untrack(self, pid: int) -> None:
        if pid and pid in self._tracked:
            try:
                self._dll.pmStopTrackingProcess(self._sess, pid)
            except Exception:  # noqa: BLE001
                pass
            self._tracked.discard(pid)

    def _poll(self, pid: int):
        """Einen Prozess pollen → (fps, frametime) oder (None, None). Trackt ihn beim ersten Mal und merkt
        sich, ob der Poll-CALL selbst erfolgreich war (Service-Lebensbeweis, unabhängig von vorhandenen Daten:
        „kein Spiel" = Erfolg + 0 Frames, „Service tot" = Call-Fehler — die zwei dürfen NICHT verwechselt werden)."""
        dll = self._dll
        self._track(pid)
        self._nsc.value = _SC_CAP   # IN/OUT-Kapazität! sonst BAD_ARGUMENT
        st = dll.pmPollDynamicQuery(self._query, pid, self._blob, ctypes.byref(self._nsc))
        if st != PM_STATUS_SUCCESS:
            self._fail_streak += 1
            return None, None
        self._last_ok = time.monotonic()
        self._fail_streak = 0
        fps = ctypes.c_double.from_buffer(self._blob, self._fps_off).value
        ft = ctypes.c_double.from_buffer(self._blob, self._ft_off).value
        return (fps if fps and fps > 0 else None), (ft if ft and ft > 0 else None)

    def _scan_for_game(self):
        """Alle sichtbaren (nicht-Browser/Deck/Shell) Fenster-Prozesse pollen → das mit den meisten FPS ist
        das Spiel. Findet das Spiel UNABHÄNGIG vom Vordergrund. ⚠ Nur der Gewinner bleibt getrackt — jede Niete
        wird sofort wieder freigegeben, sonst sammelt der PresentMon-Service endlos Tracking-Einträge an."""
        best = (0, None, None)
        for pid in _visible_window_pids():
            if any(d in _proc_name(pid) for d in _DENY):
                continue
            f, t = self._poll(pid)
            if f and f > (best[1] or 0.0):
                if best[0] and best[0] != pid:
                    self._untrack(best[0])   # bisherigen Besten ablösen
                best = (pid, f, t)
            elif pid != best[0]:
                self._untrack(pid)           # Niete sofort freigeben (kein Leak)
        return best

    def _loop(self) -> None:
        period = 1.0 / _POLL_HZ
        self._last_ok = time.monotonic()
        self._fail_streak = 0
        last_scan = 0.0
        while not self._stop.is_set():
            fps = ft = None
            # 1) am gelockten Spiel dranbleiben (schnell + billig)
            if self._game_pid:
                fps, ft = self._poll(self._game_pid)
                if fps is None:
                    self._untrack(self._game_pid)   # Spiel weg → Tracking beenden + neu suchen
                    self._game_pid = 0
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
            # 3) Service-Tod erkennen: seit _DEAD_TIMEOUT KEIN erfolgreicher Poll trotz Versuchen → der
            #    PresentMon-Service ist weg (er kann selbst abstürzen) → raus + Reconnect mit klarem Grund,
            #    statt für immer fälschlich „kein Spiel" anzuzeigen.
            if self._fail_streak and (time.monotonic() - self._last_ok) > _DEAD_TIMEOUT:
                raise RuntimeError("PresentMon-Service antwortet nicht mehr (abgestürzt? Dienst neu starten)")
            self._stop.wait(period)

    def _idle(self) -> None:
        self._presenting = False
        self._fps_last = self._ft_last = None
        if self._fail_streak and (time.monotonic() - self._last_ok) > 2.0:
            self._reason = "PresentMon-Service nicht erreichbar (Neustart?)"   # Calls scheitern ≠ kein Spiel
        else:
            self._reason = "kein Spiel erkannt (nichts präsentiert Frames)"

    def _teardown(self) -> None:
        d, s, q = self._dll, self._sess, self._query
        self._dll = self._sess = self._query = None
        self._tracked.clear()    # neue Session = frisch tracken (alte PIDs galten nur für die alte Session)
        self._game_pid = 0
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
