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
  styles.json   {"styles": {"dance": {"label": "Tanz", "on_start": [..], "on_end": [..], "on_stop": [..]}}}
  state.json    zuletzt veroeffentlichter Zustand (fuer file_field-Monitore und Hosts)
"""
from __future__ import annotations

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

log = logging.getLogger("deckcore.jukebox")

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac"}
STATES = ("idle", "queued", "starting", "playing", "paused", "ended", "stopped", "error")
_ACTIVE = {"starting", "playing", "paused"}


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")
    return s or "track"


# ───────────────────────────── Player (mpv, nur Audio) ─────────────────────────────

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
        try:
            while True:
                line = fh.readline()
                if not line:
                    break
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
                 publish: Optional[Callable[[str, dict], None]] = None) -> None:
        self._dir = Path(runtime_dir) / "jukebox"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._resolve_mpv = mpv_resolver
        self._run_actions = run_actions
        self._publish = publish
        self._lock = threading.RLock()
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
                             "updated_at": time.time()}
        self._last_progress_publish = 0.0
        self._write_state()

    # -- Config / Daten -------------------------------------------------------------------
    def _json(self, name: str) -> dict:
        p = self._dir / name
        try:
            v = json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else {}
            return v if isinstance(v, dict) else {}
        except Exception as e:  # noqa: BLE001
            log.warning("jukebox/%s unlesbar: %s", name, e)
            return {}

    def config(self) -> dict:
        return self._json("config.json")

    def set_config(self, **kw) -> dict:
        cfg = self.config()
        for k, v in kw.items():
            if v is not None:
                cfg[k] = v
        (self._dir / "config.json").write_text(json.dumps(cfg, indent=2, ensure_ascii=False), "utf-8")
        return cfg

    def styles(self) -> dict:
        raw = self._json("styles.json").get("styles")
        return raw if isinstance(raw, dict) else {}

    def set_track_style(self, track_id: str, style: str, **fields) -> dict:
        lib = self._json("library.json")
        tracks = lib.setdefault("tracks", {})
        entry = tracks.get(track_id) if isinstance(tracks.get(track_id), dict) else {}
        entry["style"] = str(style or "")
        for k, v in fields.items():
            if v is not None:
                entry[k] = v
        tracks[track_id] = entry
        (self._dir / "library.json").write_text(json.dumps(lib, indent=2, ensure_ascii=False), "utf-8")
        return entry

    def library(self) -> list[dict]:
        """Ordner scannen; Stil aus library.json, sonst aus dem Unterordnernamen; sonst leer."""
        cfg = self.config()
        root = Path(str(cfg.get("library_dir") or ""))
        if not root.is_dir():
            return []
        meta = self._json("library.json").get("tracks")
        meta = meta if isinstance(meta, dict) else {}
        out: list[dict] = []
        for p in sorted(root.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in AUDIO_EXTS:
                continue
            rel = p.relative_to(root)
            tid = _slug(str(rel.with_suffix("")))
            m = meta.get(tid) if isinstance(meta.get(tid), dict) else {}
            folder_style = rel.parts[0] if len(rel.parts) > 1 else ""
            out.append({
                "id": tid, "file": str(p), "rel": str(rel).replace("\\", "/"),
                "title": str(m.get("title") or p.stem),
                "style": str(m.get("style") or folder_style or ""),
                "max_seconds": float(m.get("max_seconds") or 0) or 0.0,
            })
        return out

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
                if p.is_file() and p.suffix.lower() in AUDIO_EXTS:
                    try:
                        st = p.stat()
                        parts.append(f"{p.relative_to(root)}|{st.st_size}|{int(st.st_mtime)}")
                    except OSError:
                        continue
        for name in ("library.json", "styles.json"):
            f = self._dir / name
            try:
                parts.append(f"{name}|{int(f.stat().st_mtime)}" if f.exists() else f"{name}|-")
            except OSError:
                parts.append(f"{name}|?")
        return "\n".join(parts)

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
            snap = dict(self._state)
        if publish:
            self._write_state(snap)
            self._emit(snap)

    def _emit(self, snap: dict) -> None:
        if self._publish:
            try:
                self._publish("jukebox:state", snap)
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
        mpv = self._resolve_mpv(self.config().get("mpv_path") or None)
        if not mpv:
            return {"ok": False, "reason": "mpv nicht gefunden"}
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
        with self._lock:
            prev = self._player
            prev_state = dict(self._state)
        if prev is not None and prev_state.get("state") in _ACTIVE:
            # Songwechsel: alter Auftrag sauber beenden (dessen Stop-Actions), dann der neue.
            self._finish(prev_state, reason="stop", detail="replaced")
            prev.stop()
        device = resolve_audio_device(mpv, str(self.config().get("audio_device") or ""))
        player = _MpvAudio(mpv, self._pipe_name(rid), lambda ev, _rid=rid: self._on_player_event(_rid, ev))
        with self._lock:
            self._player = player
        self._set(state="starting", request_id=rid, track=t["id"], title=t["title"], style=style,
                  position=0.0, duration=0.0, reason=None, detail=None, file=t["file"])
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

    def play_random(self, style: str = "") -> dict:
        pool = [t for t in self.library() if not style or t.get("style") == style]
        snap = self.status()
        pool = [t for t in pool if t["id"] != snap.get("track")] or pool
        if not pool:
            return {"ok": False, "reason": f"keine Tracks fuer Stil {style or '(alle)'}"}
        return self.play(random.choice(pool)["id"])

    def pause(self, flag: bool = True) -> dict:
        with self._lock:
            player = self._player
        if player is None:
            return {"ok": False, "reason": "kein Player"}
        return {"ok": player.pause(flag)}

    # -- intern ----------------------------------------------------------------------------
    def _pipe_name(self, rid: str) -> str:
        return (r"\\.\pipe\deckcore-jukebox-" + rid) if os.name == "nt" else f"/tmp/deckcore-jukebox-{rid}"

    def _cap(self, rid: str) -> None:
        snap = self.status()
        if snap.get("request_id") == rid and snap.get("state") in _ACTIVE:
            with self._lock:
                player = self._player
            self._finish(snap, reason="stop", detail="max_seconds")
            if player is not None:
                player.stop()

    def _on_player_event(self, rid: str, ev: dict) -> None:
        snap = self.status()
        if snap.get("request_id") != rid or snap.get("state") == "queued":
            return   # spaete Meldung eines alten Auftrags — bewusst ignoriert
        kind = ev.get("event")
        if kind == "loaded":
            self._set(state="playing")
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
                self._set(publish=heavy, position=round(position, 1),
                          duration=round(float(ev.get("duration") or 0), 1), lyric=lyric,
                          **({"state": "playing"} if snap.get("state") == "starting" else {}))
        elif kind == "paused":
            if snap.get("state") in ("playing", "paused"):
                self._set(state="paused" if ev.get("paused") else "playing")
        elif kind == "end":
            if snap.get("state") in _ACTIVE:
                reason = str(ev.get("reason") or "unknown")
                self._finish(snap, reason="eof" if reason == "eof" else ("stop" if reason in ("stop", "quit") else "error"),
                             detail=str(ev.get("detail") or ""))

    def _finish(self, snap: dict, *, reason: str, detail: str = "") -> None:
        """Genau EIN Abschluss je Auftrag: Zustand setzen, passende Stil-Actions einmal ausloesen."""
        rid = snap.get("request_id")
        with self._lock:
            if self._state.get("request_id") != rid or self._state.get("state") not in _ACTIVE:
                return
            final = {"eof": "ended", "stop": "stopped"}.get(reason, "error")
            self._state.update({"state": final, "reason": reason, "detail": detail or None,
                                "updated_at": time.time()})
            snap2 = dict(self._state)
        self._write_state(snap2)
        self._emit(snap2)
        hook = "on_stop" if reason == "stop" else "on_end"
        self._fire(str(snap.get("style") or ""), hook, str(rid), {"id": snap.get("track"), "title": snap.get("title")},
                   reason=reason)

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
