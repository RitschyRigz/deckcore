import { useState, useEffect, useRef } from 'preact/hooks'
import { getJSON, postJSON, delJSON } from './api.js'
import { resolveStyle, keyClass, groupDeckItems, UNCAT, DECK_LAYOUT_DEF } from './deckstyle.js'
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
  open_deck: '📁 Ordner öffnen (Sub-Deck / Radial-Menü)',
  displayfusion: '🖥 DisplayFusion — Monitor-Profil laden',
  media: '⏯ Media-Taste (Play/Pause · ⏭⏮ · Lauter/Leiser · Mute)',
  hotkey: '⌨ Tastenkürzel / Makro senden',
  manual_event: '🎯 Manual-Event (Tod/Boss/Win …)',
  alert: '🔔 Test-Alert abspielen (follow/sub/raid …)',
  obs: '🎬 OBS (Szene wechseln / Quelle ein-aus / Stream / Aufnahme)',
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
  obs_source_visible: 'Ist eine OBS-Quelle sichtbar? (an/aus)',
  obs_scene: 'Welche OBS-Szene ist aktiv? (Szenenname)',
  displayfusion_profile: 'Welches DisplayFusion-Profil ist aktiv? (Profilname)',
}
const MONITOR_INFO = {
  none: { text: 'Kein Status — der Button nutzt immer das „Standard"-Aussehen unten. Für reine Tasten genau richtig.', values: null, bool: false },
  process_alive: { text: 'Liefert AN oder AUS. Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  flag: { text: 'Liefert AN oder AUS. Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  bot_mode: { text: 'Liefert: off · running · muted (für den gewählten Bot). Nutze „= gleich" + Wert.', values: ['off', 'running', 'muted'], bool: false },
  bot_state: { text: 'Liefert: off · ready · followup · afk (für den gewählten Bot). Nutze „= gleich" + Wert.', values: ['off', 'ready', 'followup', 'afk'], bool: false },
  poll: { text: 'Wert kommt von der URL (z. B. Health: ok · warning · error · off).', values: ['ok', 'warning', 'error', 'off'], bool: false },
  file_field: { text: 'Wert aus dem JSON-Feld. Bei true/false „ist wahr/an", sonst „= gleich" + Wert.', values: null, bool: false },
  sse_field: { text: 'Wert aus dem Live-Event-Feld. Bei true/false „ist wahr/an", sonst „= gleich" + Wert.', values: null, bool: false },
  obs_source_visible: { text: 'Liefert AN (sichtbar) oder AUS (ausgeblendet). Nutze „ist wahr/an" und „ist falsch/aus".', values: null, bool: true },
  obs_scene: { text: 'Liefert den Namen der aktiven OBS-Szene. Nutze „= gleich" + Szenenname → der Button hebt sich hervor, wenn SEINE Szene gerade aktiv ist.', values: null, bool: false },
  displayfusion_profile: { text: 'Liefert den Namen des zuletzt geladenen DisplayFusion-Profils. Nutze „= gleich" + Profilname → der Button leuchtet, wenn SEIN Profil aktiv ist.', values: null, bool: false },
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

// Live-Kachel im WYSIWYG-Raster (Stil = item.style über Deck-Layout) ──────────
function LiveKey({ v, eff, base }) {
  v = v || {}
  return (
    <div class={keyClass(eff, base) + (v.image ? ' has-img' : '')} style={'background:' + (v.color || '#222')}>
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
            <option value="0">Auto</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option value={n}>{n}</option>)}
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
      <p class="muted sd-help" style="margin:6px 0 0">Der „Titel" ist der große Text (aus „Aussehen → Standard/Status"); er liegt bei Bild-Buttons als Overlay oben oder unten drauf — wie im Stream Deck.</p>
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

  const layout = { ...L_DEF, ...(deck.layout || {}) }
  const cats = deck.categories || []
  const itemsById = {}; for (const it of deck.items || []) itemsById[it.button] = it
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
          <InlineAdd label="➕ Kategorie" placeholder="Neue Kategorie" onAdd={addCat} />
          {obsMsg && <span class={'msg ' + (obsMsg.ok ? 'ok' : 'err')}>{obsMsg.t}</span>}
          {dfMsg && <span class={'msg ' + (dfMsg.ok ? 'ok' : 'err')}>{dfMsg.t}</span>}
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
                      return (
                        <div key={it.button} class={'sd-wys-key-wrap' + (sel === it.button ? ' sel' : '') + (it.hidden ? ' is-hidden' : '')}
                             draggable onDragStart={(e) => { e.stopPropagation(); drag.current = { id: it.button, from: 'grid' } }}
                             onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                             onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnTile(it.button) }}
                             onClick={() => setSel(sel === it.button ? '' : it.button)}
                             title={it.button}>
                          <LiveKey v={resolved[it.button]} eff={eff} base="sd-prev-key" />
                          <span class="sd-tile-acts">
                            <button class="sd-tile-act" title={it.hidden ? 'einblenden' : 'ausblenden'}
                                    onClick={(e) => { e.stopPropagation(); toggleHide(it) }}>{it.hidden ? '🚫' : '👁'}</button>
                            <button class="sd-tile-act" title="vom Deck nehmen"
                                    onClick={(e) => { e.stopPropagation(); removeItem(it.button) }}>✕</button>
                          </span>
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
function PoolList({ buttons, resolved, options, onReload }) {
  const [adding, setAdding] = useState(false)
  return (
    <div>
      <div class="conn-toolbar">
        <button class="btn ghost small" onClick={() => setAdding(true)}>➕ Neuer Button</button>
        <span class="muted">{buttons.length} Buttons im Pool · Funktion (Aktion/Überwachung/Zustände). Platzierung machst du im <b>Decks</b>-Tab bzw. am Elgato-Plugin.</span>
      </div>
      {adding && (
        <FunctionEditor button={blankButton()} options={options} isNew
          onSaved={() => { setAdding(false); onReload && onReload() }} onCancel={() => setAdding(false)} />
      )}
      <div class="cards">
        {buttons.map((b) => <PoolCard key={b.id} b={b} vis={resolved[b.id]} options={options}
                                      allIds={buttons.map((x) => x.id)} onChanged={onReload} />)}
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
    <div class={'card content-card mode-static' + (open ? ' open' : '')}>
      <div class="sd-pool-head" style="display:flex;align-items:center;gap:6px;padding-right:8px">
        <button class="card-toggle" style="flex:1;min-width:0" onClick={() => setOpen(!open)}>
          <span class="caret">{open ? '▾' : '▸'}</span>
          <Swatch vis={vis} />
          <span class="card-title">{b.label || b.id}</span>
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

// Funktions-Editor (Pool): Aktion + Überwachung + Refresh + Zustände/Default. KEINE Platzierung.
function FunctionEditor({ button, options, isNew, onSaved, onCancel }) {
  const [b, setB] = useState(() => JSON.parse(JSON.stringify(button)))
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (patch) => setB({ ...b, ...patch })
  const setAction = (patch) => setB({ ...b, action: { ...b.action, ...patch } })
  const setMonitor = (patch) => setB({ ...b, monitor: { ...b.monitor, ...patch } })
  const setDefault = (patch) => setB({ ...b, default: { ...b.default, ...patch } })

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
        <ActionEditor action={b.action} options={options} onChange={setAction} replace={(a) => set({ action: a })}
          onPicked={(info) => set({
            label: b.label || info.name,
            default: { ...b.default, image: info.icon_url || (b.default || {}).image, title: (b.default || {}).title || info.name },
          })} />
        <MonitorEditor monitor={b.monitor} options={options} onChange={setMonitor} replace={(m) => set({ monitor: m })} />
        <RefreshOverride value={b.refresh_seconds} options={options} onChange={(v) => set({ refresh_seconds: v })} />
        <StatesEditor states={b.states} def={b.default} options={options} monitor={b.monitor}
                      onStates={(s) => set({ states: s })} onDefault={setDefault} />
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
        <PoolList buttons={data.buttons || []} resolved={resolved} options={options} onReload={load} />
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
    </div>
  )
}

function MonitorEditor({ monitor, options, onChange, replace }) {
  const t = monitor.type || 'none'
  const info = MONITOR_INFO[t]
  const [obsSources, setObsSources] = useState([])
  useEffect(() => {
    if (t === 'obs_source_visible') getJSON('/api/obs/scene_items').then((d) => setObsSources(d.sources || [])).catch(() => {})
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

function StatesEditor({ states, def, options, monitor, onStates, onDefault }) {
  const mType = (monitor || {}).type || 'none'
  const info = MONITOR_INFO[mType] || {}
  const knownValues = info.values || null
  const stateless = mType === 'none'
  const add = () => onStates([...(states || []), { when: { op: knownValues ? 'eq' : 'any' }, title: '', icon: '', color: '#2a2a2a' }])
  const upd = (i, st) => onStates(states.map((s, j) => (j === i ? st : s)))
  const rm = (i) => onStates(states.filter((_, j) => j !== i))
  return (
    <div class="sd-block">
      <p class="sd-block-h">🎨 Aussehen <span class="muted">— Bild/Icon/Titel/Farbe je Zustand</span></p>
      <p class="muted sd-help">
        {stateless
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
    </div>
  )
}
