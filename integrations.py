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
  generator    optional {endpoint, label, opt?} — „Buttons generieren/Rescan" für diese Integration
               (additiv+idempotent gegen den Live-Stand). opt = 'hwinfo_render' | 'obsbot_cameras'
               schaltet im Tab das passende Zusatzfeld frei.
"""

# ── Basis — immer verfügbar, nie gegated (zur Transparenz mitgelistet, base=True) ─────────────
BASE = {
    "id": "base", "emoji": "🧱", "label": "Basis", "base": True,
    "description": "Grundfunktionen ohne externe Abhängigkeit — immer verfügbar.",
    "actions": ["launch", "open_folder", "open_deck", "http", "flag_toggle", "flag_set",
                "media", "hotkey", "none"],
    "monitors": ["flag", "file_field", "poll", "sse_field", "none"],
}

# ── Windows-Audio — eigene Kategorie (base=True → immer da, kein externes Programm nötig). ──────
# Lautstärke-Fader (Live-VU) für: Hauptlautstärke · je laufendem Programm (App-Mixer) · plus Buttons
# zum Umschalten des Standard-Ausgabegeräts. Die Elemente liest der Host LIVE aus → im Kategorie-Panel
# einzeln ankreuzbar (analog zu allen anderen Kategorien). KEIN Pauschal-Generator-Knopf (granular).
WINDOWS_AUDIO = {
    "id": "audio", "emoji": "🔊", "label": "Windows Audio", "base": True,
    "description": "Lautstärke-Fader (mit Live-VU): Windows-Hauptlautstärke, je laufendem Programm "
                   "(App-Mixer) und Umschalt-Buttons fürs Standard-Ausgabegerät. Programme erscheinen, "
                   "sobald sie Ton ausgeben (wie der Windows-Lautstärkemixer) — anhaken legt den Fader an.",
    "actions": ["winaudio", "app_audio"],
    "monitors": ["winaudio_default", "winaudio_volume", "app_volume"],
}

# ── „Eigene Buttons" — frei definierte/handgemachte Buttons (keine externe Abhängigkeit). ──────
# Sonderfall ``custom: True``: das Tab-Panel ist KEIN Häkchen-Generator, sondern ein Mini-Verwalter
# (Liste der eigenen Buttons + „Neuer Button"). base=True → immer da, nicht abschaltbar.
CUSTOM = {
    "id": "custom", "emoji": "✏️", "label": "Eigene Buttons und Kategorien", "base": True, "custom": True,
    "description": "Frei definierte Buttons (Programm starten, Tastenkürzel, URL, Ordner, Medien …) + "
                   "eigene Kategorien — beliebig viele anlegen, jederzeit bearbeiten.",
    "actions": [], "monitors": [],
}

# ── „Ordner" — jedes angelegte Sub-Deck als ankreuzbarer Öffnen-Button ─────────────────────────
# base=True → immer sichtbar. KEIN Cap-Owner (open_deck bleibt eine Basis-Aktion); diese Integration
# ist ein GENERATOR: ankreuzen legt den open_deck-Button für den Ordner an, abwählen entfernt ihn —
# einheitlich wie alles andere. So muss man für einen Ordner keinen „Eigenen Button" mehr von Hand bauen.
FOLDERS = {
    "id": "folders", "emoji": "📁", "label": "Ordner", "base": True,
    "description": "Jeder angelegte Ordner (Sub-Deck) als Öffnen-Button — ankreuzen legt den Button an, "
                   "abwählen entfernt ihn. Das Aussehen ist frei (z.B. die Health-Ampel per Aussehen-einfügen).",
    "actions": [], "monitors": [],
}

# ── Generische Fremd-App-/Hardware-Integrationen (jeder Host kann sie haben) ───────────────────
CORE_INTEGRATIONS = [
    {
        "id": "obs", "emoji": "🎬", "label": "OBS",
        "description": "Szenen wechseln, Quellen ein-/ausblenden, Stream/Aufnahme steuern (obs-websocket).",
        "actions": ["obs"], "monitors": ["obs_scene", "obs_source_visible"],
        "requires": "OBS läuft + WebSocket-Server aktiv (Standard 127.0.0.1:4455).",
        "generator": {"endpoint": "/api/streamdeck/generate/obs_scenes",
                      "label": "🎬 OBS-Szenen-Buttons generieren"},
    },
    {
        "id": "wavelink", "emoji": "🎚", "label": "Wave Link",
        "description": "Elgato Wave Link: Mixer/Fader, Mute, Live-VU, Main-Output.",
        "actions": ["wavelink"],
        "monitors": ["wavelink_meter", "wavelink_level", "wavelink_mute", "wavelink_main_output"],
        "requires": "Elgato Wave Link läuft (lokaler JSON-RPC-Port wird automatisch gefunden).",
        "generator": {"endpoint": "/api/streamdeck/wavelink/build",
                      "label": "🎚 Wave-Link-Fader generieren"},
    },
    {
        "id": "hwinfo", "emoji": "🌡", "label": "HWiNFO",
        "description": "Hardware-Sensoren (Temperaturen, Takt, Auslastung) als Wert/Graph/Gauge.",
        "actions": [], "monitors": ["hwinfo"],
        "requires": "HWiNFO läuft mit Registry-/Gadget-Export (kostenlos, kein Admin) — oder optional "
                    "Shared Memory (HWiNFO-Pro).",
        "generator": {"endpoint": "/api/streamdeck/generate/hwinfo",
                      "label": "📊 HWiNFO-Sensor-Buttons generieren", "opt": "hwinfo_render"},
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
        "generator": {"endpoint": "/api/streamdeck/generate/displayfusion",
                      "label": "🖥 DisplayFusion-Profil-Buttons generieren"},
    },
    {
        "id": "obsbot", "emoji": "📷", "label": "OBSBOT",
        "description": "OBSBOT-Kameras steuern: Presets, Zentrieren, Wake/Sleep, Tracking-Toggle (OSC). "
                       "Steuerung läuft live; der Tracking-Status ist deck-getrieben (OBSBOT meldet ihn "
                       "nicht zurück).",
        "actions": ["obsbot"], "monitors": ["obsbot_cam", "obsbot_track"],
        "requires": "OBSBOT Center läuft + OSC aktiv (UDP-Server, Standard-Port 16284).",
        "generator": {"endpoint": "/api/streamdeck/generate/obsbot",
                      "label": "📷 OBSBOT-Kamera-Buttons generieren", "opt": "obsbot_cameras"},
    },
]


def all_integrations(extra=None):
    """Vollständige Liste: Basis + Windows-Audio + Eigene + Ordner + generische Integrationen + host-injizierte (``extra``)."""
    return [BASE, WINDOWS_AUDIO, CUSTOM, FOLDERS] + list(CORE_INTEGRATIONS) + list(extra or [])


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
