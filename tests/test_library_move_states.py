"""Umzug eines Mediathek-Tracks zieht ALLE Verweise der Taste mit (23.10.2026): Kurz-/Langdruck,
Monitor und die Zustandsregeln ``<zustand>:<track>`` — sonst leuchtet die Taste beim Abspielen
nie. Schon frueher umgezogene Tasten werden beim Start ueber die Alias-Karte repariert."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402
from deckcore.service import DeckCoreService  # noqa: E402

OLD = "musical_2026_10_23_ein_gruselsong"
NEW = "spooky_2026_10_23_ein_gruselsong"


class Bus:
    def publish(self, *a, **k):
        pass


def _setup(tmp_path: Path):
    music = tmp_path / "music"
    for d in ("musical", "spooky"):
        (music / d).mkdir(parents=True)
    (music / "musical" / "2026-10-23 - Ein Gruselsong.wav").write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music))
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    svc.register_library("jukebox", lambda: lib, lambda deck: svc.populate_library(lib, deck, group="Jukebox"),
                         prefix="jb_", meta_prefix="_jukebox")
    assert svc.populate_library(lib, "main", group="Jukebox")["ok"]
    return lib, svc


def _refs(btn: dict) -> set[str]:
    vals = {str((st.get("when") or {}).get("value") or "") for st in btn.get("states") or []}
    tracks = {str((btn.get(p) or {}).get("track") or "") for p in ("action", "long_action", "monitor")}
    return {v.split(":", 1)[1] for v in vals if ":" in v} | (tracks - {""})


def test_move_retargets_states_and_long_press(tmp_path):
    lib, svc = _setup(tmp_path)
    res = svc.rename_library_track("jukebox", OLD, NEW, mutate=lambda: lib.move_track(OLD, "spooky"))
    assert res["ok"] and res["buttons_renamed"] == 1
    btn = next(b for b in svc._buttons if b["id"] == "jb_" + NEW)
    assert _refs(btn) == {NEW}, "jeder Verweis zeigt auf die neue Kennung, auch playing:/paused:"
    assert not any(b["id"] == "jb_" + OLD for b in svc._buttons)


def test_already_moved_button_is_repaired_once_via_alias(tmp_path):
    lib, svc = _setup(tmp_path)
    assert lib.move_track(OLD, "spooky")["ok"]
    # Zustand wie vor dem Fix: Id/Aktion umbenannt, Zustandsregeln + Langdruck noch alt.
    btn = next(b for b in svc._buttons if b["id"] == "jb_" + OLD)
    btn["id"], btn["_jukebox_track"] = "jb_" + NEW, NEW
    btn["action"]["track"] = btn["monitor"]["track"] = NEW
    assert OLD in _refs(btn)
    assert svc._repair_library_aliases() == 1
    assert _refs(btn) == {NEW}
    assert svc._repair_library_aliases() == 0, "zweiter Lauf aendert nichts"
