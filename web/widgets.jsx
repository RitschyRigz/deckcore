import { useState, useEffect } from 'preact/hooks'
import { Glyph, isGlyph, glyphName, hasGlyph } from './icons.jsx'
import { resolveColor, accentVar } from './deckstyle.js'

// Geteilte Widget-Bausteine für Frei-Kacheln (Text/Label + Uhr). Genutzt von Panel (TouchDeck) UND
// Editor (StreamDeck). ⚠ Reine Panel-Darstellung — physisches Stream Deck rendert sie nie (kein Pool-Button).

// Kuratierte, OFFLINE-sichere Schrift-Stacks (keine Web-Fonts — RigzDeck läuft ohne Internet).
export const WIDGET_FONTS = {
  sans: 'system-ui, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
  rounded: '"Trebuchet MS", "Segoe UI", sans-serif',
}
export const FONT_LABELS = { sans: 'Standard', serif: 'Serif', mono: 'Mono', condensed: 'Schmal', rounded: 'Rund' }
export const fontStack = (k) => WIDGET_FONTS[k] || WIDGET_FONTS.sans
export const SIZE_LABELS = { auto: 'Auto', s: 'S', m: 'M', l: 'L', xl: 'XL' }

// Auto-Emoji je Quelle: generischer, datengetriebener Klassifizierer (Stichwort→Emoji) für „Namens"-Werte
// wie das aktive Audiogerät. KEIN Gerät hartkodiert — nur Gattungen (Kopfhörer/Boxen/HDMI/…), erweiterbar.
// `kind` grenzt die Regeln ein; reihenfolge = Spezifität (erster Treffer gewinnt). Unbekanntes kind → kein
// Auto-Symbol (lieber nichts als falsch geraten). Reine Darstellung — wird auf dem Rohwert ausgewertet.
const ICON_RULES = {
  audio: [
    [/(kopfh|headph|headset|ohrh|earbud|earphone|beyerdyn|sennheiser|hyperx|cloud ?(ii|2|alpha|flight)|arctis|airpod|\bdt[ -]?\d|\bhd[ -]?\d|jabra|\bbose\b)/i, '🎧'],
    [/(mikro|microph|\bmic\b|wave[ :]?(xlr|3|1|link)|go ?xlr|\byeti\b|nt-?usb|at ?20\d\d|scarlett|focusrite|\binterface\b|\bxlr\b|shure|rode\b)/i, '🎙️'],
    [/(hdmi|\btv\b|fernseh|\bdisplay\b|\bmonitor\b|beamer|projector|nvidia|radeon|\blg\b|samsung|\bdell\b|\bacer\b|\bbenq\b|odyssey|gigabyte)/i, '📺'],
    [/(lautsprech|\bspeaker|\bbox(en)?\b|edifier|logitech ?z|\bkrk\b|soundbar|\bhs\d|studio ?monitor|\bstereo\b|\b[257]\.1\b)/i, '🔊'],
    [/(bluetooth|\bbt\b|wireless|funk|kabellos)/i, '📶'],
    [/(voicemeeter|vb-?audio|\bvirtual\b|\bvac\b|\bcable\b|aggregat|stream ?mix|game ?capture)/i, '🎛️'],
    [/(realtek|onboard|\bdigital\b|optical|s\/?pdif|\bline\b|high definition)/i, '🎚️'],
  ],
}
export function autoIcon(value, kind) {
  const s = String(value == null ? '' : value)
  for (const [re, ic] of (ICON_RULES[kind] || [])) if (re.test(s)) return ic
  return kind === 'audio' ? '🔈' : ''   // Audio: generischer Lautsprecher als Fallback; sonst kein Symbol
}

// Schriftgröße als Container-Query-Einheit (cqw = % der KachelBREITE) → skaliert automatisch mit der Kachel
// (4 Felder breit = 4× so groß). Braucht container-type:inline-size auf der Kachel (siehe deck.css). kind
// 'clock' rechnet enger (die Uhr hat mehr Zeichen). 'auto'/unbekannt = vernünftiger Default je Typ.
export const widgetFontSize = (opts, kind) => {
  const base = kind === 'clock' ? { s: 14, m: 19, l: 24, xl: 30 } : { s: 12, m: 18, l: 26, xl: 36 }
  return (base[(opts || {}).size] || (kind === 'clock' ? 19 : 18)) + 'cqw'
}

const pad = (n) => (n < 10 ? '0' + n : '' + n)
// Wochentag + Datum, lokalisiert via Intl (offline — kein Netz/Web-Font nötig); Fallback = DD.MM.YYYY.
const fmtDate = (d) => {
  try {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch (_e) {
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear()
  }
}

// Live-Uhr — digital (Text) ODER analog (SVG), in einer Deck-Kachel mit Rahmen+Glow (passt zum Flat-/Fader-Design).
// Läuft client-seitig aus der lokalen Browser-Zeit. Optionen: mode, seconds, format24, date, frame, color, font, size.
// Die Farbe (opts.color) treibt Ziffern-Glow + Eck-Brackets (--acc) — Default ein kühles Blau.
export function Clock({ opts, skin }) {
  const o = opts || {}
  const withSeconds = o.seconds !== false
  const withDate = !!o.date
  const framed = o.frame !== false
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), withSeconds ? 1000 : 15000)
    return () => clearInterval(iv)
  }, [withSeconds])
  const accent = resolveColor(o.color) || 'var(--accent)'
  // Verzierung (Rahmen/Glow/Brackets) kommt aus dem Kachel-Stil .s-* (global/Deck-Look ODER pro Taste
  // opts.skin) — EXAKT wie Status-Karte/Flat/Fader; früher war die Uhr-Karte „festgebrannt".
  const cardCls = 't-clock-card' + (framed ? ' framed s-' + (skin || 'brackets') : '')
  const dateEl = withDate ? <span class="t-clock-date">{fmtDate(now)}</span> : null

  if (o.mode === 'analog') {
    const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds()
    const hand = (ang, len, w, col) => {
      const r = (ang - 90) * Math.PI / 180
      return <line x1="50" y1="50" x2={(50 + Math.cos(r) * len).toFixed(1)} y2={(50 + Math.sin(r) * len).toFixed(1)}
                   stroke={col} stroke-width={w} stroke-linecap="round" vector-effect="non-scaling-stroke" />
    }
    return (
      <div class={cardCls} style={`--acc:${accent}`}>
        <svg class="t-clock t-clock-analog" viewBox="0 0 100 100" style={`color:${accent}`}>
          <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4" />
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
            const r = (i * 30 - 90) * Math.PI / 180
            return <circle key={i} cx={(50 + Math.cos(r) * 41).toFixed(1)} cy={(50 + Math.sin(r) * 41).toFixed(1)}
                           r={i % 3 === 0 ? 2.2 : 1.3} fill="currentColor" opacity="0.6" />
          })}
          {hand((h + m / 60) * 30, 25, 3.2, 'currentColor')}
          {hand((m + s / 60) * 6, 35, 2.2, 'currentColor')}
          {withSeconds && hand(s * 6, 39, 1, '#e0564b')}
          <circle cx="50" cy="50" r="2.6" fill="currentColor" />
        </svg>
        {dateEl}
      </div>
    )
  }

  // digital
  const hr = o.format24 === false ? ((now.getHours() % 12) || 12) : now.getHours()
  let t = pad(hr) + ':' + pad(now.getMinutes())
  if (withSeconds) t += ':' + pad(now.getSeconds())
  return (
    <div class={cardCls} style={`--acc:${accent}`}>
      <span class="t-clock t-clock-digital"
            style={`font-family:${fontStack(o.font || 'mono')};font-size:${widgetFontSize(o, 'clock')}`}>{t}</span>
      {dateEl}
    </div>
  )
}

// Farbe (0..1): KRITISCH = oberste 20% (t≥0.8) immer ROT (außer crit===false, z.B. Lüfter/Pumpe wo hoch=gut).
// Darunter die feste Kategoriefarbe (opts.color), sonst Schwellwert grün→amber→rot.
export const gaugeColor = (t, fixed, crit) => (crit !== false && t >= 0.8) ? '#ff4d4d'
  : (fixed || (t < 0.6 ? '#37e0a3' : t < 0.85 ? '#ffb454' : '#ff5d5d'))

// Geometrie-/Deko-Konfig je Gauge-Variante (cx/cy/r identisch; nur Start/Sweep/viewBox + Deko variieren).
// '' = Klassisch (270° Glow-Bogen, Gap unten) — byte-gleich zum bisherigen Design. Generisch: gilt für JEDE
// numerische Quelle (HWiNFO/FPS/poll/…), nichts sensor-exklusives.
const _GAUGE_GEO = {
  '':       { a0: 135, sw: 270, vb: '0 0 100 76', cy: 50, valTop: '' },
  classic:  { a0: 135, sw: 270, vb: '0 0 100 76', cy: 50, valTop: '' },
  ring:     { a0: -90, sw: 360, vb: '1 1 98 98', cy: 50, valTop: '50%' },
  half:     { a0: 180, sw: 180, vb: '0 6 100 52', cy: 52, valTop: '80%' },
  ticks:    { a0: 135, sw: 270, vb: '0 0 100 76', cy: 50, valTop: '', ticks: true },
  segments: { a0: 135, sw: 270, vb: '0 0 100 76', cy: 50, valTop: '', segs: true },
  minimal:  { a0: 135, sw: 270, vb: '0 0 100 76', cy: 50, valTop: '', thin: true, noDot: true },
}

// Radial-Gauge im Deck-Stil. Varianten (opts.variant): klassisch 270°-Glow, Ring 360°, Tacho 180°, Skala mit
// Strichen, Segmente (Zonen-Blöcke), Minimal (flacher dünner Bogen). Wert an/aus via opts.showValue.
// Wertbereich aus opts.min/max (Default 0..100), Einheit opts.unit. Skaliert via cqw. Reine Panel-Darstellung.
export function Gauge({ value, opts }) {
  const o = opts || {}
  const g = _GAUGE_GEO[o.variant] || _GAUGE_GEO['']
  const min = Number.isFinite(+o.min) ? +o.min : 0
  const max = Number.isFinite(+o.max) ? +o.max : 100
  const span = (max - min) || 1
  const v = (value === null || value === undefined || value === '' || isNaN(+value)) ? null : +value
  const t = v === null ? 0 : Math.max(0, Math.min(1, (v - min) / span))
  const col = gaugeColor(t, resolveColor(o.color), o.crit)   // feste Farbe via resolveColor (Theme-/fam-Token möglich)
  const cx = 50, cy = g.cy, r = 38, A0 = g.a0
  const SW = g.sw >= 360 ? 359.999 : g.sw     // Voll-Ring: 360°-Bogen (Start=Ende) ist nicht zeichenbar → minimal kürzen
  const trackW = g.thin ? 4 : 9, fillW = g.thin ? 4 : 9
  const pol = (deg) => { const a = deg * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
  const arc = (a0, a1) => { const [x0, y0] = pol(a0), [x1, y1] = pol(a1); const lg = Math.abs(a1 - a0) > 180 ? 1 : 0
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${lg} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}` }
  const [tx, ty] = pol(A0 + SW * t)
  const disp = v === null ? '–' : (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  // Segmente: SW in N Blöcke mit kleiner Lücke; Block leuchtet, wenn seine Mitte ≤ t.
  let segEls = null
  if (g.segs) {
    const N = 22, gap = 1.4, blk = SW / N, els = []
    for (let i = 0; i < N; i++) {
      const a = A0 + i * blk, b = a + blk - gap
      const on = v !== null && (i + 0.5) / N <= t
      els.push(<path key={i} d={arc(a, b)} fill="none" stroke-width="9" stroke-linecap="butt"
        style={on ? `stroke:${col};filter:drop-shadow(0 0 3px ${col})` : 'stroke:#1a2230'} />)
    }
    segEls = els
  }
  // Skala-Striche: kurze radiale Markierungen am Außenrand (rein dekorativ, zeigt die Skalierung).
  let tickEls = null
  if (g.ticks) {
    const N = 10, els = []
    for (let i = 0; i <= N; i++) {
      const a = (A0 + SW * (i / N)) * Math.PI / 180
      const r0 = r + 5, r1 = r + (i % 5 === 0 ? 10 : 7.5)
      els.push(<line key={i} x1={(cx + r0 * Math.cos(a)).toFixed(1)} y1={(cy + r0 * Math.sin(a)).toFixed(1)}
        x2={(cx + r1 * Math.cos(a)).toFixed(1)} y2={(cy + r1 * Math.sin(a)).toFixed(1)}
        stroke="#5a6b82" stroke-width={i % 5 === 0 ? 1.6 : 1} stroke-linecap="round" vector-effect="non-scaling-stroke" />)
    }
    tickEls = els
  }
  const valStyle = `font-size:${widgetFontSize(o, 'gauge')}` + (g.valTop ? `;top:${g.valTop}` : '')
  return (
    <div class="t-gauge" style={`--acc:${col}`}>
      <svg class="t-gauge-svg" viewBox={g.vb} preserveAspectRatio="xMidYMid meet">
        {tickEls}
        {g.segs ? segEls : (
          <>
            <path d={arc(A0, A0 + SW)} fill="none" stroke="#1a2230" stroke-width={trackW} stroke-linecap="round" />
            {v !== null && <path d={arc(A0, A0 + SW * t)} fill="none" stroke-width={fillW} stroke-linecap="round"
                                 style={`stroke:${col}` + (g.thin ? '' : `;filter:drop-shadow(0 0 4px ${col})`)} />}
          </>
        )}
        {v !== null && !g.noDot && !g.segs && <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r="4.6" fill="#fff"
                               style={`filter:drop-shadow(0 0 6px ${col})`} />}
      </svg>
      {o.showValue !== false && <div class="t-gauge-v" style={valStyle}>{disp}<span class="t-gauge-u">{o.unit || ''}</span></div>}
    </div>
  )
}

// Balken (render=bar): horizontaler (Standard) oder vertikaler Füll-Balken mit Wert+Einheit. Wertbereich aus
// opts.min/max (Default 0..100), Einheit opts.unit, Ausrichtung opts.orient ('h' | 'v'). Farbe wie Gauge:
// feste opts.color ODER Schwellwert grün→amber→rot, oberste 20% crit-rot (außer crit===false, z.B. Lüfter wo
// hoch=gut). Skaliert via cqw. Reine Panel-Darstellung — physisches Stream Deck zeigt nur Titel/Wert.
export function Bar({ value, opts }) {
  const o = opts || {}
  const variant = o.variant || ''
  const min = Number.isFinite(+o.min) ? +o.min : 0
  const max = Number.isFinite(+o.max) ? +o.max : 100
  const span = (max - min) || 1
  const v = (value === null || value === undefined || value === '' || isNaN(+value)) ? null : +value
  const t = v === null ? 0 : Math.max(0, Math.min(1, (v - min) / span))
  const fixed = resolveColor(o.color)
  const col = gaugeColor(t, fixed, o.crit)   // feste Farbe via resolveColor (Theme-/fam-Token möglich)
  const vert = o.orient === 'v'
  const pct = (t * 100).toFixed(1) + '%'
  const disp = v === null ? '–' : (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  // Zonen-Farbe einer Position 0..1 (grün→amber→rot) — für Segmente/Verlauf; feste opts.color gewinnt.
  const zoneCol = (p) => fixed || (p < 0.6 ? '#37e0a3' : p < 0.85 ? '#ffb454' : '#ff5d5d')
  const valEl = o.showValue === false ? null
    : <div class="t-bar-v" style={`font-size:${widgetFontSize(o, 'gauge')}`}>{disp}<span class="t-bar-u">{o.unit || ''}</span></div>
  const root = (inner) => <div class={'t-bar' + (vert ? ' bar-vert' : '') + (variant ? ' v-' + variant : '')} style={`--acc:${col}`}>{inner}</div>

  // Segmente (LED-Leiste): N Blöcke, leuchten bis t, je nach Position grün/amber/rot (außer feste Farbe).
  if (variant === 'segments') {
    const N = 16, segs = []
    for (let i = 0; i < N; i++) {
      const p = (i + 0.5) / N, on = v !== null && p <= t
      const c = zoneCol(p)
      segs.push(<span key={i} class={'t-bar-seg' + (on ? ' on' : '')}
        style={on ? `background:${c};box-shadow:0 0 5px color-mix(in srgb, ${c} 80%, transparent)` : ''} />)
    }
    return root(<><div class="t-bar-track t-bar-segs">{segs}</div>{valEl}</>)
  }
  // Zonen-Verlauf: fester grün→amber→rot-Verlauf über die GANZE Spur, unbefüllter Teil abgedunkelt.
  if (variant === 'gradient') {
    const grad = fixed
      ? `linear-gradient(${vert ? 'to top' : 'to right'}, color-mix(in srgb, ${fixed} 45%, #06080c), ${fixed})`
      : `linear-gradient(${vert ? 'to top' : 'to right'}, #37e0a3 0%, #37e0a3 50%, #ffb454 74%, #ff5d5d 100%)`
    const maskStyle = vert ? `bottom:${pct};top:0` : `left:${pct};right:0`
    return root(<><div class="t-bar-track">
      <div class="t-bar-zones" style={`background:${grad}`} />
      <div class="t-bar-mask" style={maskStyle} />
    </div>{valEl}</>)
  }
  // Streifen: diagonale Streifen-Füllung in der Farbe (candy stripe).
  if (variant === 'striped') {
    const stripe = `repeating-linear-gradient(45deg, ${col} 0 5px, color-mix(in srgb, ${col} 50%, #06080c) 5px 10px)`
    const fillStyle = (vert ? `height:${pct}` : `width:${pct}`) + `;background:${stripe}`
    return root(<><div class="t-bar-track"><div class="t-bar-fill" style={fillStyle} /></div>{valEl}</>)
  }
  // Klassisch (Glow) + Minimal (flach 2D, kein Glow — via CSS-Klasse v-minimal).
  const glow = variant === 'minimal' ? '' : `;box-shadow:0 0 6px ${col}`
  const fillStyle = (vert ? `height:${pct}` : `width:${pct}`) + `;background:${col}` + glow
  return root(<><div class="t-bar-track"><div class="t-bar-fill" style={fillStyle} /></div>{valEl}</>)
}

// 🪪 Status-Karte (render=readout): zeigt einen (Text-/Namens-)Wert schön im Deck-Look — dunkle Karte mit
// Eck-Brackets + Glow, passendem Auto-Emoji je Quelle (oder eigenem Symbol) + getönter Schrift + optionalem
// Unter-Titel (Label). Generisch & template-fähig: JEDER Namens-/Text-Monitor (Wave-Link-Hauptausgang,
// Windows-Standardgerät, OBS-Szene …) kann sie nutzen — Aussehen kommt aus opts, nicht aus Sonderlogik.
// Reine Panel-Darstellung — das physische Stream Deck rendert nur Symbol/Titel.
export function Readout({ v, opts, skin }) {
  const o = opts || {}
  const framed = o.frame !== false
  // Akzent theme-bindbar (resolveColor → var(--x)); Default = Theme-Akzent statt festem Blau.
  const accent = resolveColor(o.color) || 'var(--accent)'
  const val = v || {}
  const text = val.title || val.label || ''
  // Auf dem ROHWERT klassifizieren (z.B. Gerätename), nicht auf dem ggf. formatierten Titel.
  const raw = (val.value !== null && val.value !== undefined && val.value !== '') ? String(val.value) : text
  const icon = o.noIcon ? '' : (val.icon || autoIcon(raw, o.kind))
  // Symbol kann ein Bibliotheks-Glyph (g:name, zeichnet im Akzent) oder ein Emoji sein.
  const iconEl = !icon ? null
    : (isGlyph(icon) && hasGlyph(glyphName(icon)))
      ? <span class="t-readout-icon t-readout-glyph"><Glyph name={glyphName(icon)} /></span>
      : <span class="t-readout-icon">{isGlyph(icon) ? glyphName(icon) : icon}</span>
  // Unter-Titel nur, wenn das Label einen ZUSÄTZLICHEN Sinn trägt (≠ angezeigter Wert).
  const sub = o.sub === false ? '' : (val.label && val.label !== text ? val.label : '')
  return (
    <div class={'t-readout' + (framed ? ' framed s-' + (skin || 'brackets') : '')} style={`--acc:${accent}`}>
      {iconEl}
      <span class="t-readout-v" style={`font-family:${fontStack(o.font)};font-size:${widgetFontSize(o, 'text')}`}>{text || '—'}</span>
      {sub ? <span class="t-readout-sub">{sub}</span> : null}
    </div>
  )
}

// 🎚 VU-Meter-Renderer (geteilt: Live-Fader in TouchDeck UND Editor-Vorschau FaderView). vu-Stil (opts.vu):
// '' / 'segments' = Lämpchen (Default) · 'dots' = runde LEDs · 'bar' = durchgehende Säule (Zonen-Verlauf,
// von unten befüllt) · 'line' = dünner Pegel-Strich · 'none' = kein VU. mlvl = 0..1. peakEl (optional) =
// der Peak-Hold-Marker (live per rAF; in der Vorschau null). Farben = Theme-Vars --vu-low/mid/high.
export function FaderVU({ vu, mlvl, peakEl }) {
  if (vu === 'none') return null
  const lvl = Math.max(0, Math.min(1, mlvl || 0))
  if (vu === 'bar') {
    // Zonen-Verlauf als Container-Hintergrund (deck.css) + dunkle Maske über dem unbefüllten oberen Teil.
    return <div class="t-fader-vu vu-bar">
      <div class="t-vu-barmask" style={`height:${((1 - lvl) * 100).toFixed(1)}%`} />
      {peakEl}
    </div>
  }
  if (vu === 'line') {
    const c = lvl > 0.75 ? 'var(--vu-high)' : lvl > 0.667 ? 'var(--vu-mid)' : 'var(--vu-low)'
    return <div class="t-fader-vu vu-line">
      <div class="t-vu-lineind" style={`bottom:${(lvl * 100).toFixed(1)}%;background:${c};box-shadow:0 0 8px ${c}`} />
      {peakEl}
    </div>
  }
  const SEGS = 19, segs = []
  for (let i = 0; i < SEGS; i++) {
    const thr = (i + 1) / SEGS
    const cls = thr > 0.75 ? 'r' : thr > 0.667 ? 'y' : 'g'
    segs.push(<span key={i} class={'t-vu-seg' + (lvl >= thr - 0.0001 ? ' on ' + cls : '')} />)
  }
  return <div class={'t-fader-vu' + (vu === 'dots' ? ' vu-dots' : '')}>{segs}{peakEl}</div>
}

// 🎚 Fader-VORSCHAU (render=fader im Editor-WYSIWYG): rendert die Fader-Kachel 1:1 über DIESELBEN CSS-Klassen
// wie das Live-Panel (deck.css .t-fader*), nur STATISCH — fester Pegel, repräsentative VU-Säule, KEIN Drag/
// Live-Meter. So sieht der Editor aus wie der echte Fader (statt einer flachen Kachel), bleibt aber editierbar.
// Spiegelt die Look-Optionen: Slider/Akzent (v.color → --acc), Kachel-Stil (skin), Hintergrund + VU pro Fader (opts).
export function FaderView({ v, opts, skin }) {
  const val = v || {}, o = opts || {}
  // Rahmen (--acc) = Theme; Füllung/Knopf/Symbol (--fill) = Identitätsfarbe (Button-Farbe). Wie im Live-Fader.
  let style = `--acc:var(--accent);--fill:${accentVar(val.color)}`
  if (o.bg) { const c = resolveColor(o.bg); style += `;--fbg-top:${c};--fbg-bot:color-mix(in srgb, ${c} 55%, #06080c)` }
  if (o.vuLow) style += `;--vu-low:${resolveColor(o.vuLow)}`
  if (o.vuMid) style += `;--vu-mid:${resolveColor(o.vuMid)}`
  if (o.vuHigh) style += `;--vu-high:${resolveColor(o.vuHigh)}`
  const _k = (x) => { const n = +x; return (n >= 0.4 && n <= 3) ? n : 0 }   // Größen wie im Live-Fader
  if (_k(o.nameK)) style += `;--f-name:calc(10cqw * ${_k(o.nameK)})`
  if (_k(o.valK)) style += `;--f-val:calc(10cqw * ${_k(o.valK)})`
  if (_k(o.iconK)) style += `;--f-icon:calc(17cqw * ${_k(o.iconK)})`
  const name = val.label || val.title || ''
  const lvl = 66                                      // repräsentativer Pegel für die Vorschau
  const variant = o.variant || ''
  const icon = val.icon
  return (
    <div class={'t-fader s-' + (skin || 'brackets') + (variant ? ' v-' + variant : '') + (o.nameLines === 2 ? ' ml-name' : '')} style={style}>
      <div class="t-fader-name" title={name}>{name}</div>
      <div class="t-fader-body">
        <div class="t-fader-track">
          <div class="t-fader-fill" style={`height:${lvl}%`} />
          <div class="t-fader-knob" style={`bottom:${lvl}%`} />
        </div>
        <FaderVU vu={o.vu} mlvl={0.58} peakEl={null} />
      </div>
      <div class="t-fader-foot">{lvl}%</div>
      {icon && (isGlyph(icon) && hasGlyph(glyphName(icon))
        ? <div class="t-fader-icon t-fader-glyph" title={name}><Glyph name={glyphName(icon)} /></div>
        : <div class="t-fader-icon" title={name}>{isGlyph(icon) ? glyphName(icon) : icon}</div>)}
    </div>
  )
}
