"""Wave-Link-Zustand sparsam abfragen (Befund 03.10.2026): Wave Link 3.2.9 rendert für jede
getChannels-Antwort alle Kanal-Icons und stürzt dabei sporadisch ab. Zustand nur bei gemeldeter
Änderung (gedrosselt) oder als Sicherheitsnetz neu holen, nie zwei gleiche Anfragen gleichzeitig.
Pegel kommen per Push und bleiben unberührt."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import wavelink as wlmod  # noqa: E402
from wavelink import WaveLinkDirect  # noqa: E402


class _Fake(WaveLinkDirect):
    def __init__(self, delay: float = 0.0):
        super().__init__()
        self.calls: list[str] = []
        self.delay = delay
        self.level = 0.5
        self.muted = False

    def _ensure_started(self) -> None:  # kein echter Socket
        pass

    def _request(self, method, params=None, timeout=wlmod._REQ_TIMEOUT):
        self.calls.append(method)
        if self.delay:
            time.sleep(self.delay)
        if method == "getChannels":
            return {"channels": [{"id": "mic", "level": self.level, "isMuted": self.muted,
                                  "image": {"imgData": "AAAA", "name": "x"}, "mixes": []}]}
        if method == "getMixes":
            return {"mixes": [{"id": "stream", "level": 1.0, "isMuted": False}]}
        return {}


def _clock(monkeypatch, start: float = 1000.0):
    now = {"t": start}
    monkeypatch.setattr(wlmod.time, "monotonic", lambda: now["t"])
    return now


def test_repeated_reads_within_ttl_ask_once(monkeypatch):
    now = _clock(monkeypatch)
    wl = _Fake()
    for _ in range(50):                     # 15-Hz-Schleife über gut 3 s
        wl.channels()
        now["t"] += 1 / 15
    assert wl.calls.count("getChannels") == 1


def test_safety_net_refresh_after_ttl(monkeypatch):
    now = _clock(monkeypatch)
    wl = _Fake()
    wl.channels()
    now["t"] += wlmod._STATE_TTL + 0.1
    wl.channels()
    assert wl.calls.count("getChannels") == 2


def test_change_notification_refreshes_but_throttled(monkeypatch):
    now = _clock(monkeypatch)
    wl = _Fake()
    wl.channels()
    for _ in range(20):                     # Fader in Wave Link ziehen: Meldungssturm
        wl._dispatch('{"jsonrpc":"2.0","method":"channelChanged","params":{}}')
        wl.level = 0.9
        wl.channels()
        now["t"] += 0.05
    # 1 s Sturm → höchstens eine Nachabfrage, und der neue Wert kommt an
    assert wl.calls.count("getChannels") <= 2
    now["t"] += wlmod._REFRESH_MIN_GAP
    wl._dispatch('{"jsonrpc":"2.0","method":"channelChanged","params":{}}')
    assert wl.channel_level("mic") == 90


def test_level_meter_push_does_not_trigger_state_fetch(monkeypatch):
    now = _clock(monkeypatch)
    wl = _Fake()
    wl.channels()
    for _ in range(30):
        wl._dispatch('{"jsonrpc":"2.0","method":"levelMeterChanged","params":'
                     '{"channels":[{"id":"mic","levelLeftPercentage":0.7,"levelRightPercentage":0.6}]}}')
        wl.channels()
        now["t"] += 0.1
    assert wl.calls.count("getChannels") == 1
    assert wl.meters()["meters"]["mic"] > 0


def test_toggle_reads_current_state_right_after_change(monkeypatch):
    now = _clock(monkeypatch)
    wl = _Fake()
    wl.channels()
    wl.muted = True
    wl._dispatch('{"jsonrpc":"2.0","method":"channelChanged","params":{}}')
    now["t"] += 0.1                          # innerhalb der Drossel — Umschalten liest trotzdem frisch
    sent = {}
    monkeypatch.setattr(wl, "_command", lambda m, p=None: sent.update(p or {}) or True)
    res = wl.set_channel_mute("mic")
    assert res["muted"] is False and sent["isMuted"] is False


def test_parallel_readers_share_one_request():
    wl = _Fake(delay=0.2)
    wl.channels()                            # Cache füllen
    wl._dispatch('{"jsonrpc":"2.0","method":"channelChanged","params":{}}')
    with wl._lock:                           # letzte Abfrage künstlich alt machen
        v, ts, g = wl._cache["channels"]
        wl._cache["channels"] = (v, ts - 5, g)
    before = len(wl.calls)
    threads = [threading.Thread(target=wl.channels) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(wl.calls) - before == 1


def test_icons_are_stripped_by_default(monkeypatch):
    _clock(monkeypatch)
    wl = _Fake()
    assert "imgData" not in wl.channels()[0]["image"]
