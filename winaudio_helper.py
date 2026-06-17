"""
WinAudio-Helfer — das gesamte Windows-Core-Audio-COM in einem EIGENEN PROZESS.

Warum ein Subprozess: ``comtypes``/``pycaw`` (ctypes) crashen den Host gelegentlich hart mit
``0xC0000005`` (Access Violation in ``_ctypes.pyd``) — das ist von ``try/except`` NICHT fangbar
(C-Ebene). Ursache sind nebenläufige/zyklisch-GC'te COM-Objekte in einem Prozess, der parallel
weitere ctypes-Libs nutzt. EIN Lock reicht nicht. Lagern wir ALLES COM hierher aus, killt ein
COM-Fehler nur DIESEN Helfer — der Host (Cockpit/RigzDeck) läuft weiter und startet ihn neu.

IPC = JSON-Zeilen über stdin/stdout (eine kompakte Zeile pro Nachricht):
  stdin  (Host → Helfer):  {"cmd":"watch","target":"<id>|"} · {"cmd":"set_volume","target":..,"level":0..100}
                           {"cmd":"set_mute","target":..,"muted":bool|null} · {"cmd":"set_default","device_id":..,"roles":[..]}
  stdout (Helfer → Host):  {"type":"state","available":bool,"default_id":str|null,"devices":[{id,name}],
                            "snaps":{"<key>":{available,level,muted,peak,reason}}}   (~12 Hz)

ALLES COM läuft im Haupt-Loop-Thread (ein einziger STA). Der stdin-Reader-Thread macht KEIN COM.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import warnings

_ROLE = {"console": 0, "multimedia": 1, "communications": 2}
_CLSID_POLICY = "{870af99c-171d-4f9e-af0d-e63df40c2bc9}"
_WATCH_IDLE = 20.0       # s ohne erneutes „watch" → Target nicht mehr sampeln
_RERESOLVE = 1.0         # s → Standard-Render-Gerät neu auflösen (folgt Wechsel)
_VOL_EVERY = 0.15        # s → Level/Mute nachlesen (selten); Peak jeden Tick
_DEV_EVERY = 2.0         # s → Geräteliste neu lesen
_DEF_EVERY = 1.0         # s → Standard-Gerät-ID neu lesen
_TICK = 0.08             # s → Loop-/Sende-Rate (~12 Hz)

_IPolicyConfig = None


def _build_policy_iface():
    global _IPolicyConfig
    if _IPolicyConfig is not None:
        return _IPolicyConfig
    from ctypes import HRESULT, c_int, c_wchar_p
    from comtypes import COMMETHOD, GUID, IUnknown

    class IPolicyConfig(IUnknown):
        _iid_ = GUID("{f8679f50-850a-41cf-9c72-430f290290c8}")
        _methods_ = [
            COMMETHOD([], HRESULT, "GetMixFormat"),
            COMMETHOD([], HRESULT, "GetDeviceFormat"),
            COMMETHOD([], HRESULT, "ResetDeviceFormat"),
            COMMETHOD([], HRESULT, "SetDeviceFormat"),
            COMMETHOD([], HRESULT, "GetProcessingPeriod"),
            COMMETHOD([], HRESULT, "SetProcessingPeriod"),
            COMMETHOD([], HRESULT, "GetShareMode"),
            COMMETHOD([], HRESULT, "SetShareMode"),
            COMMETHOD([], HRESULT, "GetPropertyValue"),
            COMMETHOD([], HRESULT, "SetPropertyValue"),
            COMMETHOD([], HRESULT, "SetDefaultEndpoint",
                      (["in"], c_wchar_p, "deviceId"), (["in"], c_int, "role")),
            COMMETHOD([], HRESULT, "SetEndpointVisibility"),
        ]
    _IPolicyConfig = IPolicyConfig
    return IPolicyConfig


class _Com:
    """Das eigentliche Core-Audio-COM — NUR vom Haupt-Loop-Thread aufrufen (ein STA)."""

    def __init__(self):
        self._ifaces = {}   # key ('' = Standard | device_id) -> {vol, meter, resolved, last_vol, err}

    # ── Lesen ──
    def default_id(self, role="multimedia"):
        try:
            import comtypes
            from pycaw.pycaw import IMMDeviceEnumerator, EDataFlow
            from pycaw.constants import CLSID_MMDeviceEnumerator
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                enum = comtypes.CoCreateInstance(
                    CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
                dev = enum.GetDefaultAudioEndpoint(EDataFlow.eRender.value, _ROLE.get(role, 1))
                return dev.GetId()
        except Exception:  # noqa: BLE001
            return None

    def devices(self):
        try:
            from pycaw.pycaw import AudioUtilities
            out = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                for d in AudioUtilities.GetAllDevices():
                    did = d.id or ""
                    if not did.startswith("{0.0.0."):
                        continue
                    if str(getattr(d, "state", "")).split(".")[-1] != "Active":
                        continue
                    if d.FriendlyName:
                        out.append({"id": did, "name": d.FriendlyName})
            return out
        except Exception:  # noqa: BLE001
            return []

    def set_default(self, device_id, roles=("console", "multimedia")):
        try:
            from comtypes import GUID, CLSCTX_ALL, CoCreateInstance
            iface = _build_policy_iface()
            pc = CoCreateInstance(GUID(_CLSID_POLICY), interface=iface, clsctx=CLSCTX_ALL)
            for role in roles:
                pc.SetDefaultEndpoint(device_id, _ROLE.get(role, 1))
            cur = self.default_id("multimedia")
            if cur and cur != device_id:
                return {"success": False, "message": "Gerät nicht verfügbar (Standard unverändert)"}
            return {"success": True, "message": "Windows-Standard gesetzt"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Setzen fehlgeschlagen: {e}"}

    # ── Volume/Meter (Interfaces gehalten + wiederverwendet) ──
    def _open(self, device_id):
        try:
            import comtypes
            from ctypes import POINTER, cast
            from comtypes import CLSCTX_ALL
            from pycaw.pycaw import (IMMDeviceEnumerator, IAudioEndpointVolume,
                                     IAudioMeterInformation)
            from pycaw.constants import CLSID_MMDeviceEnumerator
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                enum = comtypes.CoCreateInstance(
                    CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
                raw = enum.GetDevice(device_id)
                vol = cast(raw.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None),
                           POINTER(IAudioEndpointVolume))
                meter = cast(raw.Activate(IAudioMeterInformation._iid_, CLSCTX_ALL, None),
                             POINTER(IAudioMeterInformation))
            return vol, meter, None
        except Exception as e:  # noqa: BLE001
            return None, None, repr(e)

    def sample(self, key, want_id, now):
        """Einen Target sampeln → {available, level, muted, peak, reason}. want_id = aufgelöste Geräte-ID."""
        st = self._ifaces.setdefault(key, {"vol": None, "meter": None, "resolved": None,
                                            "last_vol": 0.0, "err": None, "level": None, "muted": None})
        if not want_id:
            st["vol"] = st["meter"] = st["resolved"] = None
            return {"available": False, "level": None, "muted": None, "peak": 0.0,
                    "reason": "kein Standard-Ausgabegerät"}
        if st["vol"] is None or want_id != st["resolved"]:
            nvol, nmeter, err = self._open(want_id)
            if nvol is not None:
                st["vol"], st["meter"], st["resolved"], st["err"] = nvol, nmeter, want_id, None
            else:
                st["vol"] = st["meter"] = st["resolved"] = None
                st["err"] = err
        if st["vol"] is None or st["meter"] is None:
            return {"available": False, "level": None, "muted": None, "peak": 0.0, "reason": st["err"]}
        try:
            peak = float(st["meter"].GetPeakValue())
            # Level/Mute nur selten LESEN (billig halten), aber IMMER mitsenden (gecacht) — sonst „verliert"
            # der Client zwischen den 0.15-s-Reads den Wert und der Fader springt auf 0 (sichtbarer Flap).
            if (now - st["last_vol"]) > _VOL_EVERY:
                st["level"] = round(float(st["vol"].GetMasterVolumeLevelScalar()) * 100)
                st["muted"] = bool(st["vol"].GetMute())
                st["last_vol"] = now
            return {"available": True, "peak": 0.0 if peak < 0 else 1.0 if peak > 1 else peak,
                    "reason": None, "level": st["level"], "muted": st["muted"]}
        except Exception as e:  # noqa: BLE001
            st["vol"] = st["meter"] = st["resolved"] = None
            return {"available": False, "level": None, "muted": None, "peak": 0.0, "reason": repr(e)}

    def set_volume(self, key, level_0_100):
        st = self._ifaces.get(key)
        if not st or st["vol"] is None:
            return
        try:
            lvl = max(0.0, min(1.0, float(level_0_100) / 100.0))
            st["vol"].SetMasterVolumeLevelScalar(lvl, None)
        except Exception:  # noqa: BLE001
            st["vol"] = st["meter"] = st["resolved"] = None

    def set_mute(self, key, muted):
        st = self._ifaces.get(key)
        if not st or st["vol"] is None:
            return
        try:
            m = bool(muted) if muted is not None else (not bool(st["vol"].GetMute()))
            st["vol"].SetMute(m, None)
        except Exception:  # noqa: BLE001
            st["vol"] = st["meter"] = st["resolved"] = None

    def drop(self, key):
        self._ifaces.pop(key, None)


def main() -> int:
    # COM auf DIESEM (einzigen COM-)Thread initialisieren.
    try:
        import comtypes
        comtypes.CoInitialize()
    except Exception:  # noqa: BLE001
        pass

    cmds = []
    cmd_lock = threading.Lock()
    stop = threading.Event()

    def _reader():
        for line in sys.stdin:          # blockiert; EOF (Host weg) → Helfer beenden
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            with cmd_lock:
                cmds.append(obj)
        stop.set()                       # stdin geschlossen → raus

    threading.Thread(target=_reader, name="winaudio-helper-stdin", daemon=True).start()

    com = _Com()
    watched = {}        # key -> last_watch ts
    devices = []
    default_id = None
    last_dev = last_def = 0.0
    available = None    # None bis zum ersten Lib-Check

    def emit(snaps):
        msg = {"type": "state", "available": bool(available), "default_id": default_id,
               "devices": devices, "snaps": snaps}
        try:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            stop.set()

    # Lib-Check (einmal)
    try:
        import comtypes  # noqa: F401
        from pycaw.pycaw import IMMDeviceEnumerator, EDataFlow  # noqa: F401
        available = True
    except Exception:  # noqa: BLE001
        available = False

    while not stop.is_set():
        now = time.monotonic()
        # Befehle einsortieren: watch/set_default sofort, set_volume/set_mute ZURÜCKstellen (erst nach
        # dem Sampling anwenden — dann sind die Interfaces offen, auch beim allerersten Set).
        sets = []
        with cmd_lock:
            pending, cmds[:] = list(cmds), []
        for c in pending:
            k = str(c.get("target") or "")
            cmd = c.get("cmd")
            if cmd == "watch":
                watched[k] = now
            elif cmd in ("set_volume", "set_mute"):
                watched[k] = now
                sets.append((cmd, k, c))
            elif cmd == "set_default":
                com.set_default(str(c.get("device_id") or ""),
                                roles=tuple(c.get("roles") or ("console", "multimedia")))
                default_id = None  # sofort neu lesen
                last_def = 0.0

        if not available:
            emit({})
            stop.wait(0.5)
            continue

        # Geräte/Standard periodisch auffrischen
        if (now - last_dev) > _DEV_EVERY:
            devices = com.devices(); last_dev = now
        if (now - last_def) > _DEF_EVERY:
            default_id = com.default_id("multimedia"); last_def = now

        # idle-Targets vergessen
        for k in [k for k, ts in watched.items() if now - ts > _WATCH_IDLE]:
            watched.pop(k, None); com.drop(k)

        snaps = {}
        for k in list(watched.keys()):
            snaps[k] = com.sample(k, k or default_id, now)   # öffnet/hält die Interfaces
        for cmd, k, c in sets:                                # Interfaces sind jetzt offen
            if cmd == "set_volume":
                com.set_volume(k, c.get("level", 0))
            else:
                com.set_mute(k, c.get("muted"))
        emit(snaps)
        stop.wait(_TICK)
    return 0


if __name__ == "__main__":
    sys.exit(main())
