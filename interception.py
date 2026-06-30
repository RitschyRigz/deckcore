"""Interception-Treiber-Anbindung (optional) — Tastendruecke auf KERNEL-Ebene.

Manche Apps verwerfen OS-injizierte Eingaben (z.B. ``SendInput``/``keybd_event``), weil sie das
„injected"-Flag pruefen oder rohes HID lesen — typisch fuer **TikTok Live Studio**. Der
Interception-Filtertreiber (https://github.com/oblitum/Interception) sendet Anschlaege so weit
unten im Stack, dass sie fuer die Ziel-App **ununterscheidbar von echter Hardware** sind.

Public-clean: die ``interception.dll`` wird **NICHT** mitgeliefert, sondern aus einem
konfigurierten Pfad bzw. einem Standard-Download-Ort geladen. Ohne Treiber/DLL ist das Modul
einfach „nicht verfuegbar" — der normale ``SendInput``-Weg bleibt der Default.

Geraete-Auflösung ueber die **Hardware-ID** (nicht ueber eine fixe Nummer): es gibt oft mehrere
Tastatur-Geraete (z.B. Maus-Collections), und die Nummer kann sich beim Umstecken aendern. Die
Host-App kalibriert einmal (User drueckt eine Taste -> ``learn_keyboard``) und merkt sich die
Hardware-ID; zur Laufzeit wird daraus die aktuelle Geraetenummer aufgeloest.
"""
from __future__ import annotations

import ctypes
import glob
import os
import threading
import time
from pathlib import Path

# Interception Key-States / Filter-Flags
_KEY_DOWN = 0x00
_KEY_UP = 0x01
_KEY_E0 = 0x02                 # Extended-Taste (Pfeile/Nav/rechte Modifier/Numpad-Enter …)
_FILTER_KEY_ALL = 0xFFFF
_FILTER_KEY_NONE = 0x0000


class _Stroke(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("state", ctypes.c_ushort), ("information", ctypes.c_uint)]


_PREDICATE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int)


def _candidate_dll_paths(configured: str | None) -> list:
    """Reihenfolge: konfigurierter Pfad -> neben dem Modul/der App -> Standard-Download-Orte."""
    out: list = []
    if configured:
        out.append(configured)
    here = Path(__file__).resolve().parent
    out.append(str(here / "interception.dll"))
    out.append(str(here.parent / "interception.dll"))
    home = os.path.expanduser("~")
    try:
        out += glob.glob(os.path.join(home, "Down*", "**", "x64", "interception.dll"), recursive=True)
        out += glob.glob(os.path.join(home, "**", "library", "x64", "interception.dll"), recursive=True)
    except Exception:  # noqa: BLE001
        pass
    # Duplikate raus, Reihenfolge erhalten
    seen, uniq = set(), []
    for p in out:
        if p and p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


class Interception:
    """Lazy-Wrapper um ``interception.dll``. Thread-safe; pro Sende-Vorgang ein eigener Context
    (Anschlaege sind menschlich getaktet -> der Overhead ist unkritisch, dafuer kein haengender
    Treiber-State)."""

    def __init__(self, dll_path: str | None = None):
        self._dll_path = dll_path or None
        self._dll = None
        self._tried_load = False
        self._err = ""
        self._resolved_path = ""
        self._lock = threading.Lock()

    # ── Konfiguration ────────────────────────────────────────────────────
    def configure(self, dll_path: str | None) -> None:
        dll_path = dll_path or None
        if dll_path != self._dll_path:
            self._dll_path = dll_path
            self._dll = None
            self._tried_load = False
            self._err = ""
            self._resolved_path = ""

    @property
    def last_error(self) -> str:
        return self._err

    @property
    def resolved_path(self) -> str:
        return self._resolved_path

    # ── DLL laden ────────────────────────────────────────────────────────
    def _load(self) -> bool:
        if self._tried_load:
            return self._dll is not None
        self._tried_load = True
        cands = _candidate_dll_paths(self._dll_path)
        for p in cands:
            if not (p and os.path.isfile(p)):
                continue
            try:
                dll = ctypes.WinDLL(p)
            except OSError as e:
                self._err = f"DLL laedt nicht (32/64-bit?): {p}: {e}"
                continue
            dll.interception_create_context.restype = ctypes.c_void_p
            dll.interception_destroy_context.argtypes = [ctypes.c_void_p]
            dll.interception_send.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
            dll.interception_send.restype = ctypes.c_int
            dll.interception_get_hardware_id.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
            dll.interception_get_hardware_id.restype = ctypes.c_uint
            dll.interception_is_keyboard.argtypes = [ctypes.c_int]
            dll.interception_is_keyboard.restype = ctypes.c_int
            dll.interception_set_filter.argtypes = [ctypes.c_void_p, _PREDICATE, ctypes.c_ushort]
            dll.interception_wait_with_timeout.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            dll.interception_wait_with_timeout.restype = ctypes.c_int
            dll.interception_receive.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
            dll.interception_receive.restype = ctypes.c_int
            self._dll = dll
            self._resolved_path = p
            return True
        if not self._err:
            self._err = "interception.dll nicht gefunden (Pfad in den Treiber-Einstellungen setzen)"
        return False

    # ── Geraete ──────────────────────────────────────────────────────────
    def _list_keyboards(self, ctx) -> list:
        """[(device, hardware_id), …] aller ECHT angeschlossenen Tastatur-Geraete (1..10)."""
        out = []
        buf = ctypes.create_unicode_buffer(512)
        for d in range(1, 11):
            n = self._dll.interception_get_hardware_id(ctx, d, buf, ctypes.sizeof(buf))
            if n > 0 and buf.value:
                out.append((d, buf.value))
        return out

    def list_keyboards(self) -> list:
        with self._lock:
            if not self._load():
                return []
            ctx = self._dll.interception_create_context()
            if not ctx:
                self._err = "Kein Context (Treiber nicht aktiv / Reboot nach Installation noetig)"
                return []
            try:
                return self._list_keyboards(ctx)
            finally:
                self._dll.interception_destroy_context(ctx)

    def available(self) -> bool:
        """True, wenn DLL ladbar UND Treiber aktiv (mind. eine echte Tastatur sichtbar)."""
        with self._lock:
            if not self._load():
                return False
            ctx = self._dll.interception_create_context()
            if not ctx:
                self._err = "Kein Context (Treiber nicht aktiv / Reboot nach Installation noetig)"
                return False
            try:
                if self._list_keyboards(ctx):
                    self._err = ""
                    return True
                self._err = "Keine Tastatur erkannt"
                return False
            finally:
                self._dll.interception_destroy_context(ctx)

    def _resolve_device(self, ctx, prefer_hwid: str | None):
        kbds = self._list_keyboards(ctx)
        if not kbds:
            return None
        if prefer_hwid:
            for d, hid in kbds:                       # exakter Treffer
                if hid == prefer_hwid:
                    return d
            key = prefer_hwid.split("&REV")[0]        # tolerant: VID&PID (REV/Col duerfen wechseln)
            for d, hid in kbds:
                if hid.split("&REV")[0] == key:
                    return d
        return kbds[0][0]                             # Fallback: erste echte Tastatur

    # ── Senden ───────────────────────────────────────────────────────────
    def send_scancodes(self, scans: list, hold_ms: int = 18, prefer_hwid: str | None = None) -> bool:
        """``scans`` = Liste von ``(scancode:int, extended:bool)``. Alle in Reihenfolge druecken,
        ``hold_ms`` halten, in Gegenreihenfolge loslassen — auf der per Hardware-ID aufgeloesten
        echten Tastatur. False, wenn Treiber/DLL fehlt oder kein Geraet gefunden."""
        if not scans:
            return False
        with self._lock:
            if not self._load():
                return False
            ctx = self._dll.interception_create_context()
            if not ctx:
                self._err = "Kein Context (Treiber nicht aktiv / Reboot nach Installation noetig)"
                return False
            try:
                dev = self._resolve_device(ctx, prefer_hwid)
                if not dev:
                    self._err = "Keine Tastatur gefunden"
                    return False

                def _emit(code: int, up: bool, ext: bool) -> None:
                    state = (_KEY_UP if up else _KEY_DOWN) | (_KEY_E0 if ext else 0)
                    st = _Stroke(code & 0xFF, state, 0)
                    self._dll.interception_send(ctx, dev, ctypes.byref(st), 1)

                for code, ext in scans:
                    _emit(code, False, bool(ext))
                if hold_ms > 0:
                    time.sleep(hold_ms / 1000.0)
                for code, ext in reversed(scans):
                    _emit(code, True, bool(ext))
                self._err = ""
                return True
            finally:
                self._dll.interception_destroy_context(ctx)

    # ── Kalibrierung ─────────────────────────────────────────────────────
    def learn_keyboard(self, timeout_ms: int = 8000):
        """Wartet auf EINEN echten Tastendruck und gibt ``(device, hardware_id)`` zurueck (oder None
        bei Timeout). Der gedrueckte Anschlag wird verschluckt (kein Seiteneffekt). Fuer die
        Kalibrierung: der User drueckt einmal eine Taste auf SEINER Tastatur."""
        with self._lock:
            if not self._load():
                return None
            ctx = self._dll.interception_create_context()
            if not ctx:
                self._err = "Kein Context (Treiber nicht aktiv / Reboot nach Installation noetig)"
                return None
            pred = _PREDICATE(lambda d: 1 if 1 <= d <= 10 else 0)
            try:
                self._dll.interception_set_filter(ctx, pred, _FILTER_KEY_ALL)
                dev = self._dll.interception_wait_with_timeout(ctx, int(timeout_ms))
                if not dev:
                    self._err = "kein Tastendruck erkannt (Timeout)"
                    return None
                st = _Stroke()
                self._dll.interception_receive(ctx, dev, ctypes.byref(st), 1)
                buf = ctypes.create_unicode_buffer(512)
                n = self._dll.interception_get_hardware_id(ctx, dev, buf, ctypes.sizeof(buf))
                self._err = ""
                return (dev, buf.value if n > 0 else "")
            finally:
                try:
                    self._dll.interception_set_filter(ctx, pred, _FILTER_KEY_NONE)
                except Exception:  # noqa: BLE001
                    pass
                self._dll.interception_destroy_context(ctx)
