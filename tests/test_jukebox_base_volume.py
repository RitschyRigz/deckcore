"""Grundpegel je Wiedergabe (``base_volume_for``/``set_base_volume``): ein Host darf jeder
Wiedergabe einen eigenen Pegel geben und ihn live aendern; ohne Haken bleibt alles wie
bisher (``config.volume`` wird live gelesen — das Musikbett haengt daran)."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


class _Player:
    last: "_Player" = None  # type: ignore[assignment]

    def __init__(self, mpv, pipe, on_event):
        self._on = on_event
        self._alive = True
        self.start_volume = None
        self.volumes: list = []
        _Player.last = self

    def start(self, file, audio_device="", volume=None):
        self.start_volume = volume
        self._on({"event": "loaded"})
        self._on({"event": "progress", "position": 1.0, "duration": 200.0})

    def stop(self):
        self._alive = False

    def pause(self, flag):
        return True

    def set_volume(self, v):
        self.volumes.append(v)
        return True

    def alive(self):
        return self._alive


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music" / "duet"
    music.mkdir(parents=True)
    (music / "Song.wav").write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {},
                     publish=None, player_factory=_Player)
    lib.set_config(library_dir=str(tmp_path / "music"), volume=80)
    return lib


def _play(lib: jb.Jukebox) -> str:
    res = lib.play(lib.library()[0]["id"])
    assert res["ok"], res
    return res["request_id"]


def _settle(predicate, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_without_hook_config_volume_stays_live(tmp_path):
    lib = _lib(tmp_path)
    _play(lib)
    assert _Player.last.start_volume == 80
    assert lib.status().get("base_volume") is None
    lib.set_config(volume=40)
    lib.duck(None, fade_ms=0)
    assert _settle(lambda: _Player.last.volumes and _Player.last.volumes[-1] == 40)


def test_hook_sets_base_of_this_playback(tmp_path):
    lib = _lib(tmp_path)
    seen = []
    lib.base_volume_for = lambda t, style, rid: seen.append(rid) or 30
    rid = _play(lib)
    assert seen == [rid]
    assert _Player.last.start_volume == 30 and lib.status()["base_volume"] == 30
    lib.duck(0.5, fade_ms=0)
    assert _settle(lambda: _Player.last.volumes and _Player.last.volumes[-1] == 15)


def test_hook_failure_falls_back_to_config(tmp_path):
    lib = _lib(tmp_path)

    def boom(*a):
        raise RuntimeError("x")
    lib.base_volume_for = boom
    _play(lib)
    assert _Player.last.start_volume == 80


def test_set_base_volume_keeps_duck_factor_and_binds_request(tmp_path):
    lib = _lib(tmp_path)
    lib.base_volume_for = lambda *a: 100
    rid = _play(lib)
    lib.duck(0.25, fade_ms=0)
    assert _settle(lambda: _Player.last.volumes and _Player.last.volumes[-1] == 25)
    assert lib.set_base_volume(60, request_id="anderer")["ok"] is False
    out = lib.set_base_volume(60, request_id=rid, fade_ms=0)
    assert out["ok"] and lib.status()["base_volume"] == 60
    assert _settle(lambda: _Player.last.volumes[-1] == 15)


def test_set_base_volume_without_player_fails(tmp_path):
    lib = _lib(tmp_path)
    assert lib.set_base_volume(50)["ok"] is False
