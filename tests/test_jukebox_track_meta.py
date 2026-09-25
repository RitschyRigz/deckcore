"""Track-Metadaten in library.json: atomar, unter Sperre, nie ueber einen unlesbaren Stand,
freie Host-Felder werden in library() als ``meta`` durchgereicht (Musikseite, 25.09.2026)."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402


def _lib(tmp_path: Path) -> jb.Jukebox:
    music = tmp_path / "music" / "metal"
    music.mkdir(parents=True)
    (music / "2026-09-22 - Wir schnetzeln.wav").write_bytes(b"RIFF")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(tmp_path / "music"))
    return lib


def _tid(lib: jb.Jukebox) -> str:
    return lib.library()[0]["id"]


def test_titel_und_hostfelder(tmp_path):
    lib = _lib(tmp_path)
    tid = _tid(lib)
    lib.update_track_meta(tid, {"title": "Wir schnetzeln durch den Dienstag", "game": "Wolverine"})
    t = lib.library()[0]
    assert t["title"] == "Wir schnetzeln durch den Dienstag"
    assert t["meta"] == {"game": "Wolverine"}, "Kernfelder nicht in meta, Hostfelder schon"
    assert t["style"] == "metal"


def test_leerer_wert_entfernt_feld_und_leeren_eintrag(tmp_path):
    lib = _lib(tmp_path)
    tid = _tid(lib)
    lib.update_track_meta(tid, {"title": "X", "game": "Y"})
    lib.update_track_meta(tid, {"game": None, "title": ""})
    data = json.loads((tmp_path / "rt" / "jukebox" / "library.json").read_text(encoding="utf-8"))
    assert tid not in data["tracks"]
    assert lib.library()[0]["title"] == "2026-09-22 - Wir schnetzeln"


def test_unlesbare_datei_wird_nicht_ueberschrieben(tmp_path):
    lib = _lib(tmp_path)
    p = tmp_path / "rt" / "jukebox" / "library.json"
    p.write_text("{kaputt", encoding="utf-8")
    with pytest.raises(RuntimeError):
        lib.update_track_meta(_tid(lib), {"title": "X"})
    assert p.read_text(encoding="utf-8") == "{kaputt"


def test_gleichzeitige_aenderungen_verlieren_nichts(tmp_path):
    lib = _lib(tmp_path)
    tid = _tid(lib)
    fields = [f"f{i}" for i in range(20)]
    threads = [threading.Thread(target=lib.update_track_meta, args=(tid, {f: i})) for i, f in enumerate(fields)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert set(lib.library()[0]["meta"]) == set(fields)


def test_set_track_style_bleibt_kompatibel(tmp_path):
    lib = _lib(tmp_path)
    tid = _tid(lib)
    entry = lib.set_track_style(tid, "dj", title="Neu", max_seconds=None)
    assert entry == {"title": "Neu", "style": "dj"}
    assert lib.library()[0]["style"] == "dj"


def test_herkunft_bleibt_nach_umbenennung(tmp_path):
    """Die Herkunft kommt aus dem Dateinamen, nicht aus dem Anzeigetitel — sonst verliert ein
    umbenannter Song seine Stream-Zeile und ``latest_origin`` waehlt falsch (25.09.2026)."""
    lib = _lib(tmp_path)
    tid = _tid(lib)
    lib.update_track_meta(tid, {"title": "Wir schnetzeln durch den Dienstag"})
    assert lib.library()[0]["source_date"] == "2026-09-22"
