"""
HWiNFO-Sensoren auslesen — Datenquelle für den generischen deckcore-Monitor ``hwinfo``.

Zwei read-only-Quellen (beide lazy, graceful). Reihenfolge: Registry ZUERST (die bewusste
User-Kuration soll gewinnen), Shared Memory nur als Fallback, wenn nichts markiert ist:
  • **Shared Memory** (nur Fallback)``Global\\HWiNFO_SENS_SM2`` — ALLE Sensoren. Lesbar nur, wenn die lesende
     App auf gleicher/höherer Integritätsstufe wie HWiNFO läuft (HWiNFO als Admin → die App muss
     ebenfalls erhöht sein, sonst „Zugriff verweigert"). HWiNFO-Einstellung: „Shared Memory Support".
  • **Registry** (bevorzugt — User-Kuration)``HKCU\\SOFTWARE\\HWiNFO64\\VSB`` — nur die vom User markierten Sensoren, dafür
     OHNE Elevation lesbar. HWiNFO: „Settings → … periodically write values to Registry" (Gadget/VSB).

Ist keine Quelle verfügbar → leere Sensorliste / ``value()`` = None (die Kachel zeigt ihren Default).
Alle Sensoren werden EINMAL pro ``_CACHE_TTL`` gelesen und dann aus dem Cache bedient (kein
SHM-/Registry-Sturm, wenn viele Sensor-Kacheln im selben Tick auswerten).
"""
from __future__ import annotations

import logging
import struct
import time
from typing import Optional

log = logging.getLogger("deckcore.hwinfo")

_SHM_NAME = r"Global\HWiNFO_SENS_SM2"
_CACHE_TTL = 1.0          # s — alle Sensoren 1×/s lesen, dann aus dem Cache
_READING_MIN = 292        # min. Größe eines Reading-Elements (bis inkl. Value-double)


class HwinfoReader:
    """Liest HWiNFO-Sensoren (SHM bevorzugt, sonst Registry) mit kurzem Cache."""

    def __init__(self):
        self._cache: dict[str, dict] = {}   # key → {"value": float, "unit": str, "sensor": str}
        self._order: list[str] = []
        self._ts = 0.0
        self._source: Optional[str] = None  # "shm" | "registry" | None

    def _refresh(self) -> None:
        now = time.monotonic()
        if self._ts and (now - self._ts) < _CACHE_TTL:
            return
        # Registry/Gadget ZUERST: die vom User bewusst markierte Auswahl (seine Kuration soll gewinnen)
        # + läuft gratis ohne Admin/Pro. Shared Memory NUR als Fallback (wenn nichts markiert ist; zeigt
        # dann alle Sensoren, braucht aber HWiNFO-Pro/Admin-Gleichstand).
        data, order, src = _read_registry()
        if not data:
            data, order, src = _read_shm()
        self._cache, self._order, self._source = data, order, src
        self._ts = now

    def sensors(self) -> dict:
        """{available, source, sensors:[{key,label,value,unit,sensor}]} — für Editor-Dropdown."""
        self._refresh()
        return {
            "available": bool(self._cache), "source": self._source,
            "sensors": [{"key": k, "label": k, "value": self._cache[k]["value"],
                         "unit": self._cache[k]["unit"], "sensor": self._cache[k]["sensor"]}
                        for k in self._order],
        }

    def value(self, key: str) -> Optional[float]:
        """Aktueller Wert eines Sensors (per Label-Key) oder None."""
        self._refresh()
        hit = self._cache.get(str(key or ""))
        return hit["value"] if hit else None


def _uniq(key: str, data: dict) -> str:
    """Doppelte Sensor-Labels eindeutig machen (z.B. mehrere „Fan")."""
    if key not in data:
        return key
    n = 2
    while f"{key} ({n})" in data:
        n += 1
    return f"{key} ({n})"


def _read_shm():
    import mmap
    try:
        m = mmap.mmap(-1, 65536, _SHM_NAME, mmap.ACCESS_READ)
    except Exception:  # noqa: BLE001  (nicht da / Zugriff verweigert / HWiNFO aus)
        return {}, [], None
    try:
        (_sig, _ver, _rev, _poll, _soff, _ssz, _snum,
         roff, rsz, rnum) = struct.unpack("<IIIqIIIIII", m.read(44))
        if rnum <= 0 or rsz < _READING_MIN:
            return {}, [], None
        total = roff + rnum * rsz
        m.close()
        m = mmap.mmap(-1, total, _SHM_NAME, mmap.ACCESS_READ)
        data, order = {}, []
        for i in range(rnum):
            c = m[roff + i * rsz: roff + i * rsz + rsz]
            label = c[140:268].split(b"\x00")[0].decode("latin-1", "ignore").strip()
            if not label:
                continue
            unit = c[268:284].split(b"\x00")[0].decode("latin-1", "ignore").strip()
            val = struct.unpack("<d", c[284:292])[0]
            key = _uniq(label, data)
            data[key] = {"value": round(val, 2), "unit": unit, "sensor": ""}
            order.append(key)
        return data, order, "shm"
    except Exception as e:  # noqa: BLE001
        log.debug("HWiNFO-SHM-Lesen fehlgeschlagen: %s", e)
        return {}, [], None
    finally:
        try:
            m.close()
        except Exception:  # noqa: BLE001
            pass


def _read_registry():
    try:
        import winreg
    except Exception:  # noqa: BLE001  (nicht Windows)
        return {}, [], None
    vals: dict = {}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"SOFTWARE\HWiNFO64\VSB") as k:
            i = 0
            while True:
                try:
                    name, value, _ = winreg.EnumValue(k, i)
                except OSError:
                    break
                i += 1
                vals[name] = value
    except Exception:  # noqa: BLE001  (VSB nicht aktiviert)
        return {}, [], None
    data, order = {}, []
    n = 0
    while f"Label{n}" in vals:
        label = str(vals.get(f"Label{n}", "")).strip()
        # HWiNFO-VSB schreibt KEINE separate Unit-Spalte → die Einheit steckt im formatierten
        # Value<N> (z.B. „43 °C", „16,538 MB"). Darum aus Value ziehen (Unit<N> nur als Fallback,
        # falls eine HWiNFO-Version es doch schreibt).
        unit = str(vals.get(f"Unit{n}", "")).strip() or _unit_from_value(vals.get(f"Value{n}"))
        val = _to_float(vals.get(f"ValueRaw{n}"))   # ValueRaw ist sauber numerisch (ohne Tausender-Komma)
        if val is None:   # Fallback: aus „55.0 °C" die führende Zahl ziehen
            val = _to_float(_lead_num(vals.get(f"Value{n}")))
        sensor = str(vals.get(f"Sensor{n}", "")).strip()
        n += 1
        if not label or val is None:
            continue
        key = _uniq(label, data)
        data[key] = {"value": round(val, 2), "unit": unit, "sensor": sensor}
        order.append(key)
    return data, order, "registry"


def _to_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _unit_from_value(s) -> str:
    """Einheit aus einem formatierten HWiNFO-Wert ziehen: ``"43 °C"`` → ``"°C"``,
    ``"16,538 MB"`` → ``"MB"``, ``"49.7 %"`` → ``"%"`` (führende Zahl + Trenner abschneiden)."""
    if s is None:
        return ""
    t = str(s).strip()
    i = 0
    while i < len(t) and (t[i].isdigit() or t[i] in "+-.,'  "):
        i += 1
    return t[i:].strip()


def _lead_num(s) -> Optional[str]:
    """Führende Zahl aus einem String wie ``"55.0 °C"`` / ``"3,5 GHz"`` ziehen."""
    if s is None:
        return None
    out, seen_dot = [], False
    for ch in str(s).strip():
        if ch.isdigit() or (ch in ".," and not seen_dot):
            out.append("." if ch == "," else ch)
            if ch in ".,":
                seen_dot = True
        elif ch in "+-" and not out:
            out.append(ch)
        else:
            break
    return "".join(out) or None
