import { useEffect, useState, useRef } from 'preact/hooks'
import { getJSON, postJSON } from './api.js'
import { useEventStream } from './sse.js'
import { DECK_LAYOUT_DEF, resolveStyle, keyClass, groupDeckItems } from './deckstyle.js'
import { Clock, Gauge, Readout, fontStack, widgetFontSize } from './widgets.jsx'
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
//
// VOLLBILD (fullscreen): ein ⛶-Knopf in der Deck-Leiste schaltet „nur das aktive Deck" — die
// Deck-Auswahl + der Knopf selbst verschwinden und es wird `body.dc-deck-fs` gesetzt, worüber die
// Host-Hülle ihre EIGENE Navigation ausblendet (Kern bleibt host-agnostisch). Zurück per Wisch von
// oben nach unten (oder Escape). Die Ordner-Navigation (.t-nav) bleibt im Vollbild nutzbar.

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
  const [pct, setPct] = useState(null)
  const [fps, setFps] = useState(0)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let alive = true, n = 0
    const tick = () => {
      getJSON('/api/frametime/series?kind=' + kind).then((d) => {
        if (!alive) return
        setData(d.data || [])
        setMsg((d.data && d.data.length > 1) ? null : (d.reason || (d.available ? 'warte auf ein Spiel' : 'PresentMon fehlt')))
      }).catch(() => {})
      if (n % 9 === 0) getJSON('/api/frametime/status').then((d) => { if (alive) { setPct(d.percentiles || null); setFps(d.fps || 0) } }).catch(() => {})  // ~2.5 Hz: Perzentile + fps fürs Zeitfenster
      n++
    }
    tick()
    const iv = setInterval(tick, 55)   // ~18 Hz — flüssig + RTSS-näher; Last niedrig (kleiner Ring, ~100 Punkte)
    return () => { alive = false; clearInterval(iv) }
  }, [kind])
  if (msg && (!data || data.length < 2)) return <div class="t-spark-msg">{msg}</div>
  // Frametime: FESTES ~2,6-s-Zeitfenster (fps-abhängige Frame-Zahl, da echte Per-Frame-Daten) → ruhiger, RTSS-
  //   ähnlicher Verlauf statt sub-sekündlichem Geflacker. FPS: ~20 s, ausgedünnt + geglättet.
  if (kind === 'frametime') {
    // Backend liefert fixe ~32–60 Hz (Median je Loop, grobe Spikes durchgereicht) → kürzeres Fenster
    // (100 Samples ≈ 3 s) läuft RTSS-artig zügig durch, fps-unabhängig, gleichmäßiges Scrollen.
    return <FrametimeSpark data={data.slice(-100)} pct={pct} color={isDim(color) ? '#39d8ff' : color} />
  }
  return <Sparkline data={downsample(data, 240)} color={isDim(color) ? '#37e0a3' : color} minSpan={kind === 'fps' ? 40 : 0} pct={pct} />
}

// Spike-erhaltende Render-Verdichtung (Max je Bucket): eine SVG-Linie braucht nie mehr Punkte als die Kachel
// breit ist — 1000+ Per-Frame-Punkte bei hoher Rate würgen schwache Tablets ab (Ruckeln + Verbindungsabbruch,
// weil der Hauptthread den SSE-Stream nicht mehr bedient). Max je Bucket erhält Spikes (anders als „jeden N-ten").
function dsMaxBucket(arr, target) {
  if (arr.length <= target) return arr
  const out = new Array(target), step = arr.length / target
  for (let i = 0; i < target; i++) {
    let m = 0
    const a = Math.floor(i * step), b = Math.min(arr.length, Math.floor((i + 1) * step))
    for (let j = a; j < b; j++) if (arr[j] > m) m = arr[j]
    out[i] = m
  }
  return out
}

// Frametime-Spike-Graph im RTSS/Afterburner-Stil: FESTE, ruhige Y-Skala (base×4, Median über mehrere Sekunden →
// atmet NICHT bei jedem Spike), Spikes clippen oben statt die ganze Kurve zu reskalieren. Fixe ms-Referenzlinien
// (60/120/144 fps), Flächen-Glow, scharfe Per-Frame-Linie, rote Glow-Beams bei echten Spikes (>2.2× Baseline) +
// 1%-low/avg-Readout aus echten PresentMon-Perzentilen. Quelle = pmConsumeFrames (jeder Frame erfasst),
// Anzeige-Ring = 60-Hz-Fixrate (schlimmster Frame je Loop) → Spikes erhalten + gleichmäßiges Scrollen.
function FrametimeSpark({ data, pct, color }) {
  const arr = (data || []).filter((v) => v > 0)
  if (arr.length < 2) return <div class="t-spark t-spark-wait" />
  const sorted = arr.slice().sort((a, b) => a - b)
  const base = sorted[Math.floor(sorted.length * 0.5)] || 1        // Median über das ganze (mehrsekündige) Fenster = sehr stabil
  const disp = dsMaxBucket(arr, 220)                               // nur ~220 SVG-Punkte rendern (Spikes erhalten) → kein Tablet-Ruckeln/Disconnect
  const W = 100, H = 36, n = disp.length
  // FESTE Skala = base×4: der Median ist über Sekunden stabil → die Skala ATMET NICHT mehr bei jedem Spike.
  // Spikes clippen oben („an die Decke", prominent) statt die ganze Kurve groß/klein zu reskalieren (= das Geflacker).
  const scale = Math.max(base * 4, 0.1)
  const px = (i) => (i / (n - 1)) * W
  const py = (v) => H - Math.max(0, Math.min(1, v / scale)) * (H - 2) - 1
  const c = color || '#39d8ff'
  const line = disp.map((v, i) => px(i).toFixed(1) + ',' + py(v).toFixed(1)).join(' ')
  const refs = [[16.67, '60'], [8.33, '120'], [6.94, '144']].filter(([ms]) => ms < scale * 0.96)   // fixe ms-Linien, nur wenn im Bild
  const beams = []
  for (let i = 0; i < n; i++) {
    if (disp[i] > base * 2.2) {                                    // echter Spike (deutlich über Baseline)
      const inten = Math.max(0.3, Math.min(1, (disp[i] - base * 2.2) / (base * 4)))
      beams.push({ x: px(i), y: py(disp[i]), inten, k: i })
    }
  }
  const lx = px(n - 1), ly = py(disp[n - 1])
  const gid = 'ftg_' + (c.replace('#', '') || 'x')
  return (
    <div class="t-graph">
      <svg class="t-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color={c} stop-opacity="0.30" /><stop offset="1" stop-color={c} stop-opacity="0" />
        </linearGradient></defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${gid})`} />
        {refs.map(([ms, lbl]) => <line key={lbl} x1="0" y1={py(ms).toFixed(1)} x2={W} y2={py(ms).toFixed(1)}
              stroke="#6c84a0" stroke-width="0.5" stroke-dasharray="1.5 3" opacity="0.4" vector-effect="non-scaling-stroke" />)}
        {beams.map((s) => <line key={s.k} x1={s.x.toFixed(1)} y1={H} x2={s.x.toFixed(1)} y2={s.y.toFixed(1)}
              stroke="#ff5d5d" stroke-width={(0.6 + s.inten).toFixed(1)} opacity={(0.18 + s.inten * 0.4).toFixed(2)}
              vector-effect="non-scaling-stroke" style={`filter:drop-shadow(0 0 ${(1 + s.inten * 2.5).toFixed(0)}px #ff5d5d)`} />)}
        <polyline points={line} fill="none" stroke={c} stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"
                  vector-effect="non-scaling-stroke" style={`filter:drop-shadow(0 0 2px ${c})`} />
      </svg>
      <span class="t-graph-dot" style={`left:${lx.toFixed(1)}%;top:${(ly / H * 100).toFixed(1)}%;background:${c};box-shadow:0 0 6px ${c}`} />
      {refs.map(([ms, lbl]) => <span key={lbl} class="t-graph-ref" style={`top:${(py(ms) / H * 100).toFixed(1)}%`}>{lbl}</span>)}
      {pct && pct.frametime_1pct ? <span class="t-graph-lbl t-graph-max" style="color:#ff8a8a">1%↑ {pct.frametime_1pct}ms</span> : null}
    </div>
  )
}

// Mini-Verlaufskurve (Sparkline) aus einer Zahlenreihe — autoskaliert auf Min/Max der Daten.
// Politur: Fläche unter der Kurve gefüllt, Live-Punkt am aktuellen Wert, Min/Max-Werte in den Ecken.
// Stat-Kachelfarbe: Kategoriefarbe (v.color), bei festem Bereich + oberste 20% (crit) → ROT. Sonst CSS-Gold.
function statStyle(v, o) {
  let sc = (v.color && !isDim(v.color)) ? v.color : null
  if (o && Number.isFinite(+o.min) && Number.isFinite(+o.max) && o.crit !== false && v.value != null && v.value !== '') {
    const t = (+v.value - +o.min) / ((+o.max - +o.min) || 1)
    if (t >= 0.8) sc = '#ff5252'
  }
  return sc ? `color:${sc};text-shadow:0 0 9px ${sc}88,0 0 2px ${sc}` : ''
}

function Sparkline({ data, color, minSpan, pct, opts, uid }) {
  const arr = data || []
  if (arr.length < 2) return <div class="t-spark t-spark-wait" />
  const o = opts || {}
  const fixed = Number.isFinite(+o.min) && Number.isFinite(+o.max) && +o.max > +o.min   // feste Skala aus min/max (genagelt)
  let dmin = Infinity, dmax = -Infinity
  for (const v of arr) { if (v < dmin) dmin = v; if (v > dmax) dmax = v }
  let lo, hi
  if (fixed) { lo = +o.min; hi = +o.max }
  else {
    lo = dmin; hi = dmax
    if (lo === hi) { lo -= 1; hi += 1 }            // flache Linie nicht durch 0 teilen
    const mid = (lo + hi) / 2
    const span = Math.max((hi - lo) * 1.3, minSpan || 0)   // ≥ minSpan (FPS: 40 fps fest) → kleine Wackler bleiben klein
    lo = mid - span / 2; hi = mid + span / 2
  }
  const W = 100, H = 36, n = arr.length
  const px = (i) => (i / (n - 1)) * W
  const py = (v) => Math.max(1, Math.min(H - 1, H - ((v - lo) / (hi - lo)) * H))   // bei fester Skala in der Kachel halten
  const path = smoothPath(arr.map((v, i) => [px(i), py(v)]))   // weiche Bezier-Kurve statt kantiger Geraden
  const lx = px(n - 1), ly = py(arr[n - 1])
  const c = isDim(color) ? '#39d8ff' : color
  const fmt = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  // Kritischer Bereich = oberste 20% (nur bei fester Skala + crit !== false): rote Zone + Linie wird darin rot.
  const crit = fixed && o.crit !== false
  const critY = crit ? py(lo + (hi - lo) * 0.8) : 0
  const curCrit = crit && arr[n - 1] >= lo + (hi - lo) * 0.8
  const cid = 'crit_' + String(uid || 'x').replace(/[^a-z0-9_]/gi, '')
  return (
    <div class="t-graph">
      <svg class="t-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {crit && <defs><clipPath id={cid}><rect x="0" y="0" width={W} height={critY.toFixed(1)} /></clipPath></defs>}
        {crit && <rect x="0" y="0" width={W} height={critY.toFixed(1)} fill="#ff4d4d" opacity="0.1" />}
        <path d={`${path} L ${W} ${H} L 0 ${H} Z`} fill={c} opacity="0.16" stroke="none" />
        <path d={path} fill="none" stroke={c} stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"
              style={`filter:drop-shadow(0 0 2.5px ${c})`} />
        {crit && <path d={path} fill="none" stroke="#ff5252" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
              vector-effect="non-scaling-stroke" clip-path={`url(#${cid})`} style="filter:drop-shadow(0 0 2.5px #ff5252)" />}
        {crit && <line x1="0" y1={critY.toFixed(1)} x2={W} y2={critY.toFixed(1)} stroke="#ff5252" stroke-width="0.5"
              stroke-dasharray="2 2" opacity="0.5" vector-effect="non-scaling-stroke" />}
      </svg>
      <span class="t-graph-dot" style={`left:${lx.toFixed(1)}%;top:${(ly / H * 100).toFixed(1)}%;background:${curCrit ? '#ff5252' : c};box-shadow:0 0 6px ${curCrit ? '#ff5252' : c}`} />
      {pct && pct.fps_1pct_low
        ? <span class="t-graph-lbl t-graph-max" style="color:#ff8a8a">1%↓ {Math.round(pct.fps_1pct_low)}</span>
        : <span class="t-graph-lbl t-graph-max">{fmt(dmax)}</span>}
      {pct && pct.fps_avg
        ? <span class="t-graph-lbl t-graph-min">Ø {Math.round(pct.fps_avg)}</span>
        : <span class="t-graph-lbl t-graph-min">{fmt(dmin)}</span>}
    </div>
  )
}

// Vertikaler Fader: Schieberegler (vertikal ziehen = Level setzen) + Live-VU-Säule daneben;
// Tippen OHNE Ziehen = Mute-Toggle. REINE Panel-Kachel — das physische Stream Deck zeigt stattdessen
// Titel/Level% + Druck=Mute (Backend _act_wavelink / _act_winaudio). Zwei Quellen über den Monitor-Typ:
//   • wavelink_level → Wave-Link Mix/Channel (meters/state = geteilte Wave-Link-Polls).
//   • winaudio_volume → der allgemeine Windows-Master-Lautstärkeregler (wa = geteilter winaudio-Poll).
// Alle Polls sind vom Deck GETEILT (ein Request für ALLE Fader, nicht pro Kachel).
// Akzentfarbe abdunkeln (unteres Ende des Fill-Gradients) — reines Hex -> rgb().
function darken(hex, f) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#173a63'
  const n = parseInt(m[1], 16)
  const c = (x) => Math.max(0, Math.min(255, Math.round(x * f)))
  return 'rgb(' + c((n >> 16) & 255) + ',' + c((n >> 8) & 255) + ',' + c(n & 255) + ')'
}

// Windows-Audio liefert einen ROHEN Linear-Peak (0..1) — optisch sehr niedrig (anders als Wave Links
// perzeptueller Prozent-Pegel). Auf eine dBFS-Skala (-48..0 dB) mappen, damit die VU genauso lebendig
// füllt wie die Wave-Link-Säulen. (-48 dB = leer, 0 dB = voll; Empfindlichkeit über die 48 justierbar.)
function waMeter(p) {
  p = +p
  if (!(p > 0)) return 0
  const db = 20 * Math.log10(p)
  return Math.max(0, Math.min(1, (db + 48) / 48))
}

// Dunkle/leere Linienfarbe (z.B. die #222-Kachelfarbe) → durch eine kräftige Glow-Farbe ersetzen, damit
// Graphen NIE „grau auf grau" sind. Luminanz < 70 = zu dunkel.
function isDim(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return true
  const n = parseInt(m[1], 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 70
}

// Catmull-Rom → kubische Bezier: weiche Kurve durch die Punkte (statt kantiger Geraden).
function smoothPath(pts) {
  if (!pts || pts.length < 3) return 'M ' + (pts || []).map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ')
  let d = 'M ' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1)
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1)
  }
  return d
}
// Auf ~target Punkte ausdünnen (kleine Kachel braucht keine 1200 Punkte; hält den Spline performant).
function downsample(arr, target) {
  if (!arr || arr.length <= target) return arr || []
  const step = arr.length / target, out = []
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)])
  return out
}

function Fader({ id, v, mon, meters, state, wa, dev, app, proc, onMute, iconOnly }) {
  const isWa = mon.type === 'winaudio_volume'
  const isApp = mon.type === 'app_volume'
  const ttype = mon.target_type || 'mix'
  const targetId = mon.id || mon.target || ''
  const mixId = mon.mix_id || ''
  const meterId = mon.id || mon.target || targetId
  const trackRef = useRef(null)
  const movedRef = useRef(false)
  const downYRef = useRef(null)                 // Start-Y eines aktiven Zeigers (null = inaktiv) — Tap/Drag-Guard
  const sentRef = useRef(0)
  const [drag, setDrag] = useState(null)        // lokaler Level beim Ziehen (0..100) | null
  const [optMute, setOptMute] = useState(null)  // optimistischer Mute direkt nach Tap | null

  const st = isWa ? (wa || {}) : isApp ? (app || {}) : (state[targetId] || {})
  const baseLevel = Number.isFinite(st.level) ? st.level : (Number(v.value) || 0)
  const level = drag != null ? drag : baseLevel
  const muted = optMute != null ? optMute : !!st.muted
  const mlvl = (isWa || isApp) ? waMeter(st.peak) : Math.max(0, Math.min(1, (meters[meterId]) || 0))
  const accentHex = (v.color && /^#[0-9a-f]{6}$/i.test(v.color) && v.color !== '#222') ? v.color : '#4ea1ff'
  const accentDim = darken(accentHex, 0.34)
  const name = v.label || v.title || id
  // App-Icon: explizit gesetztes v.image, sonst live aus der .exe des Programms (App-Fader).
  const imgSrc = v.image || (isApp && proc ? '/api/winaudio/app_icon?proc=' + encodeURIComponent(proc) : '')
  const hideImg = (e) => { try { e.currentTarget.style.display = 'none' } catch (_) {} }

  // Peak-Hold („Schlepp-Zeiger"): trackt den Spitzenpegel, hält ihn ~1,2 s, fällt dann weich.
  // Bewegt das Marker-Element direkt per DOM (rAF) → kein Re-Render, butterweich.
  const peakRef = useRef(null)
  const mlvlRef = useRef(0); mlvlRef.current = mlvl
  const mutedRef = useRef(false); mutedRef.current = muted
  useEffect(() => {
    let raf, last = 0
    const pk = { v: 0, t: 0 }, HOLD = 1200, FALL = 0.0011
    const loop = (now) => {
      if (!last) last = now
      const dt = now - last; last = now
      const m = mutedRef.current ? 0 : mlvlRef.current
      if (m >= pk.v) { pk.v = m; pk.t = now }
      else if (now - pk.t > HOLD) { pk.v = Math.max(0, pk.v - FALL * dt) }
      const el = peakRef.current
      if (el) { el.style.bottom = (pk.v * 100) + '%'; el.style.opacity = (!mutedRef.current && pk.v > 0.04) ? '1' : '0' }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const levelAt = (clientY) => {
    const el = trackRef.current
    if (!el) return level
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(100, Math.round((1 - (clientY - r.top) / r.height) * 100)))
  }
  const push = (lvl, force) => {
    const t = Date.now()
    if (!force && t - sentRef.current < 45) return     // ~22 Hz drosseln
    sentRef.current = t
    if (isApp) postJSON('/api/winaudio/app_volume', { proc: proc || '', level: lvl }).catch(() => {})
    else if (isWa) postJSON('/api/winaudio/volume', { level: lvl, device_id: dev || '' }).catch(() => {})
    else postJSON('/api/wavelink/level', { target_type: ttype, id: targetId, level: lvl, mix_id: mixId }).catch(() => {})
  }
  // Tap vs. Drag NUR über Refs (kein State-Timing/Closure-Problem): „bewegt" = >4 px gegen die DOWN-
  // Position (NICHT gegen den Füllstand — sonst gilt jeder Tap neben dem Knopf als Drag → kein Mute).
  const onDown = (e) => {
    e.stopPropagation()
    movedRef.current = false
    downYRef.current = e.clientY
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
  }
  const onMove = (e) => {
    if (downYRef.current == null) return
    e.stopPropagation()
    if (!movedRef.current && Math.abs(e.clientY - downYRef.current) > 4) movedRef.current = true
    if (movedRef.current) {
      const l = levelAt(e.clientY)
      setDrag(l)
      push(l, false)
    }
  }
  const onUp = (e) => {
    if (downYRef.current == null) return
    e.stopPropagation()
    downYRef.current = null
    if (movedRef.current) {
      push(levelAt(e.clientY), true)                 // finalen Wert sicher senden
    } else {                                          // Tap ohne Bewegung = Mute (toggle)
      setOptMute(!muted)
      if (isApp) postJSON('/api/winaudio/app_mute', { proc: proc || '' }).catch(() => {})
      else if (isWa) postJSON('/api/winaudio/mute', { device_id: dev || '' }).catch(() => {})
      else onMute()                                   // Wave Link: über den Button-Press (mix/channel_mute)
      setTimeout(() => setOptMute(null), 1500)
    }
    setDrag(null)
  }

  // VU-Färbung: oberes Drittel (ab 2/3) orange, oberes Viertel (ab 3/4) rot, sonst grün.
  const SEGS = 19, segs = []
  for (let i = 0; i < SEGS; i++) {
    const thr = (i + 1) / SEGS
    const cls = thr > 0.75 ? 'r' : thr > 0.667 ? 'y' : 'g'
    segs.push(<span key={i} class={'t-vu-seg' + (mlvl >= thr - 0.0001 ? ' on ' + cls : '')} />)
  }
  return (
    <div class={'t-fader' + (muted ? ' muted' : '') + (isApp && st.available === false ? ' off' : '')} style={`--acc:${accentHex};--acc-dim:${accentDim}`}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div class="t-fader-name" title={name}>
        {iconOnly
          ? (imgSrc ? <img class="t-fader-name-img" src={imgSrc} alt={name} onError={hideImg} />
             : <span class="t-fader-name-emo">{v.icon || name}</span>)
          : name}
      </div>
      <div class="t-fader-body">
        <div class="t-fader-track" ref={trackRef}>
          <div class="t-fader-fill" style={`height:${level}%`} />
          <div class="t-fader-knob" style={`bottom:${level}%`} />
        </div>
        <div class="t-fader-vu">{segs}<div class="t-vu-peak" ref={peakRef} /></div>
      </div>
      <div class="t-fader-foot">{isApp && st.available === false ? '— App aus' : isWa && st.available === false ? '— n/v' : muted ? '🔇 stumm' : level + '%'}</div>
      {!iconOnly && (imgSrc
        ? <div class="t-fader-icon t-fader-img" title={name}><img src={imgSrc} alt="" onError={hideImg} /></div>
        : v.icon ? <div class="t-fader-icon" title={name}>{v.icon}</div> : null)}
    </div>
  )
}

// Interaktives Audio-Mixer-Deck (deck.auto==='audio_mixer'): rendert LIVE den Windows-Master + je
// laufendem Programm einen Fader (minus Ausblend-Liste). Pollt selbst (Liste ~1,5 s; Pegel ~90 ms) →
// Programme erscheinen/verschwinden automatisch. Reine Panel-Schicht — nutzt dieselbe <Fader>-Kachel.
// Master IMMER zuerst. Nicht manuell editierbar (kein statisches Item-Modell).
function AudioMixer({ hidden, gridStyle, w, h, iconOnly }) {
  const [apps, setApps] = useState([])
  const [waSnap, setWaSnap] = useState({})       // '' = Windows-Master
  const [appSnap, setAppSnap] = useState({})     // proc -> {available,level,muted,peak}
  const hideKey = JSON.stringify((hidden || []).map((x) => String(x).toLowerCase()).sort())
  // Live-Liste der tönenden Programme (minus Ausblend-Liste) — Apps erscheinen/verschwinden automatisch.
  useEffect(() => {
    const hide = new Set(JSON.parse(hideKey))
    let alive = true
    const poll = () => getJSON('/api/winaudio/sessions')
      .then((d) => { if (alive) setApps((d.sessions || []).filter((s) => s.proc && !hide.has(String(s.proc).toLowerCase()))) })
      .catch(() => {})
    poll(); const iv = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(iv) }
  }, [hideKey])
  // Pegel/VU schnell: Master + jede sichtbare App.
  const procKey = JSON.stringify(apps.map((a) => a.proc))
  useEffect(() => {
    let alive = true
    const poll = () => {
      getJSON('/api/winaudio/volume').then((d) => { if (alive) setWaSnap({ '': d || {} }) }).catch(() => {})
      JSON.parse(procKey).forEach((p) => getJSON('/api/winaudio/app_volume?proc=' + encodeURIComponent(p))
        .then((d) => { if (alive) setAppSnap((s) => ({ ...s, [p]: d || {} })) }).catch(() => {}))
    }
    poll(); const iv = setInterval(poll, 90)
    return () => { alive = false; clearInterval(iv) }
  }, [procKey])
  const noop = () => {}
  const fw = Math.max(1, Math.min(4, w || 1)), fh = Math.max(1, Math.min(4, h || 2))   // Fader-Spannweite (Felder), in der Kategorie einstellbar
  // ⚠ .t-key ist per Default quadratisch (aspect-ratio 1/1) — erst die Klasse .spanned löst das auf und
  // lässt die Kachel die gespannte Grid-Fläche füllen (sonst bleibt der Fader 1×1, nur mit Lücke darunter).
  const tileCls = 't-key t-fader-key cqsize' + ((fw > 1 || fh > 1) ? ' spanned' : '')
  const tileStyle = `background:var(--bg);grid-column:span ${fw};grid-row:span ${fh}`
  return (
    <div class="t-deck-grid" style={gridStyle + ';grid-auto-rows:var(--sd-size)'}>
      <div class={tileCls} style={tileStyle}>
        <Fader id="__master__" v={{ label: 'Windows', color: '#34d39a', icon: '🔊' }} mon={{ type: 'winaudio_volume' }}
               meters={{}} state={{}} wa={waSnap[''] || {}} dev="" onMute={noop} iconOnly={iconOnly} />
      </div>
      {apps.map((a) => (
        <div key={a.proc} class={tileCls} style={tileStyle}>
          <Fader id={'app_' + a.proc} v={{ label: a.name || a.proc, color: '#a855f7' }} mon={{ type: 'app_volume' }}
                 meters={{}} state={{}} app={appSnap[a.proc] || {}} proc={a.proc} onMute={noop} iconOnly={iconOnly} />
        </div>
      ))}
      {!apps.length && <div class="t-empty" style="grid-column:1/-1;margin:14px auto;font-size:13px">Warte auf Programme mit Ton … (der Master links regelt die Windows-Gesamtlautstärke)</div>}
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
  // Tasten-Größe = button_size des Ordner-Decks (derselbe Layout-Schieber wie im Raster; bei Ordnern
  // sonst ungenutzt) → die Radial-Größe ist ganz normal im UI einstellbar. Default 88 = wie bisher.
  const size = Math.max(48, Math.min(240, ((deck && deck.layout && deck.layout.button_size) || 88)))
  const margin = 14, keyHalf = Math.round(size / 2) + 2
  const vw = (typeof window !== 'undefined' ? window.innerWidth : 1024)
  const vh = (typeof window !== 'undefined' ? window.innerHeight : 768)
  // Radius wächst mit Knopf-Zahl UND -Größe → genug Bogen-Abstand, dass sich nichts überlappt.
  const minR = (size * N) / (2 * Math.PI) * 1.08
  let R = Math.max(60 + N * 16, minR)
  // Randerkennung 1/2: Radius so weit verkleinern, dass der ganze Kreis in den Viewport passt.
  const maxR = Math.max(64, Math.min((vw - 2 * margin) / 2 - keyHalf, (vh - 2 * margin) / 2 - keyHalf))
  R = Math.min(R, maxR)
  // Randerkennung 2/2: Mittelpunkt so klemmen, dass kein Knopf über den Rand ragt (am Anker, sonst rein).
  const ext = R + keyHalf
  const cx = Math.min(Math.max(anchor.x, margin + ext), vw - margin - ext)
  const cy = Math.min(Math.max(anchor.y, margin + ext), vh - margin - ext)
  return (
    <div class="t-radial-backdrop" onClick={onClose}>
      <div class={'t-radial' + (shown ? ' in' : '')} style={`left:${cx}px;top:${cy}px;--rk:${size}px`}
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
  const [optsById, setOptsById] = useState({})       // button-id → opts (Schrift/Farbe/Uhr-Modus für Text/Uhr-Buttons)
  const histRef = useRef({})                         // button-id → Zahlenreihe (Verlauf für Graph-Kacheln)
  const [wlMeters, setWlMeters] = useState({})       // Wave-Link VU-Pegel {id:0..1} (geteilter schneller Poll)
  const [wlState, setWlState] = useState({})         // Wave-Link {id:{level,muted}} (geteilter langsamer Poll)
  const [waSnap, setWaSnap] = useState({})           // Windows-Master {available,level,muted,peak} (geteilter Poll)
  const [appSnap, setAppSnap] = useState({})         // App-Mixer pro Programm {proc:{available,level,muted,peak}} (geteilter Poll)
  const [navStack, setNavStack] = useState([])       // Ordner-Drilldown (replace-Modus)
  const [overlay, setOverlay] = useState(null)       // {deck, anchor:{x,y}} — Radial-Menü
  // Vollbild-Deck: nur das aktive Deck, Chrome weg. Beim Laden den LETZTEN Zustand wiederherstellen
  // (App-Neustart / Reconnect-Reload landen sonst auf der Nicht-Vollbild-Ansicht). Das aktive Deck merkt
  // sich `sd.deck` bereits → zusammen wird die Ansicht 1:1 wiederhergestellt.
  const [fullscreen, setFullscreen] = useState(() => {
    try { return localStorage.getItem('sd.fullscreen') === '1' } catch { return false }
  })
  const [deckFlash, setDeckFlash] = useState('')     // kurz eingeblendeter Deck-Name beim Vollbild-Wisch
  const [slideDir, setSlideDir] = useState(0)        // Slide-Animation beim Side-Scroll: +1 nächstes / -1 voriges / 0 keine
  const [pull, setPull] = useState(0)                // Pull-to-Refresh: aktuelle Zugdistanz (px) für den Indikator
  const swipeRef = useRef(null)                       // Touch-Start für „Wisch-zum-Beenden"/Pull
  const pullRef = useRef(0)                            // live Zugdistanz (Entscheidung beim Loslassen, lag-frei)
  const flashT = useRef(null)

  const loadReg = () => getJSON('/api/streamdeck/registry').then((d) => {
    const dks = d.decks || []
    setDecks(dks)
    const def = d.default_deck || 'main'
    setDefaultDeck(def)
    setDeck((cur) => (cur && dks.some((x) => x.id === cur)) ? cur : pickInitialDeck(dks, def))
    const am = {}, rm = {}, mm = {}, om = {}
    for (const b of d.buttons || []) { am[b.id] = b.action || {}; rm[b.id] = b.render || 'value'; mm[b.id] = b.monitor || {}; om[b.id] = b.opts || {} }
    setActionById(am); setRenderById(rm); setMonById(mm); setOptsById(om)
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

  // Fader brauchen Live-Daten — EIN geteilter Poll JE QUELLE (nicht pro Kachel), nur wenn eine solche
  // Fader-Kachel existiert. Wave Link: VU schnell + Level/Mute langsam. Windows-Master: ein Poll (der
  // Peak ändert schnell, Level/Mute kommen gratis mit). Quelle = der Monitor-Typ des Fader-Buttons.
  const faderMons = Object.entries(monById).filter(([fid]) => renderById[fid] === 'fader')
  const hasWlFader = faderMons.some(([, m]) => { const ty = (m || {}).type; return ty !== 'winaudio_volume' && ty !== 'app_volume' })
  // Windows-Volume-Fader können je auf ein anderes Gerät zeigen ('' = Standard) → pro DISTINKTEM Gerät ein Poll.
  // Das Gerät steht an der AKTION des Fader-Buttons (device_id), nicht am Monitor.
  const waDevices = [...new Set(faderMons.filter(([fid, m]) => (m || {}).type === 'winaudio_volume')
    .map(([fid]) => (actionById[fid] || {}).device_id || ''))]
  const waKey = JSON.stringify(waDevices)   // [] vs [''] MUSS sich unterscheiden — join('|') macht beide zu '', dann startet der Poll nie
  // App-Mixer-Fader: pro DISTINKTEM Programm (app_proc, an der Aktion) ein Poll auf den App-Snapshot.
  const appProcs = [...new Set(faderMons.filter(([fid, m]) => (m || {}).type === 'app_volume')
    .map(([fid]) => (actionById[fid] || {}).app_proc || '').filter(Boolean))]
  const appKey = JSON.stringify(appProcs)
  useEffect(() => {
    if (!hasWlFader) return
    let alive = true
    const buildState = (snap) => {
      const m = {}
      for (const x of (snap.mixes || [])) m[x.id] = { level: Math.round((x.level || 0) * 100), muted: !!x.isMuted }
      for (const c of (snap.channels || [])) m[c.id] = { level: Math.round((c.level || 0) * 100), muted: !!c.isMuted }
      return m
    }
    const pollMeters = () => getJSON('/api/wavelink/meters').then((d) => { if (alive) setWlMeters(d.meters || {}) }).catch(() => {})
    const pollState = () => getJSON('/api/wavelink/state').then((d) => { if (alive) setWlState(buildState(d)) }).catch(() => {})
    pollMeters(); pollState()
    const im = setInterval(pollMeters, 90), is = setInterval(pollState, 1600)
    return () => { alive = false; clearInterval(im); clearInterval(is) }
  }, [hasWlFader])
  useEffect(() => {
    if (!waDevices.length) return
    let alive = true
    const poll = () => waDevices.forEach((dev) =>
      getJSON('/api/winaudio/volume' + (dev ? '?device=' + encodeURIComponent(dev) : ''))
        .then((d) => { if (alive) setWaSnap((s) => ({ ...s, [dev]: d || {} })) }).catch(() => {}))
    poll()
    const iv = setInterval(poll, 90)
    return () => { alive = false; clearInterval(iv) }
  }, [waKey])
  useEffect(() => {
    if (!appProcs.length) return
    let alive = true
    const poll = () => appProcs.forEach((proc) =>
      getJSON('/api/winaudio/app_volume?proc=' + encodeURIComponent(proc))
        .then((d) => { if (alive) setAppSnap((s) => ({ ...s, [proc]: d || {} })) }).catch(() => {}))
    poll()
    const iv = setInterval(poll, 90)
    return () => { alive = false; clearInterval(iv) }
  }, [appKey])

  // Vollbild: body-Klasse umschalten (die Host-Hülle blendet darüber ihre EIGENE Nav aus), Escape
  // beendet (Desktop). Aufräumen beim Unmount, damit die Klasse nie hängenbleibt.
  useEffect(() => {
    try { document.body.classList.toggle('dc-deck-fs', fullscreen) } catch {}
    try { localStorage.setItem('sd.fullscreen', fullscreen ? '1' : '0') } catch {}
  }, [fullscreen])
  useEffect(() => () => { try { document.body.classList.remove('dc-deck-fs') } catch {} }, [])
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const switchDeck = (id) => {
    setDeck(id); setNavStack([]); setOverlay(null)
    try { localStorage.setItem('sd.deck', id) } catch {}
  }
  // Vollbild-Side-Scroll: zum nächsten/vorigen Top-Level-Deck (dir=+1/-1), umlaufend. Blendet kurz den
  // Deck-Namen ein (im Vollbild gibt's keine Tableiste → man sieht sonst nicht, auf welchem Deck man landet).
  const cycleDeck = (dir) => {
    const list = visibleDecks
    if (list.length < 2) return
    const i = Math.max(0, list.findIndex((d) => d.id === tabSel))
    const nd = list[(i + dir + list.length) % list.length]
    setSlideDir(dir)   // löst die Slide-Animation aus (nur beim Side-Scroll, nicht bei Tab/Ordner)
    switchDeck(nd.id)
    setDeckFlash(nd.label || nd.id)
    clearTimeout(flashT.current)
    flashT.current = setTimeout(() => setDeckFlash(''), 1100)
  }
  const goBack = () => { setSlideDir(0); setNavStack((s) => s.slice(0, -1)) }
  const closeOverlay = () => setOverlay(null)

  // Cache-umgehender Hard-Reload (frische index.html → frisches Bundle; Tablet muss die App nicht mehr
  // schließen/öffnen). Cache-Bust per Query-Param + replace (keine History-Einträge).
  const hardReload = () => {
    try { const u = new URL(location.href); u.searchParams.set('_r', String(Date.now())); location.replace(u.toString()) }
    catch (_) { location.reload() }
  }
  // EINE Top-Pull-Geste (Entscheidung beim Loslassen → kein Konflikt): kurz ziehen = Vollbild verlassen
  // (nur im Vollbild), WEIT ziehen = Pull-to-Refresh (neu laden). Greift nur am Deck-Anfang (scrollTop≈0),
  // normales Scrollen/Tippen bleibt unberührt. Plus: horizontaler Wisch = Deck wechseln (nur Vollbild).
  const PULL_EXIT = 75, PULL_REFRESH = 150
  const onTouchStart = (e) => {
    const t = e.touches && e.touches[0]
    swipeRef.current = t ? { x: t.clientX, y: t.clientY, top: ((e.currentTarget && e.currentTarget.scrollTop) || 0) <= 2 } : null
    pullRef.current = 0
  }
  const onTouchMove = (e) => {
    const s = swipeRef.current; if (!s) return
    const t = e.touches && e.touches[0]; if (!t) return
    const dy = t.clientY - s.y, dx = t.clientX - s.x
    // Horizontaler Wisch (klar seitlich) im Vollbild auf Top-Level → Deck wechseln (eine Geste = ein Wechsel).
    if (fullscreen && !navStack.length && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      cycleDeck(dx < 0 ? 1 : -1); swipeRef.current = null; pullRef.current = 0; setPull(0); return
    }
    // Vertikaler Pull von oben → Indikator wachsen lassen (Aktion erst beim Loslassen).
    if (s.top && dy > 8 && dy > Math.abs(dx) * 1.5) { pullRef.current = dy; setPull(dy) }
    else if (pullRef.current) { pullRef.current = 0; setPull(0) }
  }
  const onTouchEnd = () => {
    const p = pullRef.current; pullRef.current = 0; swipeRef.current = null; setPull(0)
    if (p > PULL_REFRESH) { hardReload(); return }
    if (fullscreen && p > PULL_EXIT) setFullscreen(false)
  }
  // ⛶ Vollbild-Knopf (rechts in der Deck-Leiste). Im Vollbild selbst ausgeblendet → Rückkehr per Wisch.
  const FsBtn = () => (
    <button class="t-fs-btn" title="Vollbild" aria-label="Vollbild"
            onClick={(e) => { e.stopPropagation(); setFullscreen(true) }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      </svg>
    </button>
  )

  // EINHEITLICHER Tap-Handler (Haupt-Raster UND Radial): Ordner → navigieren; sonst → Press.
  const onTap = async (id, evt) => {
    const a = actionById[id] || {}
    if (a.type === 'open_deck' && a.deck) {
      if ((a.mode || 'replace') === 'radial') {
        const r = evt.currentTarget.getBoundingClientRect()
        setOverlay({ deck: a.deck, anchor: { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      } else {
        setSlideDir(0); setOverlay(null); setNavStack((s) => [...s, a.deck])
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

  // Freie Platzierung: Deck-Flag `layout.free` (im Editor umgeschaltet) → festes Quadrat-Raster mit freien
  // Positionen (Item x/y; un-platzierte Items fließen in die Lücken). Ohne das Flag = bisheriges responsives
  // Kategorie-Raster → un-editierte Decks bleiben EXAKT wie sie waren („nichts springt").
  const freeMode = !!layout.free
  const freeCols = layout.cols > 0 ? layout.cols : 6
  const freeStyle = `grid-template-columns:repeat(${freeCols},var(--sd-size));gap:${layout.gap || 12}px;justify-content:start`
  const tile = (it) => {
    const id = it.button
    const w = Math.max(1, it.w || 1), h = Math.max(1, it.h || 1)
    const spanned = w > 1 || h > 1   // große/breite Kachel — NUR Panel (physisch bleibt 1×1)
    // Freie x/y-Position gilt NUR im Frei-Modus. Sonst (Kategorie-Raster) ignorieren — sonst „springt"
    // ein Deck, das mal frei platziert war, im Grid-Modus herum (Items kleben an alten x/y).
    const positioned = freeMode && Number.isInteger(it.x) && Number.isInteger(it.y)
    const place = positioned ? `;grid-column:${it.x + 1}/span ${w};grid-row:${it.y + 1}/span ${h}`
      : (spanned ? `;grid-column:span ${w};grid-row:span ${h}` : '')
    const v = vis[id] || {}
    const eff = resolveStyle(it.style, layout)
    const folder = (actionById[id] || {}).type === 'open_deck'
    const render = renderById[id]
    const isGraph = render === 'graph'
    const isGauge = render === 'gauge'
    const isStat = render === 'stat'
    const isClock = render === 'clock', isText = render === 'text', isReadout = render === 'readout'
    const isWidget = isClock || isText || isReadout
    const isFader = render === 'fader'
    const isFlat = !v.image && !isWidget && !isGraph && !isGauge && !isStat   // normale Emoji/Farb-Kachel (kein Bild/Widget/Graph/Gauge/Stat/Fader)
    const o = optsById[id] || {}
    const statSty = isStat ? statStyle(v, o) : ''
    if (isFader) {
      // Fader-Kachel: eigenes Touch-Handling (Ziehen=Level, Tippen=Mute) statt Button-onClick.
      return (
        <div key={id} class={keyClass(eff, 't-key') + ' t-fader-key cqsize' + (spanned ? ' spanned' : '')}
             style={'background:var(--bg)' + place}>
          <Fader id={id} v={v} mon={monById[id] || {}} meters={wlMeters} state={wlState}
                 dev={(actionById[id] || {}).device_id || ''} wa={waSnap[(actionById[id] || {}).device_id || ''] || {}}
                 proc={(actionById[id] || {}).app_proc || ''} app={appSnap[(actionById[id] || {}).app_proc || ''] || {}}
                 onMute={() => onTap(id)} />
        </div>
      )
    }
    return (
      <button key={id}
              class={keyClass(eff, 't-key') + (v.image ? ' has-img' : '') + (folder ? ' is-folder' : '') + (isGraph ? ' is-graph' : '') + (isGauge ? ' is-gauge' : '') + (isStat ? ' is-stat' : '') + (isClock ? ' is-clock' : '') + (isReadout ? ' is-readout' : '') + (isWidget ? ' t-widget' : '') + (isFlat ? ' t-flat' : '') + ((isWidget || isGauge || isStat || o.size) ? ' cqsize' : '') + (spanned ? ' spanned' : '') + (pressed === id ? ' pressed' : '')}
              style={(isFlat ? `--acc:${v.color || '#222'}` : ('background:' + (isWidget ? 'transparent' : ((isGraph || isGauge || isStat) ? 'var(--bg)' : (v.color || '#222'))))) + place}
              onClick={(e) => onTap(id, e)}>
        {isClock ? <Clock opts={o} />
          : isText ? <span class="t-label-text" style={`font-size:${widgetFontSize(o, 'text')};font-family:${fontStack(o.font)};color:${o.color || 'var(--fg)'}`}>{v.title || v.label || ''}</span>
          : isReadout ? <Readout v={v} opts={o} />
          : isGraph ? (
            <>
              {v.title ? <span class="t-key-title">{v.title}</span> : null}
              {['fps', 'frametime'].includes((monById[id] || {}).type)
                ? <FastGraph kind={(monById[id] || {}).type} color={v.color} />
                : <Sparkline data={histRef.current[id]} color={v.color} opts={o} uid={id} />}
            </>
          ) : isGauge ? (
            <Gauge value={v.value} opts={o} />
          ) : isStat ? (
            <span class="t-stat-v" style={statSty}>{v.title || (v.value != null ? String(v.value) : '—')}</span>
          ) : (
            <>
              {v.image ? <img class="t-key-img" src={v.image} alt="" />
                : <span class="t-key-icon">{v.icon || '•'}</span>}
              {v.title ? <span class="t-key-title" style={o.size ? `font-size:${widgetFontSize(o, 'text')}` : ''}>{v.title}</span> : null}
            </>
          )}
        {!isWidget && <span class="t-key-label">{v.label || id}</span>}
        {folder && <span class="t-folder-badge">⋯</span>}
      </button>
    )
  }

  return (
    <div class="t-deck" style={deckStyle} onTouchStart={onTouchStart} onTouchMove={onTouchMove}
         onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
      {pull > 0 && (
        <div class={'t-ptr' + (pull > 150 ? ' armed' : '')} style={`height:${Math.min(pull, 80)}px`}>
          {pull > 150 ? '↻ Loslassen zum Neuladen'
            : (fullscreen && pull > 75 ? '⤓ Loslassen: Vollbild aus'
            : '↓ Weiter ziehen zum Neuladen')}
        </div>
      )}
      {fullscreen && deckFlash && <div class="t-deck-flash">{deckFlash}</div>}
      {navStack.length > 0 ? (
        <div class="t-nav">
          <button class="t-nav-back" onClick={goBack}>‹ Zurück</button>
          <span class="t-nav-crumb">{crumb.join('  ›  ')}</span>
          <FsBtn />
        </div>
      ) : visibleDecks.length > 1 ? (
        <div class="t-deck-tabs">
          {visibleDecks.map((dk) => (
            <button key={dk.id} class={'t-deck-tab' + (dk.id === tabSel ? ' active' : '')}
                    onClick={() => { setSlideDir(0); switchDeck(dk.id) }}>
              <span class="t-deck-tab-icon">{dk.icon || '🎛'}</span>
              <span class="t-deck-tab-label">{dk.label || dk.id}</span>
            </button>
          ))}
          <FsBtn />
        </div>
      ) : (
        <div class="t-deck-bar-min"><FsBtn /></div>
      )}
      <div class={'t-deck-body' + (slideDir > 0 ? ' t-slide-next' : slideDir < 0 ? ' t-slide-prev' : '')} key={shownId}>
        {active.auto === 'audio_mixer'
          ? <AudioMixer hidden={active.mixer_hidden} gridStyle={gridStyle} w={active.mixer_w} h={active.mixer_h} iconOnly={active.mixer_icon_only} />
          : !(active.items || []).length
          ? <div class="t-empty" style="margin:30px auto">Dieses Deck ist leer.</div>
          : freeMode ? (
            <div class="t-deck-grid t-deck-free" style={freeStyle}>
              {(active.items || []).filter((it) => !it.hidden).map((it) => tile(it))}
            </div>
          ) : (
            groups.map((g) => (
              <section class="t-deck-grp" key={g.name}>
                {showCatTitles && <h2 class="t-col-h">{g.name}</h2>}
                <div class="t-deck-grid" style={gridStyle}>
                  {g.items.map((it) => tile(it))}
                </div>
              </section>
            ))
          )}
      </div>
      {overlay && overlayDeck && (
        <RadialMenu deck={overlayDeck} vis={vis} actionById={actionById}
                    anchor={overlay.anchor} onTap={onTap} onClose={closeOverlay} />
      )}
    </div>
  )
}
