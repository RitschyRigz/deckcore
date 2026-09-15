"""mpv-IPC-Lesethread: liest nur, wenn Daten anliegen, und parst Zeilen aus Chunks.

Hintergrund (15.09.2026): Windows serialisiert Read und Write auf einer synchronen Named-Pipe.
Der alte ``readline()`` blockierte, sobald mpv pausierte (keine Events mehr), und hielt damit
jeden Write (``pause(False)``) fest — das Musikbett kam nach einem Jukebox-Song nicht zurueck.
Der echte Nachweis mit mpv steht im Musikbett-Dokument; hier laeuft der Parser ueber eine
anonyme Pipe (``PeekNamedPipe`` gilt auf Windows auch dafuer) mit zerschnittenen Zeilen.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


class _Proc:
    def __init__(self) -> None:
        self.code = None

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        return self.code


def _reader_over_pipe(lines: list[bytes], *, close_without_end: bool = False):
    r, w = os.pipe()
    fh = open(r, "rb", buffering=0)
    events: list[dict] = []
    player = jb._MpvAudio("mpv", "pipe-name", events.append)
    player._proc = _Proc()
    player._open_pipe = lambda timeout_s=4.0: fh  # type: ignore[method-assign]
    player._send = lambda cmd: True                # type: ignore[method-assign]
    t = threading.Thread(target=player._reader, daemon=True)
    t.start()

    def _feed() -> None:
        for chunk in lines:
            os.write(w, chunk)
            time.sleep(0.05)
        if close_without_end:
            player._proc.code = 1
        os.close(w)

    threading.Thread(target=_feed, daemon=True).start()
    t.join(5.0)
    assert not t.is_alive(), "Lesethread haengt"
    return events


def test_zeilen_werden_auch_aus_zerschnittenen_chunks_gelesen():
    msg1 = json.dumps({"event": "property-change", "name": "duration", "data": 120.0}).encode()
    msg2 = json.dumps({"event": "property-change", "name": "time-pos", "data": 3.5}).encode()
    end = json.dumps({"event": "end-file", "reason": "eof"}).encode()
    # Zeile 2 in zwei Haelften, Zeile 3 direkt angehaengt — wie ein echter Pipe-Puffer.
    events = _reader_over_pipe([msg1 + b"\n" + msg2[:10], msg2[10:] + b"\n" + end + b"\n"])
    kinds = [(e["event"], e.get("position"), e.get("duration")) for e in events]
    assert ("progress", 0.0, 120.0) in kinds
    assert ("progress", 3.5, 120.0) in kinds
    assert events[-1]["event"] == "end" and events[-1]["reason"] == "eof"


def test_pipe_ohne_end_file_meldet_prozessende():
    msg = json.dumps({"event": "property-change", "name": "pause", "data": True}).encode()
    events = _reader_over_pipe([msg + b"\n"], close_without_end=True)
    assert events[0] == {"event": "paused", "paused": True}
    assert events[-1]["event"] == "end" and events[-1]["reason"] == "error"


def test_pipe_available_ist_auf_windows_eine_zahl():
    r, w = os.pipe()
    fh = open(r, "rb", buffering=0)
    try:
        if os.name == "nt":
            assert jb._pipe_available(fh) == 0
            os.write(w, b"abc\n")
            assert jb._pipe_available(fh) == 4
        else:
            assert jb._pipe_available(fh) == -1
    finally:
        os.close(w)
        fh.close()
