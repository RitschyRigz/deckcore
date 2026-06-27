// Geteilte Stream-Deck-Stil-Logik (Touch-Deck + Desktop-Editor = EINE Wahrheit).
// Datenmodell v2 (Shared-Pool): Button-FUNKTION ist global; Platzierung lebt pro Deck als
// Item {button, category, style, hidden}. Das Layout (Raster/Stil-Defaults) ist PRO DECK;
// item.style überschreibt die Deck-Defaults.
// style-Werte: 'inherit' (erbt Default) | 'on' | 'off'; label_pos: 'inherit'|'top'|'bottom'.

export const DECK_LAYOUT_DEF = {
  cols: 0, button_size: 116, gap: 12, font_scale: 1.0,
  show_label: true, label_pos: 'bottom', show_title: true, frame: true, show_category_titles: true,
}
export const UNCAT = 'Ohne Kategorie'

// ── Theme-gebundene Farben ───────────────────────────────────────────────────
// Eine Button-Farbe ist normalerweise eine feste Hex (#8a5cff). Sie kann aber stattdessen auf eine
// THEME-Variable zeigen — gespeichert als reines Schlüsselwort ('accent', 'live', …, KEIN '#'). Dann
// färbt sich die Kachel automatisch mit jedem Theme/Theme-Edit um ("alles passt sich der Farbe an").
// resolveColor() macht aus dem Schlüsselwort die CSS-Variable; jede Hex bleibt unverändert.
export const THEME_COLORS = {
  accent: 'Akzent', accent2: 'Akzent 2', ok: 'Grün / OK', warn: 'Warnung', err: 'Fehler', live: 'Live',
  off: 'Inaktiv / Aus',
}
export function isThemeColor(c) {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(THEME_COLORS, c)
}
// Farbwert für einen CSS-`style`-String: Theme-Schlüsselwort → `var(--x)`, sonst die rohe Farbe (Hex)
// unverändert. Leer/undefined → '' (Aufrufer setzt seinen eigenen Fallback, z.B. '#222').
export function resolveColor(c) {
  // Familien-Token (fam:gpu …) → --fam-*-CSS-Var (Quellen-Palette ODER Theme, je Farb-Modus, live umschaltbar).
  if (typeof c === 'string' && c.startsWith('fam:')) return `var(--fam-${c.slice(4)})`
  return isThemeColor(c) ? `var(--${c})` : (c || '')
}
// Familien-Farb-Schlüssel (HWiNFO-Dashboard) — EINE Wahrheit für Palette-Editor + applyPalette + --fam-*-Defaults.
export const FAM_KEYS = ['gpu', 'cpu', 'ram', 'board', 'power', 'fan', 'water', 'radiator', 'storage', 'net', 'other']
// Quellen-Palette (Default) — muss zu service `_SMART` + deck.css `:root --fam-*` passen.
export const FAM_PALETTE = {
  gpu: '#35d07f', cpu: '#e0a92e', ram: '#1fc9b0', board: '#b07cf0', power: '#f5d423',
  fan: '#5bb0ff', water: '#3a9bf0', radiator: '#37c6e0', storage: '#e0773a', net: '#7cc4f0', other: '#8aa0b8',
}
// Anzeigenamen der Familien (Daten-Viz-Farb-Editor) — Reihenfolge folgt FAM_KEYS; muss zu service `_FAM_CAT` passen.
export const FAM_LABELS = {
  gpu: 'GPU', cpu: 'CPU', ram: 'RAM', board: 'Mainboard', power: 'Strom', fan: 'Lüfter',
  water: 'Wasser', radiator: 'Radiator', storage: 'Festplatten', net: 'Netzwerk', other: 'Sonstige',
}
// Familien-Farben auf :root setzen — Modus 'source' nutzt die (ggf. editierte) Palette, 'theme' bindet jede
// Familie an ein Theme-Schlüsselwort → die fam:-Kacheln folgen dem Theme. Live umschaltbar ohne Rebuild.
const FAM_THEME = {
  gpu: 'ok', cpu: 'warn', ram: 'accent2', board: 'accent', power: 'warn',
  fan: 'accent', water: 'accent2', radiator: 'accent2', storage: 'warn', net: 'accent', other: 'off',
}
export function applyPalette(palette, mode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const k of FAM_KEYS) {
    const val = mode === 'theme' ? `var(--${FAM_THEME[k]})` : ((palette && palette[k]) || FAM_PALETTE[k])
    root.style.setProperty(`--fam-${k}`, val)
  }
}
// Akzent-/Look-Farbe einer Kachel (Rahmen-Brackets + Icon-Glow = --acc). Explizite Farbe (Theme-Keyword →
// var, sonst Hex) ODER — wenn KEINE gesetzt bzw. der alte „#222"-Sentinel — der THEME-Akzent. So folgt der
// Rahmen automatisch dem Theme, ohne dass jede Taste eine eigene Farbe hinterlegen muss; die Taste-Farbe ist
// nur noch ein OPTIONALER Override. ('#222' = historischer „keine Farbe"-Platzhalter → wie unset behandeln.)
export function accentVar(c, fb) {
  if (!c || c === '#222') return fb || 'var(--accent)'
  return resolveColor(c)
}

// Kachel-Stile (Verzierung einer flachen Taste) — [Wert, Label]. EINE Wahrheit für den Button-Editor
// (per Taste) UND die Theming-Seite (globaler Default). Muss zu deck.css `.s-*` + service `_TILE_SKINS` passen.
export const TILE_SKINS = [
  ['brackets', 'Eck-Brackets'], ['neon', 'Neon-Rahmen'], ['double', 'Doppellinie'], ['inset', 'Innen-Glow'],
  ['underline', 'Unterstrich'], ['dashed', 'Gestrichelt'], ['gradient', 'Verlaufs-Füllung'], ['scan', 'Scanlines'],
  ['cut', 'Schnittecke'], ['ring', 'Icon-Ring'], ['topbar', 'Kopfleiste'], ['plate', 'Tasten-Platte'],
  ['cornerglow', 'Eck-Leuchten'], ['plain', 'Schlicht'],
]
// Druck-/Touch-Bestätigungs-Modi (global) — [Wert, Label]. Muss zu deck.css `body[data-press="…"]` passen.
export const PRESS_MODES = [
  ['ring', 'Ring (Rahmen)'], ['innerglow', 'Innen-Glow'], ['backlight', 'Hintergrundlicht'],
  ['pop', 'Nur Pop'], ['lift', 'Anheben'],
]

// 🎨 Daten-Viz-Design-Varianten (rein additiv, generisch — gelten für JEDE Datenquelle des jeweiligen Typs;
// nichts sensor-/quellen-exklusives). [Wert, Label] — '' = Klassisch (bisheriges Design, Default). Der
// Renderer schaltet auf den Stil; unbekannte Werte fallen auf Klassisch zurück. Single-Source für Editor-
// Dropdowns (StreamDeck.jsx) UND die Render-Komponenten (widgets.jsx / TouchDeck.jsx).
export const GRAPH_VARIANTS = [
  ['', 'Klassisch (Glow-Linie)'], ['neon', 'Neon (starker Glow)'], ['minimal', 'Minimal (dünne Linie)'],
  ['dashed', 'Strichlinie'], ['bars', 'Balken-Verlauf'], ['gradient', 'Verlaufs-Linie'],
]
export const GAUGE_VARIANTS = [
  ['', 'Klassisch (270° Glow-Bogen)'], ['ring', 'Ring (360° Donut)'], ['half', 'Tacho (180°)'],
  ['ticks', 'Skala mit Strichen'], ['segments', 'Segmente (Zonen)'], ['minimal', 'Minimal (flacher Bogen)'],
]
export const BAR_VARIANTS = [
  ['', 'Klassisch (Glow-Füllung)'], ['segments', 'Segmente (LED)'], ['gradient', 'Zonen-Verlauf'],
  ['striped', 'Streifen'], ['minimal', 'Minimal (flach 2D)'],
]
export const FADER_VARIANTS = [
  ['', 'Klassisch'], ['modern', 'Modern (breit, Verlauf)'], ['glow', 'Neon-Glow'],
  ['flat', 'Flach 2D'], ['minimal', 'Minimal (Linie)'],
]
// VU-Meter-Stile des Faders (orthogonal zur Fader-Variante). '' = Segmente (Lämpchen, Default).
export const VU_VARIANTS = [
  ['', 'Segmente (Lämpchen)'], ['bar', 'Balken (durchgehend)'], ['line', 'Linie (Pegel-Strich)'],
  ['dots', 'Punkte (LED)'], ['none', 'Ohne VU'],
]

// Globaler Deck-„Look" (Kachel-Stil-Default / Druck-Bestätigung / Ordner-Rahmen). GENERISCH: von TouchDeck
// (Panel) UND StreamDeck (Editor-Vorschau) aus der Registry (`look`) angewandt → Cockpit + RigzDeck identisch,
// ohne Hüllen-Theme-System. Kachel-Stil/Druck-Modus als body-data (deck.css liest sie), Farben/Breite als Vars.
export const LOOK_DEFAULT = { tile: 'brackets', press: 'ring', pressColor: 'accent2', folder: true, folderColor: '#c8a44e', frame: true }
export function applyDeckLook(look) {
  const lk = { ...LOOK_DEFAULT, ...(look || {}) }
  try {
    const root = document.documentElement, body = document.body
    body.dataset.tilestyle = lk.tile || 'brackets'
    body.dataset.press = lk.press || 'ring'
    body.dataset.frame = lk.frame === false ? 'off' : 'on'   // Rahmen/Box global aus (CSS body[data-frame=off])
    root.style.setProperty('--press', resolveColor(lk.pressColor) || 'var(--accent2)')
    root.style.setProperty('--folder-w', lk.folder === false ? '0' : '2px')
    root.style.setProperty('--folder', resolveColor(lk.folderColor) || '#c8a44e')
    applyPalette(lk.palette, lk.colorMode)   // Daten-Viz-Familienfarben (fam:*) mit anwenden (Quelle/Theme + Edits)
  } catch (e) { /* headless / kein DOM */ }
}

export function resolveStyle(style, lay) {
  const s = style || {}
  const onoff = (v, d) => (v === 'on' ? true : v === 'off' ? false : d)
  return {
    title: onoff(s.title, lay.show_title !== false),
    label: onoff(s.label, lay.show_label !== false),
    label_pos: (s.label_pos === 'top' || s.label_pos === 'bottom') ? s.label_pos : (lay.label_pos || 'bottom'),
    // Position des großen Titel-Texts (über dem Bild, wie Stream Deck): oben | unten. Default unten.
    title_pos: (s.title_pos === 'top') ? 'top' : 'bottom',
    frame: onoff(s.frame, lay.frame !== false),
  }
}

// Stil → CSS-Klassen für eine Kachel (Touch .t-key bzw. Editor .sd-prev-key).
export function keyClass(eff, base) {
  return base
    + (eff.frame ? '' : ' noframe')
    + (eff.label_pos === 'top' ? ' lbl-top' : '')
    + (eff.label ? '' : ' lbl-off')
    + (eff.title ? '' : ' title-off')
    + (eff.title_pos === 'top' ? ' ttl-top' : '')
}

// Deck-Items nach der (deck-eigenen) Kategorie-Liste gruppieren + „Ohne Kategorie"-Eimer.
// items: [{button, category, style, hidden}], categories: [name] (Reihenfolge = Anzeige).
// includeHidden=false → ausgeblendete Items raus (Tablet); true → behalten (Editor, grau).
// Benannte Kategorien bleiben IMMER erhalten (als Drop-Ziele im Editor); leerer „Ohne
// Kategorie"-Eimer fällt weg.
export function groupDeckItems(items, categories, includeHidden) {
  const catSet = new Set(categories || [])
  const groups = (categories || []).map((name) => ({ name, items: [] }))
  const byName = {}; for (const g of groups) byName[g.name] = g
  const uncat = { name: UNCAT, items: [] }
  for (const it of items || []) {
    if (!includeHidden && it.hidden) continue
    const g = (it.category && catSet.has(it.category)) ? byName[it.category] : uncat
    g.items.push(it)
  }
  return [...groups, uncat].filter((g) => g.items.length || g.name !== UNCAT)
}
