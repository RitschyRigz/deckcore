"""Arduino-Tastatur-Bridge (optional) — Tastendruecke ueber einen echten USB-HID-Chip.

Ein ATmega32U4-Board (Arduino Micro/Leonardo, SparkFun Pro Micro …) meldet sich beim OS als
**echtes USB-HID-Keyboard** an. Anschlaege davon sind fuer die Ziel-App ununterscheidbar von
physischer Hardware — noch eine Stufe „echter" als der Interception-Kernel-Treiber, und ohne
jeden Treiber/Reboot. Genau richtig fuer Apps, die OS-injizierte Eingaben verwerfen (TikTok Live
Studio) ODER fuer Tasten, die eine Tastatur physisch braucht (echter Ziffernblock).

Der Chip laeuft die schlanke Firmware ``RIGZDECK-KB`` (siehe ``firmware/rigzdeck_kb/``): ein CDC-
Serial-Port neben dem HID-Keyboard, zeilenbasiertes Protokoll:

    ID                 -> "RIGZDECK-KB v1"          (Discovery-Signatur)
    K <tok> <tok> ...  -> Chord druecken/halten/los  -> "OK" | "ERR:<token>"

Public-clean: keine feste Port-Nummer. Der Port wird ueber die **ID-Antwort** gefunden (die Nummer
kann beim Umstecken wechseln) — der Host merkt sich hoechstens den zuletzt gefundenen Port als
Startpunkt. ``pyserial`` wird **lazy** importiert; ohne Board/pyserial ist das Modul einfach
„nicht verfuegbar" und der normale SendInput-Weg bleibt der Default.
"""
from __future__ import annotations

import threading
import time

_SIGNATURE = "RIGZDECK-KB"          # Antwort auf "ID" beginnt damit
_BAUD = 115200

# USB-Vendor-IDs gaengiger HID-faehiger Boards (32U4/RP2040 …). NUR ein Scan-Filter, damit die
# Auto-Suche fremde serielle Geraete (FTDI-Wandler o.ae.) NICHT anspricht — die eigentliche
# Bestaetigung ist immer die ID-Signatur. Exotische Klone (CH340-Pro-Micro) → Port manuell setzen.
_ARDUINO_VIDS = {0x2341, 0x2A03, 0x1B4F, 0x239A, 0x16C0, 0x03EB, 0x1209}


class ArduinoKeyboard:
    """Lazy-Wrapper um die serielle HID-Bridge. Thread-safe; haelt den Port offen und baut ihn bei
    Fehlern einmal neu auf (Umstecken/Reset). Ein Sende-Vorgang = eine ``K``-Zeile."""

    def __init__(self, port: str | None = None):
        self._port = port or None          # bevorzugter Startport (aus Config), optional
        self._ser = None                   # offener pyserial.Serial | None
        self._resolved = ""                # tatsaechlich gefundener Port
        self._err = ""
        self._lock = threading.Lock()

    # ── Konfiguration ────────────────────────────────────────────────────
    def configure(self, port: str | None) -> None:
        port = port or None
        if port != self._port:
            self._port = port
            self._close()

    @property
    def last_error(self) -> str:
        return self._err

    @property
    def resolved_port(self) -> str:
        return self._resolved

    # ── pyserial (lazy) ──────────────────────────────────────────────────
    @staticmethod
    def _pyserial():
        try:
            import serial                       # noqa: PLC0415
            import serial.tools.list_ports as lp  # noqa: PLC0415
            return serial, lp
        except Exception:  # noqa: BLE001
            return None, None

    def _close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:  # noqa: BLE001
                pass
        self._ser = None
        self._resolved = ""

    # ── Port-Kandidaten ──────────────────────────────────────────────────
    def _candidate_ports(self, lp) -> list:
        """Reihenfolge: konfigurierter Port -> Ports mit Arduino-Vendor-ID. Nie fremde Serielle."""
        ports = list(lp.comports())
        out: list = []
        if self._port:
            out.append(self._port)
        for p in ports:
            vid = getattr(p, "vid", None)
            if vid in _ARDUINO_VIDS and p.device not in out:
                out.append(p.device)
        return out

    def _probe(self, serial_mod, name: str) -> bool:
        """Port oeffnen, ``ID`` fragen, auf die Signatur pruefen. Erfolg -> Port offen halten."""
        try:
            ser = serial_mod.Serial(name, _BAUD, timeout=0.6)
        except Exception as e:  # noqa: BLE001
            self._err = f"{name}: {e}"
            return False
        try:
            time.sleep(0.4)                      # CDC kurz setteln
            ser.reset_input_buffer()
            ser.write(b"ID\n")
            deadline = time.monotonic() + 1.2
            while time.monotonic() < deadline:
                line = ser.readline().decode("ascii", "replace").strip()
                if line.startswith(_SIGNATURE):
                    self._ser = ser
                    self._resolved = name
                    self._err = ""
                    return True
                if line:                         # fremde Antwort -> kein Match, weiter suchen
                    break
        except Exception as e:  # noqa: BLE001
            self._err = f"{name}: {e}"
        try:
            ser.close()
        except Exception:  # noqa: BLE001
            pass
        return False

    def _ensure(self) -> bool:
        """Offene, lebende Verbindung sicherstellen (sonst Ports durchprobieren)."""
        if self._ser is not None and getattr(self._ser, "is_open", False):
            return True
        serial_mod, lp = self._pyserial()
        if serial_mod is None:
            self._err = "pyserial nicht installiert"
            return False
        cands = self._candidate_ports(lp)
        if not cands:
            self._err = "kein HID-Board gefunden (Arduino Micro/Leonardo einstecken, sonst Port setzen)"
            return False
        for name in cands:
            if self._probe(serial_mod, name):
                return True
        if not self._err:
            self._err = "kein Board mit RIGZDECK-KB-Firmware gefunden"
        return False

    # ── Status / Kalibrierung ────────────────────────────────────────────
    def available(self) -> bool:
        """True, wenn ein Board mit unserer Firmware erreichbar ist."""
        with self._lock:
            return self._ensure()

    def rescan(self) -> str:
        """Verbindung neu aufbauen (Port kann gewechselt haben). Gibt den gefundenen Port zurueck."""
        with self._lock:
            self._close()
            self._ensure()
            return self._resolved

    def list_serial_ports(self) -> list:
        """Alle seriellen Ports (fuer die UI: Port manuell waehlen). Markiert Arduino-Vendor-Ports."""
        _, lp = self._pyserial()
        if lp is None:
            return []
        out = []
        for p in lp.comports():
            out.append({
                "port": p.device,
                "desc": (p.description or "").strip(),
                "hwid": (p.hwid or "").strip(),
                "arduino": getattr(p, "vid", None) in _ARDUINO_VIDS,
            })
        return out

    # ── Senden ───────────────────────────────────────────────────────────
    def send_chord(self, tokens: list, retry: bool = True) -> bool:
        """``tokens`` = Liste von Tasten-Token (z.B. ``["ctrl","shift","num1"]``) → als EIN Chord an
        das Board (druecken/halten/loslassen). False, wenn kein Board da ODER ein Token unbekannt ist.
        Bei einem I/O-Fehler wird EINMAL neu verbunden und erneut gesendet (Umstecken/Reset)."""
        toks = [str(t).strip() for t in (tokens or []) if str(t).strip()]
        if not toks:
            return False
        with self._lock:
            if not self._ensure():
                return False
            try:
                self._ser.reset_input_buffer()
                self._ser.write(("K " + " ".join(toks) + "\n").encode("ascii", "replace"))
                line = self._ser.readline().decode("ascii", "replace").strip()
                if line.startswith("OK"):
                    self._err = ""
                    return True
                # ERR:<token> = Board erreichbar, aber Token unbekannt → KEIN Reconnect
                self._err = line or "keine Antwort"
                if line.startswith("ERR"):
                    return False
            except Exception as e:  # noqa: BLE001
                self._err = str(e)
                self._close()
            # I/O-Fehler / keine Antwort → einmal neu verbinden und erneut versuchen
            if retry:
                return self._retry_locked(toks)
            return False

    def _retry_locked(self, toks: list) -> bool:
        """Reconnect + EIN erneuter Sendeversuch (bereits unter Lock)."""
        self._close()
        if not self._ensure():
            return False
        try:
            self._ser.reset_input_buffer()
            self._ser.write(("K " + " ".join(toks) + "\n").encode("ascii", "replace"))
            line = self._ser.readline().decode("ascii", "replace").strip()
            if line.startswith("OK"):
                self._err = ""
                return True
            self._err = line or "keine Antwort"
        except Exception as e:  # noqa: BLE001
            self._err = str(e)
            self._close()
        return False
