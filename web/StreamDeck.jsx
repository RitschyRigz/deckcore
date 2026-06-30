import { useState, useEffect, useRef } from 'preact/hooks'
import { getJSON, postJSON, delJSON } from './api.js'
import { resolveStyle, keyClass, groupDeckItems, UNCAT, DECK_LAYOUT_DEF, resolveColor, accentVar, isThemeColor, THEME_COLORS, TILE_SKINS, PRESS_MODES, applyDeckLook, applyPalette, LOOK_DEFAULT, FAM_KEYS, FAM_PALETTE, FAM_LABELS, GRAPH_VARIANTS, GAUGE_VARIANTS, BAR_VARIANTS, FADER_VARIANTS, VU_VARIANTS } from './deckstyle.js'
import { Clock, Gauge, Bar, Readout, FaderView, FONT_LABELS, SIZE_LABELS, fontStack, widgetFontSize } from './widgets.jsx'
import { Sparkline, statStyle } from './TouchDeck.jsx'   // Verlaufskurve + Stat-Farbe fürs WYSIWYG (Panel unberührt)
import { Glyph, IconView, isGlyph, glyphName, glyphValue, hasGlyph, GLYPH_CATS, GLYPH_KW, suggestGlyph } from './icons.jsx'
import { THEME_PRESETS, THEME_VARS } from './themes.js'

// Per-Taste-Stil-Auswahl: die geteilten Stile + vorangestellt „(Standard / global)" (= erbt den globalen
// Default aus den Theme-Einstellungen). '' = erben.
const TILE_SKIN_OPTS = [['', '(Standard / global)'], ...TILE_SKINS]
import { GridStack } from 'gridstack'
import 'gridstack/dist/gridstack.min.css'
import './deck.css'   // geteilte Deck-CSS (Editor .sd-* + Touch .t-*) — alle Hüllen

// 🎛 Stream Deck — config-getriebene Button-Registry. Datenmodell v2 (Shared-Pool):
//
//   (1) BUTTON-POOL (global) — „was tut der Button" (Aktion/Überwachung/Zustände). Jeder
//       Button hat eine ID und ist EINMAL definiert; er kann aufs echte Elgato-Deck (Plugin)
//       UND/ODER auf beliebig viele Tablet-Decks gelegt werden.
//   (2) DECKS (Tablet-Ansichten) — eigenständige Templates mit EIGENEM Layout (Raster/Größe/
//       Gap/Schrift), eigenen Kategorien und einer geordneten Item-Liste. Ein Item platziert
//       einen Pool-Button auf DIESEM Deck (eigene Kategorie/Stil/Sichtbarkeit/Reihenfolge).
//
// Der Deck-Editor ist WYSIWYG: man zieht die Buttons DIREKT im Live-Raster (kein separater
// Anordnen-Block mehr). Backend: /api/streamdeck/registry · /resolved · /buttons (Pool-Upsert)
// · /buttons/{id} (DELETE) · /press/{id} · /deck/* (Decks) · /deck/{id}/{layout,categories,
// category/*,reorder,item,item/{bid}} (per-Deck). Live-Vorschau via SSE streamdeck:buttons.

const ACTION_LABELS = {
  multi: '🔀 Multi-Action (mehrere Aktionen auf einem Button)',
  events_action: '⭐ Action auslösen (aus Events & Actions)',
  process_action: '🟢 Prozess-Aktion (start/stop/toggle/mute)',
  launch: '🚀 Programm/Script starten (beliebige .exe/.py/.lnk …)',
  open_folder: '📂 Ordner im Explorer öffnen (beliebiger Pfad)',
  open_deck: '📁 Ordner öffnen (Sub-Deck / Radial-Menü)',
  displayfusion: '🖥 DisplayFusion — Monitor-Profil laden',
  media: '⏯ Media-Taste (Play/Pause · ⏭⏮ · Lauter/Leiser · Mute)',
  hotkey: '⌨ Makro / Tastenkürzel senden (Stream-Deck-Stil, system-weit)',
  manual_event: '🎯 Manual-Event (Tod/Boss/Win …)',
  alert: '🔔 Test-Alert abspielen (follow/sub/raid …)',
  obs: '🎬 OBS (Szene wechseln / Quelle ein-aus / Stream / Aufnahme)',
  obsbot: '📷 OBSBOT-Kamera (Tiny/Meet — Schwenken/Zoom/Tracking, Center-frei via UVC)',
  wavelink: '🎚 Wave Link (Mix/Channel: Mute / Level / Main-Output)',
  winaudio: '🔊 Windows-Standardgerät setzen (Ausgabe umschalten)',
  app_audio: '🎵 App-Lautstärke (pro Programm: Spotify · Spiel · Discord …)',
  flag_toggle: '🚩 Flag umschalten (Fortgeschritten)',
  flag_set: '📌 Flag setzen (Fortgeschritten)',
  http: '🌐 HTTP-Aufruf (Fortgeschritten)',
  none: '— Keine (reiner Anzeige-Button)',
}
const MONITOR_LABELS = {
  aggregate: '🔀 Mehrere kombinieren (alle/eine/Anzahl) — z. B. „nur wenn ALLE …"',
  none: 'Keine — Button sieht immer gleich aus (einfach)',
  process_alive: 'Läuft ein Prozess? (an/aus)',
  flag: 'Ist ein Schalter gesetzt? (an/aus)',
  manual_count: 'Manual-Event-Zähler (Zahl, z.B. {value})',
  bot_mode: 'Bot-Modus (aus / läuft / stumm) — Bot wählbar',
  bot_state: 'Bot-Zustand (aus / bereit / im Gespräch / AFK) — Bot wählbar',
  file_field: 'Wert aus einer Datei (Fortgeschritten)',
  sse_field: 'Wert aus Live-Event (Fortgeschritten)',
  poll: 'Wert von einer URL (Fortgeschritten)',
  hwinfo: 'HWiNFO-Sensor (Temperatur / Last / Takt / Lüfter … als Zahl)',
  fps: 'FPS — Spiel im Vordergrund (PresentMon)',
  frametime: 'Frametime in ms — fängt Spikes (PresentMon)',
  obs_source_visible: 'Ist eine OBS-Quelle sichtbar? (an/aus)',
  obs_scene: 'Welche OBS-Szene ist aktiv? (Szenenname)',
  scene_suggest: 'Logischer Szenen-Hinweis (aktiv / wahrscheinlich-nächste / inaktiv)',
  displayfusion_profile: 'Welches DisplayFusion-Profil ist aktiv? (Profilname)',
  winaudio_default: 'Ist dieses Gerät das Windows-Standard-Ausgabegerät? (an/aus)',
  winaudio_volume: 'Windows-Lautstärke (0..100) — Master-Regler + VU',
  app_volume: 'App-Lautstärke (0..100) — pro Programm, Fader + VU',
  wavelink_meter: 'Wave-Link-Pegel (VU) eines Mix/Channels — Live-Ausschlag',
  wavelink_level: 'Wave-Link-Lautstärke (0..100) eines Mix/Channels — Fader + VU',
  wavelink_mute: 'Wave-Link: ist ein Mix/Channel stumm? (an/aus)',
  wavelink_main_output: 'Wave-Link Monitor-Hauptausgang (Gerätename)',
  obsbot_cam: 'OBSBOT-Kamera-Status (bereit / schläft / aus) — Kamera wählbar',
  obsbot_track: 'OBSBOT-Tracking (an / aus / schläft) — Kamera wählbar',
  weather: 'Wetter am Standort (Open-Meteo) — als „🪪 Status-Karte"',
  interception_status: '🛡 Hardware-Treiber-Status (bereit / Fallback / aus) — für Treiber-Makros',
}
const MONITOR_INFO = {
  aggregate: { text: 'Kombiniert mehrere Überwachungen zu EINEM Status. „Bedingung je Monitor" (z. B. „= trackon") wird auf JEDEN Sub-Monitor angewandt; „Verknüpfung" reduziert: ALLE (UND) → an/aus (truthy/falsy) · EINE (ODER) → an/aus · Anzahl → Zahl (gt/lt/eq) · Stufen → all/some/none (eq). Beispiel: „nur wenn BEIDE Kameras tracken" = ALLE + Bedingung „= trackon".', values: null, bool: true },
  none: { text: 'Kein Status — der Button nutzt immer das „Standard"-Aussehen unten. Für reine Tasten genau richtig.', values: null, bool: false },
  process_alive: { text: 'Liefert AN oder AUS. Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  flag: { text: 'Liefert AN oder AUS. Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  bot_mode: { text: 'Liefert: off · running · muted (für den gewählten Bot). Nutze „= gleich" + Wert.', values: ['off', 'running', 'muted'], bool: false },
  bot_state: { text: 'Liefert: off · ready · followup · afk (für den gewählten Bot). Nutze „= gleich" + Wert.', values: ['off', 'ready', 'followup', 'afk'], bool: false },
  poll: { text: 'Wert kommt von der URL (z. B. Health: ok · warning · error · off).', values: ['ok', 'warning', 'error', 'off'], bool: false },
  hwinfo: { text: 'Liefert den HWiNFO-Sensorwert als Zahl. Setze ihn mit {value} in den Titel (z. B. „CPU {value}°"). Für Farbe nach Schwellwert: Status „> größer als" + Wert (z. B. ab 80 rot).', values: null, bool: false },
  fps: { text: 'FPS des Vordergrund-Spiels via PresentMon (herstellerneutral, keine Injection). Am schönsten als Live-Kurve: oben „Darstellung → 📈 Graph". {value} im Titel = aktuelle Zahl.', values: null, bool: false },
  frametime: { text: 'Frametime in ms via PresentMon — fängt Spikes (Maximum je Zeitfenster). Als „Darstellung → 📈 Graph" wird das ein Frametime-Verlauf wie in RivaTuner. Braucht ein laufendes Spiel im Vordergrund.', values: null, bool: false },
  file_field: { text: 'Wert aus dem JSON-Feld. Bei true/false „ist wahr/an", sonst „= gleich" + Wert.', values: null, bool: false },
  sse_field: { text: 'Wert aus dem Live-Event-Feld. Bei true/false „ist wahr/an", sonst „= gleich" + Wert.', values: null, bool: false },
  obs_source_visible: { text: 'Liefert AN (sichtbar) oder AUS (ausgeblendet). Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  obs_scene: { text: 'Liefert den Namen der aktiven OBS-Szene. Nutze „= gleich" + Szenenname → der Button hebt sich hervor, wenn SEINE Szene gerade aktiv ist.', values: null, bool: false },
  scene_suggest: { text: 'Hebt diese Szene je nach Ablauf hervor: „current" (gerade aktiv → grün), „suggested" (laut Szenen-Ablauf wahrscheinlich als Nächstes → blau, blinkt), „return" (Rücksprung-Szene aus einer Pause → rot, blinkt) oder „idle" (unpassend → ausgegraut, bleibt klickbar). Den Ablauf bearbeitest du in der OBS-Integration → „🎬 Logisches Szenen-Deck".', values: ['current', 'suggested', 'return', 'idle'], bool: false },
  displayfusion_profile: { text: 'Liefert den Namen des zuletzt geladenen DisplayFusion-Profils. Nutze „= gleich" + Profilname → der Button leuchtet, wenn SEIN Profil aktiv ist.', values: null, bool: false },
  winaudio_default: { text: 'Liefert AN, wenn das gewählte Gerät gerade das Windows-Standard-Ausgabegerät ist. Nutze „ist wahr/an" (z. B. grün, wenn aktiv) und „ist falsch/aus".', values: null, bool: true },
  winaudio_volume: { text: 'Liefert die Windows-Master-Lautstärke (0..100) des Standard-Ausgabegeräts. Am schönsten als „Darstellung → 🎚 Fader" (Schieber + Live-VU). {value} im Titel = aktuelle Lautstärke.', values: null, bool: false },
  app_volume: { text: 'Liefert die Lautstärke (0..100) EINES Programms (App-Mixer, wie der Windows-Lautstärkemixer). Das Programm wählst du an der Aktion „🎵 App-Lautstärke". Am schönsten als „Darstellung → 🎚 Fader" (Schieber + Live-VU). {value} im Titel = aktuelle Lautstärke.', values: null, bool: false },
  wavelink_main_output: { text: 'Zeigt den aktiven Wave-Link-Monitor-Hauptausgang. Einfach „{value}" in den Titel setzen → der Button zeigt live den GERÄTE-NAMEN (keine Status-Regel, kein Gerät-Wählen nötig). Tipp: Darstellung „🪪 Status-Karte" → Rahmen + Glow + automatisch passendes Emoji je Quelle (🎧 Kopfhörer · 🔊 Boxen · 📺 HDMI/TV).', values: null, bool: false },
  wavelink_meter: { text: 'Live-Pegel (VU) eines Wave-Link-Mix/Channels. Wird beim „🎚 Wave-Link-Fader generieren" automatisch gesetzt; am schönsten als „Darstellung → 🎚 Fader" (Schieber + Live-VU).', values: null, bool: false },
  wavelink_level: { text: 'Lautstärke (0..100) eines Wave-Link-Mix/Channels. Quelle setzt/umhängst du am bequemsten über den 🎚-Quellen-Picker an der Fader-Kachel oder den „🎚 Wave-Link-Fader"-Generator. {value} im Titel = aktuelle Lautstärke.', values: null, bool: false },
  wavelink_mute: { text: 'Liefert AN, wenn der Wave-Link-Mix/Channel stumm ist. Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  obsbot_cam: { text: 'OBSBOT-Kamera-Status: on (bereit) · sleep (Linse geparkt) · off (Cam nicht gefunden / UVC nicht verfügbar). Nutze „= gleich" + Wert für die Farbe. Kamera unten wählen.', values: ['on', 'sleep', 'off'], bool: false },
  obsbot_track: { text: 'OBSBOT-Tracking: trackon · trackoff · sleep · off. Nutze „= gleich" + Wert. Kamera unten wählen. Über UVC mit echtem Readback (byte24) — zeigt den realen Tracking-Zustand der Kamera.', values: ['trackon', 'trackoff', 'sleep', 'off'], bool: false },
  manual_count: { text: 'Zählt, wie oft das Manual-Event ausgelöst wurde. Setze {value} in den Titel (z. B. „Tode: {value}").', values: null, bool: false },
  weather: { text: 'Aktuelles Wetter „⛅ 18° Zürich" (Open-Meteo, gratis/ohne Key). Standort automatisch per IP oder manuell in der „🌤 Wetter"-Kategorie. Am schönsten als „Darstellung → 🪪 Status-Karte"; {value} = der Wetter-Text.', values: null, bool: false },
  interception_status: { text: 'Status des Interception-Hardware-Treibers (für Treiber-Makros): ready (Treiber da + kalibrierte Tastatur erkannt) · fallback (Treiber da, aber kalibrierte Tastatur fehlt → erstes Gerät) · unavailable (Treiber nicht bereit). Nutze „= gleich" + Wert für die Farbe. Kalibrieren in der Kategorie „⌨ Makro / Hotkey".', values: ['ready', 'fallback', 'unavailable'], bool: false },
}
const OP_LABELS = {
  any: 'immer (egal welcher Wert)', truthy: 'ist wahr/an', falsy: 'ist falsch/aus',
  eq: '= ist gleich', ne: '≠ ist ungleich', gt: '> größer als', lt: '< kleiner als',
  gte: '≥ größer/gleich', lte: '≤ kleiner/gleich', contains: 'enthält Text',
}
const L_DEF = DECK_LAYOUT_DEF

// ── Einheitliche Emote-Anzeige für Kategorien + Ordner ──────────────────────────────────────────
// Beginnt der Text schon mit einem Emoji/Piktogramm? (kein Doppel-Emote, kein fehlendes).
const startsWithEmoji = (s) => /^\s*\p{Extended_Pictographic}/u.test(String(s || ''))
// Passendes Emote je bekannter Kategorie (sonst generisch) — NUR Anzeige, ändert die Kategorie-Daten nicht.
const CAT_EMOJI = { 'HWiNFO': '📊', 'Wave Link': '🎚', 'App-Lautstärke': '🔊', 'Audio': '🎧', 'Custom Buttons': '✏️', 'Mixer': '🎵' }
const catLabel = (cat) => (!cat || startsWithEmoji(cat)) ? cat : ((CAT_EMOJI[cat] || '📦') + ' ' + cat)
// Ordner-Anzeige (Icon + Label) OHNE Doppel-Emote: trägt das Label schon ein Emoji → so lassen, sonst Icon davor.
const folderText = (f) => { const lbl = (f && (f.label || f.id)) || ''; return startsWithEmoji(lbl) ? lbl : (((f && f.icon) || '📁') + ' ' + lbl) }

// Registry-Options robust machen: in schlanken Hüllen (z. B. RigzDeck standalone) fehlen Felder
// wie `processes`/`manual_event_types` komplett. Ohne Defaults wirft der Funktions-Editor schon
// beim Aufklappen (options.processes.find(...)) → die Karte öffnet nicht + ein Geister-Duplikat
// bleibt (weg nach Reload). Darum EINMAL zentral säubern, bevor options nach unten gereicht wird.
function normOptions(o) {
  o = o || {}
  const arr = (x) => (Array.isArray(x) ? x : [])
  return {
    ...o,
    processes: arr(o.processes),
    action_types: arr(o.action_types).length ? o.action_types : ['none'],
    monitor_types: arr(o.monitor_types).length ? o.monitor_types : ['none'],
    manual_event_types: arr(o.manual_event_types),
    alert_types: arr(o.alert_types),
    known_flags: arr(o.known_flags),
    match_ops: arr(o.match_ops),
    sse_topics: arr(o.sse_topics),
    decks: arr(o.decks),
  }
}

function blankButton() {
  return {
    id: '', label: '',
    action: { type: 'none' },
    monitor: { type: 'none' },
    states: [],
    default: { title: '', icon: '', color: '#2a2a2a' },
  }
}

// ── Mini-Inline-Helfer (ersetzen prompt()/confirm()) ─────────────────────────
function InlineAdd({ label, placeholder, onAdd }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState('')
  if (!open) return <button class="btn ghost small" onClick={() => setOpen(true)}>{label}</button>
  const go = () => { const t = v.trim(); if (t) onAdd(t); setV(''); setOpen(false) }
  return (
    <span class="sd-inline">
      <input class="reward-input" autofocus placeholder={placeholder} value={v}
             onInput={(e) => setV(e.currentTarget.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') setOpen(false) }} />
      <button class="btn small" onClick={go}>✓</button>
      <button class="btn ghost small" onClick={() => setOpen(false)}>✕</button>
    </span>
  )
}
function InlineEdit({ value, onSave, title, trigger }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  if (!edit) return <button class="sd-order-eye" title={title || 'bearbeiten'} onClick={() => { setV(value); setEdit(true) }}>{trigger || '✎'}</button>
  const go = () => { const t = (v || '').trim(); if (t && t !== value) onSave(t); setEdit(false) }
  return (
    <span class="sd-inline">
      <input class="reward-input" style="width:140px" autofocus value={v}
             onInput={(e) => setV(e.currentTarget.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') setEdit(false) }} />
      <button class="btn small" onClick={go}>✓</button>
      <button class="btn ghost small" onClick={() => setEdit(false)}>✕</button>
    </span>
  )
}
function ConfirmX({ onConfirm, title, label, cls }) {
  const [armed, setArmed] = useState(false)
  if (!armed) return <button class={cls || 'sd-order-eye'} title={title || 'löschen'} onClick={() => setArmed(true)}>{label || '✕'}</button>
  return (
    <span class="sd-inline">
      <button class="btn ghost small danger" onClick={() => { onConfirm(); setArmed(false) }}>löschen?</button>
      <button class="btn ghost small" onClick={() => setArmed(false)}>✕</button>
    </span>
  )
}

// ── Bild-Picker: klick → OS-Datei-Explorer → PNG/JPG hochladen → URL setzen ──
function IconPicker({ value, onChange }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const onFile = async (e) => {
    const f = e.currentTarget.files && e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!f) return
    setBusy(true); setErr('')
    try {
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/streamdeck/upload_icon', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'Upload fehlgeschlagen')
      onChange(d.url)
    } catch (ex) { setErr(String(ex.message || ex)) }
    setBusy(false)
  }
  return (
    <span class="sd-iconpick">
      <button class="btn ghost small" disabled={busy} title="Bild vom PC wählen (PNG/JPG)"
              onClick={() => inputRef.current && inputRef.current.click()}>
        {busy ? '… lädt' : (value ? '🖼 Bild ändern' : '🖼 Bild wählen')}
      </button>
      {value && <button class="btn ghost small danger" title="Bild entfernen" onClick={() => onChange('')}>✕</button>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
             style="display:none" onChange={onFile} />
      {err && <span class="msg err">{err}</span>}
    </span>
  )
}

// ── 🎨 Symbol-Bibliothek (Glyph-Picker) ──────────────────────────────────────
// Durchsuchbares Modal mit kuratierten SVG-Symbolen (Kategorien). Klick = setzt `g:<name>` ins
// Symbol-Feld. Die Symbole zeichnen mit currentColor → sie folgen der Akzent-/Theme-Farbe der Taste.
function GlyphPicker({ value, onPick, onClose }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const match = (name) => !ql || name.toLowerCase().includes(ql) || (GLYPH_KW[name] || '').indexOf(ql) >= 0
  const cur = isGlyph(value) ? glyphName(value) : ''
  const any = GLYPH_CATS.some((c) => c.names.some(match))
  return (
    <div class="sd-glyph-backdrop" onClick={onClose}>
      <div class="sd-glyph-modal" onClick={(e) => e.stopPropagation()}>
        <div class="sd-glyph-head">
          <input class="sd-glyph-search" autofocus placeholder="🔍 Symbol suchen (z. B. mikrofon, play, herz, ordner …)"
                 value={q} onInput={(e) => setQ(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} />
          <button class="btn ghost small" title="Symbol entfernen" onClick={() => onPick('')}>Kein Symbol</button>
          <button class="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div class="sd-glyph-body">
          {GLYPH_CATS.map((cat) => {
            const names = cat.names.filter(match)
            if (!names.length) return null
            return (
              <div class="sd-glyph-cat" key={cat.label}>
                <div class="sd-glyph-cat-h">{cat.label}</div>
                <div class="sd-glyph-grid">
                  {names.map((nm) => (
                    <button key={nm} type="button" class={'sd-glyph-cell' + (nm === cur ? ' sel' : '')}
                            title={nm} onClick={() => onPick(glyphValue(nm))}><Glyph name={nm} /></button>
                  ))}
                </div>
              </div>
            )
          })}
          {!any && <div class="sd-glyph-empty">Kein Symbol gefunden — versuch einen anderen Begriff.</div>}
        </div>
        <p class="sd-glyph-foot muted">Symbole zeichnen in der Akzent-/Theme-Farbe der Taste und passen sich
          jedem Theme an. Du kannst auch ein Emoji direkt ins Feld tippen.</p>
      </div>
    </div>
  )
}

// ── Symbol-Feld: Bibliotheks-Symbol (Glyph) ODER Emoji-Direkteingabe ──────────
// Ersetzt das nackte Icon-Textfeld. Zeigt das aktuelle Symbol als Vorschau (Glyph leuchtet im
// Akzent), öffnet per Klick die Bibliothek, und lässt daneben weiterhin ein Emoji eintippen.
// ``ctx`` (optional) = { label, action, monitor } des Buttons → schaltet den „🪄 Auto"-Knopf frei, der ein
// sinnvolles Glyph aus unserer Bibliothek vorschlägt. Ist noch kein Symbol gesetzt, zeigt der Knopf den
// Vorschlag schon blass an (man SIEHT, was Auto wählen würde) — ein Klick übernimmt ihn; danach frei änderbar.
function IconField({ value, onChange, placeholder, ctx }) {
  const [pick, setPick] = useState(false)
  const glyph = isGlyph(value) && hasGlyph(glyphName(value))
  const sug = ctx ? suggestGlyph(ctx) : ''
  const sugName = sug ? glyphName(sug) : ''
  const showSugHint = !value && sugName            // leeres Feld → Vorschlag blass im Knopf zeigen
  return (
    <span class="sd-iconfield">
      <button type="button" class={'sd-iconfield-btn' + (glyph ? ' has-glyph' : '') + (showSugHint ? ' is-suggest' : '')}
              title="Symbol-Bibliothek öffnen" onClick={() => setPick(true)}>
        {glyph ? <Glyph name={glyphName(value)} />
          : showSugHint ? <Glyph name={sugName} />
          : <span class="sd-iconfield-emo">{value || '🎨'}</span>}
      </button>
      <input class="so-delay sd-iconfield-in" placeholder={placeholder || 'Emoji'}
             value={isGlyph(value) ? '' : (value || '')} title="Emoji direkt eingeben"
             onInput={(e) => onChange(e.currentTarget.value)} />
      {sug && sug !== value && (
        <button type="button" class="sd-iconfield-auto" title={'Auto-Vorschlag übernehmen: ' + sugName}
                onClick={() => onChange(sug)}>🪄 Auto</button>
      )}
      {pick && <GlyphPicker value={value} onPick={(v) => { onChange(v); setPick(false) }} onClose={() => setPick(false)} />}
    </span>
  )
}

// ── Farb-Feld: eigener Color-Picker + Theme-Farb-Swatches (Akzent/Live/…) ─────
// Eine Theme-Farbe (Schlüsselwort) lässt die Taste dem Theme folgen; eine eigene Hex ist fix.
function ColorField({ value, onChange }) {
  const theme = isThemeColor(value)
  return (
    <span class={'sd-colorfield' + (theme ? ' is-theme' : '')}>
      <input type="color" class="sd-color" value={theme ? '#2a2a2a' : (value || '#2a2a2a')}
             title="Eigene Farbe" onInput={(e) => onChange(e.currentTarget.value)} />
      <span class="sd-theme-sws">
        {/* „(Theme)": keine eigene Farbe → Rahmen/Glow folgen dem Theme-Akzent (kein per-Taste-Override). */}
        <button type="button" class={'sd-theme-sw sd-sw-none' + (!value ? ' sel' : '')}
                title="Keine eigene Farbe → folgt dem Theme" onClick={() => onChange('')}>∅</button>
        {Object.keys(THEME_COLORS).map((k) => (
          <button key={k} type="button" class={'sd-theme-sw tc-' + k + (value === k ? ' sel' : '')}
                  style={`background:var(--${k})`} title={'Theme-Farbe: ' + THEME_COLORS[k]}
                  onClick={() => onChange(k)} />
        ))}
      </span>
    </span>
  )
}

// ── Live-Vorschau einer Taste (physischer Look) ──────────────────────────────
function Swatch({ vis }) {
  const v = vis || { color: '#222', icon: '', title: '…' }
  if (v.image) {
    return (
      <div class="sd-key" style={`background:${resolveColor(v.color) || '#222'};padding:0;overflow:hidden`}>
        <img src={v.image} alt="" style="width:100%;height:100%;object-fit:cover;display:block" />
      </div>
    )
  }
  return (
    <div class="sd-key" style={`background:${resolveColor(v.color) || '#222'}`}>
      <IconView icon={v.icon} cls="sd-key-icon" />
      <span class="sd-key-title">{v.title}</span>
    </div>
  )
}

// Verlaufs-Speicher für die WYSIWYG-Graph-Vorschau: der Editor bekommt dieselben resolved-Werte per SSE wie
// das Panel; wir schreiben pro Button eine kleine Zahlenreihe mit, damit die <Sparkline> im Editor eine echte
// (wenn auch SSE-langsame) Kurve zeigen kann — statt einer flachen Kachel. Modul-Level = von LiveKey lesbar.
const _previewHist = {}
function _accumPreviewHist(buttons) {
  for (const id in (buttons || {})) {
    const val = Number(buttons[id] && buttons[id].value)
    if (Number.isFinite(val)) {
      const h = _previewHist[id] || (_previewHist[id] = [])
      h.push(val); if (h.length > 80) h.shift()
    }
  }
}

// Live-Kachel im WYSIWYG-Raster (Stil = item.style über Deck-Layout). render-bewusst: Uhr/Text/Gauge/Stat/
// Graph/Fader werden auch in der Editor-Vorschau LIVE/1:1 gerendert (wie im Panel), sonst Symbol/Titel-Bild.
function LiveKey({ v, eff, base, render, opts, uid }) {
  v = v || {}
  const o = opts || {}
  const skin = o.skin || (typeof document !== 'undefined' && document.body.dataset.tilestyle) || 'brackets'   // Kachel-Stil (WYSIWYG wie Panel)
  if (render === 'fader') {
    return <div class={keyClass(eff, base) + ' t-fader-key cqsize'} style="background:var(--bg)"><FaderView v={v} opts={o} skin={skin} /></div>
  }
  if (render === 'graph') {
    return (
      <div class={keyClass(eff, base) + ' is-graph cqsize s-' + skin} style={`--acc:${accentVar(v.color)};background:${o.bg ? resolveColor(o.bg) : 'var(--bg)'}`}>
        {v.title ? <span class="t-key-title">{v.title}</span> : null}
        <Sparkline data={_previewHist[uid]} color={v.color} opts={o} uid={uid} />
      </div>
    )
  }
  if (render === 'clock') {
    return <div class={keyClass(eff, base) + ' t-widget is-clock'} style="background:transparent"><Clock opts={o} skin={skin} /></div>
  }
  if (render === 'text') {
    return (
      <div class={keyClass(eff, base) + ' t-widget'} style="background:transparent">
        <span class="t-label-text" style={`font-family:${fontStack(o.font)};color:${o.color || 'var(--fg)'};font-size:${widgetFontSize(o, 'text')}`}>{v.title || v.label || 'Text'}</span>
      </div>
    )
  }
  if (render === 'readout') {
    return <div class={keyClass(eff, base) + ' t-widget is-readout cqsize'} style="background:transparent"><Readout v={v} opts={o} skin={skin} /></div>
  }
  if (render === 'gauge') {
    return <div class={keyClass(eff, base) + ' is-gauge cqsize s-' + skin} style={`--acc:${accentVar(v.color)};background:${o.bg ? resolveColor(o.bg) : 'var(--bg)'}`}><Gauge value={v.value} opts={o} /></div>
  }
  if (render === 'bar') {
    return <div class={keyClass(eff, base) + ' is-bar cqsize s-' + skin} style={`--acc:${accentVar(v.color)};background:${o.bg ? resolveColor(o.bg) : 'var(--bg)'}`}><Bar value={v.value} opts={o} /></div>
  }
  if (render === 'stat') {
    return <div class={keyClass(eff, base) + ' is-stat cqsize s-' + skin} style={`--acc:${accentVar(v.color)};background:${o.bg ? resolveColor(o.bg) : 'var(--bg)'}`}><span class="t-stat-v" style={statStyle(v, o)}>{v.title || (v.value != null ? String(v.value) : '—')}</span></div>
  }
  const isFlat = !v.image && render !== 'graph' && render !== 'fader' && render !== 'gauge' && render !== 'stat' && render !== 'bar'   // dunkle Flat-Kachel + Akzent-Glow (wie Panel)
  return (
    <div class={keyClass(eff, base) + (v.image ? ' has-img' : '') + (isFlat ? ' t-flat s-' + skin : '') + (v.blink ? ' blink' : '')}
         style={isFlat ? `--acc:${accentVar(v.color)}` : ('background:' + (resolveColor(v.color) || 'var(--bg3)'))}>
      {v.image ? <img class="sd-prev-img" src={v.image} alt="" />
        : <IconView icon={v.icon} cls="sd-prev-icon" fallback={<span class="sd-prev-icon">•</span>} />}
      {v.title ? <span class="sd-prev-title">{v.title}</span> : null}
      <span class="sd-prev-label">{v.label || ''}</span>
    </div>
  )
}

// Globale Aktualisierungs-Rate (ein Eval-Loop für alle Buttons) ───────────────
// Backup / Umzug: portable Export-Datei (Decks+Buttons+Icons) + Import + rollierende Auto-Snapshots.
function BackupCard({ onReload }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [snaps, setSnaps] = useState([])
  const loadSnaps = () => getJSON('/api/streamdeck/backups').then((d) => setSnaps(d.backups || [])).catch(() => {})
  useEffect(() => { loadSnaps() }, [])
  const onExport = async () => {
    setBusy(true); setMsg('… erstelle Backup')
    try {
      const r = await fetch('/api/streamdeck/export')
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'rigzdeck-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      setMsg('✅ Backup heruntergeladen (' + Math.round(blob.size / 1024) + ' KB)')
    } catch (er) { setMsg('Export-Fehler: ' + er) }
    setBusy(false)
  }
  const onImport = async (e) => {
    const f = e.currentTarget.files && e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!f) return
    if (!confirm('Backup einspielen? Die aktuelle Config wird überschrieben (vorher automatisch gesichert).\n\n⚠ Spiele nur Backups ein, denen du vertraust — sie können Buttons enthalten, die beim Drücken Programme starten oder URLs aufrufen.')) return
    setBusy(true); setMsg(null)
    try {
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/streamdeck/import', { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.text()) || r.status)
      const d = await r.json()
      setMsg(`✅ ${d.buttons} Buttons · ${d.decks} Decks · ${d.icons || 0} Icons zurückgespielt`
        + (d.executable ? ` · ⚠ ${d.executable} Buttons starten Programme/URLs — vor dem Drücken prüfen` : ''))
      onReload && onReload(); loadSnaps()
    } catch (er) { setMsg('Fehler: ' + er) }
    setBusy(false)
  }
  const restore = async (name) => {
    if (!confirm('Diesen Snapshot zurückspielen? Aktueller Stand wird überschrieben (vorher gesichert).')) return
    setBusy(true); setMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/backups/restore', { name })
      setMsg(`✅ wiederhergestellt (${r.buttons} Buttons)`); onReload && onReload(); loadSnaps()
    } catch (e) { setMsg('Fehler: ' + e) }
    setBusy(false)
  }
  return (
    <div class="card" style="max-width:820px; margin-bottom:12px">
      <div class="reward-row" style="flex-wrap:wrap; gap:8px">
        <span class="kv-k" style="min-width:200px">💾 Backup &amp; Umzug</span>
        <button class="btn small" disabled={busy} onClick={onExport}>⬇ Export (Datei)</button>
        <label class="btn small ghost" style={'cursor:pointer' + (busy ? ';opacity:.5' : '')}>⬆ Import (Datei)
          <input type="file" accept=".zip" style="display:none" disabled={busy} onChange={onImport} /></label>
        {msg && <span class="msg">{msg}</span>}
      </div>
      <p class="muted" style="font-size:12px; margin:4px 0 0">
        <b>Export</b> = eine portable Datei (Decks + Buttons + Custom-Icons) — zum Umzug auf den Gaming-PC oder als Sicherung.
        <b> Import</b> spielt sie 1:1 zurück. <b>Auto-Snapshots</b> laufen leise bei jeder Änderung mit.
      </p>
      {snaps.length > 0 && (
        <div style="margin-top:8px">
          <span class="muted" style="font-size:12px">Auto-Snapshots (Klick = zurückspielen):</span>
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px">
            {snaps.map((s) => (
              <button key={s.name} class="btn small ghost" disabled={busy} title={s.name}
                      onClick={() => restore(s.name)}>{s.name.replace('snap_', '').replace('.json', '')}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RefreshRate({ reg, onSaved }) {
  const [val, setVal] = useState(reg.tick_seconds != null ? reg.tick_seconds : 1.5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const min = reg.tick_min != null ? reg.tick_min : 0.3
  const max = reg.tick_max != null ? reg.tick_max : 10
  const save = async (v) => {
    setBusy(true); setMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/settings', { tick_seconds: v })
      setVal(r.tick_seconds); setMsg('gespeichert'); onSaved && onSaved()
    } catch (e) { setMsg(String(e)) }
    setBusy(false)
  }
  return (
    <div class="card" style="max-width:820px; margin-bottom:12px">
      <div class="reward-row">
        <span class="kv-k" style="min-width:300px">🔄 Aktualisierungs-Rate (global)</span>
        <input class="so-delay" style="width:90px" type="number" step="0.1" min={min} max={max}
               value={val} disabled={busy} onInput={(e) => setVal(Number(e.currentTarget.value))} />
        <span class="muted">s</span>
        <button class="btn small" disabled={busy} onClick={() => save(val)}>{busy ? '…' : 'Speichern'}</button>
        {msg && <span class="msg">{msg}</span>}
      </div>
      <p class="muted" style="font-size:12px; margin:4px 0 0">
        <b>Ein</b> Push für <b>alle</b> Buttons, alle {val}s. Poll-Buttons (z.&nbsp;B. Main/Health) haben
        zusätzlich ihr eigenes Intervall. Bereich {min}–{max}s.
      </p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  DECK-EDITOR (WYSIWYG): Deck wählen → Layout/Kategorien + Buttons direkt im Raster
// ══════════════════════════════════════════════════════════════════════════════
function DeckBar({ decks, active, defaultDeck, dfAvailable, onSelect, onReload }) {
  const [popBusy, setPopBusy] = useState('')
  const [popMsg, setPopMsg] = useState(null)
  const [dragId, setDragId] = useState('')   // Deck-Tabs per Drag&Drop sortieren (Reihenfolge = Panel-Tableiste + Sidescroll)
  const [overId, setOverId] = useState('')
  const setDecks = (next) => postJSON('/api/streamdeck/decks', { decks: next.map((d) => ({ id: d.id, label: d.label, icon: d.icon })) }).then(() => onReload && onReload()).catch(() => {})
  const addDeck = (label) => postJSON('/api/streamdeck/deck/add', { label }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const addFolder = (label) => postJSON('/api/streamdeck/deck/add', { label, icon: '📁', folder: true, make_opener: true }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const dupDeck = () => postJSON('/api/streamdeck/deck/add', { label: (cur.label || 'Deck') + ' (Kopie)', icon: cur.icon, copy_from: cur.id, folder: cur.folder }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const delDeck = () => postJSON('/api/streamdeck/deck/delete', { id: active }).then(() => onReload && onReload()).catch(() => {})
  const move = (dir) => { const arr = decks.slice(); const i = arr.findIndex((x) => x.id === active); const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return;[arr[i], arr[j]] = [arr[j], arr[i]]; setDecks(arr) }
  // Drag&Drop-Sortierung: gezogenes Deck an die Position des Ziel-Decks schieben. Nur INNERHALB derselben
  // Leiste (Deck↔Deck bzw. Ordner↔Ordner) — die Reihenfolge treibt 1:1 die Panel-Tableiste + den Sidescroll.
  const reorder = (a, b) => {
    if (!a || a === b) return
    const arr = decks.slice()
    const i = arr.findIndex((x) => x.id === a), j = arr.findIndex((x) => x.id === b)
    if (i < 0 || j < 0 || !!arr[i].folder !== !!arr[j].folder) return
    const [m] = arr.splice(i, 1); arr.splice(j, 0, m); setDecks(arr)
  }
  const rename = (label) => setDecks(decks.map((x) => x.id === active ? { ...x, label } : x))
  const setIcon = (icon) => setDecks(decks.map((x) => x.id === active ? { ...x, icon } : x))
  const setFolder = (val) => postJSON(`/api/streamdeck/deck/${active}/folder`, { folder: val }).then(() => onReload && onReload()).catch(() => {})
  // Dieses Deck mit allen Live-Elementen einer Quelle füllen (OBS-Szenen / DisplayFusion-Profile).
  // Ersetzt das alte „Preset beim Ordner-Button-Anlegen" — Befüllen gehört dorthin, wo man das Deck
  // bearbeitet, nicht in die Button-Erstellung.
  const populate = async (kind) => {
    setPopBusy(kind); setPopMsg(null)
    try {
      if (kind === 'df') await postJSON(`/api/streamdeck/deck/${active}/populate_displayfusion`, {})
      else await postJSON('/api/streamdeck/deck/populate_obs_scenes', { deck_id: active })
      onReload && onReload(); setPopMsg({ ok: true, t: 'befüllt ✓' })
    } catch (e) { setPopMsg({ ok: false, t: 'fehlgeschlagen (Quelle offline?)' }) }
    setPopBusy('')
  }
  const cur = decks.find((d) => d.id === active) || decks[0] || {}
  const idx = decks.findIndex((d) => d.id === active)
  const regular = decks.filter((d) => !d.folder)
  const folders = decks.filter((d) => d.folder)
  const Tab = (d) => (
    <button key={d.id} title="Ziehen zum Sortieren · Klick zum Bearbeiten"
            class={'sd-deck-tab' + (d.id === active ? ' active' : '') + (dragId === d.id ? ' dragging' : '') + (overId === d.id && dragId && dragId !== d.id ? ' drag-over' : '')}
            draggable onClick={() => onSelect(d.id)}
            onDragStart={(e) => { setDragId(d.id); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id) } catch (_e) {} }}
            onDragEnter={() => setOverId(d.id)}
            onDragOver={(e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move' } catch (_e) {} }}
            onDrop={(e) => { e.preventDefault(); reorder(dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain')), d.id); setDragId(''); setOverId('') }}
            onDragEnd={() => { setDragId(''); setOverId('') }}>
      <span class="sd-deck-tab-icon">{d.icon || '🎛'}</span>
      <span class="sd-deck-tab-label">{d.label || d.id}</span>
    </button>
  )

  return (
    <div class="card" style="max-width:1100px;margin-bottom:12px">
      <div class="sd-deckbar">
        <span class="sd-deckbar-h">Decks</span>
        {regular.map(Tab)}
        <InlineAdd label="➕ Deck" placeholder="Name des Decks" onAdd={addDeck} />
      </div>
      <div class="sd-deckbar sd-deckbar-folders">
        <span class="sd-deckbar-h">📁 Ordner</span>
        {folders.map(Tab)}
        <InlineAdd label="➕ Ordner" placeholder="Name des Ordners" onAdd={addFolder} />
        <span class="muted" style="font-size:12px;flex-basis:100%">Ein Ordner ist einfach ein Deck: hier anlegen, dann <b>füllen wie jedes Deck</b> (Buttons reinziehen — oder oben „📥 Füllen aus" OBS/DisplayFusion). Erreichbar wird er über einen „📁 Ordner öffnen"-Button (dessen Aussehen frei wählbar ist — z.B. die Health-Ampel per „🎨 Aussehen einfügen").</span>
      </div>
      <div class="sd-deck-tools">
        <span class="muted" style="font-size:12px">Aktiv:</span>
        <b>{cur.label}</b> <code class="muted sd-deck-id">{cur.id}</code>
        {cur.folder ? <span class="sd-deck-badge">📁 Ordner</span> : null}
        <InlineEdit value={cur.label} title="Umbenennen" onSave={rename} />
        <InlineEdit value={cur.icon || '🎛'} title="Symbol ändern" trigger="🎨" onSave={setIcon} />
        <button class="sd-order-eye" title="nach vorn" disabled={idx <= 0} onClick={() => move(-1)}>◀</button>
        <button class="sd-order-eye" title="nach hinten" disabled={idx < 0 || idx >= decks.length - 1} onClick={() => move(1)}>▶</button>
        <button class="btn ghost small" title="Mit Layout+Kategorien+Buttons duplizieren" onClick={dupDeck}>⎘ Duplizieren</button>
        {active !== defaultDeck && (cur.folder
          ? <button class="btn ghost small" title="In ein normales Deck umwandeln (kommt zurück in die Tableiste)" onClick={() => setFolder(false)}>→ Deck</button>
          : <button class="btn ghost small" title="In einen Ordner umwandeln (raus aus der Tableiste)" onClick={() => setFolder(true)}>→ Ordner</button>)}
        {active !== defaultDeck
          ? <ConfirmX cls="btn ghost small danger" label="🗑 löschen"
                      title={cur.folder ? 'Ordner löschen — sein „Ordner öffnen"-Button wird mitentfernt' : 'Löschen (Buttons bleiben im Pool)'}
                      onConfirm={delDeck} />
          : <span class="muted" style="font-size:12px">· Standard-Deck (nicht löschbar)</span>}
        <span class="muted" style="font-size:12px;margin-left:6px">· 📥 Füllen aus:</span>
        <button class="btn ghost small" disabled={!!popBusy} onClick={() => populate('obs')}
                title="Dieses Deck mit allen OBS-Szenen-Buttons füllen (additiv)">{popBusy === 'obs' ? '…' : '🎬 OBS-Szenen'}</button>
        {dfAvailable && <button class="btn ghost small" disabled={!!popBusy} onClick={() => populate('df')}
                title="Dieses Deck mit allen DisplayFusion-Profil-Buttons füllen (additiv)">{popBusy === 'df' ? '…' : '🖥 DisplayFusion'}</button>}
        {popMsg && <span class={'msg small ' + (popMsg.ok ? 'ok' : 'err')}>{popMsg.t}</span>}
      </div>
    </div>
  )
}

// Globaler Deck-Look (Kachel-Stil-Default / Druck-Bestätigung / Ordner-Rahmen) — generische deckcore-Einstellung
// im GETEILTEN Editor → Cockpit UND RigzDeck. Wirkt sofort live (applyDeckLook) + persistiert via /look-Route.
function GlobalLookEditor({ look, onReload }) {
  const lk = { ...LOOK_DEFAULT, ...(look || {}) }
  const save = (patch) => {
    applyDeckLook({ ...lk, ...patch })
    postJSON('/api/streamdeck/look', patch).then(() => onReload && onReload()).catch(() => {})
  }
  const fld = 'display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)'
  return (
    <div class="card" style="max-width:820px;margin-bottom:12px">
      <div class="reward-row" style="flex-wrap:wrap;gap:16px;align-items:flex-start">
        <span class="kv-k" style="min-width:150px">🎛 Globaler Look</span>
        <label style={fld}>Kachel-Stil
          <select class="so-delay" value={lk.tile} onChange={(e) => save({ tile: e.currentTarget.value })}>
            {TILE_SKINS.map(([v, l]) => <option value={v}>{l}</option>)}
          </select>
        </label>
        <div style={fld}>Druck-Bestätigung
          <span style="display:flex;gap:6px;align-items:center">
            <select class="so-delay" value={lk.press} onChange={(e) => save({ press: e.currentTarget.value })}>
              {PRESS_MODES.map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
            <ColorField value={lk.pressColor} onChange={(c) => save({ pressColor: c })} />
          </span>
        </div>
        <div style={fld}>Ordner-Rahmen
          <span style="display:flex;gap:10px;align-items:center">
            <label style="display:inline-flex;gap:5px;align-items:center;color:var(--fg);font-weight:500">
              <input type="checkbox" checked={lk.folder !== false} onChange={(e) => save({ folder: e.currentTarget.checked })} /> an
            </label>
            {lk.folder !== false && <ColorField value={lk.folderColor} onChange={(c) => save({ folderColor: c })} />}
          </span>
        </div>
        <div style={fld}>Rahmen / Box
          <label style="display:inline-flex;gap:5px;align-items:center;color:var(--fg);font-weight:500">
            <input type="checkbox" checked={lk.frame !== false} onChange={(e) => save({ frame: e.currentTarget.checked })} /> an
          </label>
        </div>
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Standard-Verzierung für <b>alle Decks</b>. Einzelne Tasten
        können einen eigenen Stil tragen (Button-Editor → „Stil"), einzelne Decks alles überschreiben (unten am Deck → „🎛 Deck-Look").</p>
    </div>
  )
}

// 🪄 Auto-Symbole für ALLE Buttons (global). Wendet `suggestGlyph` (dieselbe Quelle wie der „🪄 Auto"-Knopf
// im Symbol-Feld — aus Label + Funktion) in EINEM Schwung auf den ganzen Pool an, statt Taste für Taste.
// Zwei Modi (User-Entscheid offen gehalten): „leere füllen" (nur Tasten OHNE Symbol — zerstörungsfrei) und
// „alle ersetzen" (jede Taste auf den Vorschlag, eigene Symbole gehen verloren → Sicherheitsabfrage).
// Konservativ: nur normale Tasten (render leer/„value", kein Hintergrundbild) — Uhr/Text/Graph/Gauge/Fader
// haben eigene Darstellungslogik und werden NICHT angefasst. Geschrieben wird nur `default.icon` (das primäre
// Symbol); State-Symbole bleiben unberührt. Rein Frontend: iteriert den Pool und upsertet je Taste über die
// bestehende /api/streamdeck/buttons-Route → kein Backend-/Python-Duplikat der Vorschlags-„Intelligenz".
function GlobalAutoIcons({ buttons, onReload }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const list = buttons || []
  // Eine Taste ist auto-fähig, wenn sie normal rendert + kein Bild trägt + die Engine einen Vorschlag liefert.
  const sugFor = (b) => {
    if (b.render && b.render !== 'value') return ''
    if ((b.default || {}).image) return ''
    return suggestGlyph({ label: b.label, action: b.action, monitor: b.monitor })
  }
  const cand = list.map((b) => ({ b, sug: sugFor(b), cur: (b.default || {}).icon || '' }))
                   .filter((x) => x.sug)
  const emptyN = cand.filter((x) => !x.cur).length                       // „leere füllen"
  const replN = cand.filter((x) => x.sug !== x.cur).length               // „alle ersetzen" (no-ops übersprungen)
  const apply = async (mode) => {                                        // mode: 'empty' | 'all'
    if (mode === 'all' && !window.confirm(`Bei ${replN} Taste${replN === 1 ? '' : 'n'} das Symbol durch den Auto-Vorschlag ERSETZEN? Eigene Symbole gehen dabei verloren.`)) return
    setBusy(true); setMsg('')
    let n = 0
    for (const { b, sug, cur } of cand) {
      if (sug === cur) continue                                         // schon korrekt → kein Schreibvorgang
      if (mode === 'empty' && cur) continue                            // belegt → im „leere"-Modus überspringen
      try { await postJSON('/api/streamdeck/buttons', { ...b, default: { ...(b.default || {}), icon: sug } }); n++ } catch (e) { /* einzelne Taste scheitert → weiter */ }
    }
    setMsg(`✓ ${n} Symbol${n === 1 ? '' : 'e'} gesetzt`)
    setBusy(false)
    onReload && onReload()
  }
  return (
    <div class="card" style="max-width:820px;margin-bottom:12px">
      <div class="reward-row" style="flex-wrap:wrap;gap:12px;align-items:center">
        <span class="kv-k" style="min-width:150px">🪄 Auto-Symbole</span>
        <button class="btn small" disabled={busy || !emptyN} onClick={() => apply('empty')}
                title="Nur Tasten ohne Symbol bekommen den Auto-Vorschlag (zerstörungsfrei).">
          {busy ? '…' : `Leere füllen (${emptyN})`}
        </button>
        <button class="btn ghost small" disabled={busy || !replN} onClick={() => apply('all')}
                title="Jede passende Taste auf den Auto-Vorschlag setzen — eigene Symbole gehen verloren.">
          {busy ? '…' : `Alle ersetzen (${replN})`}
        </button>
        {msg && <span class="muted" style="font-size:12px">{msg}</span>}
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Schlägt aus <b>Label + Funktion</b> für jede Taste ein
        passendes Symbol aus der Bibliothek vor (wie der <b>🪄 Auto</b>-Knopf im Symbol-Feld, nur für alle auf einmal).
        Betrifft normale Tasten (kein Bild, keine Uhr/Graph/Fader); setzt nur das Hauptsymbol — Zustands-Symbole bleiben.</p>
    </div>
  )
}

// „Logische Szenen" — Teil der OBS-Integration (NICHT global). Holt SELBST alle OBS-Szenen und hat eine
// EIGENE Szenen-Auswahl je Deck (Solo vs. Dual haben unterschiedliche Szenen-Sets) + Deck-Name → man kann
// mehrere logische Decks bauen. Smart-Ordner (scene_suggest: aktive grün, wahrscheinlich-nächste blau/blinken,
// Rücksprung rot; Öffner zeigt die aktive Szene). Darunter der Ablauf-Editor für die gewählten Szenen.
function SceneFlowPanel({ onReload }) {
  const [data, setData] = useState(null)   // {scene_flow:{map,return}, scenes:[alle OBS-Szenen]}
  const [sel, setSel] = useState(null)     // {sceneName: bool} — Auswahl für DIESES Deck (Default alle)
  const [name, setName] = useState('🎬 Szenen')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => getJSON('/api/streamdeck/scene_flow').then((d) => {
    const dd = d || { scene_flow: { map: {}, return: [] }, scenes: [] }
    setData(dd)
    setSel((cur) => cur || Object.fromEntries((dd.scenes || []).map((s) => [s, true])))   // Default: alle Szenen an
  }).catch(() => setData({ scene_flow: { map: {}, return: [] }, scenes: [] }))
  useEffect(() => { load() }, [])
  const allScenes = (data && data.scenes) || []
  const f = (data && data.scene_flow) || { map: {}, return: [] }
  const selected = allScenes.filter((s) => (sel || {})[s])
  const rets = new Set(f.return || [])
  const flip = (s) => setSel((c) => ({ ...(c || {}), [s]: !((c || {})[s]) }))
  const allSel = (on) => setSel(Object.fromEntries(allScenes.map((s) => [s, on])))
  const build = () => {
    if (!selected.length) { setMsg('Mindestens eine Szene anhaken.'); return }
    setBusy(true); setMsg('')
    postJSON('/api/streamdeck/scene_flow/build', { scenes: selected, label: name || '🎬 Szenen' }).then((r) => {
      setMsg(r && r.ok ? `✓ „${name}" (${r.scenes} Szenen${r.flow_seeded ? ' + Standard-Ablauf' : ''})` : 'Fehlgeschlagen')
      load(); onReload && onReload()
    }).catch(() => setMsg('Fehlgeschlagen')).finally(() => setBusy(false))
  }
  const save = (nextMap, nextRet) => {
    const sf = { map: nextMap !== undefined ? nextMap : (f.map || {}), return: nextRet !== undefined ? nextRet : (f.return || []) }
    setData((d) => ({ ...(d || {}), scene_flow: sf }))
    postJSON('/api/streamdeck/scene_flow', { scene_flow: sf }).then(() => onReload && onReload()).catch(() => {})
  }
  const toggleNext = (from, to) => {
    const cur = (f.map || {})[from] || []
    const nx = cur.includes(to) ? cur.filter((x) => x !== to) : [...cur, to]
    const m = { ...(f.map || {}) }; if (nx.length) m[from] = nx; else delete m[from]
    save(m, undefined)
  }
  const toggleReturn = (sc) => save(undefined, rets.has(sc) ? (f.return || []).filter((x) => x !== sc) : [...(f.return || []), sc])
  return (
    <div style="margin-top:12px;border-top:0.5px solid var(--line);padding-top:12px">
      <div class="sd-int-grp-h"><span>🎬 Logisches Szenen-Deck <span class="muted">— eigene Szenen-Auswahl je Deck (z. B. Solo vs. Dual)</span></span></div>
      <div class="reward-row" style="align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <span class="muted conn-label">Deck-Name</span>
        <input class="so-delay" style="width:150px" value={name} placeholder="🎬 Szenen" onInput={(e) => setName(e.currentTarget.value)} />
        <button class="btn small" disabled={busy} onClick={build}>{busy ? '… baue' : `🎬 Erstellen (${selected.length})`}</button>
        <button class="btn ghost small" onClick={() => setOpen((o) => !o)}>{open ? 'Ablauf ▴' : '🔀 Ablauf bearbeiten ▾'}</button>
        {msg && <span class="muted" style="font-size:12px">{msg}</span>}
      </div>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Aktive Szene = <b style="color:var(--ok)">grün</b>, wahrscheinlich-nächste = <b style="color:#4ea1ff">blau</b> (blinkt),
        Rücksprung (aus BRB/Coffee) = <b style="color:var(--err)">rot</b> (blinkt), Rest ausgegraut (klickbar). Der Ordner-Öffner zeigt die aktive Szene. Mehrere Decks mit verschiedenen Namen möglich.</p>
      <div class="sd-int-grp" style="margin-top:8px">
        <div class="sd-int-grp-h">
          <span>Szenen in diesem Deck <span class="muted">({selected.length}/{allScenes.length})</span></span>
          <span class="sd-int-allnone"><a onClick={() => allSel(true)}>alle</a> · <a onClick={() => allSel(false)}>keine</a></span>
        </div>
        {allScenes.length
          ? <div class="sd-int-cols">{allScenes.map((s) => (
              <label key={s} class="sd-int-chk">
                <input type="checkbox" checked={!!(sel || {})[s]} onChange={() => flip(s)} />
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{s}</span>
              </label>
            ))}</div>
          : <span class="muted" style="font-size:12px">Keine OBS-Szenen gefunden (ist OBS verbunden?).</span>}
      </div>
      {open && (
        <div style="margin-top:8px">
          {!selected.length && <p class="muted">Erst Szenen anhaken.</p>}
          {selected.map((sc) => (
            <div key={sc} class="sd-sf-row">
              <div class="sd-sf-from">
                <b>{sc}</b>
                <label class="muted" style="display:flex;align-items:center;gap:4px;font-size:11px"
                       title="Pausen-Szene (BRB/Coffee …): schlägt automatisch die Szene vor, in der du vorher warst (Rücksprung, rot).">
                  <input type="checkbox" checked={rets.has(sc)} onChange={() => toggleReturn(sc)} /> ↩ Rücksprung-Szene
                </label>
              </div>
              <div class="sd-sf-next">
                <span class="muted" style="font-size:11px">danach wahrscheinlich:</span>
                {selected.filter((x) => x !== sc).map((to) => {
                  const on = ((f.map || {})[sc] || []).includes(to)
                  return <button key={to} class={'sd-sf-chip' + (on ? ' on' : '')} onClick={() => toggleNext(sc, to)}>{on ? '▶ ' : ''}{to}</button>
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Per-Deck-Theme-Override: einem Deck ein eigenes komplettes Theme geben (Preset ODER frei angepasste Farben).
// Beim Aktivieren des Decks färbt sich das GANZE Panel um (z.B. rot=Dual / blau=Solo). „(Globales Theme)" =
// folgt dem Standard. Im GETEILTEN Editor → Cockpit UND RigzDeck bekommen es. Schreibt deck.theme via Route.
function DeckThemeEditor({ deck, onReload }) {
  const [open, setOpen] = useState(false)
  const cur = (deck && deck.theme) || null
  const curVars = (cur && cur.vars) || null
  const curName = (cur && cur.name) || ''
  const curLook = (cur && cur.look) || {}
  const presetId = curVars ? ((THEME_PRESETS.find((p) => p.name === curName) || {}).id || '__custom') : ''
  const lf = 'font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:3px'
  // Theme = {name, vars, look} bauen (leere Teile weglassen); ganz leer → Override entfernen (folgt global).
  const push = (vars, name, look) => {
    const theme = {}
    if (vars) { theme.vars = vars; theme.name = name || 'Eigenes' }
    if (look && Object.keys(look).length) theme.look = look
    postJSON('/api/streamdeck/deck/' + encodeURIComponent(deck.id) + '/theme',
      { theme: Object.keys(theme).length ? theme : null }).then(() => onReload && onReload()).catch(() => {})
  }
  const pickPreset = (id) => {
    if (!id) { push(null, '', curLook); return }                     // Farben → global (Look-Override behalten)
    const p = THEME_PRESETS.find((x) => x.id === id)
    if (p) push({ ...p.vars }, p.name, curLook)
  }
  const editVar = (k, val) => push({ ...(curVars || THEME_PRESETS[0].vars), [k]: val }, 'Eigenes', curLook)
  const setLook = (k, val) => {   // val==='' / null → Key entfernen (folgt global); sonst setzen
    const nl = { ...curLook }
    if (val === '' || val == null) delete nl[k]; else nl[k] = val
    push(curVars, curName, nl)
  }
  const tri = (k) => (k in curLook ? (curLook[k] ? 'on' : 'off') : '')   // folder/frame: '' | 'on' | 'off'
  return (
    <div class="sd-deck-theme">
      <div class="reward-row sd-state" style="flex-wrap:wrap">
        <span class="muted conn-label">🎨 Deck-Theme (Farben)</span>
        <select class="so-delay" value={presetId}
                onChange={(e) => { const v = e.currentTarget.value; if (v !== '__custom') pickPreset(v) }}>
          <option value="">(Globales Theme)</option>
          {THEME_PRESETS.map((p) => <option value={p.id}>{p.name}</option>)}
          {presetId === '__custom' && <option value="__custom">Eigenes</option>}
        </select>
        {curVars && <span class="sd-deck-theme-sw" style={`background:${curVars['--accent'] || '#888'}`} title={curName} />}
        {curVars && <button class="btn ghost small" onClick={() => setOpen((o) => !o)}>{open ? 'Farben schließen' : '🎨 Farben anpassen'}</button>}
        {curVars && <button class="btn ghost small danger" onClick={() => push(null, '', curLook)}>Farben auf global</button>}
      </div>
      {curVars && open && (
        <div class="sd-dt-grid">
          {THEME_VARS.map((v) => (
            <label class="sd-dt-row" key={v.key} title={v.key}>
              <input type="color" value={curVars[v.key] || '#000000'} onInput={(e) => editVar(v.key, e.currentTarget.value)} />
              <span>{v.label}</span>
            </label>
          ))}
        </div>
      )}
      <div class="reward-row sd-state" style="flex-wrap:wrap;margin-top:8px">
        <span class="muted conn-label">🎛 Deck-Look</span>
        <label style={lf}>Kachel-Stil
          <select class="so-delay" value={curLook.tile || ''} onChange={(e) => setLook('tile', e.currentTarget.value)}>
            <option value="">(folgt global)</option>{TILE_SKINS.map(([v, l]) => <option value={v}>{l}</option>)}
          </select>
        </label>
        <label style={lf}>Druck
          <select class="so-delay" value={curLook.press || ''} onChange={(e) => setLook('press', e.currentTarget.value)}>
            <option value="">(folgt global)</option>{PRESS_MODES.map(([v, l]) => <option value={v}>{l}</option>)}
          </select>
        </label>
        <label style={lf}>Ordner-Rahmen
          <select class="so-delay" value={tri('folder')} onChange={(e) => setLook('folder', e.currentTarget.value === '' ? '' : e.currentTarget.value === 'on')}>
            <option value="">(folgt global)</option><option value="on">an</option><option value="off">aus</option>
          </select>
        </label>
        <label style={lf}>Rahmen/Box
          <select class="so-delay" value={tri('frame')} onChange={(e) => setLook('frame', e.currentTarget.value === '' ? '' : e.currentTarget.value === 'on')}>
            <option value="">(folgt global)</option><option value="on">an</option><option value="off">aus</option>
          </select>
        </label>
      </div>
      <p class="muted sd-help">Eigenes Aussehen für dieses Deck → beim Öffnen stylt/färbt sich das <b>ganze Panel</b> um
        (z.B. <b>rot + Neon</b> fürs Dual-Stream-Deck). „(Globales Theme)" / „(folgt global)" = folgt dem Standard.
        Pro Taste geht zusätzlich ein eigener „Stil". Auf jedem Gerät gleich.</p>
    </div>
  )
}

function DeckLayout({ deck, onReload }) {
  const [lay, setLay] = useState({ ...L_DEF, ...(deck.layout || {}) })
  const t = useRef(null)
  useEffect(() => { setLay({ ...L_DEF, ...(deck.layout || {}) }) }, [deck.id, JSON.stringify(deck.layout || {})])
  const save = (patch, immediate) => {
    const next = { ...lay, ...patch }; setLay(next)
    clearTimeout(t.current)
    const doIt = () => postJSON(`/api/streamdeck/deck/${deck.id}/layout`, next).then(() => onReload && onReload()).catch(() => {})
    if (immediate) doIt(); else t.current = setTimeout(doIt, 300)
  }
  const Toggle = ({ k, children }) => (
    <label class="sd-tog"><input type="checkbox" checked={lay[k] !== false} onChange={(e) => save({ [k]: e.currentTarget.checked }, true)} /> {children}</label>
  )
  return (
    <div class="sd-lay-wrap">
      <div class="sd-lay-ctl">
        <label>Spalten
          <select value={lay.cols} onChange={(e) => save({ cols: Number(e.currentTarget.value) }, true)}>
            <option value="0">Auto</option>{Array.from({ length: 16 }, (_, i) => i + 1).map((n) => <option value={n}>{n}</option>)}
          </select>
        </label>
        <label>Größe <input type="range" min="60" max="200" step="2" value={lay.button_size}
          onInput={(e) => save({ button_size: Number(e.currentTarget.value) })} /><span class="sd-lay-v">{lay.button_size}px</span></label>
        <label>Abstand <input type="range" min="0" max="40" step="1" value={lay.gap}
          onInput={(e) => save({ gap: Number(e.currentTarget.value) })} /><span class="sd-lay-v">{lay.gap}px</span></label>
        <label>Schrift <input type="range" min="0.6" max="2" step="0.05" value={lay.font_scale}
          onInput={(e) => save({ font_scale: Number(e.currentTarget.value) })} /><span class="sd-lay-v">{Math.round(lay.font_scale * 100)}%</span></label>
        <Toggle k="show_category_titles">Kategorie-Titel</Toggle>
      </div>
      <div class="sd-lay-ctl">
        <span class="muted" style="font-size:12px">Standard-Stil (pro Button überschreibbar):</span>
        <Toggle k="show_label">Name</Toggle>
        <label>Position
          <select value={lay.label_pos || 'bottom'} onChange={(e) => save({ label_pos: e.currentTarget.value }, true)}>
            <option value="bottom">unten</option><option value="top">oben</option>
          </select>
        </label>
        <Toggle k="show_title">Titel-Text</Toggle>
      </div>
    </div>
  )
}

// Item-Inspektor: Stil/ausblenden/entfernen für den angewählten Button im Deck.
function ItemInspector({ deck, item, onReload }) {
  if (!item) return <p class="muted sd-help">Tipp: einen Button im Raster anklicken → hier Stil/Sichtbarkeit feinjustieren. Ziehen ordnet/kategorisiert.</p>
  const st = item.style || {}
  const patch = (style) => postJSON(`/api/streamdeck/deck/${deck.id}/item/${item.button}`, { style: { ...st, ...style } }).then(() => onReload && onReload()).catch(() => {})
  const Sel = ({ k, label, opts }) => (
    <label>{label}
      <select class="so-delay" value={st[k] || 'inherit'} onChange={(e) => patch({ [k]: e.currentTarget.value })}>
        {opts.map(([v, t]) => <option value={v}>{t}</option>)}
      </select>
    </label>
  )
  // Kachel-Größe (Panel-Span) — direkt am Item (nicht style). NUR Web-Panel; physisch bleibt der Button 1×1.
  const patchItem = (body) => postJSON(`/api/streamdeck/deck/${deck.id}/item/${item.button}`, body).then(() => onReload && onReload()).catch(() => {})
  const Span = ({ k, label, max }) => (
    <label>{label}
      <select class="so-delay" value={item[k] || 1} onChange={(e) => patchItem({ [k]: parseInt(e.currentTarget.value, 10) })}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => <option value={n}>{n}</option>)}
      </select>
    </label>
  )
  return (
    <div class="sd-inspect">
      <span class="muted" style="font-size:12px">Überschreibt das Aussehen von <b>{item.button}</b> — aber nur auf <b>diesem</b> Deck. (Das „🎨 Aussehen" oben gilt überall.)</span>
      <div class="sd-lay-ctl">
        <Sel k="frame" label="Rahmen" opts={[['inherit', 'Standard'], ['on', 'mit Rahmen'], ['off', 'nur Symbol']]} />
        <Sel k="label" label="Name" opts={[['inherit', 'Standard'], ['on', 'an'], ['off', 'aus']]} />
        <Sel k="label_pos" label="Name-Position" opts={[['inherit', 'Standard'], ['bottom', 'unten'], ['top', 'oben']]} />
        <Sel k="title" label="Titel" opts={[['inherit', 'Standard'], ['on', 'an'], ['off', 'aus']]} />
        <Sel k="title_pos" label="Titel-Position" opts={[['inherit', 'unten'], ['bottom', 'unten'], ['top', 'oben']]} />
      </div>
      <p class="muted sd-help" style="margin:6px 0 0">Der „Titel" ist der große Text (aus „🎨 Aussehen → Standard/Status"); er liegt bei Bild-Buttons als Overlay oben oder unten drauf — wie im Stream Deck.</p>
      <p class="muted" style="margin:14px 0 4px;font-weight:600;font-size:12px">📐 Größe im Panel</p>
      <div class="sd-lay-ctl">
        <Span k="w" label="Breite (Spalten)" max={6} />
        <Span k="h" label="Höhe (Reihen)" max={6} />
      </div>
      <p class="muted sd-help" style="margin:6px 0 0">⚠ Gilt <b>nur im Touch-Panel</b> (z. B. breite Graph-/Sensor-Kachel). Auf einem echten Stream Deck bleibt der Button immer <b>1×1</b> (Icon + Wert) — die Größe wird dort ignoriert.</p>
    </div>
  )
}

// Geteilter Deck-Inspektor: Klick auf einen platzierten Button → die VOLLEN Funktions-Einstellungen
// (derselbe FunctionEditor wie in der Button-Bibliothek) PLUS die deck-eigene Platzierung/Stil.
// Wird vom Kategorie-Raster UND vom Frei-Editor genutzt (eine Wahrheit, kein Duplikat).
function DeckItemInspector({ deck, item, btn, options, onReload, onClose, onNavigateDeck }) {
  const [folderBusy, setFolderBusy] = useState(false)
  if (!item) return <ItemInspector deck={deck} item={null} onReload={onReload} />
  // Schon ein Ordner-Öffnen-Button? Dann nicht nochmal „in Ordner umwandeln" anbieten.
  const isFolderOpener = !!(btn && btn.action && btn.action.type === 'open_deck')
  // Vorhandene Ordner (außer diesem Deck) → „verschieben in"-Auswahl. Funktioniert in BEIDEN Editoren
  // (auch auf „Frei anordnen"-Decks, wo Tile-Drag fürs Positionieren reserviert ist).
  const folders = (options.decks || []).filter((d) => d.folder && d.id !== deck.id)
  const toFolder = async () => {
    if (folderBusy) return
    setFolderBusy(true)
    try {
      const r = await postJSON(`/api/streamdeck/deck/${deck.id}/item/${encodeURIComponent(item.button)}/to_folder`, {})
      if (onReload) await onReload()
      onClose && onClose()
      if (r && r.folder && onNavigateDeck) onNavigateDeck(r.folder)   // direkt in den neuen Ordner springen
    } catch (_) {}
    setFolderBusy(false)
  }
  const moveToFolder = async (fid) => {
    if (folderBusy || !fid) return
    setFolderBusy(true)
    try {
      await postJSON(`/api/streamdeck/deck/${fid}/item`, { button: item.button })            // in den Ordner legen
      await delJSON(`/api/streamdeck/deck/${deck.id}/item/${encodeURIComponent(item.button)}`) // hier vom Deck nehmen
      if (onReload) await onReload()
      onClose && onClose()   // BEWUSST NICHT in den Ordner springen — Button verschwindet nur vom Deck, man bleibt
                             // hier und kann zügig weitere Buttons einsortieren (Ordner selbst: oben antippen).
    } catch (_) {}
    setFolderBusy(false)
  }
  return (
    <div class="sd-deck-inspect-panel">
      <div class="sd-inspect-head">
        <span class="sd-inspect-title">✏️ <b>{(btn || {}).label || item.button}</b> — Einstellungen</span>
        <span class="sd-inline">
          {!isFolderOpener && (
            <button class="btn ghost small" disabled={folderBusy} onClick={toFolder}
                    title="Diesen Button in einen Ordner verwandeln — der Ordner sieht genauso aus und enthält den Button als ersten Eintrag.">
              📁 In Ordner umwandeln
            </button>
          )}
          {folders.length > 0 && (
            <select class="so-delay" disabled={folderBusy} title="Diesen Button in einen bestehenden Ordner verschieben"
                    onChange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; moveToFolder(v) }}>
              <option value="">📁 In Ordner verschieben…</option>
              {folders.map((f) => <option value={f.id}>{folderText(f)}</option>)}
            </select>
          )}
          <button class="btn ghost small" onClick={onClose}>✕ schließen</button>
        </span>
      </div>
      {/* Reihenfolge: erst die Platzierung („wie sieht der Button auf DIESEM Deck aus"), dann die Funktion
          — deren „Speichern" sitzt damit ganz unten am Ende der Karte (User-Wunsch). */}
      <h4 class="section-h sd-inspect-sub">📐 Anzeige auf diesem Deck <span class="muted" style="font-weight:400;font-size:12px">— Rahmen · Name · Titel · Größe (überschreibt nur hier)</span></h4>
      <ItemInspector deck={deck} item={item} onReload={onReload} />
      {btn
        ? <>
            <h4 class="section-h sd-inspect-sub">⚙ Funktion <span class="muted" style="font-weight:400;font-size:12px">— Aktion · Überwachung · Aussehen (gilt für diesen Button überall)</span></h4>
            <FunctionEditor key={item.button} button={btn} options={options} onSaved={onReload} />
          </>
        : <p class="muted sd-help">Diese Funktion liegt nicht (mehr) in der Button-Bibliothek.</p>}
    </div>
  )
}

const POOL_UNCAT = '__uncat__'   // interner Key für „Ohne Kategorie" (kann nie ein echter Kategoriename sein)
const CUSTOM_CAT = 'Custom Buttons'   // EINE feste Sammel-Kategorie für eigene (owner-lose) Buttons.
// Eigene Pool-Kategorien gibt es bewusst NICHT mehr (2026-06-21): generierte Buttons ordnet das
// System über ihre Integration (pool_cat: HWiNFO/OBS-Szenen/…), eigene landen alle unter „Custom Buttons".

// Geteilte Paletten-Auswahl (Decks-Tab): Pool-Buttons nach pool_cat gruppiert, klappbar, DEFAULT ZUGEKLAPPT.
// renderChip rendert den Drag-Chip (Mechanik unterscheidet sich je Editor → als Prop reingereicht).
function PalettePicker({ palette, poolCategories, hint, renderChip }) {
  const [open, setOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sd.palcat.open') || '{}') } catch (_) { return {} }
  })
  const toggle = (cat) => setOpen((o) => {
    const n = { ...o, [cat]: !o[cat] }
    try { localStorage.setItem('sd.palcat.open', JSON.stringify(n)) } catch (_) {}
    return n
  })
  const cats = poolCategories || []
  const byCat = {}
  // Eigene (owner-lose) Buttons → IMMER „Custom Buttons"; generierte → ihre System-Kategorie (pool_cat).
  for (const b of palette) { const c = b.owner ? (b.pool_cat || POOL_UNCAT) : CUSTOM_CAT; (byCat[c] = byCat[c] || []).push(b) }
  const orphans = Object.keys(byCat).filter((c) => c !== POOL_UNCAT && !cats.includes(c)).sort()
  const order = [...cats, ...orphans, POOL_UNCAT].filter((c) => (byCat[c] || []).length > 0)
  return (
    <div class="sd-palette">
      <span class="muted" style="font-size:12px">{hint}</span>
      {palette.length === 0
        ? <div class="muted" style="font-size:12px">— alle Pool-Buttons sind auf diesem Deck —</div>
        : order.map((cat) => {
          const list = byCat[cat] || []
          const isOpen = !!open[cat]   // DEFAULT zugeklappt — nur explizit geöffnete Kategorien sind auf
          return (
            <div class="sd-palcat" key={cat}>
              <button class="sd-palcat-h" onClick={() => toggle(cat)}>
                <span class="sd-poolcat-toggle">{isOpen ? '▾' : '▸'}</span>
                <span class="sd-poolcat-name">{cat === POOL_UNCAT ? '📦 Ohne Kategorie' : catLabel(cat)}</span>
                <span class="muted" style="font-size:11px">({list.length})</span>
              </button>
              {isOpen && <div class="sd-pal-chips">{list.map(renderChip)}</div>}
            </div>
          )
        })}
    </div>
  )
}

// 🧩 Freier Drag-/Resize-Editor (gridstack) — Kachel-Positionen sind DATEN (Item x/y/w/h), kein Auto-Flow.
// Spiegelt das Muster des Stream-Tab-Layout-Editors. ⚠ Position/Größe gelten NUR im Touch-Panel; das physische
// Elgato-Plugin liest nur resolved[button] und rendert JEDEN Button 1×1.
function FreeDeckGrid({ deck, pool, poolCategories, resolved, onReload, onExit, options, onNavigateDeck }) {
  const elRef = useRef(null)
  const gridRef = useRef(null)
  const saveT = useRef(null)
  const dragId = useRef(null)   // Pool-Button, der gerade in den Canvas gezogen wird
  const layout = { ...L_DEF, ...(deck.layout || {}) }
  const cols = layout.cols > 0 ? layout.cols : 6
  const cell = layout.button_size || 116
  const items = deck.items || []
  const inDeck = new Set(items.map((it) => it.button))
  const palette = pool.filter((b) => !inDeck.has(b.id) && !b.hidden)
  const byId = {}; for (const b of pool) byId[b.id] = b   // Button-Def per id (render/opts für die Live-Vorschau)
  const itemURL = `/api/streamdeck/deck/${deck.id}/item`
  const [sel, setSel] = useState('')
  const selItem = sel ? items.find((it) => it.button === sel) : null

  // gridstack-Init: erst nach Mount (DOM-Items da). Remount via key, wenn sich die Item-MENGE ändert
  // (Positionen kommen aus den gs-Attributen). Drag/Resize → debounced Bulk-Save (set_deck_positions).
  useEffect(() => {
    if (!elRef.current) return
    const grid = GridStack.init({
      column: cols, cellHeight: cell, margin: 5, float: true,
      resizable: { handles: 'se' }, draggable: { cancel: '.sd-tile-act' },
    }, elRef.current)
    gridRef.current = grid
    const flush = () => {
      const g = gridRef.current
      if (!g) return
      const positions = (g.engine.nodes || []).map((n) => ({
        button: n.el && n.el.getAttribute('gs-id'), x: n.x, y: n.y, w: n.w, h: n.h,
      })).filter((p) => p.button)
      if (positions.length) postJSON(`/api/streamdeck/deck/${deck.id}/positions`, { positions }).catch(() => {})
    }
    const onChange = () => { clearTimeout(saveT.current); saveT.current = setTimeout(flush, 350) }
    grid.on('change', onChange)
    return () => { clearTimeout(saveT.current); try { grid.off('change'); grid.destroy(false) } catch {}; gridRef.current = null }
  }, [deck.id, cols, cell, items.length])

  const addItem = (bid) => postJSON(itemURL, { button: bid, category: '' }).then(() => onReload && onReload()).catch(() => {})
  const removeItem = (bid) => delJSON(`${itemURL}/${bid}`).then(() => onReload && onReload()).catch(() => {})
  // Pool-Button per Drag in den Canvas: Zelle aus den Drop-Koordinaten rechnen → hinzufügen + dort positionieren.
  const dropAt = (bid, cx, cy) => {
    let x = 0, y = 0
    const el = elRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      x = Math.max(0, Math.min(cols - 1, Math.floor((cx - r.left) / (r.width / cols))))
      y = Math.max(0, Math.floor((cy - r.top) / (cell + 5)))
    }
    postJSON(itemURL, { button: bid })
      .then(() => postJSON(`${itemURL}/${bid}`, { x, y }))
      .then(() => onReload && onReload()).catch(() => {})
  }

  return (
    <div>
      <div class="sd-wys-head-row">
        <span class="muted" style="font-size:12px">🧩 <b>Frei platzieren</b> — Kacheln ziehen, an der <b>Ecke unten-rechts</b> ziehen = vergrößern. Speichert automatisch. ⚠ Position/Größe gelten NUR im Touch-Panel; ein echtes Stream Deck zeigt jeden Button 1×1.</span>
        <span class="sd-inline">
          <label class="muted" style="font-size:12px;display:inline-flex;gap:6px;align-items:center">Spalten
            <select class="so-delay" value={layout.cols || 0}
                    onChange={(e) => postJSON(`/api/streamdeck/deck/${deck.id}/layout`, { ...layout, cols: Number(e.currentTarget.value) }).then(() => onReload && onReload()).catch(() => {})}>
              <option value="0">Auto (6)</option>
              {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => <option value={n}>{n}</option>)}
            </select>
          </label>
          <button class="btn ghost small" onClick={onExit} title="Zurück zum Kategorie-Raster (Positionen bleiben gespeichert)">↩ Kategorie-Raster</button>
        </span>
      </div>
      <div class="sd-free" style={`--sd-size:${cell}px;--sd-font:${layout.font_scale || 1};max-width:${cols * (cell + 6) + 8}px`}
           onDragOver={(e) => { if (dragId.current) e.preventDefault() }}
           onDrop={(e) => { e.preventDefault(); const bid = dragId.current; dragId.current = null; if (bid && !inDeck.has(bid)) dropAt(bid, e.clientX, e.clientY) }}>
        <div class="grid-stack sd-gs" ref={elRef} key={deck.id + ':' + items.length}
             style={`min-width:${cols * cell + (cols + 1) * 5}px`}>
          {items.map((it) => {
            const w = Math.min(cols, Math.max(1, it.w || 1)), h = Math.max(1, it.h || 1)
            const attrs = { 'gs-id': it.button, 'gs-w': w, 'gs-h': h, 'gs-max-w': cols }
            if (Number.isInteger(it.x)) attrs['gs-x'] = it.x
            if (Number.isInteger(it.y)) attrs['gs-y'] = it.y
            return (
              <div class="grid-stack-item" key={it.button} {...attrs}>
                <div class={'grid-stack-item-content' + (sel === it.button ? ' sel' : '')}
                     onClick={() => setSel(sel === it.button ? '' : it.button)}>
                  <LiveKey v={resolved[it.button]} eff={resolveStyle(it.style, layout)} base="sd-prev-key" uid={it.button}
                           render={(byId[it.button] || {}).render} opts={(byId[it.button] || {}).opts} />
                  <span class="sd-tile-acts">
                    <button class="sd-tile-act" title="Einstellungen öffnen"
                            onClick={(e) => { e.stopPropagation(); setSel(it.button) }}>✏️</button>
                    <button class="sd-tile-act" title="vom Deck nehmen"
                            onClick={(e) => { e.stopPropagation(); removeItem(it.button) }}>✕</button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <DeckItemInspector deck={deck} item={selItem} btn={byId[sel]} options={options}
                         onReload={onReload} onClose={() => setSel('')} onNavigateDeck={onNavigateDeck} />
      <PalettePicker palette={palette} poolCategories={poolCategories}
        hint="🧩 Pool — Kategorie aufklappen, dann in den Canvas ziehen (oder klicken = landet automatisch):"
        renderChip={(b) => (
          <button key={b.id} class="sd-pal-chip" draggable
                  onDragStart={() => { dragId.current = b.id }}
                  onClick={() => addItem(b.id)} title="In den Canvas ziehen — oder klicken (landet automatisch)">
            <Swatch vis={resolved[b.id]} />
            <span class="sd-pal-name">{b.label || b.id}</span>
          </button>
        )} />
    </div>
  )
}

// Auto-Scroll während HTML5-Drag: der Browser scrollt bei Drag&Drop NICHT von selbst. Wenn unten der
// Inspector offen ist, liegt die Palette weit unten und das Deck-Raster oben aus dem Bild — man käme
// beim Hochziehen eines Palette-Buttons gar nicht mehr ans Raster. Dieser Hook scrollt die Seite,
// sobald der Cursor WÄHREND eines Drags nahe an den oberen/unteren Fensterrand kommt (dragover feuert
// nur während eines aktiven Drags). rAF-Schleife → scrollt auch, wenn man am Rand stehen bleibt.
function useDragAutoScroll() {
  useEffect(() => {
    const EDGE = 110, MAX = 22
    let y = 0, raf = 0, on = false
    const scrollIfEdge = () => {
      const h = window.innerHeight
      if (y < EDGE) window.scrollBy(0, -MAX * (1 - y / EDGE))
      else if (y > h - EDGE) window.scrollBy(0, MAX * (1 - (h - y) / EDGE))
    }
    const step = () => { if (!on) return; scrollIfEdge(); raf = requestAnimationFrame(step) }
    // Sofort beim dragover scrollen (greift schon beim Hochziehen) UND rAF-Schleife für „am Rand stehen
    // bleiben" (falls rAF gedrosselt ist, trägt der dragover-Scroll trotzdem).
    const over = (e) => { y = e.clientY || 0; scrollIfEdge(); if (!on) { on = true; raf = requestAnimationFrame(step) } }
    const stop = () => { on = false; cancelAnimationFrame(raf) }
    document.addEventListener('dragover', over)
    document.addEventListener('drop', stop)
    document.addEventListener('dragend', stop)
    return () => { stop(); document.removeEventListener('dragover', over); document.removeEventListener('drop', stop); document.removeEventListener('dragend', stop) }
  }, [])
}

function DeckGrid({ deck, pool, poolCategories, resolved, onReload, dfAvailable, options, onNavigateDeck }) {
  useDragAutoScroll()
  const [sel, setSel] = useState('')
  const drag = useRef(null)   // {id, from:'grid'|'palette'}
  const [hot, setHot] = useState('')   // Kategorie-Name unter dem Cursor (Drop-Highlight)
  const [folderHot, setFolderHot] = useState('')   // Ordner-Button-id unter dem Cursor (Drop-in-Ordner-Highlight)
  const [obsBusy, setObsBusy] = useState(false)
  const [obsMsg, setObsMsg] = useState(null)
  const [dfBusy, setDfBusy] = useState(false)
  const [dfMsg, setDfMsg] = useState(null)
  const [wlBusy, setWlBusy] = useState(false)
  const [wlMsg, setWlMsg] = useState(null)
  const [waBusy, setWaBusy] = useState(false)
  const [waMsg, setWaMsg] = useState(null)

  const layout = { ...L_DEF, ...(deck.layout || {}) }
  const free = !!layout.free
  const toggleFree = () => postJSON(`/api/streamdeck/deck/${deck.id}/layout`, { ...layout, free: !free })
    .then(() => onReload && onReload()).catch(() => {})
  // Freie Anordnung (gridstack) ist ein eigener Editor → früh raus (alle Hooks oben liefen bereits).
  if (free) return <FreeDeckGrid deck={deck} pool={pool} poolCategories={poolCategories} resolved={resolved} onReload={onReload} onExit={toggleFree} options={options} onNavigateDeck={onNavigateDeck} />
  const cats = deck.categories || []
  const itemsById = {}; for (const it of deck.items || []) itemsById[it.button] = it
  const btnById = {}; for (const b of pool) btnById[b.id] = b   // Button-Def per id (render/opts für die Live-Vorschau)
  const inDeck = new Set((deck.items || []).map((it) => it.button))
  const palette = pool.filter((b) => !inDeck.has(b.id) && !b.hidden)
  const groups = groupDeckItems(deck.items || [], cats, true)   // hidden mit anzeigen (grau)

  const reorderURL = `/api/streamdeck/deck/${deck.id}/reorder`
  const itemURL = `/api/streamdeck/deck/${deck.id}/item`
  const catOf = (id) => { const it = itemsById[id]; const c = it && it.category; return (c && cats.includes(c)) ? c : '' }

  const addItem = (bid, cat) => postJSON(itemURL, { button: bid, category: cat || '' })
  const patchItem = (bid, body) => postJSON(`${itemURL}/${bid}`, body)

  // Drop auf eine Kachel → vor diese einsortieren (+ ggf. Kategorie übernehmen / aus Pool holen).
  // SONDERFALL: ist die Ziel-Kachel ein Ordner (open_deck), wandert der Button IN den Ordner —
  // dort hinein gelegt und (wenn er vom Deck kam) hier entfernt. Selbsterklärendes Drag-in-Ordner.
  const dropOnTile = async (dropId) => {
    const d = drag.current; drag.current = null; setHot(''); setFolderHot('')
    if (!d || d.id === dropId) return
    const tgt = btnById[dropId]
    const intoDeck = (tgt && tgt.action && tgt.action.type === 'open_deck') ? tgt.action.deck : null
    if (intoDeck) {
      await postJSON(`/api/streamdeck/deck/${intoDeck}/item`, { button: d.id }).catch(() => {})
      if (d.from === 'grid') await delJSON(`${itemURL}/${d.id}`).catch(() => {})
      onReload && onReload()
      return
    }
    const targetCat = catOf(dropId)
    if (d.from === 'palette') await addItem(d.id, targetCat).catch(() => {})
    else if (catOf(d.id) !== targetCat) await patchItem(d.id, { category: targetCat }).catch(() => {})
    let ids = (deck.items || []).map((it) => it.button).filter((x) => x !== d.id)
    const at = ids.indexOf(dropId)
    ids.splice(at < 0 ? ids.length : at, 0, d.id)
    await postJSON(reorderURL, { ids }).catch(() => {})
    onReload && onReload()
  }
  // Drop in eine Kategorie (Kopf/Leerfläche) → ans Ende dieser Kategorie.
  const dropOnCat = async (catName) => {
    const d = drag.current; drag.current = null; setHot('')
    if (!d) return
    const cat = catName === UNCAT ? '' : catName
    if (d.from === 'palette') await addItem(d.id, cat).catch(() => {})
    else await patchItem(d.id, { category: cat }).catch(() => {})
    onReload && onReload()
  }

  const addCat = (name) => postJSON(`/api/streamdeck/deck/${deck.id}/categories`, { categories: [...cats, name] }).then(() => onReload && onReload()).catch(() => {})
  const renameCat = (old, name) => postJSON(`/api/streamdeck/deck/${deck.id}/category/rename`, { old, new: name }).then(() => onReload && onReload()).catch(() => {})
  const delCat = (name) => postJSON(`/api/streamdeck/deck/${deck.id}/category/delete`, { name }).then(() => onReload && onReload()).catch(() => {})
  const toggleHide = (it) => patchItem(it.button, { hidden: !it.hidden }).then(() => onReload && onReload()).catch(() => {})
  const removeItem = (bid) => delJSON(`${itemURL}/${bid}`).then(() => { if (sel === bid) setSel(''); onReload && onReload() }).catch(() => {})
  // Pro OBS-Szene einen Szenen-Wechsel-Button in DIESES Deck (Pool-Funktion + Item), idempotent.
  const importScenes = async () => {
    setObsBusy(true); setObsMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/deck/populate_obs_scenes', { deck_id: deck.id })
      setObsMsg({ ok: true, t: `${r.created} neu · ${r.updated} aktualisiert` })
      onReload && onReload()
    } catch (e) { setObsMsg({ ok: false, t: String(e.message || e) }) }
    setObsBusy(false)
  }
  // Pro DisplayFusion-Profil einen Lade-Button in DIESES Deck (aktives Profil live grün).
  const importDf = async () => {
    setDfBusy(true); setDfMsg(null)
    try {
      const r = await postJSON(`/api/streamdeck/deck/${deck.id}/populate_displayfusion`, {})
      setDfMsg({ ok: true, t: `${r.created} neu · ${r.updated} aktualisiert` })
      onReload && onReload()
    } catch (e) { setDfMsg({ ok: false, t: String(e.message || e) }) }
    setDfBusy(false)
  }
  // Wave-Link-Fader/Ausgänge aus der laufenden Wave-Link-App in DIESES Deck (idempotent).
  const importWavelink = async () => {
    setWlBusy(true); setWlMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/wavelink/build', { deck_id: deck.id })
      setWlMsg({ ok: true, t: `${r.created} neu · ${r.updated} aktualisiert (${r.mixes} Mixes · ${r.channels} Channels · ${r.outputs} Ausgänge)` })
      onReload && onReload()
    } catch (e) {
      const m = String(e.message || e)
      setWlMsg({ ok: false, t: m === 'wavelink_offline' ? 'Wave Link läuft nicht / nicht gefunden — Wave Link starten, dann erneut.' : m })
    }
    setWlBusy(false)
  }
  // Allgemeinen Windows-Lautstärke-Regler (Master-Fader + VU) in DIESES Deck (idempotent).
  const importWinaudio = async () => {
    setWaBusy(true); setWaMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/winaudio/build', { deck_id: deck.id })
      setWaMsg({ ok: true, t: r.created ? 'Lautstärke-Fader angelegt ✓' : 'schon vorhanden ✓' })
      onReload && onReload()
    } catch (e) {
      const m = String(e.message || e)
      setWaMsg({ ok: false, t: m === 'winaudio_unavailable' ? 'Windows-Audio nicht verfügbar (läuft die App auf diesem PC?).' : m })
    }
    setWaBusy(false)
  }

  const size = (layout.button_size || 116) + 'px'
  const gridCols = layout.cols > 0 ? `repeat(${layout.cols}, 1fr)` : `repeat(auto-fill, minmax(${size}, 1fr))`
  const gridStyle = `grid-template-columns:${gridCols};gap:${(layout.gap || 12)}px`
  const deckVars = '--sd-size:' + size + ';--sd-font:' + (layout.font_scale || 1)
  const selItem = sel ? itemsById[sel] : null

  return (
    <div>
      <div class="sd-wys-head-row">
        <span class="muted" style="font-size:12px">🖱 Buttons <b>direkt im Raster</b> ziehen — ordnen + zwischen Kategorien schieben. Aus der <b>Palette</b> unten reinziehen. Klick = auswählen.</span>
        <span class="sd-inline">
          <button class="btn ghost small" onClick={toggleFree} title="Freie Drag-Platzierung (gridstack): Kacheln frei verschieben/vergrößern statt Kategorie-Raster">⊞ Frei anordnen</button>
          <InlineAdd label="➕ Kategorie" placeholder="Neue Deck-Kategorie" onAdd={addCat} />
          <span class="muted" style="font-size:11px">· Buttons/Fader generierst &amp; bearbeitest du im <b>🔌 Buttons &amp; Kategorien</b>-Tab; hier ziehst du sie ins Raster und klickst sie zum Feinjustieren an.</span>
        </span>
      </div>

      <div class="sd-wys" style={deckVars}>
        {groups.map((g) => {
          const real = g.name !== UNCAT
          return (
            <div class={'sd-wys-cat' + (hot === g.name ? ' drop-hot' : '')} key={g.name}
                 onDragOver={(e) => { e.preventDefault(); setHot(g.name) }}
                 onDragLeave={() => setHot((h) => h === g.name ? '' : h)}
                 onDrop={(e) => { e.preventDefault(); dropOnCat(g.name) }}>
              {layout.show_category_titles !== false && (
                <div class="sd-wys-cat-h">
                  <span class="sd-wys-cat-name">{g.name}</span>
                  <span class="muted" style="font-size:11px">({g.items.length})</span>
                  {real && <InlineEdit value={g.name} title="Kategorie umbenennen" onSave={(nm) => renameCat(g.name, nm)} />}
                  {real && <ConfirmX title="Kategorie löschen — Buttons bleiben (werden Ohne Kategorie)" onConfirm={() => delCat(g.name)} />}
                </div>
              )}
              {g.items.length === 0
                ? <div class="sd-wys-empty">— Buttons hierher ziehen —</div>
                : (
                  <div class="sd-wys-grid" style={gridStyle}>
                    {g.items.map((it) => {
                      const eff = resolveStyle(it.style, layout)
                      const sw = Math.max(1, it.w || 1), sh = Math.max(1, it.h || 1)
                      const spanned = sw > 1 || sh > 1
                      const tb = btnById[it.button]
                      const isFolder = !!(tb && tb.action && tb.action.type === 'open_deck')   // Ordner-Öffnen-Button
                      return (
                        <div key={it.button} class={'sd-wys-key-wrap' + (sel === it.button ? ' sel' : '') + (it.hidden ? ' is-hidden' : '') + (spanned ? ' spanned' : '') + (folderHot === it.button ? ' folder-drop' : '')}
                             style={spanned ? `grid-column:span ${sw};grid-row:span ${sh}` : ''}
                             draggable onDragStart={(e) => { e.stopPropagation(); drag.current = { id: it.button, from: 'grid' } }}
                             onDragOver={(e) => { e.preventDefault(); e.stopPropagation()
                               if (isFolder && drag.current && drag.current.id !== it.button) setFolderHot(it.button)
                               else if (folderHot) setFolderHot('') }}
                             onDragLeave={() => setFolderHot((h) => h === it.button ? '' : h)}
                             onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnTile(it.button) }}
                             onClick={() => setSel(sel === it.button ? '' : it.button)}
                             title={isFolder ? 'Ordner — Buttons hierauf ziehen = in den Ordner verschieben' : it.button}>
                          <LiveKey v={resolved[it.button]} eff={eff} base="sd-prev-key" uid={it.button}
                                   render={(btnById[it.button] || {}).render} opts={(btnById[it.button] || {}).opts} />
                          <span class="sd-tile-acts">
                            <button class="sd-tile-act" title={it.hidden ? 'einblenden' : 'ausblenden'}
                                    onClick={(e) => { e.stopPropagation(); toggleHide(it) }}>{it.hidden ? '🚫' : '👁'}</button>
                            <button class="sd-tile-act" title="vom Deck nehmen"
                                    onClick={(e) => { e.stopPropagation(); removeItem(it.button) }}>✕</button>
                          </span>
                          {sel === it.button && (
                            <div class="sd-tile-size" onClick={(e) => e.stopPropagation()}
                                 title="Kachelgröße — Spalten × Reihen (nur Touch-Panel; echtes Stream Deck bleibt 1×1)">
                              <select value={sw} onChange={(e) => patchItem(it.button, { w: +e.currentTarget.value, h: sh }).then(() => onReload && onReload())}>
                                {[1, 2, 3, 4, 5, 6].map((n) => <option value={n}>{n}</option>)}
                              </select>
                              <span class="sd-tile-x">×</span>
                              <select value={sh} onChange={(e) => patchItem(it.button, { w: sw, h: +e.currentTarget.value }).then(() => onReload && onReload())}>
                                {[1, 2, 3, 4, 5, 6].map((n) => <option value={n}>{n}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
            </div>
          )
        })}
      </div>

      <DeckItemInspector deck={deck} item={selItem} btn={btnById[sel]} options={options}
                         onReload={onReload} onClose={() => setSel('')} onNavigateDeck={onNavigateDeck} />

      <PalettePicker palette={palette} poolCategories={poolCategories}
        hint="🧩 Pool — Kategorie aufklappen, dann ziehen oder klicken zum Hinzufügen:"
        renderChip={(b) => (
          <button key={b.id} class="sd-pal-chip" draggable
                  onDragStart={() => { drag.current = { id: b.id, from: 'palette' } }}
                  onClick={() => addItem(b.id, '').then(() => onReload && onReload())}
                  title={'Hinzufügen: ' + (b.label || b.id)}>
            <Swatch vis={resolved[b.id]} />
            <span class="sd-pal-name">{b.label || b.id}</span>
          </button>
        )} />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  BUTTON-POOL (Funktionen) — global, einmal definiert
// ══════════════════════════════════════════════════════════════════════════════

function PoolList({ buttons, resolved, options, onReload, title, hint, seedAction, emptyHint }) {
  // Eine flache Liste hand-gemachter (owner-loser) Buttons. Standard = „Custom Buttons" (alle Typen
  // ohne eigene Integration); eine Integration kann SIE über ``title``/``seedAction`` als ihre eigene
  // Buttons-Liste rendern (z.B. „⌨ Makro / Hotkey"). Generische Naht — kein typ-spezifischer Sonderfall.
  const [adding, setAdding] = useState(false)
  const catName = title || catLabel(CUSTOM_CAT)
  const seed = () => { const b = blankButton(); if (seedAction) b.action = { ...b.action, ...seedAction }; return b }
  return (
    <div>
      <div class="conn-toolbar">
        <button class="btn ghost small" onClick={() => setAdding(true)}>➕ Neuer Button</button>
      </div>
      <div class="conn-toolbar" style="margin-top:-8px">
        <span class="muted">{hint || <>{buttons.length} eigene Buttons. Zum Bearbeiten aufklappen, Platzierung aufs Deck per Drag&amp;Drop im <b>Decks &amp; Layout</b>-Tab. Generierte Buttons (OBS · Wave Link · HWiNFO · …) ordnet das System in ihren eigenen <b>Kategorien</b> — eigene Kategorien gibt es bewusst nicht mehr.</>}</span>
      </div>
      {adding && (
        <FunctionEditor button={seed()} options={options} isNew
          onSaved={() => { setAdding(false); onReload && onReload() }} onCancel={() => setAdding(false)} />
      )}
      <div class="sd-poolcat">
        <div class="sd-poolcat-h">
          <span class="sd-poolcat-name">{catName}</span>
          <span class="muted" style="font-size:11px">({buttons.length})</span>
        </div>
        {buttons.length === 0
          ? <div class="sd-wys-empty">{emptyHint || '— noch keine eigenen Buttons — „➕ Neuer Button" —'}</div>
          : <div class="cards">{buttons.map((b) => <PoolCard key={b.id} b={b} vis={resolved[b.id]} options={options}
                                                             allIds={buttons.map((x) => x.id)} onChanged={onReload} />)}</div>}
      </div>
    </div>
  )
}

function PoolCard({ b, vis, options, allIds, onChanged }) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState(null)
  const press = async () => {
    setMsg(null)
    try {
      const r = await postJSON(`/api/streamdeck/press/${b.id}`, {})
      setMsg({ ok: r.success, t: r.message || (r.success ? 'gefeuert' : 'fehlgeschlagen') })
    } catch (e) { setMsg({ ok: false, t: String(e) }) }
  }
  const del = async () => {
    try { await delJSON(`/api/streamdeck/buttons/${b.id}`); onChanged && onChanged() }
    catch (e) { setMsg({ ok: false, t: String(e) }) }
  }
  const clone = async () => {
    const taken = allIds || []
    let id = b.id + '_copy', n = 2
    while (taken.includes(id)) { id = b.id + '_copy' + n; n++ }
    const copy = JSON.parse(JSON.stringify(b)); copy.id = id; copy.label = (b.label || b.id) + ' (Kopie)'
    try { await postJSON('/api/streamdeck/buttons', copy); onChanged && onChanged() }
    catch (e) { setMsg({ ok: false, t: String(e) }) }
  }
  const aType = (b.action || {}).type
  const mType = (b.monitor || {}).type
  return (
    <div class={'card content-card mode-static' + (open ? ' open' : '') + (b.hidden ? ' is-hidden-btn' : '')}>
      <div class="sd-pool-head" style="display:flex;align-items:center;gap:6px;padding-right:8px">
        <button class="card-toggle" style="flex:1;min-width:0" onClick={() => setOpen(!open)}>
          <span class="caret">{open ? '▾' : '▸'}</span>
          <Swatch vis={vis} />
          <span class="card-title">{b.label || b.id}</span>
          {b.hidden && <span class="sd-hidden-badge" title="ausgeblendet — über 🔌 Buttons &amp; Kategorien wieder anhaken">🚫 aus</span>}
          <span class="muted conn-id">⚡{ACTION_LABELS[aType] ? aType : 'none'} · 👁{mType}</span>
        </button>
        <ConfirmX cls="btn ghost small danger" label="🗑" title="Button löschen (aus Pool + allen Decks)" onConfirm={del} />
      </div>
      {open && (
        <div class="card-body">
          <div class="card-foot row" style="margin-bottom:6px">
            <button class="btn ghost small" onClick={press}>▶ Test-Druck</button>
            <button class="btn ghost small" onClick={clone} title="1:1-Kopie dieser Funktion">⎘ Klonen</button>
            {msg && <span class={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
          </div>
          <FunctionEditor button={b} options={options} onSaved={onChanged} />
        </div>
      )}
    </div>
  )
}

// Pro-Button-Refresh: Häkchen + eigene Zeit. Ohne Häkchen → globaler Takt.
function RefreshOverride({ value, options, onChange }) {
  const on = value != null
  const min = options.refresh_min != null ? options.refresh_min : 0.3
  const max = options.refresh_max != null ? options.refresh_max : 600
  return (
    <div class="sd-block">
      <p class="sd-block-h">⏱ Refresh <span class="muted">— wie oft DIESER Button neu ausgewertet wird</span></p>
      <div class="reward-row">
        <label class="muted" style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" checked={on} onChange={(e) => onChange(e.currentTarget.checked ? 5 : undefined)} />
          Eigener Refresh-Timer
        </label>
        {on ? (
          <>
            <input class="so-delay" style="width:80px" type="number" step="0.1" min={min} max={max}
                   value={value} onInput={(e) => onChange(Number(e.currentTarget.value))} />
            <span class="muted">s</span>
          </>
        ) : <span class="muted" style="font-size:12px">nutzt den globalen Takt</span>}
      </div>
    </div>
  )
}

// Mehrzeiliges Titel-Eingabefeld: ein <textarea>, das wie ein einzeiliges Feld aussieht, aber
// ZEILENUMBRÜCHE erlaubt — damit man eigene Buttons genauso mehrzeilig betiteln kann wie die
// generierten (deren Titel ein "\n" enthalten). Verhalten: Shift+Enter = neue Zeile; Enter ohne
// Shift = Feld verlassen (kein versehentlicher Umbruch). Wächst automatisch mit dem Inhalt.
function TitleInput({ value, onInput, cls, style, placeholder }) {
  const ref = useRef(null)
  const grow = (el) => { if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 84) + 'px' } }
  useEffect(() => { grow(ref.current) }, [value])
  return (
    <textarea ref={ref} class={((cls || '') + ' sd-title-area').trim()} style={style} rows={1}
              placeholder={placeholder || 'Titel'} value={value || ''}
              onInput={(e) => { grow(e.currentTarget); onInput(e.currentTarget.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() } }} />
  )
}

// Funktions-Editor (Pool): Aktion + Überwachung + Refresh + Zustände/Default. KEINE Platzierung.
// Typ-Felder für Text-/Uhr-Buttons — Teil der „Aussehen"-Sektion (bei Darstellung text|clock). Bearbeitet
// opts (Schrift/Farbe/Uhr-Modus) + bei Text den angezeigten Text (= der Titel).
function WidgetFields({ render, opts, def, onOpts, onDefault, ctx }) {
  const o = opts || {}
  const isClock = render === 'clock'
  const isReadout = render === 'readout'
  const digital = !isClock || (o.mode || 'digital') === 'digital'
  const setO = (p) => onOpts({ ...o, ...p })
  return (
    <div class="reward-row" style="flex-wrap:wrap;gap:10px">
      {render === 'text' && (
        <>
          <span class="muted conn-label">Text</span>
          <TitleInput cls="reward-input" placeholder="Überschrift / Text" value={(def || {}).title || ''}
                      onInput={(v) => onDefault({ title: v })} />
        </>
      )}
      {isReadout && (
        <>
          <span class="muted conn-label">Symbol</span>
          <IconField value={(def || {}).icon || ''} placeholder="auto" onChange={(icon) => onDefault({ icon })} ctx={ctx} />
          <label>Quelle
            <select class="so-delay" value={o.kind || 'generic'} onChange={(e) => setO({ kind: e.currentTarget.value })}>
              <option value="audio">🔊 Audiogerät</option>
              <option value="generic">— neutral</option>
            </select>
          </label>
        </>
      )}
      {isClock && (
        <label>Anzeige
          <select class="so-delay" value={o.mode || 'digital'} onChange={(e) => setO({ mode: e.currentTarget.value })}>
            <option value="digital">Digital</option>
            <option value="analog">Analog</option>
          </select>
        </label>
      )}
      {digital && (
        <label>Schrift
          <select class="so-delay" value={o.font || (isClock ? 'mono' : 'sans')} onChange={(e) => setO({ font: e.currentTarget.value })}>
            {Object.keys(FONT_LABELS).map((k) => <option value={k}>{FONT_LABELS[k]}</option>)}
          </select>
        </label>
      )}
      <label class="sd-inline" style="gap:6px">{isReadout ? 'Akzent' : 'Farbe'}
        <ColorField value={o.color || ''} onChange={(c) => setO({ color: c || undefined })} />
      </label>
      {isClock && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={o.seconds !== false} onChange={(e) => setO({ seconds: e.currentTarget.checked })} /> Sekunden</label>}
      {isClock && digital && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={o.format24 !== false} onChange={(e) => setO({ format24: e.currentTarget.checked })} /> 24-Std</label>}
      {isClock && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={!!o.date} onChange={(e) => setO({ date: e.currentTarget.checked })} /> Datum</label>}
      {(isClock || isReadout) && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={o.frame !== false} onChange={(e) => setO({ frame: e.currentTarget.checked })} /> Rahmen</label>}
    </div>
  )
}

// 🎚 Eingabequelle eines Faders wählen/umhängen — lädt die LIVE Wave-Link-Quellen (Mixes/Channels)
// + Windows-Lautstärke + App-Lautstärken (App-Mixer) und schreibt action + monitor + label der
// bestehenden Kachel um. Erkennt verwaiste Quellen (id nicht mehr in der Live-Liste, z. B. nach
// Geräte-Neuzuordnung durch Windows oder weil ein Programm gerade keinen Ton ausgibt).
function FaderSource({ b, onPick }) {
  const [src, setSrc] = useState(null)
  const [apps, setApps] = useState([])
  useEffect(() => {
    let off = false
    fetch('/api/wavelink/state').then((r) => r.json()).then((d) => { if (!off) setSrc(d || {}) }).catch(() => { if (!off) setSrc({}) })
    fetch('/api/winaudio/sessions').then((r) => r.json()).then((d) => { if (!off) setApps(d.sessions || []) }).catch(() => {})
    return () => { off = true }
  }, [])
  const a = b.action || {}, m = b.monitor || {}
  const isWa = m.type === 'winaudio_volume' || a.type === 'winaudio'
  const isApp = m.type === 'app_volume' || a.type === 'app_audio'
  const curId = isWa ? '__wa__' : isApp ? ('app:' + (a.app_proc || '')) : (m.id || a.mix_id || a.channel_id || '')
  const mixes = (src && src.mixes) || [], channels = (src && src.channels) || []
  const known = isWa || (isApp && apps.some((x) => ('app:' + x.proc) === curId))
    || (!!curId && (mixes.some((x) => x.id === curId) || channels.some((x) => x.id === curId)))
  const orphan = !!curId && !known
  const pick = (val) => {
    if (val === '__none__') return
    if (val === '__wa__') { onPick({ action: { type: 'winaudio', wa_action: 'toggle_mute' }, monitor: { type: 'winaudio_volume' }, label: 'Windows-Lautstärke' }); return }
    if (val.indexOf('app:') === 0) {
      const proc = val.slice(4), ap = apps.find((x) => x.proc === proc)
      onPick({ action: { type: 'app_audio', aa_action: 'toggle_mute', app_proc: proc }, monitor: { type: 'app_volume' }, label: ap ? ap.name : proc }); return
    }
    const mix = mixes.find((x) => x.id === val)
    if (mix) { onPick({ action: { type: 'wavelink', wl_action: 'mix_mute', mix_id: mix.id }, monitor: { type: 'wavelink_level', target_type: 'mix', id: mix.id }, label: mix.name }); return }
    const ch = channels.find((x) => x.id === val)
    if (ch) onPick({ action: { type: 'wavelink', wl_action: 'channel_mute', channel_id: ch.id }, monitor: { type: 'wavelink_level', target_type: 'channel', id: ch.id }, label: ch.name })
  }
  return (
    <div class="sd-block">
      <p class="sd-block-h">🎚 Eingabequelle <span class="muted">— welche Wave-Link-Quelle / Windows- oder App-Lautstärke dieser Fader regelt (hier umhängen, falls Windows neu zuordnet)</span></p>
      <div class="reward-row">
        <select class="reward-input" value={known ? curId : '__none__'} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="__none__">{orphan ? '⚠ Quelle verloren — neu wählen …' : '— Eingabequelle wählen …'}</option>
          <option value="__wa__">🔊 Windows-Hauptlautstärke</option>
          {mixes.length > 0 && <optgroup label="Wave Link · Mixes">{mixes.map((x) => <option value={x.id}>{x.name}</option>)}</optgroup>}
          {channels.length > 0 && <optgroup label="Wave Link · Channels">{channels.map((x) => <option value={x.id}>{x.name}</option>)}</optgroup>}
          {apps.length > 0 && <optgroup label="App-Lautstärke (App-Mixer)">{apps.map((x) => <option value={'app:' + x.proc}>{x.name}</option>)}</optgroup>}
        </select>
        {src === null && <span class="muted" style="font-size:12px;margin-left:6px">lädt …</span>}
      </div>
      {src && mixes.length === 0 && channels.length === 0
        ? <p class="muted sd-help" style="margin:4px 0 0">Wave Link nicht verbunden — „Windows-Hauptlautstärke" + laufende App-Lautstärken wählbar. Wave-Link-Verbindung im OBS/Wave-Link-Tab prüfen.</p>
        : orphan
          ? <p class="msg err" style="font-size:12px;margin:4px 0 0">Die bisherige Quelle gibt's gerade nicht (Gerät neu zugeordnet oder Programm ohne Ton?). Wähl oben die neue — der Fader wird umgehängt, ohne neu zu erzeugen.</p>
          : null}
    </div>
  )
}

function FunctionEditor({ button, options, isNew, onSaved, onCancel }) {
  const [b, setB] = useState(() => {
    // Defensive Normalisierung: ein (z.B. per API) unvollständig angelegter Button darf den Editor
    // NICHT crashen — MonitorEditor/StatesEditor erwarten monitor/states/default.
    const x = JSON.parse(JSON.stringify(button)) || {}
    if (!x.action || typeof x.action !== 'object') x.action = { type: 'none' }
    if (!x.monitor || typeof x.monitor !== 'object') x.monitor = { type: 'none' }
    if (!Array.isArray(x.states)) x.states = []
    if (!x.default || typeof x.default !== 'object') x.default = {}
    return x
  })
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  // Vorlage/Preset: füllt Überwachung + Zustände + Symbol passend zur Aktion vor. AUTO bei neuen
  // Buttons; sobald der User Überwachung/Zustände/Standard selbst ändert, stoppt das Auto-Füllen.
  const [presetOn, setPresetOn] = useState(!!isNew)
  const stopPreset = () => setPresetOn(false)
  const set = (patch) => setB({ ...b, ...patch })
  const setAction = (patch) => setB({ ...b, action: { ...b.action, ...patch } })
  const setMonitor = (patch) => { stopPreset(); setB({ ...b, monitor: { ...b.monitor, ...patch } }) }
  const setDefault = (patch) => { stopPreset(); setB({ ...b, default: { ...b.default, ...patch } }) }
  const applyPresetData = (p) => {
    if (!p) return
    setB((cur) => ({
      ...cur,
      monitor: p.monitor ? p.monitor : cur.monitor,
      states: Array.isArray(p.states) ? p.states : cur.states,
      default: { ...cur.default, ...(p.default || {}) },
      ...(p.render !== undefined ? { render: p.render || undefined } : {}),
    }))
  }
  const actionSig = JSON.stringify(b.action)
  useEffect(() => {
    if (!presetOn || (((b.action || {}).type) || 'none') === 'none') return
    let cancelled = false
    postJSON('/api/streamdeck/preset', { action: b.action })
      .then((p) => { if (!cancelled) applyPresetData(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [actionSig, presetOn])
  const applyPresetNow = async () => {
    setPresetOn(true)
    try { applyPresetData(await postJSON('/api/streamdeck/preset', { action: b.action })) } catch (e) { /* noop */ }
  }
  // 🎨 Aussehen + Status kopieren/einfügen: das gesamte Look-+-Status-Paket (Darstellung · Monitor ·
  // Zustände · Standard · Refresh) — NICHT die Aktion. Damit kann z.B. die Health-Ampel auf einen
  // Ordner-Button (open_deck) übertragen werden, ohne alles manuell nachzubauen. Clipboard in
  // localStorage (überlebt Button-/Session-Wechsel).
  const [lookClip, setLookClip] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sd.lookClip') || 'null') } catch (_) { return null }
  })
  const copyLook = () => {
    const s = JSON.stringify({ render: b.render, opts: b.opts, monitor: b.monitor,
                               states: b.states, default: b.default, refresh_seconds: b.refresh_seconds })
    try { localStorage.setItem('sd.lookClip', s) } catch (_) {}
    setLookClip(JSON.parse(s)); setMsg({ ok: true, t: '🎨 Aussehen + Status kopiert' })
  }
  const pasteLook = () => {
    if (!lookClip) return
    stopPreset()
    const lc = JSON.parse(JSON.stringify(lookClip))
    setB({ ...b, render: lc.render, opts: lc.opts, monitor: lc.monitor,
           states: lc.states, default: lc.default, refresh_seconds: lc.refresh_seconds })
    setMsg({ ok: true, t: '🎨 eingefügt — nur Aussehen + Status, Aktion bleibt' })
  }

  const save = async () => {
    const id = (b.id || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (!id) { setMsg({ ok: false, t: 'ID fehlt' }); return }
    setBusy(true); setMsg(null)
    try {
      await postJSON('/api/streamdeck/buttons', { ...b, id })
      setMsg({ ok: true, t: 'gespeichert' }); onSaved && onSaved()
    } catch (e) { setMsg({ ok: false, t: String(e) }) }
    setBusy(false)
  }
  return (
    <div class={isNew ? 'card content-card open new-conn' : ''}>
      <div class={isNew ? 'card-body' : ''}>
        {isNew && <h3 class="section-h">Neuer Button (Funktion)</h3>}
        <div class="reward-row">
          <span class="muted conn-label">ID</span>
          <input class="reward-input" placeholder="z.B. obs_rec" value={b.id}
                 disabled={!isNew} onInput={(e) => set({ id: e.currentTarget.value })} />
          <span class="muted conn-label">Name</span>
          <input class="reward-input" placeholder="Anzeigename" value={b.label}
                 onInput={(e) => set({ label: e.currentTarget.value })} />
        </div>
        {b.render === 'fader' && <FaderSource b={b} onPick={(patch) => { stopPreset(); setB({ ...b, ...patch }) }} />}
        <ActionEditor action={b.action} options={options} onChange={setAction} replace={(a) => set({ action: a })}
          onPicked={(info) => set({
            label: b.label || info.name,
            default: { ...b.default, image: info.icon_url || (b.default || {}).image, title: (b.default || {}).title || info.name },
          })} />
        <div class="reward-row" style="margin:6px 0 2px">
          <button class="btn ghost small" type="button" onClick={applyPresetNow}
                  title="Füllt Überwachung, Zustands-Logik und ein passendes Symbol zur gewählten Aktion vor — danach kannst du alles anpassen.">✨ Vorlage anwenden</button>
          <span class="muted" style="font-size:12px">{presetOn
            ? 'füllt Symbol + Logik automatisch — sobald du unten etwas änderst, hört das auf.'
            : 'füllt Überwachung, Zustände + passendes Symbol zur Aktion vor.'}</span>
        </div>
        <div class="reward-row" style="margin:6px 0 2px;align-items:center">
          <span class="muted conn-label">🎨 Aussehen</span>
          <button class="btn ghost small" type="button" onClick={copyLook}
                  title="Darstellung + Statuslogik (Monitor / Zustände / Standard) dieses Buttons kopieren — NICHT die Aktion.">📋 kopieren</button>
          <button class="btn ghost small" type="button" disabled={!lookClip} onClick={pasteLook}
                  title="Kopiertes Aussehen + Statusanzeige hier einsetzen (die Aktion bleibt). Z.B. die Health-Ampel auf einen Ordner-Button übertragen.">📥 einfügen</button>
          <span class="muted" style="font-size:12px">überträgt Look + Statusanzeige (Monitor/Zustände), nicht die Aktion — z.B. Health-Status auf einen Ordner.</span>
        </div>
        <MonitorEditor monitor={b.monitor} options={options} onChange={setMonitor} replace={(m) => { stopPreset(); set({ monitor: m }) }} />
        <RefreshOverride value={b.refresh_seconds} options={options} onChange={(v) => set({ refresh_seconds: v })} />
        <StatesEditor states={b.states} def={b.default} options={options} monitor={b.monitor}
                      action={b.action} label={b.label}
                      render={b.render} opts={b.opts}
                      onRender={(r) => { stopPreset(); set({ render: r === 'value' ? undefined : r }) }}
                      onOpts={(o) => { stopPreset(); set({ opts: o }) }}
                      onStates={(s) => { stopPreset(); set({ states: s }) }} onDefault={setDefault} />
        <div class="card-foot row">
          <button class="btn" disabled={busy} onClick={save}>{isNew ? 'Anlegen' : 'Speichern'}</button>
          {onCancel && <button class="btn ghost small" onClick={onCancel}>Abbrechen</button>}
          {msg && <span class={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// OBS-Verbindungs-Settings — eingebettet im OBS-Integrations-Karten-Detail (ausklappbar).
// HOST-AGNOSTISCH: nutzt /api/obs/config + /api/obs/status (der direkte obs-websocket-Host, z.B.
// RigzDeck). Fehlen die Endpoints (eine größere Host-App verwaltet OBS selbst über eine geteilte
// Verbindung), zeigt es einen dezenten Hinweis statt zu brechen — kein 404-Bruch im anderen Host.
function ObsConn() {
  const [cfg, setCfg] = useState(undefined)   // undefined=lädt · null=kein config-Endpoint · obj=da
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState(4455)
  const [password, setPassword] = useState('')
  const [hasPw, setHasPw] = useState(false)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let alive = true
    fetch('/api/obs/config').then((r) => r.ok ? r.json() : Promise.reject(r.status)).then((d) => {
      if (!alive) return
      setCfg(d); setHost(d.host || '127.0.0.1'); setPort(d.port || 4455)
      setHasPw(!!d.has_password); setConnected(!!d.connected)
    }).catch(() => { if (alive) setCfg(null) })
    return () => { alive = false }
  }, [])
  const save = async () => {
    setBusy(true); setMsg('')
    const body = { host: (host || '').trim() || '127.0.0.1', port: Number(port) || 4455 }
    if ((password || '').trim() !== '') body.password = password   // leer = unverändert (kein versehentliches Löschen)
    try {
      const d = await (await fetch('/api/obs/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
      setPassword(''); setHasPw(!!d.has_password); setConnected(!!d.connected)
      setMsg(d.connected ? 'Verbunden ✓' : (d.error || 'Nicht verbunden'))
    } catch (e) { setMsg('Fehler beim Speichern') }
    setBusy(false)
  }
  const test = async () => {
    setBusy(true); setMsg('')
    try { const d = await (await fetch('/api/obs/status?probe=true')).json(); setConnected(!!d.connected); setMsg(d.connected ? 'Verbunden ✓' : (d.error || 'Nicht verbunden')) }
    catch (e) { setMsg('Fehler beim Testen') }
    setBusy(false)
  }
  if (cfg === undefined) return <div class="sd-int-obs"><span class="muted">Verbindung lädt…</span></div>
  if (cfg === null) return <div class="sd-int-obs"><span class="muted">OBS-Verbindung wird von der Host-App verwaltet.</span></div>
  return (
    <div class="sd-int-obs">
      <p class="hint" style="margin:0 0 8px">In OBS: <b>Werkzeuge → WebSocket-Server</b> aktivieren (Port 4455) + das angezeigte Passwort hier eintragen.</p>
      <div class="sd-int-frow"><span class="muted">Host</span><input class="sd-int-in" value={host} spellcheck={false} onInput={(e) => setHost(e.currentTarget.value)} /></div>
      <div class="sd-int-frow"><span class="muted">Port</span><input class="sd-int-in" type="number" value={port} onInput={(e) => setPort(e.currentTarget.value)} /></div>
      <div class="sd-int-frow"><span class="muted">Passwort</span><input class="sd-int-in" type="password" value={password} spellcheck={false}
        placeholder={hasPw ? '•••••• gespeichert (leer = unverändert)' : 'OBS-WebSocket-Passwort'} onInput={(e) => setPassword(e.currentTarget.value)} /></div>
      <div class="sd-int-gen">
        <button class="btn small" disabled={busy} onClick={save}>{busy ? '…' : 'Speichern & Verbinden'}</button>
        <button class="btn ghost small" disabled={busy} onClick={test}>Testen</button>
        {msg && <span class={'msg small ' + (connected ? 'ok' : 'err')}>{msg}</span>}
      </div>
    </div>
  )
}

// 🔌 Integrationen — an-/abschaltbare Capability-Bündel. ABSCHALTEN = reines Editor-Gating
// (die Button-Typen verschwinden aus den Auswahllisten); bestehende Buttons laufen weiter.
// Pro Integration optional ein „Generieren/Rescan"-Knopf (additiv+idempotent gegen den Live-Stand).
// onReload lädt die Registry/Optionen neu → Gating + frisch generierte Buttons sofort sichtbar.
// ✨ Schnellstart — proaktiver Einrichtungs-Assistent: erkennt LIVE, was vorhanden ist, und legt auf
// einen Klick die empfohlenen Buttons + ein „✨ Schnellstart"-Deck an (reine Wiederverwendung der
// Generatoren — kein Sonderweg). Erkanntes ist vorausgewählt; danach bleibt alles frei editierbar.
function Quickstart({ onReload }) {
  const [scan, setScan] = useState(null)
  const [picked, setPicked] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    getJSON('/api/streamdeck/quickstart').then((d) => {
      const its = d.integrations || []
      setScan(its)
      const p = {}; its.forEach((it) => { p[it.id] = !!it.available }); setPicked(p)
    }).catch(() => setScan([]))
  }, [])
  if (!scan || !scan.length) return null
  const nDet = scan.filter((it) => it.available).length
  const apply = () => {
    const ids = Object.keys(picked).filter((k) => picked[k])
    if (!ids.length || busy) return
    setBusy(true); setMsg(null)
    postJSON('/api/streamdeck/quickstart', { ids })
      .then((r) => {
        setMsg(r.ok
          ? { ok: true, t: `✓ ${r.created || 0} Buttons · ${r.placed || 0} aufs Deck „✨ Schnellstart" — jetzt frei anpassen.` }
          : { ok: false, t: r.reason || 'Fehler' })
        if (r.ok) onReload && onReload()
      })
      .catch((e) => setMsg({ ok: false, t: String(e.message || e) })).then(() => setBusy(false))
  }
  return (
    <div style="border:0.5px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onClick={() => setOpen((o) => !o)}>
        <span style="font-weight:600">✨ Schnellstart</span>
        <span class="muted" style="font-size:12px">{nDet} erkannt — Starter-Buttons &amp; -Deck auf einen Klick</span>
        <span style="flex:1" />
        <span class="muted">{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div style="margin-top:10px">
          <p class="muted" style="font-size:12px;margin:0 0 8px">Erkannt = vorausgewählt. Anhaken/abwählen, dann anlegen — alles bleibt danach frei editierbar.</p>
          <div class="sd-int-cols">
            {scan.map((it) => (
              <label key={it.id} class={'sd-int-chk' + (it.available ? '' : ' off')} title={it.available ? `${it.count} Elemente erkannt` : (it.reason || 'nicht gefunden')}>
                <input type="checkbox" checked={!!picked[it.id]} onChange={() => setPicked((p) => ({ ...p, [it.id]: !p[it.id] }))} />
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{it.emoji} {it.label}</span>
                <span class={'sd-int-dot ' + (it.available ? 'ok' : 'off')} />
              </label>
            ))}
          </div>
          <div class="sd-int-gen" style="margin-top:10px">
            <button class="btn small" disabled={busy} onClick={apply}>{busy ? '… lege an' : '✨ Starter-Deck anlegen'}</button>
            {msg && <span class={'msg small ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function Integrations({ onReload, buttons, poolCategories, resolved, options }) {
  const [items, setItems] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState('')
  const [statuses, setStatuses] = useState({})
  const [probing, setProbing] = useState(false)
  const [sel, setSel] = useState('')
  const [search, setSearch] = useState('')
  const load = () => getJSON('/api/integrations').then((d) => setItems(d.integrations || [])).catch((e) => setErr(String(e)))
  const loadStatus = (probe) => {
    if (probe) setProbing(true)
    return getJSON('/api/integrations/status' + (probe ? '?probe=1' : ''))
      .then((d) => setStatuses(d.statuses || {})).catch(() => {}).then(() => setProbing(false))
  }
  useEffect(() => { load(); loadStatus(false) }, [])
  const toggle = (it) => {
    if (it.base || busy) return
    setBusy(it.id)
    return postJSON('/api/integrations/' + encodeURIComponent(it.id), { enabled: !it.enabled })
      .then((d) => { setItems(d.integrations || []); onReload && onReload() })
      .catch((e) => setErr(String(e))).then(() => setBusy(''))
  }
  if (err) return <p class="fatal">Kategorien nicht erreichbar: {err}</p>
  if (!items) return <p class="muted">Lade Kategorien…</p>
  const list = items.slice().sort((a, b) => (a.base ? -1 : b.base ? 1 : a.label.localeCompare(b.label)))
  // Action-Typen, die einer NICHT-Basis-Integration gehören → diese hand-gemachten Buttons wandern aus
  // „Custom Buttons" in das Panel ihrer Integration (generisch, kein typ-spezifischer Sonderfall).
  const ownedTypes = new Set()
  items.forEach((it) => { if (!it.base) (it.actions || []).forEach((t) => ownedTypes.add(t)) })
  const q = search.trim().toLowerCase()
  const filtered = q ? list.filter((i) => i.label.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)) : list
  const current = list.find((i) => i.id === sel)
  const dot = (id) => {
    const s = statuses[id]
    if (!s || s.state === 'unknown') return <span class="sd-int-dot" />
    return <span class={'sd-int-dot ' + s.state} title={s.detail} />
  }
  return (
    <div class="card" style="max-width:1100px">
      <h3 class="section-h" style="margin-top:0">🔌 Kategorien <span class="muted" style="font-weight:400;font-size:13px">— wähle eine, hake an was du brauchst, generiere</span></h3>
      <Quickstart onReload={onReload} />
      <div class="conn-toolbar" style="margin-bottom:8px">
        <span class="sd-int-search"><input value={search} placeholder="🔍 Kategorie suchen…" onInput={(e) => setSearch(e.currentTarget.value)} /></span>
        <button class="btn ghost small" disabled={probing} onClick={() => loadStatus(true)}>{probing ? '… prüfe' : '🔄 Status prüfen'}</button>
        <span class="muted" style="font-size:12px">🟢 erreichbar · 🔴 aus · ⚪ nicht im Build</span>
      </div>
      <div class="sd-int-pick">
        {filtered.map((it) => (
          <button key={it.id} class={'sd-int-row' + (sel === it.id ? ' sel' : '') + (it.enabled ? '' : ' off')} onClick={() => setSel(it.id)}>
            <span class="sd-int-row-t">{it.emoji} {it.label}</span>
            {dot(it.id)}
            <span class="sd-int-row-on">{it.enabled ? '● an' : '○ aus'}</span>
          </button>
        ))}
        {!filtered.length && <span class="muted" style="padding:8px">Keine Kategorie gefunden.</span>}
      </div>
      {current
        ? <IntegrationPanel key={current.id} it={current} status={statuses[current.id]} busy={busy === current.id}
            onToggle={() => toggle(current)} onReload={onReload} ownedTypes={ownedTypes}
            buttons={buttons} poolCategories={poolCategories} resolved={resolved} options={options} />
        : <p class="hint" style="margin-top:12px">↑ Wähle oben eine Kategorie, um Voraussetzungen zu prüfen + Buttons zu generieren.</p>}
    </div>
  )
}

// Panel der gewählten Integration: Status + An/Aus + live ausgelesene Elemente zum Ankreuzen + Generieren.
// Steuerung des interaktiven Audio-Mixer-Decks (nur in der „🔊 Windows Audio"-Kategorie): Toggle legt
// ein Live-Deck an/entfernt es; darunter eine Ausblend-Liste (abwählen = Programm dauerhaft aus dem
// Mixer nehmen). Das Deck selbst rendert das Panel live (deck.auto==='audio_mixer').
// 🌤 Wetter-Steuerung (nur in der „Wetter"-Kategorie): zeigt aktuelles Wetter + Standort und lässt den
// Standort manuell setzen (Stadt → Geocoding) oder auf Auto (IP) zurückstellen. Quelle Open-Meteo (key-frei).
function WeatherControl({ onReload }) {
  const [st, setSt] = useState(null)
  const [city, setCity] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const load = () => getJSON('/api/weather/status').then(setSt).catch(() => setSt({ available: false, reason: 'nicht erreichbar' }))
  useEffect(() => { load() }, [])
  const setLoc = (body, label) => {
    setBusy(true); setMsg(null)
    postJSON('/api/weather/config', body)
      .then((r) => { setMsg(r.ok ? { ok: true, t: '✓ ' + label } : { ok: false, t: r.reason || 'Fehler' }); load(); onReload && onReload() })
      .catch((e) => setMsg({ ok: false, t: String(e.message || e) })).then(() => setBusy(false))
  }
  return (
    <div style="margin-top:12px">
      <div class={'sd-int-status ' + (st && st.available ? 'ok' : 'na')} style="margin-bottom:8px">
        {st && st.available
          ? `${st.emoji || '🌤'} ${st.temp != null ? Math.round(st.temp) + '°' : ''} · ${st.place || ''}`
          : '⏳ ' + ((st && st.reason) || 'lade Wetter…')}
      </div>
      <div class="reward-row">
        <input class="reward-input" placeholder="Stadt (z. B. Zürich) — leer = Auto per IP"
               value={city} onInput={(e) => setCity(e.currentTarget.value)} />
        <button class="btn small" disabled={busy}
                onClick={() => city.trim() ? setLoc({ city: city.trim() }, city.trim()) : setLoc({ auto: true }, 'Auto-Standort')}>
          {busy ? '…' : 'Setzen'}
        </button>
        <button class="btn ghost small" disabled={busy} onClick={() => { setCity(''); setLoc({ auto: true }, 'Auto-Standort') }}>📍 Auto</button>
      </div>
      {msg && <span class={'msg small ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
      <p class="muted" style="font-size:12px;margin:6px 0 0">Quelle: Open-Meteo (gratis, ohne Key). Standort automatisch per IP oder oben manuell — ~20 min gecacht. Kachel-Look: „🪪 Status-Karte".</p>
    </div>
  )
}

function AudioMixerControl({ onReload }) {
  const [st, setSt] = useState(null)        // {enabled, hidden:[procname]}
  const [apps, setApps] = useState([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    getJSON('/api/streamdeck/audio_mixer').then(setSt).catch(() => setSt({ enabled: false, hidden: [] }))
    let alive = true
    const poll = () => getJSON('/api/winaudio/sessions').then((d) => { if (alive) setApps(d.sessions || []) }).catch(() => {})
    poll(); const iv = setInterval(poll, 2000)   // pollen, nicht einmalig — fängt den Helfer-Warmup + neue Apps
    return () => { alive = false; clearInterval(iv) }
  }, [])
  const toggle = () => {
    setBusy(true)
    postJSON('/api/streamdeck/audio_mixer', { enabled: !(st && st.enabled) })
      .then((r) => { setSt(r); onReload && onReload() }).catch(() => {}).then(() => setBusy(false))
  }
  const hidden = new Set(((st && st.hidden) || []).map((x) => String(x).toLowerCase()))
  const flipHide = (proc) => postJSON('/api/streamdeck/audio_mixer/hide',
    { proc, hidden: !hidden.has(String(proc).toLowerCase()) }).then(setSt).catch(() => {})
  const setSize = (patch) => postJSON('/api/streamdeck/audio_mixer/size', patch).then(setSt).catch(() => {})
  const goneHidden = [...hidden].filter((p) => !apps.some((a) => String(a.proc).toLowerCase() === p))
  return (
    <div class="sd-int-grp" style="margin-top:14px;border-top:0.5px solid var(--line);padding-top:12px">
      <div class="sd-int-grp-h">
        <span>🎛 Interaktives Mixer-Deck</span>
        <button class={'sd-int-toggle' + (st && st.enabled ? ' on' : '')} disabled={busy || !st} onClick={toggle}
                title="Live-Deck Audio Mixer an/aus">{busy ? '…' : (st && st.enabled) ? '● An' : '○ Aus'}</button>
      </div>
      <p class="muted" style="font-size:12px;margin:2px 0 8px">Erstellt ein Live-Deck <b>„🔊 Audio Mixer"</b> im Decks-Tab, das automatisch den Master + jedes tönende Programm als Fader zeigt (kommen/gehen von selbst). Nicht manuell editierbar — dafür immer aktuell.</p>
      {st && st.enabled && (
        <>
          <div class="reward-row" style="margin-bottom:10px">
            <span class="muted conn-label">Fader-Größe</span>
            <span class="muted" style="font-size:12px">Breite</span>
            <select class="so-delay" value={st.w || 1} onChange={(e) => setSize({ w: Number(e.currentTarget.value) })}>
              {[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}</select>
            <span class="muted" style="font-size:12px">Höhe</span>
            <select class="so-delay" value={st.h || 2} onChange={(e) => setSize({ h: Number(e.currentTarget.value) })}>
              {[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}</select>
            <span class="muted" style="font-size:11px">Felder (z.B. 1×3 = schmal &amp; hoch). Grundgröße: Schieber „Größe" oben.</span>
          </div>
          <label class="sd-int-chk sd-int-chk-x" style="margin-bottom:10px">
            <input type="checkbox" checked={!!st.icon_only} onChange={(e) => setSize({ icon_only: e.currentTarget.checked })} />
            Nur App-Symbol statt Titel (oben das Programm-Icon)
          </label>
          <div class="muted" style="font-size:12px;margin-bottom:4px">Im Mixer zeigen <span class="muted">(abwählen = dauerhaft ausblenden)</span>:</div>
          <div class="sd-int-cols">
            {apps.filter((a) => a.proc).map((a) => (
              <label key={a.proc} class="sd-int-chk">
                <input type="checkbox" checked={!hidden.has(String(a.proc).toLowerCase())} onChange={() => flipHide(a.proc)} />
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{a.name || a.proc}</span>
              </label>
            ))}
            {goneHidden.map((p) => (
              <label key={p} class="sd-int-chk">
                <input type="checkbox" checked={false} onChange={() => flipHide(p)} />
                <span class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{p} — ausgeblendet</span>
              </label>
            ))}
            {!apps.length && !goneHidden.length && <span class="muted" style="font-size:12px">— kein Programm gibt gerade Ton aus —</span>}
          </div>
        </>
      )}
    </div>
  )
}

// Familien-Farben der HWiNFO-Viz-Kacheln (Gauge/Balken/Graph/Stat) — gehört in die HWiNFO-Integration,
// NICHT global (wer kein HWiNFO nutzt, hat damit nichts zu tun). Der Modus Quelle/Theme ist die vorhandene
// „Farben"-Dashboard-Option (mode-Prop); hier nur die Farbe je Familie. Setzt --fam-* live (applyPalette,
// ohne den restlichen Look zu verändern) + persistiert look.palette via /look.
function FamilyPaletteEditor({ mode }) {
  const [pal, setPal] = useState(null)
  useEffect(() => {
    getJSON('/api/streamdeck/registry')
      .then((d) => setPal({ ...FAM_PALETTE, ...(((d || {}).look || {}).palette || {}) }))
      .catch(() => setPal({ ...FAM_PALETTE }))
  }, [])
  if (mode === 'theme') {
    return <p class="muted" style="font-size:12px;margin:10px 0 0">🎨 Familien-Farben: aktuell <b>Theme-gebunden</b> (Option „Farben" = Theme). Auf „Quelle" stellen, um eigene Farben je Familie zu setzen.</p>
  }
  if (!pal) return null
  const setColor = (k, v) => {
    const np = { ...pal, [k]: v }; setPal(np)
    applyPalette(np, 'source')                                  // live: nur --fam-*-Vars (Look unberührt)
    postJSON('/api/streamdeck/look', { palette: np }).catch(() => {})
  }
  return (
    <div style="margin-top:10px;border-top:0.5px solid var(--line);padding-top:10px">
      <div class="sd-int-grp-h"><span>🎨 Familien-Farben <span class="muted">— Farbe je Sensor-Familie (Gauge/Balken/Graph/Stat)</span></span></div>
      <div class="sd-dt-grid">
        {FAM_KEYS.map((k) => (
          <label class="sd-dt-row" key={k} title={k}>
            <input type="color" value={pal[k]} onInput={(e) => setColor(k, e.currentTarget.value)} />
            <span>{FAM_LABELS[k] || k}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function IntegrationPanel({ it, status, busy, onToggle, onReload, ownedTypes, buttons, poolCategories, resolved, options }) {
  const [el, setEl] = useState(null)
  const [checked, setChecked] = useState({})   // {groupKey: {id:bool}}
  const [toggles, setToggles] = useState({})
  const [opts, setOpts] = useState({})
  const [renders, setRenders] = useState({})   // {item_id: render} — pro Item wählbare Darstellung (z.B. HWiNFO)
  const [obsOpen, setObsOpen] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  // Hand-gemachte (owner-lose) Buttons, deren Aktionstyp DIESE Integration besitzt → ihre eigene Liste.
  const ownActs = it.actions || []
  const ownButtons = (buttons || []).filter((b) => !b.owner && ownActs.includes(((b.action || {}).type)))
  const ownsButtons = !it.base && ownActs.length > 0
  useEffect(() => {
    setEl(null); setMsg(null); setObsOpen(false)
    if (it.custom || it.id === 'hotkey' || !it.enabled) return   // hotkey: kein Generator, eigenes Panel
    getJSON('/api/integrations/' + it.id + '/elements').then((d) => {
      setEl(d)
      const c = {}; (d.groups || []).forEach((g) => { c[g.key] = {}; g.items.forEach((x) => { c[g.key][x.id] = ('present' in x) ? !!x.present : ('recommend' in x ? !!x.recommend : true) }) })
      setChecked(c)
      const o = {}; (d.options || []).forEach((op) => { o[op.key] = op.default }); setOpts(o)
      const t = {}; (d.toggles || []).forEach((tg) => { t[tg.key] = ('present' in tg) ? !!tg.present : true }); setToggles(t)
      const rnd = {}; (d.groups || []).forEach((g) => g.items.forEach((x) => { if (x.renders) rnd[x.id] = x.render || 'auto' })); setRenders(rnd)
    }).catch(() => setEl({ available: false, reason: 'Auslesen fehlgeschlagen' }))
  }, [it.id, it.enabled])
  const flip = (gk, id) => setChecked((c) => ({ ...c, [gk]: { ...c[gk], [id]: !(c[gk] || {})[id] } }))
  const allG = (gk, its, on) => setChecked((c) => ({ ...c, [gk]: Object.fromEntries(its.map((x) => [x.id, on])) }))
  const cnt = (gk) => Object.values(checked[gk] || {}).filter(Boolean).length
  const totalSel = () => Object.keys(checked).reduce((n, gk) => n + cnt(gk), 0) + Object.values(toggles).filter(Boolean).length
  const gen = () => {
    setGenBusy(true); setMsg(null)
    const groups = {}; Object.keys(checked).forEach((gk) => { groups[gk] = Object.keys(checked[gk]).filter((id) => checked[gk][id]) })
    postJSON('/api/integrations/' + it.id + '/generate', { groups, toggles, options: opts, renders })
      .then((r) => { setMsg(r.ok ? { ok: true, t: `✓ ${r.created || 0} neu · ${r.updated || 0} aktualisiert${r.removed ? ` · ${r.removed} entfernt` : ''}${r.hidden ? ` · ${r.hidden} ausgeblendet` : ''} → Pool` } : { ok: false, t: r.reason || 'Fehler' }); if (r.ok) onReload && onReload() })
      .catch((e) => setMsg({ ok: false, t: String(e.message || e) })).then(() => setGenBusy(false))
  }
  // 1-Klick HWiNFO-Dashboard (Übersicht + Kategorie-Ordner). Liest die Optionen oben (Farben/Umfang) + baut
  // alles über die idempotente Builder-Route — überschreibt keine Edits, belebt gelöschte Kacheln nicht wieder.
  const buildDash = (clean) => {
    if (clean && !confirm('Clean-Build: löscht zuerst die alten HWiNFO-Decks (📊 System + Kategorie-Ordner) und alle Sensor-Kacheln, dann frisch bauen. Eigene Decks/Buttons bleiben. Fortfahren?')) return
    setGenBusy(true); setMsg(null)
    postJSON('/api/streamdeck/hwinfo/dashboard', { color_mode: opts.color_mode || 'source', curation: opts.curation || 'essential', render_mode: opts.render_mode || 'graph', override_colors: !!opts.override_colors, clean: !!clean })
      .then((r) => { setMsg(r.ok ? { ok: true, t: `✓ ${clean ? '🧹 frisch: ' : ''}„📊 System" + ${r.decks || 0} Ordner · ${r.tiles || 0} Kacheln` } : { ok: false, t: r.reason || 'Fehler' }); if (r.ok) onReload && onReload() })
      .catch((e) => setMsg({ ok: false, t: String(e.message || e) })).then(() => setGenBusy(false))
  }
  const st = status && status.state !== 'unknown' ? status : null
  if (it.custom) return (
    <div class="sd-int-panel">
      <div class="sd-int-phead">
        <span class="sd-int-title">{it.emoji} {it.label}</span>
        <span style="flex:1" />
        <span class="sd-int-status na" title="Grundfunktion — immer verfügbar">immer aktiv</span>
      </div>
      <div class="sd-int-desc">{it.description}</div>
      <PoolList buttons={(buttons || []).filter((b) => !b.owner && !(ownedTypes && ownedTypes.has((b.action || {}).type)))}
                poolCategories={poolCategories || []}
                resolved={resolved || {}} options={options || {}} onReload={onReload} />
    </div>
  )
  return (
    <div class="sd-int-panel">
      <div class="sd-int-phead">
        <span class="sd-int-title">{it.emoji} {it.label}</span>
        {st && <span class={'sd-int-status ' + st.state}>{st.state === 'ok' ? '🟢' : st.state === 'na' ? '⚪' : '🔴'} {st.detail}</span>}
        <span style="flex:1" />
        {it.base
          ? <span class="sd-int-status na" title="Grundfunktionen — immer verfügbar">immer aktiv</span>
          : <button class={'sd-int-toggle' + (it.enabled ? ' on' : '')} disabled={busy} onClick={onToggle}
              title={it.enabled ? 'Aktiv — Button-Typen im Editor sichtbar' : 'Aus — Typen ausgeblendet (bestehende Buttons laufen weiter)'}>
              {busy ? '…' : it.enabled ? '● An' : '○ Aus'}
            </button>}
      </div>
      <div class="sd-int-desc">{it.description}</div>
      {it.requires && <div class="sd-int-req">🔌 Voraussetzung: {it.requires}</div>}
      {!it.enabled && it.id !== 'hotkey' && <p class="hint" style="margin:10px 0 0">Kategorie ist aus — aktiviere sie (Knopf oben rechts), um Buttons zu generieren.</p>}
      {it.id === 'audio' && <AudioMixerControl onReload={onReload} />}
      {it.id === 'weather' && <WeatherControl onReload={onReload} />}
      {it.id === 'hotkey' && <InterceptionPanel />}
      {it.id === 'hotkey' && !it.enabled && <p class="hint" style="margin:10px 0 0">Kategorie ist aus — bestehende Makro-Buttons laufen weiter; zum Anlegen/Bearbeiten oben aktivieren.</p>}
      {it.enabled && ownsButtons && (ownButtons.length > 0 || it.id === 'hotkey') && (
        <div style="margin-top:14px">
          <div class="sd-int-grp-h" style="border-top:0.5px solid var(--line);padding-top:12px">
            <span>{it.emoji} {it.label}-Buttons <span class="muted">— landen im Pool, aufs Deck ziehbar (Decks &amp; Layout)</span></span>
          </div>
          <PoolList buttons={ownButtons} options={options} resolved={resolved || {}} onReload={onReload}
                    title={it.label + '-Buttons'}
                    seedAction={ownActs.length === 1 ? { type: ownActs[0] } : undefined}
                    hint={<>{ownButtons.length} eigene Button(s). „➕ Neuer Button" legt direkt einen vom Typ <b>{ownActs.join(' / ')}</b> an; Platzierung per Drag&amp;Drop im <b>Decks &amp; Layout</b>-Tab.</>}
                    emptyHint={'— noch keine — „➕ Neuer Button" —'} />
        </div>
      )}
      {it.enabled && it.id !== 'hotkey' && el === null && <p class="muted" style="margin-top:10px">Lese verfügbare Elemente…</p>}
      {it.enabled && el && !el.available && <p class="sd-int-status off" style="margin-top:10px">🔴 {el.reason}</p>}
      {it.enabled && el && el.available && el.note && <p class="hint" style="margin:10px 0 0">{el.note}</p>}
      {it.enabled && el && el.available && it.id !== 'weather' && (
        <>
          {it.id === 'audio' && <div class="sd-int-grp-h" style="margin-top:16px;border-top:0.5px solid var(--line);padding-top:12px"><span>📌 Feste Fader-Buttons erstellen <span class="muted">— landen im Pool, auf jedes Deck ziehbar (grau, wenn App aus)</span></span></div>}
          {(el.groups || []).map((g) => (
            <div key={g.key} class="sd-int-grp">
              <div class="sd-int-grp-h">
                <span>{g.label} <span class="muted">({cnt(g.key)}/{g.items.length})</span></span>
                <span class="sd-int-allnone"><a onClick={() => allG(g.key, g.items, true)}>alle</a> · <a onClick={() => allG(g.key, g.items, false)}>keine</a></span>
              </div>
              {g.items.length
                ? <div class="sd-int-cols">{g.items.map((x) => (
                    <label key={x.id} class="sd-int-chk">
                      <input type="checkbox" checked={!!(checked[g.key] || {})[x.id]} onChange={() => flip(g.key, x.id)} />
                      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">{x.label}</span>
                      {x.renders && <select class="sd-int-rsel" value={renders[x.id] || x.render || 'auto'} onChange={(e) => setRenders((r) => ({ ...r, [x.id]: e.currentTarget.value }))}>
                        {x.renders.map((ch) => <option value={ch[0]}>{ch[1]}</option>)}
                      </select>}
                    </label>
                  ))}</div>
                : <span class="muted" style="font-size:12px">— nichts gefunden —</span>}
            </div>
          ))}
          {(el.toggles || []).map((tg) => (
            <label key={tg.key} class="sd-int-chk sd-int-chk-x"><input type="checkbox" checked={!!toggles[tg.key]} onChange={() => setToggles((t) => ({ ...t, [tg.key]: !t[tg.key] }))} /> {tg.label}</label>
          ))}
          {(el.options || []).map((op) => (
            <div key={op.key} class="sd-int-gen" style="margin-top:10px">
              {op.type === 'bool'
                ? <label class="sd-int-chk sd-int-chk-x" title="An = beim Bauen die alten (bewahrten) Farbwerte mit der frischen Familien-Farbe überschreiben">
                    <input type="checkbox" checked={!!opts[op.key]} onChange={(e) => setOpts((o) => ({ ...o, [op.key]: e.currentTarget.checked }))} /> {op.label}</label>
                : <>
                    <span class="muted" style="font-size:12px">{op.label}:</span>
                    {op.choices
                      ? <select class="sd-pool-cat" value={opts[op.key]} onChange={(e) => setOpts((o) => ({ ...o, [op.key]: e.currentTarget.value }))}>
                          {op.choices.map((ch) => <option value={ch[0]}>{ch[1]}</option>)}</select>
                      : <input class="sd-int-num" type="number" min="1" max="4" value={opts[op.key]} onInput={(e) => setOpts((o) => ({ ...o, [op.key]: Number(e.currentTarget.value) || op.default }))} />}
                  </>}
            </div>
          ))}
          {it.id === 'hwinfo' && el.dashboard && <FamilyPaletteEditor mode={opts.color_mode} />}
          <div class="sd-int-gen" style="margin-top:14px;border-top:0.5px solid var(--line);padding-top:12px;flex-wrap:wrap">
            {el.dashboard && <button class="btn small" disabled={genBusy} onClick={() => buildDash(false)}
                title={'Übersichts-Deck „📊 System" + Kategorie-Ordner (CPU/GPU/Mainboard/Strom/Lüfter/…) — idempotent, additiv, überschreibt keine Edits'}>{genBusy ? '… baue' : '📊 Dashboard bauen'}</button>}
            {el.dashboard && <button class="btn small" disabled={genBusy} onClick={() => buildDash(true)}
                title={'Löscht ZUERST die alten HWiNFO-Decks (📊 System + Kategorie-Ordner) + alle Sensor-Kacheln, dann frisch bauen — gegen Überbleibsel nach einem „Alle"-Import. Eigene Decks/Buttons bleiben.'}>{genBusy ? '… baue' : '🧹 Clean-Build'}</button>}
            <button class="btn small" disabled={genBusy} onClick={gen}>{genBusy ? '… wende an' : `✨ Anwenden (${totalSel()})`}</button>
            <span class="muted" style="font-size:12px">{el.dashboard ? 'Dashboard = fertiges Layout · Anwenden = nur angehakte Sensoren in den Pool' : 'angehakt = anlegen · abgehakt = entfernen'}</span>
            {msg && <span class={'msg small ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
          </div>
        </>
      )}
      {it.id === 'obs' && it.enabled && (
        <div style="margin-top:12px">
          <SceneFlowPanel onReload={onReload} />
          {(options.obs_self_managed !== false) ? (
            <>
              {st && st.state === 'off' && !obsOpen && (
                <p class="hint" style="margin:0 0 8px">🔌 OBS noch nicht verbunden — unter <b>⚙ Verbindung</b> die OBS-WebSocket-Daten (Host / Port / Passwort) eintragen, dann scannt der Tab die Szenen automatisch.</p>
              )}
              <button class="btn ghost small" onClick={() => setObsOpen((o) => !o)}>{obsOpen ? '⚙ Verbindung ▴' : '⚙ Verbindung ▾'}</button>
              {obsOpen && <ObsConn />}
            </>
          ) : (
            <p class="hint" style="margin:0">OBS-Verbindung wird von der Host-App verwaltet — dort einrichten (Host / Port / Passwort).</p>
          )}
        </div>
      )}
    </div>
  )
}

export function StreamDeck() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [resolved, setResolved] = useState({})
  const [view, setView] = useState('decks')   // 'decks' | 'buttons' | 'backup'
  const [activeDeck, setActiveDeck] = useState('')
  const esRef = useRef(null)

  const load = () => getJSON('/api/streamdeck/registry').then((d) => {
    setData(d)
    setActiveDeck((cur) => (cur && (d.decks || []).some((x) => x.id === cur)) ? cur : (d.default_deck || (d.decks && d.decks[0] && d.decks[0].id) || 'main'))
  }).catch((e) => setErr(String(e)))
  useEffect(() => { load() }, [])

  // Editor-Vorschau (WYSIWYG) folgt dem EFFEKTIVEN Look des aktiven Decks = globaler Look + per-Deck-Override
  // (Kachel-Stil/Druck/Ordner/Rahmen). Ohne das zeigte die Vorschau immer den globalen Default-Stil (z.B.
  // „Eck-Brackets") statt des am Deck eingestellten „Innen-Glow" — genau wie im Panel.
  useEffect(() => {
    if (!data) return
    const dk = (data.decks || []).find((x) => x.id === activeDeck) || (data.decks || [])[0] || {}
    applyDeckLook({ ...(data.look || {}), ...((dk.theme && dk.theme.look) || {}) })
  }, [data, activeDeck])

  useEffect(() => {
    const es = new EventSource('/api/streamdeck/stream')
    esRef.current = es
    es.addEventListener('streamdeck:buttons', (ev) => {
      try { const b = JSON.parse(ev.data).buttons || {}; _accumPreviewHist(b); setResolved(b) } catch { /* noop */ }
    })
    es.onerror = () => { /* Browser reconnectet selbst */ }
    return () => es.close()
  }, [])

  if (err) return <p class="fatal">Stream-Deck-Registry nicht erreichbar: {err}</p>
  if (!data) return <p class="muted">Lade Stream-Deck…</p>

  const decks = data.decks || []
  const deck = decks.find((d) => d.id === activeDeck) || decks[0]
  const options = normOptions(data.options)
  // ⚠ Editor-Vorschau im DECK-Theme rendern: ohne das zeigen Swatches/Vorschauen das statische Cockpit-Slate
  // (Akzent ≈ Violett/Blau) statt der echten Deck-Farben (z.B. Gold) → „Themenfarbe: Akzent" wirkte falsch.
  // Die Deck-Theme-Vars auf die Deck-Karte legen → jedes var(--x) darin (LiveKey/Swatch/ColorField-Swatches)
  // löst zur Deck-Palette auf, exakt wie im Panel. Folgt das Deck dem globalen Theme → kein Override (Slate).
  const _dtv = (deck && deck.theme && deck.theme.vars) || null
  const deckThemeStyle = _dtv ? THEME_VARS.map((v) => (_dtv[v.key] ? `${v.key}:${_dtv[v.key]}` : '')).filter(Boolean).join(';') : ''

  return (
    <div>
      <p class="hint">
        <b>Buttons &amp; Kategorien</b> = alle Buttons (Funktion + ID), einmal definiert — von Hand oder über
        die Kategorien angekreuzt. <b>Decks &amp; Layout</b> = unabhängige Tablet-Ansichten mit je eigenem
        Raster/Größe/Kategorien; Buttons ziehst du dort <b>ins Raster</b> und klickst sie zum Bearbeiten an.
        Derselbe Button darf auf mehreren Decks liegen. Das Elgato-Plugin nutzt nur die Button-Definitionen. Live-Vorschau = jetzt.
      </p>

      <RefreshRate reg={data} onSaved={load} />
      {/* Auch der GLOBALE Look-Editor zeigt seine Farb-Swatches im aktiven Deck-Theme — sonst zeigt „Akzent 2"
          das Cockpit-Slate (Blau), während ein Theme-Schlüsselwort beim Drücken die Deck-Farbe (z.B. Gold) nimmt.
          So entspricht der Swatch dem echten Render; wer eine FESTE Farbe will, wählt eine eigene Hex. */}
      <div style={deckThemeStyle}>
        <GlobalLookEditor look={data.look} onReload={load} />
        <GlobalAutoIcons buttons={data.buttons || []} onReload={load} />
      </div>

      <div class="sd-tabbar">
        <button class={'sd-tab' + (view === 'decks' ? ' active' : '')} onClick={() => setView('decks')}>🎛 Decks &amp; Layout</button>
        <button class={'sd-tab' + (view === 'buttons' ? ' active' : '')} onClick={() => setView('buttons')}>🔌 Buttons &amp; Kategorien ({(data.buttons || []).length})</button>
        <button class={'sd-tab' + (view === 'backup' ? ' active' : '')} onClick={() => setView('backup')}>💾 Backup</button>
      </div>

      {view === 'decks' ? (
        <>
          <DeckBar decks={decks} active={deck ? deck.id : ''} defaultDeck={data.default_deck || 'main'}
                   dfAvailable={options.displayfusion_available} onSelect={setActiveDeck} onReload={load} />
          {deck && (
            <div class="card" style={'max-width:1100px' + (deckThemeStyle ? ';' + deckThemeStyle : '')}>
              <h3 class="section-h" style="margin-top:0">{deck.icon || '🎛'} {deck.label} <span class="muted" style="font-weight:400;font-size:13px">— {deck.auto === 'audio_mixer' ? 'Interaktiv (Live-Audio)' : 'Layout & Buttons'}</span></h3>
              <DeckLayout deck={deck} onReload={load} />
              <DeckThemeEditor deck={deck} onReload={load} />
              {deck.auto === 'audio_mixer'
                ? <p class="hint" style="margin-top:10px">🔊 <b>Interaktives Audio-Mixer-Deck.</b> Zeigt automatisch die Windows-Hauptlautstärke + einen Fader für jedes Programm, das gerade Ton ausgibt — wird <b>nicht</b> manuell mit Buttons gefüllt (deshalb kein Raster). Programme dauerhaft ausblenden: Tab <b>🔌 Buttons &amp; Kategorien → 🔊 Windows Audio</b>. Größe/Spalten oben frei einstellbar.</p>
                : <DeckGrid deck={deck} pool={data.buttons || []} options={options} poolCategories={data.pool_categories || []} resolved={resolved} onReload={load}
                        dfAvailable={options.displayfusion_available} onNavigateDeck={setActiveDeck} />}
            </div>
          )}
        </>
      ) : view === 'buttons' ? (
        <Integrations buttons={data.buttons || []} poolCategories={data.pool_categories || []}
          resolved={resolved} options={options} onReload={load} />
      ) : (
        <BackupCard onReload={load} />
      )}
    </div>
  )
}

// ── Funktions-Editor-Bausteine (Aktion / Überwachung / Zustände) ─────────────
// Live-OBSBOT-UVC-Status direkt im Editor: zeigt, ob eine Kamera über rohes UVC steuerbar ist (ready),
// keine Cam gefunden (no_cam — USB? in OBS aktiv? OBSBOT Center darf NICHT laufen) oder UVC fehlt
// (unavailable — comtypes/pygrabber). Pollt /api/obsbot/status (in schlanken Hosts ohne Status → still
// nichts). Reine Anzeige (kein Auto-Kill): erkennen statt heilen.
function ObsbotStatusHint() {
  const [st, setSt] = useState(null)
  useEffect(() => {
    let alive = true
    const tick = () => getJSON('/api/obsbot/status').then((d) => alive && setSt(d || null)).catch(() => alive && setSt(null))
    tick(); const iv = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  if (!st || !st.state) return null
  const M = {
    ready:       ['var(--ok)',    '✓ UVC aktiv — Kamera steuerbar (kein OBSBOT Center nötig)'],
    no_cam:      ['var(--warn)',  '⚠ Keine OBSBOT-Kamera gefunden — per USB verbunden? In OBS als Quelle aktiv? (OBSBOT Center darf NICHT laufen.)'],
    unavailable: ['var(--muted)', 'UVC nicht verfügbar — comtypes/pygrabber fehlen (nur Windows).'],
  }
  const [col, txt] = M[st.state] || ['var(--muted)', st.state]
  return (
    <p class="sd-help" style={`margin-top:6px;color:${col};display:flex;gap:7px;align-items:center`}>
      <span style={`flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:${col};box-shadow:0 0 6px ${col}`}></span>
      <span>{txt}</span>
    </p>
  )
}

// ── Makro / Tastenkürzel: Klick-zum-Aufnehmen ──────────────────────────────────────────────
// Statt „ctrl+shift+1" zu TIPPEN: Feld anklicken und die echte Kombination DRÜCKEN. Der Browser-
// Tastendruck wird in die kanonische Token-Kombo übersetzt, die das Backend (_parse_hotkey) 1:1
// versteht. Mehrere Schritte = Makro (werden beim Druck nacheinander system-weit gesendet).
const HK_PRETTY = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', enter: 'Enter', numenter: 'Num↵',
  esc: 'Esc', space: 'Space', tab: 'Tab', backspace: '⌫', delete: 'Entf', insert: 'Einfg',
  up: '↑', down: '↓', left: '←', right: '→', pageup: 'Bild↑', pagedown: 'Bild↓',
  home: 'Pos1', end: 'Ende', plus: '+', minus: '-', comma: ',', period: '.', slash: '/',
  backslash: '\\', semicolon: ';', quote: "'", bracketleft: '[', bracketright: ']',
  tilde: '~', backquote: '~', equal: '=', printscreen: 'Druck', apps: '☰', capslock: 'Caps',
  numadd: 'Num+',
}
function hkPretty(tok) {
  if (HK_PRETTY[tok]) return HK_PRETTY[tok]
  if (/^f\d{1,2}$/.test(tok)) return tok.toUpperCase()
  if (tok.startsWith('num')) return 'Num' + tok.slice(3)
  return tok.toUpperCase()
}
function hkChips(combo) { return String(combo || '').split('+').filter(Boolean).map(hkPretty) }

const HK_CODE = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'enter', NumpadEnter: 'numenter', Space: 'space', Tab: 'tab', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup',
  PageDown: 'pagedown', Minus: 'minus', Equal: 'plus', Comma: 'comma', Period: 'period',
  Slash: 'slash', Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'quote',
  BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backquote: 'tilde',
  NumpadAdd: 'numadd', NumpadSubtract: 'num-', NumpadMultiply: 'num*', NumpadDivide: 'num/',
  NumpadDecimal: 'num.', PrintScreen: 'printscreen', ContextMenu: 'apps', CapsLock: 'capslock',
}
function hkComboFromEvent(e) {
  const mods = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('win')
  const code = e.code || ''
  let main = null
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) main = 'num' + code.slice(6)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) main = code.toLowerCase()
  else if (HK_CODE[code]) main = HK_CODE[code]
  else { const k = e.key || ''; if (k.length === 1 && /[a-z0-9]/i.test(k)) main = k.toLowerCase() }
  if (!main) return null                       // nur Modifier gedrückt → weiter warten
  return [...mods, main].join('+')
}

function HotkeyCapture({ value, onCapture }) {
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) return undefined
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setListening(false); return }
      const combo = hkComboFromEvent(e)
      if (combo) { onCapture(combo); setListening(false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening])
  const chips = hkChips(value)
  return (
    <button type="button" class={'sd-hk-capture' + (listening ? ' rec' : '')}
            onClick={() => setListening((v) => !v)}
            title="Anklicken und dann die gewünschte Tastenkombination drücken (Esc = abbrechen)">
      {listening
        ? <span class="sd-hk-rec">● Jetzt Tasten drücken…</span>
        : (chips.length
            ? <span class="sd-hk-chips">{chips.map((c) => <kbd class="sd-kbd">{c}</kbd>)}</span>
            : <span class="muted">⌨ Klicken, dann Tasten drücken</span>)}
    </button>
  )
}

// Treiber-Panel: Status + Tastatur-Kalibrierung + DLL-Pfad für den Interception-Sende-Weg.
// Nötig für Apps, die OS-simulierte Tasten verwerfen (TikTok Live Studio). Public-clean:
// die DLL wird nicht gebündelt, sondern aus Config-Pfad/Standardort geladen.
function InterceptionPanel() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [dll, setDll] = useState('')
  const load = () => getJSON('/api/interception/status')
    .then((d) => { setSt(d); setDll(d.dll_path || '') })
    .catch(() => setSt({ available: false, error: 'Status nicht abrufbar', keyboards: [] }))
  useEffect(() => { load() }, [])
  const calibrate = () => {
    setBusy(true); setMsg('● Jetzt EINE Taste auf deiner Tastatur drücken…')
    postJSON('/api/interception/calibrate', { timeout_ms: 8000 })
      .then((d) => { setMsg(d.ok ? '✅ Tastatur gemerkt' : '⚠ ' + (d.error || 'fehlgeschlagen')); return load() })
      .catch((e) => setMsg('⚠ ' + e.message))
      .finally(() => setBusy(false))
  }
  const saveDll = () => {
    setBusy(true)
    postJSON('/api/interception/config', { dll_path: dll }).then(() => load()).finally(() => setBusy(false))
  }
  const avail = !!(st && st.available)
  const cal = !!(st && st.keyboard_hwid)
  return (
    <div class="sd-itc">
      <div class="sd-itc-row">
        <span class={'sd-itc-dot ' + (avail ? 'ok' : 'bad')}></span>
        <b>{avail ? 'Treiber bereit' : 'Treiber nicht bereit'}</b>
        {st && !avail && st.error && <span class="muted">— {st.error}</span>}
      </div>
      <div class="sd-itc-row">
        <span class="muted">Tastatur:</span>
        {cal
          ? <kbd class="sd-kbd" title={st.keyboard_hwid}>kalibriert ✓</kbd>
          : <span class="muted">nicht kalibriert → erste erkannte</span>}
        <button type="button" class="btn ghost small" disabled={busy} onClick={calibrate}>🎯 Tastatur kalibrieren</button>
      </div>
      {msg && <p class="muted" style="margin:2px 0">{msg}</p>}
      <details class="sd-itc-adv">
        <summary class="muted">DLL-Pfad (nur falls nicht automatisch gefunden)</summary>
        <div class="sd-itc-row" style="margin-top:4px">
          <input class="reward-input" style="flex:1;min-width:0" value={dll}
                 placeholder={(st && st.resolved_dll) || 'C:\\…\\library\\x64\\interception.dll'}
                 onInput={(e) => setDll(e.currentTarget.value)} />
          <button type="button" class="btn ghost small" disabled={busy} onClick={saveDll}>speichern</button>
        </div>
      </details>
      <p class="muted sd-help">Einmalig: <b>Interception-Treiber</b> installieren + Rechner neu starten, dann hier
        <b> Tastatur kalibrieren</b>. Danach sendet RigzDeck die Tasten als <b>echte Hardware</b> — nötig für
        <b> TikTok&nbsp;Live&nbsp;Studio</b>, das OS-simulierte Tasten ignoriert.</p>
    </div>
  )
}

function HotkeyEditor({ action, onChange }) {
  // Lokale Zeilen-Liste (erlaubt leere Schritte beim Bauen); persistiert kompakt nach action:
  // 1 Kombo → {keys}; mehrere → {steps:[{keys,delay}]}.
  const seed = () => {
    const src = (Array.isArray(action.steps) && action.steps.length)
      ? action.steps : (action.keys ? [{ keys: action.keys }] : [{ keys: '' }])
    return src.map((s, i) => ({ keys: (s && s.keys) || '', delay: (s && s.delay), _id: 'r' + i }))
  }
  const [rows, setRows] = useState(seed)
  const idc = useRef(rows.length)
  const push = (next) => {
    setRows(next)
    const clean = next.filter((r) => r.keys).map((r) => (r.delay == null ? { keys: r.keys } : { keys: r.keys, delay: r.delay }))
    if (clean.length > 1) onChange({ steps: clean, keys: '' })
    else if (clean.length === 1) onChange({ steps: undefined, keys: clean[0].keys })
    else onChange({ steps: undefined, keys: '' })
  }
  const setRow = (i, p) => push(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const addRow = () => { idc.current += 1; push([...rows, { keys: '', delay: undefined, _id: 'r' + idc.current }]) }
  const delRow = (i) => push(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ keys: '', delay: undefined, _id: 'r0' }])
  const macro = rows.length > 1
  return (
    <>
      <div class="sd-hk-steps">
        {rows.map((r, i) => (
          <div class="sd-hk-step" key={r._id}>
            {macro && <span class="sd-hk-num">{i + 1}</span>}
            <HotkeyCapture value={r.keys} onCapture={(c) => setRow(i, { keys: c })} />
            {macro && i < rows.length - 1 && (
              <label class="sd-hk-delay" title="Pause nach diesem Schritt, in Millisekunden (Default 40)">
                ⏱<input type="number" min="0" max="5000" step="10" value={r.delay == null ? '' : r.delay}
                        placeholder="40" onInput={(e) => {
                          const v = e.currentTarget.value
                          setRow(i, { delay: v === '' ? undefined : Math.max(0, Math.min(5000, parseInt(v, 10) || 0)) })
                        }} />ms
              </label>
            )}
            {macro && <button type="button" class="btn ghost small" title="Schritt entfernen" onClick={() => delRow(i)}>✖</button>}
          </div>
        ))}
      </div>
      <div class="reward-row" style="margin:6px 0 2px">
        <button type="button" class="btn ghost small" onClick={addRow}>➕ Schritt (Makro)</button>
        <span class="muted" style="font-size:12px">Mehrere Schritte = Makro: werden beim Druck der Reihe nach gesendet.</span>
      </div>
      <div class="reward-row" style="margin:8px 0 2px;align-items:center">
        <span class="muted" style="font-size:12px">Senden über:</span>
        <select class="so-delay" value={action.send_via === 'driver' ? 'driver' : 'standard'}
                onChange={(e) => onChange({ send_via: e.currentTarget.value === 'driver' ? 'driver' : undefined })}>
          <option value="standard">Standard (SendInput)</option>
          <option value="driver">🛡 Hardware-Treiber (Interception)</option>
        </select>
      </div>
      {action.send_via === 'driver' && <InterceptionPanel />}
      <p class="muted sd-help">Feld anklicken und die <b>echte Tastenkombination drücken</b> — RigzDeck tippt sie
        beim Druck selbst, <b>system-weit</b> (das Fenster muss nicht im Vordergrund sein). Für <b>OBS</b> und die
        meisten Programme reicht <b>Standard</b>. <b>TikTok&nbsp;Live&nbsp;Studio</b> verwirft OS-simulierte Tasten —
        dafür <b>„Senden über → 🛡 Hardware-Treiber"</b> wählen (Interception, einmalig kalibrieren). Setup: in der
        Ziel-App unter Hotkeys eine Kombo vergeben und hier <b>dieselbe</b> aufnehmen.</p>
    </>
  )
}

function ActionEditor({ action, options, onChange, replace, onPicked }) {
  const t = action.type || 'none'
  const proc = (options.processes || []).find((p) => p.key === action.process)
  const [obsScenes, setObsScenes] = useState([])
  const [obsSources, setObsSources] = useState([])
  const [eaActions, setEaActions] = useState([])
  const [dfProfiles, setDfProfiles] = useState([])
  const [winDevs, setWinDevs] = useState([])
  const [appSessions, setAppSessions] = useState([])
  const [picking, setPicking] = useState(false)
  const [pickMsg, setPickMsg] = useState(null)
  const [deckOpts, setDeckOpts] = useState(options.decks || [])   // Ziel-Deck-Liste (open_deck), lokal aktualisierbar
  const [presetBusy, setPresetBusy] = useState(false)
  const [presetMsg, setPresetMsg] = useState(null)
  useEffect(() => { setDeckOpts(options.decks || []) }, [options.decks])
  useEffect(() => {
    if (t === 'obs') {
      getJSON('/api/obs/scenes').then((d) => setObsScenes(d.scenes || [])).catch(() => {})
      getJSON('/api/obs/scene_items').then((d) => setObsSources(d.sources || [])).catch(() => {})
    }
    if (t === 'events_action') getJSON('/api/events_actions/config')
      .then((d) => setEaActions(d.actions || [])).catch(() => {})
    if (t === 'displayfusion') getJSON('/api/displayfusion/profiles')
      .then((d) => setDfProfiles(d.profiles || [])).catch(() => {})
    if (t === 'winaudio') getJSON('/api/winaudio/devices')
      .then((d) => setWinDevs(d.devices || [])).catch(() => {})
    if (t === 'app_audio') getJSON('/api/winaudio/sessions')
      .then((d) => setAppSessions(d.sessions || [])).catch(() => {})
  }, [t])
  const pickFile = async () => {
    setPicking(true); setPickMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/pick_file', {})
      if (r && r.cancelled) { setPicking(false); return }
      if (!r || !r.ok || !r.path) throw new Error('keine Datei')
      onChange({ path: r.path })
      if (onPicked) onPicked({ name: r.name, icon_url: r.icon_url })
      setPickMsg({ ok: true, t: r.icon_url ? 'Datei + Icon übernommen' : 'Datei übernommen (kein Icon gefunden)' })
    } catch (e) { setPickMsg({ ok: false, t: 'Auswahl fehlgeschlagen: ' + (e.message || e) }) }
    setPicking(false)
  }
  const pickFolder = async () => {
    setPicking(true); setPickMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/pick_folder', {})
      if (r && r.cancelled) { setPicking(false); return }
      if (!r || !r.ok || !r.path) throw new Error('kein Ordner')
      onChange({ path: r.path })
      setPickMsg({ ok: true, t: 'Ordner übernommen: ' + r.path })
    } catch (e) { setPickMsg({ ok: false, t: 'Auswahl fehlgeschlagen: ' + (e.message || e) }) }
    setPicking(false)
  }
  // Neuen LEEREN Ordner anlegen + direkt als Ziel setzen. Befüllen passiert danach im Decks-Tab
  // (Buttons reinziehen oder „📥 Füllen aus OBS/DisplayFusion") — kein Preset-Sonderflow mehr beim
  // Button-Anlegen. Deck-Liste lokal nachladen, damit das Dropdown den frischen Ordner sofort zeigt.
  const refreshDeckOpts = async () => {
    try { const d = await getJSON('/api/streamdeck/registry'); setDeckOpts((d.options && d.options.decks) || []) } catch { /* noop */ }
  }
  const makeEmptyFolder = async () => {
    setPresetBusy(true); setPresetMsg(null)
    try {
      const r = await postJSON('/api/streamdeck/deck/add', { label: 'Neuer Ordner', icon: '📁', folder: true })
      if (!r || !r.id) throw new Error('Ordner nicht angelegt')
      await refreshDeckOpts(); onChange({ deck: r.id })
      setPresetMsg({ ok: true, t: 'Leerer Ordner angelegt + als Ziel gesetzt — jetzt im Decks-Tab füllen' })
    } catch (e) { setPresetMsg({ ok: false, t: 'Fehlgeschlagen: ' + (e.message || e) }) }
    setPresetBusy(false)
  }
  return (
    <div class="sd-block">
      <p class="sd-block-h">⚡ Aktion <span class="muted">— was beim Tastendruck passiert</span></p>
      <div class="reward-row">
        <span class="muted conn-label">Typ</span>
        <select class="reward-input" value={t} onChange={(e) => replace({ type: e.currentTarget.value })}>
          {(options.action_types || []).map((k) => <option value={k}>{ACTION_LABELS[k] || k}</option>)}
        </select>
      </div>
      {t === 'multi' && (() => {
        // Multi-Action: rekursiv geschachtelte ActionEditoren — jeder Schritt ist eine VOLLE normale Aktion.
        const steps = action.steps || []
        const setSteps = (next) => onChange({ steps: next })
        return (
          <>
            <p class="muted sd-help">Mehrere Aktionen auf EINEM Button — laufen schnell nacheinander (≈ gleichzeitig).
              Jeder Schritt ist eine ganz normale Aktion (jede Art, auch geschachtelt). Die Rückmeldung sammelt pro
              Schritt ✓/✗. Den <b>Status</b> setzt du unten über die Überwachung „🔀 Mehrere kombinieren" (z. B. „nur
              wenn alle aktiv").</p>
            <label class="sd-inline" style="gap:6px;font-size:12px;margin:0 0 8px">
              <input type="checkbox" checked={!!action.stop_on_error}
                     onChange={(e) => onChange({ stop_on_error: e.currentTarget.checked || undefined })} />
              Beim ersten Fehler abbrechen <span class="muted">(sonst laufen alle Schritte)</span>
            </label>
            {steps.map((step, i) => (
              <div key={i} class="sd-substep">
                <div class="sd-substep-head">
                  <span class="muted">Schritt {i + 1}</span>
                  <span style="flex:1" />
                  {i > 0 && <button class="btn ghost small" title="nach oben"
                              onClick={() => { const n = steps.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; setSteps(n) }}>↑</button>}
                  {i < steps.length - 1 && <button class="btn ghost small" title="nach unten"
                              onClick={() => { const n = steps.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; setSteps(n) }}>↓</button>}
                  <button class="btn ghost small danger" title="Schritt entfernen"
                          onClick={() => setSteps(steps.filter((_, j) => j !== i))}>✕</button>
                </div>
                <ActionEditor action={step} options={options} onPicked={onPicked}
                  onChange={(patch) => { const n = steps.slice(); n[i] = { ...step, ...patch }; setSteps(n) }}
                  replace={(full) => { const n = steps.slice(); n[i] = full; setSteps(n) }} />
              </div>
            ))}
            <button class="btn small" onClick={() => setSteps([...steps, { type: 'none' }])}>➕ Aktion hinzufügen</button>
          </>
        )
      })()}
      {t === 'events_action' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Action</span>
            <select class="reward-input" value={action.action_id || ''} onChange={(e) => onChange({ action_id: e.currentTarget.value })}>
              <option value="">— wählen —</option>
              {eaActions.map((a) => <option value={a.id}>{(a.label || a.id) + (a.enabled ? '' : ' (aus)')}</option>)}
            </select>
          </div>
          <p class="muted sd-help">Löst beim Druck genau diese Action aus dem <b>Events &amp; Actions</b>-Tab aus.</p>
        </>
      )}
      {t === 'open_deck' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Ziel-Deck</span>
            <select class="reward-input" value={action.deck || ''} onChange={(e) => onChange({ deck: e.currentTarget.value })}>
              <option value="">— wählen —</option>
              {deckOpts.map((d) => <option value={d.id}>{(d.folder ? '📁 ' : (d.icon || '🎛') + ' ') + (d.label || d.id)}</option>)}
            </select>
          </div>
          <div class="reward-row">
            <span class="muted conn-label">oder neu</span>
            <button class="btn ghost small" disabled={presetBusy} onClick={makeEmptyFolder}
                    title="Neuen leeren Ordner anlegen und hier direkt als Ziel setzen — danach im Decks-Tab füllen (Buttons reinziehen oder per Füllen-aus-OBS/DisplayFusion).">➕ Neuer leerer Ordner</button>
            {presetMsg && <span class={'msg small ' + (presetMsg.ok ? 'ok' : 'err')}>{presetMsg.t}</span>}
          </div>
          <div class="reward-row">
            <span class="muted conn-label">Öffnen als</span>
            <select class="so-delay" value={action.mode || 'replace'} onChange={(e) => onChange({ mode: e.currentTarget.value })}>
              <option value="replace">Unterseite (Vollbild + Zurück-Pfeil)</option>
              <option value="radial">Radial-Menü (Kreis um den Button)</option>
            </select>
          </div>
          <div class="reward-row">
            <span class="muted conn-label">Nach einer Aktion</span>
            <select class="so-delay"
                    value={action.close_on_action === true ? 'back' : action.close_on_action === false ? 'stay' : 'auto'}
                    onChange={(e) => { const v = e.currentTarget.value; onChange({ close_on_action: v === 'auto' ? undefined : (v === 'back') }) }}>
              <option value="auto">Standard ({(action.mode || 'replace') === 'radial' ? 'schließt sich' : 'bleibt offen'})</option>
              <option value="back">↩ direkt zurück zum Deck</option>
              <option value="stay">📌 offen bleiben (bis „‹ Zurück" / Mitte antippen)</option>
            </select>
          </div>
          <p class="muted sd-help">Macht diesen Button zu einem <b>Ordner</b>: beim Tippen öffnet sich das
            gewählte Deck — als Unterseite (mit Zurück-Pfeil) oder als Radial-Menü. Den Ordner-Inhalt füllst du
            im <b>Decks-Tab</b> (Buttons reinziehen oder „📥 Füllen aus OBS/DisplayFusion"). Das <b>Aussehen</b>
            dieses Buttons ist frei — z.B. via „🎨 Aussehen einfügen" die Health-Ampel statt des Ordner-Symbols.
            Nur im Touch-Panel; auf der Elgato-Hardware ohne Wirkung.</p>
        </>
      )}
      {t === 'process_action' && (
        <div class="reward-row">
          <span class="muted conn-label">Prozess</span>
          <select class="reward-input" value={action.process || ''} onChange={(e) => onChange({ process: e.currentTarget.value, action: undefined })}>
            <option value="">— wählen —</option>
            {options.processes.map((p) => <option value={p.key}>{p.label}</option>)}
          </select>
          <span class="muted conn-label">Aktion</span>
          <select class="reward-input" value={action.action || ''} onChange={(e) => onChange({ action: e.currentTarget.value })}>
            <option value="">— wählen —</option>
            <option value="toggle">toggle (auto start/stop)</option>
            {(proc ? proc.actions : []).map((a) => <option value={a.key}>{a.label} ({a.key})</option>)}
          </select>
        </div>
      )}
      {t === 'launch' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Datei</span>
            <input class="reward-input" placeholder="Pfad zu .exe / .py / .lnk …" value={action.path || ''}
                   onInput={(e) => onChange({ path: e.currentTarget.value })} />
            <button class="btn ghost small" disabled={picking} onClick={pickFile}>{picking ? '… wählt' : '📂 Datei wählen'}</button>
          </div>
          <div class="reward-row">
            <span class="muted conn-label">Argumente</span>
            <input class="reward-input" placeholder="optional, z.B. --fullscreen" value={action.args || ''}
                   onInput={(e) => onChange({ args: e.currentTarget.value })} />
          </div>
          {pickMsg && <p class={'sd-help ' + (pickMsg.ok ? 'msg ok' : 'msg err')}>{pickMsg.t}</p>}
          <p class="muted sd-help">Startet beim Druck das gewählte Programm/Script (eigener Prozess).
            „📂 Datei wählen" öffnet den Datei-Dialog auf dem Stream-PC und übernimmt — wenn möglich —
            gleich Icon + Name in „Aussehen → Standard".</p>
        </>
      )}
      {t === 'open_folder' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Ordner</span>
            <input class="reward-input" placeholder="z. B. C:/Spiele  ·  %USERPROFILE%/Desktop  ·  shell:Desktop"
                   value={action.path || ''} onInput={(e) => onChange({ path: e.currentTarget.value })} />
            <button class="btn ghost small" disabled={picking} onClick={pickFolder}>{picking ? '… wählt' : '📂 Ordner wählen'}</button>
          </div>
          <div class="reward-row">
            <span class="muted conn-label">Schnell</span>
            <button class="btn ghost small" onClick={() => onChange({ path: 'shell:Desktop' })}>Desktop</button>
            <button class="btn ghost small" onClick={() => onChange({ path: 'shell:Downloads' })}>Downloads</button>
            <button class="btn ghost small" onClick={() => onChange({ path: 'shell:Personal' })}>Dokumente</button>
          </div>
          {pickMsg && <p class={'sd-help ' + (pickMsg.ok ? 'msg ok' : 'msg err')}>{pickMsg.t}</p>}
          <p class="muted sd-help">Öffnet beim Druck den <b>Windows-Explorer</b> direkt in diesem Ordner
            (z. B. den Desktop, wenn die Symbole ausgeblendet sind). Erlaubt sind feste Pfade,
            <code>%ENV%</code>-Variablen (z. B. <code>%USERPROFILE%/Desktop</code>) und <code>shell:</code>-Kürzel
            (<code>shell:Desktop</code>, <code>shell:Downloads</code>). Zeigt der Pfad auf eine Datei, wird sie im
            Ordner markiert.</p>
        </>
      )}
      {t === 'displayfusion' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Profil</span>
            <select class="reward-input" value={action.profile || ''} onChange={(e) => onChange({ profile: e.currentTarget.value })}>
              <option value="">— wählen —</option>
              {dfProfiles.map((p) => <option value={p.name}>{p.name + (p.active ? '  ● aktiv' : '')}</option>)}
            </select>
          </div>
          {!dfProfiles.length && (
            <div class="reward-row">
              <span class="muted conn-label">Name</span>
              <input class="reward-input" placeholder="Profilname (DisplayFusion nicht erkannt)"
                     value={action.profile || ''} onInput={(e) => onChange({ profile: e.currentTarget.value })} />
            </div>
          )}
          <p class="muted sd-help">Lädt beim Druck dieses DisplayFusion-Monitor-Profil. Tipp:
            Überwachung „Welches DisplayFusion-Profil ist aktiv?" + „= gleich" {action.profile ? '„' + action.profile + '"' : '<Profil>'} →
            der Button leuchtet, wenn das Profil aktiv ist.</p>
        </>
      )}
      {t === 'media' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Taste</span>
            <select class="reward-input" value={action.key || ''} onChange={(e) => onChange({ key: e.currentTarget.value })}>
              <option value="">— wählen —</option>
              <option value="playpause">⏯ Play / Pause</option>
              <option value="next">⏭ Nächster Track</option>
              <option value="prev">⏮ Vorheriger Track</option>
              <option value="stop">⏹ Stop</option>
              <option value="volup">🔊 Lauter</option>
              <option value="voldown">🔉 Leiser</option>
              <option value="mute">🔇 Stumm</option>
            </select>
          </div>
          <p class="muted sd-help">Sendet die Media-Taste ans Betriebssystem — steuert den gerade aktiven
            Media-Player (Spotify, YouTube, Wave Link …).</p>
        </>
      )}
      {t === 'hotkey' && <HotkeyEditor action={action} onChange={onChange} />}
      {t === 'flag_toggle' && (
        <div class="reward-row">
          <span class="muted conn-label">Flag-Datei</span>
          <input class="reward-input" list="sd-flags" placeholder="z.B. do_not_disturb.flag"
                 value={action.flag || ''} onInput={(e) => onChange({ flag: e.currentTarget.value })} />
          <datalist id="sd-flags">{options.known_flags.map((f) => <option value={f} />)}</datalist>
        </div>
      )}
      {t === 'http' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Methode</span>
            <select class="so-delay" value={action.method || 'POST'} onChange={(e) => onChange({ method: e.currentTarget.value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option value={m}>{m}</option>)}
            </select>
            <span class="muted conn-label">URL</span>
            <input class="reward-input" placeholder="http://127.0.0.1:7883/api/…"
                   value={action.url || ''} onInput={(e) => onChange({ url: e.currentTarget.value })} />
          </div>
          <div class="reward-row">
            <span class="muted conn-label">Body (JSON, optional)</span>
            <input class="reward-input" placeholder='{"x": 1}'
                   value={action.body ? JSON.stringify(action.body) : ''}
                   onInput={(e) => {
                     const v = e.currentTarget.value.trim()
                     if (!v) { onChange({ body: undefined }); return }
                     try { onChange({ body: JSON.parse(v) }) } catch { /* erst bei gültigem JSON */ }
                   }} />
          </div>
        </>
      )}
      {t === 'manual_event' && (
        <div class="reward-row">
          <span class="muted conn-label">Event-Typ</span>
          <select class="reward-input" value={action.event_type || ''} onChange={(e) => onChange({ event_type: e.currentTarget.value })}>
            <option value="">— wählen —</option>
            {options.manual_event_types.map((m) => <option value={m}>{m}</option>)}
          </select>
        </div>
      )}
      {t === 'alert' && (
        <div class="reward-row">
          <span class="muted conn-label">Alert-Typ</span>
          <select class="reward-input" value={action.alert_type || ''} onChange={(e) => onChange({ alert_type: e.currentTarget.value })}>
            <option value="">— wählen —</option>
            {(options.alert_types || []).map((a) => <option value={a}>{a}</option>)}
          </select>
        </div>
      )}
      {t === 'obs' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">OBS-Aktion</span>
            <select class="reward-input" value={action.obs_action || 'scene'}
                    onChange={(e) => replace({ type: 'obs', obs_action: e.currentTarget.value })}>
              <option value="scene">Szene wechseln</option>
              <option value="source_toggle">Quelle ein-/ausblenden</option>
              <option value="stream">Stream starten/stoppen</option>
              <option value="record">Aufnahme starten/stoppen</option>
            </select>
          </div>
          {(action.obs_action || 'scene') === 'scene' && (
            <div class="reward-row">
              <span class="muted conn-label">Szene</span>
              <input class="reward-input" list="sd-obs-scenes" placeholder="Szenenname"
                     value={action.scene || ''} onInput={(e) => onChange({ scene: e.currentTarget.value })} />
              <datalist id="sd-obs-scenes">{obsScenes.map((s) => <option value={s} />)}</datalist>
            </div>
          )}
          {action.obs_action === 'source_toggle' && (
            <>
              <div class="reward-row">
                <span class="muted conn-label">Quelle</span>
                <input class="reward-input" list="sd-obs-sources" placeholder="z.B. Bot-Timer / Kamera / Overlay"
                       value={action.source || ''} onInput={(e) => onChange({ source: e.currentTarget.value })} />
                <datalist id="sd-obs-sources">{obsSources.map((s) => <option value={s} />)}</datalist>
              </div>
              <div class="reward-row">
                <span class="muted conn-label">Modus</span>
                <select class="so-delay" value={action.mode || 'toggle'} onChange={(e) => onChange({ mode: e.currentTarget.value })}>
                  <option value="toggle">umschalten</option><option value="show">einblenden</option><option value="hide">ausblenden</option>
                </select>
                <span class="muted conn-label">Szene (optional)</span>
                <input class="so-delay" style="width:150px" list="sd-obs-scenes" placeholder="leer = automatisch"
                       value={action.scene || ''} onInput={(e) => onChange({ scene: e.currentTarget.value })} />
              </div>
            </>
          )}
          {(action.obs_action === 'stream' || action.obs_action === 'record') && (
            <div class="reward-row">
              <span class="muted conn-label">Modus</span>
              <select class="so-delay" value={action.mode || 'toggle'} onChange={(e) => onChange({ mode: e.currentTarget.value })}>
                <option value="toggle">umschalten</option><option value="start">starten</option><option value="stop">stoppen</option>
              </select>
            </div>
          )}
        </>
      )}
      {t === 'obsbot' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Kamera</span>
            <select class="so-delay" value={action.device == null ? '' : String(action.device)}
                    onChange={(e) => onChange({ device: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })}>
              <option value="">aktive Kamera</option>
              <option value="0">Kamera 1</option>
              <option value="1">Kamera 2</option>
              <option value="2">Kamera 3</option>
              <option value="3">Kamera 4</option>
            </select>
            <span class="muted conn-label">Aktion</span>
            <select class="reward-input" value={action.obsbot_action || 'recenter'}
                    onChange={(e) => replace({ type: 'obsbot', obsbot_action: e.currentTarget.value, device: action.device })}>
              <option value="recenter">🎯 Zentrieren</option>
              <option value="wake">☀ Aufwecken</option>
              <option value="sleep">🌙 Schlafen (Privacy)</option>
              <option value="tracking">👁 Tracking an/aus</option>
              <option value="ai_mode">🤖 AI-Modus</option>
              <option value="framing">🖼 Bildausschnitt</option>
              <option value="track_speed">🏃 Tracking-Tempo</option>
              <option value="zoom">🔍 Zoom (%)</option>
              <option value="gimbal_dir">🕹 Schwenken</option>
              <option value="view">📐 Sichtfeld (FOV)</option>
              <option value="mirror">🪞 Spiegeln an/aus</option>
              <option value="preset">⭐ Preset abrufen</option>
              <option value="record">⏺ Aufnahme an/aus</option>
              <option value="snapshot">📸 Foto</option>
              <option value="select">🎚 Aktive Kamera wählen</option>
            </select>
          </div>
          {action.obsbot_action === 'zoom' && (
            <div class="reward-row">
              <span class="muted conn-label">Zoom %</span>
              <input class="so-delay" type="number" min="0" max="100" style="width:90px"
                     value={action.value ?? 50} onInput={(e) => onChange({ value: Number(e.currentTarget.value) })} />
            </div>
          )}
          {action.obsbot_action === 'gimbal_dir' && (
            <div class="reward-row">
              <span class="muted conn-label">Richtung</span>
              <select class="so-delay" value={action.direction || 'up'} onChange={(e) => onChange({ direction: e.currentTarget.value })}>
                <option value="up">hoch</option><option value="down">runter</option>
                <option value="left">links</option><option value="right">rechts</option>
              </select>
              <span class="muted conn-label">Tempo</span>
              <input class="so-delay" type="number" min="0" max="100" style="width:80px"
                     value={action.speed ?? 50} onInput={(e) => onChange({ speed: Number(e.currentTarget.value) })} />
            </div>
          )}
          {['tracking', 'mirror', 'record'].includes(action.obsbot_action) && (
            <div class="reward-row">
              <span class="muted conn-label">Modus</span>
              <select class="so-delay" value={action.mode || 'on'} onChange={(e) => onChange({ mode: e.currentTarget.value })}>
                <option value="on">an</option><option value="off">aus</option>
              </select>
            </div>
          )}
          {action.obsbot_action === 'ai_mode' && (
            <div class="reward-row">
              <span class="muted conn-label">AI-Modus</span>
              <select class="reward-input" value={action.value ?? 0} onChange={(e) => onChange({ value: Number(e.currentTarget.value) })}>
                <option value="0">Mensch – Einzel</option><option value="1">Mensch – Gruppe</option>
                <option value="2">Stimme</option><option value="3">Desk</option>
                <option value="4">Hand</option><option value="5">Whiteboard</option>
              </select>
            </div>
          )}
          {action.obsbot_action === 'framing' && (
            <div class="reward-row">
              <span class="muted conn-label">Ausschnitt</span>
              <select class="so-delay" value={action.value ?? 1} onChange={(e) => onChange({ value: Number(e.currentTarget.value) })}>
                <option value="0">Headroom</option><option value="1">Standard</option><option value="2">Motion</option>
              </select>
            </div>
          )}
          {action.obsbot_action === 'track_speed' && (
            <div class="reward-row">
              <span class="muted conn-label">Tempo</span>
              <select class="so-delay" value={action.value ?? 1} onChange={(e) => onChange({ value: Number(e.currentTarget.value) })}>
                <option value="0">langsam</option><option value="1">standard</option><option value="2">schnell</option>
              </select>
            </div>
          )}
          {action.obsbot_action === 'view' && (
            <div class="reward-row">
              <span class="muted conn-label">FOV</span>
              <select class="so-delay" value={action.value ?? 0} onChange={(e) => onChange({ value: Number(e.currentTarget.value) })}>
                <option value="0">86° (weit)</option><option value="1">78°</option><option value="2">65° (eng)</option>
              </select>
            </div>
          )}
          {(action.obsbot_action === 'preset' || action.obsbot_action === 'select') && (
            <div class="reward-row">
              <span class="muted conn-label">{action.obsbot_action === 'preset' ? 'Preset' : 'Aktiv setzen'}</span>
              <select class="so-delay" value={action.index ?? 0} onChange={(e) => onChange({ index: Number(e.currentTarget.value) })}>
                {action.obsbot_action === 'preset'
                  ? [<option value="0">Preset 1</option>, <option value="1">Preset 2</option>, <option value="2">Preset 3</option>]
                  : [<option value="0">Kamera 1</option>, <option value="1">Kamera 2</option>, <option value="2">Kamera 3</option>, <option value="3">Kamera 4</option>]}
              </select>
              {action.obsbot_action === 'preset' && <span class="muted" style="font-size:11px">⚠ Presets via UVC (noch) nicht verfügbar</span>}
            </div>
          )}
          <p class="muted sd-help"><b>⚠ OBSBOT Center darf NICHT laufen</b> (greift sonst die Kamera). Die Kamera
            muss in OBS o.ä. als Quelle aktiv sein. Steuerung läuft direkt über UVC — keine OBSBOT-Software nötig.</p>
          <ObsbotStatusHint />
        </>
      )}
      {t === 'winaudio' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Modus</span>
            <select class="reward-input"
                    value={['set_volume', 'toggle_mute'].includes(action.wa_action) ? 'volume' : 'set_default'}
                    onChange={(e) => replace(e.currentTarget.value === 'volume'
                      ? { type: 'winaudio', wa_action: 'toggle_mute' }
                      : { type: 'winaudio', wa_action: 'set_default' })}>
              <option value="set_default">Standard-Ausgabegerät umschalten</option>
              <option value="volume">🎚 Lautstärke-Regler (Fader + VU)</option>
            </select>
          </div>
          {['set_volume', 'toggle_mute'].includes(action.wa_action) ? (
            <>
              <div class="reward-row">
                <span class="muted conn-label">Gerät</span>
                <select class="reward-input" value={action.device_id || ''}
                        onChange={(e) => {
                          const id = e.currentTarget.value
                          const dev = winDevs.find((d) => d.id === id)
                          onChange({ wa_action: 'toggle_mute', device_id: id || undefined, device_name: dev ? dev.name : undefined })
                          if (onPicked) onPicked({ name: dev ? dev.name : 'Windows-Lautstärke' })
                        }}>
                  <option value="">🔊 Windows-Hauptlautstärke (Standard)</option>
                  {winDevs.map((d) => <option value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <p class="muted sd-help">Vertikaler <b>Lautstärke-Regler + Live-VU</b> (oben <b>Darstellung → 🎚 Fader</b>
                bzw. „✨ Vorlage anwenden"; Tippen = Stumm). <b>Leer</b> = die allgemeine Windows-Lautstärke (folgt dem
                Standardgerät), oder ein <b>bestimmtes</b> Ausgabegerät. Den <b>Anzeigenamen</b> setzt du oben im Feld
                „Name". <b>Mehrere</b> Fader (für mehrere Geräte): einfach mehrere Buttons anlegen — oder
                „🔊 Windows-Lautstärke-Fader" mehrmals klicken.{winDevs.length ? '' : ' (Geräteliste leer — läuft die App auf diesem PC?)'}</p>
            </>
          ) : (
            <>
              <div class="reward-row">
                <span class="muted conn-label">Gerät</span>
                <select class="reward-input" value={action.device_name || ''}
                        onChange={(e) => onChange({ wa_action: 'set_default', device_name: e.currentTarget.value, device_id: undefined })}>
                  <option value="">— wählen —</option>
                  {winDevs.map((d) => <option value={d.name}>{d.name}</option>)}
                </select>
              </div>
              {!winDevs.length && (
                <div class="reward-row">
                  <span class="muted conn-label">Gerätename</span>
                  <input class="reward-input" placeholder="Teil des Namens, z. B. ROG CETRA / Realtek USB"
                         value={action.device_name || ''}
                         onInput={(e) => onChange({ wa_action: 'set_default', device_name: e.currentTarget.value })} />
                </div>
              )}
              <p class="muted sd-help">Schaltet beim Druck das <b>Windows-Standard-Ausgabegerät</b> auf dieses Gerät
                (z. B. Kopfhörer ⟷ Lautsprecher). Erkannt über den <b>Namen</b> (robust gegen wechselnde Geräte-IDs
                beim Neu-Einstecken). Tipp: unten Überwachung „Ist dieses Gerät das Windows-Standardgerät?" mit
                demselben Gerät → der Button leuchtet grün, wenn es aktiv ist.
                {winDevs.length ? '' : ' (Geräteliste leer — läuft die App auf diesem PC? Sonst Namen oben eintippen.)'}</p>
            </>
          )}
        </>
      )}
      {t === 'app_audio' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Programm</span>
            <select class="reward-input" value={action.app_proc || ''}
                    onChange={(e) => {
                      const proc = e.currentTarget.value
                      const s = appSessions.find((x) => x.proc === proc)
                      onChange({ aa_action: 'toggle_mute', app_proc: proc || undefined })
                      if (onPicked && s) onPicked({ name: s.name })
                    }}>
              <option value="">— Programm wählen …</option>
              {appSessions.map((s) => <option value={s.proc}>{s.name}</option>)}
            </select>
          </div>
          {!appSessions.length && (
            <div class="reward-row">
              <span class="muted conn-label">Prozessname</span>
              <input class="reward-input" placeholder="z. B. spotify.exe / chrome.exe / firefox.exe"
                     value={action.app_proc || ''}
                     onInput={(e) => onChange({ aa_action: 'toggle_mute', app_proc: e.currentTarget.value })} />
            </div>
          )}
          <p class="muted sd-help">Regelt die Lautstärke <b>eines Programms</b> (App-Mixer, wie der Windows-
            Lautstärkemixer). Vertikaler <b>Fader + Live-VU</b> (oben <b>Darstellung → 🎚 Fader</b> bzw.
            „✨ Vorlage anwenden"; Tippen = Stumm). Den <b>Anzeigenamen</b> setzt du oben im Feld „Name".
            {appSessions.length ? '' : ' (Liste leer — das Programm muss gerade Ton ausgeben, sonst hat es keine Audio-Session. Sonst Prozessnamen eintippen.)'}</p>
        </>
      )}
    </div>
  )
}

function MonitorEditor({ monitor, options, onChange, replace }) {
  const t = monitor.type || 'none'
  const info = MONITOR_INFO[t]
  const [obsSources, setObsSources] = useState([])
  const [hwSensors, setHwSensors] = useState([])
  const [winDevs, setWinDevs] = useState([])
  const [pmStatus, setPmStatus] = useState(null)
  useEffect(() => {
    if (t === 'obs_source_visible') getJSON('/api/obs/scene_items').then((d) => setObsSources(d.sources || [])).catch(() => {})
    if (t === 'hwinfo') getJSON('/api/hwinfo/sensors').then((d) => setHwSensors(d.sensors || [])).catch(() => {})
    if (t === 'winaudio_default') getJSON('/api/winaudio/devices').then((d) => setWinDevs(d.devices || [])).catch(() => {})
    if (t === 'fps' || t === 'frametime') getJSON('/api/frametime/status').then(setPmStatus).catch(() => {})
  }, [t])
  return (
    <div class="sd-block">
      <p class="sd-block-h">👁 Überwachung <span class="muted">— optional: Statuslicht je nach Zustand</span></p>
      <div class="reward-row">
        <span class="muted conn-label">Typ</span>
        <select class="reward-input" value={t} onChange={(e) => replace({ type: e.currentTarget.value })}>
          {(options.monitor_types || []).map((k) => <option value={k}>{MONITOR_LABELS[k] || k}</option>)}
        </select>
      </div>
      {info && <p class="muted sd-help">{info.text}</p>}
      {t === 'aggregate' && (() => {
        // Aggregat: rekursiv geschachtelte MonitorEditoren + EINE Bedingung je Sub-Monitor + Verknüpfung.
        const subs = monitor.monitors || []
        const setSubs = (next) => onChange({ monitors: next })
        const m = monitor.match || { op: 'truthy' }
        const setMatch = (patch) => onChange({ match: { ...m, ...patch } })
        const needsVal = !['any', 'truthy', 'falsy'].includes(m.op || 'truthy')
        return (
          <>
            <div class="reward-row sd-state" style="flex-wrap:wrap">
              <span class="muted conn-label">Bedingung je Monitor</span>
              <select class="so-delay" value={m.op || 'truthy'} onChange={(e) => setMatch({ op: e.currentTarget.value })}>
                {(options.match_ops || ['any', 'truthy', 'falsy', 'eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains']).map((o) => <option value={o}>{OP_LABELS[o] || o}</option>)}
              </select>
              {needsVal && <input class="so-delay" style="width:120px" placeholder="Wert (z. B. trackon)"
                                  value={m.value != null ? m.value : ''} onInput={(e) => setMatch({ value: e.currentTarget.value })} />}
            </div>
            <div class="reward-row sd-state">
              <span class="muted conn-label">Verknüpfung</span>
              <select class="so-delay" value={monitor.mode || 'all'}
                      onChange={(e) => onChange({ mode: e.currentTarget.value === 'all' ? undefined : e.currentTarget.value })}>
                <option value="all">ALLE (UND) → an/aus</option>
                <option value="any">EINE (ODER) → an/aus</option>
                <option value="count">Anzahl der Treffer → Zahl</option>
                <option value="tally">Stufen → all / some / none</option>
              </select>
            </div>
            <p class="muted sd-help" style="margin:2px 0">Zustände unten: <b>ALLE/EINE</b> → „ist wahr/an" bzw. „ist falsch/aus" · <b>Anzahl</b> → „&gt; größer als" usw. · <b>Stufen</b> → „= gleich" mit <code>all</code>/<code>some</code>/<code>none</code>.</p>
            {subs.map((sm, i) => (
              <div key={i} class="sd-substep">
                <div class="sd-substep-head"><span class="muted">Monitor {i + 1}</span><span style="flex:1" />
                  <button class="btn ghost small danger" title="entfernen" onClick={() => setSubs(subs.filter((_, j) => j !== i))}>✕</button>
                </div>
                <MonitorEditor monitor={sm} options={options}
                  onChange={(patch) => { const n = subs.slice(); n[i] = { ...sm, ...patch }; setSubs(n) }}
                  replace={(full) => { const n = subs.slice(); n[i] = full; setSubs(n) }} />
              </div>
            ))}
            <button class="btn small" onClick={() => setSubs([...subs, { type: 'none' }])}>➕ Monitor hinzufügen</button>
          </>
        )
      })()}
      {t === 'hwinfo' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Sensor</span>
            <select class="reward-input" value={monitor.sensor || ''} onChange={(e) => onChange({ sensor: e.currentTarget.value })}>
              <option value="">— wählen —</option>
              {hwSensors.map((s) => <option value={s.key}>{s.label}{s.unit ? ' (' + s.unit + ')' : ''}{s.value != null ? ' — akt. ' + s.value : ''}</option>)}
            </select>
          </div>
          {!hwSensors.length && (
            <p class="muted sd-help">Keine HWiNFO-Sensoren gefunden. <b>Empfohlen (gratis, ohne Admin):</b> im
              HWiNFO-<b>Sensoren</b>-Fenster → <b>Einstellungen</b> → Reiter <b>HWiNFO Gadget</b> → unten
              <b>„Aktivieren der Berichterstellung im Gadget"</b> anhaken, dann bei jedem Sensor
              <b>„Wert zum Gadget melden"</b> ankreuzen. <b>Optional (Pro):</b> „Shared Memory Support".
              Danach hier neu öffnen.</p>
          )}
        </>
      )}
      {(t === 'fps' || t === 'frametime') && (
        <p class={'sd-help ' + (pmStatus && pmStatus.available ? 'msg ok' : 'msg err')}>
          {pmStatus && pmStatus.available
            ? (pmStatus.presenting ? '✓ PresentMon live — Werte fließen' : '✓ PresentMon verbunden — warte auf ein Spiel im Vordergrund')
            : '⚠ ' + ((pmStatus && pmStatus.reason) || 'PresentMon nicht gefunden — Intel PresentMon installieren')}
          {'. '}Am schönsten als <b>Darstellung → 📈 Graph</b> (oben). Quelle: PresentMon — herstellerneutral, keine Injection.
        </p>
      )}
      {t === 'process_alive' && (
        <div class="reward-row">
          <span class="muted conn-label">Prozess</span>
          <select class="reward-input" value={monitor.process || ''} onChange={(e) => onChange({ process: e.currentTarget.value })}>
            <option value="">— wählen —</option>
            {options.processes.map((p) => <option value={p.key}>{p.label}</option>)}
          </select>
        </div>
      )}
      {(t === 'bot_mode' || t === 'bot_state') && (
        <div class="reward-row">
          <span class="muted conn-label">Bot</span>
          <select class="reward-input" value={monitor.target || ''} onChange={(e) => onChange({ target: e.currentTarget.value })}>
            {options.processes.map((p) => <option value={p.key}>{p.label}</option>)}
          </select>
        </div>
      )}
      {t === 'flag' && (
        <div class="reward-row">
          <span class="muted conn-label">Flag-Datei</span>
          <input class="reward-input" list="sd-flags" placeholder="z.B. do_not_disturb.flag"
                 value={monitor.flag || ''} onInput={(e) => onChange({ flag: e.currentTarget.value })} />
        </div>
      )}
      {t === 'file_field' && (
        <div class="reward-row">
          <span class="muted conn-label">Datei (rel. zum App-Ordner)</span>
          <input class="reward-input" placeholder="z.B. status.json"
                 value={monitor.file || ''} onInput={(e) => onChange({ file: e.currentTarget.value })} />
          <span class="muted conn-label">Pfad</span>
          <input class="so-delay" style="width:120px" placeholder="is_live"
                 value={monitor.path || ''} onInput={(e) => onChange({ path: e.currentTarget.value })} />
        </div>
      )}
      {t === 'sse_field' && (
        <div class="reward-row">
          <span class="muted conn-label">SSE-Topic</span>
          <input class="reward-input" list="sd-topics" placeholder="health"
                 value={monitor.topic || ''} onInput={(e) => onChange({ topic: e.currentTarget.value })} />
          <datalist id="sd-topics">{options.sse_topics.map((s) => <option value={s} />)}</datalist>
          <span class="muted conn-label">Pfad</span>
          <input class="so-delay" style="width:120px" placeholder="level"
                 value={monitor.path || ''} onInput={(e) => onChange({ path: e.currentTarget.value })} />
        </div>
      )}
      {t === 'poll' && (
        <div class="reward-row">
          <span class="muted conn-label">URL</span>
          <input class="reward-input" placeholder="http://127.0.0.1:7883/api/health"
                 value={monitor.url || ''} onInput={(e) => onChange({ url: e.currentTarget.value })} />
          <span class="muted conn-label">Pfad</span>
          <input class="so-delay" style="width:90px" placeholder="level"
                 value={monitor.path || ''} onInput={(e) => onChange({ path: e.currentTarget.value })} />
          <span class="muted conn-label">Intervall (s)</span>
          <input class="so-delay" style="width:70px" type="number" min="2" value={monitor.interval || 10}
                 onInput={(e) => onChange({ interval: Number(e.currentTarget.value) })} />
        </div>
      )}
      {t === 'obs_source_visible' && (
        <div class="reward-row">
          <span class="muted conn-label">Quelle</span>
          <input class="reward-input" list="sd-obs-sources-mon" placeholder="z.B. Bot-Timer"
                 value={monitor.source || ''} onInput={(e) => onChange({ source: e.currentTarget.value })} />
          <datalist id="sd-obs-sources-mon">{obsSources.map((s) => <option value={s} />)}</datalist>
          <span class="muted conn-label">Szene (optional)</span>
          <input class="so-delay" style="width:140px" placeholder="leer = automatisch"
                 value={monitor.scene || ''} onInput={(e) => onChange({ scene: e.currentTarget.value })} />
        </div>
      )}
      {t === 'winaudio_default' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Gerät</span>
            <select class="reward-input" value={monitor.device_name || ''}
                    onChange={(e) => onChange({ device_name: e.currentTarget.value, device_id: undefined })}>
              <option value="">— wählen —</option>
              {winDevs.map((d) => <option value={d.name}>{d.name}</option>)}
            </select>
          </div>
          {!winDevs.length && (
            <div class="reward-row">
              <span class="muted conn-label">Gerätename</span>
              <input class="reward-input" placeholder="Teil des Namens, z. B. ROG CETRA / Realtek USB"
                     value={monitor.device_name || ''} onInput={(e) => onChange({ device_name: e.currentTarget.value })} />
            </div>
          )}
        </>
      )}
      {t === 'winaudio_volume' && (
        <p class="muted sd-help">Reglerstand (0..100) für die Fader-Kachel + {'{value}'}-Titel. Das <b>Gerät</b> wählst du
          oben bei der <b>Aktion</b> (🔊 Windows-Audio → Lautstärke-Regler) — leer = Windows-Hauptlautstärke. Darstellung
          oben als <b>🎚 Fader</b>.</p>
      )}
      {(t === 'obsbot_cam' || t === 'obsbot_track') && (
        <div class="reward-row">
          <span class="muted conn-label">Kamera</span>
          <select class="reward-input" value={monitor.device == null ? '' : String(monitor.device)}
                  onChange={(e) => onChange({ device: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })}>
            <option value="">aktive Kamera</option>
            <option value="0">Kamera 1</option>
            <option value="1">Kamera 2</option>
            <option value="2">Kamera 3</option>
            <option value="3">Kamera 4</option>
          </select>
        </div>
      )}
      {(t === 'wavelink_level' || t === 'wavelink_meter' || t === 'wavelink_mute') && (
        <p class="muted sd-help">Die Quelle (Mix/Channel) setzt du am einfachsten über den <b>🎚 Quellen-Picker</b> an der
          Fader-Kachel oder den Generator <b>„🎚 Wave-Link-Fader"</b> — beides verdrahtet Aktion + Überwachung passend.
          Am schönsten als <b>Darstellung → 🎚 Fader</b>.</p>
      )}
    </div>
  )
}

function StateRow({ st, options, knownValues, onChange, onDelete, ctx }) {
  const op = (st.when || {}).op || 'any'
  const needsValue = !['any', 'truthy', 'falsy'].includes(op)
  return (
    <div class="reward-row sd-state">
      <span class="muted sd-when">Wenn Wert</span>
      <select class="so-delay" value={op}
              onChange={(e) => onChange({ ...st, when: { ...st.when, op: e.currentTarget.value } })}>
        {(options.match_ops || []).map((o) => <option value={o}>{OP_LABELS[o] || o}</option>)}
      </select>
      {needsValue && (knownValues && knownValues.length ? (
        <select class="so-delay" style="width:110px"
                value={st.when && st.when.value != null ? st.when.value : ''}
                onChange={(e) => onChange({ ...st, when: { ...st.when, value: e.currentTarget.value } })}>
          <option value="">— Wert —</option>
          {knownValues.map((v) => <option value={v}>{v}</option>)}
        </select>
      ) : (
        <input class="so-delay" style="width:90px" placeholder="Wert"
               value={st.when && st.when.value != null ? st.when.value : ''}
               onInput={(e) => onChange({ ...st, when: { ...st.when, value: e.currentTarget.value } })} />
      ))}
      <span class="muted sd-when">zeige</span>
      <IconField value={st.icon || ''} onChange={(icon) => onChange({ ...st, icon })} ctx={ctx} />
      <TitleInput cls="so-delay" style="width:100px" placeholder="Titel" value={st.title || ''}
                  onInput={(v) => onChange({ ...st, title: v })} />
      <IconPicker value={st.image} onChange={(url) => onChange({ ...st, image: url })} />
      <ColorField value={st.color} onChange={(color) => onChange({ ...st, color: color || undefined })} />
      <Swatch vis={{ color: st.color, icon: st.icon, title: st.title, image: st.image }} />
      <button class="btn ghost small danger" onClick={onDelete}>✕</button>
    </div>
  )
}

function StatesEditor({ states, def, options, monitor, action, label, render, opts, onRender, onOpts, onStates, onDefault }) {
  const mType = (monitor || {}).type || 'none'
  const iconCtx = { label, action, monitor }   // → 🪄 Auto-Symbol-Vorschlag aus Label + Funktion
  const info = MONITOR_INFO[mType] || {}
  const knownValues = info.values || null
  const stateless = mType === 'none'
  const isWidget = render === 'text' || render === 'clock' || render === 'readout'
  const isGauge = render === 'gauge'
  const isBar = render === 'bar'
  const isViz = isGauge || isBar || render === 'graph' || render === 'stat'   // Daten-Viz: Look (Stil/Rahmen/Glow/BG) wie normale Tasten editierbar
  // Render-Wechsel: beim Sprung auf „Gauge" sinnvolle Grenzen SICHTBAR vorbefüllen (sonst leere Felder →
  // implizit 0..100, der Nutzer sieht nichts zum Anpassen). Einheit aus dem Titel-Template („{value} °C").
  // Die smarten Grenzen je Sensor setzt weiterhin der HWiNFO-Generator (_smart_classify) — hier nur der
  // manuelle Editor-Weg, bewusst ohne Klassifizier-Duplikat.
  const pickRender = (r) => {
    onRender(r)
    if ((r === 'gauge' || r === 'bar') && (opts || {}).min == null && (opts || {}).max == null) {
      const o = opts || {}
      const m = String((def || {}).title || '').match(/\{value\}\s*([°%]?[\w/]*)/)
      onOpts({ ...o, min: 0, max: 100, unit: o.unit || (m && m[1]) || undefined })
    }
    // Status-Karte: Quelle für das Auto-Emoji aus dem Monitor-Typ vorbelegen (Audio-Monitore → 🎧/🔊/…),
    // sonst „neutral" (kein geratenes Symbol). Sichtbar im Editor, vom Nutzer überschreibbar.
    if (r === 'readout' && (opts || {}).kind == null) {
      onOpts({ ...(opts || {}), kind: /wavelink|winaudio|audio|app_vol/.test(mType) ? 'audio' : 'generic' })
    }
  }
  const add = () => onStates([...(states || []), { when: { op: knownValues ? 'eq' : 'any' }, title: '', icon: '', color: '#2a2a2a' }])
  const upd = (i, st) => onStates(states.map((s, j) => (j === i ? st : s)))
  const rm = (i) => onStates(states.filter((_, j) => j !== i))
  return (
    <div class="sd-block">
      <p class="sd-block-h">🎨 Aussehen <span class="muted">— wie die Taste aussieht</span></p>
      {/* Darstellung steuert, welche Aussehen-Felder unten erscheinen (ein Ort, typgesteuert). */}
      <div class="reward-row">
        <span class="muted conn-label">Darstellung</span>
        <select class="so-delay" value={render || 'value'} onChange={(e) => pickRender(e.currentTarget.value)}>
          <option value="value">Standard (Symbol / Wert)</option>
          <option value="graph">📈 Graph (Verlaufskurve)</option>
          <option value="text">🔤 Text / Überschrift</option>
          <option value="clock">🕐 Uhr</option>
          <option value="fader">🎚 Fader (Wave Link / Windows-Lautstärke)</option>
          <option value="gauge">🎯 Gauge (Glow-Bogen)</option>
          <option value="bar">📊 Balken (Füllstand)</option>
          <option value="stat">🔢 Stat (große Glow-Zahl)</option>
          <option value="readout">🪪 Status-Karte (Rahmen + Auto-Emoji)</option>
        </select>
        <span class="muted conn-label" style="margin-left:8px">Größe</span>
        <select class="so-delay" value={(opts || {}).size || 'auto'} title="Schriftgröße von Titel/Text/Uhr — skaliert mit der Kachelbreite"
                onChange={(e) => onOpts({ ...(opts || {}), size: e.currentTarget.value === 'auto' ? undefined : e.currentTarget.value })}>
          {Object.keys(SIZE_LABELS).map((k) => <option value={k}>{SIZE_LABELS[k]}</option>)}
        </select>
        {(!render || render === 'value' || render === 'fader' || isViz || render === 'clock' || render === 'readout') && (
          <>
            <span class="muted conn-label" style="margin-left:8px">Stil</span>
            <select class="so-delay" value={(opts || {}).skin || ''}
                    title="Rahmen-/Glow-Stil dieser Kachel (leer = globaler Standard aus den Theme-Einstellungen)"
                    onChange={(e) => onOpts({ ...(opts || {}), skin: e.currentTarget.value || undefined })}>
              {TILE_SKIN_OPTS.map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
          </>
        )}
        {/* 🎨 Design-Variante: rein optisch, gilt generisch für JEDE Quelle des Typs (Graph/Gauge/Balken/Fader). */}
        {(render === 'graph' || isGauge || isBar || render === 'fader') && (
          <>
            <span class="muted conn-label" style="margin-left:8px">Design</span>
            <select class="so-delay" value={(opts || {}).variant || ''}
                    title="Design-Variante dieser Darstellung — rein optisch, funktioniert mit jeder Datenquelle"
                    onChange={(e) => onOpts({ ...(opts || {}), variant: e.currentTarget.value || undefined })}>
              {(render === 'graph' ? GRAPH_VARIANTS : isGauge ? GAUGE_VARIANTS : isBar ? BAR_VARIANTS : FADER_VARIANTS)
                .map(([v, l]) => <option value={v}>{l}</option>)}
            </select>
          </>
        )}
        {isViz && (
          <>
            <span class="muted conn-label" style="margin-left:8px">Hintergrund</span>
            <label class="muted" style="display:flex;align-items:center;gap:4px" title="Aus = folgt dem Theme (--bg); an = feste Farbe für diese Kachel">
              <input type="checkbox" checked={!(opts || {}).bg}
                     onChange={(e) => onOpts({ ...(opts || {}), bg: e.currentTarget.checked ? undefined : '#10131a' })} /> Theme</label>
            {(opts || {}).bg && <input type="color" class="sd-color" value={(opts || {}).bg}
                   onInput={(e) => onOpts({ ...(opts || {}), bg: e.currentTarget.value })} />}
          </>
        )}
      </div>
      {isWidget ? (
        <WidgetFields render={render} opts={opts} def={def} onOpts={onOpts} onDefault={onDefault} ctx={iconCtx} />
      ) : (isGauge || isBar) ? (
        <>
          <p class="muted sd-help">{isBar
            ? <>Füll-Balken: der Überwachungs-Wert füllt den Balken von <b>Min</b> bis <b>Max</b>. <b>Einheit</b> = Suffix (°C, %, …). Farbe automatisch grün→amber→rot nach Schwellwert, oder feste Farbe. <b>Richtung</b> horizontal/vertikal. Skaliert mit der Kachelgröße.</>
            : <>Radial-Gauge mit Glow-Bogen: der Überwachungs-Wert füllt den Bogen. <b>Min/Max</b> = Wertebereich, <b>Einheit</b> = Suffix (°C, %, …). Farbe automatisch grün→amber→rot nach Schwellwert, oder feste Farbe. Skaliert mit der Kachelgröße.</>}</p>
          <div class="reward-row sd-state" style="margin-top:8px;flex-wrap:wrap">
            <span class="muted conn-label">Bereich</span>
            <input class="so-delay" style="width:64px" type="number" placeholder="Min" value={(opts || {}).min ?? ''}
                   onInput={(e) => onOpts({ ...(opts || {}), min: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
            <span class="muted">…</span>
            <input class="so-delay" style="width:64px" type="number" placeholder="Max" value={(opts || {}).max ?? ''}
                   onInput={(e) => onOpts({ ...(opts || {}), max: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
            <input class="so-delay" style="width:60px" placeholder="Einheit" value={(opts || {}).unit || ''}
                   onInput={(e) => onOpts({ ...(opts || {}), unit: e.currentTarget.value || undefined })} />
            <label class="muted" style="display:flex;align-items:center;gap:4px;margin-left:6px">
              <input type="checkbox" checked={!(opts || {}).color}
                     onChange={(e) => onOpts({ ...(opts || {}), color: e.currentTarget.checked ? undefined : '#39d8ff' })} /> Schwellwert-Farbe</label>
            {(opts || {}).color && <input type="color" class="sd-color" value={(opts || {}).color}
                   onInput={(e) => onOpts({ ...(opts || {}), color: e.currentTarget.value })} />}
            <label class="muted" style="display:flex;align-items:center;gap:4px;margin-left:6px" title="Den Zahlenwert in der Kachel anzeigen (aus = nur die Grafik)">
              <input type="checkbox" checked={(opts || {}).showValue !== false}
                     onChange={(e) => onOpts({ ...(opts || {}), showValue: e.currentTarget.checked ? undefined : false })} /> Wert anzeigen</label>
            {isBar && (
              <>
                <span class="muted conn-label" style="margin-left:6px">Richtung</span>
                <select class="so-delay" value={(opts || {}).orient || 'h'}
                        onChange={(e) => onOpts({ ...(opts || {}), orient: e.currentTarget.value === 'h' ? undefined : e.currentTarget.value })}>
                  <option value="h">Horizontal</option>
                  <option value="v">Vertikal</option>
                </select>
              </>
            )}
          </div>
        </>
      ) : render === 'graph' ? (
        <>
          <p class="muted sd-help">Verlaufskurve des Überwachungs-Werts. Jedes Element einzeln: <b>Linie</b> (Farbe/Stärke), <b>Füllung</b>, <b>Punkt</b>, <b>Eckwerte</b>. Jede Farbe leer (∅) = folgt der Familien-/Tasten-Farbe und dem Theme. <b>Bereich</b> Min/Max nagelt die Skala (sonst Auto-Zoom); <b>Kritisch</b> = oberste 20 % rot.</p>
          <div class="reward-row sd-state" style="margin-top:8px;flex-wrap:wrap">
            <span class="muted conn-label">Bereich</span>
            <input class="so-delay" style="width:64px" type="number" placeholder="Min" value={(opts || {}).min ?? ''}
                   onInput={(e) => onOpts({ ...(opts || {}), min: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
            <span class="muted">…</span>
            <input class="so-delay" style="width:64px" type="number" placeholder="Max" value={(opts || {}).max ?? ''}
                   onInput={(e) => onOpts({ ...(opts || {}), max: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
            <input class="so-delay" style="width:60px" placeholder="Einheit" value={(opts || {}).unit || ''}
                   onInput={(e) => onOpts({ ...(opts || {}), unit: e.currentTarget.value || undefined })} />
            <label class="muted" style="display:flex;align-items:center;gap:4px;margin-left:6px" title="Oberste 20 % der Skala werden rot (nur bei festem Bereich). Aus z. B. bei Lüfter/Pumpe, wo hoch = gut.">
              <input type="checkbox" checked={(opts || {}).crit !== false}
                     onChange={(e) => onOpts({ ...(opts || {}), crit: e.currentTarget.checked ? undefined : false })} /> Kritisch-Zone</label>
          </div>
          <div class="reward-row sd-state" style="flex-wrap:wrap">
            <label class="muted" style="display:flex;align-items:center;gap:4px"><input type="checkbox" checked={(opts || {}).line !== false}
                   onChange={(e) => onOpts({ ...(opts || {}), line: e.currentTarget.checked ? undefined : false })} /> 📈 Linie</label>
            <ColorField value={(opts || {}).lineColor || ''} onChange={(c) => onOpts({ ...(opts || {}), lineColor: c || undefined })} />
            <span class="muted" style="font-size:11px">Stärke</span>
            <input class="so-delay" style="width:56px" type="number" step="0.5" min="0.5" max="6" placeholder="2" value={(opts || {}).lineWidth ?? ''}
                   onInput={(e) => onOpts({ ...(opts || {}), lineWidth: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value) })} />
          </div>
          <div class="reward-row sd-state" style="flex-wrap:wrap">
            <label class="muted" style="display:flex;align-items:center;gap:4px"><input type="checkbox" checked={(opts || {}).fill !== false}
                   onChange={(e) => onOpts({ ...(opts || {}), fill: e.currentTarget.checked ? undefined : false })} /> 🌊 Füllung</label>
            <ColorField value={(opts || {}).fillColor || ''} onChange={(c) => onOpts({ ...(opts || {}), fillColor: c || undefined })} />
            <label class="muted" style="display:flex;align-items:center;gap:4px;margin-left:8px"><input type="checkbox" checked={(opts || {}).dot !== false}
                   onChange={(e) => onOpts({ ...(opts || {}), dot: e.currentTarget.checked ? undefined : false })} /> 🔘 Punkt</label>
            <ColorField value={(opts || {}).dotColor || ''} onChange={(c) => onOpts({ ...(opts || {}), dotColor: c || undefined })} />
            <label class="muted" style="display:flex;align-items:center;gap:4px;margin-left:8px" title="Min/Max-Werte in den Ecken"><input type="checkbox" checked={(opts || {}).labels !== false}
                   onChange={(e) => onOpts({ ...(opts || {}), labels: e.currentTarget.checked ? undefined : false })} /> 🔢 Eckwerte</label>
          </div>
          <div class="reward-row sd-state" style="margin-top:8px">
            <span class="muted conn-label" title="Symbol/Titel/Basis-Farbe — Titel mit {value} zeigt die Zahl; das physische Stream Deck nutzt diese Farbe.">Standard</span>
            <IconField value={def.icon || ''} onChange={(icon) => onDefault({ icon })} ctx={iconCtx} />
            <TitleInput cls="so-delay" style="width:100px" placeholder="Titel" value={def.title || ''} onInput={(v) => onDefault({ title: v })} />
            <ColorField value={def.color} onChange={(color) => onDefault({ color: color || undefined })} />
          </div>
        </>
      ) : (
        <>
          <p class="muted sd-help">
            {render === 'fader'
              ? 'Vertikaler Fader: ziehen = Level, tippen = Mute, mit Live-VU-Säule. Die Quelle wählst/änderst du oben unter „🎚 Eingabequelle" (Wave-Link Mix/Channel oder Windows-Lautstärke) — auch zum Umhängen, falls Windows ein Gerät neu zuordnet.'
              : render === 'graph'
              ? 'Der Graph zeichnet den Verlauf des Überwachungs-Werts; die „Farbe" unten ist die Linienfarbe. Titel „{value}" zeigt zusätzlich die Zahl.'
              : render === 'stat'
              ? 'Stat: der Überwachungs-Wert als große Gold-Glow-Zahl (kein Symbol), Sensorname als Label drunter. Titel „{value} °C" formatiert Zahl + Einheit.'
              : stateless
                ? 'Diese Taste hat keinen Status (Überwachung = „Keine") → es zählt nur das „Standard"-Aussehen unten.'
                : 'Pro Status eine Regel: „Wenn Wert … dann zeige …". Erster Treffer gewinnt; sonst „Standard".'}
          </p>
          {render === 'fader' && (
            <>
              <div class="reward-row sd-state" style="margin:2px 0 4px">
                <span class="muted conn-label">🎚 Slider-Farbe</span>
                <ColorField value={def.color} onChange={(color) => onDefault({ color: color || undefined })} />
                <span class="muted conn-label" style="margin-left:10px">🎨 Hintergrund</span>
                <ColorField value={(opts || {}).bg || ''} onChange={(c) => onOpts({ ...(opts || {}), bg: c || undefined })} />
              </div>
              <div class="reward-row sd-state" style="margin:0 0 6px">
                <span class="muted conn-label">📊 VU</span>
                <span class="muted" style="font-size:11px">unten</span>
                <ColorField value={(opts || {}).vuLow || ''} onChange={(c) => onOpts({ ...(opts || {}), vuLow: c || undefined })} />
                <span class="muted" style="font-size:11px">Mitte</span>
                <ColorField value={(opts || {}).vuMid || ''} onChange={(c) => onOpts({ ...(opts || {}), vuMid: c || undefined })} />
                <span class="muted" style="font-size:11px">oben</span>
                <ColorField value={(opts || {}).vuHigh || ''} onChange={(c) => onOpts({ ...(opts || {}), vuHigh: c || undefined })} />
              </div>
              <p class="muted sd-help" style="margin:0 0 6px">Jede Fader-Farbe einzeln: <b>Slider</b>, <b>Hintergrund</b>, <b>Rahmen</b> (= Slider-Farbe + „Stil" oben) und die 3 <b>VU-Zonen</b>. Leer (∅) = folgt dem Theme. <b>Design</b> (oben) = Grundform des Faders.</p>
              <div class="reward-row sd-state" style="margin:0 0 6px;flex-wrap:wrap">
                <span class="muted conn-label">📊 VU-Meter</span>
                <select class="so-delay" value={(opts || {}).vu || ''} title="VU-Meter-Stil (Lämpchen, durchgehender Balken, Pegel-Linie, Punkte oder ganz aus)"
                        onChange={(e) => onOpts({ ...(opts || {}), vu: e.currentTarget.value || undefined })}>
                  {VU_VARIANTS.map(([v, l]) => <option value={v}>{l}</option>)}
                </select>
              </div>
              <div class="reward-row sd-state" style="margin:0 0 6px;flex-wrap:wrap">
                <span class="muted conn-label">🔣 Symbol</span>
                <select class="so-delay" value={(opts || {}).iconSrc || 'auto'} title="Welches Symbol der Fader zeigt"
                        onChange={(e) => onOpts({ ...(opts || {}), iconSrc: e.currentTarget.value === 'auto' ? undefined : e.currentTarget.value })}>
                  <option value="auto">Auto (Channel = Wave-Link-Icon · Mix = Glyph)</option>
                  <option value="wl">🎚 Wave-Link-Icon (Original)</option>
                  <option value="glyph">🪄 Auto-Symbol (einheitlich aus Bibliothek)</option>
                </select>
                <label class="sd-inline" style="gap:4px;font-size:12px;margin-left:8px" title="Langen Namen auf zwei Zeilen umbrechen statt abschneiden">
                  <input type="checkbox" checked={(opts || {}).nameLines === 2} onChange={(e) => onOpts({ ...(opts || {}), nameLines: e.currentTarget.checked ? 2 : undefined })} /> Name zweizeilig</label>
              </div>
              <div class="reward-row sd-state" style="margin:0 0 6px;flex-wrap:wrap">
                <span class="muted conn-label">📏 Größe</span>
                {[['Name', 'nameK'], ['Wert', 'valK'], ['Symbol', 'iconK']].map(([lbl, key]) => (
                  <label key={key} class="sd-inline" style="gap:5px;font-size:11px" title={lbl + '-Größe (× Standard). Klick auf den Wert = zurück auf Auto.'}>
                    {lbl}
                    <input type="range" min="0.5" max="2.5" step="0.1" style="width:78px" value={(opts || {})[key] || 1}
                           onInput={(e) => { const n = +e.currentTarget.value; onOpts({ ...(opts || {}), [key]: Math.abs(n - 1) < 0.05 ? undefined : n }) }} />
                    <span class="sd-lay-v" style="cursor:pointer;min-width:30px" title="zurücksetzen"
                          onClick={() => onOpts({ ...(opts || {}), [key]: undefined })}>{((opts || {})[key] || 1).toFixed(1)}×</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {!stateless && (states || []).map((st, i) => (
            <StateRow key={i} st={st} options={options} knownValues={knownValues} ctx={iconCtx}
                      onChange={(s) => upd(i, s)} onDelete={() => rm(i)} />
          ))}
          {!stateless && <button class="btn ghost small" onClick={add}>➕ Status-Regel</button>}
          <div class="reward-row sd-state" style="margin-top:8px">
            <span class="muted conn-label">Standard</span>
            <IconField value={def.icon || ''} onChange={(icon) => onDefault({ icon })} ctx={iconCtx} />
            <TitleInput cls="so-delay" style="width:100px" placeholder="Titel" value={def.title || ''}
                        onInput={(v) => onDefault({ title: v })} />
            <IconPicker value={def.image} onChange={(url) => onDefault({ image: url })} />
            <ColorField value={def.color} onChange={(color) => onDefault({ color: color || undefined })} />
            {/* Swatch spiegelt den Idle-Fallback: leerer Default eines Status-Buttons → Inaktivitätsfarbe (wie im Panel). */}
            <Swatch vis={{ color: def.color || ((states && states.length) ? 'off' : undefined), icon: def.icon, title: def.title, image: def.image }} />
          </div>
        </>
      )}
    </div>
  )
}
