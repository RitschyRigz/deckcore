"""Medientasten-Sperre fuer gesteuerte mpv-Instanzen (Stream 17.09.2026: Kopfhoerer-Play/Pause
pausierte das Bett ohne Spur). Versionssicher: nur Flags, die das Binary kennt."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mpvflags  # noqa: E402
import jukebox as jb  # noqa: E402


def test_flags_only_for_known_options(monkeypatch):
    mpvflags.reset_cache()
    monkeypatch.setattr(mpvflags, "_list_options", lambda path: frozenset({"input-media-keys", "volume"}))
    assert mpvflags.media_control_flags("mpv-old") == ["--input-media-keys=no"]
    mpvflags.reset_cache()
    monkeypatch.setattr(mpvflags, "_list_options",
                        lambda path: frozenset({"input-media-keys", "media-controls"}))
    assert mpvflags.media_control_flags("mpv-new") == ["--input-media-keys=no", "--media-controls=no"]
    assert mpvflags.has_media_control_flags(mpvflags.media_control_flags("mpv-new"))
    assert not mpvflags.has_media_control_flags(["--no-video"])


def test_unknown_binary_adds_nothing(monkeypatch):
    mpvflags.reset_cache()
    monkeypatch.setattr(mpvflags, "_list_options", lambda path: frozenset())
    assert mpvflags.media_control_flags("nirgends/mpv") == []


def test_options_are_probed_once_per_binary(monkeypatch):
    mpvflags.reset_cache()
    calls = []
    monkeypatch.setattr(mpvflags, "_list_options",
                        lambda path: (calls.append(path), frozenset({"media-controls"}))[1])
    mpvflags.media_control_flags("x")
    mpvflags.media_control_flags("x")
    mpvflags.media_control_flags("y")
    assert calls == ["x", "y"]


def test_audio_launcher_passes_the_lock_to_mpv(monkeypatch):
    mpvflags.reset_cache()
    monkeypatch.setattr(mpvflags, "_list_options",
                        lambda path: frozenset({"input-media-keys", "media-controls"}))
    seen = {}

    class _Proc:
        pid = 1

    def fake_popen(args, **kw):
        seen["args"] = list(args)
        return _Proc()

    monkeypatch.setattr(jb.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(jb.threading, "Thread", lambda *a, **k: type("T", (), {"start": lambda self: None})())
    player = jb._MpvAudio("mpv.exe", r"\.\pipe\t", lambda ev: None)
    player.start("song.wav", audio_device="dev", volume=30)
    assert "--input-media-keys=no" in seen["args"] and "--media-controls=no" in seen["args"]
    assert "--no-input-default-bindings" in seen["args"]


def test_write_json_retries_a_busy_target(monkeypatch, tmp_path):
    """Windows: os.replace scheitert, solange ein Leser die Datei offen hat — kurz erneut versuchen."""
    lib = jb.Jukebox.__new__(jb.Jukebox)
    lib._dir = tmp_path
    attempts = {"n": 0}
    real_replace = jb.os.replace

    def flaky(src, dst):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise PermissionError(5, "Zugriff verweigert")
        real_replace(src, dst)

    monkeypatch.setattr(jb.os, "replace", flaky)
    monkeypatch.setattr(jb.time, "sleep", lambda s: None)
    lib._write_json("config.json", {"volume": 42})
    assert attempts["n"] == 3
    assert jb.json.loads((tmp_path / "config.json").read_text("utf-8")) == {"volume": 42}
    assert not (tmp_path / "config.json.tmp").exists()


def test_write_json_raises_visibly_when_the_target_stays_busy(monkeypatch, tmp_path):
    import pytest
    lib = jb.Jukebox.__new__(jb.Jukebox)
    lib._dir = tmp_path

    def always_busy(src, dst):
        raise PermissionError(5, "Zugriff verweigert")

    monkeypatch.setattr(jb.os, "replace", always_busy)
    monkeypatch.setattr(jb.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        lib._write_json("config.json", {"volume": 1})
    assert not (tmp_path / "config.json.tmp").exists()
