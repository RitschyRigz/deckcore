"""Mitsing-Overlay darf nicht hinter dem Gesang herhinken (Stream 07.10.2026).

Befund: mpv meldet ``time-pos`` sehr oft; je Meldung lief ``lyrics()`` mit vollem Bibliotheks-
Scan (~35 ms). Der Lesethread staute die Meldungen, das Overlay hing 2-9 s zurueck und
uebersprang Zeilen. Jetzt: aufgestaute Positionen werden zur neuesten zusammengefasst, und
die Cues werden je Auftrag einmal geladen.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402
import threading  # noqa: E402


class _Proc:
    code = None

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        return self.code


def _reader_over_pipe(chunks: list[bytes]) -> list[dict]:
    """Echter Lesethread ueber eine anonyme Pipe (wie test_jukebox_ipc_reader)."""
    r, w = os.pipe()
    fh = open(r, "rb", buffering=0)
    events: list[dict] = []
    player = jb._MpvAudio("mpv", "pipe-name", events.append)
    player._proc = _Proc()
    player._open_pipe = lambda timeout_s=4.0: fh  # type: ignore[method-assign]
    player._send = lambda cmd: True                # type: ignore[method-assign]
    t = threading.Thread(target=player._reader, daemon=True)
    t.start()
    for chunk in chunks:
        os.write(w, chunk)
        time.sleep(0.05)
    os.close(w)
    t.join(5.0)
    assert not t.is_alive(), "Lesethread haengt"
    return events


def _pos(t: float) -> bytes:
    return json.dumps({"event": "property-change", "name": "time-pos", "data": t}).encode() + b"\n"


def test_aufgestaute_positionen_werden_zur_neuesten_zusammengefasst():
    burst = b"".join(_pos(i / 10) for i in range(1, 201))          # 200 Meldungen auf einmal
    end = json.dumps({"event": "end-file", "reason": "eof"}).encode() + b"\n"
    events = _reader_over_pipe([burst, end])
    progress = [e for e in events if e["event"] == "progress"]
    assert len(progress) <= 3, progress                            # kein Abarbeiten von 200 Altwerten
    assert progress[-1]["position"] == 20.0                        # der neueste Stand kommt an
    assert events[-1]["event"] == "end" and events[-1]["position"] == 20.0


def test_position_kommt_vor_dem_folgeereignis_an():
    pause = json.dumps({"event": "property-change", "name": "pause", "data": True}).encode() + b"\n"
    events = _reader_over_pipe([_pos(4.2) + pause])
    kinds = [e["event"] for e in events]
    assert kinds.index("progress") < kinds.index("paused")
    assert [e for e in events if e["event"] == "progress"][-1]["position"] == 4.2


def test_cues_werden_je_auftrag_nur_einmal_geladen(tmp_path):
    music = tmp_path / "music" / "duet"
    music.mkdir(parents=True)
    wav = music / "2026-10-07 - Song.wav"
    wav.write_bytes(b"RIFF")
    wav.with_suffix(".srt").write_text(
        "1\n00:00:01,000 --> 00:00:03,000\nEins\n\n2\n00:00:03,000 --> 00:00:05,000\nZwei\n",
        encoding="utf-8")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(tmp_path / "music"))
    track = lib.library()[0]["id"]
    calls = []
    real = lib.lyrics
    lib.lyrics = lambda tid: calls.append(tid) or real(tid)        # type: ignore[method-assign]
    with lib._lock:
        lib._state.update({"state": "playing", "request_id": "r1", "track": track})
    for p in (0.5, 1.2, 2.0, 3.4, 4.1):
        lib._on_player_event("r1", {"event": "progress", "position": p, "duration": 6.0})
    assert calls == [track]
    assert lib.status()["lyric"]["text"] == "Zwei"
    # neuer Auftrag -> Cues neu laden
    with lib._lock:
        lib._state.update({"request_id": "r2"})
    lib._on_player_event("r2", {"event": "progress", "position": 1.5, "duration": 6.0})
    assert calls == [track, track]
    assert lib.status()["lyric"]["text"] == "Eins"
