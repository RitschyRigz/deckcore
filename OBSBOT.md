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
