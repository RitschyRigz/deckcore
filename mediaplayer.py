"""Media-Player-Anbindung (mpv) — spielt eine Videodatei in einem RANDLOSEN, dauerhaften Fenster,
das z.B. TikTok Live Studio als **Fensterquelle** abgreift.

Knackpunkt: TTLS setzt EINGEBETTETE Videos beim Szenenwechsel NICHT zurueck (spielt einmal, friert
dann ein). Ein extern gesteuerter Player schon — also: mpv haelt EIN Fenster offen und spielt auf
Knopfdruck **in-place von vorn** (IPC ``loadfile`` -> kein Fenster-Flackern fuer die Capture).

Public-clean: mpv wird **NICHT gebuendelt**, sondern aus Config-Pfad / PATH / Standardorten
aufgeloest. Ohne mpv meldet die Aktion 'mpv nicht gefunden' (kein Crash). Generisch in deckcore
(Cockpit + RigzDeck).
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import subprocess
import threading
from ctypes import wintypes

_PROCS: dict = {}        # slot -> subprocess.Popen (eine persistente mpv-Fensterinstanz je Slot)
_LOCK = threading.Lock()


def _slug(s) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", str(s or "media").strip().lower()).strip("-") or "media"


def _candidate_mpv(configured: str | None) -> list:
    out: list = []
    if configured:
        out.append(configured)
    try:
        p = shutil.which("mpv")
        if p:
            out.append(p)
    except Exception:  # noqa: BLE001
        pass
    out += [
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files\mpv.net\mpv.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\mpv.exe"),
    ]
    seen, uniq = set(), []
    for c in out:
        if c and c not in seen and os.path.isfile(c):
            seen.add(c)
            uniq.append(c)
    return uniq


def resolve_mpv(configured: str | None = None) -> str:
    c = _candidate_mpv(configured)
    return c[0] if c else ""


def available(configured: str | None = None) -> bool:
    return bool(resolve_mpv(configured))


def _pipe_name(slot: str) -> str:
    return r"\\.\pipe\rigzdeck-mpv-" + _slug(slot)


def _ipc_send(slot: str, *commands: dict) -> bool:
    """Ein ODER MEHRERE JSON-Kommandos an ein laufendes mpv (Named Pipe) schicken — alle in EINER
    Verbindung (newline-getrennt), damit nicht mehrere schnelle Pipe-Öffnungen auf eine Busy-Pipe
    treffen. False, wenn die Pipe nicht erreichbar ist (mpv laeuft (noch) nicht). Blockiert nie:
    CreateFileW kehrt sofort zurück (kein WaitNamedPipe)."""
    if not commands:
        return False
    name = _pipe_name(slot)
    GENERIC_RW = 0xC0000000
    OPEN_EXISTING = 3
    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    except Exception:  # noqa: BLE001 — nicht Windows
        return False
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    h = k32.CreateFileW(name, GENERIC_RW, 0, None, OPEN_EXISTING, 0, None)
    invalid = ctypes.c_void_p(-1).value
    if not h or h == invalid:
        return False
    try:
        data = "".join(json.dumps(c) + "\n" for c in commands).encode("utf-8")
        written = wintypes.DWORD(0)
        ok = k32.WriteFile(h, data, len(data), ctypes.byref(written), None)
        return bool(ok)
    finally:
        k32.CloseHandle(h)


def _alive(slot: str) -> bool:
    p = _PROCS.get(slot)
    return p is not None and p.poll() is None


_EQ_KEYS = ("brightness", "contrast", "gamma", "saturation")   # mpv-Video-Equalizer, je -100..100


def _eq_value(v):
    try:
        return max(-100, min(100, int(float(v))))
    except (TypeError, ValueError):
        return None


def _eq_flags(eq) -> list:
    """{brightness,contrast,gamma,saturation} → mpv-Startflags (nur != 0)."""
    out: list = []
    if isinstance(eq, dict):
        for k in _EQ_KEYS:
            iv = _eq_value(eq.get(k))
            if iv:
                out.append(f"--{k}={iv}")
    return out


def adjust(slot: str = "media", eq=None) -> dict:
    """Bild-Equalizer (brightness/contrast/gamma/saturation, -100..100) LIVE am laufenden mpv
    setzen (IPC, ohne Neustart) — fürs Echtzeit-Tunen der HDR-Capture-Helligkeit. False, wenn
    für den Slot kein mpv läuft."""
    cmds = []
    if isinstance(eq, dict):
        for k in _EQ_KEYS:
            if k in eq:
                iv = _eq_value(eq.get(k))
                if iv is not None:
                    cmds.append({"command": ["set_property", k, iv]})
    if not cmds:
        return {"ok": False, "message": "nichts zu setzen"}
    ok = _ipc_send(_slug(slot), *cmds)
    return {"ok": bool(ok), "message": "Bild angepasst" if ok else "Player läuft nicht für diesen Slot"}


def _parse_extra_args(extra) -> list:
    """``extra_args`` (String ODER Liste) → Liste von mpv-Flags. Shlex-getrennt (Quotes ok)."""
    if not extra:
        return []
    if isinstance(extra, (list, tuple)):
        return [str(a) for a in extra if str(a).strip()]
    try:
        import shlex
        return [a for a in shlex.split(str(extra), posix=False) if a.strip()]
    except Exception:  # noqa: BLE001
        return [a for a in str(extra).split() if a.strip()]


def play(file: str, *, slot: str = "media", loop: bool = False,
         fullscreen: bool = False, mpv_path: str | None = None, extra_args=None, eq=None) -> dict:
    """Datei von VORN abspielen. Laeuft das Slot-Fenster schon → in-place neu starten (IPC,
    kein Flackern); sonst mpv frisch starten. ``slot`` = Fenster-Identitaet (Titel
    ``RigzDeck Media: <slot>`` → in TTLS als Fensterquelle waehlbar)."""
    if os.name != "nt":
        return {"ok": False, "message": "Media-Player nur unter Windows"}
    f = str(file or "").strip().strip('"')
    if not f or not os.path.isfile(f):
        return {"ok": False, "message": f"Datei nicht gefunden: {f or '(leer)'}"}
    mpv = resolve_mpv(mpv_path)
    if not mpv:
        return {"ok": False, "message": "mpv nicht gefunden — Pfad in den Player-Einstellungen setzen oder mpv installieren"}
    slot = _slug(slot)
    with _LOCK:
        # 1) In-Place-Restart ZUERST über die IPC-Pipe (NICHT über _PROCS/poll, das ist auf manchen
        #    Setups unzuverlässig — mpv.exe kann einen Kindprozess starten, der getrackte „stirbt").
        #    Läuft eine mpv-Instanz mit diesem Slot → von vorn im SELBEN Fenster. Übersteht sogar
        #    Cockpit-Neustarts (findet das laufende mpv an seiner Named Pipe wieder).
        if _ipc_send(slot,
                     {"command": ["loadfile", f, "replace"]},
                     {"command": ["set_property", "loop-file", "inf" if loop else "no"]},
                     {"command": ["set_property", "pause", "no"]}):
            return {"ok": True, "message": f"Replay: {os.path.basename(f)}"}
        # 2) Keine erreichbare Instanz → evtl. toten Track aufraeumen, dann frisch starten.
        old = _PROCS.pop(slot, None)
        if old is not None:
            try:
                old.kill()
            except Exception:  # noqa: BLE001
                pass
        args = [
            mpv, f,
            "--no-border", "--force-window=yes", "--keep-open=yes", "--idle=yes",
            "--no-osc", "--ontop=no", "--no-input-default-bindings",
            "--input-ipc-server=" + _pipe_name(slot),
            "--title=RigzDeck Media: " + slot,
            "--loop-file=inf" if loop else "--loop-file=no",
            "--fullscreen=yes" if fullscreen else "--fullscreen=no",
        ]
        # Bild-Equalizer (HDR-Capture-Helligkeit) + zusätzliche mpv-Flags. NUR beim Frischstart —
        # zum Live-Tunen ohne Neustart dient adjust() (IPC set_property).
        args += _eq_flags(eq)
        args += _parse_extra_args(extra_args)
        try:
            CREATE_NO_WINDOW = 0x08000000     # nur die Konsole unterdruecken — mpv hat sein eigenes GUI-Fenster
            p = subprocess.Popen(args, creationflags=CREATE_NO_WINDOW,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _PROCS[slot] = p
            return {"ok": True, "message": f"Starte: {os.path.basename(f)}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "message": f"mpv-Start fehlgeschlagen: {e}"}


def stop(slot: str = "media") -> dict:
    slot = _slug(slot)
    with _LOCK:
        sent = _ipc_send(slot, {"command": ["quit"]})    # laufendes mpv über die Pipe beenden
        old = _PROCS.pop(slot, None)
        if old is not None and not sent:
            try:
                old.kill()
            except Exception:  # noqa: BLE001
                pass
        return {"ok": True, "message": "Player gestoppt" if (sent or old is not None) else "Player war nicht aktiv"}


def status(configured: str | None = None) -> dict:
    mpv = resolve_mpv(configured)
    return {
        "available": bool(mpv),
        "mpv_path": mpv,
        "active_slots": [s for s in list(_PROCS.keys()) if _alive(s)],
    }
