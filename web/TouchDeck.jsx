import { useEffect, useState, useRef } from 'preact/hooks'
import { getJSON, postJSON } from './api.js'
import { useEventStream } from './sse.js'
import { DECK_LAYOUT_DEF, resolveStyle, keyClass, groupDeckItems } from './deckstyle.js'
import './deck.css'   // geteilte Deck-CSS (Editor .sd-* + Touch .t-*) — alle Hüllen

// 🎛 Deck — Soft-Stream-Deck: rendert die config-getriebene Registry wie das echte Plugin,
// live aufgelöst (Farbe/Icon/Bild/Titel) und per Tipp ausgelöst.
//
// Datenmodell v2 (Shared-Pool): die Button-FUNKTION ist global (`/resolved` per id); die
// Platzierung lebt PRO DECK als Item {button, category, style, hidden}. Jedes Deck hat sein
// EIGENES Layout (Raster/Größe/Gap/Schrift) + eigene Kategorien.
//
// ORDNER (open_deck): ein Button mit action.type==='open_deck' ist ein Ordner — beim Tippen
// öffnet sich das Ziel-Deck. mode='replace' → Unterseite (Navigations-Stack + Zurück-Pfeil);
// mode='radial' → die Buttons fächern im Kreis um den Anker auf (Overlay). Das Panel kennt die
// Aktion aus der Registry (`actionById`), navigiert lokal und löst KEINEN Press aus.

// Bild-Vorladung: alle State-Icons des Pools einmal in den Browser-Cache holen → kein Flackern.
const _preloadedIcons = new Set()
function preloadDeckImages(poolButtons) {
  const urls = new Set()
  for (const b of poolButtons || []) {
    const d = b.default || {}
    if (d.image) urls.add(d.image)
    for (const st of b.states || []) if (st && st.image) urls.add(st.image)
  }
  for (const u of urls) {
    if (_preloadedIcons.has(u)) continue
    _preloadedIcons.add(u)
    const img = new Image()
    img.src = u
  }
}

// Start-Deck wählen: URL-Param ?deck= (Pinning) → localStorage → erstes Deck → Default.
function pickInitialDeck(deckList, def) {
  const ids = new Set((deckList || []).map((d) => d.id))
  try {
    const fromUrl = new URLSearchParams(location.search).get('deck')
    if (fromUrl && ids.has(fromUrl)) return fromUrl
  } catch {}
  try {
    const stored = localStorage.getItem('sd.deck') || ''
    if (stored && ids.has(stored)) return stored
  } catch {}
  return (deckList && deckList[0] && deckList[0].id) || def
}

// Verlaufs-Puffer für Graph-Kacheln: bei jedem resolved-Push den Roh-`value` jedes Buttons anhängen
// (gedeckelt). Wird für ALLE numerischen Werte gesammelt; nur Graph-Kacheln lesen ihn. Schnell sampeln /
// grob anzeigen: hier sammelt das Frontend, was der Eval-Loop pusht — eine spätere High-Rate-Quelle
// (z.B. PresentMon-Frametimes) füllt denselben Puffer feiner.
const _HIST_MAX = 90
function _accumHist(hist, buttons) {
  for (const id in buttons) {
    const v = Number(buttons[id] && buttons[id].value)
    if (Number.isFinite(v)) {
      const arr = hist[id] || (hist[id] = [])
      arr.push(v)
      if (arr.length > _HIST_MAX) arr.shift()
    }
  }
}

// High-Rate-Graph für fps/frametime: pollt /api/frametime/series schnell (die Quelle = PresentMon
// sampelt im ms-Bereich; die Anzeige liest gröber). Zeigt einen klaren Hinweis, wenn keine Daten
// (kein Spiel / PresentMon fehlt) — nie stumm leer.
function FastGraph({ kind, color }) {
  const [data, setData] = useState([])
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let alive = true
    const tick = () => getJSON('/api/frametime/series?kind=' + kind).then((d) => {
      if (!alive) return
      setData(d.data || [])
      setMsg((d.data && d.data.length > 1) ? null : (d.reason || (d.available ? 'warte auf ein Spiel' : 'PresentMon fehlt')))
    }).catch(() => {})
    tick()
    const iv = setInterval(tick, 110)
    return () => { alive = false; clearInterval(iv) }
  }, [kind])
  if (msg && (!data || data.length < 2)) return <div class="t-spark-msg">{msg}</div>
  return <Sparkline data={data} color={color} />
}

// Mini-Verlaufskurve (Sparkline) aus einer Zahlenreihe — autoskaliert auf Min/Max der Daten.
// Politur: Fläche unter der Kurve gefüllt, Live-Punkt am aktuellen Wert, Min/Max-Werte in den Ecken.
function Sparkline({ data, color }) {
  const arr = data || []
  if (arr.length < 2) return <div class="t-spark t-spark-wait" />
  let min = Infinity, max = -Infinity
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v }
  let lo = min, hi = max
  if (lo === hi) { lo -= 1; hi += 1 }            // flache Linie nicht durch 0 teilen
  const W = 100, H = 36, n = arr.length
  const px = (i) => (i / (n - 1)) * W
  const py = (v) => H - ((v - lo) / (hi - lo)) * H
  const line = arr.map((v, i) => px(i).toFixed(1) + ',' + py(v).toFixed(1)).join(' ')
  const lx = px(n - 1), ly = py(arr[n - 1])
  const c = color || 'var(--accent2)'
  const fmt = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  return (
    <div class="t-graph">
      <svg class="t-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={c} opacity="0.2" stroke="none" />
        <polyline points={line} fill="none" stroke={c} stroke-width="2"
                  stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="t-graph-dot" style={`left:${lx.toFixed(1)}%;top:${(ly / H * 100).toFixed(1)}%;background:${c}`} />
      <span class="t-graph-lbl t-graph-max">{fmt(max)}</span>
      <span class="t-graph-lbl t-graph-min">{fmt(min)}</span>
    </div>
  )
}

// Radial-Menü: fächert die (sichtbaren) Buttons eines Ziel-Decks im Kreis um den Anker (den
// getippten Ordner-Button) auf. Reines Overlay — schließt bei Tap auf den Hintergrund oder nach
// einer ausgeführten Aktion. Ein Ordner-Button IM Radial öffnet wieder ein Radial (eine Ebene).
function RadialMenu({ deck, vis, actionById, anchor, onTap, onClose }) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 10); return () => clearTimeout(t) }, [])
  const items = (deck && deck.items || []).filter((it) => !it.hidden)
  const N = items.length
  const margin = 14, keyHalf = 46
  const vw = (typeof window !== 'undefined' ? window.innerWidth : 1024)
  const vh = (typeof window !== 'undefined' ? window.innerHeight : 768)
  let R = Math.min(230, Math.max(116, 60 + N * 16))   // Radius wächst mit der Knopf-Zahl …
  // Randerkennung 1/2: Radius so weit verkleinern, dass der ganze Kreis in den Viewport passt.
  const maxR = Math.max(64, Math.min((vw - 2 * margin) / 2 - keyHalf, (vh - 2 * margin) / 2 - keyHalf))
  R = Math.min(R, maxR)
  // Randerkennung 2/2: Mittelpunkt so klemmen, dass kein Knopf über den Rand ragt (am Anker, sonst rein).
  const ext = R + keyHalf
  const cx = Math.min(Math.max(anchor.x, margin + ext), vw - margin - ext)
  const cy = Math.min(Math.max(anchor.y, margin + ext), vh - margin - ext)
  return (
    <div class="t-radial-backdrop" onClick={onClose}>
      <div class={'t-radial' + (shown ? ' in' : '')} style={`left:${cx}px;top:${cy}px`}
           onClick={(e) => e.stopPropagation()}>
        <span class="t-radial-hub">{(deck && deck.icon) || '📁'}</span>
        {N === 0 && <div class="t-radial-empty">leer</div>}
        {items.map((it, i) => {
          const ang = (-90 + i * (360 / N)) * Math.PI / 180
          const rx = Math.round(Math.cos(ang) * R), ry = Math.round(Math.sin(ang) * R)
          const id = it.button
          const v = vis[id] || {}
          const folder = (actionById[id] || {}).type === 'open_deck'
          return (
            <button key={id}
                    class={'t-key t-radial-key' + (v.image ? ' has-img' : '') + (folder ? ' is-folder' : '')}
                    style={`--rx:${rx}px;--ry:${ry}px;--i:${i};background:${v.color || '#222'}`}
                    onClick={(e) => { e.stopPropagation(); onTap(id, e) }}>
              {v.image ? <img class="t-key-img" src={v.image} alt="" />
                : <span class="t-key-icon">{v.icon || '•'}</span>}
              <span class="t-key-label">{v.label || id}</span>
              {folder && <span class="t-folder-badge">⋯</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function TouchDeck() {
  const [decks, setDecks] = useState([])        // volle Templates [{id,label,icon,layout,categories,items}]
  const [defaultDeck, setDefaultDeck] = useState('main')
  const [deck, setDeck] = useState('')          // Tab-gewähltes Deck (Top-Level)
  const [vis, setVis] = useState({})            // button-id → {label,title,icon,image,color} (live)
  const [pressed, setPressed] = useState('')
  const [actionById, setActionById] = useState({})   // button-id → action (für „ist Ordner?")
  const [renderById, setRenderById] = useState({})   // button-id → Darstellung ('value' | 'graph')
  const [monById, setMonById] = useState({})         // button-id → monitor (für High-Rate-Graphen fps/frametime)
  const histRef = useRef({})                         // button-id → Zahlenreihe (Verlauf für Graph-Kacheln)
  const [navStack, setNavStack] = useState([])       // Ordner-Drilldown (replace-Modus)
  const [overlay, setOverlay] = useState(null)       // {deck, anchor:{x,y}} — Radial-Menü

  const loadReg = () => getJSON('/api/streamdeck/registry').then((d) => {
    const dks = d.decks || []
    setDecks(dks)
    const def = d.default_deck || 'main'
    setDefaultDeck(def)
    setDeck((cur) => (cur && dks.some((x) => x.id === cur)) ? cur : pickInitialDeck(dks, def))
    const am = {}, rm = {}, mm = {}
    for (const b of d.buttons || []) { am[b.id] = b.action || {}; rm[b.id] = b.render || 'value'; mm[b.id] = b.monitor || {} }
    setActionById(am); setRenderById(rm); setMonById(mm)
    setNavStack((s) => s.filter((id) => dks.some((x) => x.id === id)))   // entfernte Decks aus dem Stack
    preloadDeckImages(d.buttons || [])
  }).catch(() => {})

  useEffect(() => {
    loadReg()
    getJSON('/api/streamdeck/resolved').then((d) => { _accumHist(histRef.current, d.buttons || {}); setVis(d.buttons || {}) }).catch(() => {})
  }, [])
  useEventStream(['streamdeck:buttons', 'streamdeck:layout'], {
    'streamdeck:buttons': (d) => { if (d.buttons) { _accumHist(histRef.current, d.buttons); setVis(d.buttons) } },
    // Deck-Template- ODER Button-Änderung aus dem Editor → Registry neu lesen (hält actionById frisch).
    'streamdeck:layout': () => loadReg(),
  })

  const switchDeck = (id) => {
    setDeck(id); setNavStack([]); setOverlay(null)
    try { localStorage.setItem('sd.deck', id) } catch {}
  }
  const goBack = () => setNavStack((s) => s.slice(0, -1))
  const closeOverlay = () => setOverlay(null)

  // EINHEITLICHER Tap-Handler (Haupt-Raster UND Radial): Ordner → navigieren; sonst → Press.
  const onTap = async (id, evt) => {
    const a = actionById[id] || {}
    if (a.type === 'open_deck' && a.deck) {
      if ((a.mode || 'replace') === 'radial') {
        const r = evt.currentTarget.getBoundingClientRect()
        setOverlay({ deck: a.deck, anchor: { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      } else {
        setOverlay(null); setNavStack((s) => [...s, a.deck])
      }
      return
    }
    setPressed(id)
    try { await postJSON('/api/streamdeck/press/' + encodeURIComponent(id)) } catch {}
    setTimeout(() => setPressed(''), 220)
    setOverlay(null)   // nach einer echten Aktion ein offenes Radial schließen
  }

  if (!decks.length) return <div class="t-empty" style="margin:30px auto">Keine Decks in der Registry.</div>

  const tabSel = (deck && decks.some((d) => d.id === deck)) ? deck : defaultDeck
  const shownId = navStack.length ? navStack[navStack.length - 1] : tabSel
  const active = decks.find((d) => d.id === shownId) || decks[0]
  const layout = { ...DECK_LAYOUT_DEF, ...(active.layout || {}) }
  const groups = groupDeckItems(active.items || [], active.categories || [], false)
    .filter((g) => g.items.length)

  const size = (layout.button_size || 116) + 'px'
  const gridCols = (layout.cols > 0) ? `repeat(${layout.cols}, 1fr)` : `repeat(auto-fill, minmax(${size}, 1fr))`
  const gridStyle = `grid-template-columns:${gridCols};gap:${layout.gap || 12}px`
  const deckStyle = `--sd-size:${size};--sd-font:${layout.font_scale || 1}`
  const showCatTitles = layout.show_category_titles !== false

  const crumb = [tabSel, ...navStack].map((id) => (decks.find((d) => d.id === id) || {}).label || id)
  const overlayDeck = overlay ? decks.find((d) => d.id === overlay.deck) : null
  const visibleDecks = decks.filter((d) => !d.folder)   // Ordner NICHT in der Tableiste (nur per open_deck)

  return (
    <div class="t-deck" style={deckStyle}>
      {navStack.length > 0 ? (
        <div class="t-nav">
          <button class="t-nav-back" onClick={goBack}>‹ Zurück</button>
          <span class="t-nav-crumb">{crumb.join('  ›  ')}</span>
        </div>
      ) : (visibleDecks.length > 1 && (
        <div class="t-deck-tabs">
          {visibleDecks.map((dk) => (
            <button key={dk.id} class={'t-deck-tab' + (dk.id === tabSel ? ' active' : '')}
                    onClick={() => switchDeck(dk.id)}>
              <span class="t-deck-tab-icon">{dk.icon || '🎛'}</span>
              <span class="t-deck-tab-label">{dk.label || dk.id}</span>
            </button>
          ))}
        </div>
      ))}
      {!groups.length
        ? <div class="t-empty" style="margin:30px auto">Dieses Deck ist leer.</div>
        : groups.map((g) => (
          <section class="t-deck-grp" key={g.name}>
            {showCatTitles && <h2 class="t-col-h">{g.name}</h2>}
            <div class="t-deck-grid" style={gridStyle}>
              {g.items.map((it) => {
                const id = it.button
                const v = vis[id] || {}
                const eff = resolveStyle(it.style, layout)
                const folder = (actionById[id] || {}).type === 'open_deck'
                const isGraph = renderById[id] === 'graph'
                const w = Math.max(1, it.w || 1), h = Math.max(1, it.h || 1)
                const spanned = w > 1 || h > 1   // große/breite Kachel — NUR Panel (physisch bleibt 1×1)
                return (
                  <button key={id}
                          class={keyClass(eff, 't-key') + (v.image ? ' has-img' : '') + (folder ? ' is-folder' : '') + (isGraph ? ' is-graph' : '') + (spanned ? ' spanned' : '') + (pressed === id ? ' pressed' : '')}
                          style={'background:' + (isGraph ? 'var(--bg)' : (v.color || '#222')) + (spanned ? `;grid-column:span ${w};grid-row:span ${h}` : '')}
                          onClick={(e) => onTap(id, e)}>
                    {isGraph ? (
                      <>
                        {v.title ? <span class="t-key-title">{v.title}</span> : null}
                        {['fps', 'frametime'].includes((monById[id] || {}).type)
                          ? <FastGraph kind={(monById[id] || {}).type} color={v.color} />
                          : <Sparkline data={histRef.current[id]} color={v.color} />}
                      </>
                    ) : (
                      <>
                        {v.image ? <img class="t-key-img" src={v.image} alt="" />
                          : <span class="t-key-icon">{v.icon || '•'}</span>}
                        {v.title ? <span class="t-key-title">{v.title}</span> : null}
                      </>
                    )}
                    <span class="t-key-label">{v.label || id}</span>
                    {folder && <span class="t-folder-badge">⋯</span>}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      {overlay && overlayDeck && (
        <RadialMenu deck={overlayDeck} vis={vis} actionById={actionById}
                    anchor={overlay.anchor} onTap={onTap} onClose={closeOverlay} />
      )}
    </div>
  )
}
