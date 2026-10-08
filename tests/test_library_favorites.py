"""Favoriten-Stern und Sammel-Abschnitte der Mediathek-Maschine (Richard 06.10.2026):
``favorite`` ist ein Metafeld je Track, ``populate_library`` erzeugt daraus den Abschnitt
„Favoriten" (Zweittasten) vor den Stilen, jede Track-Taste traegt den Stern als Langdruck,
``recent_section`` liefert „Neueste N". Ein Baustein fuer Musik, Videos und TTS."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402
from deckcore.service import DeckCoreService  # noqa: E402


class Bus:
    def publish(self, *a, **k):
        pass


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music" / "metal"
    music.mkdir(parents=True)
    for name in ("2026-09-22 - Wir schnetzeln.wav", "2026-09-25 - Ritschy kommt gleich.wav",
                 "2026-10-01 - Dritter.wav"):
        (music / name).write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(tmp_path / "music"), recent_section=3)
    return lib


def _svc(tmp_path: Path) -> DeckCoreService:
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    return svc


def test_favorite_is_a_meta_flag_toggled_per_track(tmp_path):
    lib = _lib(tmp_path)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    assert lib.favorite(tid)["favorite"] is True
    assert next(t for t in lib.library() if t["id"] == tid)["favorite"] is True
    assert lib.favorite(tid)["favorite"] is False
    assert lib.favorite("gibt-es-nicht")["ok"] is False


def test_populate_adds_favorites_and_recent_sections_with_long_press(tmp_path):
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    lib.favorite(tid, True)
    res = svc.populate_library(lib, "main", group="Jukebox")
    assert res["ok"]
    ids = {b["id"] for b in svc._buttons}
    assert "jb_fav_" + tid in ids, "Favorit bekommt eine Zweittaste im Abschnitt Favoriten"
    assert sum(1 for b in svc._buttons if b["id"].startswith("jb_new_")) == 3, "recent_section=3"
    track_btn = next(b for b in svc._buttons if b["id"] == "jb_" + tid)
    assert track_btn["long_action"] == {"type": "jukebox", "mode": "favorite", "track": tid}
    fav_btn = next(b for b in svc._buttons if b["id"] == "jb_fav_" + tid)
    assert fav_btn["action"] == {"type": "jukebox", "mode": "toggle", "track": tid}
    deck = svc._decks[0]
    cats = deck["categories"]
    assert cats.index("⭐ Favoriten") < cats.index("🆕 Neueste") < cats.index("metal")
    # Stern weg -> Zweittaste weg, Track-Taste bleibt
    lib.favorite(tid, False)
    svc.populate_library(lib, "main", group="Jukebox")
    ids = {b["id"] for b in svc._buttons}
    assert "jb_fav_" + tid not in ids and "jb_" + tid in ids


def test_library_favorite_repopulates_registered_library(tmp_path):
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    lib.set_config(deck_id="main")
    calls = []
    svc.register_library("jukebox", lambda: lib, lambda deck_id: calls.append(deck_id) or {"ok": True},
                         prefix="jb_", action_type="jukebox", monitor_type="jukebox_state")
    tid = lib.library()[0]["id"]
    res = svc.library_favorite("jukebox", lib, tid)
    assert res["success"] and res["favorite"] is True and calls == ["main"]


def test_deleted_secondary_buttons_stay_deleted(tmp_path):
    """Codex R1 F03: eine per delete_button entfernte Favoriten-/Neueste-Taste kommt beim
    naechsten Abgleich nicht zurueck; Haupttaste und Abschnitt bleiben."""
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    lib.favorite(tid, True)
    svc.populate_library(lib, "main", group="Jukebox")
    svc.delete_button("jb_fav_" + tid)
    svc.delete_button("jb_new_" + tid)
    svc.populate_library(lib, "main", group="Jukebox")
    ids = {b["id"] for b in svc._buttons}
    assert "jb_fav_" + tid not in ids and "jb_new_" + tid not in ids and "jb_" + tid in ids


def test_secondary_buttons_follow_catalogue_title_changes(tmp_path):
    """Codex R1 F04: Katalogtitel aendert sich -> Haupt-, Favoriten- und Neueste-Taste zeigen den
    neuen Titel; eine vom Nutzer gesetzte Beschriftung bleibt."""
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    lib.favorite(tid, True)
    svc.populate_library(lib, "main", group="Jukebox")
    lib.update_track_meta(tid, {"title": "Gleich Remix"})
    svc.populate_library(lib, "main", group="Jukebox")
    for bid in ("jb_" + tid, "jb_fav_" + tid, "jb_new_" + tid):
        b = next(b for b in svc._buttons if b["id"] == bid)
        assert b["label"] == "Gleich Remix", bid
        assert "Gleich Remix" in b["default"]["title"], bid
    # Nutzerkosmetik bleibt: eigener Ruhetitel an der Favoritentaste
    fav = next(b for b in svc._buttons if b["id"] == "jb_fav_" + tid)
    fav["default"] = {**fav["default"], "title": "MEIN STERN"}
    lib.update_track_meta(tid, {"title": "Gleich Final"})
    svc.populate_library(lib, "main", group="Jukebox")
    fav = next(b for b in svc._buttons if b["id"] == "jb_fav_" + tid)
    assert fav["default"]["title"] == "MEIN STERN" and fav["label"] == "Gleich Final"


def test_star_marks_the_main_button_and_sections_follow_library(tmp_path):
    """Richard 06.10.2026: der Stern steht auch an der HAUPTTASTE im Stil-Abschnitt; mit
    ``sections_follow_library`` bestimmt die Mediathek die Abschnittsreihenfolge (Favoriten vor
    einem schon vorhandenen Stil-Abschnitt), fremde Abschnitte bleiben dahinter."""
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    svc._decks[0]["categories"] = ["Fremd", "metal"]
    lib.set_config(sections_follow_library=True, new_badge_days=0)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    lib.favorite(tid, True)
    svc.populate_library(lib, "main", group="Jukebox")
    main_btn = next(b for b in svc._buttons if b["id"] == "jb_" + tid)
    assert main_btn["default"]["title"].startswith("⭐ ") and main_btn["default"]["icon"] != "⭐"
    other = next(b for b in svc._buttons if b["id"] == "jb_" + next(
        t["id"] for t in lib.library() if "Dritter" in t["title"]))
    assert not other["default"]["title"].startswith("⭐")
    assert svc._decks[0]["categories"] == ["Jukebox", "⭐ Favoriten", "🆕 Neueste", "metal", "Fremd"]
    # Stern weg → Abzeichen weg (Generator-Titel folgt dem Katalog)
    lib.favorite(tid, False)
    svc.populate_library(lib, "main", group="Jukebox")
    main_btn = next(b for b in svc._buttons if b["id"] == "jb_" + tid)
    assert not main_btn["default"]["title"].startswith("⭐")


def test_recent_excludes_styles_and_secondary_buttons_carry_the_artist(tmp_path):
    """``recent_exclude_styles`` haelt einen Stil aus „Neueste" heraus (er bleibt in seinem
    Abschnitt); Metafeld ``artist`` steht in Favoriten/Neueste vor dem Titel, in der Haupttaste nicht."""
    lib, svc = _lib(tmp_path), _svc(tmp_path)
    ans = tmp_path / "music" / "ansagen"
    ans.mkdir()
    (ans / "2026-10-06 - Ansage.wav").write_bytes(b"RIFF")
    lib.set_config(recent_exclude_styles=["ansagen"], new_badge_days=0)
    tid = next(t["id"] for t in lib.library() if "kommt gleich" in t["title"])
    lib.update_track_meta(tid, {"artist": "Sentavius"})
    lib.favorite(tid, True)
    svc.populate_library(lib, "main", group="Jukebox")
    ids = {b["id"] for b in svc._buttons}
    ans_id = next(t["id"] for t in lib.library() if t["style"] == "ansagen")
    assert "jb_" + ans_id in ids and "jb_new_" + ans_id not in ids
    assert sum(1 for b in svc._buttons if b["id"].startswith("jb_new_")) == 3
    main_btn = next(b for b in svc._buttons if b["id"] == "jb_" + tid)
    fav_btn = next(b for b in svc._buttons if b["id"] == "jb_fav_" + tid)
    new_btn = next(b for b in svc._buttons if b["id"] == "jb_new_" + tid)
    assert main_btn["label"] == "2026-09-25 - Ritschy kommt gleich" and "Sentavius" not in main_btn["default"]["title"]
    assert fav_btn["label"] == "Sentavius: 2026-09-25 - Ritschy kommt gleich"
    assert fav_btn["default"]["title"].startswith("⭐ Sentavius: ")
    assert new_btn["default"]["title"].startswith("⭐ Sentavius: ")


def test_two_libraries_sharing_a_section_keep_their_positions(tmp_path):
    """Codex 1c F10: zwei Mediatheken im selben Ordner teilen sich „⭐ Favoriten"; abwechselnde
    Abgleiche (auch mit Sternwechsel) duerfen die Plaetze der Tasten nicht vertauschen."""
    svc = _svc(tmp_path)
    a = _lib(tmp_path / "a")
    music_b = tmp_path / "b" / "music" / "cozy"
    music_b.mkdir(parents=True)
    for name in ("2026-10-01 - Clip Eins.wav", "2026-10-02 - Clip Zwei.wav"):
        (music_b / name).write_bytes(b"RIFF")
    b = jb.Jukebox(tmp_path / "b" / "rt", mpv_resolver=lambda p: "", run_actions=lambda x, v: {}, publish=None)
    b.set_config(library_dir=str(tmp_path / "b" / "music"), recent_section=0)
    a.favorite(a.library()[0]["id"], True)
    b.favorite(b.library()[0]["id"], True)

    def favs():
        return [it["button"] for it in svc._decks[0]["items"] if it.get("category") == "⭐ Favoriten"]

    svc.populate_library(a, "main", group="TTS", prefix="ta_")
    svc.populate_library(b, "main", group="Clips", prefix="cb_")
    first = favs()
    assert [x[:3] for x in first] == ["ta_", "cb_"]
    for _ in range(3):
        svc.populate_library(a, "main", group="TTS", prefix="ta_")
        svc.populate_library(b, "main", group="Clips", prefix="cb_")
        assert favs() == first, "Favoritenplaetze bleiben stabil"
    # Stern dazu bei A: neue Taste kommt dazu, die bestehenden behalten ihre Reihenfolge
    a.favorite(a.library()[1]["id"], True)
    svc.populate_library(a, "main", group="TTS", prefix="ta_")
    svc.populate_library(b, "main", group="Clips", prefix="cb_")
    now = favs()
    assert [x for x in now if x in first] == first and len(now) == 3
