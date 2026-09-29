"""Push to Duck nach dem Songende (Stream 28.09.2026): Die Taste stand nach einem Song bis
Stream-Ende auf „Duck AN" und liess sich nicht mehr ausschalten. Der Merker ``ducked``
ueberlebte das Trackende, und ``duck(None)`` ohne Player meldete ok:false, ohne ihn zu
loeschen. Jetzt gehoert das Ducking zur Wiedergabe: es endet mit dem Track, und „aus"
gelingt immer."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


class _Player:
    """Player-Attrappe mit dem echten Vertrag (Ereignisse ueber ``on_event``)."""

    last: "_Player" = None  # type: ignore[assignment]

    def __init__(self, mpv, pipe, on_event):
        self._on = on_event
        self._alive = True
        self.volumes: list = []
        _Player.last = self

    def start(self, file, audio_device="", volume=None):
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

    def end(self, reason="eof"):
        self._alive = False
        self._on({"event": "end", "reason": reason})


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music" / "duet"
    music.mkdir(parents=True)
    (music / "Kuechentuer.wav").write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {},
                     publish=None, player_factory=_Player)
    lib.set_config(library_dir=str(tmp_path / "music"))
    return lib


def _play(lib: jb.Jukebox) -> str:
    track = lib.library()[0]["id"]
    res = lib.play(track)
    assert res["ok"], res
    assert lib.status()["state"] == "playing"
    return res["request_id"]


def test_track_end_resets_the_duck_flag_for_every_final_state(tmp_path):
    for reason in ("eof", "stop", "error"):
        lib = _lib(tmp_path / reason)
        _play(lib)
        assert lib.duck_toggle(0.25)["ducked"] is True
        assert lib.status()["ducked"] is True
        _Player.last.end(reason)
        snap = lib.status()
        assert snap["state"] in ("ended", "stopped", "error")
        assert snap["ducked"] is False and snap["duck_level"] is None
        # Die Taste zeigt den Zustand aus state.json/status — auch dort ist er zurueck.
        import json
        assert json.loads((lib._dir / "state.json").read_text("utf-8"))["ducked"] is False


def test_user_stop_resets_the_duck_flag(tmp_path):
    lib = _lib(tmp_path)
    _play(lib)
    lib.duck(0.25)
    lib.stop()
    assert lib.status()["ducked"] is False


def test_unduck_without_player_clears_a_stuck_flag_and_reports_ok(tmp_path):
    lib = _lib(tmp_path)
    # Alter Stand (vor dem Fix / nach einem Absturz): Merker steht ohne Player.
    lib._set(state="ended", ducked=True, duck_level=0.25)
    res = lib.duck_toggle(0.25)
    assert res["ok"] is True and res["ducked"] is False and res["player"] is False
    assert lib.status()["ducked"] is False
    # Aus bleibt aus (idempotent), Absenken ohne Player geht weiterhin nicht.
    assert lib.duck(None)["ok"] is True
    assert lib.duck(0.25)["ok"] is False
    assert lib.status()["ducked"] is False


def test_toggle_four_times_during_a_song_ends_unducked(tmp_path):
    lib = _lib(tmp_path)
    rid = _play(lib)
    seen = []
    for _ in range(4):
        res = lib.duck_toggle(0.25)
        assert res["ok"] is True and res["request_id"] == rid
        seen.append(res["ducked"])
    assert seen == [True, False, True, False]
    assert lib.status()["ducked"] is False
    assert lib.status()["state"] == "playing"
    time.sleep(0.05)
