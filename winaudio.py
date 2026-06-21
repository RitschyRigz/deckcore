"""
WinAudio — Client für den Out-of-Process Core-Audio-Helfer (``winaudio_helper.py``).

DIESES Modul macht KEIN COM. Das gesamte ``comtypes``/``pycaw``-COM lebt im Helfer-SUBPROZESS,
weil es den Host sonst gelegentlich hart mit ``0xC0000005`` (Access Violation in ``_ctypes.pyd``)
crasht — uncatchbar auf C-Ebene (nebenläufige/zyklisch-GC'te COM-Objekte). Im Subprozess killt ein
COM-Fehler nur den Helfer; der Host (Cockpit/RigzDeck) läuft weiter und startet ihn mit Cooldown neu.

Öffentliche API unverändert (Aufrufer in service.py): ``available`` · ``default_render_id`` ·
``set_default`` · ``is_default_render`` · ``render_devices`` · ``resolve_render_id`` ·
``volume_snapshot`` · ``set_master_volume`` · ``set_master_mute`` · ``master_volume`` · ``master_muted``.

IPC: JSON-Zeilen über stdin/stdout. Der Helfer pusht ~12 Hz den vollen Zustand (Geräte/Standard/
Snapshots); dieser Client cached ihn und sendet Befehle (watch/set_*). Reads sind also nie blockierend
und nie COM — sie liefern den letzten gepushten Zustand (leer/`available:false`, solange der Helfer
gerade (neu) startet).
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("deckcore.winaudio")

_PKG_DIR = Path(__file__).resolve().parent
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_SPAWN_COOLDOWN = 3.0       # s — nach Helfer-Tod/Spawn-Fehler so lange nicht erneut starten
_STATE_STALE = 5.0          # s — ohne frischen Push gilt der Zustand als veraltet


class WinAudio:
    """Dünner Client zum Audio-Helfer-Subprozess. Thread-safe, lazy, graceful."""

    def __init__(self):
        self._lock = threading.RLock()
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._state = {"available": False, "default_id": None, "devices": [], "sessions": [], "snaps": {}}
        self._state_ts = 0.0
        self._last_fail = 0.0

    # ── Prozess-Lebenszyklus ─────────────────────────────────────────────
    def _helper_args(self):
        # Eingefroren (.exe): der Host-Entrypoint MUSS `--deckcore-winaudio-helper` abfangen und
        # winaudio_helper.main() ausführen. Sonst: als Modul über denselben Interpreter (-u = unbuffered,
        # damit die JSON-Zeilen sofort durch die Pipe kommen).
        if getattr(sys, "frozen", False):
            return [sys.executable, "--deckcore-winaudio-helper"]
        return [sys.executable, "-u", "-m", "deckcore.winaudio_helper"]

    def _ensure_proc(self) -> bool:
        with self._lock:
            p = self._proc
            if p is not None and p.poll() is None:
                return True
            if self._last_fail and (time.monotonic() - self._last_fail) < _SPAWN_COOLDOWN:
                return False
            self._proc = None
            try:
                p = subprocess.Popen(
                    self._helper_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
                    bufsize=1, cwd=str(_PKG_DIR.parent), creationflags=_CREATE_NO_WINDOW)
            except Exception as e:  # noqa: BLE001
                self._last_fail = time.monotonic()
                log.warning("Audio-Helfer-Start fehlgeschlagen: %r", e)
                return False
            self._proc = p
            self._reader = threading.Thread(target=self._read_loop, args=(p,), name="winaudio-reader", daemon=True)
            self._reader.start()
            return True

    def _read_loop(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stdout:                # blockiert; EOF = Helfer weg/tot
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if obj.get("type") == "state":
                    with self._lock:
                        self._state = {"available": bool(obj.get("available")),
                                       "default_id": obj.get("default_id"),
                                       "devices": obj.get("devices") or [],
                                       "sessions": obj.get("sessions") or [],
                                       "snaps": obj.get("snaps") or {}}
                        self._state_ts = time.monotonic()
        except Exception:  # noqa: BLE001
            pass
        # Helfer ist weg → Zustand auf „nicht verfügbar", Cooldown vor Respawn.
        with self._lock:
            if self._proc is proc:
                self._proc = None
                self._state = {"available": False, "default_id": None, "devices": [], "sessions": [], "snaps": {}}
                self._last_fail = time.monotonic()
        log.warning("Audio-Helfer beendet (EOF) — wird bei Bedarf neu gestartet.")

    def _send(self, obj: dict) -> bool:
        if not self._ensure_proc():
            return False
        with self._lock:
            p = self._proc
        if p is None or p.poll() is not None or p.stdin is None:
            return False
        try:
            p.stdin.write(json.dumps(obj) + "\n")
            p.stdin.flush()
            return True
        except Exception:  # noqa: BLE001
            with self._lock:
                if self._proc is p:
                    self._proc = None
                    self._last_fail = time.monotonic()
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass
            return False

    def _fresh(self) -> dict:
        with self._lock:
            if self._state_ts and (time.monotonic() - self._state_ts) > _STATE_STALE:
                return {"available": False, "default_id": None, "devices": [], "sessions": [], "snaps": {}}
            return self._state

    # ── Status / Lesen ───────────────────────────────────────────────────
    def available(self) -> bool:
        self._ensure_proc()
        return bool(self._fresh().get("available"))

    def default_render_id(self, role: str = "multimedia") -> Optional[str]:
        self._ensure_proc()
        return self._fresh().get("default_id")

    def render_devices(self) -> list:
        """Aktive Ausgabegeräte ``[{id, name}]`` (vom Helfer gepusht)."""
        self._ensure_proc()
        return list(self._fresh().get("devices") or [])

    def audio_sessions(self) -> list:
        """Aktive App-Audio-Sessions ``[{id:'app:<proc>', name, proc}]`` (vom Helfer gepusht). Sendet
        zugleich den ``@sessions``-Watch → der Helfer sammelt + hält die Liste frisch (App-Mixer-Dropdown).
        Beim ALLERERSTEN Aufruf ist die Liste noch leer (der Helfer sammelt sie erst NACH dem Watch, ~1
        Tick) → kurz (≤0.8 s) darauf warten, damit das Editor-Dropdown sofort gefüllt ist statt erst beim
        zweiten Öffnen. Nur eine Editor-/Generator-Abfrage (nicht der schnelle Fader-Poll) → ok zu warten."""
        self._send({"cmd": "watch", "target": "@sessions"})
        s = self._fresh().get("sessions") or []
        # Erst-Aufruf: der Helfer braucht nach (Neu-)Start ~1 s, bis er „available" meldet UND die Liste
        # gesammelt hat. Kurz darauf warten (unabhängig vom available-Flag — beim Spawn ist es noch False),
        # damit das Editor-Dropdown/die Kategorie-Liste sofort gefüllt sind statt leer zu erscheinen.
        if not s:
            deadline = time.monotonic() + 1.2
            while not s and time.monotonic() < deadline:
                time.sleep(0.1)
                s = self._fresh().get("sessions") or []
        return list(s)

    def resolve_render_id(self, name_substring: str) -> Optional[str]:
        sub = (name_substring or "").lower()
        if not sub:
            return None
        for d in self.render_devices():
            if sub in (d.get("name") or "").lower():
                return d.get("id")
        return None

    def is_default_render(self, device_id: str, role: str = "multimedia") -> Optional[bool]:
        device_id = str(device_id or "")
        if not device_id:
            return None
        cur = self.default_render_id(role)
        return None if cur is None else (cur == device_id)

    def volume_snapshot(self, device_id: Optional[str] = None) -> dict:
        """{available, level(0..100|None), muted(bool|None), peak(0..1)} des Geräts (leer = Standard).
        Sendet zugleich „watch" → der Helfer hält dieses Gerät offen + sampelt es."""
        key = str(device_id or "")
        self._send({"cmd": "watch", "target": key})
        s = dict((self._fresh().get("snaps") or {}).get(key) or {})
        if not s:
            return {"available": False, "level": None, "muted": None, "peak": 0.0}
        return s

    def set_master_volume(self, level_0_100, device_id: Optional[str] = None) -> dict:
        key = str(device_id or "")
        self._send({"cmd": "watch", "target": key})          # sicherstellen, dass der Helfer das Gerät offen hat
        ok = self._send({"cmd": "set_volume", "target": key, "level": level_0_100})
        try:
            pct = round(float(level_0_100))
        except (TypeError, ValueError):
            pct = level_0_100
        return {"success": ok, "message": (f"Lautstärke -> {pct}%" if ok else "Audio-Helfer nicht verfügbar")}

    def set_master_mute(self, muted: Optional[bool] = None, device_id: Optional[str] = None) -> dict:
        key = str(device_id or "")
        self._send({"cmd": "watch", "target": key})
        ok = self._send({"cmd": "set_mute", "target": key, "muted": None if muted is None else bool(muted)})
        return {"success": ok, "message": ("Mute umgeschaltet" if ok else "Audio-Helfer nicht verfügbar")}

    def master_volume(self, device_id: Optional[str] = None) -> Optional[int]:
        return self.volume_snapshot(device_id).get("level")

    def master_muted(self, device_id: Optional[str] = None) -> Optional[bool]:
        return self.volume_snapshot(device_id).get("muted")

    # ── App-Audio (App-Mixer: Lautstärke/Mute/VU je Programm via ISimpleAudioVolume) ──
    # Opaker Target-Key ``app:<proc>`` durch dieselbe watch/snaps-Mechanik wie die Geräte-Snapshots.
    def app_snapshot(self, proc: str) -> dict:
        """{available, level(0..100|None), muted(bool|None), peak(0..1)} aller Sessions eines Prozesses."""
        return self.volume_snapshot("app:" + str(proc or ""))

    def app_set_volume(self, proc: str, level_0_100) -> dict:
        return self.set_master_volume(level_0_100, "app:" + str(proc or ""))

    def app_set_mute(self, proc: str, muted: Optional[bool] = None) -> dict:
        return self.set_master_mute(muted, "app:" + str(proc or ""))

    # ── Setzen: Windows-Standard-Ausgabegerät ────────────────────────────
    def set_default(self, device_id: str, roles=("console", "multimedia")) -> dict:
        """Windows-Standard-Ausgabegerät setzen (im Helfer via IPolicyConfig). Optimistisch — das
        Statuslicht (winaudio_default-Monitor) zeigt anschließend die Wahrheit aus dem gepushten Zustand."""
        device_id = str(device_id or "")
        if not device_id:
            return {"success": False, "message": "Kein Gerät gewählt"}
        ok = self._send({"cmd": "set_default", "device_id": device_id, "roles": list(roles)})
        return {"success": ok, "message": ("Windows-Standard gesetzt" if ok else "Audio-Helfer nicht verfügbar")}

    def close(self) -> None:
        with self._lock:
            p = self._proc
            self._proc = None
        if p is not None:
            try:
                if p.stdin:
                    p.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                p.terminate()
            except Exception:  # noqa: BLE001
                pass
