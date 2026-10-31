"""Ablehnungs-Pause fuer poll/level_http (Stream 30.10., F54): Lehnt ein Ziel den Verbindungsaufbau
ab (Dienst laeuft noch nicht), fragt der Takt dasselbe Ziel bis zum Ende der Pause nicht erneut an.
Unter Windows kostet jede Ablehnung auf 127.0.0.1 rund 2 s; zehn Tasten auf denselben Dienst hielten
den Takt sonst 20 s fest. Andere Ziele und andere Fehler bleiben unberuehrt."""
import json
import urllib.error

from deckcore import service as core
from deckcore.service import DeckCoreService

DOWN = "http://127.0.0.1:7907/api/deck/status"
DOWN_OTHER_PATH = "http://127.0.0.1:7907/api/deck/wish_status"
UP = "http://127.0.0.1:7883/api/health"


class Bus:
    def publish(self, *a, **k):
        pass


class _Resp:
    def __init__(self, obj):
        self._b = json.dumps(obj).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


class Net:
    """urlopen-Attrappe: Ziele in ``down`` lehnen ab, ``broken`` antwortet mit Fehler, sonst {ok: 1}."""

    def __init__(self, down=(), broken=()):
        self.down = set(down)
        self.broken = set(broken)
        self.calls = []

    def __call__(self, req, timeout=None):
        url = req.full_url
        self.calls.append(url)
        if any(url.startswith(d) for d in self.down):
            raise urllib.error.URLError(ConnectionRefusedError(10061, "refused"))
        if url in self.broken:
            raise urllib.error.HTTPError(url, 500, "boom", {}, None)
        return _Resp({"ok": 1})


def _svc(tmp_path, monkeypatch, net, urls):
    svc = DeckCoreService(Bus(), runtime_dir=tmp_path / "rt", default_buttons=[])
    monkeypatch.setattr(core.urllib.request, "urlopen", net)
    svc._buttons = [{"id": f"b{i}", "monitor": {"type": "poll", "url": u, "path": "ok", "interval": 0},
                     "action": {"type": "none"}} for i, u in enumerate(urls)]
    return svc


def _tick(svc):
    return {b["id"]: svc._eval_monitor(b) for b in svc._buttons}


def test_refused_target_is_asked_once_per_pause(tmp_path, monkeypatch):
    net = Net(down={"http://127.0.0.1:7907/"})
    svc = _svc(tmp_path, monkeypatch, net, [DOWN] * 8 + [DOWN_OTHER_PATH] * 2 + [UP])
    values = _tick(svc)
    assert net.calls.count(DOWN) + net.calls.count(DOWN_OTHER_PATH) == 1, "ein Versuch je Ziel statt zehn"
    assert net.calls.count(UP) == 1 and values["b10"] == 1, "anderes Ziel unberuehrt"
    assert all(values[f"b{i}"] is None for i in range(10)), "abgelehnt = kein Wert, wie bisher"
    net.calls.clear()
    _tick(svc)
    assert DOWN not in net.calls and DOWN_OTHER_PATH not in net.calls, "Pause laeuft: kein neuer Versuch"


def test_pause_ends_and_recovery_clears_it(tmp_path, monkeypatch):
    net = Net(down={"http://127.0.0.1:7907/"})
    svc = _svc(tmp_path, monkeypatch, net, [DOWN, DOWN])
    _tick(svc)
    key = core._http_endpoint(DOWN)
    svc._refused_until[key] = 0.0                       # Pause abgelaufen
    net.down.clear()                                    # Dienst ist inzwischen da
    net.calls.clear()
    values = _tick(svc)
    assert net.calls == [DOWN, DOWN] and values == {"b0": 1, "b1": 1}
    assert key not in svc._refused_until


def test_other_errors_start_no_pause(tmp_path, monkeypatch):
    net = Net(broken={UP})
    svc = _svc(tmp_path, monkeypatch, net, [UP, UP])
    _tick(svc)
    assert net.calls == [UP, UP], "Antwort mit Fehler = Dienst lebt, jede Taste fragt weiter"
    assert not svc._refused_until


def test_level_http_shares_the_pause(tmp_path, monkeypatch):
    net = Net(down={"http://127.0.0.1:7907/"})
    svc = _svc(tmp_path, monkeypatch, net, [DOWN])
    svc._buttons.append({"id": "lvl", "monitor": {"type": "level_http", "get_url": DOWN_OTHER_PATH,
                                                  "value_path": "value", "interval": 0},
                         "action": {"type": "none"}})
    values = _tick(svc)
    assert net.calls == [DOWN], "Pegel-Taste auf dasselbe Ziel wartet nicht erneut"
    assert values["lvl"]["available"] is False


def test_endpoint_key_ignores_path():
    assert core._http_endpoint(DOWN) == core._http_endpoint(DOWN_OTHER_PATH)
    assert core._http_endpoint(DOWN) != core._http_endpoint(UP)
    assert core._is_refused(urllib.error.URLError(ConnectionRefusedError()))
    assert not core._is_refused(urllib.error.URLError(TimeoutError()))
