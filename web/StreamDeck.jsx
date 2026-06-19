import { useState, useEffect, useRef } from 'preact/hooks'
import { getJSON, postJSON, delJSON } from './api.js'
import { resolveStyle, keyClass, groupDeckItems, UNCAT, DECK_LAYOUT_DEF } from './deckstyle.js'
import { Clock, FONT_LABELS, SIZE_LABELS, fontStack, widgetFontSize } from './widgets.jsx'
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
  wavelink: '🎚 Wave Link (Mix/Channel: Mute / Level / Main-Output)',
  winaudio: '🔊 Windows-Standardgerät setzen (Ausgabe umschalten)',
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
    return <div class={keyClass(eff, base) + ' t-widget'} style="background:transparent"><Clock opts={o} fs={26} /></div>
  }
  if (render === 'text') {
    return (
      <div class={keyClass(eff, base) + ' t-widget'} style="background:transparent">
        <span class="t-label-text" style={`font-family:${fontStack(o.font)};color:${o.color || 'var(--fg)'};font-size:${widgetFontSize(o, 'text')}`}>{v.title || v.label || 'Text'}</span>
      </div>
    )
  }
  const isFlat = !v.image && render !== 'graph' && render !== 'fader'   // dunkle Flat-Kachel + Akzent-Glow (wie Panel)
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
  const setDecks = (next) => postJSON('/api/streamdeck/decks', { decks: next.map((d) => ({ id: d.id, label: d.label, icon: d.icon })) }).then(() => onReload && onReload()).catch(() => {})
  const addDeck = (label) => postJSON('/api/streamdeck/deck/add', { label }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const addFolder = (label) => postJSON('/api/streamdeck/deck/add', { label, icon: '📁', folder: true }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const dupDeck = () => postJSON('/api/streamdeck/deck/add', { label: (cur.label || 'Deck') + ' (Kopie)', icon: cur.icon, copy_from: cur.id, folder: cur.folder }).then((r) => { onReload && onReload(); if (r && r.id) onSelect(r.id) }).catch(() => {})
  const delDeck = () => postJSON('/api/streamdeck/deck/delete', { id: active }).then(() => onReload && onReload()).catch(() => {})
  const move = (dir) => { const arr = decks.slice(); const i = arr.findIndex((x) => x.id === active); const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return;[arr[i], arr[j]] = [arr[j], arr[i]]; setDecks(arr) }
  const rename = (label) => setDecks(decks.map((x) => x.id === active ? { ...x, label } : x))
  const setIcon = (icon) => setDecks(decks.map((x) => x.id === active ? { ...x, icon } : x))
  const setFolder = (val) => postJSON(`/api/streamdeck/deck/${active}/folder`, { folder: val }).then(() => onReload && onReload()).catch(() => {})
  const cur = decks.find((d) => d.id === active) || decks[0] || {}
  const idx = decks.findIndex((d) => d.id === active)
  const regular = decks.filter((d) => !d.folder)
  const folders = decks.filter((d) => d.folder)
  const Tab = (d) => (
    <button key={d.id} class={'sd-deck-tab' + (d.id === active ? ' active' : '')} onClick={() => onSelect(d.id)}>
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
        <span class="muted" style="font-size:12px;flex-basis:100%">Ordner erscheinen NICHT in der Panel-Tableiste — nur über einen „📁 Ordner öffnen"-Button erreichbar. <b>Presets</b> (DisplayFusion/OBS) lädst du direkt beim Anlegen eines „📁 Ordner öffnen"-Buttons — oder per „Importieren" unten im Deck.</span>
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
          ? <ConfirmX cls="btn ghost small danger" label="🗑 löschen" title="Löschen (Buttons bleiben im Pool)" onConfirm={delDeck} />
          : <span class="muted" style="font-size:12px">· Standard-Deck (nicht löschbar)</span>}
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

// 🧩 Freier Drag-/Resize-Editor (gridstack) — Kachel-Positionen sind DATEN (Item x/y/w/h), kein Auto-Flow.
// Spiegelt das Muster des Stream-Tab-Layout-Editors. ⚠ Position/Größe gelten NUR im Touch-Panel; das physische
// Elgato-Plugin liest nur resolved[button] und rendert JEDEN Button 1×1.
function FreeDeckGrid({ deck, pool, resolved, onReload, onExit }) {
  const elRef = useRef(null)
  const gridRef = useRef(null)
  const saveT = useRef(null)
  const dragId = useRef(null)   // Pool-Button, der gerade in den Canvas gezogen wird
  const layout = { ...L_DEF, ...(deck.layout || {}) }
  const cols = layout.cols > 0 ? layout.cols : 6
  const cell = layout.button_size || 116
  const items = deck.items || []
  const inDeck = new Set(items.map((it) => it.button))
  const palette = pool.filter((b) => !inDeck.has(b.id))
  const byId = {}; for (const b of pool) byId[b.id] = b   // Button-Def per id (render/opts für die Live-Vorschau)
  const itemURL = `/api/streamdeck/deck/${deck.id}/item`

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
                <div class="grid-stack-item-content">
                  <LiveKey v={resolved[it.button]} eff={resolveStyle(it.style, layout)} base="sd-prev-key"
                           render={(byId[it.button] || {}).render} opts={(byId[it.button] || {}).opts} />
                  <span class="sd-tile-acts">
                    <button class="sd-tile-act" title="vom Deck nehmen"
                            onClick={(e) => { e.stopPropagation(); removeItem(it.button) }}>✕</button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div class="sd-palette">
        <span class="muted" style="font-size:12px">🧩 Pool — in den Canvas <b>ziehen</b> (oder klicken = landet automatisch):</span>
        <div class="sd-pal-chips">
          {palette.length === 0 ? <span class="muted" style="font-size:12px">— alle Pool-Buttons sind auf diesem Deck —</span>
            : palette.map((b) => (
              <button key={b.id} class="sd-pal-chip" draggable
                      onDragStart={() => { dragId.current = b.id }}
                      onClick={() => addItem(b.id)} title="In den Canvas ziehen — oder klicken (landet automatisch)">
                <Swatch vis={resolved[b.id]} />
                <span class="sd-pal-name">{b.label || b.id}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}

function DeckGrid({ deck, pool, resolved, onReload, dfAvailable }) {
  const [sel, setSel] = useState('')
  const drag = useRef(null)   // {id, from:'grid'|'palette'}
  const [hot, setHot] = useState('')   // Kategorie-Name unter dem Cursor (Drop-Highlight)
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
  if (free) return <FreeDeckGrid deck={deck} pool={pool} resolved={resolved} onReload={onReload} onExit={toggleFree} />
  const cats = deck.categories || []
  const itemsById = {}; for (const it of deck.items || []) itemsById[it.button] = it
  const btnById = {}; for (const b of pool) btnById[b.id] = b   // Button-Def per id (render/opts für die Live-Vorschau)
  const inDeck = new Set((deck.items || []).map((it) => it.button))
  const palette = pool.filter((b) => !inDeck.has(b.id))
  const groups = groupDeckItems(deck.items || [], cats, true)   // hidden mit anzeigen (grau)

  const reorderURL = `/api/streamdeck/deck/${deck.id}/reorder`
  const itemURL = `/api/streamdeck/deck/${deck.id}/item`
  const catOf = (id) => { const it = itemsById[id]; const c = it && it.category; return (c && cats.includes(c)) ? c : '' }

  const addItem = (bid, cat) => postJSON(itemURL, { button: bid, category: cat || '' })
  const patchItem = (bid, body) => postJSON(`${itemURL}/${bid}`, body)

  // Drop auf eine Kachel → vor diese einsortieren (+ ggf. Kategorie übernehmen / aus Pool holen).
  const dropOnTile = async (dropId) => {
    const d = drag.current; drag.current = null; setHot('')
    if (!d || d.id === dropId) return
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
          <span class="muted" style="font-size:12px;font-weight:700">Presets generieren:</span>
          <button class="btn ghost small" disabled={obsBusy} onClick={importScenes}
                  title="Pro OBS-Szene einen Szenen-Wechsel-Button in DIESES Deck (aktive Szene wird live grün hervorgehoben). Idempotent.">
            {obsBusy ? '… lädt OBS' : '🎬 OBS-Szenen importieren'}
          </button>
          {dfAvailable && (
            <button class="btn ghost small" disabled={dfBusy} onClick={importDf}
                    title="Pro DisplayFusion-Monitor-Profil einen Lade-Button in DIESES Deck (aktives Profil live grün). Idempotent.">
              {dfBusy ? '… lädt DF' : '🖥 DisplayFusion-Profile importieren'}
            </button>
          )}
          <button class="btn ghost small" disabled={wlBusy} onClick={importWavelink}
                  title="Liest die laufende Wave-Link-App aus und legt pro Mix/Channel einen Fader + pro Ausgang einen Wähler in DIESES Deck. Idempotent.">
            {wlBusy ? '… liest Wave Link' : '🎚 Wave-Link-Fader importieren'}
          </button>
          <button class="btn ghost small" disabled={waBusy} onClick={importWinaudio}
                  title="Legt den allgemeinen Windows-Lautstärke-Regler als Fader + Live-VU in DIESES Deck (folgt dem Standard-Ausgabegerät). Idempotent.">
            {waBusy ? '… Windows-Audio' : '🔊 Windows-Lautstärke-Fader'}
          </button>
          <InlineAdd label="➕ Kategorie" placeholder="Neue Kategorie" onAdd={addCat} />
          {obsMsg && <span class={'msg ' + (obsMsg.ok ? 'ok' : 'err')}>{obsMsg.t}</span>}
          {dfMsg && <span class={'msg ' + (dfMsg.ok ? 'ok' : 'err')}>{dfMsg.t}</span>}
          {wlMsg && <span class={'msg ' + (wlMsg.ok ? 'ok' : 'err')}>{wlMsg.t}</span>}
          {waMsg && <span class={'msg ' + (waMsg.ok ? 'ok' : 'err')}>{waMsg.t}</span>}
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
                      return (
                        <div key={it.button} class={'sd-wys-key-wrap' + (sel === it.button ? ' sel' : '') + (it.hidden ? ' is-hidden' : '') + (spanned ? ' spanned' : '')}
                             style={spanned ? `grid-column:span ${sw};grid-row:span ${sh}` : ''}
                             draggable onDragStart={(e) => { e.stopPropagation(); drag.current = { id: it.button, from: 'grid' } }}
                             onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                             onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnTile(it.button) }}
                             onClick={() => setSel(sel === it.button ? '' : it.button)}
                             title={it.button}>
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

      <ItemInspector deck={deck} item={selItem} onReload={onReload} />

      <div class="sd-palette">
        <span class="muted" style="font-size:12px">🧩 Pool — Buttons NICHT auf diesem Deck (ziehen oder klicken zum Hinzufügen):</span>
        <div class="sd-pal-chips">
          {palette.length === 0 ? <span class="muted" style="font-size:12px">— alle Pool-Buttons sind auf diesem Deck —</span>
            : palette.map((b) => (
              <button key={b.id} class="sd-pal-chip" draggable
                      onDragStart={() => { drag.current = { id: b.id, from: 'palette' } }}
                      onClick={() => addItem(b.id, '').then(() => onReload && onReload())}
                      title={'Hinzufügen: ' + (b.label || b.id)}>
                <Swatch vis={resolved[b.id]} />
                <span class="sd-pal-name">{b.label || b.id}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  BUTTON-POOL (Funktionen) — global, einmal definiert
// ══════════════════════════════════════════════════════════════════════════════
const POOL_UNCAT = ' uncat'   // interner Key für „Ohne Kategorie" (kann nie ein echter Kategoriename sein)

function PoolList({ buttons, poolCategories, resolved, options, onReload }) {
  const [adding, setAdding] = useState(false)
  const [genBusy, setGenBusy] = useState('')
  const [genMsg, setGenMsg] = useState(null)
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sd.poolcat.collapsed') || '{}') } catch (_) { return {} }
  })
  const toggleCol = (k) => setCollapsed((c) => {
    const n = { ...c, [k]: !c[k] }
    try { localStorage.setItem('sd.poolcat.collapsed', JSON.stringify(n)) } catch (_) {}
    return n
  })
  const cats = poolCategories || []
  const postCat = (url, body) => postJSON(url, body).then(() => onReload && onReload()).catch(() => {})
  const addCat = (name) => postCat('/api/streamdeck/pool_category/add', { name })
  const renameCat = (old, nw) => postCat('/api/streamdeck/pool_category/rename', { old, new: nw })
  const delCat = (name) => postCat('/api/streamdeck/pool_category/delete', { name })
  const moveCat = (name, dir) => {
    const i = cats.indexOf(name); const j = i + dir
    if (i < 0 || j < 0 || j >= cats.length) return
    const next = cats.slice(); next.splice(i, 1); next.splice(j, 0, name)
    postCat('/api/streamdeck/pool_categories', { categories: next })
  }
  const byCat = {}
  for (const b of buttons) { const c = b.pool_cat || POOL_UNCAT; (byCat[c] = byCat[c] || []).push(b) }
  const orphans = Object.keys(byCat).filter((c) => c !== POOL_UNCAT && !cats.includes(c)).sort()
  const poolOrder = [...cats, ...orphans]
  if (byCat[POOL_UNCAT]) poolOrder.push(POOL_UNCAT)
  // Presets generieren: OBS/DisplayFusion NUR in den Pool; Wave Link / Windows-Lautstärke bauen ein Fader-Deck.
  const gen = async (kind) => {
    setGenBusy(kind); setGenMsg(null)
    try {
      if (kind === 'wl') {
        const r = await postJSON('/api/streamdeck/wavelink/build', {})
        setGenMsg({ ok: true, t: `Wave-Link-Deck: ${r.created || 0} neu · ${r.updated || 0} aktualisiert (${r.mixes || 0} Mixes · ${r.channels || 0} Channels · ${r.outputs || 0} Ausgänge) — Tab „Wave Link"` })
      } else if (kind === 'wa') {
        const r = await postJSON('/api/streamdeck/winaudio/build', {})
        setGenMsg({ ok: true, t: `Windows-Lautstärke-Fader angelegt (${r.created || 0} neu) — Tab „Audio"` })
      } else {
        const r = await postJSON(kind === 'df' ? '/api/streamdeck/generate/displayfusion' : '/api/streamdeck/generate/obs_scenes', {})
        setGenMsg({ ok: true, t: `${r.created || 0} neu · ${r.updated || 0} aktualisiert` })
      }
      onReload && onReload()
    } catch (e) {
      const m = String(e.message || e)
      setGenMsg({ ok: false, t: m === 'wavelink_offline' ? 'Wave Link läuft nicht / nicht gefunden — Wave Link starten, dann erneut.'
        : m === 'winaudio_unavailable' ? 'Windows-Audio nicht verfügbar (läuft die App auf diesem PC?).' : m })
    }
    setGenBusy('')
  }
  return (
    <div>
      <div class="conn-toolbar">
        <button class="btn ghost small" onClick={() => setAdding(true)}>➕ Neuer Button</button>
        <InlineAdd label="➕ Kategorie" placeholder="Neue Pool-Kategorie" onAdd={addCat} />
        <span class="muted" style="font-weight:700;font-size:12px;margin-left:4px">· Presets generieren:</span>
        {options.displayfusion_available && <button class="btn ghost small" disabled={!!genBusy} onClick={() => gen('df')}>{genBusy === 'df' ? '…' : '🖥 DisplayFusion-Profile'}</button>}
        <button class="btn ghost small" disabled={!!genBusy} onClick={() => gen('obs')}>{genBusy === 'obs' ? '… OBS' : '🎬 OBS-Szenen'}</button>
        <button class="btn ghost small" disabled={!!genBusy} onClick={() => gen('wl')} title="Liest die laufende Wave-Link-App aus und baut ein komplettes Wave-Link-Deck: pro Mix/Channel einen Fader + pro Ausgang einen Wähler. Idempotent.">{genBusy === 'wl' ? '… Wave Link' : '🎚 Wave-Link-Fader'}</button>
        <button class="btn ghost small" disabled={!!genBusy} onClick={() => gen('wa')} title="Legt den allgemeinen Windows-Lautstärke-Regler als Fader + Live-VU an (Tab Audio). Folgt automatisch dem Standard-Ausgabegerät.">{genBusy === 'wa' ? '… Windows' : '🔊 Windows-Lautstärke-Fader'}</button>
        {genMsg && <span class={'msg small ' + (genMsg.ok ? 'ok' : 'err')}>{genMsg.t}</span>}
      </div>
      <div class="conn-toolbar" style="margin-top:-8px">
        <span class="muted">{buttons.length} Buttons im Pool · in <b>klappbaren Kategorien</b> gruppiert. Pro Button rechts die Kategorie wählen. Platzierung aufs Deck per Drag&amp;Drop im <b>Decks</b>-Tab. <b>Presets</b> erzeugen Buttons nur im Pool.</span>
      </div>
      {adding && (
        <FunctionEditor button={blankButton()} options={options} isNew
          onSaved={() => { setAdding(false); onReload && onReload() }} onCancel={() => setAdding(false)} />
      )}
      {poolOrder.map((cat) => {
        const isUncat = cat === POOL_UNCAT
        const list = byCat[cat] || []
        const idx = cats.indexOf(cat)
        const isCol = !!collapsed[cat]
        return (
          <div class="sd-poolcat" key={cat}>
            <div class="sd-poolcat-h">
              <button class="sd-poolcat-toggle" onClick={() => toggleCol(cat)} title={isCol ? 'aufklappen' : 'zuklappen'}>{isCol ? '▸' : '▾'}</button>
              <span class="sd-poolcat-name">{isUncat ? 'Ohne Kategorie' : cat}</span>
              <span class="muted" style="font-size:11px">({list.length})</span>
              {!isUncat && <>
                <InlineEdit value={cat} title="Kategorie umbenennen" onSave={(nm) => renameCat(cat, nm)} />
                {idx > 0 && <button class="sd-poolcat-mv" title="nach oben" onClick={() => moveCat(cat, -1)}>↑</button>}
                {idx >= 0 && idx < cats.length - 1 && <button class="sd-poolcat-mv" title="nach unten" onClick={() => moveCat(cat, 1)}>↓</button>}
                <ConfirmX title="Kategorie löschen — Buttons bleiben (werden Ohne Kategorie)" onConfirm={() => delCat(cat)} />
              </>}
            </div>
            {!isCol && (list.length === 0
              ? <div class="sd-wys-empty">— leer — weise Buttons über ihr Kategorie-Feld zu —</div>
              : <div class="cards">{list.map((b) => <PoolCard key={b.id} b={b} vis={resolved[b.id]} options={options}
                                                              cats={cats} allIds={buttons.map((x) => x.id)} onChanged={onReload} />)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function PoolCard({ b, vis, options, cats, allIds, onChanged }) {
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
    <div class={'card content-card mode-static' + (open ? ' open' : '')}>
      <div class="sd-pool-head" style="display:flex;align-items:center;gap:6px;padding-right:8px">
        <button class="card-toggle" style="flex:1;min-width:0" onClick={() => setOpen(!open)}>
          <span class="caret">{open ? '▾' : '▸'}</span>
          <Swatch vis={vis} />
          <span class="card-title">{b.label || b.id}</span>
          <span class="muted conn-id">⚡{ACTION_LABELS[aType] ? aType : 'none'} · 👁{mType}</span>
        </button>
        <select class="sd-pool-cat" value={b.pool_cat || ''} title="Pool-Kategorie (klappbare Gruppe im Pool)"
                onChange={(e) => postJSON(`/api/streamdeck/buttons/${b.id}/pool_category`, { category: e.currentTarget.value }).then(() => onChanged && onChanged()).catch(() => {})}>
          <option value="">— Kategorie —</option>
          {(cats || []).map((c) => <option value={c}>{c}</option>)}
        </select>
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

// Funktions-Editor (Pool): Aktion + Überwachung + Refresh + Zustände/Default. KEINE Platzierung.
// Typ-Felder für Text-/Uhr-Buttons — Teil der „Aussehen"-Sektion (bei Darstellung text|clock). Bearbeitet
// opts (Schrift/Farbe/Uhr-Modus) + bei Text den angezeigten Text (= der Titel).
function WidgetFields({ render, opts, def, onOpts, onDefault }) {
  const o = opts || {}
  const isClock = render === 'clock'
  const digital = !isClock || (o.mode || 'digital') === 'digital'
  const setO = (p) => onOpts({ ...o, ...p })
  return (
    <div class="reward-row" style="flex-wrap:wrap;gap:10px">
      {render === 'text' && (
        <>
          <span class="muted conn-label">Text</span>
          <input class="reward-input" placeholder="Überschrift / Text" value={(def || {}).title || ''}
                 onInput={(e) => onDefault({ title: e.currentTarget.value })} />
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
      <label>Farbe
        <input type="color" class="so-delay" style="width:46px;height:30px;padding:2px"
               value={o.color || '#ffffff'} onChange={(e) => setO({ color: e.currentTarget.value })} />
      </label>
      {isClock && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={o.seconds !== false} onChange={(e) => setO({ seconds: e.currentTarget.checked })} /> Sekunden</label>}
      {isClock && digital && <label class="sd-inline" style="gap:4px;font-size:12px"><input type="checkbox" checked={o.format24 !== false} onChange={(e) => setO({ format24: e.currentTarget.checked })} /> 24-Std</label>}
    </div>
  )
}

// 🎚 Eingabequelle eines Faders wählen/umhängen — lädt die LIVE Wave-Link-Quellen (Mixes/Channels)
// + Windows-Lautstärke und schreibt action + monitor + label der bestehenden Kachel um. Erkennt
// verwaiste Quellen (id nicht mehr in der Live-Liste, z. B. nach Geräte-Neuzuordnung durch Windows).
function FaderSource({ b, onPick }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let off = false
    fetch('/api/wavelink/state').then((r) => r.json()).then((d) => { if (!off) setSrc(d || {}) }).catch(() => { if (!off) setSrc({}) })
    return () => { off = true }
  }, [])
  const a = b.action || {}, m = b.monitor || {}
  const isWa = m.type === 'winaudio_volume' || a.type === 'winaudio'
  const curId = isWa ? '__wa__' : (m.id || a.mix_id || a.channel_id || '')
  const mixes = (src && src.mixes) || [], channels = (src && src.channels) || []
  const known = isWa || (!!curId && (mixes.some((x) => x.id === curId) || channels.some((x) => x.id === curId)))
  const orphan = !!curId && !known
  const pick = (val) => {
    if (val === '__none__') return
    if (val === '__wa__') { onPick({ action: { type: 'winaudio', wa_action: 'toggle_mute' }, monitor: { type: 'winaudio_volume' }, label: 'Windows-Lautstärke' }); return }
    const mix = mixes.find((x) => x.id === val)
    if (mix) { onPick({ action: { type: 'wavelink', wl_action: 'mix_mute', mix_id: mix.id }, monitor: { type: 'wavelink_level', target_type: 'mix', id: mix.id }, label: mix.name }); return }
    const ch = channels.find((x) => x.id === val)
    if (ch) onPick({ action: { type: 'wavelink', wl_action: 'channel_mute', channel_id: ch.id }, monitor: { type: 'wavelink_level', target_type: 'channel', id: ch.id }, label: ch.name })
  }
  return (
    <div class="sd-block">
      <p class="sd-block-h">🎚 Eingabequelle <span class="muted">— welche Wave-Link-Quelle / Windows-Lautstärke dieser Fader regelt (hier umhängen, falls Windows neu zuordnet)</span></p>
      <div class="reward-row">
        <select class="reward-input" value={known ? curId : '__none__'} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="__none__">{orphan ? '⚠ Quelle verloren — neu wählen …' : '— Eingabequelle wählen …'}</option>
          <option value="__wa__">🔊 Windows-Hauptlautstärke</option>
          {mixes.length > 0 && <optgroup label="Wave Link · Mixes">{mixes.map((x) => <option value={x.id}>{x.name}</option>)}</optgroup>}
          {channels.length > 0 && <optgroup label="Wave Link · Channels">{channels.map((x) => <option value={x.id}>{x.name}</option>)}</optgroup>}
        </select>
        {src === null && <span class="muted" style="font-size:12px;margin-left:6px">lädt …</span>}
      </div>
      {src && mixes.length === 0 && channels.length === 0
        ? <p class="muted sd-help" style="margin:4px 0 0">Wave Link nicht verbunden — nur „Windows-Hauptlautstärke" wählbar. Verbindung im OBS/Wave-Link-Tab prüfen.</p>
        : orphan
          ? <p class="msg err" style="font-size:12px;margin:4px 0 0">Die bisherige Quelle gibt's in Wave Link nicht mehr (Gerät neu zugeordnet?). Wähl oben die neue — der Fader wird umgehängt, ohne neu zu erzeugen.</p>
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
export function StreamDeck() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [resolved, setResolved] = useState({})
  const [view, setView] = useState('decks')   // 'decks' | 'pool'
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
        <b>Pool</b> = die Buttons (Funktion + ID), einmal definiert. <b>Decks</b> = unabhängige Tablet-
        Ansichten mit je eigenem Raster/Größe/Kategorien; Buttons ziehst du dort <b>direkt ins Raster</b>.
        Derselbe Button darf auf mehreren Decks liegen. Das Elgato-Plugin nutzt nur den Pool. Live-Vorschau = jetzt.
      </p>

      <RefreshRate reg={data} onSaved={load} />

      <div class="sd-tabbar">
        <button class={'sd-tab' + (view === 'decks' ? ' active' : '')} onClick={() => setView('decks')}>🎛 Decks &amp; Layout</button>
        <button class={'sd-tab' + (view === 'pool' ? ' active' : '')} onClick={() => setView('pool')}>🧩 Button-Pool ({(data.buttons || []).length})</button>
      </div>

      {view === 'decks' ? (
        <>
          <DeckBar decks={decks} active={deck ? deck.id : ''} defaultDeck={data.default_deck || 'main'}
                   dfAvailable={options.displayfusion_available} onSelect={setActiveDeck} onReload={load} />
          {deck && (
            <div class="card" style="max-width:1100px">
              <h3 class="section-h" style="margin-top:0">{deck.icon || '🎛'} {deck.label} <span class="muted" style="font-weight:400;font-size:13px">— Layout &amp; Buttons</span></h3>
              <DeckLayout deck={deck} onReload={load} />
              <DeckGrid deck={deck} pool={data.buttons || []} resolved={resolved} onReload={load}
                        dfAvailable={options.displayfusion_available} />
            </div>
          )}
        </>
      ) : (
        <PoolList buttons={data.buttons || []} poolCategories={data.pool_categories || []} resolved={resolved} options={options} onReload={load} />
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
  // open_deck-Preset: einen befüllten Ordner anlegen (DisplayFusion-Profile / OBS-Szenen) und
  // direkt als Ziel dieses Ordner-Buttons setzen. Die Deck-Liste lokal nachladen, damit das
  // Dropdown den frischen Ordner sofort zeigt.
  const refreshDeckOpts = async () => {
    try { const d = await getJSON('/api/streamdeck/registry'); setDeckOpts((d.options && d.options.decks) || []) } catch { /* noop */ }
  }
  const makePresetFolder = async (kind) => {
    setPresetBusy(true); setPresetMsg(null)
    const meta = kind === 'df' ? { label: 'Monitor-Profile', icon: '🖥' } : { label: 'OBS-Szenen', icon: '🎬' }
    try {
      const r = await postJSON('/api/streamdeck/deck/add', { ...meta, folder: true })
      if (!r || !r.id) throw new Error('Ordner nicht angelegt')
      let filled = true
      try {
        if (kind === 'df') await postJSON(`/api/streamdeck/deck/${r.id}/populate_displayfusion`, {})
        else await postJSON('/api/streamdeck/deck/populate_obs_scenes', { deck_id: r.id })
      } catch { filled = false }
      await refreshDeckOpts(); onChange({ deck: r.id })
      setPresetMsg({ ok: true, t: filled ? 'Ordner angelegt + befüllt ✓' : 'Ordner angelegt (Quelle offline — später befüllen)' })
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
            <span class="muted conn-label">oder Preset laden</span>
            <button class="btn ghost small" disabled={presetBusy} onClick={() => makePresetFolder('df')}
                    title="Neuen Ordner mit allen DisplayFusion-Monitor-Profilen anlegen und hier direkt als Ziel setzen">🖥 DisplayFusion-Ordner</button>
            <button class="btn ghost small" disabled={presetBusy} onClick={() => makePresetFolder('obs')}
                    title="Neuen Ordner mit allen OBS-Szenen anlegen und hier direkt als Ziel setzen">🎬 OBS-Szenen-Ordner</button>
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
            gewählte Deck — als Unterseite (mit Zurück-Pfeil) oder als Radial-Menü. <b>„Preset laden"</b> legt
            direkt einen befüllten Ordner an (alle DisplayFusion-Profile / OBS-Szenen) und setzt ihn als Ziel.
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
      <input class="so-delay" style="width:100px" placeholder="Titel" value={st.title || ''}
             onInput={(e) => onChange({ ...st, title: e.currentTarget.value })} />
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
  const isWidget = render === 'text' || render === 'clock'
  const add = () => onStates([...(states || []), { when: { op: knownValues ? 'eq' : 'any' }, title: '', icon: '', color: '#2a2a2a' }])
  const upd = (i, st) => onStates(states.map((s, j) => (j === i ? st : s)))
  const rm = (i) => onStates(states.filter((_, j) => j !== i))
  return (
    <div class="sd-block">
      <p class="sd-block-h">🎨 Aussehen <span class="muted">— wie die Taste aussieht</span></p>
      {/* Darstellung steuert, welche Aussehen-Felder unten erscheinen (ein Ort, typgesteuert). */}
      <div class="reward-row">
        <span class="muted conn-label">Darstellung</span>
        <select class="so-delay" value={render || 'value'} onChange={(e) => onRender(e.currentTarget.value)}>
          <option value="value">Standard (Symbol / Wert)</option>
          <option value="graph">📈 Graph (Verlaufskurve)</option>
          <option value="text">🔤 Text / Überschrift</option>
          <option value="clock">🕐 Uhr</option>
          <option value="fader">🎚 Fader (Wave Link / Windows-Lautstärke)</option>
        </select>
        <span class="muted conn-label" style="margin-left:8px">Größe</span>
        <select class="so-delay" value={(opts || {}).size || 'auto'} title="Schriftgröße von Titel/Text/Uhr — skaliert mit der Kachelbreite"
                onChange={(e) => onOpts({ ...(opts || {}), size: e.currentTarget.value === 'auto' ? undefined : e.currentTarget.value })}>
          {Object.keys(SIZE_LABELS).map((k) => <option value={k}>{SIZE_LABELS[k]}</option>)}
        </select>
      </div>
      {isWidget ? (
        <WidgetFields render={render} opts={opts} def={def} onOpts={onOpts} onDefault={onDefault} />
      ) : (
        <>
          <p class="muted sd-help">
            {render === 'fader'
              ? 'Vertikaler Fader: ziehen = Level, tippen = Mute, mit Live-VU-Säule. Die Quelle wählst/änderst du oben unter „🎚 Eingabequelle" (Wave-Link Mix/Channel oder Windows-Lautstärke) — auch zum Umhängen, falls Windows ein Gerät neu zuordnet.'
              : render === 'graph'
              ? 'Der Graph zeichnet den Verlauf des Überwachungs-Werts; die „Farbe" unten ist die Linienfarbe. Titel „{value}" zeigt zusätzlich die Zahl.'
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
            <input class="so-delay" style="width:100px" placeholder="Titel" value={def.title || ''}
                   onInput={(e) => onDefault({ title: e.currentTarget.value })} />
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
