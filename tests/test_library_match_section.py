"""Sammel-Abschnitt „passend" der Mediathek-Maschine (Richard 21.10.2026): ``config.json →
match_section`` nennt einen Host-Matcher; ``populate_library`` legt die passenden Titel als
Zweittasten in einen Abschnitt GANZ VORN, neueste zuerst. Passt nichts, steht dort eine
Hinweis-Taste ohne Aktion. Wechselt der Wert des Hosts, aendert sich der Waechter-Fingerabdruck."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402
from deckcore.service import DeckCoreService  # noqa: E402

LABEL = "🎯 Recap passend"


class Bus:
    def publish(self, *a, **k):
        pass


def _lib(tmp_path: Path) -> jb.Jukebox:
    # Herkunftsdatum vorn im Namen; alle Dateien gleich alt abgelegt (wie eine Sammel-Kopie)
    files = {"recap": ["2026-10-01 Recap Alpha Tag 1.mp4", "2026-10-05 Recap Beta Tag 2.mp4",
                       "2026-10-12 Recap Alpha Tag 3.mp4"],
             "daily": ["2026-10-05 Daily Alpha Tag 2.mp4"]}
    stamp = 1_800_000_000
    for style, names in files.items():
        folder = tmp_path / "videos" / style
        folder.mkdir(parents=True)
        for name in names:
            f = folder / name
            f.write_bytes(b"x")
            os.utime(f, (stamp, stamp))
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {},
                     publish=None, subdir="videobox", media_exts=jb.VIDEO_EXTS)
    lib.set_config(library_dir=str(tmp_path / "videos"),
                   match_section={"match": "game", "label": LABEL, "empty_title": "Nichts passend"})
    return lib


def _svc(tmp_path: Path, value: dict) -> DeckCoreService:
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "videos", "label": "Videos", "layout": {}, "categories": ["Alt"], "items": []}]
    svc.register_library_matcher("game", lambda: {
        "value": value["now"],
        "key": lambda t: "Alpha" if "Alpha" in t["title"] else "Beta" if "Beta" in t["title"] else ""})
    return svc


def _populate(svc, lib):
    return svc.populate_library(lib, "videos", group="Video", prefix="vb_", action_type="videobox",
                                monitor_type="videobox_state", meta_prefix="_videobox")


def _section(svc) -> list[str]:
    deck = svc._decks[0]
    return [it["button"] for it in deck["items"] if it["category"] == LABEL]


def test_matching_titles_newest_first_in_the_first_section(tmp_path):
    lib, now = _lib(tmp_path), {"now": "alpha"}            # Gross-/Kleinschreibung egal
    svc = _svc(tmp_path, now)
    assert _populate(svc, lib)["ok"]
    dates = {t["id"]: t["source_date"] for t in lib.library()}
    section = _section(svc)
    assert [dates[b[len("vb_match_"):]] for b in section] == ["2026-10-12", "2026-10-05", "2026-10-01"]
    assert svc._decks[0]["categories"][0] == LABEL
    # Zweittaste: dieselbe Abspiel-Aktion wie die Track-Taste, der Track bleibt in seinem Stil
    tid = section[0][len("vb_match_"):]
    btn = next(b for b in svc._buttons if b["id"] == section[0])
    assert btn["action"] == {"type": "videobox", "mode": "toggle", "track": tid}
    assert any(b["id"] == "vb_" + tid for b in svc._buttons)


def test_no_match_leaves_a_visible_hint_and_follows_the_value(tmp_path):
    lib, now = _lib(tmp_path), {"now": "Gamma"}
    svc = _svc(tmp_path, now)
    _populate(svc, lib)
    assert _section(svc) == ["vb_match_none"]
    hint = next(b for b in svc._buttons if b["id"] == "vb_match_none")
    assert hint["action"] == {"type": "none"} and hint["default"]["title"] == "Nichts passend\nGamma"
    # Wert wechselt auf ein anderes, ebenfalls unpassendes Spiel: generierter Titel zieht nach
    now["now"] = "Delta"
    _populate(svc, lib)
    hint = next(b for b in svc._buttons if b["id"] == "vb_match_none")
    assert hint["default"]["title"] == "Nichts passend\nDelta"
    # … eine eigene Gestaltung der Hinweis-Taste bleibt dagegen erhalten
    hint["default"] = {"icon": "🙈", "title": "Mein Text", "color": "off"}
    now["now"] = "Epsilon"
    _populate(svc, lib)
    hint = next(b for b in svc._buttons if b["id"] == "vb_match_none")
    assert hint["default"]["title"] == "Mein Text"
    # Jetzt passt etwas: Hinweis weg, Treffer da
    now["now"] = "Beta"
    _populate(svc, lib)
    assert [b for b in _section(svc)] and "vb_match_none" not in _section(svc)
    assert not any(b["id"] == "vb_match_none" for b in svc._buttons)


def test_value_change_replaces_the_section_and_the_watch_signature(tmp_path):
    lib, now = _lib(tmp_path), {"now": "Alpha"}
    svc = _svc(tmp_path, now)
    _populate(svc, lib)
    sig_alpha = svc._library_match_sig(lib)
    assert len(_section(svc)) == 3
    now["now"] = "Beta"
    assert svc._library_match_sig(lib) != sig_alpha
    _populate(svc, lib)
    assert len(_section(svc)) == 1
    assert sum(1 for b in svc._buttons if b["id"].startswith("vb_match_")) == 1


def test_unknown_value_or_missing_matcher_shows_only_the_hint(tmp_path):
    lib = _lib(tmp_path)
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "deck", default_buttons=[])
    svc._decks = [{"id": "videos", "label": "Videos", "layout": {}, "categories": [], "items": []}]
    _populate(svc, lib)                                      # Matcher nie registriert
    assert _section(svc) == ["vb_match_none"]
    assert next(b for b in svc._buttons if b["id"] == "vb_match_none")["default"]["title"] == "Nichts passend"
    svc.register_library_matcher("game", lambda: None)       # Host kennt den Wert gerade nicht
    _populate(svc, lib)
    assert _section(svc) == ["vb_match_none"]
    svc.register_library_matcher("game", lambda: 1 / 0)      # scheiternder Matcher haelt nichts an
    assert _populate(svc, lib)["ok"] and _section(svc) == ["vb_match_none"]


def test_without_match_section_nothing_changes(tmp_path):
    lib = _lib(tmp_path)
    lib.set_config(match_section={})
    svc = _svc(tmp_path, {"now": "Alpha"})
    _populate(svc, lib)
    assert not any(b["id"].startswith("vb_match_") for b in svc._buttons)
    assert LABEL not in svc._decks[0]["categories"]
    assert svc._library_match_sig(lib) == ""
