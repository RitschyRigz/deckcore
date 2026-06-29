"""Button-Presets — pro Aktions-Typ eine sinnvolle Default-Überwachung + Zustände + Symbol.

EINE Wahrheit für (a) den Editor („✨ Vorlage anwenden" / Auto-Apply bei frischen Buttons)
und (b) die Massen-Generatoren (OBS-Szenen / DisplayFusion). Reine, host-agnostische Funktion —
kennt keine konkrete App. Gibt ein Teil-Button-Skelett ``{monitor, states, default, render?}``
zurück, das über die feste Aktion/ID gemergt wird.

Farb-Konvention (überall gleich): aktiv/an = grün · inaktiv/aus = grau · live/Aufnahme = rot.

⭐ Farben sind THEME-SCHLÜSSELWÖRTER (kein festes Hex), damit jede generierte Taste dem Theme folgt und
der Nutzer global umfärben kann (resolveColor → var(--x)). Pro Taste bleibt eine eigene (auch feste) Farbe
wählbar; ein Re-Generieren überschreibt sie nicht (_regen_preserve bewahrt default/states/color).
"""
from __future__ import annotations

GREEN = "ok"     # aktiv / an  → var(--ok)
GREY = "off"     # inaktiv / aus / neutral → var(--off)
RED = "live"     # live / Aufnahme → var(--live)

# Media-Tasten → Symbol + Titel
_MEDIA = {
    "playpause": ("⏯", "Play/Pause"), "next": ("⏭", "Weiter"), "prev": ("⏮", "Zurück"),
    "stop": ("⏹", "Stop"), "volup": ("🔊", "Lauter"), "voldown": ("🔉", "Leiser"),
    "mute": ("🔇", "Stumm"),
}
# Manual-Event-Typen → Symbol (Cockpit)
_MANUAL_ICONS = {"death": "💀", "win": "🏆", "boss": "👹", "boss_killed": "👹",
                 "kill": "⚔️", "funny": "😂", "fail": "❌", "clip": "🎬"}


def _state(op: str, value, icon: str, title: str) -> dict:
    when = {"op": op}
    if op not in ("any", "truthy", "falsy"):
        when["value"] = value
    return {"when": when, "icon": icon, "title": title, "color": GREEN}


def button_preset(action: dict, *, deck_label: str | None = None) -> dict:
    """``{monitor, states, default}`` (+ optional ``render``) für die gegebene Aktion.

    Füllt im Editor die übrigen Felder „preset-mäßig" vor (Überwachung + Zustands-Logik +
    Symbol/Farben) und liefert den Massen-Generatoren dieselben Default-Visuals. Unbekannter Typ
    → neutraler, leerer Default (kein Monitor)."""
    a = action or {}
    t = a.get("type") or "none"

    # ── Multi-Action: nur ein Symbol vorschlagen, Monitor/Zustände NICHT anfassen (der User baut den
    # aggregierten Status selbst — sonst würde das Auto-Preset bei jedem Schritt-Edit den Aggregat-
    # Monitor überschreiben). Keine monitor/states-Keys → applyPresetData behält die aktuellen Werte. ──
    if t == "multi":
        return {"default": {"icon": "🔀"}}

    # ── Audio (generisch) ────────────────────────────────────────────────
    if t == "winaudio":
        sub = a.get("wa_action") or "set_default"
        if sub in ("set_volume", "toggle_mute"):
            # Lautstärke-Regler: vertikaler Fader + Live-VU. Das Gerät steht an der AKTION (device_id/
            # device_name); der Monitor liest es von dort → hier KEIN Gerät im Monitor.
            return {"render": "fader",
                    "monitor": {"type": "winaudio_volume"},
                    "states": [], "default": {"icon": "🔊", "title": "{value}%", "color": GREEN}}
        name = a.get("device_name") or "Gerät"
        return {"monitor": {"type": "winaudio_default", "device_name": a.get("device_name", "")},
                "states": [_state("truthy", None, "🔊", name)],
                "default": {"icon": "🔈", "title": name, "color": GREY}}

    if t == "app_audio":
        # App-Mixer: vertikaler Fader + Live-VU je Programm. Das Programm steht an der AKTION (app_proc);
        # der Monitor liest es von dort → hier KEIN Programm im Monitor. Violett = App-Mixer-Identität.
        return {"render": "fader",
                "monitor": {"type": "app_volume"},
                "states": [], "default": {"icon": "🎵", "title": "{value}%", "color": "accent2"}}

    # ── OBS (generisch) ──────────────────────────────────────────────────
    if t == "obs":
        sub = a.get("obs_action") or "scene"
        if sub == "scene":
            s = a.get("scene") or "Szene"
            return {"monitor": {"type": "obs_scene"},
                    "states": [_state("eq", a.get("scene", ""), "📺", s)],
                    "default": {"icon": "🎬", "title": s, "color": GREY}}
        if sub == "source_toggle":
            src = a.get("source") or "Quelle"
            return {"monitor": {"type": "obs_source_visible", "source": a.get("source", ""),
                                "scene": a.get("scene", "")},
                    "states": [_state("truthy", None, "👁", src)],
                    "default": {"icon": "🙈", "title": src, "color": GREY}}
        if sub == "stream":
            return {"monitor": {"type": "none"}, "states": [],
                    "default": {"icon": "🔴", "title": "Live", "color": GREY}}
        if sub == "record":
            return {"monitor": {"type": "none"}, "states": [],
                    "default": {"icon": "⏺", "title": "Aufnahme", "color": RED}}
        return {"monitor": {"type": "none"}, "states": [], "default": {"icon": "🎬"}}

    # ── Programme / System (generisch) ───────────────────────────────────
    if t == "displayfusion":
        p = a.get("profile") or "Profil"
        return {"monitor": {"type": "displayfusion_profile"},
                "states": [_state("eq", a.get("profile", ""), "🖥", p)],
                "default": {"icon": "🖥", "title": p, "color": GREY}}

    if t == "media":
        icon, title = _MEDIA.get(a.get("key", ""), ("⏯", "Media"))
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": icon, "title": title}}

    if t == "hotkey":
        steps = [s for s in (a.get("steps") or []) if str((s or {}).get("keys") or "").strip()]
        if len(steps) > 1:
            title = f"Makro · {len(steps)} Schritte"
        elif len(steps) == 1:
            title = str(steps[0].get("keys"))
        else:
            title = a.get("keys") or "Makro"
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "⌨", "title": title}}

    if t == "http":
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "🌐", "title": "HTTP"}}

    if t == "open_deck":
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "📁", "title": deck_label or "Ordner"}}

    if t == "open_folder":
        # Titel = letzter Pfad-Bestandteil (z.B. „Desktop"); `shell:Downloads` → „Downloads".
        raw = (a.get("path") or "").strip().strip('"').rstrip("\\/")
        if raw.lower().startswith("shell:"):
            name = raw.split(":", 1)[1] or "Ordner"
        else:
            name = raw.replace("/", "\\").split("\\")[-1] if raw else "Ordner"
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "📂", "title": name or "Ordner"}}

    if t == "launch":
        # Symbol/Titel kommen i.d.R. aus der Datei-Icon-Extraktion (pick_file) → hier nur Fallback,
        # kein Monitor. Bestehende Felder werden im Editor NICHT überschrieben.
        return {"monitor": {"type": "none"}, "states": [], "default": {"icon": "🚀"}}

    # ── Schalter / Flags (generisch) ─────────────────────────────────────
    if t == "flag_toggle":
        return {"monitor": {"type": "flag", "flag": a.get("flag", "")},
                "states": [_state("truthy", None, "✅", "An")],
                "default": {"icon": "⬜", "title": "Aus", "color": GREY}}

    if t == "flag_set":
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "📌", "title": a.get("flag") or "Flag"}}

    # ── Nur Cockpit (Registry trägt sie generisch; in schlanken Hüllen nie angefragt) ──
    if t == "process_action":
        return {"monitor": {"type": "process_alive", "process": a.get("process", "")},
                "states": [_state("truthy", None, "🟢", "läuft")],
                "default": {"icon": "⚪", "title": "aus", "color": GREY}}

    if t == "manual_event":
        et = a.get("event_type") or ""
        return {"monitor": {"type": "manual_count", "event_type": et}, "states": [],
                "default": {"icon": _MANUAL_ICONS.get(et, "🎯"), "title": "{value}"}}

    if t == "alert":
        return {"monitor": {"type": "none"}, "states": [],
                "default": {"icon": "🔔", "title": a.get("alert_type") or "Alert"}}

    if t == "events_action":
        return {"monitor": {"type": "none"}, "states": [], "default": {"icon": "⚡"}}

    if t == "wavelink":
        # Einzel-Button (z.B. Mix-Mute). Komplette Fader-Decks kommen über den „🎚 Wave-Link-Fader"-
        # Generator (render=fader) — nicht über dieses Preset.
        return {"monitor": {"type": "none"}, "states": [], "default": {"icon": "🎚"}}

    # none / unbekannt → neutral, ohne Monitor
    return {"monitor": {"type": "none"}, "states": [], "default": {}}
