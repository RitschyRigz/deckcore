"""
Deklarative Integrations-Registry für DeckCore.

Eine *Integration* bündelt zusammengehörige Capability-Typen (Aktionen + Monitore) unter einem
an-/abschaltbaren Schirm. ⚠ ABSCHALTEN = reines Editor-Gating: die Typen verschwinden aus den
Auswahllisten (man legt keine NEUEN solchen Buttons mehr an). Bestehende Buttons und ihre Handler
laufen IMMER weiter — es wird nie etwas deregistriert. Man kann sich also nichts kaputtmachen.

Die Registry ist HOST-ERWEITERBAR (wie die Capability-Registry): der Kern liefert die Basis +
die generischen Fremd-App-Integrationen. Eine Host-App injiziert über
``DeckCoreService._register_extra_integrations()`` ihre eigenen (z.B. die Eigensteuerung einer
größeren App) — so bleibt der Kern host-agnostisch und kennt keine konkrete Host-App.

Eintrags-Felder:
  id           stabiler Schlüssel (``runtime/integrations.json`` referenziert ihn)
  emoji,label  Anzeige im Tab
  description  Klartext fürs Tab
  base         True = Grundfunktion: IMMER sichtbar, nicht abschaltbar (kein Gating)
  actions      [cap-typ, …] besessene Aktions-Typen (fürs Gating)
  monitors     [cap-typ, …] besessene Monitor-Typen (fürs Gating)
  requires     optionaler Voraussetzungs-Hinweis (Klartext; die Live-Probe kommt später)
"""

# ── Basis — immer verfügbar, nie gegated (zur Transparenz mitgelistet, base=True) ─────────────
BASE = {
    "id": "base", "emoji": "🧱", "label": "Basis", "base": True,
    "description": "Grundfunktionen ohne externe Abhängigkeit — immer verfügbar.",
    "actions": ["launch", "open_folder", "open_deck", "http", "flag_toggle", "flag_set",
                "media", "hotkey", "winaudio", "none"],
    "monitors": ["flag", "file_field", "poll", "sse_field",
                 "winaudio_default", "winaudio_volume", "none"],
}

# ── Generische Fremd-App-/Hardware-Integrationen (jeder Host kann sie haben) ───────────────────
CORE_INTEGRATIONS = [
    {
        "id": "obs", "emoji": "🎬", "label": "OBS",
        "description": "Szenen wechseln, Quellen ein-/ausblenden, Stream/Aufnahme steuern (obs-websocket).",
        "actions": ["obs"], "monitors": ["obs_scene", "obs_source_visible"],
        "requires": "OBS läuft + WebSocket-Server aktiv (Standard 127.0.0.1:4455).",
    },
    {
        "id": "wavelink", "emoji": "🎚", "label": "Wave Link",
        "description": "Elgato Wave Link: Mixer/Fader, Mute, Live-VU, Main-Output.",
        "actions": ["wavelink"],
        "monitors": ["wavelink_meter", "wavelink_level", "wavelink_mute", "wavelink_main_output"],
        "requires": "Elgato Wave Link läuft (lokaler JSON-RPC-Port wird automatisch gefunden).",
    },
    {
        "id": "hwinfo", "emoji": "🌡", "label": "HWiNFO",
        "description": "Hardware-Sensoren (Temperaturen, Takt, Auslastung) als Wert/Graph/Gauge.",
        "actions": [], "monitors": ["hwinfo"],
        "requires": "HWiNFO läuft mit Shared-Memory- oder Registry-Export aktiviert.",
    },
    {
        "id": "presentmon", "emoji": "🎯", "label": "PresentMon",
        "description": "FPS / Frametime des Vordergrund-Spiels (herstellerneutral, ohne Injection).",
        "actions": [], "monitors": ["fps", "frametime"],
        "requires": "Intel-PresentMon-Dienst installiert (vendor-neutral; auf jedem PC nötig).",
    },
    {
        "id": "displayfusion", "emoji": "🖥", "label": "DisplayFusion",
        "description": "Monitor-Profile laden (Auflösung/Anordnung umschalten).",
        "actions": ["displayfusion"], "monitors": ["displayfusion_profile"],
        "requires": "DisplayFusion installiert (DisplayFusionCommand.exe).",
    },
    {
        "id": "obsbot", "emoji": "📷", "label": "OBSBOT",
        "description": "OBSBOT-Kameras steuern: Presets, Zentrieren, Wake/Sleep, Tracking-Toggle (OSC).",
        "actions": ["obsbot"], "monitors": ["obsbot_cam", "obsbot_track"],
        "requires": "OBSBOT Center läuft + OSC aktiv (UDP-Server, Standard-Port 16284).",
    },
]


def all_integrations(extra=None):
    """Vollständige Liste: Basis + generische Integrationen + host-injizierte (``extra``)."""
    return [BASE] + list(CORE_INTEGRATIONS) + list(extra or [])


def cap_owners(integrations):
    """``{cap_typ: integration_id}`` über alle NICHT-Basis-Integrationen — die Gating-Wahrheit.
    Cap-Typen der Basis (oder gar keiner Integration zugeordnet) tauchen hier NICHT auf und gelten
    damit als immer sichtbar. Bei Doppelnennung gewinnt die erste Integration (deterministisch)."""
    owners: dict[str, str] = {}
    for it in integrations:
        if it.get("base"):
            continue
        for t in list(it.get("actions") or []) + list(it.get("monitors") or []):
            owners.setdefault(str(t), it["id"])
    return owners


def visible_cap_types(integrations, enabled_ids):
    """Set der Cap-Typen, die im Editor sichtbar sein sollen: alle Basis-Caps + die Caps der
    aktiven Integrationen. (Wird ab P2 vom Editor-Gating genutzt; in P1 nur bereitgestellt.)"""
    enabled = set(enabled_ids or ())
    visible: set[str] = set()
    for it in integrations:
        if it.get("base") or it["id"] in enabled:
            for t in list(it.get("actions") or []) + list(it.get("monitors") or []):
                visible.add(str(t))
    return visible
