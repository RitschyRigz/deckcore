"""Bibliotheksvertrag der Mediathek-Maschine (Tor G, Richards Entscheidung ueber Codex R5 C1/C2):
ein vorbereiteter Katalog je Mediathek (Liste + Index + Fingerabdruck) aus EINEM Ordnerlauf;
``library()``/``track()`` lesen daraus. Neuzugaenge/Entfernungen erkennt der billige Vorfilter
(Ordner-Zeitstempel), Metadaten werden ohne Ordnerlauf neu aufgelegt, geaenderte Inhalte
bestehender Dateien erst der naechste volle Lauf. Ein Host-Tor haelt den vollen Lauf des
Ordnerwaechters an (nur Vorfilter), bis sich der Ordner aendert."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402
import deckcore.service as ds  # noqa: E402
from deckcore.service import DeckCoreService  # noqa: E402


class Bus:
    def publish(self, *a, **k):
        pass


def _lib(tmp_path: Path) -> tuple[jb.Jukebox, Path]:
    music = tmp_path / "music"
    (music / "metal").mkdir(parents=True)
    (music / "metal" / "A.wav").write_bytes(b"RIFF")
    (music / "metal" / "B.wav").write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music))
    return lib, music


def _count_walks(monkeypatch, lib: jb.Jukebox) -> list:
    walks = []
    orig = lib._walk

    def counted(root):
        walks.append(str(root))
        return orig(root)
    monkeypatch.setattr(lib, "_walk", counted)
    return walks


def test_library_and_track_read_the_prepared_catalog_without_walking(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    walks = _count_walks(monkeypatch, lib)
    first = lib.library()
    assert {t["id"] for t in first} == {"metal_a", "metal_b"} and len(walks) == 1
    for _ in range(20):
        lib.library()
        lib.track("metal_a")
    assert len(walks) == 1, "Lesen laeuft den Ordner nicht mehr ab"
    assert lib.track("metal_a")["file"].endswith("A.wav") and lib.track("nope") is None
    got = lib.track("metal_a")
    got["meta"]["x"] = 1                                   # Kopie, nie der Katalog selbst
    assert lib.track("metal_a")["meta"] == {}


def test_new_and_removed_files_are_seen_through_the_cheap_prefilter(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    walks = _count_walks(monkeypatch, lib)
    lib.library()
    (music / "metal" / "C.wav").write_bytes(b"RIFF")
    assert "metal_c" in {t["id"] for t in lib.library()} and len(walks) == 2
    (music / "dj").mkdir()
    (music / "dj" / "D.wav").write_bytes(b"RIFF")          # neuer Unterordner = Wurzel geaendert
    assert lib.track("dj_d") is not None and len(walks) == 3
    (music / "metal" / "A.wav").unlink()
    assert "metal_a" not in {t["id"] for t in lib.library()} and len(walks) == 4
    lib.library(); lib.library()
    assert len(walks) == 4


def test_metadata_changes_relayer_without_a_walk(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    walks = _count_walks(monkeypatch, lib)
    lib.library()
    lib.update_track_meta("metal_a", {"title": "Riff", "favorite": True, "game": "Alters"})
    t = lib.track("metal_a")
    assert t["title"] == "Riff" and t["favorite"] is True and t["meta"]["game"] == "Alters"
    assert len(walks) == 1
    lib.update_track_meta("metal_b", {"hidden": True})
    assert {t["id"] for t in lib.library()} == {"metal_a"} and len(walks) == 1


def test_changed_contents_need_a_full_run_and_tree_signature_documents_that(tmp_path, monkeypatch):
    """Codex R5 C2: die Ordner-mtime ist keine Aenderungskennung fuer Inhalte — der Vorfilter
    sieht ein ersetztes Cover nicht, der volle Lauf (library_signature/scan) schon."""
    lib, music = _lib(tmp_path)
    cover = music / "metal" / "A.png"
    cover.write_bytes(b"\x89PNG old")
    walks = _count_walks(monkeypatch, lib)
    url = lib.track("metal_a")["cover_url"]
    assert "?v=" in url and len(walks) == 1
    tree_before, sig_before = lib.tree_signature(), lib.library_signature()
    assert len(walks) == 2                                 # library_signature = voller Lauf
    cover.write_bytes(b"\x89PNG new and longer")
    os.utime(cover, ns=(cover.stat().st_atime_ns, cover.stat().st_mtime_ns + 5_000_000))
    assert lib.tree_signature() == tree_before             # Vorfilter: kein Neuzugang
    assert lib.track("metal_a")["cover_url"] == url and len(walks) == 2
    assert lib.library_signature() != sig_before           # voller Lauf sieht den Inhalt
    assert lib.track("metal_a")["cover_url"] != url and len(walks) == 3
    (music / "metal" / "Z.wav").write_bytes(b"RIFF")
    assert lib.tree_signature() != tree_before             # Neuzugang aendert den Ordner


def test_own_file_steps_invalidate_the_catalog(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    (music / "dj").mkdir()
    lib.library()
    walks = _count_walks(monkeypatch, lib)
    res = lib.move_track("metal_a", "dj")
    assert res["ok"] and res["new_id"] == "dj_a"
    assert lib.track("dj_a") is not None and lib.track("metal_a") is None
    assert len(walks) >= 1
    res = lib.trash_track("dj_a")
    assert res["ok"] and lib.track("dj_a") is None


def test_populate_runs_the_folder_once_deliberately(tmp_path, monkeypatch):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    lib = svc.jukebox()
    music = tmp_path / "music"
    (music / "metal").mkdir(parents=True)
    (music / "metal" / "A.wav").write_bytes(b"RIFF")
    lib.set_config(library_dir=str(music))
    lib.library()
    walks = _count_walks(monkeypatch, lib)
    svc.populate_jukebox("main")
    assert len(walks) == 1, "Tasten ableiten = ein bewusster voller Lauf"
    assert any(b.get("_jukebox_track") == "metal_a" for b in svc._buttons)


def _watch_setup(tmp_path, monkeypatch):
    monkeypatch.setattr(ds, "_JUKEBOX_WATCH_SEC", 0)
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    lib = svc.jukebox()
    music = tmp_path / "music"
    (music / "metal").mkdir(parents=True)
    (music / "metal" / "A.wav").write_bytes(b"RIFF")
    lib.set_config(library_dir=str(music), deck_id="main")
    lib.library()                     # vorbereiteter Stand vorhanden (Speicher + catalog.json)
    full = []
    orig_sig = lib.library_signature

    def counted_sig():
        full.append(1)
        return orig_sig()
    monkeypatch.setattr(lib, "library_signature", counted_sig)
    return svc, lib, music, full


def test_watch_loop_runs_only_the_prefilter_while_the_host_gate_pauses(tmp_path, monkeypatch):
    svc, lib, music, full = _watch_setup(tmp_path, monkeypatch)
    ticks = []
    populates = []
    state = {"paused": "Live-Fenster: Test"}
    svc.set_library_scan_gate(lambda: state["paused"])

    def populate(deck_id=""):
        populates.append(deck_id)
        return svc.populate_jukebox(deck_id)

    orig_tree = lib.tree_signature

    def counted_tree():
        ticks.append(1)
        if len(ticks) == 4:
            (music / "metal" / "B.wav").write_bytes(b"RIFF")   # Neuzugang im Live-Fenster
        if len(ticks) >= 7:
            svc._stop.set()
        return orig_tree()
    monkeypatch.setattr(lib, "tree_signature", counted_tree)
    svc.register_library("jukebox", svc.jukebox, populate, fallback_label="Jukebox")
    svc._stop.clear()
    asyncio.run(asyncio.wait_for(svc._library_watch_loop("jukebox"), 5))
    # Takt 1: Vorfilter unbekannt -> ein voller Lauf (Erststand); Takt 2-3: nur Vorfilter;
    # Takt 4: Neuzugang -> voller Lauf + Tasten; danach wieder nur Vorfilter.
    assert len(full) == 2, full
    assert populates and any(b.get("_jukebox_track") == "metal_b" for b in svc._buttons)
    assert svc._libraries["jukebox"].get("paused_reason") == "Live-Fenster: Test"


def test_watch_loop_runs_fully_without_a_gate_and_after_the_gate_opens(tmp_path, monkeypatch):
    svc, lib, music, full = _watch_setup(tmp_path, monkeypatch)
    state = {"paused": "Live-Fenster: Test"}
    svc.set_library_scan_gate(lambda: state["paused"])
    ticks = []
    orig_tree = lib.tree_signature

    def counted_tree():
        ticks.append(1)
        return orig_tree()
    monkeypatch.setattr(lib, "tree_signature", counted_tree)
    calls = []

    def populate(deck_id=""):
        calls.append(1)
        return svc.populate_jukebox(deck_id)
    orig_sig = lib.library_signature

    def sig_and_stop():
        out = orig_sig()
        if state["paused"] is None and len(full) >= 4:
            svc._stop.set()
        if len(full) == 2:
            state["paused"] = None                          # Tor oeffnet sich
        return out
    monkeypatch.setattr(lib, "library_signature", sig_and_stop)
    svc.register_library("jukebox", svc.jukebox, populate, fallback_label="Jukebox")
    svc._stop.clear()

    async def run():
        task = asyncio.ensure_future(svc._library_watch_loop("jukebox"))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if len(full) == 1 and state["paused"]:
                (music / "metal" / "B.wav").write_bytes(b"RIFF")    # loest Lauf 2 aus
            if task.done():
                break
        await asyncio.wait_for(task, 5)
    asyncio.run(run())
    assert len(full) >= 4 and state["paused"] is None
    assert svc._libraries["jukebox"].get("paused_reason") is None   # offen = wieder voll je Takt


def test_foreign_library_without_prefilter_keeps_the_full_run(tmp_path, monkeypatch):
    """Eine Fremd-Mediathek (nur library/library_signature) kennt keinen Vorfilter: im Tor laeuft
    sie wie bisher voll — kein stiller Stillstand."""
    monkeypatch.setattr(ds, "_JUKEBOX_WATCH_SEC", 0)
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc.set_library_scan_gate(lambda: "Live-Fenster: Test")
    sigs = []

    class Foreign:
        def config(self):
            return {"library_dir": str(tmp_path)}

        def library(self):
            return []

        def library_signature(self):
            sigs.append(1)
            if len(sigs) >= 3:
                svc._stop.set()
            return "same"
    svc.register_library("foreign", lambda: Foreign(), lambda deck_id="": {}, prefix="fx_")
    svc._stop.clear()
    asyncio.run(asyncio.wait_for(svc._library_watch_loop("foreign"), 5))
    assert len(sigs) == 3


# -- Codex R13 (F52/F53): vorbereiteter Stand auf der Platte, kein Start-Scan im Tor, Deck-Sicht --

def test_persisted_catalog_serves_a_new_instance_without_a_walk(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    lib.library()                                           # Lesen schreibt nie
    assert not (tmp_path / "rt" / "jukebox" / "catalog.json").exists()
    lib.library_signature()                                 # Waechter-/Populate-Lauf legt ab
    assert (tmp_path / "rt" / "jukebox" / "catalog.json").is_file()
    fresh = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    walks = _count_walks(monkeypatch, fresh)
    assert {t["id"] for t in fresh.library()} == {"metal_a", "metal_b"}
    assert fresh.track("metal_a")["file"].endswith("A.wav") and walks == []
    assert fresh.tree_signature() is not None and fresh.catalog_state() == "ready"


def test_without_a_prepared_stand_the_gate_blocks_any_automatic_walk(tmp_path, monkeypatch):
    lib, music = _lib(tmp_path)
    lib.set_scan_gate(lambda: "Live-Fenster: Test")
    walks = _count_walks(monkeypatch, lib)
    assert lib.tree_signature() is None                     # Vorfilter laeuft nie selbst
    assert lib.library() == [] and lib.track("metal_a") is None
    assert lib.catalog_state() == "not_loaded" and walks == []
    assert lib.scan() is not None and walks == [str(music)]  # bewusster Lauf bleibt moeglich
    assert lib.catalog_state() == "ready" and len(lib.library()) == 2
    lib.set_scan_gate(lambda: None)
    fresh = jb.Jukebox(tmp_path / "rt2", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    fresh.set_config(library_dir=str(music))
    fresh.set_scan_gate(lambda: None)
    assert len(fresh.library()) == 2                        # offenes Tor: erster Zugriff laeuft


def test_watch_loop_in_the_gate_without_a_stand_scans_nothing_and_says_so(tmp_path, monkeypatch, caplog):
    import logging
    monkeypatch.setattr(ds, "_JUKEBOX_WATCH_SEC", 0)
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    svc.set_library_scan_gate(lambda: "Live-Fenster: Test")
    lib = svc.jukebox()
    music = tmp_path / "music"
    (music / "metal").mkdir(parents=True)
    (music / "metal" / "A.wav").write_bytes(b"RIFF")
    lib.set_config(library_dir=str(music), deck_id="main")
    walks = _count_walks(monkeypatch, lib)
    ticks = []
    orig_tree = lib.tree_signature

    def counted_tree():
        ticks.append(1)
        if len(ticks) >= 3:
            svc._stop.set()
        return orig_tree()
    monkeypatch.setattr(lib, "tree_signature", counted_tree)
    populates = []
    svc.register_library("jukebox", svc.jukebox, lambda deck_id="": populates.append(1) or {}, fallback_label="Jukebox")
    svc._stop.clear()
    with caplog.at_level(logging.WARNING, logger="deckcore.service"):
        asyncio.run(asyncio.wait_for(svc._library_watch_loop("jukebox"), 5))
    assert walks == [] and populates == []
    assert "kein vorbereiteter Stand" in caplog.text
    assert svc._buttons == [] or all(not b.get("_jukebox_track") for b in svc._buttons)


def test_deck_view_newest_favorites_shows_only_recent_and_starred(tmp_path):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    lib = svc.jukebox()
    music = tmp_path / "music" / "metal"
    music.mkdir(parents=True)
    for name, stamp in (("A.wav", 100), ("B.wav", 200), ("C.wav", 300)):
        p = music / name
        p.write_bytes(b"RIFF")
        os.utime(p, (stamp, stamp))
    lib.set_config(library_dir=str(music.parent), recent_section=1, deck_view="newest_favorites")
    lib.update_track_meta("metal_a", {"favorite": True})
    svc.populate_jukebox("main")
    ids = sorted(b["id"] for b in svc._buttons if b["id"].startswith("jb_"))
    # Neueste = juengster Neuzugang (Dateigeburt, nicht mtime): genau EINE Neueste-Taste.
    assert [i for i in ids if not i.startswith("jb_new_")] == ["jb_fav_metal_a", "jb_random_metal", "jb_stop", "jb_view_all"], ids
    assert len([i for i in ids if i.startswith("jb_new_")]) == 1, ids
    entry = {"prefix": "jb_", "meta_prefix": "_jukebox"}
    assert not svc._library_needs_sync(lib, entry), "Deck-Sicht und Pool stimmen ueberein"
    lib.set_config(deck_view="all")
    assert svc._library_needs_sync(lib, entry)
    svc.populate_jukebox("main")
    assert {"jb_metal_a", "jb_metal_b", "jb_metal_c"} <= {b["id"] for b in svc._buttons}


def _by_style_setup(tmp_path):
    """Sechs Stile, Dateien in Geburtsreihenfolge: ansagen_g (aeltester Festbestand), rock_f,
    metal_a/b/c, dj_d, musical_e (juengste). ``recent_section=2`` -> Neueste = musical_e, dj_d;
    Favorit = metal_a; ``ansagen`` ist aus „Neueste" ausgenommen (Festbestand)."""
    import time
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": ["Fremd"], "items": []}]
    svc.register_library("jukebox", svc.jukebox, svc.populate_jukebox,
                         action_type="jukebox", monitor_type="jukebox_state")
    lib = svc.jukebox()
    music = tmp_path / "music"
    for style, name in (("ansagen", "G"), ("rock", "F"), ("metal", "A"), ("metal", "B"),
                        ("metal", "C"), ("dj", "D"), ("musical", "E")):
        (music / style).mkdir(parents=True, exist_ok=True)
        (music / style / f"{name}.wav").write_bytes(b"RIFF")
        time.sleep(0.02)
    lib.set_config(library_dir=str(music), deck_id="main", recent_section=2,
                   recent_exclude_styles=["ansagen"], deck_view="newest_by_style")
    lib.update_track_meta("metal_a", {"favorite": True})
    return svc, lib


def _jb_ids(svc) -> set:
    return {b["id"] for b in svc._buttons if b["id"].startswith("jb_")}


def test_deck_view_newest_by_style_sorts_recent_and_starred_into_their_categories(tmp_path):
    svc, lib = _by_style_setup(tmp_path)
    svc.populate_jukebox("main")
    ids = _jb_ids(svc)
    # Treffer in ihrer Kategorie: Favorit metal_a, Neueste dj_d + musical_e; Festbestand ansagen.
    assert {"jb_metal_a", "jb_random_metal", "jb_dj_d", "jb_random_dj", "jb_musical_e",
            "jb_random_musical", "jb_ansagen_g", "jb_random_ansagen", "jb_stop", "jb_view_all",
            "jb_fav_metal_a", "jb_new_dj_d", "jb_new_musical_e"} <= ids, sorted(ids)
    # Keine alten Titel, keine Kategorie ohne Treffer (rock faellt samt Wuerfel weg).
    assert not {"jb_metal_b", "jb_metal_c", "jb_rock_f", "jb_random_rock", "jb_new_ansagen_g"} & ids, sorted(ids)
    deck = svc._deck("main")
    assert "rock" not in deck["categories"] and "Fremd" in deck["categories"], deck["categories"]
    assert {"metal", "dj", "musical", "ansagen"} <= set(deck["categories"]), deck["categories"]
    tb = next(it for it in deck["items"] if it["button"] == "jb_view_all")
    assert tb["style"]["placement"] == "toolbar"
    entry = {"prefix": "jb_", "meta_prefix": "_jukebox"}
    assert not svc._library_needs_sync(lib, entry), "Deck-Sicht und Pool stimmen ueberein"


def test_view_all_button_loads_everything_and_switches_back_without_persisting(tmp_path):
    svc, lib = _by_style_setup(tmp_path)
    svc.populate_jukebox("main")
    btn = next(b for b in svc._buttons if b["id"] == "jb_view_all")
    assert svc._eval_monitor(btn) == "newest_by_style"
    res = svc._press("jb_view_all")
    assert res["success"], res
    ids = _jb_ids(svc)
    assert {"jb_metal_b", "jb_metal_c", "jb_rock_f", "jb_random_rock", "jb_view_all"} <= ids, sorted(ids)
    assert "rock" in svc._deck("main")["categories"]
    assert svc._eval_monitor(btn) == "all"
    entry = {"prefix": "jb_", "meta_prefix": "_jukebox"}
    assert not svc._library_needs_sync(lib, entry), "auch in der Alles-Sicht stimmen Pool und Deck"
    res = svc._press("jb_view_all")
    assert res["success"], res
    ids = _jb_ids(svc)
    assert not {"jb_metal_b", "jb_metal_c", "jb_rock_f", "jb_random_rock"} & ids, sorted(ids)
    assert "rock" not in svc._deck("main")["categories"]
    assert svc._eval_monitor(btn) == "newest_by_style"
    assert not svc._library_view_override, "Umschaltung gilt nur bis zum naechsten Klick"
    # Die Config bleibt die Wahrheit: nichts geschrieben.
    assert lib.config().get("deck_view") == "newest_by_style"


def test_view_all_button_only_exists_for_a_filtered_config_view(tmp_path):
    svc, lib = _by_style_setup(tmp_path)
    lib.set_config(deck_view="all")
    svc.populate_jukebox("main")
    ids = _jb_ids(svc)
    assert "jb_view_all" not in ids and {"jb_metal_b", "jb_rock_f"} <= ids, sorted(ids)
    res = svc._press("jb_stop")   # unveraendert erreichbar
    assert "success" in res
