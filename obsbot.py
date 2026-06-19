"""
ObsBotOSC — schlanker OSC-Client für die lokale OBSBOT-Kamerasteuerung.

Damit kann eine Host-App OBSBOT-Kameras (Tiny / Meet / Tail) DIREKT steuern —
Gimbal/Zoom/Tracking/Presets/Wake-Sleep usw. — ohne externes SDK und ohne das
Elgato-Stream-Deck-Plugin. Der Client ist absichtlich generisch (kein Wissen über
eine konkrete Host-App) und host-agnostisch.

Protokoll (reverse-engineered, identisch zum offiziellen Plugin + Bitfocus-Companion-Modul):
  • Transport: OSC über **UDP** (touchOSC-Schema). Send-and-forget, kein Handshake/Auth.
  • Ziel: die OBSBOT-Steuersoftware (Prozess ``OBSBOT_WebCam.exe`` bzw. „OBSBOT Center").
    Standard ``127.0.0.1:16284`` (in der App als „Receive Port" einstellbar).
  • ⚠ Die App MUSS laufen UND „OSC" in ihren Einstellungen aktiviert haben — sonst lauscht
    niemand auf 16284 und die Befehle verpuffen lautlos (UDP bestätigt nichts).
  • USB-Kameras (Tiny/Meet) steuert die App per USB; wir sprechen nur die App an. Sie ist der
    „Server" — exakt die Rolle, die Wave Link für ``wavelink.py`` spielt.

Eigenschaften (analog ``ObsDirect`` / ``WaveLinkDirect``):
  • Ein einzelner UDP-Socket, LAZY beim ersten Senden erzeugt, wiederverwendet, thread-safe.
  • Graceful: jede Methode fängt Fehler ab und liefert ``{success, message}`` statt zu werfen.
  • Host/Port zur Laufzeit umstellbar (``set_config``) — eine Hülle auf einem ANDEREN Rechner
    als die Kameras zeigt den Host einfach auf die IP des Kamera-PCs.

OSC-Adressen: die ``General/*``-Befehle gelten geräteübergreifend (Tiny/Meet/Tail), die
``Tiny/*``-Befehle nur für die Tiny-Familie. Autoritative, vollständige Liste pro Modell =
OBSBOTs per-Modell-``.xlsx`` (https://www.obsbot.com/explore/obsbot-center/osc); Referenz-
Implementierung = Bitfocus ``companion-module-obsbot-osc``.
"""
from __future__ import annotations

import logging
import socket
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Optional

log = logging.getLogger("deckcore.obsbot")

_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 16284          # OBSBOT „Receive Port" (Default)
_PROC_TTL = 3.0                # s — Cache, wie oft wir den App-Prozess prüfen (Status)
_OBSBOT_PROCS = ("OBSBOT_WebCam.exe", "OBSBOT_Center.exe", "OBSBOT Center.exe")


# ── OSC-Encoder (hand-gerollt — kein python-osc nötig; deckcore bleibt dep-frei) ──
def _osc_string(s: str) -> bytes:
    """OSC-String: UTF-8 + mind. ein Null-Byte, auf 4 Byte aufgefüllt."""
    b = s.encode("utf-8", "replace") + b"\x00"
    return b + b"\x00" * ((-len(b)) % 4)


def _osc_message(address: str, args: tuple) -> bytes:
    """Eine OSC-Message bauen: Adresse + Typetag (",iif…") + 4-Byte-ausgerichtete Args.
    Unterstützt int (i), float (f), str (s). bool wird zu int 0/1 (OBSBOT erwartet Zahlen)."""
    tag = ","
    payload = b""
    for a in args:
        if isinstance(a, bool):
            tag += "i"; payload += struct.pack(">i", 1 if a else 0)
        elif isinstance(a, int):
            tag += "i"; payload += struct.pack(">i", a)
        elif isinstance(a, float):
            tag += "f"; payload += struct.pack(">f", a)
        elif isinstance(a, str):
            tag += "s"; payload += _osc_string(a)
        else:
            tag += "i"; payload += struct.pack(">i", int(a))
    return _osc_string(address) + _osc_string(tag) + payload


def _clampi(v: Any, lo: int, hi: int, default: int = 0) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return lo if n < lo else hi if n > hi else n


class ObsBotOSC:
    """Direkter OBSBOT-OSC-Client (UDP, send-only, thread-safe, graceful)."""

    def __init__(self, host: str = _DEFAULT_HOST, port: int = _DEFAULT_PORT):
        self._host = str(host or _DEFAULT_HOST)
        self._port = int(port or _DEFAULT_PORT)
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._proc_cache: tuple = (None, -1e9)   # (running?, monotonic)
        self._last_send: float = 0.0

    # ── Verbindung/Config ────────────────────────────────────────────────
    def set_config(self, host: str | None = None, port: int | None = None) -> dict:
        """Ziel umstellen (z.B. Host = IP des Kamera-PCs). Schließt den alten Socket."""
        with self._lock:
            if host is not None:
                self._host = str(host or _DEFAULT_HOST)
            if port is not None:
                self._port = int(port or _DEFAULT_PORT)
            if self._sock is not None:
                try:
                    self._sock.close()
                except Exception:  # noqa: BLE001
                    pass
                self._sock = None
        return {"success": True, "host": self._host, "port": self._port}

    def _socket(self) -> Optional[socket.socket]:
        if self._sock is None:
            try:
                self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            except OSError as e:
                log.warning("obsbot: UDP-Socket-Fehler: %s", e)
                self._sock = None
        return self._sock

    def send(self, address: str, *args) -> dict:
        """Eine rohe OSC-Message an die OBSBOT-App schicken (fire-and-forget)."""
        pkt = _osc_message(address, args)
        with self._lock:
            sock = self._socket()
            if sock is None:
                return {"success": False, "message": "OSC-Socket nicht verfügbar"}
            try:
                sock.sendto(pkt, (self._host, self._port))
                self._last_send = time.monotonic()
            except OSError as e:
                log.warning("obsbot: sendto %s:%s fehlgeschlagen: %s", self._host, self._port, e)
                return {"success": False, "message": f"OSC-Send fehlgeschlagen: {e}"}
        return {"success": True, "message": f"OSC {address} {' '.join(str(a) for a in args)}".strip()}

    # ── Geräte-Adressierung (Mehr-Kamera) — GELÖST (offizielle OSC-Spec) ──────────────
    # Bei MEHREREN Kameras adressiert ein optionaler **Geräte-Index als ERSTES OSC-Argument**
    # die Zielkamera: 0 = Gerät 1, 1 = Gerät 2, … (verbatim aus OBSBOTs OSC-Definition; ebenso
    # im Bitfocus-Companion-Modul + ObsbotSharp). Ohne Index zählt die aktuell gewählte Kamera —
    # für unabhängige Buttons hängen wir den Index daher IMMER vorn an. Ausnahmen (kein Index):
    # die Session-Befehle Connected/SelectDevice. ⚠ Zwei BAUGLEICHE Tiny 3 in OBSBOT Center per
    # „Positions-Sperre" auf Slot 1/2 fixieren, sonst vertauschen sie sich beim Reconnect.
    def _dev_send(self, address: str, device: Any, *args) -> dict:
        """OSC senden, optional mit führendem Geräte-Index (0-basiert) als erstem Argument."""
        if device is not None and device != "":
            try:
                args = (int(device),) + args
            except (TypeError, ValueError):
                pass
        return self.send(address, *args)

    def connected(self) -> dict:
        """Handshake/Presence-Probe (ohne Geräte-Index) — die App antwortet mit der Geräteliste."""
        return self.send("/OBSBOT/WebCam/General/Connected", 0)

    def select_device(self, index: Any) -> dict:
        """Aktive Kamera umschalten (0 = Gerät 1, 1 = Gerät 2 …) — Index ist das einzige Argument."""
        return self.send("/OBSBOT/WebCam/General/SelectDevice", _clampi(index, 0, 7))

    # ── Befehle: General (geräteübergreifend) ────────────────────────────
    def recenter(self, device: Any = None) -> dict:
        """Gimbal zurück in die Mitte."""
        return self._dev_send("/OBSBOT/WebCam/General/ResetGimbal", device, 0)

    def wake(self, device: Any = None) -> dict:
        """Kamera aufwecken (richtet sich auf)."""
        return self._dev_send("/OBSBOT/WebCam/General/WakeSleep", device, 1)

    def sleep(self, device: Any = None) -> dict:
        """Kamera schlafen legen (dreht nach unten weg — Privatsphäre)."""
        return self._dev_send("/OBSBOT/WebCam/General/WakeSleep", device, 0)

    def set_zoom(self, percent: Any, device: Any = None) -> dict:
        """Zoom absolut 0–100 %."""
        return self._dev_send("/OBSBOT/WebCam/General/SetZoom", device, _clampi(percent, 0, 100))

    def set_view(self, mode: Any, device: Any = None) -> dict:
        """Sichtfeld/FOV: 0 = 86°, 1 = 78°, 2 = 65°."""
        return self._dev_send("/OBSBOT/WebCam/General/SetView", device, _clampi(mode, 0, 2))

    def set_mirror(self, on: Any, device: Any = None) -> dict:
        return self._dev_send("/OBSBOT/WebCam/General/SetMirror", device, 1 if on else 0)

    def gimbal_move(self, pan: Any, pitch: Any, speed: Any = 1, device: Any = None) -> dict:
        """Gimbal auf absolute Grad fahren: speed 0…90, pan −129…129, pitch −59…59."""
        return self._dev_send("/OBSBOT/WebCam/General/SetGimMotorDegree", device,
                              _clampi(speed, 0, 90, 1), _clampi(pan, -129, 129), _clampi(pitch, -59, 59))

    def gimbal_dir(self, direction: str, speed: Any = 50, device: Any = None) -> dict:
        """Gimbal in eine Richtung fahren (speed 1–100; speed 0 = STOPP). Tap-Nudge = kurz senden, dann 0."""
        addr = {"up": "SetGimbalUp", "down": "SetGimbalDown",
                "left": "SetGimbalLeft", "right": "SetGimbalRight"}.get(str(direction).strip().lower())
        if not addr:
            return {"success": False, "message": f"Unbekannte Richtung: {direction}"}
        return self._dev_send(f"/OBSBOT/WebCam/General/{addr}", device, _clampi(speed, 0, 100, 50))

    def record(self, on: Any, device: Any = None) -> dict:
        """PC-Aufnahme der App starten/stoppen."""
        return self._dev_send("/OBSBOT/WebCam/General/SetPCRecording", device, 1 if on else 0)

    def snapshot(self, device: Any = None) -> dict:
        return self._dev_send("/OBSBOT/WebCam/General/PCSnapshot", device, 1)

    # ── Befehle: Tiny-Familie (Tiny 2/3/SE; Adressen aus der offiziellen Spec, Tiny-3-kompatibel) ──
    def tracking(self, on: Any, device: Any = None) -> dict:
        """AI-Tracking (Zielverfolgung) an/aus — ToggleAILock 1/0."""
        return self._dev_send("/OBSBOT/WebCam/Tiny/ToggleAILock", device, 1 if on else 0)

    def ai_mode(self, mode: Any, device: Any = None) -> dict:
        """AI-Modus (Tiny 3): 0 Mensch-Einzel · 1 Mensch-Gruppe · 2 Stimme · 3 Desk · 4 Hand · 5 Whiteboard."""
        return self._dev_send("/OBSBOT/WebCam/Tiny/SetAiMode", device, _clampi(mode, 0, 5))

    def framing(self, mode: Any, device: Any = None) -> dict:
        """Bildausschnitt-Verfolgung: 0 = Headroom, 1 = Standard, 2 = Motion."""
        return self._dev_send("/OBSBOT/WebCam/Tiny/SetTrackingMode", device, _clampi(mode, 0, 2))

    def tracking_speed(self, mode: Any, device: Any = None) -> dict:
        """Verfolgungs-Tempo (nur Tiny 3): 0 = langsam, 1 = standard, 2 = schnell."""
        return self._dev_send("/OBSBOT/WebCam/Tiny/SetTrackingSpeed", device, _clampi(mode, 0, 2))

    def preset(self, index: Any, device: Any = None) -> dict:
        """Gespeicherte Preset-Position aufrufen (0 = Preset 1, 1 = Preset 2, 2 = Preset 3).
        Speichern geht NICHT über OSC — Presets in OBSBOT Center anlegen."""
        return self._dev_send("/OBSBOT/WebCam/Tiny/TriggerPreset", device, _clampi(index, 0, 2))

    # ── Status (best effort) ─────────────────────────────────────────────
    def _app_running(self) -> Optional[bool]:
        """Läuft die OBSBOT-Steuersoftware? (Cache; None außerhalb Windows.)"""
        if not sys.platform.startswith("win"):
            return None
        running, ts = self._proc_cache
        if (time.monotonic() - ts) < _PROC_TTL:
            return running
        found = None
        try:
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq OBSBOT_WebCam.exe", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=2.0,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            blob = (out.stdout or "").lower()
            found = any(p.lower() in blob for p in _OBSBOT_PROCS)
        except Exception:  # noqa: BLE001
            found = None
        self._proc_cache = (found, time.monotonic())
        return found

    def status(self) -> dict:
        """Best-effort-Status für die UI. UDP bestätigt nichts → ``app_running`` ist das beste Signal."""
        return {"host": self._host, "port": self._port,
                "app_running": self._app_running(),
                "last_send_age": (round(time.monotonic() - self._last_send, 1) if self._last_send else None)}
