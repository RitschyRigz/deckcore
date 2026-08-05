"""Call-free tests for scene-aware play_media file selection."""
from __future__ import annotations

import sys
import importlib
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scene_media import resolve_media_file  # noqa: E402


def test_scene_mapping_selects_the_two_configured_products():
    action = {
        "file": r"C:\media\latest_pause.mp4",
        "file_by_scene": {
            "Stream Starting": r"C:\media\latest_pause.mp4",
            "Kategorienwechsel": r"C:\media\latest_pause.mp4",
            "Be right Back": r"C:\media\latest_meine_reise.mp4",
            "Coffee Loading": r"C:\media\latest_meine_reise.mp4",
        },
    }
    assert resolve_media_file(action, "Kategorienwechsel").endswith("latest_pause.mp4")
    assert resolve_media_file(action, "Coffee Loading").endswith("latest_meine_reise.mp4")


def test_scene_mapping_is_case_tolerant_and_fails_soft():
    action = {
        "file": "fallback.mp4",
        "file_by_scene": {"Be right Back": "reise.mp4"},
    }
    assert resolve_media_file(action, "be RIGHT back") == "reise.mp4"
    assert resolve_media_file(action, "Gameplay") == "fallback.mp4"
    assert resolve_media_file({"file": "fallback.mp4"}, "Be right Back") == "fallback.mp4"


def test_play_media_handler_uses_current_obs_scene_without_starting_mpv():
    package_name = "deckcore_scene_media_test"
    spec = importlib.util.spec_from_file_location(
        package_name,
        ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    spec.loader.exec_module(package)

    service = object.__new__(package.DeckCoreService)
    service._mon_obs_scene = lambda _monitor, _button: "Coffee Loading"
    service._mediaplayer_cfg = lambda: {}
    media_module = importlib.import_module(f"{package_name}.mediaplayer")
    old_play = media_module.play
    old_active = media_module.active
    old_stop = media_module.stop
    captured = {}
    try:
        def fake_play(file, **kwargs):
            captured["file"] = file
            captured["kwargs"] = kwargs
            return {"ok": True, "message": "fake"}

        media_module.play = fake_play
        media_module.active = lambda _slot: False
        media_module.stop = lambda **_kwargs: {"ok": True, "message": "stopped"}
        result = package.DeckCoreService._act_play_media(service, {
            "type": "play_media",
            "file": "pause.mp4",
            "file_by_scene": {"Coffee Loading": "reise.mp4"},
            "slot": "Recap",
            "mode": "toggle",
        }, {"id": "test"})
        media_module.active = lambda _slot: True
        stopped = package.DeckCoreService._act_play_media(service, {
            "type": "play_media",
            "file": "pause.mp4",
            "slot": "Recap",
            "mode": "toggle",
        }, {"id": "test"})
    finally:
        media_module.play = old_play
        media_module.active = old_active
        media_module.stop = old_stop
    assert result["success"] is True
    assert captured["file"] == "reise.mp4"
    assert captured["kwargs"]["slot"] == "Recap"
    assert stopped["success"] is True and stopped["message"] == "stopped"


if __name__ == "__main__":
    test_scene_mapping_selects_the_two_configured_products()
    test_scene_mapping_is_case_tolerant_and_fails_soft()
    test_play_media_handler_uses_current_obs_scene_without_starting_mpv()
    print("Scene-aware media test: 0 failures.")
