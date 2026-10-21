"""Pegel per HTTP (level_http): generischer Fader, der seinen Stand aus einer URL liest und ueber den
Deck-Proxy schreibt. Vertrag: Rohwert [min,max] <-> Fader-Prozent [0,100] linear; Monitor-Zustand
{available,value,raw,target,label,editable}; Proxy POSTet {set_field: Wert, target_field: Ziel} an
die set_url aus den Daten; Tippen = normale Aktion mit dem angezeigten Ziel als ``shown``."""
import json
import urllib.error

from fastapi import FastAPI
from fastapi.testclient import TestClient

from deckcore import service as core
from deckcore.api import build_streamdeck_router
from deckcore.service import DeckCoreService

GET = "http://127.0.0.1:9/api/level"
SET = "http://127.0.0.1:9/api/level/set"


class Bus:
    def publish(self, *a, **k):
        pass


class Host:
    """urlopen-Attrappe: GET liefert ``state``, POST merkt sich den Koerper und antwortet ``reply``."""

    def __init__(self, state=None, reply=None, fail=None):
        self.state = state if state is not None else {"value": 60, "target": "song-1", "label": "Live 60%", "editable": True}
        self.reply = reply if reply is not None else {"ok": True, "value": 30}
        self.fail = fail
        self.posts = []
        self.gets = 0

    def __call__(self, req, timeout=None):
        if self.fail is not None:
            raise self.fail
        if req.get_method() == "POST":
            self.posts.append((req.full_url, json.loads(req.data.decode())))
            return _Resp(self.reply)
        self.gets += 1
        return _Resp(self.state)


class _Resp:
    status = 200

    def __init__(self, obj):
        self._b = json.dumps(obj).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


def _mon(**over):
    m = {"type": "level_http", "get_url": GET, "value_path": "value", "target_path": "target",
         "label_path": "label", "editable_path": "editable", "set_url": SET, "set_field": "value",
         "target_field": "target", "min": 0, "max": 100, "interval": 1}
    m.update(over)
    return m


def _svc(tmp_path, monkeypatch, host, **mon):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    monkeypatch.setattr(core.urllib.request, "urlopen", host)
    svc._buttons = [
        {"id": "lvl", "render": "fader", "monitor": _mon(**mon),
         "meter": {"type": "wavelink", "id": "PCM_IN"},
         "action": {"type": "http", "method": "POST", "url": "http://127.0.0.1:9/api/pause",
                    "body": {"target": "{shown}"}, "bind_shown": True}},
        {"id": "plain", "monitor": {"type": "poll", "url": GET}, "action": {"type": "none"}},
    ]
    return svc


def _client(svc):
    app = FastAPI()
    app.include_router(build_streamdeck_router(lambda request: svc))
    return TestClient(app)


def test_mapping_both_directions_and_inverted_scale():
    assert core._level_to_pct(-20, -40, 0) == 50
    assert core._level_to_pct(-50, -40, 0) == 0 and core._level_to_pct(10, -40, 0) == 100   # geklemmt
    assert core._pct_to_level(50, -40, 0) == -20
    assert core._pct_to_level(150, -40, 0) == 0                                               # geklemmt
    assert core._level_to_pct(25, 100, 0) == 75 and core._pct_to_level(75, 100, 0) == 25     # min > max
    assert core._pct_to_level(33, 0, 1, integer=False) == 0.33
    assert core._level_to_pct("x", 0, 100) is None and core._level_to_pct(True, 0, 100) is None


def test_monitor_state_fields(tmp_path, monkeypatch):
    host = Host(state={"value": 120, "target": "song-1", "label": "Live 60%"})
    svc = _svc(tmp_path, monkeypatch, host, min=0, max=200)
    st = svc._eval_monitor(svc._buttons[0])
    assert st == {"available": True, "value": 60, "raw": 120, "target": "song-1",
                  "label": "Live 60%", "editable": True}, "editable fehlt + Wert da → bedienbar"
    resolved = svc._resolve({**svc._buttons[0], "default": {"title": "{value}% {label}"}}, st)
    assert resolved["value"]["target"] == "song-1" and resolved["title"] == "60% Live 60%"
    host.state = {"value": 10, "target": "", "editable": False}
    svc._poll_cache.clear()
    st = svc._eval_monitor(svc._buttons[0])
    assert st["editable"] is False and st["target"] == "" and st["label"] == ""


def test_unavailable_get_url_never_raises(tmp_path, monkeypatch):
    svc = _svc(tmp_path, monkeypatch, Host(fail=urllib.error.URLError("weg")))
    st = svc._eval_monitor(svc._buttons[0])
    assert st["available"] is False and st["value"] is None and st["editable"] is False
    svc2 = _svc(tmp_path, monkeypatch, Host(state={"nothing": 1}))
    assert svc2._eval_monitor(svc2._buttons[0])["available"] is False


def test_proxy_maps_and_posts_to_set_url(tmp_path, monkeypatch):
    host = Host(reply={"ok": True, "value": -20, "extra": "x"})
    svc = _svc(tmp_path, monkeypatch, host, min=-40, max=0)
    res = _client(svc).post("/api/streamdeck/level_http/lvl", json={"value": 50, "target": "song-1"}).json()
    assert host.posts == [(SET, {"value": -20, "target": "song-1"})]
    assert res == {"ok": True, "value": -20, "extra": "x", "fader_value": 50,
                   "fader_target": "", "fader_label": ""}, "Host-Antwort unveraendert + Prozent/Ziel/Zeile"
    assert host.gets >= 1, "Monitor-Cache sofort frisch gelesen"


def test_proxy_passes_host_rejection_through(tmp_path, monkeypatch):
    host = Host(reply={"ok": False, "reason": "target_changed"})
    svc = _svc(tmp_path, monkeypatch, host)
    res = _client(svc).post("/api/streamdeck/level_http/lvl", json={"value": 10, "target": "alt"}).json()
    assert res == {"ok": False, "reason": "target_changed"}


def test_proxy_http_error_status_keeps_host_json(tmp_path, monkeypatch):
    import io
    err = urllib.error.HTTPError(SET, 409, "Conflict", {}, io.BytesIO(b'{"reason": "target_changed"}'))

    class Reject(Host):
        def __call__(self, req, timeout=None):
            if req.get_method() == "POST":
                self.posts.append(req.full_url)
                raise err
            return super().__call__(req, timeout)
    svc = _svc(tmp_path, monkeypatch, Reject())
    res = _client(svc).post("/api/streamdeck/level_http/lvl", json={"value": 10, "target": "alt"}).json()
    assert res == {"reason": "target_changed", "ok": False}


def test_proxy_errors_send_nothing(tmp_path, monkeypatch):
    host = Host()
    svc = _svc(tmp_path, monkeypatch, host)
    c = _client(svc)
    r = c.post("/api/streamdeck/level_http/nope", json={"value": 10})
    assert r.status_code == 404 and r.json()["reason"] == "unknown_button"
    r = c.post("/api/streamdeck/level_http/plain", json={"value": 10})
    assert r.status_code == 400 and r.json()["reason"] == "not_level_http"
    r = c.post("/api/streamdeck/level_http/lvl", json={"value": "viel"})
    assert r.status_code == 400 and r.json()["reason"] == "bad_value"
    svc._buttons[0]["monitor"].pop("set_url")
    r = c.post("/api/streamdeck/level_http/lvl", json={"value": 10})
    assert r.status_code == 400 and r.json()["reason"] == "no_set_url"
    assert host.posts == []


def test_tap_runs_the_buttons_action_with_the_shown_target(tmp_path, monkeypatch):
    host = Host()
    svc = _svc(tmp_path, monkeypatch, host)
    res = _client(svc).post("/api/streamdeck/press/lvl", json={"src": "panel", "shown": "song-1"}).json()
    assert res["success"] is True
    assert host.posts[-1] == ("http://127.0.0.1:9/api/pause", {"target": "song-1"})


class _JB:
    def __init__(self, state):
        self.state, self.calls = state, []

    def status(self):
        return {"state": self.state}

    def pause(self, flag=True):
        self.calls.append(flag)
        return {"ok": True}


def test_jukebox_pause_toggles(tmp_path, monkeypatch):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    jb = _JB("playing")
    monkeypatch.setattr(svc, "jukebox", lambda: jb)
    assert svc._act_jukebox({"mode": "pause"}, {}) == {"success": True, "message": "Pausiert"}
    jb.state = "paused"
    assert svc._act_jukebox({"mode": "pause"}, {}) == {"success": True, "message": "Weiter"}
    assert jb.calls == [True, False]


def test_proxy_reports_target_and_label_of_the_confirmed_answer(tmp_path, monkeypatch):
    """Codex R7 F19: die bestaetigte Anzeige gehoert zu einem Ziel — ueber die Pfade der Taste."""
    host = Host(reply={"ok": True, "value": 15, "target": "song:r2:duck", "label": "Duck · 15%"})
    svc = _svc(tmp_path, monkeypatch, host)
    res = _client(svc).post("/api/streamdeck/level_http/lvl", json={"value": 80, "target": "song:r2:duck"}).json()
    assert res["fader_value"] == 15 and res["fader_target"] == "song:r2:duck" and res["fader_label"] == "Duck · 15%"
