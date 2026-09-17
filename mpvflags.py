"""Gemeinsame mpv-Startflags fuer gesteuerte Player (Jukebox/Bett-Audio, Media-Fenster).

Diese Player werden ausschliesslich ueber ihre IPC-Pipe bedient. Ohne Sperre registriert
mpv sich unter Windows bei der Mediensteuerung (SMTC) und hoert auf die globalen Medientasten
— Play/Pause am Kopfhoerer, Tastatur oder Bluetooth-Geraet pausiert dann die zuletzt aktive
Instanz, ohne dass der Besitzer davon erfaehrt (Stream 17.09.2026: Bett stumm, kein Log).

Die Optionen ``--input-media-keys`` und ``--media-controls`` gibt es nicht in jeder mpv-Version
(``media-controls`` erst seit 0.38). Ein unbekanntes Flag liesse mpv gar nicht starten — deshalb
wird die Optionsliste des konkreten Binaries einmal abgefragt und nur Vorhandenes gesetzt.
"""
from __future__ import annotations

import os
import subprocess
import threading
from typing import Iterable

# Option -> gewuenschter Wert. Reine Daten: eine weitere Sperre kommt hier dazu, nicht im Launcher.
MEDIA_CONTROL_OFF: dict[str, str] = {
    "input-media-keys": "no",
    "media-controls": "no",
}

_cache: dict[str, frozenset[str]] = {}
_cache_lock = threading.Lock()


def _list_options(mpv_path: str) -> frozenset[str]:
    """Namen aller Optionen des Binaries (ohne fuehrende ``--``); leer, wenn nicht abfragbar."""
    try:
        creation = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW
        out = subprocess.run([mpv_path, "--list-options"], capture_output=True, text=True,
                             timeout=8, creationflags=creation, stdin=subprocess.DEVNULL)
    except Exception:  # noqa: BLE001 — kein Abfrageergebnis = keine Zusatzflags
        return frozenset()
    names: set[str] = set()
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("--"):
            names.add(line[2:].split()[0].strip())
    return frozenset(names)


def supported_options(mpv_path: str) -> frozenset[str]:
    """Einmal je Binary-Pfad abfragen; das Ergebnis lebt fuer die Prozesslaufzeit."""
    key = str(mpv_path or "")
    with _cache_lock:
        cached = _cache.get(key)
    if cached is not None:
        return cached
    names = _list_options(key) if key else frozenset()
    with _cache_lock:
        _cache[key] = names
    return names


def media_control_flags(mpv_path: str, wanted: dict[str, str] | None = None) -> list[str]:
    """``--<option>=<wert>`` fuer jede gewuenschte Sperre, die dieses mpv kennt."""
    wanted = dict(MEDIA_CONTROL_OFF if wanted is None else wanted)
    known = supported_options(mpv_path)
    return [f"--{name}={value}" for name, value in wanted.items() if name in known]


def has_media_control_flags(args: Iterable[str]) -> bool:
    """Prueflesung fuer Tests/Diagnose: tragen diese Startargumente die Sperre?"""
    present = {a.split("=", 1)[0][2:] for a in args if isinstance(a, str) and a.startswith("--")}
    return all(name in present for name in MEDIA_CONTROL_OFF)


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()
