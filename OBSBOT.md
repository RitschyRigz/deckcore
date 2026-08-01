# OBSBOT-Kamerasteuerung (Center-frei, rohes UVC)

deckcore steuert OBSBOT-Kameras (Tiny / Meet) **direkt über UVC** — ohne OBSBOT-Software.
Kein Center, kein Elgato-Plugin, kein SDK. Schwenken, Zoom, Zentrieren und Tracking laufen
über zwei Standard-Windows-Schnittstellen (`IAMCameraControl` für PTZ/Zoom, eine Vendor-USB-
Video-Extension-Unit für Tracking). Implementierung: [`obsbot_uvc.py`](obsbot_uvc.py).

## ⚠ Voraussetzungen (WICHTIG)

1. **OBSBOT Center darf NICHT laufen** — auch nicht im Tray, auch nicht im Autostart.
   Center greift dieselbe Kamera auf Steuer-Ebene; läuft es parallel, blockiert/verkantet sich
   die Steuerung, im schlimmsten Fall hängt der USB-/Kamera-Treiber. → Center komplett beenden,
   Autostart deaktivieren.
2. **Die Kamera muss aktiv sein** — von einem Video-Konsumenten (z. B. OBS als Quelle) geöffnet.
   UVC-Steuerung kann die Kamera **nicht selbst aufwecken**; eine schlafende Cam meldet `sleep`.
3. **Windows** + Python-Pakete **`comtypes`** und **`pygrabber`** (DirectShow-Geräte-Enumeration).
   Fehlen sie (Nicht-Windows / Minimal-Build), meldet die Integration sauber „nicht verfügbar".
4. **Kein Dauer-Polling der Kameras.** Mehrere Consumer, die gleichzeitig auf eine UVC-Kamera
   zugreifen (Hintergrund-Poll + startender OBS-Capture), können den Windows Camera Frame Server /
   USB-Stack überlasten → harte Treiber-Hänger. deckcore pollt daher **nicht** im Hintergrund
   (`_BACKGROUND_POLL = False`); Status/Readback kommen aus dem Cache, gefüllt durch die diskreten
   Tastendrücke. Steuerung wirkt **on-demand** und sofort.

## ⛔ Wenn ein Kamera-Zugriff sich verkeilt (Single-Flight & `wedged`)

**Punkt 4 allein reicht als Schutz nicht.** Live bewiesen (2026-08-01): Auch ein *einzelner*
Tastendruck kann sich im COM-Call verkeilen, solange ein Video-Konsument die Kamera hält — und
ein verkeilter Call kommt **nie** zurück (mit geschlossenem OBS 4,7 h später immer noch fest).
Ein Thread, der in COM steckt, ist aus Python nicht abbrechbar.

Ohne Gegenmaßnahme reihte sich danach jeder weitere Druck dahinter ein und blockierte je einen
Threadpool-Thread der Host-App — bis das ganze Deck stand und die Deck-Verbindung abriss. Der
Schaden war also nicht die eine tote Kamera, sondern die **Kaskade in die Host-App**.

Deshalb gilt jetzt:

- **Single-Flight** — maximal *ein* Kamera-Job gleichzeitig. Weitere Drücke werden **sofort**
  abgewiesen (`busy`), nicht eingereiht. Ungeduldiges Klicken kostet keinen Thread mehr.
- **Blockiert-Erkennung** — hängt ein Job länger als `_WEDGE_AFTER` (10 s), meldet `status()`
  ehrlich `state="wedged"` samt `wedged_for`/`job` und nimmt nichts mehr an.
- **Bewusst keine Selbstheilung** — automatisches Neustarten schickte nur einen zweiten Thread
  auf dieselbe klemmende Kamera. Der Nutzer löst es aus: `reconnect()` (Deck-Aktion
  `obsbot_action: "reconnect"`, Editor-Eintrag „🔄 Neu verbinden", `POST /api/obsbot/reconnect`).
  Der alte Worker wird nur **abgemeldet** (neue Generation + eigene Queue) und räumt sich selbst
  ab, falls sein Call je zurückkommt; der neue startet mit frischem COM-Apartment.
- **Kurze Wartezeit** — Aufrufer blockieren nur `_JOB_TIMEOUT` (2,5 s) und melden sonst
  „läuft noch"; das Ergebnis kommt über den Status-Cache.

Abgesichert in `tests/test_obsbot_singleflight.py` (Hauptrepo, call-frei — kein COM, keine Kamera).

## Was funktioniert (über rohes UVC)

| Funktion | Status |
|---|---|
| **Tracking an/aus** (AI-Follow) | ✅ inkl. **echtem Readback** (zeigt den realen Cam-Zustand) |
| **Schwenken** hoch / runter / links / rechts (PTZ) | ✅ |
| **Zoom** | ✅ |
| **Zentrieren** (Home) | ✅ |

## Was (noch) NICHT über UVC geht

Diese waren OBSBOT-Center-Funktionen und sind über rohes UVC noch nicht kartiert. Sie melden
ehrlich „nicht verfügbar" statt still zu verpuffen:

- Positions-**Presets** anfahren/speichern
- Framing-Modus, Tracking-Tempo, FOV/View
- Mirror, Aufnahme, Schnappschuss

## Buttons anlegen

Integration **📷 OBSBOT** im Editor → „📷 OBSBOT-Kamera-Buttons generieren" legt pro Kamera ein
Set in den Pool: **Tracking-Toggle · Zentrieren · Schwenken (hoch/runter/links/rechts)**.
Anzahl Kameras wählbar; idempotent (mehrfaches Anwenden erzeugt keine Duplikate).
