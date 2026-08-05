"""Pure helpers for scene-aware media actions."""
from __future__ import annotations

from collections.abc import Mapping


def resolve_media_file(action: Mapping, current_scene: str | None) -> str:
    """Resolve file_by_scene with file as a fail-soft fallback.

    Scene mappings live in the button configuration. The action engine stays
    host- and product-agnostic and merely supplies the current OBS scene.
    Matching is exact first and then case-insensitive for hand-edited configs.
    """
    fallback = str(action.get("file") or "")
    mapping = action.get("file_by_scene")
    if not isinstance(mapping, Mapping) or not current_scene:
        return fallback

    scene = str(current_scene)
    selected = mapping.get(scene)
    if selected not in (None, ""):
        return str(selected)
    scene_ci = scene.casefold()
    for name, value in mapping.items():
        if str(name).casefold() == scene_ci and value not in (None, ""):
            return str(value)
    return fallback
