"""Langer Druck: zweite Aktion je Taste (docs/deck_long_press/DESIGN.md im Haupt-Repo)."""
import json

from deckcore import service as core
from deckcore.service import DeckCoreService


class Bus:
    def publish(self, *a, **k):
        pass


def _svc(tmp_path):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    calls = []
    svc.register_action("probe", lambda a, b: (calls.append(a.get("tag")), {"success": True, "message": a.get("tag")})[1])
    svc._buttons = [
        {"id": "both", "action": {"type": "probe", "tag": "kurz"}, "long_action": {"type": "probe", "tag": "lang"}},
        {"id": "only", "action": {"type": "probe", "tag": "kurz"}},
    ]
    svc._decks = [{"id": "main", "label": "Main", "layout": {}, "categories": [], "items": []}]
    return svc, calls


def test_short_and_long_run_their_own_action(tmp_path):
    svc, calls = _svc(tmp_path)
    assert svc.press("both")["variant"] == "short"
    res = svc.press("both", "long")
    assert res == {"id": "both", "success": True, "message": "lang", "variant": "long"}
    assert calls == ["kurz", "lang"]


def test_long_without_long_action_is_rejected_never_falls_back(tmp_path):
    svc, calls = _svc(tmp_path)
    res = svc.press("only", "long")
    assert res["success"] is False and "langen Druck" in res["message"]
    assert calls == []                                    # kurze Aktion NICHT ausgeloest (Codex R1 F03)
    svc._buttons[0]["long_action"] = {"type": "none"}
    assert svc.press("both", "long")["success"] is False


def test_unknown_variant_is_rejected(tmp_path):
    svc, calls = _svc(tmp_path)
    assert svc.press("both", "double")["success"] is False
    assert calls == []


def test_resolved_reports_has_long_and_threshold(tmp_path):
    svc, _ = _svc(tmp_path)
    r = svc._resolve(svc._buttons[0], None)
    assert r["has_long"] is True and r["long_press_ms"] == 600
    assert "has_long" not in svc._resolve(svc._buttons[1], None)
    svc._buttons[0]["long_press_ms"] = 99999
    assert svc._resolve(svc._buttons[0], None)["long_press_ms"] == 3000
    svc._buttons[0].pop("long_press_ms")
    svc._look = core._sanitize_look({**svc._look, "longPressMs": 900})
    assert svc._resolve(svc._buttons[0], None)["long_press_ms"] == 900
    # auch im Zustands-Zweig
    svc._buttons[0]["states"] = [{"when": {"op": "any"}, "title": "x"}]
    assert svc._resolve(svc._buttons[0], None)["has_long"] is True


def test_look_threshold_is_global_only():
    assert core._sanitize_look({"longPressMs": "abc"})["longPressMs"] == 600
    assert core._sanitize_look({"longPressMs": 10})["longPressMs"] == 250
    assert "longPressMs" not in core._look_overrides({"longPressMs": 900})   # keine Schwelle je Deck


def test_long_action_survives_upsert_save_and_load(tmp_path):
    svc, _ = _svc(tmp_path)
    svc.upsert_button({"id": "x", "action": {"type": "none"}, "long_action": {"type": "probe", "tag": "l"},
                       "long_press_ms": 800})
    again = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    b = next(b for b in again._buttons if b["id"] == "x")
    assert b["long_action"] == {"type": "probe", "tag": "l"} and b["long_press_ms"] == 800


def test_dead_long_open_deck_drops_only_the_long_branch(tmp_path):
    svc, _ = _svc(tmp_path)
    svc._buttons.append({"id": "opener", "action": {"type": "probe", "tag": "k"},
                         "long_action": {"type": "open_deck", "deck": "weg"}})
    assert svc._prune_dangling_openers() == 0
    b = next(b for b in svc._buttons if b["id"] == "opener")
    assert "long_action" not in b and b["action"]["type"] == "probe"


def test_both_action_trees_count_for_import_and_integrations(tmp_path):
    only_long = [{"id": "a", "action": {"type": "none"}, "long_action": {"type": "http", "url": "x"}}]
    nested = [{"id": "b", "action": {"type": "multi", "steps": [{"type": "launch", "path": "x"}]}}]
    assert core._count_executable(only_long) == 1
    assert core._count_executable(nested) == 1
    assert core._button_action_types({"action": {"type": "multi", "steps": [{"type": "obs"}]},
                                      "long_action": {"type": "hotkey"}}) == {"multi", "obs", "hotkey"}


def test_export_import_round_trip_keeps_long_action_and_threshold(tmp_path):
    svc, _ = _svc(tmp_path)
    svc._look = core._sanitize_look({**svc._look, "longPressMs": 700})
    exported = json.loads(json.dumps(svc.export_state()))
    other, _ = _svc(tmp_path / "other")
    other.import_state(exported)
    assert next(b for b in other._buttons if b["id"] == "both")["long_action"]["tag"] == "lang"
    assert other._look["longPressMs"] == 700
    svc._save()
    raw = json.loads((tmp_path / "rt" / "streamdeck_buttons.json").read_text(encoding="utf-8"))
    assert next(b for b in raw["buttons"] if b["id"] == "both")["long_action"]["tag"] == "lang"


def test_state_map_button_keeps_its_short_dispatch_and_button_context(tmp_path):
    """Bestehende Status-Taste (state_map, Monitor): kurz geht unveraendert an ihren Handler mit
    derselben Taste; lang erreicht nur die lange Aktion (Codex R2)."""
    svc, calls = _svc(tmp_path)
    seen = []
    svc.register_action("stateful", lambda a, b: (seen.append((a.get("mode"), b.get("id"), (b.get("monitor") or {}).get("type"))),
                                                   {"success": True})[1])
    svc._buttons.append({"id": "hold_toggle", "monitor": {"type": "file_field", "field": "phase"},
                         "action": {"type": "stateful", "mode": "state_map", "map": {"*": "go"}},
                         "long_action": {"type": "probe", "tag": "lang"}})
    assert svc.press("hold_toggle")["success"] is True
    assert seen == [("state_map", "hold_toggle", "file_field")] and calls == []
    assert svc.press("hold_toggle", "long")["success"] is True
    assert seen == [("state_map", "hold_toggle", "file_field")] and calls == ["lang"]


def test_faders_are_excluded_from_long_press(tmp_path):
    """Richard 26.09.: Fader haben Tippen = Mute und Halten+Ziehen = Pegel — kein langer Druck.
    Eine gespeicherte long_action bleibt erhalten (Editor zeigt den Konflikt), wirkt aber nicht."""
    svc, calls = _svc(tmp_path)
    svc._buttons.append({"id": "fad", "render": "fader", "action": {"type": "probe", "tag": "kurz"},
                         "long_action": {"type": "probe", "tag": "lang"}, "long_press_ms": 800})
    fad = svc._buttons[-1]
    assert "has_long" not in svc._resolve(fad, None)            # Panel und Elgato halten gar nicht erst
    res = svc.press("fad", "long")
    assert res["success"] is False and "Fader" in res["message"] and calls == []
    assert fad["long_action"] == {"type": "probe", "tag": "lang"}   # nicht still verloren
    assert svc.press("fad")["success"] is True and calls == ["kurz"]
