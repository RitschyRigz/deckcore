"""replace_generated_page: generierte Seite als ein zusammenhaengender Stand."""
from deckcore.service import DeckCoreService


class Bus:
    def __init__(self):
        self.calls = 0

    def publish(self, *args, **kwargs):
        self.calls += 1


def _svc(tmp_path):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "runtime", default_buttons=[])
    svc._buttons = [{"id": "foreign", "label": "Fremd"}, {"id": "gp_old", "label": "Alt"}]
    svc._decks = [
        {"id": "page", "label": "Page", "folder": True, "layout": {}, "categories": ["Fremd", "Alt"],
         "items": [{"button": "foreign", "category": "Fremd", "style": {}, "hidden": False},
                   {"button": "gp_old", "category": "Alt", "style": {}, "hidden": False}]},
        {"id": "other", "label": "Other", "layout": {}, "categories": [],
         "items": [{"button": "gp_old", "category": "", "style": {}, "hidden": False, "x": 3, "y": 1}]},
    ]
    return svc


def _e(bid, cat, placement="grid"):
    return {"button": {"id": bid, "label": bid, "action": {"type": "none"}}, "category": cat,
            "placement": placement}


def test_replaces_generated_keeps_foreign_and_order(tmp_path):
    svc = _svc(tmp_path)
    saves = []
    svc._save = lambda: saves.append(1)
    res = svc.replace_generated_page("page", "gp_", [
        _e("gp_tool", "", "toolbar"), _e("gp_a_1", "A"), _e("gp_b_1", "B"), _e("gp_a_2", "A")],
        pool_cat="Gen", categories=["A", "B"])
    assert res == {"ok": True, "buttons": 4, "removed": 1, "deck": "page"}
    page = svc._deck("page")
    assert [it["button"] for it in page["items"]] == ["foreign", "gp_tool", "gp_a_1", "gp_b_1", "gp_a_2"]
    assert page["items"][0] == {"button": "foreign", "category": "Fremd", "style": {}, "hidden": False}
    assert page["items"][1]["style"] == {"placement": "toolbar", "label": "off"}
    assert page["categories"] == ["A", "B", "Fremd"]          # "Alt" hatte nur generierte Items
    ids = {b["id"] for b in svc._buttons}
    assert ids == {"foreign", "gp_tool", "gp_a_1", "gp_b_1", "gp_a_2"}
    assert all(b.get("pool_cat") == "Gen" for b in svc._buttons if b["id"].startswith("gp_"))
    # verschwundene generierte Taste: auch von anderen Decks weg, aber NICHT gemerkt
    assert svc._deck("other")["items"] == []
    assert "gp_old" not in svc._removed
    assert len(saves) == 1                                   # ein Stand, keine Zwischenstaende


def test_same_candidate_in_two_sections_needs_distinct_ids(tmp_path):
    svc = _svc(tmp_path)
    res = svc.replace_generated_page("page", "gp_", [_e("gp_x", "A"), _e("gp_x", "B")])
    assert res["ok"] is False and res["reason"].startswith("invalid_or_duplicate_id")
    assert {b["id"] for b in svc._buttons} == {"foreign", "gp_old"}   # nichts angefasst


def test_rejects_foreign_prefix_and_unknown_deck(tmp_path):
    svc = _svc(tmp_path)
    assert svc.replace_generated_page("page", "gp_", [_e("foreign", "A")])["ok"] is False
    assert svc.replace_generated_page("nope", "gp_", [])["reason"] == "unknown_deck"
    assert svc.replace_generated_page("page", "", [])["reason"] == "prefix_required"


def test_rerun_is_idempotent(tmp_path):
    svc = _svc(tmp_path)
    entries = [_e("gp_a_1", "A")]
    svc.replace_generated_page("page", "gp_", entries, categories=["A"])
    first = [dict(it) for it in svc._deck("page")["items"]]
    svc.replace_generated_page("page", "gp_", entries, categories=["A"])
    assert svc._deck("page")["items"] == first
    assert [b["id"] for b in svc._buttons].count("gp_a_1") == 1
