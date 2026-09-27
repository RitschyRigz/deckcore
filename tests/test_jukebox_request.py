"""Gesprochener Auftrag -> Kategorie (Musikseite M3b): jede Kategorie gleichwertig, Woerter im
Katalog (styles.json request.words), Standard aus config.json request_default."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402

STYLES = {"styles": {
    "dj": {"label": "DJ", "request": {"words": ["dj", "party"]}},
    "metal": {"label": "Metal", "request": {"words": ["metal"]}},
    "duet": {"label": "Duett", "request": {"words": ["duett", "mit lisa", "zusammen"]}},
    "musical": {"label": "Musical", "request": {"words": ["musical"], "play_style": "musical_live"}},
    "musical_live": {"label": "Musical (live)", "tracks": "musical"},
    "dance": {"label": "Tanz", "request": {"words": ["tanz", "dance"]}},
}}


def _lib(tmp_path: Path, default="dj") -> jb.Jukebox:
    music = tmp_path / "music"
    for folder, name, date in (("dj", "2026-09-20 - Alt", 300), ("dj", "2026-09-26 - Neu", 200),
                               ("metal", "2026-09-19 - Durch die Nacht", 100), ("metal", "2026-09-26 - Sturmfrei", 50),
                               ("duet", "2026-09-24 - Kuechentuer", 10), ("musical", "2026-09-25 - Radio", 10),
                               ("dance", "2026-09-01 - Tanz", 10)):
        (music / folder).mkdir(parents=True, exist_ok=True)
        f = music / folder / (name + ".wav")
        f.write_bytes(b"RIFF")
        os.utime(f, (time.time() - date, time.time() - date))
    rt = tmp_path / "rt"
    lib = jb.Jukebox(rt, mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music))
    d = Path(lib._dir)
    (d / "styles.json").write_text(json.dumps(STYLES), encoding="utf-8")
    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    cfg["request_default"] = default
    (d / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    return lib


def test_category_from_words_first_mention_wins(tmp_path):
    lib = _lib(tmp_path)
    r = lib.resolve_request
    assert r("Bruno, sing mir einen Song")["style"] == "dj" and r("Bruno, sing mir einen Song")["default"]
    assert r("Bruno, spiel nen Metal-Song")["style"] == "metal"
    assert r("Bruno, hast du ein Duett mit Lisa?")["style"] == "duet"
    assert r("Bruno, sing was zusammen mit Lisa")["style"] == "duet"
    assert r("Bruno, lass uns tanzen, sing was")["style"] == "dance"
    assert r("Bruno, spiel ein Musical")["play_style"] == "musical_live"
    assert r("Bruno, erst Metal, dann ein Duett")["style"] == "metal", "zuerst genannt"
    assert r("Bruno, spiel was vom DJ")["style"] == "dj" and not r("Bruno, spiel was vom DJ")["default"]
    assert r("Bruno, spiel was Metallisches")["style"] == "metal", "Wortanfang"
    assert r("Bruno, spiel das Dejavu")["default"], "kein Treffer mitten im Wort"


def test_no_default_and_no_word_is_a_clear_refusal(tmp_path):
    lib = _lib(tmp_path, default="")
    assert lib.resolve_request("Bruno, sing was")["ok"] is False


def test_play_request_takes_the_newest_of_the_category(tmp_path):
    lib = _lib(tmp_path)
    played = []
    lib.play = lambda track_id, style_override="": played.append((track_id, style_override)) or {"ok": True}
    assert lib.play_request("Bruno, spiel nen Metal-Song")["request"]["style"] == "metal"
    assert played[-1][0] == "metal_2026_09_26_sturmfrei"
    lib.play_request("Bruno, sing mir einen Song")
    assert played[-1][0] == "dj_2026_09_26_neu"
    lib.play_request("Bruno, spiel ein Musical")
    assert played[-1] == ("musical_2026_09_25_radio", "musical_live"), "Rezept Exkursion"
