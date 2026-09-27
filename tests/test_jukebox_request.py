"""Gesprochener Auftrag -> Songs (Musikseite M3b, Richard 27.09.2026): Kategorie genannt ->
diese; Auftrittsart genannt (singen/auflegen/tanzen …) -> alle Kategorien mit dieser Art;
nichts davon -> alle. Keine Kategorie ist Standard; gespielt wird der neueste Song."""
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
    "dj": {"label": "DJ", "request": {"words": ["dj", "party"]}, "performance": {"act": "mix", "by": ["bruno", "lisa"]}},
    "metal": {"label": "Metal", "request": {"words": ["metal"]}, "performance": {"act": "sing", "by": ["bruno"]}},
    "duet": {"label": "Duett", "request": {"words": ["duett", "mit lisa"]}, "performance": {"act": "sing", "by": ["bruno", "lisa"]}},
    "musical": {"label": "Musical", "request": {"words": ["musical"], "play_style": "musical_live"},
                "performance": {"act": "sing", "by": ["bruno", "lisa"]}},
    "musical_live": {"label": "Musical (live)", "tracks": "musical"},
    "dance": {"label": "Tanz", "request": {"words": ["tanz", "dance"]}, "performance": {"act": "dance", "by": ["bruno"]}},
    "violin": {"label": "Geige", "request": {"words": ["geige"]}, "performance": {"act": "instrument", "by": ["lisa"]}},
}}
ACTS = {"sing": {"words": ["sing", "gesungen", "gesang", "lied"]},
        "mix": {"words": ["leg", "auflegen", "mix"]},
        "dance": {"words": ["tanz"]}}


def _lib(tmp_path: Path, songs) -> jb.Jukebox:
    music = tmp_path / "music"
    for folder, name, age in songs:
        (music / folder).mkdir(parents=True, exist_ok=True)
        f = music / folder / (name + ".wav")
        f.write_bytes(b"RIFF")
        os.utime(f, (time.time() - age, time.time() - age))
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music))
    d = Path(lib._dir)
    (d / "styles.json").write_text(json.dumps(STYLES), encoding="utf-8")
    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    cfg["acts"] = ACTS
    (d / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    return lib


SONGS = [("dj", "2026-09-27 - Pausensong", 1), ("metal", "2026-09-26 - Sturmfrei", 50),
         ("metal", "2026-09-19 - Durch die Nacht", 100), ("duet", "2026-09-24 - Kuechentuer", 10),
         ("musical", "2026-09-25 - Radio", 10), ("dance", "2026-09-01 - Tanz", 10),
         ("violin", "2026-09-02 - Wobble", 10)]


def test_recipe_category_then_act_then_all(tmp_path):
    lib = _lib(tmp_path, SONGS)
    r = lib.resolve_request
    assert r("Bruno, spiel nen Metal-Song") == {"ok": True, "by": "category", "styles": ["metal"], "word": "metal"}
    assert r("Bruno, hast du ein Duett mit Lisa?")["styles"] == ["duet"]
    assert r("Bruno, spiel was auf der Geige")["styles"] == ["violin"]
    sing = r("Bruno, sing mir ein Lied")
    assert sing["by"] == "act" and sing["act"] == "sing" and set(sing["styles"]) == {"metal", "duet", "musical"}
    assert r("Bruno, leg was auf")["styles"] == ["dj"]
    assert r("Bruno, sing was zum Tanzen")["styles"] == ["dance"], "Kategorie gewinnt vor Auftrittsart"
    alle = r("Bruno, spiel nen Song")
    assert alle["by"] == "all" and "musical_live" not in alle["styles"], "Rezepte sind keine eigene Kategorie"
    assert set(alle["styles"]) == {"dj", "metal", "duet", "musical", "dance", "violin"}
    (tmp_path / "music" / "rock").mkdir()
    (tmp_path / "music" / "rock" / "Neu.wav").write_bytes(b"RIFF")
    assert "rock" in r("Bruno, spiel nen Song")["styles"], "Ordner ohne Stil-Eintrag gehoert zu „alle\""


def test_sing_never_picks_the_dj_set_even_if_it_is_newest(tmp_path):
    """Richard 27.09.: beim DJ singen sie nicht — „sing ein Lied" darf den (neuesten) DJ-Song nie waehlen."""
    lib = _lib(tmp_path, SONGS)
    played = []
    lib.play = lambda track_id, style_override="": played.append((track_id, style_override)) or {"ok": True}
    lib.play_request("Bruno, sing mir ein Lied", pick="newest")
    assert not played[-1][0].startswith("dj_")
    lib.play_request("Bruno, spiel nen Song", pick="newest")
    assert played[-1][0] == "dj_2026_09_27_pausensong", "ohne Angabe: neuester ueberhaupt"
    lib.play_request("Bruno, spiel nen Metal-Song")
    assert played[-1][0] == "metal_2026_09_26_sturmfrei", "neueste Herkunft der Kategorie"
    lib.play_request("Bruno, spiel ein Musical")
    assert played[-1] == ("musical_2026_09_25_radio", "musical_live"), "Rezept Exkursion"


def test_act_without_category_is_a_clear_refusal(tmp_path):
    lib = _lib(tmp_path, SONGS)
    cfg = json.loads((Path(lib._dir) / "config.json").read_text(encoding="utf-8"))
    cfg["acts"]["whistle"] = {"words": ["pfeif"]}
    (Path(lib._dir) / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    assert lib.resolve_request("Bruno, pfeif was")["ok"] is False
