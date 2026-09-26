"""Ordner = Kategorie (Musikseite M2, 26.09.2026): Umzug samt Begleitdateien + Metadaten +
Alias, Papierkorb neben der Bibliothek, Wiederherstellen — alles oder nichts."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music"
    for d in ("bruno_song", "metal"):
        (music / d).mkdir(parents=True)
    song = music / "bruno_song" / "2026-09-12 - Kaffee im Bierglas"
    song.with_suffix(".wav").write_bytes(b"RIFF")
    song.with_suffix(".srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nKaffee\n", encoding="utf-8")
    song.with_suffix(".png").write_bytes(b"PNG")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music))
    return lib


OLD = "bruno_song_2026_09_12_kaffee_im_bierglas"
NEW = "metal_2026_09_12_kaffee_im_bierglas"


def test_umzug_nimmt_begleitdateien_metadaten_und_alias_mit(tmp_path):
    lib = _lib(tmp_path)
    lib.update_track_meta(OLD, {"title": "Kaffee im Bierglas", "game": "The Alters", "style": "bruno_song"})
    res = lib.move_track(OLD, "metal")
    assert res == {"ok": True, "old_id": OLD, "new_id": NEW, "rel": "metal/2026-09-12 - Kaffee im Bierglas.wav"}
    music = tmp_path / "music"
    assert sorted(p.name for p in (music / "metal").iterdir()) == [
        "2026-09-12 - Kaffee im Bierglas.png", "2026-09-12 - Kaffee im Bierglas.srt", "2026-09-12 - Kaffee im Bierglas.wav"]
    assert not any((music / "bruno_song").iterdir())
    t = lib.track(NEW)
    assert t["title"] == "Kaffee im Bierglas" and t["style"] == "metal", "Ordner ist die Stil-Wahrheit"
    assert t["meta"] == {"game": "The Alters"} and t["source_date"] == "2026-09-12"
    assert lib.lyrics(NEW) and lib.cover(NEW)
    assert lib.aliases() == {OLD: NEW} and lib.resolve_id(OLD) == NEW


def test_alias_kette_und_rueckumzug(tmp_path):
    lib = _lib(tmp_path)
    (tmp_path / "music" / "dj").mkdir()
    lib.move_track(OLD, "metal")
    lib.move_track(NEW, "dj")
    dj = "dj_2026_09_12_kaffee_im_bierglas"
    assert lib.aliases() == {OLD: dj, NEW: dj}, "Ketten verdichtet"
    lib.move_track(dj, "bruno_song")
    assert lib.aliases() == {NEW: OLD, dj: OLD}, "aktuelle Kennung ist nie ein Alias"


def test_ablehnungen_aendern_nichts(tmp_path):
    lib = _lib(tmp_path)
    before = sorted(str(p) for p in (tmp_path / "music").rglob("*"))
    assert not lib.move_track(OLD, "gibtsnicht")["ok"]
    assert not lib.move_track(OLD, "../metal")["ok"]
    assert not lib.move_track(OLD, "bruno_song")["ok"]
    (tmp_path / "music" / "metal" / "2026-09-12 - Kaffee im Bierglas.srt").write_text("x", encoding="utf-8")
    res = lib.move_track(OLD, "metal")
    assert not res["ok"] and "schon" in res["reason"]
    after = sorted(str(p) for p in (tmp_path / "music").rglob("*"))
    assert set(before) <= set(after) and lib.aliases() == {}


def test_laufender_song_wird_nicht_bewegt(tmp_path):
    lib = _lib(tmp_path)
    lib._set(publish=False, state="playing", track=OLD)
    assert lib.move_track(OLD, "metal") == {"ok": False, "reason": "Song laeuft gerade"}
    assert lib.trash_track(OLD) == {"ok": False, "reason": "Song laeuft gerade"}


def test_papierkorb_liegt_neben_der_bibliothek_und_stellt_zurueck(tmp_path):
    lib = _lib(tmp_path)
    lib.update_track_meta(OLD, {"title": "Kaffee im Bierglas"})
    res = lib.trash_track(OLD, note={"publish": "now"})
    assert res["ok"]
    assert lib.trash_dir() == tmp_path / "music_papierkorb"
    assert lib.track(OLD) is None and not any((tmp_path / "music" / "bruno_song").iterdir())
    listed = lib.trash_list()
    assert [e["track_id"] for e in listed] == [OLD] and listed[0]["note"] == {"publish": "now"}
    back = lib.restore_track(listed[0]["entry"])
    assert back == {"ok": True, "track_id": OLD, "note": {"publish": "now"}}
    assert lib.track(OLD)["title"] == "Kaffee im Bierglas" and lib.lyrics(OLD)
    assert lib.trash_list() == []


def test_wiederherstellen_ueberschreibt_nie(tmp_path):
    lib = _lib(tmp_path)
    entry = lib.trash_track(OLD)["entry"]
    (tmp_path / "music" / "bruno_song" / "2026-09-12 - Kaffee im Bierglas.wav").write_bytes(b"NEU")
    res = lib.restore_track(entry)
    assert not res["ok"] and "belegt" in res["reason"]
    assert (tmp_path / "music" / "bruno_song" / "2026-09-12 - Kaffee im Bierglas.wav").read_bytes() == b"NEU"
    assert not lib.restore_track("../x")["ok"]


def test_schreibfehler_stellt_dateien_und_metadaten_zurueck(tmp_path, monkeypatch):
    """Codex R9 F19: scheitert aliases.json, bleiben Datei, library.json und Alias-Karte alt."""
    lib = _lib(tmp_path)
    lib.update_track_meta(OLD, {"title": "Kaffee im Bierglas"})
    real = lib._write_json

    def failing(name, data):
        if name == "aliases.json":
            raise PermissionError("belegt")
        return real(name, data)
    monkeypatch.setattr(lib, "_write_json", failing)
    res = lib.move_track(OLD, "metal")
    assert not res["ok"] and "zurueckgestellt" in res["reason"]
    monkeypatch.setattr(lib, "_write_json", real)
    assert lib.track(OLD)["title"] == "Kaffee im Bierglas" and lib.track(NEW) is None
    meta = json.loads((tmp_path / "rt" / "jukebox" / "library.json").read_text(encoding="utf-8"))["tracks"]
    assert OLD in meta and NEW not in meta
    assert lib.aliases() == {}


def test_papierkorb_schreibfehler_hinterlaesst_keinen_geist(tmp_path, monkeypatch):
    lib = _lib(tmp_path)
    real = lib._write_json

    def failing(name, data):
        if name == "library.json":
            raise PermissionError("belegt")
        return real(name, data)
    monkeypatch.setattr(lib, "_write_json", failing)
    assert not lib.trash_track(OLD)["ok"]
    monkeypatch.setattr(lib, "_write_json", real)
    assert lib.track(OLD) is not None and lib.trash_list() == []


def test_gescheiterte_rueckstellung_meldet_das_ehrlich(tmp_path, monkeypatch):
    """Codex R10 F19: scheitert auch die Rueckstellung, heisst es nie „zurueckgestellt"."""
    lib = _lib(tmp_path)
    real = lib._write_json
    calls = {"library.json": 0}

    def failing(name, data):
        if name == "aliases.json":
            raise PermissionError("belegt")
        calls[name] = calls.get(name, 0) + 1
        if name == "library.json" and calls[name] > 1:          # die Rueckstellung selbst
            raise PermissionError("auch belegt")
        return real(name, data)
    monkeypatch.setattr(lib, "_write_json", failing)
    res = lib.move_track(OLD, "metal")
    assert res["ok"] is False and res["rollback_failed"] is True and "zurueckgestellt" not in res["reason"]


def test_plan_und_fortsetzung_nach_abbruch(tmp_path):
    """Absturz nach dem Bewegen, vor den Metadaten: complete_move fuehrt nach dem echten
    Dateistand zu Ende (idempotent); liegt eine Datei an beiden Orten, entscheidet es nicht."""
    lib = _lib(tmp_path)
    plan = lib.plan_move(OLD, "metal")
    assert plan["ok"] and plan["new_id"] == NEW and len(plan["pairs"]) == 3
    src, dst = plan["pairs"][0]
    Path(dst).parent.mkdir(exist_ok=True)
    Path(src).replace(dst)                                      # nur die Audiodatei ist schon drueben
    res = lib.complete_move(OLD, NEW, plan["pairs"])
    assert res == {"ok": True, "old_id": OLD, "new_id": NEW, "moved": 2}
    assert lib.track(NEW) and lib.lyrics(NEW) and lib.aliases() == {OLD: NEW}
    assert lib.complete_move(OLD, NEW, plan["pairs"])["moved"] == 0
    Path(plan["pairs"][1][0]).write_text("x", encoding="utf-8")   # Datei an beiden Orten
    assert not lib.complete_move(OLD, NEW, plan["pairs"])["ok"]
