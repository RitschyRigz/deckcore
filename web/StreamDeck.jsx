import { useState, useEffect, useRef } from 'preact/hooks'
import { getJSON, postJSON, delJSON } from './api.js'
import { resolveStyle, keyClass, groupDeckItems, UNCAT, DECK_LAYOUT_DEF } from './deckstyle.js'
import { Clock, Gauge, Readout, FONT_LABELS, SIZE_LABELS, fontStack, widgetFontSize } from './widgets.jsx'
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
  events_action: '⭐ Action auslösen (aus Events & Actions)',
  process_action: '🟢 Prozess-Aktion (start/stop/toggle/mute)',
  launch: '🚀 Programm/Script starten (beliebige .exe/.py/.lnk …)',
  open_folder: '📂 Ordner im Explorer öffnen (beliebiger Pfad)',
  open_deck: '📁 Ordner öffnen (Sub-Deck / Radial-Menü)',
  displayfusion: '🖥 DisplayFusion — Monitor-Profil laden',
  media: '⏯ Media-Taste (Play/Pause · ⏭⏮ · Lauter/Leiser · Mute)',
  hotkey: '⌨ Tastenkürzel / Makro senden',
  manual_event: '🎯 Manual-Event (Tod/Boss/Win …)',
  alert: '🔔 Test-Alert abspielen (follow/sub/raid …)',
  obs: '🎬 OBS (Szene wechseln / Quelle ein-aus / Stream / Aufnahme)',
  obsbot: '📷 OBSBOT-Kamera (Tiny/Meet — Gimbal/Zoom/Tracking/Preset/Wake)',
  wavelink: '🎚 Wave Link (Mix/Channel: Mute / Level / Main-Output)',
  winaudio: '🔊 Windows-Standardgerät setzen (Ausgabe umschalten)',
  app_audio: '🎵 App-Lautstärke (pro Programm: Spotify · Spiel · Discord …)',
  flag_toggle: '🚩 Flag umschalten (Fortgeschritten)',
  flag_set: '📌 Flag setzen (Fortgeschritten)',
  http: '🌐 HTTP-Aufruf (Fortgeschritten)',
  none: '— Keine (reiner Anzeige-Button)',
}
const MONITOR_LABELS = {
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
  displayfusion_profile: 'Welches DisplayFusion-Profil ist aktiv? (Profilname)',
  winaudio_default: 'Ist dieses Gerät das Windows-Standard-Ausgabegerät? (an/aus)',
  winaudio_volume: 'Windows-Lautstärke (0..100) — Master-Regler + VU',
  app_volume: 'App-Lautstärke (0..100) — pro Programm, Fader + VU',
}
const MONITOR_INFO = {
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
  displayfusion_profile: { text: 'Liefert den Namen des zuletzt geladenen DisplayFusion-Profils. Nutze „= gleich" + Profilname → der Button leuchtet, wenn SEIN Profil aktiv ist.', values: null, bool: false },
  winaudio_default: { text: 'Liefert AN, wenn das gewählte Gerät gerade das Windows-Standard-Ausgabegerät ist. Nutze „ist wahr/an" (z. B. grün, wenn aktiv) und „ist falsch/aus".', values: null, bool: true },
  winaudio_volume: { text: 'Liefert die Windows-Master-Lautstärke (0..100) des Standard-Ausgabegeräts. Am schönsten als „Darstellung → 🎚 Fader" (Schieber + Live-VU). {value} im Titel = aktuelle Lautstärke.', values: null, bool: false },
  app_volume: { text: 'Liefert die Lautstärke (0..100) EINES Programms (App-Mixer, wie der Windows-Lautstärkemixer). Das Programm wählst du an der Aktion „🎵 App-Lautstärke". Am schönsten als „Darstellung → 🎚 Fader" (Schieber + Live-VU). {value} im Titel = aktuelle Lautstärke.', values: null, bool: false },
  wavelink_main_output: { text: 'Zeigt den aktiven Wave-Link-Monitor-Hauptausgang. Einfach „{value}" in den Titel setzen → der Button zeigt live den GERÄTE-NAMEN (keine Status-Regel, kein Gerät-Wählen nötig). Tipp: Darstellung „🪪 Status-Karte" → Rahmen + Glow + automatisch passendes Emoji je Quelle (🎧 Kopfhörer · 🔊 Boxen · 📺 HDMI/TV).', values: null, bool: false },
}
const OP_LABELS = {
  any: 'immer (egal welcher Wert)', truthy: 'ist wahr/an', falsy: 'ist falsch/aus',
  eq: '= ist gleich', ne: '≠ ist ungleich', gt: '> größer als', lt: '< kleiner als',
  gte: '≥ größer/gleich', lte: '≤ kleiner/gleich', contains: 'enthält Text',
}
const L_DEF = DECK_LAYOUT_DEF

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

// ── Live-Vorschau einer Taste (physischer Look) ──────────────────────────────
function Swatch({ vis }) {
  const v = vis || { color: '#222', icon: '', title: '…' }
  if (v.image) {
    return (
      <div class="sd-key" style={`background:${v.color};padding:0;overflow:hidden`}>
        <img src={v.image} alt="" style="width:100%;height:100%;object-fit:cover;display:block" />
      </div>
    )
  }
  return (
    <div class="sd-key" style={`background:${v.color}`}>
      {v.icon && <span class="sd-key-icon">{v.icon}</span>}
      <span class="sd-key-title">{v.title}</span>
    </div>
  )
}

// Live-Kachel im WYSIWYG-Raster (Stil = item.style über Deck-Layout). render-bewusst: Uhr/Text werden
// auch in der Editor-Vorschau LIVE gerendert (wie im Panel), sonst das normale Symbol/Titel-Bild.
function LiveKey({ v, eff, base, render, opts }) {
  v = v || {}
  const o = opts || {}
  if (render === 'clock') {
    return <div class={keyClass(eff, base) + ' t-widget is-clock'} style="background:transparent"><Clock opts={o} /></div>
  }
  if (render === 'text') {
    return (
      <div class={keyClass(eff, base) + ' t-widget'} style="background:transparent">
        <span class="t-label-text" style={`font-family:${fontStack(o.font)};color:${o.color || 'var(--fg)'};font-size:${widgetFontSize(o, 'text')}`}>{v.title || v.label || 'Text'}</span>
      </div>
    )
  }
  if (render === 'readout') {
    return <div class={keyClass(eff, base) + ' t-widget is-readout cqsize'} style="background:transparent"><Readout v={v} opts={o} /></div>
  }
  if (render === 'gauge') {
    return <div class={keyClass(eff, base) + ' is-gauge cqsize'} style="background:var(--bg)"><Gauge value={v.value} opts={o} /></div>
  }
  if (render === 'stat') {
    return <div class={keyClass(eff, base) + ' is-stat cqsize'} style="background:var(--bg)"><span class="t-stat-v">{v.title || (v.value != null ? String(v.value) : '—')}</span></div>
  }
  const isFlat = !v.image && render !== 'graph' && render !== 'fader' && render !== 'gauge' && render !== 'stat'   // dunkle Flat-Kachel + Akzent-Glow (wie Panel)
  return (
    <div class={keyClass(eff, base) + (v.image ? ' has-img' : '') + (isFlat ? ' t-flat' : '')}
         style={isFlat ? `--acc:${v.color || '#222'}` : ('background:' + (v.color || '#222'))}>
      {v.image ? <img class="sd-prev-img" src={v.image} alt="" />
        : <span class="sd-prev-icon">{v.icon || '•'}</span>}
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
    if (!confirm('Backup einspielen? Die aktuelle Config wird überschrieben (vorher automatisch gesichert).')) return
    setBusy(true); setMsg(null)
    try {
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/streamdeck/import', { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.text()) || r.status)
      const d = await r.json()
      setMsg(`✅ ${d.buttons} Buttons · ${d.decks} Decks · ${d.icons || 0} Icons zurückgespielt`)
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
        <Toggle k="frame">Rahmen/Box</Toggle>
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
      <span class="muted" style="font-size:12px">Stil von <b>{item.button}</b> auf diesem Deck:</span>
      <div class="sd-lay-ctl">
        <Sel k="frame" label="Rahmen" opts={[['inherit', 'Standard'], ['on', 'mit Rahmen'], ['off', 'nur Symbol']]} />
        <Sel k="label" label="Name" opts={[['inherit', 'Standard'], ['on', 'an'], ['off', 'aus']]} />
        <Sel k="label_pos" label="Name-Position" opts={[['inherit', 'Standard'], ['bottom', 'unten'], ['top', 'oben']]} />
        <Sel k="title" label="Titel" opts={[['inherit', 'Standard'], ['on', 'an'], ['off', 'aus']]} />
        <Sel k="title_pos" label="Titel-Position" opts={[['inherit', 'unten'], ['bottom', 'unten'], ['top', 'oben']]} />
      </div>
      <div class="sd-lay-ctl" style="margin-top:8px">
        <Span k="w" label="Breite (Spalten)" max={6} />
        <Span k="h" label="Höhe (Reihen)" max={6} />
      </div>
      <p class="muted sd-help" style="margin:6px 0 0">⚠ Größe gilt <b>nur im Touch-Panel</b> (z. B. breite Graph-/Sensor-Kachel). Auf einem echten Stream Deck bleibt der Button immer <b>1×1</b> (Icon + Wert) — die Größe wird dort ignoriert.</p>
      <p class="muted sd-help" style="margin:6px 0 0">Der „Titel" ist der große Text (aus „Aussehen → Standard/Status"); er liegt bei Bild-Buttons als Overlay oben oder unten drauf — wie im Stream Deck.</p>
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
              {folders.map((f) => <option value={f.id}>{(f.icon || '📁') + ' ' + (f.label || f.id)}</option>)}
            </select>
          )}
          <button class="btn ghost small" onClick={onClose}>✕ schließen</button>
        </span>
      </div>
      {btn
        ? <FunctionEditor key={item.button} button={btn} options={options} onSaved={onReload} />
        : <p class="muted sd-help">Diese Funktion liegt nicht (mehr) in der Button-Bibliothek.</p>}
      <h4 class="section-h sd-inspect-sub">📐 Platzierung auf diesem Deck</h4>
      <ItemInspector deck={deck} item={item} onReload={onReload} />
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
                <span class="sd-poolcat-name">{cat === POOL_UNCAT ? 'Ohne Kategorie' : cat}</span>
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
                  <LiveKey v={resolved[it.button]} eff={resolveStyle(it.style, layout)} base="sd-prev-key"
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
                          <LiveKey v={resolved[it.button]} eff={eff} base="sd-prev-key"
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

function PoolList({ buttons, resolved, options, onReload }) {
  // Eigene Buttons EINE flache Liste („Custom Buttons") — KEINE eigenen Pool-Kategorien mehr
  // (2026-06-21). Generierte Buttons ordnet das System über ihre Integration; eigene landen hier.
  const [adding, setAdding] = useState(false)
  return (
    <div>
      <div class="conn-toolbar">
        <button class="btn ghost small" onClick={() => setAdding(true)}>➕ Neuer Button</button>
      </div>
      <div class="conn-toolbar" style="margin-top:-8px">
        <span class="muted">{buttons.length} eigene Buttons. Zum Bearbeiten aufklappen, Platzierung aufs Deck per Drag&amp;Drop im <b>Decks &amp; Layout</b>-Tab. Generierte Buttons (OBS · Wave Link · HWiNFO · …) ordnet das System in ihren eigenen <b>Kategorien</b> — eigene Kategorien gibt es bewusst nicht mehr.</span>
      </div>
      {adding && (
        <FunctionEditor button={blankButton()} options={options} isNew
          onSaved={() => { setAdding(false); onReload && onReload() }} onCancel={() => setAdding(false)} />
      )}
      <div class="sd-poolcat">
        <div class="sd-poolcat-h">
          <span class="sd-poolcat-name">{CUSTOM_CAT}</span>
          <span class="muted" style="font-size:11px">({buttons.length})</span>
        </div>
        {buttons.length === 0
          ? <div class="sd-wys-empty">— noch keine eigenen Buttons — „➕ Neuer Button" —</div>
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
function WidgetFields({ render, opts, def, onOpts, onDefault }) {
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
          <input class="so-delay" style="width:54px" placeholder="auto" value={(def || {}).icon || ''}
                 title="Eigenes Emoji — leer = automatisch je Quelle (🎧 Kopfhörer · 🔊 Boxen · 📺 HDMI/TV · 🎙️ Mikro …)"
                 onInput={(e) => onDefault({ icon: e.currentTarget.value })} />
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
      <label>{isReadout ? 'Akzent' : 'Farbe'}
        <input type="color" class="so-delay" style="width:46px;height:30px;padding:2px"
               value={o.color || (isClock || isReadout ? '#8ec5ff' : '#ffffff')} onChange={(e) => setO({ color: e.currentTarget.value })} />
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
  const [b, setB] = useState(() => JSON.parse(JSON.stringify(button)))
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
            onToggle={() => toggle(current)} onReload={onReload}
            buttons={buttons} poolCategories={poolCategories} resolved={resolved} options={options} />
        : <p class="hint" style="margin-top:12px">↑ Wähle oben eine Kategorie, um Voraussetzungen zu prüfen + Buttons zu generieren.</p>}
    </div>
  )
}

// Panel der gewählten Integration: Status + An/Aus + live ausgelesene Elemente zum Ankreuzen + Generieren.
// Steuerung des interaktiven Audio-Mixer-Decks (nur in der „🔊 Windows Audio"-Kategorie): Toggle legt
// ein Live-Deck an/entfernt es; darunter eine Ausblend-Liste (abwählen = Programm dauerhaft aus dem
// Mixer nehmen). Das Deck selbst rendert das Panel live (deck.auto==='audio_mixer').
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

function IntegrationPanel({ it, status, busy, onToggle, onReload, buttons, poolCategories, resolved, options }) {
  const [el, setEl] = useState(null)
  const [checked, setChecked] = useState({})   // {groupKey: {id:bool}}
  const [toggles, setToggles] = useState({})
  const [opts, setOpts] = useState({})
  const [renders, setRenders] = useState({})   // {item_id: render} — pro Item wählbare Darstellung (z.B. HWiNFO)
  const [obsOpen, setObsOpen] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    setEl(null); setMsg(null); setObsOpen(false)
    if (it.custom || !it.enabled) return
    getJSON('/api/integrations/' + it.id + '/elements').then((d) => {
      setEl(d)
      const c = {}; (d.groups || []).forEach((g) => { c[g.key] = {}; g.items.forEach((x) => { c[g.key][x.id] = ('present' in x) ? !!x.present : true }) })
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
  const st = status && status.state !== 'unknown' ? status : null
  if (it.custom) return (
    <div class="sd-int-panel">
      <div class="sd-int-phead">
        <span class="sd-int-title">{it.emoji} {it.label}</span>
        <span style="flex:1" />
        <span class="sd-int-status na" title="Grundfunktion — immer verfügbar">immer aktiv</span>
      </div>
      <div class="sd-int-desc">{it.description}</div>
      <PoolList buttons={(buttons || []).filter((b) => !b.owner)} poolCategories={poolCategories || []}
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
      {!it.enabled && <p class="hint" style="margin:10px 0 0">Kategorie ist aus — aktiviere sie (Knopf oben rechts), um Buttons zu generieren.</p>}
      {it.id === 'audio' && <AudioMixerControl onReload={onReload} />}
      {it.enabled && el === null && <p class="muted" style="margin-top:10px">Lese verfügbare Elemente…</p>}
      {it.enabled && el && !el.available && <p class="sd-int-status off" style="margin-top:10px">🔴 {el.reason}</p>}
      {it.enabled && el && el.available && (
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
              <span class="muted" style="font-size:12px">{op.label}:</span>
              {op.choices
                ? <select class="sd-pool-cat" value={opts[op.key]} onChange={(e) => setOpts((o) => ({ ...o, [op.key]: e.currentTarget.value }))}>
                    {op.choices.map((ch) => <option value={ch[0]}>{ch[1]}</option>)}</select>
                : <input class="sd-int-num" type="number" min="1" max="4" value={opts[op.key]} onInput={(e) => setOpts((o) => ({ ...o, [op.key]: Number(e.currentTarget.value) || op.default }))} />}
            </div>
          ))}
          <div class="sd-int-gen" style="margin-top:14px;border-top:0.5px solid var(--line);padding-top:12px">
            <button class="btn small" disabled={genBusy} onClick={gen}>{genBusy ? '… wende an' : `✨ Anwenden (${totalSel()})`}</button>
            <span class="muted" style="font-size:12px">angehakt = anlegen · abgehakt = entfernen</span>
            {msg && <span class={'msg small ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</span>}
          </div>
        </>
      )}
      {it.id === 'obs' && it.enabled && (
        <div style="margin-top:12px">
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

  useEffect(() => {
    const es = new EventSource('/api/streamdeck/stream')
    esRef.current = es
    es.addEventListener('streamdeck:buttons', (ev) => {
      try { setResolved(JSON.parse(ev.data).buttons || {}) } catch { /* noop */ }
    })
    es.onerror = () => { /* Browser reconnectet selbst */ }
    return () => es.close()
  }, [])

  if (err) return <p class="fatal">Stream-Deck-Registry nicht erreichbar: {err}</p>
  if (!data) return <p class="muted">Lade Stream-Deck…</p>

  const decks = data.decks || []
  const deck = decks.find((d) => d.id === activeDeck) || decks[0]
  const options = normOptions(data.options)

  return (
    <div>
      <p class="hint">
        <b>Buttons &amp; Kategorien</b> = alle Buttons (Funktion + ID), einmal definiert — von Hand oder über
        die Kategorien angekreuzt. <b>Decks &amp; Layout</b> = unabhängige Tablet-Ansichten mit je eigenem
        Raster/Größe/Kategorien; Buttons ziehst du dort <b>ins Raster</b> und klickst sie zum Bearbeiten an.
        Derselbe Button darf auf mehreren Decks liegen. Das Elgato-Plugin nutzt nur die Button-Definitionen. Live-Vorschau = jetzt.
      </p>

      <RefreshRate reg={data} onSaved={load} />

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
            <div class="card" style="max-width:1100px">
              <h3 class="section-h" style="margin-top:0">{deck.icon || '🎛'} {deck.label} <span class="muted" style="font-weight:400;font-size:13px">— {deck.auto === 'audio_mixer' ? 'Interaktiv (Live-Audio)' : 'Layout & Buttons'}</span></h3>
              <DeckLayout deck={deck} onReload={load} />
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
      {t === 'hotkey' && (
        <>
          <div class="reward-row">
            <span class="muted conn-label">Tasten</span>
            <input class="reward-input" placeholder="z.B. ctrl+shift+m  ·  alt+f4  ·  f9"
                   value={action.keys || ''} onInput={(e) => onChange({ keys: e.currentTarget.value })} />
          </div>
          <p class="muted sd-help">Sendet diese Tastenkombination ans gerade fokussierte Fenster.
            Mit „+" verbinden. Modifier: ctrl · alt · shift · win. Tasten: a–z, 0–9, f1–f24, enter,
            esc, space, tab, up/down/left/right …</p>
        </>
      )}
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
              {action.obsbot_action === 'preset' && <span class="muted" style="font-size:11px">Presets in OBSBOT Center anlegen</span>}
            </div>
          )}
          <p class="muted sd-help">OBSBOT-App muss laufen + <b>OSC aktiv</b> (UDP, Port 16284). Bei zwei
            baugleichen Kameras in OBSBOT die <b>Positions-Sperre</b> setzen, damit „Kamera 1" stabil bleibt.</p>
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
            <p class="muted sd-help">Keine HWiNFO-Sensoren gefunden. In <b>HWiNFO</b> eine Quelle aktivieren:
              entweder <b>„Shared Memory Support"</b> (alle Sensoren — die App muss dann ggf. als Admin laufen)
              ODER <b>regelmäßig in die Registry schreiben</b> (Gadget, ohne Admin) und die gewünschten Sensoren
              markieren. Danach hier neu öffnen.</p>
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
    </div>
  )
}

function StateRow({ st, options, knownValues, onChange, onDelete }) {
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
      <input class="so-delay" style="width:44px" placeholder="Icon" value={st.icon || ''}
             onInput={(e) => onChange({ ...st, icon: e.currentTarget.value })} />
      <TitleInput cls="so-delay" style="width:100px" placeholder="Titel" value={st.title || ''}
                  onInput={(v) => onChange({ ...st, title: v })} />
      <IconPicker value={st.image} onChange={(url) => onChange({ ...st, image: url })} />
      <input type="color" class="sd-color" value={st.color || '#2a2a2a'}
             onInput={(e) => onChange({ ...st, color: e.currentTarget.value })} />
      <Swatch vis={{ color: st.color, icon: st.icon, title: st.title, image: st.image }} />
      <button class="btn ghost small danger" onClick={onDelete}>✕</button>
    </div>
  )
}

function StatesEditor({ states, def, options, monitor, render, opts, onRender, onOpts, onStates, onDefault }) {
  const mType = (monitor || {}).type || 'none'
  const info = MONITOR_INFO[mType] || {}
  const knownValues = info.values || null
  const stateless = mType === 'none'
  const isWidget = render === 'text' || render === 'clock' || render === 'readout'
  const isGauge = render === 'gauge'
  // Render-Wechsel: beim Sprung auf „Gauge" sinnvolle Grenzen SICHTBAR vorbefüllen (sonst leere Felder →
  // implizit 0..100, der Nutzer sieht nichts zum Anpassen). Einheit aus dem Titel-Template („{value} °C").
  // Die smarten Grenzen je Sensor setzt weiterhin der HWiNFO-Generator (_smart_classify) — hier nur der
  // manuelle Editor-Weg, bewusst ohne Klassifizier-Duplikat.
  const pickRender = (r) => {
    onRender(r)
    if (r === 'gauge' && (opts || {}).min == null && (opts || {}).max == null) {
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
          <option value="stat">🔢 Stat (große Glow-Zahl)</option>
          <option value="readout">🪪 Status-Karte (Rahmen + Auto-Emoji)</option>
        </select>
        <span class="muted conn-label" style="margin-left:8px">Größe</span>
        <select class="so-delay" value={(opts || {}).size || 'auto'} title="Schriftgröße von Titel/Text/Uhr — skaliert mit der Kachelbreite"
                onChange={(e) => onOpts({ ...(opts || {}), size: e.currentTarget.value === 'auto' ? undefined : e.currentTarget.value })}>
          {Object.keys(SIZE_LABELS).map((k) => <option value={k}>{SIZE_LABELS[k]}</option>)}
        </select>
      </div>
      {isWidget ? (
        <WidgetFields render={render} opts={opts} def={def} onOpts={onOpts} onDefault={onDefault} />
      ) : isGauge ? (
        <>
          <p class="muted sd-help">Radial-Gauge mit Glow-Bogen: der Überwachungs-Wert füllt den Bogen. <b>Min/Max</b> = Wertebereich, <b>Einheit</b> = Suffix (°C, %, …). Farbe automatisch grün→amber→rot nach Schwellwert, oder feste Farbe. Skaliert mit der Kachelgröße.</p>
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
          {!stateless && (states || []).map((st, i) => (
            <StateRow key={i} st={st} options={options} knownValues={knownValues}
                      onChange={(s) => upd(i, s)} onDelete={() => rm(i)} />
          ))}
          {!stateless && <button class="btn ghost small" onClick={add}>➕ Status-Regel</button>}
          <div class="reward-row sd-state" style="margin-top:8px">
            <span class="muted conn-label">Standard</span>
            <input class="so-delay" style="width:44px" placeholder="Icon" value={def.icon || ''}
                   onInput={(e) => onDefault({ icon: e.currentTarget.value })} />
            <TitleInput cls="so-delay" style="width:100px" placeholder="Titel" value={def.title || ''}
                        onInput={(v) => onDefault({ title: v })} />
            <IconPicker value={def.image} onChange={(url) => onDefault({ image: url })} />
            <input type="color" class="sd-color" value={def.color || '#2a2a2a'}
                   onInput={(e) => onDefault({ color: e.currentTarget.value })} />
            <Swatch vis={{ color: def.color, icon: def.icon, title: def.title, image: def.image }} />
          </div>
        </>
      )}
    </div>
  )
}
