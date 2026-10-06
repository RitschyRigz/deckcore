"""Jukebox — Soundbibliothek mit Audio-Player (mpv) und ehrlichem Wiedergabestatus.

Generisch und hostneutral: Die Bibliothek ist ein Ordner mit Audiodateien, jedem Track kann
ein *Stil* zugeordnet werden, ein Stil traegt optionale Deck-Actions fuer Start/Ende/Stop
(beliebige Aktionstypen des Decks, z.B. ``http``). Deckcore kennt weder Buehnen noch Shows;
was ein Stil ausloest, ist ausschliesslich Datum (``runtime/jukebox/styles.json``).

Wahrheitsquelle fuer den Zustand ist der Player selbst: mpv laeuft je Song als eigener
Prozess (nur Audio, kein Fenster) und meldet ueber seine JSON-IPC-Pipe ``file-loaded``,
Positions-/Dauer-Aenderungen und ``end-file`` mit Grund (eof | stop | error). Ein laufender
Prozess beweist nichts — erst ``file-loaded`` heisst „spielt", erst ``end-file`` heisst „zu
Ende". Jeder Start traegt eine ``request_id``; spaete Meldungen eines alten Songs werden an
ihr erkannt und verworfen.

Dateien (alle unter ``<runtime>/jukebox/``):
  config.json   {"library_dir": "...", "audio_device": "Name-Teil", "mpv_path": "..."}
  library.json  {"tracks": {"<track_id>": {"style": "dance", "title": "...", "max_seconds": 0}}}
                weitere Felder gehoeren dem Host (library()[i].meta); Aenderung nur ueber
                update_track_meta (atomar, gesperrt)
  styles.json   {"styles": {"dance": {"label": "Tanz", "on_start": [..], "on_end": [..], "on_stop": [..]}}}
  state.json    zuletzt veroeffentlichter Zustand (fuer file_field-Monitore und Hosts)

Stil-Felder ueber Start/Ende/Stop hinaus (alle optional, alle Daten):
  on_prepare          Actions, die SYNCHRON und befristet VOR dem Player-Start laufen
                      („Vorhang auf, dann Musik"); Zustand ``preparing``. Frist
                      ``prepare_timeout_s`` (Default PREPARE_TIMEOUT_S). Scheitern, Frist,
                      Stop oder Abloesung waehrend der Vorbereitung: KEIN Player-Start, der
                      Auftrag endet mit ``on_stop`` und benanntem Grund.
  tracks              Stil-Id, deren Musik dieser Stil leiht (zwei Rezepte, eine Musik);
                      gespielt wird dann mit dem eigenen Stil als Rezept.
  Auswahl (``play_random``): ``pick="random"`` (Default, ohne Wiederholung des zuletzt
  gespielten Tracks) oder ``pick="newest"`` = juengste veroeffentlichte Datei (mtime,
  Gleichstand nach Pfad) — ausdruecklich „neueste Datei", kein Streambezug.

Ducking (``duck(level)``): die laufende Wiedergabe wird weich auf ``level`` (0..1) der
konfigurierten Lautstaerke abgesenkt und mit ``duck(None)`` wieder hochgeholt — fuer Brunos
Antworten ueber der Musik und Richards „Push to Duck" auf dem Deck. Ein neuer Song startet
immer ungeduckt, und mit dem Ende eines Tracks (ended/stopped/error) endet auch sein
Ducking; ``duck(None)`` ohne laufenden Player setzt den Merker zurueck (ok). Zustand:
``status().ducked`` / ``duck_level``.

Veroeffentlicht ist eine Audiodatei, wenn sie unter ihrem endgueltigen Namen liegt und der
Name NICHT mit ``_`` beginnt: Kopieren als ``_name.mp3`` und danach umbenennen; Browser-
Downloads (``.crdownload``/``.part`` -> Zielname) tun das von selbst. Unveroeffentlichte
Dateien existieren fuer Bibliothek, Auswahl, Tasten und Ordnerwaechter nicht.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from .mpvflags import media_control_flags
except ImportError:  # Tests laden das Modul flach (sys.path = deckcore/)
    from mpvflags import media_control_flags  # type: ignore[no-redef]

log = logging.getLogger("deckcore.jukebox")

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac"}
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".webm", ".m4v"}
STATES = ("idle", "queued", "preparing", "starting", "playing", "paused", "ended", "stopped", "error")
_ACTIVE = {"preparing", "starting", "playing", "paused"}
PICKS = ("random", "newest", "latest_origin")
PREPARE_TIMEOUT_S = 8.0     # Frist fuer on_prepare, ueberschreibbar je Stil (prepare_timeout_s)
DUCK_LEVEL_DEFAULT = 0.25   # Anteil der konfigurierten Lautstaerke waehrend des Duckens
DUCK_FADE_MS = 250          # weiche Rampe (linear, in Schritten ueber mpv-IPC)
DUCK_FADE_STEPS = 6
_UNPUBLISHED_PREFIX = "_"


class RollbackFailed(RuntimeError):
    """Ein Dateischritt scheiterte UND das Zuruecklegen der schon bewegten Dateien auch —
    der Stand ist halb; Hosts muessen ihn als offen fuehren (Codex R11 F19)."""
# library.json-Felder, die die Jukebox selbst auswertet; alles andere reicht library() als ``meta`` durch.
_CORE_META = frozenset({"style", "title", "max_seconds", "source_date", "source_session",
                        "lyrics", "lyrics_offset"})


def _published(path: Path, exts: Optional[set] = None) -> bool:
    """Mediendatei unter endgueltigem Namen (siehe Modul-Docstring). ``exts`` = erlaubte
    Endungen der Mediathek (Default Audio)."""
    return path.suffix.lower() in (exts or AUDIO_EXTS) and not path.name.startswith(_UNPUBLISHED_PREFIX)


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")
    return s or "track"


# ───────────────────────────── Player (mpv, nur Audio) ─────────────────────────────

def _pipe_available(fh) -> Optional[int]:
    """Bytes, die auf der Pipe ohne Blockieren lesbar sind (Windows ``PeekNamedPipe``);
    ``None`` = Pipe geschlossen/kaputt, ``-1`` = nicht feststellbar (kein Windows).

    Hintergrund: Windows serialisiert Lese- und Schreibzugriffe auf EINER synchronen
    Named-Pipe. Ein blockierendes ``ReadFile`` (``readline``) haelt damit jeden ``WriteFile``
    hinter sich fest. Solange mpv spielt, kommen laufend ``time-pos``-Events und das faellt nie
    auf — sobald mpv **pausiert**, kommt kein Event mehr, der Read blockiert fuer immer und
    ``pause(False)`` dahinter auch (Musikbett 15.09.2026: Bett kam nach dem Jukebox-Song nicht
    zurueck). Deshalb liest der Lesethread nur, wenn wirklich Daten anliegen."""
    if os.name != "nt":
        return -1
    try:
        import ctypes
        import msvcrt
        handle = msvcrt.get_osfhandle(fh.fileno())
        avail = ctypes.c_ulong(0)
        ok = ctypes.windll.kernel32.PeekNamedPipe(
            ctypes.c_void_p(handle), None, 0, None, ctypes.byref(avail), None)
        if ok:
            return int(avail.value)
        err = ctypes.get_last_error() or ctypes.windll.kernel32.GetLastError()
        # 109 ERROR_BROKEN_PIPE, 233 ERROR_PIPE_NOT_CONNECTED, 6 ERROR_INVALID_HANDLE = weg.
        # Alles andere (z.B. waehrend eines gleichzeitigen WriteFile auf demselben Handle)
        # ist ein voruebergehender Fehlschlag: als "keine Daten" werten, der Aufrufer
        # entscheidet ueber den Prozesszustand (Musikbett 15.09.2026: ein einzelner
        # Fehlschlag beim Pausieren wurde als Pipe-Ende gelesen -> Track "error").
        return None if err in (109, 233, 6) else 0
    except Exception:  # noqa: BLE001
        return None


class _MpvAudio:
    """Ein mpv-Prozess je Song mit persistenter IPC-Verbindung (ein Client = keine BUSY-Pipe).

    Ereignisse gehen als Dicts an ``on_event``: {"event": "loaded"|"progress"|"paused"|"end",
    "reason": ..., "position": ..., "duration": ...}. Alles laeuft in einem Lesethread; der
    Aufrufer entscheidet, was er mit spaeten Meldungen macht (request_id).
    """

    def __init__(self, mpv_path: str, pipe_name: str, on_event: Callable[[dict], None]) -> None:
        self._mpv = mpv_path
        self._pipe = pipe_name
        self._on_event = on_event
        self._proc: Optional[subprocess.Popen] = None
        self._fh = None
        self._wlock = threading.Lock()
        self._closed = False

    # -- Start / Stop -------------------------------------------------------------------
    def start(self, file: str, audio_device: str = "", volume: Optional[float] = None) -> None:
        args = [self._mpv, file, "--no-video", "--force-window=no", "--no-terminal",
                "--idle=no", "--keep-open=no", "--loop-file=no",
                "--input-ipc-server=" + self._pipe, "--no-input-default-bindings",
                "--msg-level=all=no"]
        # Kein Gehoer fuer Windows-Medientasten/SMTC: dieser Player wird NUR ueber die Pipe
        # bedient (Kopfhoerer-Play/Pause pausierte am 17.09.2026 das Bett ohne jede Spur).
        args += media_control_flags(self._mpv)
        if audio_device:
            args.append("--audio-device=" + audio_device)
        if volume is not None:
            args.append(f"--volume={max(0, min(130, int(volume)))}")
        creation = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW
        self._proc = subprocess.Popen(args, creationflags=creation, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._reader, name="jukebox-mpv-ipc", daemon=True).start()

    def stop(self) -> None:
        self._closed = True
        if not self._send({"command": ["quit"]}):
            self._kill()

    def pause(self, flag: bool) -> bool:
        return self._send({"command": ["set_property", "pause", bool(flag)]})

    def set_volume(self, volume: float) -> bool:
        return self._send({"command": ["set_property", "volume", max(0.0, min(130.0, float(volume)))]})

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _kill(self) -> None:
        try:
            if self._proc and self._proc.poll() is None:
                self._proc.kill()
        except Exception:  # noqa: BLE001
            pass

    # -- IPC ----------------------------------------------------------------------------
    def _open_pipe(self, timeout_s: float = 4.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                return None
            try:
                return open(self._pipe, "r+b", buffering=0)
            except OSError:
                time.sleep(0.05)
        return None

    def _send(self, cmd: dict) -> bool:
        fh = self._fh
        if fh is None:
            return False
        try:
            with self._wlock:
                fh.write((json.dumps(cmd) + "\n").encode("utf-8"))
            return True
        except OSError:
            return False

    def _reader(self) -> None:
        fh = self._open_pipe()
        if fh is None:
            # mpv ist gestorben, bevor die Pipe stand → Fehler ueber den Exit-Code melden.
            code = self._proc.poll() if self._proc else None
            self._on_event({"event": "end", "reason": "error",
                            "detail": f"mpv beendet vor IPC (exit {code})"})
            return
        self._fh = fh
        for i, prop in enumerate(("time-pos", "duration", "pause"), start=1):
            self._send({"command": ["observe_property", i, prop]})
        position = 0.0
        duration = 0.0
        ended = False
        buf = b""
        try:
            while True:
                nl = buf.find(b"\n")
                if nl < 0:
                    avail = _pipe_available(fh)
                    if avail is None:
                        break                       # Pipe weg (mpv beendet)
                    if avail == 0:
                        if self._proc is not None and self._proc.poll() is not None:
                            # Prozess weg: Rest lesen, dann Schluss
                            if _pipe_available(fh):
                                continue
                            break
                        time.sleep(0.02)
                        continue
                    chunk = fh.read(avail) if avail > 0 else fh.readline()
                    if not chunk:
                        break
                    buf += chunk
                    continue
                line, buf = buf[:nl + 1], buf[nl + 1:]
                try:
                    msg = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    continue
                ev = msg.get("event")
                if ev == "file-loaded":
                    self._on_event({"event": "loaded"})
                elif ev == "property-change":
                    name, data = msg.get("name"), msg.get("data")
                    if name == "time-pos" and isinstance(data, (int, float)):
                        position = float(data)
                        self._on_event({"event": "progress", "position": position, "duration": duration})
                    elif name == "duration" and isinstance(data, (int, float)):
                        duration = float(data)
                        self._on_event({"event": "progress", "position": position, "duration": duration})
                    elif name == "pause" and isinstance(data, bool):
                        self._on_event({"event": "paused", "paused": data})
                elif ev == "end-file":
                    reason = str(msg.get("reason") or "unknown")
                    ended = True
                    self._on_event({"event": "end", "reason": reason,
                                    "position": position, "duration": duration,
                                    "detail": str((msg.get("file_error") or ""))})
                    break
        except OSError:
            pass
        finally:
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass
            self._fh = None
        if not ended:
            # Pipe weg ohne end-file: Prozess wurde gestoppt/abgeschossen oder ist abgestuerzt.
            code = None
            try:
                code = self._proc.wait(timeout=2) if self._proc else None
            except Exception:  # noqa: BLE001
                pass
            reason = "stop" if self._closed else ("error" if code not in (0, None) else "eof")
            self._on_event({"event": "end", "reason": reason, "position": position,
                            "duration": duration, "detail": f"pipe closed (exit {code})"})


def _list_mpv_processes() -> list:
    """[(pid, cmdline)] aller mpv.exe (Windows, Win32_Process)."""
    out = subprocess.run(
        ["powershell", "-NonInteractive", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='mpv.exe'\" | ForEach-Object { "
         "$_.ProcessId.ToString() + '|' + $_.CommandLine }"],
        capture_output=True, text=True, timeout=15, creationflags=0x08000000).stdout
    rows = []
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition("|")
        if pid.isdigit():
            rows.append((int(pid), cmd))
    return rows


def _kill_process(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(int(pid)), "/F", "/T"], capture_output=True, timeout=10,
                   creationflags=0x08000000)


def list_audio_devices(mpv_path: str) -> list[dict]:
    """``mpv --audio-device=help`` parsen → [{"id": "wasapi/{...}", "name": "..."}]."""
    try:
        out = subprocess.run([mpv_path, "--audio-device=help"], capture_output=True,
                             text=True, timeout=8, creationflags=0x08000000 if os.name == "nt" else 0).stdout
    except Exception:  # noqa: BLE001
        return []
    devices = []
    for m in re.finditer(r"'([^']+)'\s+\(([^)]*)\)", out):
        devices.append({"id": m.group(1), "name": m.group(2)})
    return devices


def resolve_audio_device(mpv_path: str, wanted: str) -> str:
    """Geraete-Id aus Name-Teil (case-insensitiv); leer = mpv-Default. Eine Id bleibt eine Id."""
    w = str(wanted or "").strip()
    if not w or "/" in w:
        return w
    for d in list_audio_devices(mpv_path):
        if w.lower() in d["name"].lower():
            return d["id"]
    return ""


# ───────────────────────────── Bibliothek + Zustandsautomat ─────────────────────────────

_SRT_TIME = re.compile(r"(\d+):(\d\d):(\d\d)[,.](\d{1,3})")
_LYRIC_MIN_SECONDS = 0.8   # Suno-SRTs haben teils Cues mit ~20 ms Dauer -> bis zum naechsten Cue strecken


def parse_srt(text: str, *, offset: float = 0.0) -> list[dict]:
    """SRT -> [{index, start, end, text}] (Sekunden). Robust gegen BOM/CRLF/fehlende Nummern,
    HTML-Tags werden entfernt. Entartete Cues (Dauer < 0.8 s) laufen bis zum Start des naechsten
    Cues (mindestens 0.8 s); Cues mit gleichem Start werden zu EINER Zeile zusammengefasst."""
    def _sec(m) -> float:
        h, mi, s, ms = m.groups()
        return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0

    raw: list[dict] = []
    for block in re.split(r"\r?\n\s*\r?\n", text.replace("\ufeff", "").strip()):
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        ti = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if ti is None:
            continue
        times = _SRT_TIME.findall(lines[ti])
        if len(times) < 2:
            continue
        start = _sec(_SRT_TIME.search(lines[ti]))
        end = _sec(list(_SRT_TIME.finditer(lines[ti]))[1])
        body = " ".join(re.sub(r"<[^>]+>", "", ln) for ln in lines[ti + 1:]).strip()
        if not body:
            continue
        raw.append({"start": start + offset, "end": end + offset, "text": body})
    raw.sort(key=lambda c: c["start"])
    # Suno-Downloader: ganze Bloecke mit IDENTISCHEM Zeitstempel (Timing unbekannt). Solche
    # Gruppen werden gleichmaessig bis zum naechsten echten Cue-Start verteilt statt gestapelt.
    merged: list[dict] = []
    i = 0
    while i < len(raw):
        group = [raw[i]]
        while i + len(group) < len(raw) and abs(raw[i + len(group)]["start"] - raw[i]["start"]) < 0.05:
            group.append(raw[i + len(group)])
        nxt_i = i + len(group)
        span_end = raw[nxt_i]["start"] if nxt_i < len(raw) else raw[i]["start"] + 3.0 * len(group)
        if len(group) == 1:
            merged.append(dict(group[0]))
        else:
            step = max(_LYRIC_MIN_SECONDS, (span_end - raw[i]["start"]) / len(group))
            for k, c in enumerate(group):
                s = raw[i]["start"] + k * step
                merged.append({"start": s, "end": s + step, "text": c["text"]})
        i = nxt_i
    out: list[dict] = []
    for i, c in enumerate(merged):
        nxt = merged[i + 1]["start"] if i + 1 < len(merged) else None
        end = c["end"]
        if end - c["start"] < _LYRIC_MIN_SECONDS:
            end = nxt if nxt is not None else c["start"] + 3.0
        if nxt is not None:
            end = min(end, nxt)
        end = max(end, c["start"] + min(_LYRIC_MIN_SECONDS, (nxt - c["start"]) if nxt is not None else _LYRIC_MIN_SECONDS))
        out.append({"index": i, "start": round(max(0.0, c["start"]), 3), "end": round(end, 3), "text": c["text"]})
    return out


def lyric_at(cues: list[dict], position: float) -> dict:
    """Aktuelle Zeile zur Position: {index, text, start, end, next, count, progress}. Zwischen zwei
    Cues (Pause) ist ``text`` leer und ``next`` die kommende Zeile; ohne Cues: {}."""
    if not cues:
        return {}
    cur = None
    nxt = None
    for c in cues:
        if c["start"] <= position < c["end"]:
            cur = c
        elif c["start"] > position:
            nxt = c
            break
    if cur is None:
        return {"index": -1, "text": "", "start": None, "end": None,
                "next": nxt["text"] if nxt else "", "next_in": round(nxt["start"] - position, 1) if nxt else None,
                "count": len(cues), "progress": 0.0}
    span = max(0.001, cur["end"] - cur["start"])
    return {"index": cur["index"], "text": cur["text"], "start": cur["start"], "end": cur["end"],
            "next": nxt["text"] if nxt else "", "next_in": None,
            "count": len(cues), "progress": round(min(1.0, (position - cur["start"]) / span), 3)}


class Jukebox:
    def __init__(self, runtime_dir: Path, *, mpv_resolver: Callable[[Optional[str]], str],
                 run_actions: Callable[[list, dict], dict],
                 publish: Optional[Callable[[str, dict], None]] = None,
                 subdir: str = "jukebox", media_exts: Optional[set] = None,
                 player_factory: Optional[Callable[..., Any]] = None,
                 cover_route: str = "/api/jukebox/cover") -> None:
        # EINE Mediathek-Klasse, N Instanzen: ``subdir`` = eigener Laufzeitordner (config/
        # styles/library/state), ``media_exts`` = welche Dateien zaehlen (Audio-Default),
        # ``player_factory(mpv, pipe, on_event)`` = anderer Player als mpv (z.B. eine OBS-
        # Medienquelle beim Host); ohne Factory bleibt alles wie bei der Musik-Jukebox.
        self._dir = Path(runtime_dir) / str(subdir or "jukebox")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._resolve_mpv = mpv_resolver
        self._run_actions = run_actions
        self._publish = publish
        self._exts = set(media_exts) if media_exts else set(AUDIO_EXTS)
        self._player_factory = player_factory
        self._cover_route = str(cover_route or "/api/jukebox/cover").rstrip("/")
        # Kennung dieser Instanz (Laufzeitordner) in jedem Pipe-Namen: so erkennt ein neuer
        # Host-Prozess die mpv-Waisen SEINER Vorgaenger-Instanz (Cockpit per Kill neu gestartet,
        # Player lief weiter: „zwei Tracks uebereinander", Test-Stream 15.09.2026) — und laesst
        # fremde Instanzen (RigzDeck auf derselben Maschine) in Ruhe.
        self._pipe_tag = hashlib.sha1(str(self._dir.resolve()).lower().encode("utf-8")).hexdigest()[:8]
        self._config_lock = threading.Lock()
        self._meta_lock = threading.Lock()      # library.json: Lesen-Aendern-Schreiben
        self._lock = threading.RLock()
        # Start-Sperre: Abloesung, Uebernahme (preparing -> starting) und Player-Start bilden
        # EINE kritische Sektion gegenueber stop()/_cap(). Sonst ueberschreibt ein Start im
        # Fenster nach der Vorbereitung einen dazwischen gekommenen Stop (Codex-Review
        # 11.09.2026, Theater-Runde 1). Die (lange) Vorbereitung selbst laeuft ausserhalb.
        self._start_lock = threading.Lock()
        self._player: Optional[_MpvAudio] = None
        # Host-Haken (optional, Daten bleiben generisch): ``before_play(track, style, request_id)``
        # darf {"deferred": True, ...} liefern → der Start wird vom Host spaeter mit derselben
        # request_id ueber play(..., direct=True) ausgeloest (z.B. Ansage einer Show zuerst).
        self.before_play: Optional[Callable[[dict, str, str], Optional[dict]]] = None
        self.cancel_deferred: Optional[Callable[[str], dict]] = None
        # In-Prozess-Zuhoerer fuer Zustandswechsel (Hosts), zusaetzlich zum Bus-``publish``.
        self.listeners: list[Callable[[dict], None]] = []
        self._lyrics_cache: dict[str, tuple] = {}
        self._state: dict = {"state": "idle", "request_id": None, "track": None, "style": None,
                             "position": 0.0, "duration": 0.0, "reason": None, "lyric": {},
                             "ducked": False, "duck_level": None, "updated_at": time.time()}
        self._duck_generation = 0      # laufende Rampe erkennt eine neuere Anweisung
        self._last_progress_publish = 0.0
        # Laufnummer je Zustandsaenderung (unter _lock vergeben). Veroeffentlicht wird in
        # dieser Reihenfolge: ein aelterer Schnappschuss, dessen Thread erst nach einem
        # neueren zum Zug kommt, wird verworfen — sonst koennte er beim Host die Lease des
        # neueren Auftrags verdraengen (Abschlussrunde 11.09.2026).
        self._seq = 0
        self._publish_lock = threading.Lock()
        self._published_seq = 0
        self._write_state()

    # -- Config / Daten -------------------------------------------------------------------
    def _json(self, name: str) -> dict:
        """Datei lesen; ein voruebergehend unlesbarer Stand (jemand schreibt gerade) wird kurz
        erneut versucht statt sofort als „leer" gedeutet."""
        v = self._json_strict(name)
        return v if v is not None else {}

    def _json_strict(self, name: str) -> Optional[dict]:
        """``None`` = Datei existiert, ist aber (auch nach Wiederholung) nicht lesbar."""
        p = self._dir / name
        if not p.exists():
            return {}
        last = None
        for attempt in range(4):
            try:
                v = json.loads(p.read_text(encoding="utf-8-sig"))
                return v if isinstance(v, dict) else {}
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(0.03 * (attempt + 1))
        log.warning("%s/%s unlesbar: %s", self._dir.name, name, last)
        return None

    def _write_json(self, name: str, data: dict) -> None:
        """Atomar: erst Nachbardatei, dann umbenennen — ein Leser sieht nie eine halbe Datei.

        Unter Windows schlaegt ``os.replace`` fehl, solange ein Leser die Zieldatei gerade
        offen hat (der Regie-Takt liest config/state jede Sekunde; Stream 17.09.2026 19:04:51:
        Lautstaerke nicht gespeichert, ``PermissionError [WinError 5]``). Deshalb kurz warten
        und erneut versuchen; bleibt es dabei, faellt der Fehler sichtbar an den Aufrufer
        zurueck — nichts wird still verworfen, nichts halb geschrieben.
        """
        p = self._dir / name
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
        last: Optional[BaseException] = None
        for attempt in range(6):
            try:
                os.replace(tmp, p)
                return
            except PermissionError as e:
                last = e
                time.sleep(0.03 * (attempt + 1))
        try:
            tmp.unlink()
        except OSError:
            pass
        log.warning("%s/%s nicht ersetzbar (Datei belegt): %s", self._dir.name, name, last)
        raise last  # type: ignore[misc]

    def config(self) -> dict:
        return self._json("config.json")

    def set_config(self, **kw) -> dict:
        """Lesen-aendern-schreiben unter einer Sperre und atomar. Ist die Datei gerade nicht
        lesbar, wird NICHT geschrieben (sonst schrumpft die Config auf die Aenderung —
        Test-Stream 15.09.2026: Bett-Config bestand nur noch aus ``volume``, Bibliothek leer)."""
        with self._config_lock:
            cfg = self._json_strict("config.json")
            if cfg is None:
                log.warning("%s/config.json nicht lesbar — Aenderung %s verworfen", self._dir.name, sorted(kw))
                return self.config()
            for k, v in kw.items():
                if v is not None:
                    cfg[k] = v
            self._write_json("config.json", cfg)
            return cfg

    def styles(self) -> dict:
        raw = self._json("styles.json").get("styles")
        return raw if isinstance(raw, dict) else {}

    def set_styles(self, styles: dict) -> dict:
        """Stil-Katalog (``styles.json``) als Ganzes setzen — fuer Hosts, deren Abschnitte aus
        Daten entstehen (z. B. je Chatter ein Abschnitt der TTS-Box). Atomar unter der Meta-Sperre;
        andere Dateien bleiben unberuehrt."""
        if not isinstance(styles, dict):
            raise ValueError("styles muss ein Objekt sein")
        with self._meta_lock:
            doc = self._json("styles.json")
            doc["styles"] = {str(k): (dict(v) if isinstance(v, dict) else {}) for k, v in styles.items()}
            self._write_json("styles.json", doc)
        return doc["styles"]

    def set_track_style(self, track_id: str, style: str, **fields) -> dict:
        patch = {k: v for k, v in fields.items() if v is not None}
        patch["style"] = str(style or "")
        return self.update_track_meta(track_id, patch)

    def update_track_meta(self, track_id: str, patch: dict) -> dict:
        """Metadaten eines Tracks in ``library.json`` aendern — atomar und unter Sperre.

        ``patch`` = {Feld: Wert}; ``None`` oder ``""`` entfernt das Feld. Welche Felder es gibt,
        entscheidet der Host (die Jukebox reicht unbekannte Felder in ``library()`` unter
        ``meta`` durch). Ist ``library.json`` vorhanden, aber unlesbar, wird NICHT geschrieben
        (sonst ersetzte ein leerer Stand alle Metadaten) — der Fehler faellt an den Aufrufer."""
        track_id = str(track_id or "").strip()
        if not track_id:
            raise ValueError("track_id fehlt")
        with self._meta_lock:
            lib = self._json_strict("library.json")
            if lib is None:
                raise RuntimeError("library.json unlesbar — nichts geschrieben")
            tracks = lib.get("tracks") if isinstance(lib.get("tracks"), dict) else {}
            lib["tracks"] = tracks
            entry = dict(tracks.get(track_id)) if isinstance(tracks.get(track_id), dict) else {}
            for k, v in (patch or {}).items():
                if v is None or v == "":
                    entry.pop(str(k), None)
                else:
                    entry[str(k)] = v
            if entry:
                tracks[track_id] = entry
            else:
                tracks.pop(track_id, None)
            self._write_json("library.json", lib)
            return entry

    def favorite(self, track_id: str, on: Optional[bool] = None) -> dict:
        """Favoriten-Stern eines Tracks setzen/loeschen (``on`` None = umschalten). Der Stern ist
        ein Host-neutrales Metafeld ``favorite`` in library.json; Hosts (Musik, Videos, TTS)
        zeigen daraus denselben Abschnitt „Favoriten" auf dem Deck (Richard 06.10.2026)."""
        t = self.track(track_id)
        if not t:
            return {"ok": False, "reason": f"unbekannter Track: {track_id}"}
        now_on = bool(t.get("favorite"))
        want = (not now_on) if on is None else bool(on)
        try:
            self.update_track_meta(t["id"], {"favorite": True if want else None})
        except (RuntimeError, ValueError, OSError) as e:
            return {"ok": False, "reason": str(e)}
        return {"ok": True, "track": t["id"], "title": t["title"], "favorite": want}

    def library(self) -> list[dict]:
        """Ordner scannen; Stil aus library.json, sonst aus dem Unterordnernamen; sonst leer."""
        cfg = self.config()
        lib_dir = str(cfg.get("library_dir") or "").strip()
        if not lib_dir:
            return []      # kein Ordner konfiguriert: Path("") waere das Arbeitsverzeichnis
        root = Path(lib_dir)
        if not root.is_dir():
            return []
        meta = self._json("library.json").get("tracks")
        meta = meta if isinstance(meta, dict) else {}
        out: list[dict] = []
        for p in sorted(root.rglob("*")):
            if not p.is_file() or not _published(p, self._exts):
                continue
            try:
                mtime = float(p.stat().st_mtime)
            except OSError:
                continue
            rel = p.relative_to(root)
            tid = _slug(str(rel.with_suffix("")))
            m = meta.get(tid) if isinstance(meta.get(tid), dict) else {}
            folder_style = rel.parts[0] if len(rel.parts) > 1 else ""
            cover = self._cover_sidecar(p, root)
            title = str(m.get("title") or p.stem)
            try:
                st = p.stat()
                added_at = float(getattr(st, "st_birthtime", 0) or st.st_ctime)
            except OSError:
                added_at = mtime
            out.append({
                "id": tid, "file": str(p), "rel": str(rel).replace("\\", "/"),
                "title": title,
                # Titel steht ausdruecklich in library.json (auch wenn er dem Dateinamen gleicht) —
                # Hosts unterscheiden so „kein Titel" von „bewusst so benannt" (Codex R14 F24).
                "title_set": bool(str(m.get("title") or "").strip()),
                "style": str(m.get("style") or folder_style or ""),
                "max_seconds": float(m.get("max_seconds") or 0) or 0.0,
                "mtime": mtime,
                # Herkunft getrennt von der Aufnahme in die Bibliothek: ``source_date`` = Quell-
                # stream (Metadaten oder Titel), ``source_session`` = Session-Prefix (Metadaten),
                # ``added_at`` = wann die Datei hier angelegt wurde (Neuzugang), nie „produziert".
                # Herkunft aus Metadaten oder dem DATEINAMEN — nie aus dem Anzeigetitel: ein
                # gesetzter Titel („Der Himmel faltet sich") traegt kein Datum mehr, und
                # ``pick=latest_origin`` saehe sonst keine Herkunft (Musikseite M1, 25.09.2026).
                "source_date": self._origin_date(m, p.stem),
                "source_session": str(m.get("source_session") or ""),
                "added_at": added_at,
                # Favoriten-Stern (Metafeld ``favorite``), von Hosts/Deck gemeinsam genutzt.
                "favorite": bool(m.get("favorite")),
                "cover_url": f"{self._cover_route}/{tid}?v={cover.stat().st_mtime_ns}" if cover else "",
                # Freie Host-Felder aus library.json (z. B. Spiel/Anlass einer Musikseite) —
                # die Jukebox deutet sie nicht, sie reicht sie nur durch.
                "meta": {k: v for k, v in m.items() if k not in _CORE_META},
            })
        return out

    @staticmethod
    def _origin_date(meta: dict, title: str) -> str:
        """Herkunft eines Tracks als ISO-Datum: ``library.json``-Feld ``source_date`` (von der
        Auslieferung gesetzt) oder das fuehrende Datum im Titel (Lieferkonvention
        ``YYYY-MM-DD - Titel`` = Quellstream). Keine Dateizeit — die sagt nur, wann kopiert wurde."""
        val = str(meta.get("source_date") or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", val):
            return val
        m = re.match(r"\s*(\d{4}-\d{2}-\d{2})(?!\d)", str(title or ""))
        return m.group(1) if m else ""

    @staticmethod
    def _cover_sidecar(audio: Path, root: Path) -> Optional[Path]:
        """Only image sidecars belonging to this audio, inside the configured library."""
        for suffix in (".jpg", ".png", ".webp", ".jpeg"):
            p = audio.with_suffix(suffix)
            try:
                if p.resolve().is_relative_to(root.resolve()) and p.is_file() and 0 < p.stat().st_size <= 16_000_000:
                    return p
            except OSError:
                continue
        return None

    def cover(self, track_id: str) -> Optional[Path]:
        """Resolve by catalog ID; HTTP clients cannot supply filesystem paths."""
        tr = self.track(track_id)
        if not tr:
            return None
        return self._cover_sidecar(Path(tr["file"]), Path(str(self.config().get("library_dir") or "")))

    def style_pool(self, style: str = "") -> tuple[list[dict], str]:
        """Tracks eines Stils — samt Musik-Leihe: traegt der Stil ``tracks: "<anderer>"``,
        kommt der Pool von dort. Liefert ``(pool, pool_stil)``; ohne Stil alle Tracks."""
        spec = self.styles().get(style) if style else None
        pool_style = str((spec or {}).get("tracks") or style or "") if isinstance(spec, dict) else str(style or "")
        pool = [t for t in self.library() if not pool_style or t.get("style") == pool_style]
        return pool, pool_style

    def lyrics(self, track_id: str) -> list[dict]:
        """Mitsing-Text eines Tracks: ``<audio-stem>.srt`` neben der Datei (oder ``lyrics`` in
        library.json, relativ zur Bibliothek). ``lyrics_offset`` (Sekunden, +/-) verschiebt alle
        Cues. Ohne Datei: leere Liste. Gecacht nach Pfad+mtime."""
        tr = self.track(track_id)
        if not tr:
            return []
        cfg = self.config()
        root = Path(str(cfg.get("library_dir") or ""))
        meta = (self._json("library.json").get("tracks") or {}).get(track_id) or {}
        meta = meta if isinstance(meta, dict) else {}
        srt = Path(tr["file"]).with_suffix(".srt")
        if meta.get("lyrics"):
            srt = root / str(meta["lyrics"])
        if not srt.is_file():
            return []
        try:
            key = (str(srt), int(srt.stat().st_mtime), float(meta.get("lyrics_offset") or 0))
        except OSError:
            return []
        cached = self._lyrics_cache.get(track_id)
        if cached and cached[0] == key:
            return cached[1]
        try:
            cues = parse_srt(srt.read_text(encoding="utf-8-sig"), offset=key[2])
        except Exception as e:  # noqa: BLE001
            log.warning("SRT %s unlesbar: %s", srt, e)
            cues = []
        self._lyrics_cache[track_id] = (key, cues)
        return cues

    def library_signature(self) -> str:
        """Fingerabdruck der Bibliothek (Dateien + Groesse + mtime, library.json, styles.json):
        aendert er sich, hat sich der Ordner geaendert -> Tasten neu ableiten."""
        cfg = self.config()
        root = Path(str(cfg.get("library_dir") or ""))
        parts: list[str] = []
        if root.is_dir():
            for p in sorted(root.rglob("*")):
                if p.is_file() and (_published(p, self._exts) or (not p.name.startswith('_') and p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))):
                    try:
                        st = p.stat()
                        parts.append(f"{p.relative_to(root)}|{st.st_size}|{st.st_mtime_ns}")
                    except OSError:
                        continue
        for name in ("library.json", "styles.json", "config.json"):
            f = self._dir / name
            try:
                parts.append(f"{name}|{f.stat().st_mtime_ns}" if f.exists() else f"{name}|-")
            except OSError:
                parts.append(f"{name}|?")
        return "\n".join(parts)

    def meta_signature(self) -> str:
        """Billiger Fingerabdruck NUR der Metadaten (``library.json``-Zeitstempel) — fuer Hosts,
        die Anzeige-Titel je Abruf aufloesen, ohne jedes Mal die Bibliothek zu scannen."""
        try:
            return str((self._dir / "library.json").stat().st_mtime_ns)
        except OSError:
            return "-"

    # -- Ordner = Kategorie: Umzug, Papierkorb, Kennungs-Aliasse ---------------------------
    # Die track_id ist der Pfad-Slug. Ein Umzug in einen anderen Unterordner aendert sie; wer
    # alte Kennungen gespeichert hat (Verlauf, Protokolle), loest sie ueber ``aliases()`` auf.
    # Die Jukebox kennt dabei keine Hosts: Deck-Tasten, Programme, Kataloge ziehen die Hosts nach.

    SIDECAR_EXTS = (".srt", ".png", ".jpg", ".jpeg", ".webp", ".lrc")

    def aliases(self) -> dict:
        """{alte_id: aktuelle_id} aller Umzuege (Ketten verdichtet)."""
        raw = self._json("aliases.json").get("aliases")
        return {str(k): str(v) for k, v in (raw or {}).items()} if isinstance(raw, dict) else {}

    def resolve_id(self, track_id: str) -> str:
        return self.aliases().get(str(track_id), str(track_id))

    def _playing_track(self) -> str:
        snap = self.status()
        return str(snap.get("track") or "") if snap.get("state") in (_ACTIVE | {"queued"}) else ""

    def _track_files(self, audio: Path) -> list:
        """Audio + alle Begleitdateien gleichen Stamms (Songtext, Cover)."""
        files = [audio]
        for ext in self.SIDECAR_EXTS:
            side = audio.with_suffix(ext)
            if side.is_file() and side != audio:
                files.append(side)
        return files

    def trash_dir(self) -> Path:
        """Papierkorb NEBEN der Bibliothek (nie darin: ``_`` blendet nur Dateinamen aus, keine
        Ordner). Config ``trash_dir``, sonst ``<library_dir>_papierkorb``."""
        cfg = self.config()
        explicit = str(cfg.get("trash_dir") or "").strip()
        if explicit:
            return Path(explicit)
        lib = Path(str(cfg.get("library_dir") or ""))
        return lib.with_name(lib.name + "_papierkorb")

    @staticmethod
    def _move_files(pairs: list) -> None:
        """Alle oder keine: bei einem Fehler werden die schon bewegten Dateien zurueckgelegt."""
        done = []
        try:
            for src, dst in pairs:
                Path(dst).parent.mkdir(parents=True, exist_ok=True)
                if Path(dst).exists():
                    raise FileExistsError(str(dst))
                os.replace(src, dst)
                done.append((src, dst))
        except Exception as first:
            failed = []
            for src, dst in reversed(done):
                try:
                    os.replace(dst, src)
                except OSError as e:
                    log.error("Rueckstellung %s -> %s gescheitert: %s", dst, src, e)
                    failed.append(Path(dst).name)
            if failed:
                raise RollbackFailed(f"{first}; Rueckstellung gescheitert fuer: {', '.join(failed)}") from first
            raise

    def _rollback(self, pairs: list, meta_before: dict) -> bool:
        """Teilfehler: Dateien zurueck und die genannten Metadaten-Dateien auf ihren Vorstand.
        Liefert False, wenn die Rueckstellung selbst scheitert — dann darf niemand
        „zurueckgestellt" melden (Codex R10 F19); es bleibt laut (Log)."""
        ok = True
        try:
            self._move_files([(d, s) for s, d in pairs if Path(d).exists() and not Path(s).exists()])
        except Exception as e:  # noqa: BLE001
            log.error("Rueckstellung der Dateien gescheitert: %s", e)
            ok = False
        for name, before in meta_before.items():
            if self._json_strict(name) == before:
                continue                              # nie geschrieben / schon zurueck: nichts zu tun
            try:
                self._write_json(name, before)
            except Exception as e:  # noqa: BLE001
                log.error("Rueckstellung %s gescheitert: %s", name, e)
                ok = False
        return ok

    def plan_move(self, track_id: str, folder: str) -> dict:
        """Umzug planen, ohne etwas anzufassen: Zielkennung, neuer Pfad und JEDE Datei (Quelle,
        Ziel). Hosts schreiben damit ihr Protokoll VOR dem ersten Schritt (Codex R10 F19)."""
        t = self.track(track_id)
        if not t:
            return {"ok": False, "reason": "Track unbekannt"}
        root = Path(str(self.config().get("library_dir") or ""))
        folder = str(folder or "").strip().strip("/\\")
        target_dir = root / folder
        if (not folder or "/" in folder or "\\" in folder or folder.startswith(("_", "."))
                or not target_dir.is_dir()):
            return {"ok": False, "reason": f"Zielordner unbekannt: {folder}"}
        audio = Path(t["file"])
        if audio.parent.resolve() == target_dir.resolve():
            return {"ok": False, "reason": "Song liegt schon in diesem Ordner"}
        if self._playing_track() == track_id:
            return {"ok": False, "reason": "Song laeuft gerade"}
        pairs = [(f, target_dir / f.name) for f in self._track_files(audio)]
        clash = [d.name for _, d in pairs if d.exists()]
        if clash:
            return {"ok": False, "reason": "Im Zielordner gibt es schon: " + ", ".join(clash)}
        new_rel = (target_dir / audio.name).relative_to(root)
        return {"ok": True, "old_id": track_id, "new_id": _slug(str(new_rel.with_suffix(""))),
                "rel": str(new_rel).replace("\\", "/"), "pairs": [[str(s), str(d)] for s, d in pairs]}

    def _record_move_locked(self, lib: dict, aliases: dict, old_id: str, new_id: str) -> tuple:
        tracks = lib.get("tracks") if isinstance(lib.get("tracks"), dict) else {}
        if old_id in tracks and new_id not in tracks:
            entry = tracks.pop(old_id)
            if isinstance(entry, dict):
                entry.pop("style", None)              # der Ordner ist die Stil-Wahrheit
                if entry:
                    tracks[new_id] = entry
        lib["tracks"] = tracks
        amap = aliases.get("aliases") if isinstance(aliases.get("aliases"), dict) else {}
        amap = {k: (new_id if v == old_id else v) for k, v in amap.items()}
        amap[old_id] = new_id
        amap.pop(new_id, None)                        # Rueckumzug: aktuelle Kennung ist kein Alias
        return lib, {"aliases": amap}

    def move_track(self, track_id: str, folder: str) -> dict:
        """Track samt Begleitdateien in einen anderen Unterordner der Bibliothek verschieben.
        Metadaten ziehen mit, die alte Kennung wird als Alias gemerkt. Abgelehnt, wenn der
        Track gerade laeuft, der Zielordner kein Unterordner ist oder ein Ziel schon existiert."""
        plan = self.plan_move(track_id, folder)
        if not plan.get("ok"):
            return plan
        pairs = [(Path(s), Path(d)) for s, d in plan["pairs"]]
        new_id = plan["new_id"]
        with self._meta_lock:
            lib = self._json_strict("library.json")
            aliases = self._json_strict("aliases.json")
            if lib is None or aliases is None:
                return {"ok": False, "reason": "library.json/aliases.json unlesbar - nichts verschoben"}
            lib_before, aliases_before = json.loads(json.dumps(lib)), json.loads(json.dumps(aliases))
            try:
                self._move_files(pairs)
            except RollbackFailed as e:
                return {"ok": False, "rollback_failed": True, "reason": f"Verschieben gescheitert: {e}"[:200]}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "reason": f"Verschieben gescheitert: {e}"[:200]}
            lib, aliases = self._record_move_locked(lib, aliases, track_id, new_id)
            try:
                self._write_json("library.json", lib)
                self._write_json("aliases.json", aliases)
            except Exception as e:  # noqa: BLE001
                # Alles zurueck: Dateien UND beide Metadaten-Dateien (Codex R9 F19).
                if self._rollback(pairs, {"library.json": lib_before, "aliases.json": aliases_before}):
                    return {"ok": False, "reason": f"Metadaten nicht schreibbar, zurueckgestellt: {e}"[:200]}
                return {"ok": False, "rollback_failed": True,
                        "reason": f"Metadaten nicht schreibbar UND Rueckstellung gescheitert: {e}"[:200]}
        log.info("Jukebox: %s -> %s (%d Dateien)", track_id, new_id, len(pairs))
        return {"ok": True, "old_id": track_id, "new_id": new_id, "rel": plan["rel"]}

    def complete_move(self, old_id: str, new_id: str, pairs: list) -> dict:
        """Einen unterbrochenen Umzug zu Ende fuehren — idempotent, nach dem tatsaechlichen
        Dateistand: noch nicht bewegte Dateien bewegen, dann Metadaten + Alias nachtragen.
        Liegt eine Datei an BEIDEN Orten, wird nichts entschieden (Grund zurueck)."""
        pairs = [(Path(s), Path(d)) for s, d in pairs]
        both = [s.name for s, d in pairs if s.exists() and d.exists()]
        if both:
            return {"ok": False, "reason": "Datei an beiden Orten: " + ", ".join(both)}
        todo = [(s, d) for s, d in pairs if s.exists() and not d.exists()]
        with self._meta_lock:
            lib = self._json_strict("library.json")
            aliases = self._json_strict("aliases.json")
            if lib is None or aliases is None:
                return {"ok": False, "reason": "library.json/aliases.json unlesbar"}
            try:
                self._move_files(todo)
            except RollbackFailed as e:
                return {"ok": False, "rollback_failed": True, "reason": f"Verschieben gescheitert: {e}"[:200]}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "reason": f"Verschieben gescheitert: {e}"[:200]}
            lib, aliases = self._record_move_locked(lib, aliases, old_id, new_id)
            self._write_json("library.json", lib)
            self._write_json("aliases.json", aliases)
        return {"ok": True, "old_id": old_id, "new_id": new_id, "moved": len(todo)}

    def trash_track(self, track_id: str, *, note: Optional[dict] = None) -> dict:
        """Track samt Begleitdateien in den Papierkorb (neben der Bibliothek). Metadaten und
        ``note`` (Host-Angaben, z. B. Veroeffentlichungsstatus) liegen im Eintrag, damit
        ``restore_track`` alles zurueckstellen kann. Endgueltig geloescht wird nie."""
        t = self.track(track_id)
        if not t:
            return {"ok": False, "reason": "Track unbekannt"}
        if self._playing_track() == track_id:
            return {"ok": False, "reason": "Song laeuft gerade"}
        root = Path(str(self.config().get("library_dir") or ""))
        audio = Path(t["file"])
        entry_id = time.strftime("%Y%m%d-%H%M%S") + "-" + track_id[:40]
        entry_dir = self.trash_dir() / entry_id
        rel_dir = audio.parent.relative_to(root)
        pairs = [(f, entry_dir / "files" / rel_dir / f.name) for f in self._track_files(audio)]
        with self._meta_lock:
            lib = self._json_strict("library.json")
            if lib is None:
                return {"ok": False, "reason": "library.json unlesbar - nichts verschoben"}
            lib_before = json.loads(json.dumps(lib))
            try:
                self._move_files(pairs)
            except RollbackFailed as e:
                return {"ok": False, "rollback_failed": True, "reason": f"Papierkorb gescheitert: {e}"[:200]}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "reason": f"Papierkorb gescheitert: {e}"[:200]}
            tracks = lib.get("tracks") if isinstance(lib.get("tracks"), dict) else {}
            meta = tracks.pop(track_id, None)
            lib["tracks"] = tracks
            record = {"track_id": track_id, "rel": t["rel"], "title": t["title"],
                      "trashed_at": time.time(), "meta": meta if isinstance(meta, dict) else {},
                      "files": [str(d.relative_to(entry_dir)).replace("\\", "/") for _, d in pairs],
                      "note": note or {}}
            try:
                (entry_dir / "entry.json").write_text(json.dumps(record, indent=2, ensure_ascii=False), "utf-8")
                self._write_json("library.json", lib)
            except Exception as e:  # noqa: BLE001
                if not self._rollback(pairs, {"library.json": lib_before}):
                    return {"ok": False, "rollback_failed": True,
                            "reason": f"Papierkorb nicht beschreibbar UND Rueckstellung gescheitert: {e}"[:200]}
                try:
                    (entry_dir / "entry.json").unlink(missing_ok=True)   # kein Geister-Eintrag
                except OSError:
                    pass
                return {"ok": False, "reason": f"Papierkorb nicht beschreibbar, zurueckgestellt: {e}"[:200]}
        log.info("Jukebox: %s in den Papierkorb (%s)", track_id, entry_id)
        return {"ok": True, "entry": entry_id, "track_id": track_id}

    def trash_list(self) -> list:
        """Eintraege im Papierkorb, neueste zuerst (zurueckgestellte ausgenommen)."""
        out = []
        base = self.trash_dir()
        if not base.is_dir():
            return out
        for d in sorted(base.iterdir(), reverse=True):
            try:
                rec = json.loads((d / "entry.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({"entry": d.name, **{k: rec.get(k) for k in ("track_id", "rel", "title", "trashed_at", "note")}})
        return out

    def restore_track(self, entry_id: str) -> dict:
        """Eintrag aus dem Papierkorb an seinen alten Platz zurueck (Metadaten inklusive)."""
        entry_id = str(entry_id or "")
        if not entry_id or "/" in entry_id or "\\" in entry_id or entry_id.startswith("."):
            return {"ok": False, "reason": "Eintrag unbekannt"}
        entry_dir = self.trash_dir() / entry_id
        try:
            rec = json.loads((entry_dir / "entry.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"ok": False, "reason": "Eintrag unbekannt"}
        root = Path(str(self.config().get("library_dir") or ""))
        pairs = []
        for rel in rec.get("files") or []:
            parts = Path(rel).parts
            if not parts or parts[0] != "files" or ".." in parts:
                return {"ok": False, "reason": "Eintrag unvollstaendig"}
            src, dst = entry_dir / rel, root.joinpath(*parts[1:])
            if not src.is_file():
                return {"ok": False, "reason": "Eintrag unvollstaendig"}
            if dst.exists():
                return {"ok": False, "reason": f"Platz belegt: {dst.name}"}
            pairs.append((src, dst))
        with self._meta_lock:
            lib = self._json_strict("library.json")
            if lib is None:
                return {"ok": False, "reason": "library.json unlesbar - nichts zurueckgestellt"}
            try:
                self._move_files(pairs)
            except RollbackFailed as e:
                return {"ok": False, "rollback_failed": True, "reason": f"Zurueckstellen gescheitert: {e}"[:200]}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "reason": f"Zurueckstellen gescheitert: {e}"[:200]}
            tracks = lib.get("tracks") if isinstance(lib.get("tracks"), dict) else {}
            if rec.get("meta"):
                tracks[str(rec["track_id"])] = rec["meta"]
            lib["tracks"] = tracks
            try:
                self._write_json("library.json", lib)
            except Exception as e:  # noqa: BLE001
                self._move_files([(d, s) for s, d in pairs])   # zurueck in den Papierkorb
                return {"ok": False, "reason": f"Metadaten nicht schreibbar, im Papierkorb gelassen: {e}"[:200]}
            try:
                (entry_dir / "entry.json").rename(entry_dir / "entry.restored.json")
            except OSError:
                pass
        log.info("Jukebox: %s aus dem Papierkorb zurueck", rec.get("track_id"))
        return {"ok": True, "track_id": rec.get("track_id"), "note": rec.get("note") or {}}

    def track(self, track_id: str) -> Optional[dict]:
        for t in self.library():
            if t["id"] == track_id:
                return t
        return None

    # -- Zustand -------------------------------------------------------------------------
    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _set(self, publish: bool = True, **kw) -> None:
        with self._lock:
            self._state.update(kw)
            self._state["updated_at"] = time.time()
            self._seq += 1
            self._state["seq"] = self._seq
            snap = dict(self._state)
        if publish:
            self._publish_snapshot(snap)

    def _publish_snapshot(self, snap: dict) -> None:
        """state.json und Zuhoerer in Zustandsreihenfolge; aeltere Schnappschuesse nach
        einem neueren werden verworfen (siehe _seq)."""
        with self._publish_lock:
            seq = int(snap.get("seq") or 0)
            if seq < self._published_seq:
                return
            self._published_seq = seq
            self._write_state(snap)
            self._emit(snap)

    def _emit(self, snap: dict) -> None:
        if self._publish:
            try:
                self._publish(f"{self._dir.name}:state", snap)   # jukebox:state / videobox:state
            except Exception:  # noqa: BLE001
                pass
        for fn in list(self.listeners):
            try:
                fn(dict(snap))
            except Exception as e:  # noqa: BLE001
                log.warning("Jukebox-Listener fehlgeschlagen: %s", e)

    def _write_state(self, snap: Optional[dict] = None) -> None:
        try:
            (self._dir / "state.json").write_text(
                json.dumps(snap or self._state, indent=2, ensure_ascii=False), "utf-8")
        except Exception:  # noqa: BLE001
            pass

    def deck_state(self, track_id: str = "", style: str = "") -> str:
        """EIN pollbarer Wert fuer Tasten: ``<state>:<track_id>`` (oder ``:<style>``); ``idle``."""
        s = self.status()
        st = str(s.get("state") or "idle")
        if st in ("idle", "ended", "stopped"):
            return "idle"
        if st == "queued":
            pass   # vorgemerkt: <queued:track> — die Taste zeigt „wartet auf die Show"
        key = s.get("track") or ""
        if style and not track_id:
            key = s.get("style") or ""
        return f"{st}:{key}" if key else st

    # -- Steuerung -----------------------------------------------------------------------
    def play(self, track_id: str, *, style_override: str = "", request_id: str = "",
             direct: bool = False) -> dict:
        t = self.track(track_id)
        if not t:
            return {"ok": False, "reason": f"unbekannter Track: {track_id}"}
        if self._player_factory is None:
            mpv = self._resolve_mpv(self.config().get("mpv_path") or None)
            if not mpv:
                return {"ok": False, "reason": "mpv nicht gefunden"}
        else:
            mpv = ""   # fremder Player (Factory) — braucht weder mpv noch Audio-Geraet
        style = str(style_override or t.get("style") or "")
        rid = str(request_id or uuid.uuid4().hex[:12])
        if not direct and self.before_play is not None:
            try:
                gate = self.before_play(t, style, rid)
            except Exception as e:  # noqa: BLE001
                log.warning("Jukebox before_play fehlgeschlagen (spiele sofort): %s", e)
                gate = None
            if isinstance(gate, dict) and gate.get("deferred"):
                self._set(state="queued", request_id=rid, track=t["id"], title=t["title"], style=style,
                          position=0.0, duration=0.0, reason=None, detail=str(gate.get("reason") or ""),
                          file=t["file"])
                return {"ok": True, "deferred": True, "request_id": rid, "track": t["id"], "style": style,
                        "title": t["title"], "reason": gate.get("reason")}
        device = (resolve_audio_device(mpv, str(self.config().get("audio_device") or ""))
                  if self._player_factory is None else "")
        common = dict(request_id=rid, track=t["id"], title=t["title"], style=style,
                      position=0.0, duration=0.0, reason=None, detail=None, file=t["file"],
                      ducked=False, duck_level=None)
        prepared = self._has_hook(style, "on_prepare")
        with self._start_lock:
            with self._lock:
                prev = self._player
                prev_state = dict(self._state)
            if prev_state.get("state") in _ACTIVE:
                # Songwechsel: alter Auftrag sauber beenden (dessen Stop-Actions), dann der
                # neue. Auch ein Auftrag in der Vorbereitung (ohne Player) wird so abgeloest.
                self._finish(prev_state, reason="stop", detail="replaced")
                if prev is not None:
                    prev.stop()
            with self._lock:
                self._player = None
            if prepared:
                # Vorhang auf, dann Musik: synchron und befristet. Waehrenddessen ist der
                # Auftrag ``preparing`` — stoppbar und abloesbar wie ein spielender.
                self._set(state="preparing", **common)
            else:
                return self._start_player(rid, t, style, mpv, device, common)
        ok, why = self._prepare(style, rid, t)          # lang, deshalb OHNE Start-Sperre
        with self._start_lock:
            snap = self.status()
            if snap.get("request_id") != rid or snap.get("state") != "preparing":
                # Waehrend der Vorbereitung gestoppt oder abgeloest: Abschluss lief schon.
                return {"ok": False, "reason": "prepare_superseded", "request_id": rid}
            if not ok:
                self._finish(snap, reason="error", detail=why, hook="on_stop")
                return {"ok": False, "reason": why, "request_id": rid}
            return self._start_player(rid, t, style, mpv, device, common)

    def _start_player(self, rid: str, t: dict, style: str, mpv: str, device: str,
                      common: dict) -> dict:
        """Uebernahme (``starting``) und Player-Start — NUR unter ``_start_lock``: kein
        stop()/_cap() kann sich zwischen Zustand und Prozessstart schieben."""
        factory = self._player_factory or _MpvAudio
        player = factory(mpv, self._pipe_name(rid), lambda ev, _rid=rid: self._on_player_event(_rid, ev))
        with self._lock:
            self._player = player
        self._set(state="starting", **common)
        try:
            player.start(t["file"], audio_device=device, volume=self.config().get("volume"))
        except Exception as e:  # noqa: BLE001
            self._finish(self.status(), reason="error", detail=f"mpv-Start: {e}")
            return {"ok": False, "reason": f"mpv-Start fehlgeschlagen: {e}", "request_id": rid}
        self._fire(style, "on_start", rid, t)
        max_s = float(t.get("max_seconds") or 0)
        if max_s > 0:
            threading.Timer(max_s, lambda: self._cap(rid)).start()
        return {"ok": True, "request_id": rid, "track": t["id"], "style": style, "title": t["title"]}

    def stop(self) -> dict:
        with self._start_lock:
            return self._stop_locked()

    def _stop_locked(self) -> dict:
        with self._lock:
            player, snap = self._player, dict(self._state)
        if snap.get("state") == "queued":
            # Vorgemerkt bei einer Show: Auftrag zurueckziehen, nichts spielt.
            res = {}
            if self.cancel_deferred is not None:
                try:
                    res = self.cancel_deferred(str(snap.get("request_id") or "")) or {}
                except Exception as e:  # noqa: BLE001
                    log.warning("Jukebox cancel_deferred fehlgeschlagen: %s", e)
            self._set(state="idle", reason="cancelled", detail="queued request withdrawn")
            return {"ok": True, "cancelled": True, "request_id": snap.get("request_id"), **res}
        if snap.get("state") == "preparing":
            # Noch kein Player: der Abschluss (on_stop) raeumt die Vorbereitung auf, und
            # play() startet danach keine Musik mehr (Auftrag ist nicht mehr ``preparing``).
            self._finish(snap, reason="stop", detail="user")
            return {"ok": True, "request_id": snap.get("request_id"), "stopped": True,
                    "was": "preparing"}
        if player is None or snap.get("state") not in _ACTIVE:
            return {"ok": True, "message": "nichts zu stoppen", "was": snap.get("state")}
        self._finish(snap, reason="stop", detail="user")
        player.stop()
        return {"ok": True, "request_id": snap.get("request_id"), "stopped": True}

    def toggle(self, track_id: str, **kw) -> dict:
        snap = self.status()
        if snap.get("state") in (_ACTIVE | {"queued"}) and snap.get("track") == track_id:
            return self.stop()
        return self.play(track_id, **kw)

    def play_random(self, style: str = "", *, pick: str = "random") -> dict:
        """Einen Track des Stils waehlen und spielen. ``pick``: ``random`` (Default, der
        zuletzt gespielte faellt aus dem Pool) oder ``newest`` (juengste Datei, Gleichstand
        nach Pfad, KEINE Wiederholungsvermeidung). Leiht der Stil seine Musik (``tracks``),
        spielt der Track trotzdem mit DIESEM Stil als Rezept. Ohne Track: ok:false, kein
        Ausweichen auf einen anderen Stil."""
        pick = str(pick or "random").strip().lower()
        if pick not in PICKS:
            return {"ok": False, "reason": f"unbekannte Auswahl: {pick}"}
        pool, pool_style = self.style_pool(style)
        if not pool:
            return {"ok": False, "reason": f"keine Tracks fuer Stil {pool_style or '(alle)'}"}
        if pick == "newest":
            chosen = sorted(pool, key=lambda t: (-float(t.get("mtime") or 0), t["rel"]))[0]
        elif pick == "latest_origin":
            # Juengste HERKUNFT (Quellstream-Datum aus Metadaten/Titel), nicht juengste Datei —
            # eine nachgelieferte Kopie eines alten Songs ist kein aktueller Recap (17.09.2026).
            # Ohne Herkunft zaehlt die Datei als aeltest; Gleichstand nach mtime, dann Pfad.
            chosen = sorted(pool, key=lambda t: (str(t.get("source_date") or ""),
                                                 float(t.get("mtime") or 0)), reverse=True)[0]
        else:
            snap = self.status()
            chosen = random.choice([t for t in pool if t["id"] != snap.get("track")] or pool)
        return self.play(chosen["id"], style_override=(style if style and pool_style != style else ""))

    # -- Gesprochener Auftrag (Musikseite M3b, Richard 27.09.2026) ---------------------------
    @staticmethod
    def _first_hit(low: str, words) -> tuple[int, str] | None:
        """Frueheste Fundstelle eines Wortes am Wortanfang (``metal`` trifft „Metal-Song",
        ``tanz`` trifft „tanzen"); Gleichstand: das laengere Wort."""
        best = None
        for word in words or []:
            w = str(word or "").strip().lower()
            if not w:
                continue
            m = re.search(r"(?<!\w)" + re.escape(w), low)
            if m and (best is None or (m.start(), -len(w)) < (best[0], -len(best[1]))):
                best = (m.start(), w)
        return best

    def categories(self) -> dict[str, dict]:
        """Kategorien fuer Auftraege: Stile mit eigenem Ordner (keine Rezepte, die Musik
        leihen — ``tracks: …``). Jede gleichwertig."""
        return {k: v for k, v in (self.styles() or {}).items()
                if isinstance(v, dict) and not v.get("tracks")}

    @staticmethod
    def performance(spec: dict | None) -> dict:
        """Auftrittsart einer Kategorie (``styles.json → <stil>.performance``): ``act`` (z. B.
        sing | mix | dance | instrument) und ``by`` (wer). Daten, kein Code je Kategorie."""
        perf = (spec or {}).get("performance") if isinstance(spec, dict) else None
        return dict(perf) if isinstance(perf, dict) else {}

    def resolve_request(self, text: str) -> dict:
        """Welche Songs meint ein gesprochener Auftrag? Rezept (Richard 27.09.2026), fuer jede
        Kategorie gleich — neue Kategorien und Kanal-Reward-Songs brauchen keinen Code:

        1. **Kategorie genannt** (``styles.json → <stil>.request.words``, zuerst genannte gewinnt)
           → nur diese Kategorie.
        2. **Auftrittsart genannt** (``config.json → acts.<act>.words``, z. B. „sing" → singen,
           „leg … auf" → auflegen) → alle Kategorien mit dieser ``performance.act``.
        3. **Nichts davon** („spiel nen Song") → alle Kategorien.

        Keine Kategorie ist Standard; gespielt wird der neueste Song der Auswahl."""
        low = str(text or "").lower()
        cats = self.categories()
        best = None
        for style, spec in cats.items():
            req = spec.get("request") if isinstance(spec.get("request"), dict) else {}
            hit = self._first_hit(low, req.get("words"))
            if hit and (best is None or (hit[0], -len(hit[1])) < (best[0], -len(best[2]))):
                best = (hit[0], style, hit[1])
        if best is not None:
            return {"ok": True, "by": "category", "styles": [best[1]], "word": best[2]}
        acts = (self.config() or {}).get("acts") or {}
        best_act = None
        for act, spec in acts.items():
            hit = self._first_hit(low, (spec or {}).get("words") if isinstance(spec, dict) else None)
            if hit and (best_act is None or (hit[0], -len(hit[1])) < (best_act[0], -len(best_act[2]))):
                best_act = (hit[0], act, hit[1])
        if best_act is not None:
            styles = [s for s, spec in cats.items() if self.performance(spec).get("act") == best_act[1]]
            if not styles:
                return {"ok": False, "reason": f"keine Kategorie mit Auftrittsart {best_act[1]}"}
            return {"ok": True, "by": "act", "act": best_act[1], "styles": styles, "word": best_act[2]}
        # Alle = jede Kategorie mit Songs, auch Ordner ohne eigenen Stil-Eintrag.
        present = sorted({str(t.get("style") or "") for t in self.library()} - set(cats) - {""})
        return {"ok": True, "by": "all", "styles": list(cats) + present}

    def play_request(self, text: str = "", *, pick: str = "latest_origin") -> dict:
        """Auftrag aufloesen und den NEUESTEN Song der Auswahl spielen (``pick`` wie
        ``play_random``: latest_origin = juengste Herkunft, newest = juengste Datei). Das Rezept
        der Kategorie (``request.play_style``, z. B. Musical als Exkursion) gilt auch hier."""
        r = self.resolve_request(text)
        if not r.get("ok"):
            return r
        pick = str(pick or "latest_origin").strip().lower()
        if pick not in ("latest_origin", "newest"):
            return {"ok": False, "reason": f"unbekannte Auswahl: {pick}"}
        pool = [t for t in self.library() if t.get("style") in set(r["styles"])]
        if not pool:
            return {"ok": False, "reason": "keine Songs fuer diesen Auftrag", "request": r}
        if pick == "newest":
            chosen = sorted(pool, key=lambda t: (-float(t.get("mtime") or 0), t["rel"]))[0]
        else:
            chosen = sorted(pool, key=lambda t: (str(t.get("source_date") or ""),
                                                 float(t.get("mtime") or 0)), reverse=True)[0]
        spec = self.categories().get(chosen.get("style")) or {}
        req = spec.get("request") if isinstance(spec.get("request"), dict) else {}
        play_style = str(req.get("play_style") or "")
        out = self.play(chosen["id"], style_override=play_style if play_style and play_style != chosen.get("style") else "")
        return {**out, "request": {**r, "style": chosen.get("style"), "play_style": play_style or chosen.get("style")}}

    def pause(self, flag: bool = True) -> dict:
        with self._lock:
            player = self._player
        if player is None:
            return {"ok": False, "reason": "kein Player"}
        return {"ok": player.pause(flag)}

    def duck(self, level: Optional[float] = DUCK_LEVEL_DEFAULT, *, fade_ms: int = DUCK_FADE_MS) -> dict:
        """Laufende Wiedergabe weich absenken (``level`` 0..1 der konfigurierten Lautstaerke)
        oder mit ``None``/``1.0`` wieder hochholen.

        Ohne laufenden Player: Absenken geht nicht (ok:false). Hochholen/Aus gelingt immer —
        es setzt den Duck-Merker zurueck (ok:true, ``player: false``). Sonst blieb nach einem
        Songende ``ducked`` stehen, und eine Push-to-Duck-Taste liess sich nie mehr
        ausschalten (Stream 28.09.2026: „Duck AN" bis Stream-Ende)."""
        with self._lock:
            player, snap = self._player, dict(self._state)
        unduck = level is None or float(level) >= 1.0
        if player is None or snap.get("state") not in _ACTIVE:
            if unduck:
                with self._lock:
                    self._duck_generation += 1      # eine noch laufende Rampe endet
                if snap.get("ducked") or snap.get("duck_level") is not None:
                    self._set(ducked=False, duck_level=None)
                return {"ok": True, "ducked": False, "duck_level": None, "player": False,
                        "state": snap.get("state")}
            return {"ok": False, "reason": "kein laufender Player", "state": snap.get("state")}
        try:
            base = float(self.config().get("volume") if self.config().get("volume") is not None else 100.0)
        except (TypeError, ValueError):
            base = 100.0
        ducked = level is not None and float(level) < 1.0
        target_level = max(0.0, min(1.0, float(level))) if ducked else 1.0
        # Ausgangspegel = zuletzt angewiesener Pegel. Null ist dabei ein GUELTIGER Wert (ein
        # auf 0 gesenktes Bett kehrt aus der Stille zurueck) — ``or 1.0`` machte daraus den
        # vollen Pegel: die Rampe stand dann auf dem Zielwert, ein erneutes duck(0) begann
        # hoerbar bei 100 % (Codex-Pruefung Musikbett 15.09.2026).
        prev_level = snap.get("duck_level")
        start_level = (float(prev_level) if snap.get("ducked") and prev_level is not None
                       else 1.0)
        with self._lock:
            self._duck_generation += 1
            generation = self._duck_generation
        self._set(ducked=ducked, duck_level=target_level if ducked else None)

        def _ramp() -> None:
            steps = max(1, int(DUCK_FADE_STEPS))
            for i in range(1, steps + 1):
                if self._duck_generation != generation or not player.alive():
                    return                          # neuere Anweisung oder Player weg
                lvl = start_level + (target_level - start_level) * (i / steps)
                player.set_volume(base * lvl)
                if i < steps:
                    time.sleep(max(0.0, float(fade_ms)) / 1000.0 / steps)

        threading.Thread(target=_ramp, name="jukebox-duck", daemon=True).start()
        return {"ok": True, "ducked": ducked, "duck_level": target_level if ducked else None,
                "request_id": snap.get("request_id")}

    def duck_toggle(self, level: float = DUCK_LEVEL_DEFAULT) -> dict:
        """Push to Duck: geduckt -> hoch, sonst absenken. Ohne laufenden Player ist ein
        stehengebliebener Merker immer „aus" (setzt zurueck, ok:true)."""
        return self.duck(None if self.status().get("ducked") else level)

    # -- intern ----------------------------------------------------------------------------
    def _pipe_name(self, rid: str) -> str:
        stem = f"deckcore-jukebox-{self._pipe_tag}-{rid}"
        return (r"\\.\pipe\\" + stem) if os.name == "nt" else f"/tmp/{stem}"

    def orphan_marker(self) -> str:
        """Teil des Pipe-Namens, der alle Player DIESER Instanz kennzeichnet."""
        return f"deckcore-jukebox-{self._pipe_tag}-"

    def reap_orphans(self, *, list_processes: Optional[Callable[[], list]] = None,
                     kill: Optional[Callable[[int], None]] = None) -> list[int]:
        """mpv-Prozesse einer frueheren Instanz mit demselben Laufzeitordner beenden — beim
        Start des Hosts, bevor etwas Neues spielt. Ein abgeschossener Host (Neustart-Helfer,
        Absturz) nimmt seine Player nicht mit; sie spielten weiter, und der neue Host legte
        einen zweiten Track darueber (Test-Stream 15.09.2026). Fremde Instanzen bleiben
        unberuehrt (anderer Marker). ``list_processes`` liefert ``[(pid, cmdline)]``
        (Default: Win32_Process), ``kill`` beendet einen Prozess (Default: taskkill)."""
        marker = self.orphan_marker()
        with self._lock:
            own = self._player
        own_pid = None
        try:
            own_pid = own._proc.pid if own is not None and own._proc is not None else None
        except Exception:  # noqa: BLE001
            own_pid = None
        if list_processes is None:
            if os.name != "nt":
                return []
            list_processes = _list_mpv_processes
        if kill is None:
            kill = _kill_process
        killed: list[int] = []
        try:
            for pid, cmdline in list_processes():
                if marker in str(cmdline or "") and int(pid) != own_pid:
                    try:
                        kill(int(pid))
                        killed.append(int(pid))
                    except Exception as e:  # noqa: BLE001
                        log.warning("Jukebox: Waise %s nicht beendet: %s", pid, e)
        except Exception as e:  # noqa: BLE001
            log.warning("Jukebox: Waisen-Suche fehlgeschlagen: %s", e)
        if killed:
            log.warning("JUKEBOX_ORPHANS_REAPED instance=%s pids=%s", self._dir.name, killed)
        return killed

    def _cap(self, rid: str) -> None:
        with self._start_lock:
            snap = self.status()
            if snap.get("request_id") == rid and snap.get("state") in _ACTIVE:
                with self._lock:
                    player = self._player
                self._finish(snap, reason="stop", detail="max_seconds")
                if player is not None:
                    player.stop()

    def _set_if(self, rid: str, allowed: tuple, publish: bool = True, **kw) -> bool:
        """Zustand NUR aendern, wenn der Auftrag noch derselbe ist UND der Ausgangszustand
        erlaubt — Pruefung und Zuweisung unter einer Sperre. Sonst setzte die spaete
        Rueckmeldung eines abgeloesten Players (A: ``loaded``) den NEUEN Auftrag B von
        ``preparing`` auf ``playing``, und B's Vorbereitung galt danach als abgeloest, ohne
        dass je ein Player lief (Codex-Review 11.09.2026, Theater-Runde 2)."""
        with self._lock:
            if self._state.get("request_id") != rid or self._state.get("state") not in allowed:
                return False
            self._state.update(kw)
            self._state["updated_at"] = time.time()
            self._seq += 1
            self._state["seq"] = self._seq
            snap = dict(self._state)
        if publish:
            self._publish_snapshot(snap)
        return True

    def _on_player_event(self, rid: str, ev: dict) -> None:
        snap = self.status()
        if snap.get("request_id") != rid or snap.get("state") == "queued":
            return   # spaete Meldung eines alten Auftrags — bewusst ignoriert
        kind = ev.get("event")
        if kind == "loaded":
            # ein gestoppter oder abgeloester Auftrag wird nicht wieder spielend
            self._set_if(rid, ("starting",), state="playing")
        elif kind == "progress":
            if snap.get("state") in ("starting", "playing", "paused"):
                now = time.monotonic()
                heavy = now - self._last_progress_publish >= 1.0
                position = float(ev.get("position") or 0)
                lyric = lyric_at(self.lyrics(str(snap.get("track") or "")), position)
                if lyric.get("index") != (snap.get("lyric") or {}).get("index"):
                    heavy = True   # Zeilenwechsel sofort raus (Overlay, Listener)
                if heavy:
                    self._last_progress_publish = now
                fields = dict(position=round(position, 1),
                              duration=round(float(ev.get("duration") or 0), 1), lyric=lyric)
                if not self._set_if(rid, ("starting",), publish=heavy, state="playing", **fields):
                    self._set_if(rid, ("playing", "paused"), publish=heavy, **fields)
        elif kind == "paused":
            self._set_if(rid, ("playing", "paused"),
                         state="paused" if ev.get("paused") else "playing")
        elif kind == "end":
            if snap.get("state") in _ACTIVE:
                reason = str(ev.get("reason") or "unknown")
                self._finish(snap, reason="eof" if reason == "eof" else ("stop" if reason in ("stop", "quit") else "error"),
                             detail=str(ev.get("detail") or ""))

    def _finish(self, snap: dict, *, reason: str, detail: str = "",
                hook: Optional[str] = None) -> None:
        """Genau EIN Abschluss je Auftrag: Zustand setzen, passende Stil-Actions einmal ausloesen.

        ``hook`` erzwingt die Action-Gruppe — z.B. ``on_stop`` fuer eine gescheiterte
        Vorbereitung, die als ``error`` endet, aber aufraeumen muss wie ein Stop; die
        Actions bekommen dann den benannten Grund (``prepare_timeout``/``prepare_failed``)."""
        rid = snap.get("request_id")
        with self._lock:
            if self._state.get("request_id") != rid or self._state.get("state") not in _ACTIVE:
                return
            final = {"eof": "ended", "stop": "stopped"}.get(reason, "error")
            self._seq += 1
            # Mit dem Track endet auch sein Ducking: der Merker gehoert zur Wiedergabe, nicht
            # zur Taste (Stream 28.09.2026: „Duck AN" blieb nach dem Songende bis Stream-Ende).
            self._duck_generation += 1
            self._state.update({"state": final, "reason": reason, "detail": detail or None,
                                "ducked": False, "duck_level": None,
                                "updated_at": time.time(), "seq": self._seq})
            snap2 = dict(self._state)
        self._publish_snapshot(snap2)
        forced = hook is not None
        hook = hook or ("on_stop" if reason == "stop" else "on_end")
        self._fire(str(snap.get("style") or ""), hook, str(rid),
                   {"id": snap.get("track"), "title": snap.get("title")},
                   reason=(detail or reason) if forced else reason)

    def _has_hook(self, style: str, hook: str) -> bool:
        spec = self.styles().get(style) if style else None
        return bool(isinstance(spec, dict) and spec.get(hook))

    def _prepare(self, style: str, rid: str, track: dict) -> tuple[bool, str]:
        """``on_prepare`` synchron mit Frist ausfuehren: ``(True, "")`` oder ``(False, grund)``.

        Die Actions laufen in einem Hilfsthread, damit die Frist wirklich gilt; laeuft sie
        ab, ist der Auftrag hier zu Ende (``prepare_timeout``). Ein spaeter doch noch
        eintreffendes Ergebnis wird verworfen — es gehoert zu einem abgeschlossenen Auftrag,
        und sein Buehnen-Anteil scheitert an dessen eigener Auftragsbindung."""
        spec = self.styles().get(style) or {}
        actions = list(spec.get("on_prepare") or [])
        try:
            timeout = float(spec.get("prepare_timeout_s") or PREPARE_TIMEOUT_S)
        except (TypeError, ValueError):
            timeout = PREPARE_TIMEOUT_S
        timeout = max(0.5, timeout)
        ctx = {"jukebox": {"request_id": rid, "style": style, "track": track.get("id"),
                           "title": track.get("title"), "hook": "on_prepare", "reason": ""}}
        result: dict = {}

        def _work() -> None:
            try:
                result["res"] = self._run_actions(actions, ctx)
            except Exception as e:  # noqa: BLE001
                result["exc"] = e

        worker = threading.Thread(target=_work, name=f"jukebox-prepare-{rid}", daemon=True)
        worker.start()
        worker.join(timeout)
        if worker.is_alive():
            log.warning("Jukebox %s: on_prepare ueberschreitet %.1fs - Auftrag %s abgebrochen",
                        style, timeout, rid)
            return False, "prepare_timeout"
        if "exc" in result:
            log.warning("Jukebox %s: on_prepare fehlgeschlagen: %s", style, result["exc"])
            return False, "prepare_failed"
        res = result.get("res") or {}
        if isinstance(res, dict) and res.get("success") is False:
            log.warning("Jukebox %s: on_prepare gemeldet: %s", style, res)
            return False, "prepare_failed"
        return True, ""

    def _fire(self, style: str, hook: str, rid: str, track: dict, reason: str = "") -> None:
        spec = self.styles().get(style) if style else None
        actions = (spec or {}).get(hook) if isinstance(spec, dict) else None
        if not actions:
            return
        ctx = {"jukebox": {"request_id": rid, "style": style, "track": track.get("id"),
                           "title": track.get("title"), "hook": hook, "reason": reason}}

        def _work() -> None:
            try:
                res = self._run_actions(list(actions), ctx)
                if not (res or {}).get("success", True):
                    log.warning("Jukebox %s/%s: Actions gemeldet: %s", style, hook, res)
            except Exception as e:  # noqa: BLE001
                log.warning("Jukebox %s/%s: Actions fehlgeschlagen: %s", style, hook, e)

        threading.Thread(target=_work, name=f"jukebox-{hook}", daemon=True).start()
