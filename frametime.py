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
PM_STAT_PERCENTILE_99 = 2   # 99.-Perzentil (langsame Frames); Standard-PM_STAT-Enum, konsistent zu AVG=1/MAX=8
PM_STAT_PERCENTILE_01 = 5   # 1.-Perzentil (= 1% low FPS direkt)
PM_STAT_NONE = 0            # Frame-Event-Query: pro Frame ein Roh-Wert (keine Statistik)

_DLL_CANDIDATES = [
    r"C:\Program Files\Intel\PresentMonSharedService\PresentMonAPI2.dll",
    r"C:\Program Files\Intel\Intel Graphics Software\PresentMonAPI2.dll",
]
_WINDOW_MS = 140.0       # Statistik-Fenster der dynamischen Query (Spike-erfassend)
_PCT_WINDOW_MS = 60000.0 # rollendes 60-s-Fenster für 1%-low / avg (Perzentile brauchen viele Frames)
_POLL_HZ = 60.0          # Sampler-/Consume-Rate (Frame-Event-Modus: drainiert pro Tick ALLE neuen Frames)
_RING = 1200             # Ringpuffer-Tiefe (Per-Frame-Modus: ~5–13 s je nach FPS)
_FRAME_CAP = 512         # max. Frames pro pmConsumeFrames-Aufruf (RTSS-Stil Per-Frame-Abholung)
_RECONNECT_COOLDOWN = 8.0
_DEAD_TIMEOUT = 6.0      # so lange JEDER Poll fehlschlägt (trotz Versuchen) → Service tot → Reconnect
_BLOB = 16384            # großzügiger Poll-Blob (mehrere Swapchains)
_SC_CAP = 64             # ⚠ numSwapChains ist IN/OUT: VOR dem Poll die Blob-Kapazität (#Swapchains) setzen,
#                          sonst lehnt pmPollDynamicQuery mit BAD_ARGUMENT (Status 2) ab. Kostete 1 Debug-Runde.
# Sichtbare Prozesse, die KEIN Spiel sind (Browser/Deck/Shell) → nie als FPS-Quelle nehmen. So bleiben die
# Werte stehen, während man das Panel im Browser anschaut (das Spiel läuft borderless im Hintergrund weiter).
# ⚠ Spiegel-/Capture-Tools (RitschyMirror, OBS) präsentieren VSync-gelockt mit der Refresh-Rate (z.B. 165 flat) →
#   ohne Deny-Eintrag gewinnt so ein flacher Dauer-Präsentierer den „meiste FPS"-Scan, sobald das echte Spiel
#   unter die Refresh-Rate dippt, und der sticky Game-Lock klebt dann für immer an ihm fest (Anzeige konstant 165).
_DENY = ("chrome", "firefox", "msedge", "edge", "brave", "opera", "vivaldi", "iexplore", "explorer.exe",
         "rigzdeck", "python", "code.exe", "discord", "obs", "ritschymirror", "electron", "dwm.exe",
         "textinputhost", "searchhost", "applicationframehost", "shellexperiencehost", "widgets", "nvidia")

# ── Deny-Liste laufzeit-/config-erweiterbar (§0 — KEIN fest verdrahteter Tool-Name) ───────────────
# Der Basis-_DENY bleibt fest; ZUSAETZLICHE Namen (z. B. ein umbenanntes Capture-/Spiegel-Tool nach
# einem Update, das den Spiel-Scan sonst kapert) kommen ueber ENV FRAMETIME_DENY_EXTRA (Komma-getrennt)
# ODER zur Laufzeit via set_deny_extra() (vom Host persistiert + per API /api/frametime/config setzbar,
# auch remote). So bricht ein Mirror-Rename den Scan NIE wieder ohne Neubau. Substring-Match, lowercase.
def _split_names(raw) -> tuple:
    if not raw:
        return ()
    if isinstance(raw, str):
        raw = raw.split(",")
    return tuple(str(x).strip().lower() for x in raw if str(x).strip())

_deny_extra: tuple = _split_names(os.environ.get("FRAMETIME_DENY_EXTRA"))

def set_deny_extra(names) -> tuple:
    """Zusaetzliche Deny-Substrings setzen (ersetzt die bisherige Extra-Liste). Gibt die neue Liste zurueck."""
    global _deny_extra
    _deny_extra = _split_names(names)
    return _deny_extra

def deny_extra() -> tuple:
    return _deny_extra

def _is_denied(name: str) -> bool:
    if not name:
        return False
    return any(d in name for d in _DENY) or any(d in name for d in _deny_extra)


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
        self._ft = deque(maxlen=360)   # Frametime jetzt 60-Hz-Fixrate → 6 s reichen (Anzeige zeigt 3 s); kleinerer Payload
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
        self._pquery = None          # optionale 2. Query (langes Fenster) für Perzentile — Graceful: None = keine
        self._pblob = None
        self._p_low_off = self._p_ftp_off = self._p_avg_off = 0
        self._pct: dict = {}         # zuletzt gelesene Perzentile {fps_1pct_low, frametime_1pct, fps_avg}
        self._pct_t = 0.0            # monotonic des letzten Perzentil-Polls (gedrosselt ~1 Hz)
        self._fquery = None          # optionale Frame-Event-Query → ECHTE Frametime pro Frame (RTSS-Stil)
        self._f_ft_off = 0
        self._fblobsize = 0
        self._fblob = None
        self._ft_pid = 0             # Spiel-PID, für das der Frametime-Ring aktuell Daten hält (Reset bei Wechsel)
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
                "tracked_name": _proc_name(self._tracked_pid) if self._tracked_pid else "",
                "fps": self._fps_last, "frametime": self._ft_last, "reason": self._reason,
                "per_frame": bool(self._fquery), "deny_extra": list(_deny_extra),
                "percentiles": dict(self._pct) if self._pct else None}

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
        # ── Optionale 2. Query: Perzentile (1%-low FPS / 1%-Frametime / avg) über ein langes Fenster.
        #    Schlägt sie fehl (alte PresentMon-Version / Stat nicht unterstützt → BAD_ARGUMENT), läuft der
        #    30-Hz-Spike-Teil unberührt weiter — Perzentile sind dann einfach nicht verfügbar (Graceful).
        self._pquery = None
        try:
            pe = (PM_QUERY_ELEMENT * 3)()
            pe[0].metric, pe[0].stat = PM_METRIC_PRESENTED_FPS, PM_STAT_PERCENTILE_01   # 1% low FPS
            pe[1].metric, pe[1].stat = PM_METRIC_CPU_FRAME_TIME, PM_STAT_PERCENTILE_99  # langsame Frames (1%-„high")
            pe[2].metric, pe[2].stat = PM_METRIC_PRESENTED_FPS, PM_STAT_AVG             # avg FPS über 60 s
            pq = ctypes.c_void_p()
            pst = dll.pmRegisterDynamicQuery(sess, ctypes.byref(pq), pe, 3, _PCT_WINDOW_MS, 0.0)
            if pst == PM_STATUS_SUCCESS and pq.value:
                self._pquery = pq
                self._p_low_off, self._p_ftp_off, self._p_avg_off = (
                    int(pe[0].dataOffset), int(pe[1].dataOffset), int(pe[2].dataOffset))
                self._pblob = (ctypes.c_ubyte * _BLOB)()
        except Exception:  # noqa: BLE001
            self._pquery = None
        # ── Optionale Frame-Event-Query: ECHTE Frametime PRO FRAME (wie RTSS/Afterburner) statt 60-Hz-MAX-
        #    Aggregat. pmConsumeFrames liefert jeden einzelnen Present-Event → scharfe Spikes, kein Glätten.
        #    Fehlt die Funktion (ältere PresentMon) → fquery=None, Ring fällt graceful auf die Dynamic-Query-
        #    Frametime (Spike-erfassend via MAX, nur gröber) zurück. Harte Regel „läuft auf jeder Hardware".
        self._fquery = None
        try:
            dll.pmRegisterFrameQuery.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
                                                 ctypes.POINTER(PM_QUERY_ELEMENT), ctypes.c_uint64,
                                                 ctypes.POINTER(ctypes.c_uint32)]
            dll.pmRegisterFrameQuery.restype = ctypes.c_int
            dll.pmConsumeFrames.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                            ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(ctypes.c_uint32)]
            dll.pmConsumeFrames.restype = ctypes.c_int
            fe = (PM_QUERY_ELEMENT * 1)()
            fe[0].metric, fe[0].stat = PM_METRIC_CPU_FRAME_TIME, PM_STAT_NONE
            fq = ctypes.c_void_p()
            bsize = ctypes.c_uint32(0)
            fst = dll.pmRegisterFrameQuery(sess, ctypes.byref(fq), fe, 1, ctypes.byref(bsize))
            if fst == PM_STATUS_SUCCESS and fq.value and bsize.value:
                self._fquery = fq
                self._f_ft_off = int(fe[0].dataOffset)
                self._fblobsize = int(bsize.value)
                self._fblob = (ctypes.c_ubyte * (self._fblobsize * _FRAME_CAP))()
                log.info("PresentMon Frame-Event-Query aktiv — echte Per-Frame-Frametime (%d B/Frame)", self._fblobsize)
        except Exception:  # noqa: BLE001
            self._fquery = None

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
        ctypes.memset(self._blob, 0, _BLOB)   # ⚠ Blob nullen: ein nicht-präsentierender PID schreibt NICHTS in
        #   den Blob → ohne Nullen läse man den stale-FPS-Wert des zuvor gepollten Spiels (Geister-FPS → falscher
        #   PID gelockt). Mit Nullen liefert „präsentiert nicht" sauber 0. Kostete 1 Debug-Runde.
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

    def _poll_pct(self, pid: int) -> None:
        """Perzentil-Query (langes Fenster) fürs gelockte Spiel pollen — gedrosselt ~1 Hz aus dem Loop.
        Ohne registrierte Query (alte PresentMon) passiert nichts. Füllt ``self._pct``."""
        if not self._pquery:
            return
        try:
            ctypes.memset(self._pblob, 0, _BLOB)
            self._nsc.value = _SC_CAP   # IN/OUT-Kapazität (wie beim Haupt-Poll)
            if self._dll.pmPollDynamicQuery(self._pquery, pid, self._pblob, ctypes.byref(self._nsc)) != PM_STATUS_SUCCESS:
                return
            low = ctypes.c_double.from_buffer(self._pblob, self._p_low_off).value
            ftp = ctypes.c_double.from_buffer(self._pblob, self._p_ftp_off).value
            avg = ctypes.c_double.from_buffer(self._pblob, self._p_avg_off).value
            self._pct = {
                "fps_1pct_low": round(low, 1) if low and low > 0 else None,
                "frametime_1pct": round(ftp, 2) if ftp and ftp > 0 else None,
                "fps_avg": round(avg, 1) if avg and avg > 0 else None,
            }
        except Exception:  # noqa: BLE001
            pass

    def _consume_frames(self, pid: int) -> list:
        """Alle seit dem letzten Aufruf angefallenen EINZELNEN Frames des Spiels abholen (RTSS-Stil) →
        Liste echter Per-Frame-Frametimes in ms. Leer, wenn keine Frame-Query (Fallback) oder nichts Neues.
        pmConsumeFrames ist IN/OUT: nf = Kapazität rein, geschriebene Frame-Anzahl raus."""
        if not self._fquery:
            return []
        try:
            nf = ctypes.c_uint32(_FRAME_CAP)
            if self._dll.pmConsumeFrames(self._fquery, pid, self._fblob, ctypes.byref(nf)) != PM_STATUS_SUCCESS:
                return []
            out = []
            for i in range(min(nf.value, _FRAME_CAP)):
                ft = ctypes.c_double.from_buffer(self._fblob, i * self._fblobsize + self._f_ft_off).value
                if ft and 0.0 < ft < 10000.0:    # Plausibilitäts-Gate gegen falsches Blob-Layout
                    out.append(round(ft, 2))
            return out
        except Exception:  # noqa: BLE001
            return []

    def _scan_for_game(self):
        """Alle sichtbaren (nicht-Browser/Deck/Shell) Fenster-Prozesse pollen → das mit den meisten FPS ist
        das Spiel (UNABHÄNGIG vom Vordergrund). ⚠ PresentMon liefert erst NACH einem Statistik-Fenster Werte —
        die Kandidaten müssen also ÜBER mehrere Scans getrackt BLEIBEN, sonst füllt sich nie ein Fenster und das
        Spiel wird nie erkannt (genau dieser Regressions-Fehler trat auf). Gegen den Leak: nur AKTUELL sichtbare
        Kandidaten bleiben getrackt, verschwundene Fenster werden freigegeben → das Set bleibt = sichtbare
        Kandidaten; sobald ein Spiel gelockt ist, gibt der Loop ohnehin alles außer dem Spiel frei."""
        best = (0, None, None)
        candidates = set()
        for pid in _visible_window_pids():
            if _is_denied(_proc_name(pid)):
                continue
            candidates.add(pid)
            f, t = self._poll(pid)           # trackt beim ersten Mal und BLEIBT getrackt (Fenster füllt sich)
            if f and f > (best[1] or 0.0):
                best = (pid, f, t)
        for pid in list(self._tracked):      # nicht mehr sichtbare PIDs freigeben → kein endloser Aufbau
            if pid not in candidates and pid != self._game_pid:
                self._untrack(pid)
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
                if len(self._tracked) > 1:          # Spiel gelockt → nur DAS tracken, Rest sofort freigeben
                    for pid in list(self._tracked):
                        if pid != self._game_pid:
                            self._untrack(pid)
                frames = self._consume_frames(self._game_pid)   # ECHTE Per-Frame-Frametimes (RTSS-Stil)
                with self._lock:
                    if self._game_pid != self._ft_pid:          # neues Spiel → Ringe frisch
                        self._ft.clear(); self._fps.clear(); self._ft_pid = self._game_pid
                    self._fps.append(round(fps, 1))
                    if frames:
                        sf = sorted(frames); lm = sf[len(sf) // 2]; mx = sf[-1]
                        # 60-Hz-Fixrate + RUHIGE Baseline: pro Loop normal den Median (flüssiges Spiel = flache Linie,
                        # kein ms-Gezappel), aber einen GROBEN Einzel-Ausreißer (Frame > 2× Loop-Median = echter
                        # Stutter) voll durchreichen → man sieht die groben Spikes, nicht das feine Frame-Rauschen.
                        self._ft.append(round(mx if mx > lm * 2.0 else lm, 2))
                    elif ft:
                        self._ft.append(round(ft, 2))           # Fallback (alte PresentMon ohne Frame-Query)
                self._fps_last = round(fps, 1)
                # Großer Titel = Ø-Frametime = 1000/avg-fps → genau + ruhig (Median des Max-Rings zeigte ~20 % zu hoch).
                self._ft_last = round(1000.0 / fps, 2) if fps else (round(ft, 2) if ft else None)
                self._presenting = True
                self._reason = "live"
                if self._pquery and (time.monotonic() - self._pct_t) > 1.0:
                    self._pct_t = time.monotonic()
                    self._poll_pct(self._game_pid)
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
        self._pct = {}
        self._fps_last = self._ft_last = None
        if self._fail_streak and (time.monotonic() - self._last_ok) > 2.0:
            self._reason = "PresentMon-Service nicht erreichbar (Neustart?)"   # Calls scheitern ≠ kein Spiel
        else:
            self._reason = "kein Spiel erkannt (nichts präsentiert Frames)"

    def _teardown(self) -> None:
        d, s, q, pq, fq = self._dll, self._sess, self._query, self._pquery, self._fquery
        self._dll = self._sess = self._query = self._pquery = self._fquery = None
        self._tracked.clear()    # neue Session = frisch tracken (alte PIDs galten nur für die alte Session)
        self._game_pid = self._ft_pid = 0
        try:
            if d and q: d.pmFreeDynamicQuery(q)
        except Exception: pass  # noqa: BLE001
        try:
            if d and pq: d.pmFreeDynamicQuery(pq)
        except Exception: pass  # noqa: BLE001
        try:
            if d and fq: d.pmFreeFrameQuery(fq)
        except Exception: pass  # noqa: BLE001
        try:
            if d and s: d.pmCloseSession(s)
        except Exception: pass  # noqa: BLE001


def _explain(e: Exception) -> str:
    msg = str(e).strip()
    if isinstance(e, OSError) and "PresentMonAPI2" in msg:
        return "PresentMon-DLL nicht ladbar"
    return msg[:140] if msg else f"PresentMon-Fehler ({type(e).__name__})"
