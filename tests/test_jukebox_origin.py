"""Herkunft je Track (Quellstream-Datum aus Metadaten/Titel, Neuzugang = Anlagezeit) und die
Auswahl ``latest_origin`` — ein nachgelieferter alter Song ist kein aktueller Recap (17.09.2026)."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music" / "bruno_song"
    music.mkdir(parents=True)
    for name, age in (("2026-09-11 - Doch ihr seid wach.wav", 300), ("2026-09-12 - Kaffee im Bierglas.wav", 200),
                      ("Recap Bruno 10.09.26.mp3", 10)):
        f = music / name
        f.write_bytes(b"RIFF")
        os.utime(f, (time.time() - age, time.time() - age))
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(tmp_path / "music"))
    return lib


def test_library_traegt_herkunft_und_neuzugang(tmp_path):
    lib = _lib(tmp_path)
    by_title = {t["title"]: t for t in lib.library()}
    assert by_title["2026-09-12 - Kaffee im Bierglas"]["source_date"] == "2026-09-12"
    assert by_title["2026-09-11 - Doch ihr seid wach"]["source_date"] == "2026-09-11"
    assert by_title["Recap Bruno 10.09.26"]["source_date"] == "", "kein ISO-Datum = keine Herkunft erfinden"
    for t in by_title.values():
        assert t["added_at"] > 0 and "source_session" in t


def test_metadaten_schlagen_den_titel(tmp_path):
    lib = _lib(tmp_path)
    tid = next(t["id"] for t in lib.library() if t["title"].startswith("Recap Bruno"))
    lib.set_track_style(tid, "bruno_song", source_date="2026-09-10", source_session="2026-09-10_19-03_X")
    t = next(t for t in lib.library() if t["id"] == tid)
    assert t["source_date"] == "2026-09-10" and t["source_session"] == "2026-09-10_19-03_X"


def test_latest_origin_waehlt_die_juengste_herkunft_nicht_die_juengste_datei(tmp_path):
    lib = _lib(tmp_path)
    started = {}
    lib.play = lambda tid, **kw: started.setdefault("tid", tid) or {"ok": True, "track": tid}  # type: ignore[method-assign]
    lib.play_random("bruno_song", pick="newest")
    newest = started.pop("tid")
    assert "recap_bruno" in newest, "mtime-juengste Datei ist der alte Recap ohne Datum"
    lib.play_random("bruno_song", pick="latest_origin")
    assert "2026_09_12" in started["tid"], "juengste Herkunft = 12.09."
