"""
StreamDeck-Service — config-getriebene Button-Registry für ein eigenes
Elgato-Stream-Deck-Plugin.

Philosophie (identisch zu ``bots.py`` / ``monitors.py``): **Registry =
Single-Source-of-Truth**. Das Stream-Deck-Plugin ist absichtlich *dumm* — es
kennt keinen einzigen konkreten Button. Es rendert nur, was die Host-App ihm
über SSE pusht, und feuert beim Tastendruck ``POST /api/streamdeck/press/{id}``.
Die GESAMTE Logik (welche Aktion, welche Überwachung, welcher Zustand →
welche Farbe) liegt hier. Neuer Button = ein Eintrag in
``runtime/streamdeck_buttons.json`` (per Editor anlegbar) — KEINE
Plugin-Änderung, kein Stream-Deck-Reinstall.

Lifecycle wie die anderen Services: ``async start()`` / ``async stop()``,
publiziert auf den EventBus (Topic ``streamdeck:buttons``).

──────────────────────────────────────────────────────────────────────────────
Datenmodell (2026-06-13/v2 — Shared-Pool): ZWEI getrennte Ebenen.

(1) ``buttons`` = globaler FUNKTIONS-POOL — nur „was tut der Button"; kein Tablet-/
    Deck-Belang. Eine Liste davon in der Registry-JSON:

    {
      "id":     "obs_rec",                 # stabiler Schlüssel, eindeutig
      "label":  "Aufnahme",                # Anzeigename (Fallback-/Pool-Name)
      "action": { "type": "...", ... },    # was bei Tastendruck passiert
      "monitor":{ "type": "...", ... },    # was die Darstellung treibt
      "states": [ {"when": {...}, "title","icon","image","color"} ], # Wert → Look
      "default":{ "title","icon","image","color" }, # Fallback wenn kein State matcht
      "refresh_seconds": 10  # optional: eigener Refresh-Takt; fehlt = globaler Takt
    }

(2) ``decks`` = eigenständige Ansichts-TEMPLATES (Tablet/Touch). Jedes Deck:

    { "id","label","icon",
      "layout":     { cols, button_size, gap, font_scale, show_label, label_pos,
                      show_title, frame, show_category_titles },   # PRO DECK
      "categories": ["Steuerung", ...],                            # PRO DECK
      "items":      [ {"button":"obs_rec","category":"OBS",
                       "style":{frame,label,label_pos,title}, "hidden":false} ] }
      #  Reihenfolge der items = Render-Reihenfolge; Vorhandensein = Mitgliedschaft.

Ein Pool-Button darf in MEHREREN Decks als Item liegen (je Deck eigene category/
style/hidden/Reihenfolge). Die Auswertung (``_resolved``) ist global per Button-id —
die Tablet-Ansicht schlägt pro Item ``resolved[item.button]`` nach. Das physische
Stream-Deck-Plugin nutzt nur den Pool (+ /resolved) und ignoriert Decks komplett.

Refresh: ein globaler Eval-Loop rechnet alle Buttons neu und pusht EINMAL. Ohne
``refresh_seconds`` läuft ein Button im globalen Takt (siehe ``set_tick``); mit
Override nur so oft wie angegeben (kann schneller ODER langsamer als global sein —
die Loop-Granularität passt sich ans kürzeste Intervall an). poll-Monitore haben
zusätzlich ihr eigenes HTTP-Cache-``interval`` (wie oft die URL neu geholt wird).

Pro State optional ein ``image`` (z.B. ``/static/sd_icons/mic-muted.png``):
ein fertiges, von der Host-App ausgeliefertes PNG, das das Plugin bildschirmfüllend
auf die Taste rendert (Text+Label gebacken). Ohne ``image`` fällt das Plugin auf
das Emoji+Titel-Canvas-Compositing (``icon``/``title``/``color``) zurück.

GENERISCHE Aktions-Typen (``action.type``) im Kern:
  • launch        {"path":"C:/…/app.exe","args":"…"}      → Programm/Datei/Verknüpfung starten
  • http          {"method":"POST","url":"...","body":{}} → beliebiger HTTP-Call
  • flag_toggle   {"flag":"do_not_disturb.flag"}          → Flag im runtime-Verzeichnis an/aus
  • flag_set      {"flag":"trigger.flag"}                 → Flag IMMER setzen (Konsument löscht es)
  • displayfusion {"profile":"3 Monitore"}                → DisplayFusion-Monitorprofil laden
  • media         {"action":"playpause"}                  → Media-Taste (playpause/next/prev/
                                                            volup/voldown/mute), Windows-nativ
  • hotkey        {"keys":"ctrl+shift+m"}                 → beliebige Tastenkombo senden
  • none                                                   → reiner Anzeige-Button

GENERISCHE Monitor-Typen (``monitor.type``) — was die Button-Darstellung treibt:
  • flag          {"flag":"do_not_disturb.flag"}          → bool (Flag existiert)
  • file_field    {"file":"state.json","path":"is_live"}  → Wert aus lokaler JSON
  • sse_field     {"topic":"health","path":"level"}       → letztes Bus-Event
  • poll          {"url":"http://...","path":"a.b","interval":10}
                                                          → JSON von URL (periodisch)
  • displayfusion_profile {}                              → Name des aktiven DF-Profils
  • none                                                   → zustandslos

Eine Host-App kann über ``register_action`` / ``register_monitor`` (bzw. den Hook
``_register_extra_handlers``) weitere, app-spezifische Typen ergänzen.

State-Match (``states[].when.op``): any | truthy | falsy | eq | ne |
  gt | lt | gte | lte | contains. Erster passender State gewinnt, sonst
  ``default``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("deckcore")

# DeckCore ist standalone-fähig: KEINE Annahme über eine bestimmte Host-Verzeichnisstruktur.
# Basis-Pfade kommen über den Konstruktor (runtime_dir / flags_dir / files_base).
_PKG_DIR = Path(__file__).resolve().parent

_TICK_SEC = 1.5            # Default-Basis-Takt der Neuberechnung (global, einstellbar)
_TICK_MIN, _TICK_MAX = 0.3, 10.0   # Klemmgrenzen für die globale Rate
_REFRESH_MIN, _REFRESH_MAX = 0.3, 600.0   # Klemmgrenzen für den Pro-Button-Override
_HTTP_TIMEOUT = 4.0       # Sekunden für poll/http
_PROC_CACHE_TTL = 1.0     # Sekunden: streamdeck-interner Prozess-Status-Cache (Anti-tasklist-Sturm)

# Deck-Layout = PRO DECK (Raster/Stil). Jedes Deck hat sein EIGENES Layout (Spalten/Größe/
# Gap/Schrift) + eigene Stil-Defaults; pro Item (item.style im Deck) überschreibbar. Rein
# optisch — ändert KEINE Button-Funktion. cols=0 → responsiv (auto-fill).
# „hidden" ist KEINE Layout-Eigenschaft mehr → pro Item (item.hidden), weil ein Button auf
# Deck A sichtbar und auf Deck B ausgeblendet sein kann.
_LAYOUT_DEFAULT = {
    "cols": 0,            # 0 = auto (responsiv), sonst feste Spaltenzahl
    "button_size": 116,   # px Kachelgröße
    "gap": 12,            # px Abstand
    "font_scale": 1.0,    # Skalierung Icon/Titel/Label
    # ── Stil-DEFAULTS des Decks (pro Item via item.style überschreibbar) ──
    "show_label": True,           # Button-Name anzeigen (Default)
    "label_pos": "bottom",        # "top" | "bottom" (Default)
    "show_title": True,           # großer Titel-Text anzeigen (Default)
    "frame": True,                # True = Kachel mit Rahmen/Box; False = nur Symbol (größer) (Default)
    "show_category_titles": True, # Kategorie-Überschriften am Deck anzeigen
}
_LAYOUT_BOUNDS = {  # (min, max) für die numerischen Felder
    "cols": (0, 12), "button_size": (60, 260), "gap": (0, 48), "font_scale": (0.6, 2.0),
}
_LAYOUT_BOOLS = ("show_label", "show_title", "frame", "show_category_titles")
# Pro-Item-Stil-Felder (was ein Item im Deck an Stil überschreiben darf).
# title_pos = Position des großen Titel-Texts (über dem Bild), "top"|"bottom" (wie Stream Deck).
_STYLE_KEYS = ("frame", "label", "label_pos", "title", "title_pos")


def _clamp_num(v, lo, hi, fallback):
    try:
        return max(lo, min(hi, type(fallback)(v)))
    except (TypeError, ValueError):
        return fallback


def _clamp_tick(value: Any, fallback: float = _TICK_SEC) -> float:
    try:
        return max(_TICK_MIN, min(_TICK_MAX, float(value)))
    except (TypeError, ValueError):
        return fallback


def _clamp_refresh(value: Any) -> Optional[float]:
    """Pro-Button-Refresh-Override klemmen. None = kein Override (globaler Takt)."""
    if value is None or value == "":
        return None
    try:
        return max(_REFRESH_MIN, min(_REFRESH_MAX, float(value)))
    except (TypeError, ValueError):
        return None

# Fertige State-Icons (288×288-PNG mit gebackenem Text+Label), ausgeliefert von
# der Host-App unter /static/sd_icons/. Das Plugin lädt das Bild und rendert es
# bildschirmfüllend auf die Taste (ersetzt das Emoji+Titel-Canvas-Compositing).
_ICON = "/static/sd_icons/"   # + "<name>.png"

# ── Decks: eigenständige Ansichts-TEMPLATES (Shared-Pool-Modell, 2026-06-13/v2) ──────
# Ein Deck ist ein komplett unabhängiges Tablet-Panel mit EIGENEM Layout (Raster/Größe/
# Gap/Schrift/Stil-Defaults), EIGENEN Kategorien und einer geordneten ITEM-Liste. Ein Item
# referenziert per ``button`` einen Button aus dem GLOBALEN Funktions-Pool und trägt die
# DECK-spezifische Platzierung (category / style / hidden). Damit darf derselbe Pool-Button
# auf MEHREREN Decks liegen — je Deck anders platziert/gestylt. Die Button-DEFINITIONEN
# (action/monitor/states) sind global (Pool) und kennen kein Deck. Die physische Stream-
# Deck-Hardware ignoriert Decks (jede Taste referenziert eine Button-id direkt) — Decks sind
# rein eine Tablet-/Touch-Ansichts-Sache. Das Default-Deck kann nie gelöscht werden.
_DEFAULT_DECK = "main"
_DEFAULT_DECK_META = {"id": _DEFAULT_DECK, "label": "Hauptdeck", "icon": "🎛"}

# obs_scene-Monitor: ein GEMEINSAMER Cache der aktiven OBS-Szene für ALLE Szenen-Buttons
# (statt pro-Button-Poll). Quelle = der billige In-Memory-Snapshot von obs_control über
# /api/obs/current_scene (kein OBS-WebSocket-Call pro Abfrage). URL aus ``self_base_url``.
_OBS_SCENE_TTL = 1.0   # s

# ── DisplayFusion-Integration ─────────────────────────────────────────────────
# Monitor-Profile liegen in der Registry unter HKCU\…\DisplayFusion\MonitorConfig\<guid>
# (Value ``Name`` = Profilname, ``DateTimeLastUsedUTC`` = .NET-Ticks des letzten Ladens).
# Das zuletzt geladene Profil = „aktives" Profil (Highlight). Geladen wird per
# ``DisplayFusionCommand.exe -monitorloadprofile "<Name>"``.
_DF_REG_PATH = r"Software\Binary Fortress Software\DisplayFusion\MonitorConfig"
_DF_CMD_CANDIDATES = (
    r"C:\Program Files\DisplayFusion\DisplayFusionCommand.exe",
    r"C:\Program Files (x86)\DisplayFusion\DisplayFusionCommand.exe",
)
_DF_ACTIVE_TTL = 2.0   # s — Cache für das aktive Profil (Eval-Loop)


def _df_command_path() -> Optional[str]:
    for p in _DF_CMD_CANDIDATES:
        if Path(p).exists():
            return p
    return None


def _df_list_profiles() -> list[dict]:
    """Alle DisplayFusion-Monitor-Profile aus der Registry: [{name, last_used}], aktiv-sortiert.
    Aktiv = größtes DateTimeLastUsedUTC (zuletzt geladen)."""
    try:
        import winreg
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _DF_REG_PATH) as base:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(base, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(base, sub) as k:
                        name = _df_reg_val(k, "Name")
                        if not name:
                            continue
                        try:
                            last = int(_df_reg_val(k, "DateTimeLastUsedUTC") or 0)
                        except (TypeError, ValueError):
                            last = 0
                        out.append({"name": str(name), "last_used": last})
                except OSError:
                    continue
    except OSError:
        return []
    out.sort(key=lambda p: p["last_used"], reverse=True)
    for idx, p in enumerate(out):
        p["active"] = (idx == 0 and p["last_used"] > 0)
    return out


def _df_reg_val(key, name: str):
    import winreg
    try:
        v, _ = winreg.QueryValueEx(key, name)
        return v
    except OSError:
        return None


def _slug(s: str) -> str:
    """ASCII-Slug für Button-/Deck-IDs (a-z0-9 + Unterstrich), wie die Frontend-Normierung."""
    out: list[str] = []
    for ch in str(s).strip().lower():
        if ("a" <= ch <= "z") or ("0" <= ch <= "9"):
            out.append(ch)
        elif out and out[-1] != "_":
            out.append("_")
    return "".join(out).strip("_") or "x"


# Default-Buttons sind HÜLLEN-Sache: die Hülle übergibt ihre eigenen über
# ``default_buttons=`` an den Konstruktor. Der generische Kern bringt KEINE mit.


def _dig(obj: Any, path: str) -> Any:
    """Punkt-Pfad in verschachteltem dict/list lesen ('a.b.0.c')."""
    if not path:
        return obj
    cur = obj
    for part in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _match(value: Any, when: dict) -> bool:
    op = (when or {}).get("op", "any")
    target = (when or {}).get("value")
    try:
        if op == "any":
            return True
        if op == "truthy":
            return bool(value)
        if op == "falsy":
            return not bool(value)
        if op == "eq":
            return value == target
        if op == "ne":
            return value != target
        if op == "gt":
            return float(value) > float(target)
        if op == "lt":
            return float(value) < float(target)
        if op == "gte":
            return float(value) >= float(target)
        if op == "lte":
            return float(value) <= float(target)
        if op == "contains":
            return str(target) in str(value)
    except (TypeError, ValueError):
        return False
    return False


# ── Eingabe-Simulation (generische Capabilities media/hotkey) — Windows-nativ via ctypes ──────
# Media-Tasten + beliebige Hotkey-Kombos ans fokussierte Fenster/OS senden. Kein schwerer Dep.
_MEDIA_VK = {
    "playpause": 0xB3, "play": 0xB3, "pause": 0xB3, "toggle": 0xB3,
    "next": 0xB0, "nexttrack": 0xB0, "prev": 0xB1, "previous": 0xB1, "prevtrack": 0xB1,
    "stop": 0xB2, "mute": 0xAD, "volup": 0xAF, "volume_up": 0xAF,
    "voldown": 0xAE, "volume_down": 0xAE,
}
_VK_MODS = {"ctrl": 0x11, "control": 0x11, "alt": 0x12, "menu": 0x12,
            "shift": 0x10, "win": 0x5B, "super": 0x5B, "cmd": 0x5B, "meta": 0x5B}
_VK_SPECIAL = {
    "enter": 0x0D, "return": 0x0D, "esc": 0x1B, "escape": 0x1B, "space": 0x20, "tab": 0x09,
    "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "insert": 0x2D, "ins": 0x2D, "plus": 0xBB, "minus": 0xBD,
}


def _vk_for_token(tok: str):
    """Ein Hotkey-Token (z.B. 'ctrl', 'f5', 'a', 'up') → Windows-VK-Code, oder None."""
    tok = str(tok).strip().lower()
    if not tok:
        return None
    if tok in _VK_MODS:
        return _VK_MODS[tok]
    if tok in _VK_SPECIAL:
        return _VK_SPECIAL[tok]
    if len(tok) == 1:
        c = tok.upper()
        if ("A" <= c <= "Z") or ("0" <= c <= "9"):
            return ord(c)
    if tok[0] == "f" and tok[1:].isdigit():
        n = int(tok[1:])
        if 1 <= n <= 24:
            return 0x70 + (n - 1)
    return None


def _parse_hotkey(spec: str) -> list:
    """'ctrl+shift+m' → [VK_CONTROL, VK_SHIFT, 0x4D]. Unbekanntes Token → [] (= ungültig)."""
    parts = [p for p in str(spec or "").replace(" ", "").split("+") if p]
    vks: list = []
    for p in parts:
        vk = _vk_for_token(p)
        if vk is None:
            return []
        vks.append(vk)
    return vks


def _send_vk_combo(vks: list) -> bool:
    """VK-Codes als Kombo drücken (alle runter in Reihenfolge, hoch in Gegenreihenfolge).
    Windows-nativ via ctypes; auf Nicht-Windows → False (kein keybd_event verfügbar)."""
    if not vks:
        return False
    try:
        import ctypes
        u = ctypes.windll.user32           # nur Windows; sonst AttributeError → False
        KEYEVENTF_KEYUP = 0x0002
        for vk in vks:
            u.keybd_event(vk, 0, 0, 0)
        for vk in reversed(vks):
            u.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        return True
    except Exception:  # noqa: BLE001
        return False


class DeckCoreService:
    """Generischer Stream-Deck-Kern: Registry + Monitor-Evaluation + Aktions-Ausführung.
    Eine Hülle (z.B. die RigzDeck-App) erbt davon und registriert über
    ``_register_extra_handlers`` / ``_extra_options`` ihre eigenen Capabilities + seedet ihre
    Default-Buttons (``default_buttons=``). Der Kern selbst kennt keine konkrete Host-App."""

    def __init__(self, bus, *, runtime_dir: Path | None = None,
                 flags_dir: Path | None = None, files_base: Path | None = None,
                 self_base_url: str = "http://127.0.0.1:7883",
                 default_buttons: list | None = None):
        self.bus = bus
        # Basis für HTTP-Selfcalls (z.B. obs/alert in einer Hülle). Generische Handler brauchen sie nicht.
        self._self_base = str(self_base_url or "").rstrip("/")
        self._runtime = Path(runtime_dir) if runtime_dir else (_PKG_DIR / "runtime")
        # Pfad-Basen der generischen flag-/file_field-Capabilities (eine Hülle gibt ihre eigenen
        # Verzeichnisse rein; Default = das eigene runtime-Verzeichnis).
        self._flags_dir = Path(flags_dir) if flags_dir else self._runtime
        self._files_base = Path(files_base) if files_base else self._runtime
        self._default_buttons = list(default_buttons or [])   # Hülle seedet ihre Default-Buttons
        self._file = self._runtime / "streamdeck_buttons.json"
        self._buttons: list[dict] = []   # GLOBALER Funktions-Pool (id/label/action/monitor/states/default)
        self._removed: set[str] = set()   # bewusst gelöschte Default-Button-IDs → NIE re-seeden
        self._decks: list[dict] = []   # Deck-TEMPLATES [{id,label,icon,layout,categories,items}] (Default-Deck garantiert in _load)
        self._tick = float(_TICK_SEC)              # globale Aktualisierungs-Rate (einstellbar)
        self._resolved: dict[str, dict] = {}      # id → {label,title,icon,image,color}
        self._last_eval: dict[str, float] = {}    # button-id → monotonic der letzten Auswertung
        self._sse_cache: dict[str, Any] = {}      # topic → letztes Payload
        self._poll_cache: dict[str, Any] = {}     # button-id → (value, last_fetch_ts)
        self._obs_scene_cache: tuple = (None, 0.0)  # (aktive Szene, ts) — von einer obs_scene-Hülle genutzt
        self._df_active_cache: tuple = (None, 0.0)  # (aktives DisplayFusion-Profil, ts) — geteilt
        self._proc_cache: dict[str, Any] = {}     # process → (status_dict, monotonic) — für Hüllen-Prozess-Monitore
        # ── Capability-Registry (Handler-Naht) ───────────────────────────────
        # action.type / monitor.type → Handler. Der Kern registriert die GENERISCHEN Handler;
        # eine Hülle ergänzt über _register_extra_handlers() ihre eigenen (z.B. Prozess-Steuerung).
        self._action_handlers: dict[str, Any] = {}
        self._monitor_handlers: dict[str, Any] = {}
        self._register_core_handlers()
        self._register_extra_handlers()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._eval_task: Optional[asyncio.Task] = None
        self._sse_task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._load()

    # ── Capability-Registry: Handler registrieren ────────────────────────
    def register_action(self, atype: str, handler) -> None:
        """Aktions-Handler registrieren. ``handler(action: dict, btn: dict) -> {success,message}``.
        Erneute Registrierung überschreibt (so kann eine Hülle z.B. ``obs`` durch einen direkten
        Client ersetzen)."""
        self._action_handlers[str(atype)] = handler

    def register_monitor(self, mtype: str, handler) -> None:
        """Monitor-Handler registrieren. ``handler(mon: dict, btn: dict) -> Wert`` (für State-Match)."""
        self._monitor_handlers[str(mtype)] = handler

    def _self_url(self, path: str) -> str:
        """URL für einen HTTP-Selfcall an die eigene App (Basis aus ``self_base_url``)."""
        return self._self_base + path

    def _register_core_handlers(self) -> None:
        """Generische DeckCore-Capabilities — laufen überall, auch in einer Standalone-App."""
        A, M = self.register_action, self.register_monitor
        A("none", self._act_none)
        A("launch", self._act_launch)
        A("displayfusion", self._act_displayfusion)
        A("media", self._act_media)
        A("hotkey", self._act_hotkey)
        A("flag_toggle", self._act_flag_toggle)
        A("flag_set", self._act_flag_set)
        A("http", self._act_http_action)
        M("none", self._mon_none)
        M("flag", self._mon_flag)
        M("file_field", self._mon_file_field)
        M("poll", self._mon_poll)
        M("sse_field", self._mon_sse_field)
        M("displayfusion_profile", self._mon_displayfusion_profile)

    def _register_extra_handlers(self) -> None:
        """Hook für Hüllen: zusätzliche (hüllen-spezifische) Capabilities registrieren.
        Im reinen Kern ein No-op — die generische Teilmenge kommt über _register_core_handlers()."""
        pass

    def _migrate_buttons(self, data: list) -> bool:
        """Hook für Hüllen: hüllen-spezifische Legacy-Migrationen am rohen Button-Pool
        (z.B. umbenannte Monitor-Typen). Im reinen Kern ein No-op. Rückgabe True, wenn
        etwas geändert wurde (dann wird die Registry neu gespeichert)."""
        return False

    # ── Registry-Persistenz ──────────────────────────────────────────────
    def _load(self) -> None:
        data: list = []
        raw_decks = None
        legacy_layout = None
        legacy_cats = None
        if self._file.exists():
            try:
                raw = json.loads(self._file.read_text(encoding="utf-8-sig"))
                if isinstance(raw, dict):
                    data = raw.get("buttons", [])
                    self._tick = _clamp_tick(raw.get("tick_seconds", self._tick), self._tick)
                    if isinstance(raw.get("removed"), list):
                        self._removed = {str(x) for x in raw["removed"]}
                    if isinstance(raw.get("decks"), list):
                        raw_decks = raw["decks"]
                    # Legacy-Top-Level (v1): EIN globales Layout + EINE globale Kategorie-Liste.
                    if isinstance(raw.get("layout"), dict):
                        legacy_layout = raw["layout"]
                    if isinstance(raw.get("categories"), list):
                        legacy_cats = [str(x) for x in raw["categories"]]
                else:
                    data = raw
            except Exception as e:  # noqa: BLE001
                log.warning("streamdeck_buttons.json unlesbar: %s", e)
                data = []
        # Additives Seeding + Schema-Migration der Default-Buttons (Funktions-Pool). Fehlende
        # ergänzen; bestehende NUR bei höherem "_v" ersetzen (Schema-Upgrade). Buttons ohne
        # "_v" bleiben unangetastet → User-Anpassungen an eigenen Buttons gehen nicht verloren.
        by_id = {b.get("id"): i for i, b in enumerate(data)}
        seeded = False
        newly_seeded: list[dict] = []   # frisch ergänzte Default-Buttons → aufs Default-Deck legen
        for d in self._default_buttons:
            fresh = json.loads(json.dumps(d))
            if d["id"] in self._removed:
                continue   # User hat diesen Default bewusst gelöscht → nie wieder anlegen
            if d["id"] not in by_id:
                data.append(fresh); seeded = True; newly_seeded.append(fresh)
            else:
                cur = data[by_id[d["id"]]]
                if int(d.get("_v", 0)) > int(cur.get("_v", 0)):
                    # Funktion auffrischen; etwaige Platzierungs-Reste behalten (werden eh migriert).
                    for keep in ("deck", "group", "style"):
                        if keep in cur and keep not in fresh:
                            fresh[keep] = cur[keep]
                    data[by_id[d["id"]]] = fresh; seeded = True
        # Hüllen-spezifische Legacy-Migrationen am rohen Pool (Hook; Kern = No-op).
        if self._migrate_buttons(data):
            seeded = True

        # Platzierungs-Felder (deck/group/style) VOR dem Strippen für die Migration sichern.
        order = [b.get("id") for b in data if b.get("id")]
        placement = {b["id"]: {"deck": b.get("deck"), "group": b.get("group"),
                               "style": b.get("style")}
                     for b in data if b.get("id")}
        # Pool = reine FUNKTION (Platzierung raus → wandert in die Deck-Items).
        self._buttons = []
        for b in data:
            if not b.get("id"):
                continue
            for f in ("deck", "group", "style"):
                b.pop(f, None)
            self._buttons.append(b)
        valid_ids = {b["id"] for b in self._buttons}

        # ── Decks bestimmen: schon v2 (haben items/layout) → nur sanitizen; sonst migrieren ──
        migrated = False
        decks_are_v2 = bool(raw_decks) and all(
            isinstance(d, dict) and ("items" in d or "layout" in d) for d in raw_decks)
        if decks_are_v2:
            self._decks = self._sanitize_decks(raw_decks, valid_ids)
        else:
            self._decks = self._migrate_to_decks(order, placement, raw_decks,
                                                 legacy_layout, legacy_cats, valid_ids)
            migrated = True

        # Default-Deck garantieren + frisch geseedete Default-Buttons aufs Default-Deck legen.
        self._decks = self._ensure_default_deck(self._decks)
        placed = {it["button"] for d in self._decks for it in d.get("items", [])}
        seeded_placed = False
        for fresh in newly_seeded:
            bid = fresh.get("id")
            if bid and bid in valid_ids and bid not in placed:
                dd = self._deck(_DEFAULT_DECK)
                cat = str(fresh.get("group") or "")
                if cat and cat not in dd["categories"]:
                    dd["categories"].append(cat)
                dd["items"].append({"button": bid, "category": cat, "style": {}, "hidden": False})
                placed.add(bid); seeded_placed = True

        if seeded or migrated or seeded_placed or not self._file.exists():
            self._save()

    def _migrate_to_decks(self, order, placement, raw_decks, legacy_layout,
                          legacy_cats, valid_ids) -> list[dict]:
        """v1→v2-Migration (oder Frischinstallation): aus den alten Platzierungs-Feldern
        (button.deck/group/style) + globalem Layout/Kategorien echte Deck-Templates bauen.
        Jedes Deck bekommt eine KOPIE des alten Layouts + der Kategorien → Tag 1 sieht optisch
        identisch aus; nur ist das Layout jetzt pro Deck frei änderbar."""
        base_layout = (self._sanitize_layout(legacy_layout, _LAYOUT_DEFAULT)
                       if legacy_layout else dict(_LAYOUT_DEFAULT))
        legacy_hidden = {str(x) for x in (legacy_layout or {}).get("hidden", [])}
        if legacy_cats is not None:
            cats = list(legacy_cats)
        else:   # keine globale Liste → aus den vorhandenen Gruppen in Auftritts-Reihenfolge
            cats = []
            for bid in order:
                g = (placement.get(bid, {}).get("group") or "").strip()
                if g and g not in cats:
                    cats.append(g)
        # Alte (v1-)Deck-Metas (id/label/icon) übernehmen; Default-Deck garantieren.
        metas: list[dict] = []
        for d in (raw_decks or []):
            if isinstance(d, dict):
                did = _slug(d.get("id") or d.get("label") or "")
                if did and not any(m["id"] == did for m in metas):
                    metas.append({"id": did, "label": str(d.get("label") or did),
                                  "icon": str(d.get("icon") or "🎛")})
        if not any(m["id"] == _DEFAULT_DECK for m in metas):
            metas.insert(0, dict(_DEFAULT_DECK_META))
        decks = [{**m, "layout": dict(base_layout), "categories": list(cats), "items": []}
                 for m in metas]
        deck_by_id = {d["id"]: d for d in decks}
        for bid in order:
            pl = placement.get(bid, {})
            deck = deck_by_id.get(pl.get("deck") or _DEFAULT_DECK) or deck_by_id[_DEFAULT_DECK]
            deck["items"].append({
                "button": bid,
                "category": str(pl.get("group") or ""),
                "style": {k: v for k, v in (pl.get("style") or {}).items() if k in _STYLE_KEYS},
                "hidden": bid in legacy_hidden,
            })
        return self._sanitize_decks(decks, valid_ids)

    def _save(self) -> None:
        try:
            self._runtime.mkdir(parents=True, exist_ok=True)
            self._file.write_text(
                json.dumps({"buttons": self._buttons, "tick_seconds": round(self._tick, 2),
                            "decks": self._decks,
                            "removed": sorted(self._removed)},
                           ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:  # noqa: BLE001
            log.error("streamdeck_buttons.json schreiben fehlgeschlagen: %s", e)

    # ── Deck-Templates (eigenständige Ansichten, Shared-Pool-Modell) ─────
    def _sanitize_layout(self, patch: dict, base: dict) -> dict:
        """Layout-Patch auf eine Basis anwenden + klemmen. ``base`` = aktuelles Deck-Layout
        (oder ``_LAYOUT_DEFAULT``). Es bleiben nur bekannte Layout-Felder übrig."""
        out = dict(base or _LAYOUT_DEFAULT)
        patch = patch or {}
        for k, (lo, hi) in _LAYOUT_BOUNDS.items():
            if k in patch:
                out[k] = _clamp_num(patch[k], lo, hi, _LAYOUT_DEFAULT[k])
        for k in _LAYOUT_BOOLS:
            if k in patch:
                out[k] = bool(patch[k])
        if patch.get("label_pos") in ("top", "bottom"):
            out["label_pos"] = patch["label_pos"]
        return {k: out.get(k, _LAYOUT_DEFAULT[k]) for k in _LAYOUT_DEFAULT}

    def _sanitize_item(self, it, valid_ids: set, seen: set) -> Optional[dict]:
        bid = str((it or {}).get("button") or "")
        if not bid or bid not in valid_ids or bid in seen:
            return None
        seen.add(bid)
        raw_style = (it or {}).get("style")
        raw_style = raw_style if isinstance(raw_style, dict) else {}
        style = {k: raw_style[k] for k in _STYLE_KEYS if k in raw_style}
        return {"button": bid, "category": str((it or {}).get("category") or ""),
                "style": style, "hidden": bool((it or {}).get("hidden"))}

    def _sanitize_deck(self, d, valid_ids: set) -> Optional[dict]:
        if not isinstance(d, dict):
            return None
        did = _slug(d.get("id") or d.get("label") or "")
        if not did:
            return None
        cats, cseen = [], set()
        for c in (d.get("categories") or []):
            s = str(c).strip()
            if s and s not in cseen:
                cseen.add(s); cats.append(s)
        items, iseen = [], set()
        for it in (d.get("items") or []):
            si = self._sanitize_item(it, valid_ids, iseen)
            if si:
                items.append(si)
        return {"id": did, "label": str(d.get("label") or did).strip() or did,
                "icon": str(d.get("icon") or "🎛"),
                "layout": self._sanitize_layout(d.get("layout") or {}, _LAYOUT_DEFAULT),
                "categories": cats, "items": items}

    def _sanitize_decks(self, decks, valid_ids: set) -> list[dict]:
        out, seen = [], set()
        for d in (decks or []):
            sd = self._sanitize_deck(d, valid_ids)
            if sd and sd["id"] not in seen:
                seen.add(sd["id"]); out.append(sd)
        return out

    def _fresh_deck(self, did: str, label: str, icon: str) -> dict:
        return {"id": did, "label": label, "icon": icon,
                "layout": dict(_LAYOUT_DEFAULT), "categories": [], "items": []}

    def _ensure_default_deck(self, decks) -> list[dict]:
        decks = list(decks or [])
        if not any(d.get("id") == _DEFAULT_DECK for d in decks):
            decks = [self._fresh_deck(_DEFAULT_DECK, _DEFAULT_DECK_META["label"],
                                      _DEFAULT_DECK_META["icon"])] + decks
        return decks

    def _deck_ids(self) -> set:
        return {d["id"] for d in self._decks}

    def _deck(self, deck_id: str) -> Optional[dict]:
        return next((d for d in self._decks if d["id"] == str(deck_id or "")), None)

    def _valid_ids(self) -> set:
        return {b["id"] for b in self._buttons if b.get("id")}

    def decks(self) -> list[dict]:
        return [json.loads(json.dumps(d)) for d in self._decks]

    def set_decks(self, decks: list) -> dict:
        """Deck-Existenz/Reihenfolge/Label/Icon setzen (Deck-Manager). Layout/Kategorien/Items
        BLEIBEN je Deck erhalten (per id gemerged); unbekannte ids = neue, leere Decks."""
        existing = {d["id"]: d for d in self._decks}
        out, seen = [], set()
        for d in (decks or []):
            if not isinstance(d, dict):
                continue
            did = _slug(d.get("id") or d.get("label") or "")
            if not did or did in seen:
                continue
            seen.add(did)
            label = str(d.get("label") or did).strip() or did
            icon = str(d.get("icon") or "🎛")
            if did in existing:
                cur = dict(existing[did]); cur["label"] = label; cur["icon"] = icon
                out.append(cur)
            else:
                out.append(self._fresh_deck(did, label, icon))
        self._decks = self._ensure_default_deck(out)
        self._save(); self._publish_cfg()
        return {"ok": True, "decks": self.decks()}

    def add_deck(self, label: str, icon: str = "🎛", copy_from: str = "") -> dict:
        """Neues Deck. ``copy_from`` = id eines bestehenden Decks → dessen Layout+Kategorien+
        Items klonen (= „Deck duplizieren"). Sonst leeres Deck mit Default-Layout."""
        label = str(label or "").strip() or "Deck"
        ids = self._deck_ids()
        base = _slug(label); did = base; n = 2
        while did in ids:
            did = f"{base}_{n}"; n += 1
        icon = str(icon or "🎛")
        src = self._deck(copy_from) if copy_from else None
        if src is not None:
            deck = {"id": did, "label": label, "icon": icon,
                    "layout": dict(src["layout"]), "categories": list(src["categories"]),
                    "items": json.loads(json.dumps(src["items"]))}
        else:
            deck = self._fresh_deck(did, label, icon)
        self._decks.append(deck)
        self._save(); self._publish_cfg()
        return {"ok": True, "id": did, "decks": self.decks()}

    def delete_deck(self, deck_id: str) -> dict:
        """Deck löschen. Die Pool-Buttons bleiben (sie können auf anderen Decks liegen bzw.
        im Pool verfügbar bleiben). Das Default-Deck ist unlöschbar."""
        deck_id = str(deck_id or "")
        if deck_id == _DEFAULT_DECK:
            return {"ok": False, "reason": "cannot_delete_default"}
        if not self._deck(deck_id):
            return {"ok": False, "reason": "unknown_deck"}
        self._decks = [d for d in self._decks if d["id"] != deck_id]
        self._save(); self._publish_cfg()
        return {"ok": True, "decks": self.decks()}

    # ── Pro Deck: Layout / Kategorien / Items (Platzierung) ──────────────
    def set_deck_layout(self, deck_id: str, patch: dict) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        deck["layout"] = self._sanitize_layout(patch or {}, deck["layout"])
        self._save(); self._publish_cfg()
        return {"ok": True, "layout": dict(deck["layout"])}

    def set_deck_categories(self, deck_id: str, names: list) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        out, seen = [], set()
        for nm in (names or []):
            s = str(nm).strip()
            if s and s not in seen:
                seen.add(s); out.append(s)
        deck["categories"] = out
        self._save(); self._publish_cfg()
        return {"ok": True, "categories": list(out)}

    def rename_deck_category(self, deck_id: str, old: str, new: str) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        old, new = str(old).strip(), str(new).strip()
        if not new or new == old:
            return {"ok": False, "reason": "invalid"}
        if new in deck["categories"]:
            return {"ok": False, "reason": "exists"}
        deck["categories"] = [new if c == old else c for c in deck["categories"]]
        for it in deck["items"]:
            if it.get("category") == old:
                it["category"] = new
        self._save(); self._publish_cfg()
        return {"ok": True, "categories": list(deck["categories"])}

    def delete_deck_category(self, deck_id: str, name: str) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        name = str(name).strip()
        deck["categories"] = [c for c in deck["categories"] if c != name]
        moved = 0
        for it in deck["items"]:
            if it.get("category") == name:
                it["category"] = ""; moved += 1
        self._save(); self._publish_cfg()
        return {"ok": True, "categories": list(deck["categories"]), "uncategorized": moved}

    def assign_item_category(self, deck_id: str, button_id: str, category: str) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        category = str(category or "").strip()
        if category and category not in deck["categories"]:
            return {"ok": False, "reason": "unknown_category"}
        it = next((x for x in deck["items"] if x["button"] == button_id), None)
        if it is None:
            return {"ok": False, "reason": "not_in_deck"}
        it["category"] = category
        self._save(); self._publish_cfg()
        return {"ok": True, "id": button_id, "category": category}

    def reorder_deck(self, deck_id: str, button_ids: list) -> dict:
        """Item-Reihenfolge eines Decks setzen (Drag&Drop im Raster). Unbekannte ids ignoriert,
        fehlende Items hinten angehängt — kein Item geht verloren."""
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        order = [str(x) for x in (button_ids or [])]
        pos = {bid: i for i, bid in enumerate(order)}
        deck["items"].sort(key=lambda it: pos.get(it["button"], 10_000))
        self._save(); self._publish_cfg()
        return {"ok": True, "order": [it["button"] for it in deck["items"]]}

    def set_item_style(self, deck_id: str, button_id: str, style: dict) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        it = next((x for x in deck["items"] if x["button"] == button_id), None)
        if it is None:
            return {"ok": False, "reason": "not_in_deck"}
        raw = style or {}
        it["style"] = {k: raw[k] for k in _STYLE_KEYS if k in raw}
        self._save(); self._publish_cfg()
        return {"ok": True, "style": dict(it["style"])}

    def set_item_hidden(self, deck_id: str, button_id: str, hidden: bool) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        it = next((x for x in deck["items"] if x["button"] == button_id), None)
        if it is None:
            return {"ok": False, "reason": "not_in_deck"}
        it["hidden"] = bool(hidden)
        self._save(); self._publish_cfg()
        return {"ok": True, "hidden": it["hidden"]}

    def add_item(self, deck_id: str, button_id: str, category: str = "",
                 index: Optional[int] = None) -> dict:
        """Pool-Button auf ein Deck legen (Mitgliedschaft). Idempotent — ein bereits
        vorhandenes Item wird nicht dupliziert."""
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        button_id = str(button_id or "")
        if button_id not in self._valid_ids():
            return {"ok": False, "reason": "unknown_button"}
        if any(it["button"] == button_id for it in deck["items"]):
            return {"ok": True, "already": True}
        category = str(category or "").strip()
        if category and category not in deck["categories"]:
            category = ""
        item = {"button": button_id, "category": category, "style": {}, "hidden": False}
        if index is None or index < 0 or index >= len(deck["items"]):
            deck["items"].append(item)
        else:
            deck["items"].insert(index, item)
        self._save(); self._publish_cfg()
        return {"ok": True, "id": button_id}

    def remove_item(self, deck_id: str, button_id: str) -> dict:
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        before = len(deck["items"])
        deck["items"] = [it for it in deck["items"] if it["button"] != str(button_id or "")]
        self._save(); self._publish_cfg()
        return {"ok": True, "removed": before - len(deck["items"])}

    def populate_obs_scenes(self, deck_id: str, scenes: list, *, group: str = "OBS-Szenen",
                            active_color: str = "#1f9d55", idle_color: str = "#2a2a2a") -> dict:
        """Erzeugt/aktualisiert pro OBS-Szene einen Szenen-Wechsel-Button im POOL (Funktion:
        Szene wechseln + Aktiv-Highlight via obs_scene-Monitor) UND ein Item im Ziel-Deck
        (Platzierung). Stabile Button-id ``scene_<slug>`` → wiederholtes Befüllen aktualisiert
        statt zu duplizieren. Die User-Platzierung im Deck (Kategorie/Stil) bleibt erhalten."""
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        names = [str(s) for s in (scenes or []) if str(s).strip()]
        if not names:
            return {"ok": False, "reason": "no_scenes"}
        if group and group not in deck["categories"]:
            deck["categories"].append(group)
        pool_by_id = {b.get("id"): b for b in self._buttons}
        item_by_id = {it["button"]: it for it in deck["items"]}
        used = set(pool_by_id.keys())
        created = updated = 0
        for name in names:
            bid = "scene_" + _slug(name)
            # Slug-Kollision (zwei Szenen → gleicher Slug) eindeutig machen, aber einen
            # bestehenden Button DERSELBEN Szene wiederverwenden (idempotentes Update).
            if bid in pool_by_id and pool_by_id[bid].get("_scene") != name:
                base = bid; n = 2
                while bid in used:
                    bid = f"{base}_{n}"; n += 1
            fn = {
                "id": bid, "label": name, "_scene": name,
                "action": {"type": "obs", "obs_action": "scene", "scene": name},
                "monitor": {"type": "obs_scene"},
                "states": [
                    {"when": {"op": "eq", "value": name}, "icon": "📺", "title": name, "color": active_color},
                ],
                "default": {"icon": "🎬", "title": name, "color": idle_color},
            }
            existing_fn = pool_by_id.get(bid)
            if existing_fn is not None:
                self._buttons[self._buttons.index(existing_fn)] = fn
            else:
                self._buttons.append(fn); used.add(bid)
            pool_by_id[bid] = fn
            self._removed.discard(bid)
            # Deck-Item (Platzierung) — Szenenname als großer Titel (Label aus). Bereits
            # platziert → Funktion aufgefrischt, User-Platzierung unangetastet.
            if bid in item_by_id:
                updated += 1
            else:
                deck["items"].append({"button": bid, "category": group or "",
                                      "style": {"label": "off"}, "hidden": False})
                item_by_id[bid] = deck["items"][-1]
                created += 1
        self._save(); self._schedule_recompute(); self._publish_cfg()
        return {"ok": True, "deck": deck_id, "created": created, "updated": updated,
                "total": created + updated}

    def displayfusion_profiles(self) -> dict:
        """DisplayFusion-Monitor-Profile (+ aktiv-Markierung) + ob DisplayFusion verfügbar ist."""
        return {"available": bool(_df_command_path()), "profiles": _df_list_profiles()}

    def populate_displayfusion_profiles(self, deck_id: str, *, group: str = "Monitor-Profile",
                                        active_color: str = "#1f9d55", idle_color: str = "#2a2a2a") -> dict:
        """Pro DisplayFusion-Profil einen Lade-Button im POOL (Funktion) + Item im Ziel-Deck.
        Stabile id ``df_<slug>``; das aktive Profil wird live grün (displayfusion_profile-Monitor +
        eq-State). Idempotent; User-Platzierung/Stil bleibt erhalten."""
        deck = self._deck(deck_id)
        if not deck:
            return {"ok": False, "reason": "unknown_deck"}
        profs = _df_list_profiles()
        if not profs:
            return {"ok": False, "reason": "no_profiles"}
        if group and group not in deck["categories"]:
            deck["categories"].append(group)
        pool_by_id = {b.get("id"): b for b in self._buttons}
        item_by_id = {it["button"]: it for it in deck["items"]}
        used = set(pool_by_id.keys())
        created = updated = 0
        for prof in profs:
            name = prof["name"]
            bid = "df_" + _slug(name)
            if bid in pool_by_id and pool_by_id[bid].get("_df_profile") != name:
                base = bid; n = 2
                while bid in used:
                    bid = f"{base}_{n}"; n += 1
            fn = {
                "id": bid, "label": name, "_df_profile": name,
                "action": {"type": "displayfusion", "profile": name},
                "monitor": {"type": "displayfusion_profile"},
                "states": [
                    {"when": {"op": "eq", "value": name}, "icon": "🖥", "title": name, "color": active_color},
                ],
                "default": {"icon": "🖥", "title": name, "color": idle_color},
            }
            existing_fn = pool_by_id.get(bid)
            if existing_fn is not None:
                self._buttons[self._buttons.index(existing_fn)] = fn
            else:
                self._buttons.append(fn); used.add(bid)
            pool_by_id[bid] = fn
            self._removed.discard(bid)
            if bid in item_by_id:
                updated += 1
            else:
                deck["items"].append({"button": bid, "category": group or "",
                                      "style": {}, "hidden": False})
                item_by_id[bid] = deck["items"][-1]
                created += 1
        self._save(); self._schedule_recompute(); self._publish_cfg()
        return {"ok": True, "deck": deck_id, "created": created, "updated": updated,
                "total": created + updated}

    # ── Öffentliche API (Endpoints rufen das) ────────────────────────────
    def list_buttons(self) -> list[dict]:
        return [json.loads(json.dumps(b)) for b in self._buttons]

    def registry(self) -> dict:
        """Volle Registry inkl. Auswahl-Optionen für den Property-Inspector/Tab.
        ``buttons`` = globaler Funktions-Pool; ``decks`` = eigenständige Templates (jedes mit
        eigenem ``layout``/``categories``/``items``). Kein globales Top-Level-Layout mehr."""
        return {"buttons": self.list_buttons(), "options": self.options(),
                "tick_seconds": round(self._tick, 2),
                "tick_min": _TICK_MIN, "tick_max": _TICK_MAX,
                "refresh_min": _REFRESH_MIN, "refresh_max": _REFRESH_MAX,
                "decks": self.decks(), "default_deck": _DEFAULT_DECK}

    def get_tick(self) -> float:
        return round(self._tick, 2)

    def set_tick(self, seconds: Any) -> dict:
        """Globale Aktualisierungs-Rate setzen (ein Push für ALLE Buttons). Wirkt
        sofort — der Eval-Loop liest self._tick bei jedem Durchlauf neu."""
        self._tick = _clamp_tick(seconds, self._tick)
        self._save()
        # Sofort neu rechnen+pushen (sichtbare Reaktion); die neue Taktrate selbst
        # greift ab dem nächsten Loop-Durchlauf (spätestens nach dem alten Takt).
        self._schedule_recompute()
        return {"tick_seconds": round(self._tick, 2),
                "tick_min": _TICK_MIN, "tick_max": _TICK_MAX}

    # ── Live-Config-Push (Deck-Templates) an die Tablet-Frontends ────────
    def _publish_cfg(self) -> None:
        """Deck-Templates (jedes mit eigenem Layout/Kategorien/Items) an die Frontends pushen
        → das Touch-Deck lädt daraufhin die Registry neu. Topic-Name historisch
        ``streamdeck:layout`` (bleibt, damit bestehende SSE-Allowlists greifen)."""
        self.bus.publish("streamdeck:layout", {"decks": self.decks()})

    def resolved(self) -> dict:
        """Aktuell aufgelöste Visuals (Snapshot fürs Plugin/Tab)."""
        return {"buttons": {k: dict(v) for k, v in self._resolved.items()}}

    def upsert_button(self, button: dict, place_on_deck: str = "") -> dict:
        """Funktions-Button im POOL anlegen/aktualisieren (Aktion/Überwachung/Zustände/Default).
        Platzierungs-Felder (deck/group/style) gehören NICHT in den Pool und werden verworfen —
        Platzierung passiert über Deck-Items. ``place_on_deck`` (optional): einen FRISCH
        angelegten Button gleich auf dieses Deck legen (Komfort im Deck-Editor)."""
        bid = (button or {}).get("id")
        if not bid:
            raise ValueError("Button braucht eine 'id'.")
        button = json.loads(json.dumps(button))   # defensive copy
        # Pro-Button-Refresh normalisieren: leer/ungültig → Feld weg (= globaler Takt).
        crs = _clamp_refresh(button.get("refresh_seconds"))
        if crs is None:
            button.pop("refresh_seconds", None)
        else:
            button["refresh_seconds"] = round(crs, 2)
        # Platzierung gehört nicht in die Funktions-Definition.
        for f in ("deck", "group", "style"):
            button.pop(f, None)
        is_new = not any(b.get("id") == bid for b in self._buttons)
        self._last_eval.pop(bid, None)             # erzwingt sofortige Neuauswertung
        self._removed.discard(str(bid))            # bewusst (wieder) angelegt → nicht mehr „gelöscht"
        for i, b in enumerate(self._buttons):
            if b.get("id") == bid:
                self._buttons[i] = button
                break
        else:
            self._buttons.append(button)
        # Optional: frisch angelegten Button direkt aufs bearbeitete Deck legen.
        if is_new and place_on_deck:
            deck = self._deck(place_on_deck)
            if deck and not any(it["button"] == bid for it in deck["items"]):
                deck["items"].append({"button": bid, "category": "", "style": {}, "hidden": False})
        self._save()
        self._poll_cache.pop(bid, None)
        self._schedule_recompute()
        self._publish_cfg()
        return button

    def delete_button(self, bid: str) -> dict:
        """Button aus dem POOL löschen — und aus ALLEN Deck-Items entfernen (er kann auf
        mehreren Decks gelegen haben)."""
        bid = str(bid or "")
        before = len(self._buttons)
        self._buttons = [b for b in self._buttons if b.get("id") != bid]
        removed_items = 0
        for d in self._decks:
            n = len(d["items"])
            d["items"] = [it for it in d["items"] if it["button"] != bid]
            removed_items += n - len(d["items"])
        self._resolved.pop(bid, None)
        self._poll_cache.pop(bid, None)
        # Merken, damit ein gelöschter Default-Button beim Neustart NICHT re-geseedet wird.
        self._removed.add(bid)
        self._save()
        self._publish()
        self._publish_cfg()
        return {"deleted": before - len(self._buttons), "items_removed": removed_items}

    def press(self, bid: str) -> dict:
        """Aktion eines Buttons ausführen (SYNC — Endpoint wrappt in to_thread).
        Dispatch über die Capability-Registry: ``action.type`` → registrierter Handler."""
        btn = next((b for b in self._buttons if b.get("id") == bid), None)
        if btn is None:
            raise KeyError(f"Unbekannter Button: {bid}")
        action = btn.get("action") or {}
        atype = action.get("type", "none")
        handler = self._action_handlers.get(atype)
        if handler is None:
            return {"success": False, "message": f"Unbekannter/nicht verfügbarer action.type: {atype}"}
        try:
            res = handler(action, btn) or {}
            ok, msg = bool(res.get("success")), res.get("message", "")
        except KeyError as e:
            return {"success": False, "message": f"Aktion unvollständig konfiguriert: {e}"}
        except Exception as e:  # noqa: BLE001
            log.exception("press(%s) Fehler", bid)
            return {"success": False, "message": str(e)}
        # Nach jeder Aktion zeitnah neu auswerten (State ändert sich meist).
        self._schedule_recompute()
        return {"id": bid, "success": ok, "message": msg}

    # ── Aktions-Handler (Capability-Registry; generisch = DeckCore) ───────
    def _act_none(self, action: dict, btn: dict) -> dict:
        return {"success": True, "message": "Anzeige-Button (keine Aktion)"}

    def _act_flag_toggle(self, action: dict, btn: dict) -> dict:
        return self._toggle_flag(action["flag"])

    def _act_flag_set(self, action: dict, btn: dict) -> dict:
        # Flag IMMER setzen (kein Toggle) — für „Signal an Daemon"-Buttons, wo ein Daemon
        # das Flag selbst wieder löscht, nachdem er es konsumiert hat.
        return self._set_flag(action["flag"], action.get("value", "on"))

    def _act_http_action(self, action: dict, btn: dict) -> dict:
        return self._http_call(action)

    def _act_launch(self, action: dict, btn: dict) -> dict:
        # Beliebiges Programm/Script starten (eigener Prozess, detached).
        return self._launch_program(action)

    def _act_displayfusion(self, action: dict, btn: dict) -> dict:
        return self._df_load_profile(action.get("profile", ""))

    def _act_media(self, action: dict, btn: dict) -> dict:
        # Media-Transport ans OS/fokussierte Fenster (Play/Pause, ⏭/⏮, Lauter/Leiser, Mute).
        key = str(action.get("key") or "").strip().lower()
        vk = _MEDIA_VK.get(key)
        if vk is None:
            return {"success": False, "message": f"Unbekannte Media-Taste: {key or '(leer)'}"}
        ok = _send_vk_combo([vk])
        return {"success": ok, "message": f"Media: {key}" if ok else "Media-Taste nur unter Windows"}

    def _act_hotkey(self, action: dict, btn: dict) -> dict:
        # Beliebige Tastenkombo senden, z.B. {"keys":"ctrl+shift+m"} (ans fokussierte Fenster).
        spec = str(action.get("keys") or action.get("combo") or "").strip()
        vks = _parse_hotkey(spec)
        if not vks:
            return {"success": False, "message": f"Hotkey nicht erkannt: {spec or '(leer)'}"}
        ok = _send_vk_combo(vks)
        return {"success": ok, "message": f"Hotkey: {spec}" if ok else "Hotkey nur unter Windows"}

    # (host-spezifische Aktions-Handler leben in der Hülle und werden
    #  über _register_extra_handlers() registriert.)

    def options(self) -> dict:
        """Auswahllisten für den Editor/Property-Inspector. ``action_types``/``monitor_types`` = die
        TATSÄCHLICH registrierten Capabilities (Registry) in stabiler Anzeige-Reihenfolge; nicht
        registrierte fehlen automatisch. Hüllen ergänzen via ``_extra_options()`` eigene Listen."""
        flags = []
        try:
            flags = sorted(p.name for p in self._flags_dir.glob("*.flag"))
        except Exception:  # noqa: BLE001
            pass
        _ACTION_ORDER = ["process_action", "launch", "displayfusion", "media", "hotkey",
                         "flag_toggle", "flag_set", "http", "manual_event", "alert", "obs",
                         "events_action", "none"]
        _MONITOR_ORDER = ["process_alive", "flag", "manual_count", "bot_mode", "bot_state",
                          "file_field", "sse_field", "poll", "obs_source_visible", "obs_scene",
                          "displayfusion_profile", "none"]
        def _ordered(reg, order):
            return [t for t in order if t in reg] + [t for t in reg if t not in order]
        out = {
            "refresh_min": _REFRESH_MIN, "refresh_max": _REFRESH_MAX,
            "action_types": _ordered(self._action_handlers, _ACTION_ORDER),
            "monitor_types": _ordered(self._monitor_handlers, _MONITOR_ORDER),
            "displayfusion_available": bool(_df_command_path()),
            "match_ops": ["any", "truthy", "falsy", "eq", "ne", "gt", "lt", "gte", "lte", "contains"],
            "known_flags": flags,
        }
        out.update(self._extra_options() or {})
        return out

    def _extra_options(self) -> dict:
        """Hook: hüllen-spezifische Auswahllisten (Prozesse, Alert-/Manual-Typen, sse-Topics,
        file_suggestions). Kern = leer."""
        return {}

    # ── Aktions-Helfer ───────────────────────────────────────────────────
    def _toggle_flag(self, flag_name: str) -> dict:
        flag = self._flags_dir / flag_name
        try:
            if flag.exists():
                flag.unlink()
                return {"success": True, "message": f"{flag_name} → aus"}
            flag.parent.mkdir(parents=True, exist_ok=True)
            flag.write_text("on", encoding="utf-8")
            return {"success": True, "message": f"{flag_name} → an"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Flag-Toggle Fehler: {e}"}

    def _set_flag(self, flag_name: str, value: str = "on") -> dict:
        flag = self._flags_dir / flag_name
        try:
            flag.parent.mkdir(parents=True, exist_ok=True)
            flag.write_text(value, encoding="utf-8")
            return {"success": True, "message": f"{flag_name} gesetzt"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Flag-Set Fehler: {e}"}

    def _http_call(self, action: dict) -> dict:
        method = (action.get("method") or "GET").upper()
        url = action.get("url")
        if not url:
            return {"success": False, "message": "http-Aktion ohne url"}
        body = action.get("body")
        data = None
        headers = {}
        if body is not None and method in ("POST", "PUT", "PATCH"):
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                return {"success": 200 <= resp.status < 300,
                        "message": f"HTTP {resp.status} {url}"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"HTTP-Fehler: {e}"}

    def _launch_program(self, action: dict) -> dict:
        """Beliebiges Programm/Script starten — eigener, DETACHED Prozess, OHNE Shell.
        .py → über den aktuellen Interpreter; .exe/.bat/.cmd → direkt; .lnk/sonst → über die
        Shell-Zuordnung (os.startfile). Lokales Streamer-Tool: bewusst keine Pfad-Allowlist."""
        import os
        import shlex
        import subprocess
        import sys
        path = (action.get("path") or "").strip().strip('"')
        if not path:
            return {"success": False, "message": "Kein Pfad gewählt"}
        p = Path(path)
        if not p.exists():
            return {"success": False, "message": f"Pfad nicht gefunden: {path}"}
        args = action.get("args") or ""
        try:
            arg_list = shlex.split(args, posix=False) if args else []
        except ValueError:
            arg_list = args.split()
        cwd = action.get("cwd") or str(p.parent)
        detached = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        try:
            ext = p.suffix.lower()
            if ext == ".py":
                subprocess.Popen([sys.executable or "python", str(p), *arg_list],
                                 cwd=cwd, creationflags=detached, close_fds=True)
            elif ext in (".exe", ".bat", ".cmd", ".com"):
                subprocess.Popen([str(p), *arg_list], cwd=cwd, creationflags=detached, close_fds=True)
            else:
                os.startfile(str(p))   # .lnk u.a. über Shell-Zuordnung
            return {"success": True, "message": f"gestartet: {p.name}"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Start fehlgeschlagen: {e}"}

    def _df_load_profile(self, profile: str) -> dict:
        """DisplayFusion-Monitor-Profil per Name laden (DisplayFusionCommand.exe)."""
        import subprocess
        profile = (profile or "").strip()
        if not profile:
            return {"success": False, "message": "Kein DisplayFusion-Profil gewählt"}
        exe = _df_command_path()
        if not exe:
            return {"success": False, "message": "DisplayFusionCommand.exe nicht gefunden"}
        try:
            subprocess.run([exe, "-monitorloadprofile", profile], timeout=20,
                           creationflags=0x08000000)   # CREATE_NO_WINDOW
            self._df_active_cache = (None, 0.0)   # Aktiv-Highlight gleich neu auswerten
            return {"success": True, "message": f"DisplayFusion-Profil geladen: {profile}"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"DisplayFusion-Fehler: {e}"}

    def _df_active_profile(self) -> Optional[str]:
        """Aktives (zuletzt geladenes) DisplayFusion-Profil — gemeinsamer Cache wie obs_scene."""
        now = time.monotonic()
        val, ts = self._df_active_cache
        if ts and (now - ts) < _DF_ACTIVE_TTL:
            return val
        profs = _df_list_profiles()
        active = next((p["name"] for p in profs if p.get("active")), None)
        self._df_active_cache = (active, now)
        return active

    # ── Monitor-Evaluation ───────────────────────────────────────────────
    def _eval_monitor(self, btn: dict) -> Any:
        """Monitor eines Buttons auswerten — Dispatch über die Capability-Registry
        (``monitor.type`` → registrierter Handler). Unbekannter/nicht verfügbarer Typ → None."""
        mon = btn.get("monitor") or {}
        mtype = mon.get("type", "none")
        handler = self._monitor_handlers.get(mtype)
        if handler is None:
            return None
        try:
            return handler(mon, btn)
        except Exception as e:  # noqa: BLE001
            log.debug("Monitor-Eval %s fehlgeschlagen: %s", btn.get("id"), e)
            return None

    # ── Monitor-Handler (Capability-Registry; generisch = DeckCore) ───────
    def _mon_none(self, mon: dict, btn: dict) -> Any:
        return None

    def _mon_flag(self, mon: dict, btn: dict) -> Any:
        return (self._flags_dir / mon["flag"]).exists()

    def _mon_file_field(self, mon: dict, btn: dict) -> Any:
        path = self._files_base / mon["file"]
        if not path.exists():
            return None
        obj = json.loads(path.read_text(encoding="utf-8-sig"))
        return _dig(obj, mon.get("path", ""))

    def _mon_sse_field(self, mon: dict, btn: dict) -> Any:
        payload = self._sse_cache.get(mon.get("topic"))
        return _dig(payload, mon.get("path", "")) if payload is not None else None

    def _mon_poll(self, mon: dict, btn: dict) -> Any:
        return self._poll_value(btn["id"], mon)

    def _mon_displayfusion_profile(self, mon: dict, btn: dict) -> Any:
        # Aktives (zuletzt geladenes) DisplayFusion-Profil — für Profil-Buttons.
        return self._df_active_profile()

    # (host-spezifische Monitor-Handler leben in der Hülle und werden
    #  über _register_extra_handlers() registriert.)

    def _poll_value(self, bid: str, mon: dict) -> Any:
        interval = float(mon.get("interval", 10))
        cached = self._poll_cache.get(bid)
        now = time.monotonic()
        if cached is not None and (now - cached[1]) < interval:
            return cached[0]
        value = None
        try:
            req = urllib.request.Request(mon["url"], method="GET")
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                obj = json.loads(resp.read().decode("utf-8"))
                value = _dig(obj, mon.get("path", ""))
        except Exception as e:  # noqa: BLE001
            log.debug("poll(%s) Fehler: %s", bid, e)
        self._poll_cache[bid] = (value, now)
        return value

    def _resolve(self, btn: dict, value: Any) -> dict:
        # {value} im Titel → aktueller Monitor-Wert (z.B. Manual-Event-Zähler).
        def tpl(s):
            return s.replace("{value}", str(value if value is not None else "")) if isinstance(s, str) and "{value}" in s else s
        default = btn.get("default") or {}
        for st in btn.get("states") or []:
            if _match(value, st.get("when") or {}):
                return {
                    "label": btn.get("label", btn.get("id")),
                    "title": tpl(st.get("title", "")),
                    "icon": st.get("icon", ""),
                    "image": st.get("image", ""),
                    "color": st.get("color", "#222"),
                }
        return {
            "label": btn.get("label", btn.get("id")),
            "title": tpl(default.get("title", "")),
            "icon": default.get("icon", ""),
            "image": default.get("image", ""),
            "color": default.get("color", "#222"),
        }

    def _eff_interval(self, btn: dict) -> float:
        """Effektive Refresh-Periode eines Buttons: eigener Override oder globaler Takt."""
        rs = _clamp_refresh(btn.get("refresh_seconds"))
        return rs if rs is not None else self._tick

    def _loop_granularity(self) -> float:
        """Wie oft der Eval-Loop aufwacht — fein genug für das kürzeste Button-Intervall."""
        ivs = [self._eff_interval(b) for b in self._buttons if b.get("id")]
        return max(_TICK_MIN, min([self._tick] + ivs))

    def _recompute(self, force: bool = False) -> dict[str, dict]:
        """Fällige Buttons neu auswerten; nicht-fällige behalten ihren letzten Look.
        ``force`` = alles sofort neu (nach Tastendruck/Edit). Baut ein frisches Dict
        und tauscht es atomar (thread-safe ggü. parallelem Endpoint-Aufruf)."""
        now = time.monotonic()
        prev = self._resolved
        out: dict[str, dict] = {}
        last = dict(self._last_eval)
        for btn in self._buttons:
            bid = btn.get("id")
            if not bid:
                continue
            due = force or bid not in prev or (now - last.get(bid, 0.0)) >= self._eff_interval(btn)
            if due:
                out[bid] = self._resolve(btn, self._eval_monitor(btn))
                last[bid] = now
            else:
                out[bid] = prev[bid]
        self._last_eval = last
        return out

    def _publish(self) -> None:
        if self.bus is not None:
            self.bus.publish("streamdeck:buttons", {"buttons": self._resolved})

    def _schedule_recompute(self) -> None:
        # Sofort ALLES neu auflösen + pushen (z.B. nach press/upsert), ohne auf den
        # Tick zu warten — force, damit auch Buttons mit langem Override gleich umspringen.
        try:
            self._resolved = self._recompute(force=True)
            self._publish()
        except Exception as e:  # noqa: BLE001
            log.debug("schedule_recompute Fehler: %s", e)

    # ── Lifecycle ────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._stop.clear()
        self._loop = asyncio.get_running_loop()
        self._eval_task = asyncio.create_task(self._eval_loop())
        self._sse_task = asyncio.create_task(self._sse_loop())
        log.info("StreamDeckService gestartet (%d Buttons, Rate %.2fs)",
                 len(self._buttons), self._tick)

    async def stop(self) -> None:
        self._stop.set()
        for t in (self._eval_task, self._sse_task):
            if t:
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    async def _eval_loop(self) -> None:
        while not self._stop.is_set():
            try:
                # WICHTIG: _recompute macht blockierendes IO (poll-HTTP, File-Reads,
                # tasklist via processes.status). Das MUSS off-loop laufen — sonst
                # blockiert der poll-Self-Call (die Host-App ruft sich selbst) den Event-
                # Loop → Deadlock/Timeout → Monitor liefert None.
                new = await asyncio.to_thread(self._recompute)
                if new != self._resolved:
                    self._resolved = new
                    self._publish()
            except Exception as e:  # noqa: BLE001
                log.debug("eval_loop Fehler: %s", e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._loop_granularity())
            except asyncio.TimeoutError:
                pass

    async def _sse_loop(self) -> None:
        """Cached die letzten Payloads der Topics, die sse_field-Monitore brauchen."""
        while not self._stop.is_set():
            topics = sorted({
                (b.get("monitor") or {}).get("topic")
                for b in self._buttons
                if (b.get("monitor") or {}).get("type") == "sse_field"
                and (b.get("monitor") or {}).get("topic")
            })
            if not topics or self.bus is None:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    pass
                continue
            queues = [(t, self.bus.subscribe(t)) for t in topics]

            async def _one(tq):
                t, q = tq
                return t, await q.get()

            try:
                # Konsumiere bis sich die Topic-Menge ändert oder gestoppt wird.
                current = set(topics)
                while not self._stop.is_set():
                    tasks = [asyncio.create_task(_one(tq)) for tq in queues]
                    done, pending = await asyncio.wait(
                        tasks, timeout=3.0, return_when=asyncio.FIRST_COMPLETED)
                    for d in done:
                        try:
                            topic, payload = d.result()
                            self._sse_cache[topic] = payload
                        except Exception:  # noqa: BLE001
                            pass
                    for p in pending:
                        p.cancel()
                    # Topic-Menge geändert? → neu subscriben
                    live = {
                        (b.get("monitor") or {}).get("topic")
                        for b in self._buttons
                        if (b.get("monitor") or {}).get("type") == "sse_field"
                        and (b.get("monitor") or {}).get("topic")
                    }
                    if live != current:
                        break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("sse_loop Fehler: %s", e)
                await asyncio.sleep(2.0)
