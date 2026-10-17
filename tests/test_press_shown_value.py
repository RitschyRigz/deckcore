"""Druck an den ANGEZEIGTEN Wert gebunden (Wunschsong 2026-10-17, Codex R11 F19).

Vertrag: der Client schickt beim Druck den Monitor-Wert mit, den er gerade zeigt (``shown``). Eine
http-Aktion mit ``bind_shown`` setzt ihn als ``{shown}`` in URL und Koerper ein; fehlt er, wird
NICHTS ausgeloest (nie auf den aktuellen Zustand ausweichen). Aktionen ohne ``bind_shown`` bleiben
unveraendert. ``monitor.label_path`` liefert eine zweite Anzeigezeile ``{label}``.
"""
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from deckcore import service as core
from deckcore.api import build_streamdeck_router
from deckcore.service import DeckCoreService


class Bus:
    def publish(self, *a, **k):
        pass


class Sent:
    def __init__(self):
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append((req.full_url, req.data.decode() if req.data else None))
        return self

    def __enter__(self):
        self.status = 200
        return self

    def __exit__(self, *a):
        return False


def _svc(tmp_path, monkeypatch):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    sent = Sent()
    monkeypatch.setattr(core.urllib.request, "urlopen", sent)
    svc._buttons = [
        {"id": "bound", "action": {"type": "http", "method": "POST", "bind_shown": True,
                                   "url": "http://127.0.0.1:7907/api/wishes/shown/accept",
                                   "body": {"token": "t", "shown": "{shown}"}}},
        {"id": "plain", "action": {"type": "http", "method": "POST", "url": "http://127.0.0.1:1/api/x",
                                   "body": {"token": "t", "shown": "{shown}"}}},
    ]
    return svc, sent


def _client(svc):
    app = FastAPI()
    app.include_router(build_streamdeck_router(lambda request: svc))
    return TestClient(app)


def test_a_bound_action_carries_exactly_the_displayed_value(tmp_path, monkeypatch):
    svc, sent = _svc(tmp_path, monkeypatch)
    res = _client(svc).post("/api/streamdeck/press/bound", json={"src": "panel", "shown": "w-0123456789abcdef"}).json()
    assert res["success"] is True
    url, body = sent.requests[-1]
    assert json.loads(body) == {"token": "t", "shown": "w-0123456789abcdef"}


def test_a_bound_action_without_a_displayed_value_triggers_nothing(tmp_path, monkeypatch):
    svc, sent = _svc(tmp_path, monkeypatch)
    c = _client(svc)
    for payload in ({"src": "panel"}, None):                      # altes Panel / Elgato ohne Koerper
        res = (c.post("/api/streamdeck/press/bound", json=payload) if payload else
               c.post("/api/streamdeck/press/bound")).json()
        assert res["success"] is False and "Anzeigewert" in res["message"]
    assert sent.requests == []


def test_actions_without_bind_shown_are_unchanged(tmp_path, monkeypatch):
    svc, sent = _svc(tmp_path, monkeypatch)
    assert _client(svc).post("/api/streamdeck/press/plain", json={"shown": "egal"}).json()["success"] is True
    assert json.loads(sent.requests[-1][1]) == {"token": "t", "shown": "{shown}"}, "kein Ersetzen ohne Zustimmung"


def test_the_displayed_value_never_leaks_into_the_next_press(tmp_path, monkeypatch):
    svc, sent = _svc(tmp_path, monkeypatch)
    svc.press("bound", "short", "panel", "w-aaaaaaaaaaaaaaaa")
    assert svc.press("bound", "short", "panel")["success"] is False, "threadlokal, nur fuer diesen Druck"
    assert len(sent.requests) == 1


def test_label_path_gives_a_second_display_line(tmp_path, monkeypatch):
    svc, _ = _svc(tmp_path, monkeypatch)

    class Poll:
        def __init__(self, req, timeout=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"deck_value": "w-0123456789abcdef", "deck_label": "Wunsch von Sentavius"}).encode()
    monkeypatch.setattr(core.urllib.request, "urlopen", Poll)
    btn = {"id": "wish", "monitor": {"type": "poll", "url": "http://127.0.0.1/x", "path": "deck_value",
                                     "label_path": "deck_label", "interval": 2},
           "states": [{"when": {"op": "contains", "value": "w-"}, "title": "annehmen\n{label}"}],
           "default": {"title": "Kein Wunsch"}}
    value = svc._poll_value("wish", btn["monitor"])
    resolved = svc._resolve(btn, value)
    assert value == "w-0123456789abcdef" and resolved["title"] == "annehmen\nWunsch von Sentavius"
    assert resolved["value"] == "w-0123456789abcdef", "der Client kennt die Kennung, die er zeigt"
