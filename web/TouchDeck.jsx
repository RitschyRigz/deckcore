import { useEffect, useState } from 'preact/hooks'
import { getJSON, postJSON } from './api.js'
import { useEventStream } from './sse.js'
import { DECK_LAYOUT_DEF, resolveStyle, keyClass, groupDeckItems } from './deckstyle.js'
import './deck.css'   // geteilte Deck-CSS (Editor .sd-* + Touch .t-*) — alle Hüllen

// 🎛 Deck — Soft-Stream-Deck: rendert die config-getriebene Registry wie das echte Plugin,
// live aufgelöst (Farbe/Icon/Bild/Titel) und per Tipp ausgelöst.
//
// Datenmodell v2 (Shared-Pool): die Button-FUNKTION ist global (`/resolved` per id); die
// Platzierung lebt PRO DECK als Item {button, category, style, hidden}. Jedes Deck hat sein
// EIGENES Layout (Raster/Größe/Gap/Schrift) + eigene Kategorien. Hier wird also pro gewähltem
// Deck dessen Template gerendert — kein globales Layout mehr.
//
// DECKS (umschaltbare Panels): die Umschalt-Leiste zeigt alle Decks. Welches beim Laden offen
// ist: ?deck=<id> (Tablet-Pinning) → localStorage → erstes Deck. So kann Tablet 1 fest auf
// „Szenen" stehen, Tablet 2 frei umschalten — beide an derselben /panel-URL.

// Bild-Vorladung: alle State-Icons des Pools einmal in den Browser-Cache holen → kein Flackern
// beim Stream-Start (off→run-Swap sofort). Modul-weiter Cache gegen Doppel-Loads.
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

export function TouchDeck() {
  const [decks, setDecks] = useState([])        // volle Templates [{id,label,icon,layout,categories,items}]
  const [defaultDeck, setDefaultDeck] = useState('main')
  const [deck, setDeck] = useState('')          // gewähltes Deck (id)
  const [vis, setVis] = useState({})            // button-id → {label,title,icon,image,color} (live)
  const [pressed, setPressed] = useState('')

  const loadReg = () => getJSON('/api/streamdeck/registry').then((d) => {
    const dks = d.decks || []
    setDecks(dks)
    const def = d.default_deck || 'main'
    setDefaultDeck(def)
    // Aktuelle Auswahl behalten, wenn noch gültig — sonst Start-Deck bestimmen.
    setDeck((cur) => (cur && dks.some((x) => x.id === cur)) ? cur : pickInitialDeck(dks, def))
    preloadDeckImages(d.buttons || [])   // Pool-State-Icons vorladen → kein Flackern
  }).catch(() => {})

  useEffect(() => {
    loadReg()
    getJSON('/api/streamdeck/resolved').then((d) => setVis(d.buttons || {})).catch(() => {})
  }, [])
  useEventStream(['streamdeck:buttons', 'streamdeck:layout'], {
    'streamdeck:buttons': (d) => { if (d.buttons) setVis(d.buttons) },
    // Deck-Template-Änderung aus dem Desktop-Editor → Registry neu lesen.
    'streamdeck:layout': () => loadReg(),
  })

  const switchDeck = (id) => {
    setDeck(id)
    try { localStorage.setItem('sd.deck', id) } catch {}
  }

  const press = async (id) => {
    setPressed(id)
    try { await postJSON('/api/streamdeck/press/' + encodeURIComponent(id)) } catch {}
    setTimeout(() => setPressed(''), 220)
  }

  if (!decks.length) return <div class="t-empty" style="margin:30px auto">Keine Decks in der Registry.</div>

  const sel = (deck && decks.some((d) => d.id === deck)) ? deck : defaultDeck
  const active = decks.find((d) => d.id === sel) || decks[0]
  const layout = { ...DECK_LAYOUT_DEF, ...(active.layout || {}) }
  // Sichtbare Items des aktiven Decks nach SEINEN Kategorien gruppieren (hidden raus, leere weg).
  const groups = groupDeckItems(active.items || [], active.categories || [], false)
    .filter((g) => g.items.length)

  const size = (layout.button_size || 116) + 'px'
  const gridCols = (layout.cols > 0) ? `repeat(${layout.cols}, 1fr)` : `repeat(auto-fill, minmax(${size}, 1fr))`
  const gridStyle = `grid-template-columns:${gridCols};gap:${layout.gap || 12}px`
  const deckStyle = `--sd-size:${size};--sd-font:${layout.font_scale || 1}`
  const showCatTitles = layout.show_category_titles !== false

  return (
    <div class="t-deck" style={deckStyle}>
      {decks.length > 1 && (
        <div class="t-deck-tabs">
          {decks.map((dk) => (
            <button key={dk.id} class={'t-deck-tab' + (dk.id === sel ? ' active' : '')}
                    onClick={() => switchDeck(dk.id)}>
              <span class="t-deck-tab-icon">{dk.icon || '🎛'}</span>
              <span class="t-deck-tab-label">{dk.label || dk.id}</span>
            </button>
          ))}
        </div>
      )}
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
                return (
                  <button key={id}
                          class={keyClass(eff, 't-key') + (v.image ? ' has-img' : '') + (pressed === id ? ' pressed' : '')}
                          style={'background:' + (v.color || '#222')}
                          onClick={() => press(id)}>
                    {v.image ? <img class="t-key-img" src={v.image} alt="" />
                      : <span class="t-key-icon">{v.icon || '•'}</span>}
                    {v.title ? <span class="t-key-title">{v.title}</span> : null}
                    <span class="t-key-label">{v.label || id}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
    </div>
  )
}
