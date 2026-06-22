"""
Wetter für den generischen deckcore-Monitor ``weather``.

Datenquelle = **Open-Meteo** (gratis, KEIN API-Key, kein Login) — läuft also bei jedem Nutzer.
Standort ohne GPS = **automatisch per IP** (gratis, kein Key) ODER **manuell** gesetzt (Stadt →
Geocoding, oder Koordinaten direkt). „Auto-gut, dann manuell."

⚠ Das ist der EINZIGE deckcore-Baustein, der nach AUSSEN telefoniert (IP→Geo-Dienst, Wetter-API).
Darum: eigene opt-in-Integration, LANGE gecacht (Wetter ~20 min, Standort ~24 h → kein API-Hämmern),
nur stdlib (urllib) — keine neue Abhängigkeit. Jede Methode ist graceful: kein Netz → ``available:False``
mit Klartext-Grund, die Kachel zeigt ihren Default.

Eigenschaften (analog ``HwinfoReader`` / ``FrametimeSource``): lazy, thread-safe, gecacht, graceful.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

log = logging.getLogger("deckcore.weather")

_WX_TTL = 1200.0      # s — Wetter höchstens alle 20 min neu holen (kein API-Hämmern)
_GEO_TTL = 86400.0    # s — Standort höchstens 1×/Tag per IP neu auflösen
_TIMEOUT = 6.0        # s — HTTP-Timeout (hängt nie)
_UA = "RigzDeck/weather (+https://github.com/RitschyRigz/deckcore)"

# WMO-Wettercodes → Emoji (kompakt; Open-Meteo „weather_code"). Unbekannt → 🌡️.
_WMO = {
    0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️",
    51: "🌦️", 53: "🌦️", 55: "🌦️", 56: "🌧️", 57: "🌧️",
    61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌧️", 67: "🌧️",
    71: "🌨️", 73: "🌨️", 75: "❄️", 77: "❄️",
    80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "❄️",
    95: "⛈️", 96: "⛈️", 99: "⛈️",
}


def wmo_emoji(code) -> str:
    """WMO-Wettercode → Emoji (pure, testbar). Unbekannt/None → 🌡️."""
    try:
        return _WMO.get(int(code), "🌡️")
    except (TypeError, ValueError):
        return "🌡️"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:  # noqa: S310 (feste, vertrauenswürdige Hosts)
        return json.loads(r.read().decode("utf-8", "replace"))


class WeatherSource:
    """Aktuelles Wetter am (Auto- oder manuellen) Standort. Gecacht, graceful, thread-safe."""

    def __init__(self, config_path: Optional[str] = None):
        self._lock = threading.Lock()
        self._cfg_path = Path(config_path) if config_path else None
        # cfg: manuell gesetzte Koordinaten/Ort. manual=False → Standort per IP auflösen.
        self._cfg = {"lat": None, "lon": None, "place": "", "manual": False}
        self._geo_ts = -1e9                  # monotonic der letzten IP-Auflösung
        self._geo = {"lat": None, "lon": None, "place": ""}   # zuletzt aufgelöster Auto-Standort
        self._wx: Optional[dict] = None      # zuletzt geholtes Wetter
        self._wx_ts = -1e9
        self._wx_key = None                  # (lat,lon) des gecachten Wetters
        self._load_cfg()

    # ── Config (manueller Standort) ──────────────────────────────────────
    def _load_cfg(self) -> None:
        if self._cfg_path and self._cfg_path.is_file():
            try:
                data = json.loads(self._cfg_path.read_text(encoding="utf-8"))
                for k in ("lat", "lon", "place", "manual"):
                    if k in data:
                        self._cfg[k] = data[k]
            except (OSError, ValueError):
                pass

    def _save_cfg(self) -> None:
        if not self._cfg_path:
            return
        try:
            self._cfg_path.parent.mkdir(parents=True, exist_ok=True)
            self._cfg_path.write_text(json.dumps(self._cfg), encoding="utf-8")
        except OSError as e:
            log.warning("weather: cfg speichern fehlgeschlagen: %s", e)

    def configure(self, lat=None, lon=None, place: str = "", city: str = "", auto: bool = False) -> dict:
        """Standort setzen. ``auto=True`` → zurück auf IP-Auto. ``city`` → per Geocoding auflösen.
        ``lat``/``lon`` → direkt. Leert den Wetter-Cache, damit der neue Ort sofort greift."""
        with self._lock:
            if auto:
                self._cfg = {"lat": None, "lon": None, "place": "", "manual": False}
                self._geo_ts = -1e9
            elif city and str(city).strip():
                try:
                    g = _get_json("https://geocoding-api.open-meteo.com/v1/search?"
                                  + urllib.parse.urlencode({"name": str(city).strip(), "count": 1}))
                    res = (g.get("results") or [None])[0]
                    if not res:
                        return {"ok": False, "reason": f"Ort „{city}\" nicht gefunden"}
                    nm = ", ".join(p for p in (res.get("name"), res.get("country_code")) if p)
                    self._cfg = {"lat": float(res["latitude"]), "lon": float(res["longitude"]),
                                 "place": nm, "manual": True}
                except Exception as e:  # noqa: BLE001
                    return {"ok": False, "reason": f"Geocoding fehlgeschlagen: {e}"}
            elif lat is not None and lon is not None:
                try:
                    self._cfg = {"lat": float(lat), "lon": float(lon),
                                 "place": str(place or "").strip() or f"{float(lat):.2f}, {float(lon):.2f}",
                                 "manual": True}
                except (TypeError, ValueError):
                    return {"ok": False, "reason": "ungültige Koordinaten"}
            else:
                return {"ok": False, "reason": "nichts zu setzen (auto / city / lat+lon)"}
            self._wx = None
            self._wx_ts = -1e9
            self._save_cfg()
        return {"ok": True, **self.config()}

    def config(self) -> dict:
        return dict(self._cfg)

    # ── Standort auflösen (manuell > IP-Auto) ────────────────────────────
    def _resolve_location(self):
        if self._cfg.get("manual") and self._cfg.get("lat") is not None:
            return self._cfg["lat"], self._cfg["lon"], self._cfg.get("place") or ""
        now = time.monotonic()
        if self._geo["lat"] is not None and (now - self._geo_ts) < _GEO_TTL:
            return self._geo["lat"], self._geo["lon"], self._geo["place"]
        try:    # IP-Geo (gratis, kein Key) — nur ungefähr (Stadt-Level), reicht fürs Wetter
            g = _get_json("http://ip-api.com/json/?fields=status,lat,lon,city,country")
            if g.get("status") == "success" and g.get("lat") is not None:
                place = ", ".join(p for p in (g.get("city"), g.get("country")) if p)
                self._geo = {"lat": float(g["lat"]), "lon": float(g["lon"]), "place": place}
                self._geo_ts = now
                return self._geo["lat"], self._geo["lon"], place
        except Exception as e:  # noqa: BLE001
            log.debug("weather: IP-Geo fehlgeschlagen: %s", e)
        return None, None, ""

    # ── Wetter holen (gecacht) ───────────────────────────────────────────
    def current(self) -> dict:
        """``{available, temp, code, emoji, place, reason?}`` — gecacht (~20 min), graceful."""
        with self._lock:
            now = time.monotonic()
            lat, lon, place = self._resolve_location()
            if lat is None:
                return {"available": False, "reason": "Standort nicht bestimmbar (Internet? manuell setzen)"}
            key = (round(float(lat), 3), round(float(lon), 3))
            if self._wx is not None and self._wx_key == key and (now - self._wx_ts) < _WX_TTL:
                return dict(self._wx, place=place or self._wx.get("place", ""))
            try:
                d = _get_json("https://api.open-meteo.com/v1/forecast?"
                              + urllib.parse.urlencode({"latitude": lat, "longitude": lon,
                                                        "current": "temperature_2m,weather_code",
                                                        "timezone": "auto"}))
                cur = d.get("current") or {}
                temp = cur.get("temperature_2m")
                code = cur.get("weather_code")
                if temp is None:
                    return {"available": False, "reason": "keine Wetterdaten"}
                self._wx = {"available": True, "temp": round(float(temp), 1),
                            "code": int(code) if code is not None else None,
                            "emoji": wmo_emoji(code), "place": place}
                self._wx_ts = now
                self._wx_key = key
                return dict(self._wx)
            except Exception as e:  # noqa: BLE001
                return {"available": False, "reason": f"Wetter-Abruf fehlgeschlagen: {e}", "place": place}

    def display(self) -> Optional[str]:
        """Kompakter Anzeige-String „⛅ 18° Zürich" (für den Monitor-Wert) oder None, wenn nicht verfügbar."""
        c = self.current()
        if not c.get("available"):
            return None
        s = f"{c.get('emoji', '')} {round(c['temp'])}°".strip()
        city = (c.get("place") or "").split(",")[0].strip()
        return f"{s} {city}".strip() if city else s

    def status(self, probe: bool = False) -> dict:
        """Status für die UI (= current(); ``probe`` erzwingt keinen Sonderpfad, der Cache reicht)."""
        return self.current()
