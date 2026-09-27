"""Diagnose des Tastendrucks (Fixrunde 26.09. F01): eine Log-Zeile je press(), gedrosselte
Client-Telemetrie der Geste und die Bewegungstoleranz des langen Drucks als Look-Einstellung."""
import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from deckcore import service as core
from deckcore.api import build_streamdeck_router
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
    return svc, calls


def _lines(caplog, prefix):
    return [r.getMessage() for r in caplog.records if r.name == "deckcore" and r.getMessage().startswith(prefix)]


def test_every_press_writes_one_log_line_including_rejections(tmp_path, caplog):
    svc, _ = _svc(tmp_path)
    caplog.set_level(logging.INFO, logger="deckcore")
    svc.press("both", "long", "panel")
    svc.press("only", "long", "panel")            # abgelehnt: keine long_action
    svc.press("both", "double")                   # abgelehnt: unbekannte Variante
    with pytest.raises(KeyError):
        svc.press("weg", "long", "panel")
    lines = _lines(caplog, "deck press ")
    assert len(lines) == 4
    assert "bid=both variant=long src=panel success=True" in lines[0] and "msg=lang" in lines[0]
    assert "bid=only variant=long src=panel success=False" in lines[1] and "langen Druck" in lines[1]
    assert "bid=both variant=double src=- success=False" in lines[2]
    assert "bid=weg variant=long src=panel success=False" in lines[3] and "Unbekannter Button" in lines[3]


def test_press_result_contract_is_unchanged(tmp_path):
    svc, calls = _svc(tmp_path)
    assert svc.press("both", "long", "panel") == {"id": "both", "success": True, "message": "lang", "variant": "long"}
    assert calls == ["lang"]


def test_press_source_is_sanitized(tmp_path, caplog):
    svc, _ = _svc(tmp_path)
    caplog.set_level(logging.INFO, logger="deckcore")
    svc.press("both", "short", "Panel<script>\nX" * 5)
    line = _lines(caplog, "deck press ")[0]
    assert "<" not in line and "\n" not in line
    assert "src=panelscriptxpane " in line         # nur [a-z0-9_-], max. 16 Zeichen


def test_client_event_logs_whitelisted_fields_only(tmp_path, caplog):
    svc, _ = _svc(tmp_path)
    caplog.set_level(logging.INFO, logger="deckcore")
    body = {"bid": "raid_top_123", "event": "abort", "reason": "move", "variant": "long", "pointer": "touch",
            "dx": 21.4, "dy": -3, "held_ms": 240, "slop": 16, "threshold_ms": 600,
            "name": "Richard", "ua": "Mozilla/5.0"}
    assert svc.client_event(json.dumps(body).encode()) == {"ok": True}
    line = _lines(caplog, "deck client_event ")[0]
    assert line == ("deck client_event bid=raid_top_123 event=abort reason=move variant=long pointer=touch "
                    "dx=21 dy=-3 held_ms=240 slop=16 threshold_ms=600")
    assert "Richard" not in line and "Mozilla" not in line


def test_client_event_rejects_unknown_event_bad_json_and_oversize(tmp_path, caplog):
    svc, _ = _svc(tmp_path)
    caplog.set_level(logging.INFO, logger="deckcore")
    assert svc.client_event(b'{"event":"hack"}')["ok"] is False
    assert svc.client_event(b"not json")["ok"] is False
    assert svc.client_event(b"[1,2]")["ok"] is False
    big = json.dumps({"event": "abort", "pad": "x" * core._CLIENT_EVENT_MAX_BYTES}).encode()
    assert svc.client_event(big) == {"ok": False, "reason": "zu gross"}
    assert _lines(caplog, "deck client_event ") == []
    svc.client_event(b'{"event":"abort","reason":"freitext mit namen","bid":"a b/c"}')
    assert _lines(caplog, "deck client_event ")[0] == "deck client_event bid=abc event=abort reason=other"


def test_client_event_is_throttled_and_reports_drops(tmp_path, caplog, monkeypatch):
    svc, _ = _svc(tmp_path)
    caplog.set_level(logging.INFO, logger="deckcore")
    now = [1000.0]
    monkeypatch.setattr(core.time, "monotonic", lambda: now[0])
    ev = b'{"event":"abort","reason":"cancel","bid":"k"}'
    results = [svc.client_event(ev)["ok"] for _ in range(core._CLIENT_EVENT_MAX_PER_WINDOW + 3)]
    assert results.count(True) == core._CLIENT_EVENT_MAX_PER_WINDOW and results[-1] is False
    now[0] += core._CLIENT_EVENT_WINDOW_S + 0.1
    assert svc.client_event(ev)["ok"] is True
    last = _lines(caplog, "deck client_event ")[-1]
    assert last.endswith("dropped_before=3")


def test_slop_is_global_look_setting_and_reported_in_resolved(tmp_path):
    svc, _ = _svc(tmp_path)
    assert core._sanitize_look({})["longPressSlopPx"] == 16
    assert core._sanitize_look({"longPressSlopPx": 1})["longPressSlopPx"] == 4
    assert core._sanitize_look({"longPressSlopPx": 999})["longPressSlopPx"] == 64
    assert core._sanitize_look({"longPressSlopPx": "x"})["longPressSlopPx"] == 16
    assert "longPressSlopPx" not in core._look_overrides({"longPressSlopPx": 30})   # nicht je Deck
    assert svc._resolve(svc._buttons[0], None)["long_press_slop_px"] == 16
    svc.set_look({"longPressSlopPx": 24})
    assert svc._resolve(svc._buttons[0], None)["long_press_slop_px"] == 24
    assert "long_press_slop_px" not in svc._resolve(svc._buttons[1], None)   # nur Tasten mit langem Druck


def test_router_press_reads_source_from_body_and_accepts_no_body(tmp_path, caplog):
    svc, calls = _svc(tmp_path)
    app = FastAPI()
    app.include_router(build_streamdeck_router(lambda request: svc))
    c = TestClient(app)
    caplog.set_level(logging.INFO, logger="deckcore")
    assert c.post("/api/streamdeck/press/both?variant=long", json={"src": "panel"}).json()["variant"] == "long"
    assert c.post("/api/streamdeck/press/both").json()["success"] is True      # Elgato: ohne Körper
    assert c.post("/api/streamdeck/press/both", content=b"kaputt").json()["success"] is True
    assert calls == ["lang", "kurz", "kurz"]
    lines = _lines(caplog, "deck press ")
    assert "src=panel" in lines[0] and "src=-" in lines[1] and "src=-" in lines[2]


def test_router_client_event_route(tmp_path, caplog):
    svc, _ = _svc(tmp_path)
    app = FastAPI()
    app.include_router(build_streamdeck_router(lambda request: svc))
    c = TestClient(app)
    caplog.set_level(logging.INFO, logger="deckcore")
    assert c.post("/api/streamdeck/client_event", json={"event": "abort", "reason": "cancel", "bid": "both"}).json() == {"ok": True}
    big = b'{"event":"abort","pad":"' + b"x" * 5000 + b'"}'
    assert c.post("/api/streamdeck/client_event", content=big,
                  headers={"content-type": "application/json"}).json()["ok"] is False
    assert len(_lines(caplog, "deck client_event ")) == 1
