# RIGZDECK-KB — Hardware-Tastatur-Firmware

Firmware für einen **ATmega32U4-Chip** (Arduino Micro / Leonardo, SparkFun Pro Micro …), der sich
als **echtes USB-HID-Keyboard** anmeldet. Tastendrücke davon sind für die Ziel-App ununterscheidbar
von physischer Hardware — auch für Apps, die OS-injizierte Eingaben verwerfen (TikTok Live Studio),
und für Tasten, die eine Tastatur physisch braucht (echter Ziffernblock). Ist der host-seitige
Gegenpart zu [`../../arduino_kb.py`](../../arduino_kb.py) (`send_via="arduino"`).

> Nur ATmega32U4/RP2040 & Co. mit **nativem USB** können HID. Ein klassischer Arduino **Nano/Uno**
> (USB via FTDI/CH340) kann es NICHT — der ist nur ein serieller Port.

## Protokoll (seriell, 115200, zeilenbasiert)

| Befehl | Antwort | Zweck |
|---|---|---|
| `ID` | `RIGZDECK-KB v1` | Discovery-Signatur (der Host findet den Port darüber, keine feste COM-Nummer) |
| `K <tok> <tok> …` | `OK` / `ERR:<token>` | Chord: alle Token zusammen drücken, ~20 ms halten, loslassen |

Token = dasselbe Vokabular wie `_parse_hotkey` in `deckcore/service.py` (`num1`, `numadd`, `up`,
`f5`, `a`, `ctrl`, `shift` …). Ein Makro = mehrere `K`-Zeilen mit Host-seitigem Timing dazwischen.

## Flashen (arduino-cli)

```bash
arduino-cli core install arduino:avr
arduino-cli lib install "HID-Project"
arduino-cli compile --fqbn arduino:avr:micro rigzdeck_kb
arduino-cli upload -p <COMx> --fqbn arduino:avr:micro rigzdeck_kb
```

FQBN je Board anpassen (`arduino:avr:leonardo`, `SparkFun:avr:promicro` …). Nach dem Flash meldet
sich der Chip als Verbundgerät: ein CDC-Serial-Port **und** eine „HID-Tastatur".

## Layout-Hinweis

Ein HID-Keyboard sendet **physische Tasten-Positionen**; das OS wendet sein aktives Layout an. Der
Host (`arduino_kb.py`) schickt Token, die für Ziffernblock / Hotkeys / F-Tasten / Ziffern layout-
unabhängig sind. Nur **wörtliche Buchstaben/Sonderzeichen** unterliegen dem Host-Layout (z. B. y/z
auf QWERTZ) — genau wie eine physische US-Tastatur an deutschem Windows.
