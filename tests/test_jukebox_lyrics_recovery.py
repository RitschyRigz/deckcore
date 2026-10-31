"""Ein kurzer Lesefehler darf den Mitsing-Text nicht fuer die Laufzeit loeschen.

Stream-Nacharbeit 30.10.2026 (B5): Bei einem Song fiel der Untertitel mitten im Stream aus,
obwohl die SRT vollstaendig daneben lag — die Ursache DIESES Ausfalls ist nicht belegt.
Belegt ist ein Defekt derselben Art: schlug ``read_text``/``parse_srt`` einmal fehl, legte
``lyrics()`` ``cues=[]`` unter (Pfad, mtime in SEKUNDEN, Offset) ab. Derselbe Schluessel traf
danach jedes Mal — der Text blieb fuer die ganze Laufzeit weg, obwohl die Datei lesbar war.
Ein halb geschriebener oder per ``os.replace`` ersetzter Stand (uebernimmt den Stempel der
Quelle) fiel aus demselben Grund in dieselbe Sekunde.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jukebox as jb  # noqa: E402

ENTE = "1\n00:00:01,000 --> 00:00:03,000\nDie Ente\n"
SCHWAN = "1\n00:00:01,000 --> 00:00:04,000\nDer Schwan\n"


def _lib(tmp_path: Path):
    """Bibliothek mit genau einem Song samt SRT daneben."""
    music = tmp_path / "music" / "lieder"
    music.mkdir(parents=True)
    wav = music / "2026-10-30 - Die Ente.wav"
    wav.write_bytes(b"RIFF")
    srt = wav.with_suffix(".srt")
    srt.write_text(ENTE, encoding="utf-8")
    lib = jb.Jukebox(tmp_path / "rt", mpv_resolver=lambda p: "", run_actions=lambda a, v: {}, publish=None)
    lib.set_config(library_dir=str(music.parent))
    return lib, lib.library()[0]["id"], srt


def _reads(monkeypatch, srt: Path, fehler: list, dauerhaft: BaseException | None = None) -> list:
    """``read_text`` NUR fuer diese SRT steuern: ``fehler`` gibt je Aufruf eine Ausnahme vor
    (leer = echt lesen), ``dauerhaft`` laesst jeden weiteren Versuch scheitern. Rueckgabe
    sammelt die Leseversuche."""
    real = Path.read_text
    versuche: list = []

    def fake(self, *a, **kw):
        if str(self) == str(srt):
            versuche.append(str(self))
            if fehler:
                raise fehler.pop(0)
            if dauerhaft is not None:
                raise dauerhaft
        return real(self, *a, **kw)

    monkeypatch.setattr(Path, "read_text", fake)
    return versuche


def _takt(lib, tid, monkeypatch, start: float = 10.0):
    """Auftrag ``r1`` spielt, Uhr steht. Rueckgabe: ``takt(zeit)`` schickt eine progress-Meldung
    zur gesetzten Zeit (der heavy-Takt von ``_on_player_event`` haengt an ``time.monotonic``)."""
    uhr = [start]
    monkeypatch.setattr(jb.time, "monotonic", lambda: uhr[0])
    with lib._lock:
        lib._state.update({"state": "playing", "request_id": "r1", "track": tid})

    def takt(zeit: float, position: float = 2.0):
        uhr[0] = zeit
        lib._on_player_event("r1", {"event": "progress", "position": position, "duration": 6.0})
    return takt


# -- Nachlese im laufenden Auftrag: _progress_cues haelt die Cues je request_id -------------

def test_laufender_auftrag_holt_den_text_im_naechsten_takt_nach(tmp_path, monkeypatch):
    """Ein Lesefehler beim Auftragsbeginn liess den Text bis zum Songende weg: ``_progress_cues``
    merkt sich ``(rid, [])`` und lud je Auftrag nur einmal."""
    lib, tid, srt = _lib(tmp_path)
    versuche = _reads(monkeypatch, srt, [PermissionError(13, "Datei in Benutzung")])
    takt = _takt(lib, tid, monkeypatch)
    takt(10.0)
    assert lib.status()["lyric"] == {} and len(versuche) == 1, "gescheitertes Lesen: kein Text"
    takt(10.5)
    assert len(versuche) == 1, "zwischen den Takten wird nicht nachgelesen"
    takt(11.0)
    assert lib.status()["lyric"]["text"] == "Die Ente", "naechster Takt liest nach"
    assert len(versuche) == 2 and lib._lyrics_failed == set()


def test_song_ohne_text_loest_keine_nachlese_aus(tmp_path, monkeypatch):
    """Legitim leer (und ebenso: keine Datei) ist ein Erfolg — kein Merker, keine Wiederholung."""
    lib, tid, srt = _lib(tmp_path)
    srt.write_text("\n", encoding="utf-8")
    versuche = _reads(monkeypatch, srt, [])
    takt = _takt(lib, tid, monkeypatch)
    for t in (10.0, 11.0, 12.0, 13.0):
        takt(t)
    assert lib.status()["lyric"] == {} and len(versuche) == 1
    assert lib._lyrics_failed == set()


def test_nachlese_bleibt_beim_takt_und_endet_mit_der_datei(tmp_path, monkeypatch):
    """Dauerhafter Lesefehler: ein Versuch je Sekunde, nicht je Meldung. Verschwindet die Datei,
    ist nach einem Takt Ruhe (kein Versuch bei fehlender Datei)."""
    lib, tid, srt = _lib(tmp_path)
    versuche = _reads(monkeypatch, srt, [], dauerhaft=OSError(5, "Zugriff verweigert"))
    takt = _takt(lib, tid, monkeypatch)
    for zehntel in range(0, 21):
        takt(10.0 + zehntel / 10)            # 21 Meldungen ueber 2 s
    assert len(versuche) == 3, "ein Versuch beim Beginn, dann je 1-s-Takt genau einer"
    assert lib.status()["lyric"] == {} and tid in lib._lyrics_failed
    srt.unlink()
    takt(13.0)
    assert len(versuche) == 3 and lib._lyrics_failed == set(), "fehlende Datei: kein Leseversuch"
    takt(14.0)
    assert len(versuche) == 3, "ohne Merker keine Nachlese mehr"


def test_lesefehler_setzt_keinen_leeren_erfolgscache(tmp_path, monkeypatch):
    lib, tid, srt = _lib(tmp_path)
    versuche = _reads(monkeypatch, srt, [PermissionError(13, "Datei in Benutzung")])
    assert lib.lyrics(tid) == [], "gescheitertes Lesen liefert keinen Text"
    assert [c["text"] for c in lib.lyrics(tid)] == ["Die Ente"], "gleiche mtime, trotzdem neu lesen"
    assert len(versuche) == 2


def test_warmer_cache_liest_bei_unveraendertem_stand_nicht_erneut(tmp_path, monkeypatch):
    lib, tid, srt = _lib(tmp_path)
    versuche = _reads(monkeypatch, srt, [])
    erste = lib.lyrics(tid)
    assert [c["text"] for c in erste] == ["Die Ente"]
    assert lib.lyrics(tid) == erste and len(versuche) == 1


def test_geaenderte_quelle_mit_lesefehler_liefert_nie_den_alten_text(tmp_path, monkeypatch):
    lib, tid, srt = _lib(tmp_path)
    assert [c["text"] for c in lib.lyrics(tid)] == ["Die Ente"]
    srt.write_text(SCHWAN, encoding="utf-8")                  # andere Groesse -> anderer Stand
    versuche = _reads(monkeypatch, srt, [OSError(5, "Zugriff verweigert")])
    assert lib.lyrics(tid) == [], "zur geaenderten Quelle nie den alten Text"
    assert [c["text"] for c in lib.lyrics(tid)] == ["Der Schwan"]
    assert len(versuche) == 2


def test_ersetzter_stand_mit_gleichem_zeitstempel_wird_erkannt(tmp_path):
    """``os.replace`` traegt den Stempel der Quelle: der Sekundenstempel allein erkannte einen
    getauschten Textstand nicht. Gleicher Stempel UND gleiche Groesse bleiben ununterscheidbar."""
    lib, tid, srt = _lib(tmp_path)
    assert [c["text"] for c in lib.lyrics(tid)] == ["Die Ente"]
    stempel = srt.stat().st_mtime_ns
    neu = srt.with_name("neu.srt")
    neu.write_text(SCHWAN, encoding="utf-8")
    os.replace(neu, srt)
    os.utime(srt, ns=(stempel, stempel))                      # exakt derselbe Stempel wie vorher
    assert [c["text"] for c in lib.lyrics(tid)] == ["Der Schwan"]
