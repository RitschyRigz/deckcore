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
    lib.set_config(library_dir=str(tmp_path / "music"), recent_section=2)
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
    assert sum(1 for b in svc._buttons if b["id"].startswith("jb_new_")) == 2, "recent_section=2"
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
