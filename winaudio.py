"""
WinAudio — das Windows-Standard-Ausgabegerät LESEN und SETZEN (Windows Core Audio + IPolicyConfig).

Generisch und host-agnostisch. Dient zwei Zwecken:
  • die Kopplung „Wave Link folgt Windows-Standardgerät" (lesen, was Windows als Standard hat),
  • Deck-Knöpfe „Windows-Standard setzen" (auf ein bestimmtes Gerät schalten) + Aktiv-Statuslicht.

Eigenschaften:
  • LAZY: ``comtypes``/``pycaw`` werden erst beim ersten echten Zugriff importiert — ``import
    deckcore.winaudio`` zieht nichts (Kern bleibt schlank, überall importierbar; nur Windows).
  • Setzen über das (undokumentierte, aber seit Windows 7 stabile) ``IPolicyConfig``-COM-Interface —
    dasselbe, das SoundVolumeView / AudioDeviceCmdlets / NirCmd nutzen.
  • COM wird pro aufrufendem Thread initialisiert (die Deck-Handler/der Watcher laufen in Worker-
    Threads) — sonst „CoInitialize has not been called".
  • Graceful: jede Methode fängt Fehler ab und liefert ein klares Ergebnis statt zu werfen.

Geräte-IDs sind das Windows-Endpoint-Format ``{0.0.0.00000000}.{GUID}`` — IDENTISCH mit Wave Links
``outputDeviceId``. Darum ist die Kopplung ein direkter ID-Abgleich (kein Namens-Matching).
"""
from __future__ import annotations

import logging
import threading
import warnings
from typing import Optional

log = logging.getLogger("deckcore.winaudio")

# eConsole / eMultimedia / eCommunications — das „Standardgerät" (Media) = console+multimedia,
# Kommunikation (eComm) ist getrennt (z.B. ein anderes Headset für Calls) und bleibt unangetastet.
_ROLE = {"console": 0, "multimedia": 1, "communications": 2}

_IPolicyConfig = None   # comtypes-Interface, einmal gebaut (lazy)


def _build_policy_iface():
    """IPolicyConfig-Interface einmalig definieren (Vtable-Reihenfolge zählt; nur SetDefaultEndpoint
    wird aufgerufen, die übrigen Slots sind Platzhalter für die korrekte Slot-Position)."""
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


# CLSID_CPolicyConfigClient
_CLSID_POLICY = "{870af99c-171d-4f9e-af0d-e63df40c2bc9}"


class WinAudio:
    """Windows-Standard-Ausgabegerät lesen/setzen. Thread-safe, lazy, graceful."""

    def __init__(self):
        self._lock = threading.RLock()
        self._lib_ok: Optional[bool] = None

    # ── Lib / COM ────────────────────────────────────────────────────────
    def _ensure_lib(self) -> bool:
        if self._lib_ok is None:
            try:
                import comtypes  # noqa: F401
                from pycaw.pycaw import IMMDeviceEnumerator, EDataFlow  # noqa: F401
                self._lib_ok = True
            except Exception:  # noqa: BLE001
                self._lib_ok = False
        return self._lib_ok

    @staticmethod
    def _co_init() -> None:
        """COM auf dem AKTUELLEN Thread initialisieren (Deck-Handler/Watcher laufen in Worker-
        Threads). Idempotent — mehrfaches CoInitialize ist ungefährlich."""
        try:
            import comtypes
            comtypes.CoInitialize()
        except Exception:  # noqa: BLE001
            pass

    def available(self) -> bool:
        return self._ensure_lib()

    # ── Lesen ────────────────────────────────────────────────────────────
    def default_render_id(self, role: str = "multimedia") -> Optional[str]:
        """ID des aktuellen Windows-Standard-AUSGABEgeräts (Default Render Endpoint). None bei Fehler."""
        if not self._ensure_lib():
            return None
        with self._lock:
            return self._read_default_id(role)

    def _read_default_id(self, role: str = "multimedia") -> Optional[str]:
        """Standard-Render-ID lesen — OHNE Lock (der Aufrufer hält ihn bereits)."""
        try:
            import comtypes
            from pycaw.pycaw import IMMDeviceEnumerator, EDataFlow
            from pycaw.constants import CLSID_MMDeviceEnumerator
            self._co_init()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                enum = comtypes.CoCreateInstance(
                    CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
                dev = enum.GetDefaultAudioEndpoint(EDataFlow.eRender.value, _ROLE.get(role, 1))
                return dev.GetId()
        except Exception as e:  # noqa: BLE001
            log.debug("default_render_id fehlgeschlagen: %s", e)
            return None

    # ── Setzen ───────────────────────────────────────────────────────────
    def set_default(self, device_id: str, roles=("console", "multimedia")) -> dict:
        """Windows-Standard-Ausgabegerät auf ``device_id`` setzen (für die gegebenen Rollen;
        Default = Media-Standard = console+multimedia, Kommunikation bleibt unangetastet)."""
        if not self._ensure_lib():
            return {"success": False, "message": "Windows-Audio (comtypes/pycaw) nicht verfügbar"}
        device_id = str(device_id or "")
        if not device_id:
            return {"success": False, "message": "Kein Gerät gewählt"}
        with self._lock:
            try:
                from comtypes import GUID, CLSCTX_ALL, CoCreateInstance
                self._co_init()
                iface = _build_policy_iface()
                pc = CoCreateInstance(GUID(_CLSID_POLICY), interface=iface, clsctx=CLSCTX_ALL)
                for role in roles:
                    pc.SetDefaultEndpoint(device_id, _ROLE.get(role, 1))
                # Verifizieren: ein NICHT vorhandenes Gerät (z.B. ausgestöpselte Kopfhörer) meldet zwar
                # S_OK, wechselt den Standard aber NICHT → ehrlich als Fehler zurückmelden statt Schein-OK.
                cur = self._read_default_id("multimedia")
                if cur and cur != device_id:
                    return {"success": False, "message": "Gerät nicht verfügbar (Standard unverändert)"}
                return {"success": True, "message": "Windows-Standard gesetzt"}
            except Exception as e:  # noqa: BLE001
                return {"success": False, "message": f"Setzen fehlgeschlagen: {e}"}

    def is_default_render(self, device_id: str, role: str = "multimedia") -> Optional[bool]:
        """True, wenn ``device_id`` das aktuelle Standard-Ausgabegerät ist (für das Statuslicht)."""
        device_id = str(device_id or "")
        if not device_id:
            return None
        cur = self.default_render_id(role)
        if cur is None:
            return None
        return cur == device_id

    # ── Geräte per Name auflösen (robust gegen wechselnde IDs beim Neu-Einstecken) ──
    def render_devices(self) -> list:
        """Aktive Ausgabegeräte ``[{id, name}]`` — für Namens-Auflösung + Editor-Picker. Nur Render
        (Ausgänge, ID-Präfix ``{0.0.0.``), nur Status Active."""
        if not self._ensure_lib():
            return []
        from pycaw.pycaw import AudioUtilities
        out = []
        with self._lock:
            try:
                self._co_init()
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    for d in AudioUtilities.GetAllDevices():
                        did = d.id or ""
                        if not did.startswith("{0.0.0."):                 # nur Render-Endpoints
                            continue
                        if str(getattr(d, "state", "")).split(".")[-1] != "Active":
                            continue
                        name = d.FriendlyName or ""
                        if name:
                            out.append({"id": did, "name": name})
            except Exception as e:  # noqa: BLE001
                log.debug("render_devices fehlgeschlagen: %s", e)
        return out

    def resolve_render_id(self, name_substring: str) -> Optional[str]:
        """ID des AKTIVEN Ausgabegeräts, dessen Name ``name_substring`` enthält (case-insensitive).
        Robust gegen wechselnde Endpoint-IDs / „-2"-Namenssuffixe (Bluetooth/Wireless beim Neu-
        Einstecken). None, wenn gerade kein passendes aktives Gerät da ist."""
        sub = (name_substring or "").lower()
        if not sub:
            return None
        for d in self.render_devices():
            if sub in (d.get("name") or "").lower():
                return d.get("id")
        return None
