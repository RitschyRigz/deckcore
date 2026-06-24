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
export function Clock({ opts }) {
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
  const cardCls = 't-clock-card' + (framed ? ' framed' : '')
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

// Radial-Gauge im Deck-Stil: Glow-Bogen (270°, Gap unten) + Schleppzeiger-Punkt + großer Wert mit Glow.
// Wertbereich aus opts.min/max (Default 0..100), Einheit opts.unit. Skaliert via cqw (wie Text/Uhr).
// Reine Panel-Darstellung — physisches Stream Deck zeigt nur Titel/Wert.
export function Gauge({ value, opts }) {
  const o = opts || {}
  const min = Number.isFinite(+o.min) ? +o.min : 0
  const max = Number.isFinite(+o.max) ? +o.max : 100
  const span = (max - min) || 1
  const v = (value === null || value === undefined || value === '' || isNaN(+value)) ? null : +value
  const t = v === null ? 0 : Math.max(0, Math.min(1, (v - min) / span))
  const col = gaugeColor(t, resolveColor(o.color), o.crit)   // feste Farbe via resolveColor (Theme-/fam-Token möglich)
  const cx = 50, cy = 50, r = 38, A0 = 135, SW = 270
  const pol = (deg) => { const a = deg * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
  const arc = (a0, a1) => { const [x0, y0] = pol(a0), [x1, y1] = pol(a1); const lg = Math.abs(a1 - a0) > 180 ? 1 : 0
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${lg} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}` }
  const [tx, ty] = pol(A0 + SW * t)
  const disp = v === null ? '–' : (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  return (
    <div class="t-gauge" style={`--acc:${col}`}>
      <svg class="t-gauge-svg" viewBox="0 0 100 74" preserveAspectRatio="xMidYMid meet">
        <path d={arc(A0, A0 + SW)} fill="none" stroke="#1a2230" stroke-width="9" stroke-linecap="round" />
        {v !== null && <path d={arc(A0, A0 + SW * t)} fill="none" stroke-width="9" stroke-linecap="round"
                             style={`stroke:${col};filter:drop-shadow(0 0 4px ${col})`} />}
        {v !== null && <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r="4.6" fill="#fff"
                               style={`filter:drop-shadow(0 0 6px ${col})`} />}
      </svg>
      <div class="t-gauge-v" style={`font-size:${widgetFontSize(o, 'gauge')}`}>{disp}<span class="t-gauge-u">{o.unit || ''}</span></div>
    </div>
  )
}

// Balken (render=bar): horizontaler (Standard) oder vertikaler Füll-Balken mit Wert+Einheit. Wertbereich aus
// opts.min/max (Default 0..100), Einheit opts.unit, Ausrichtung opts.orient ('h' | 'v'). Farbe wie Gauge:
// feste opts.color ODER Schwellwert grün→amber→rot, oberste 20% crit-rot (außer crit===false, z.B. Lüfter wo
// hoch=gut). Skaliert via cqw. Reine Panel-Darstellung — physisches Stream Deck zeigt nur Titel/Wert.
export function Bar({ value, opts }) {
  const o = opts || {}
  const min = Number.isFinite(+o.min) ? +o.min : 0
  const max = Number.isFinite(+o.max) ? +o.max : 100
  const span = (max - min) || 1
  const v = (value === null || value === undefined || value === '' || isNaN(+value)) ? null : +value
  const t = v === null ? 0 : Math.max(0, Math.min(1, (v - min) / span))
  const col = gaugeColor(t, resolveColor(o.color), o.crit)   // feste Farbe via resolveColor (Theme-/fam-Token möglich)
  const vert = o.orient === 'v'
  const pct = (t * 100).toFixed(1) + '%'
  const disp = v === null ? '–' : (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  const fillStyle = (vert ? `height:${pct}` : `width:${pct}`) + `;background:${col};box-shadow:0 0 6px ${col}`
  return (
    <div class={'t-bar' + (vert ? ' bar-vert' : '')} style={`--acc:${col}`}>
      <div class="t-bar-track"><div class="t-bar-fill" style={fillStyle}></div></div>
      <div class="t-bar-v" style={`font-size:${widgetFontSize(o, 'gauge')}`}>{disp}<span class="t-bar-u">{o.unit || ''}</span></div>
    </div>
  )
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

// 🎚 Fader-VORSCHAU (render=fader im Editor-WYSIWYG): rendert die Fader-Kachel 1:1 über DIESELBEN CSS-Klassen
// wie das Live-Panel (deck.css .t-fader*), nur STATISCH — fester Pegel, repräsentative VU-Säule, KEIN Drag/
// Live-Meter. So sieht der Editor aus wie der echte Fader (statt einer flachen Kachel), bleibt aber editierbar.
// Spiegelt die Look-Optionen: Slider/Akzent (v.color → --acc), Kachel-Stil (skin), Hintergrund + VU pro Fader (opts).
export function FaderView({ v, opts, skin }) {
  const val = v || {}, o = opts || {}
  let style = `--acc:${accentVar(val.color)}`
  if (o.bg) { const c = resolveColor(o.bg); style += `;--fbg-top:${c};--fbg-bot:color-mix(in srgb, ${c} 55%, #06080c)` }
  if (o.vuLow) style += `;--vu-low:${resolveColor(o.vuLow)}`
  if (o.vuMid) style += `;--vu-mid:${resolveColor(o.vuMid)}`
  if (o.vuHigh) style += `;--vu-high:${resolveColor(o.vuHigh)}`
  const name = val.label || val.title || ''
  const lvl = 66                                      // repräsentativer Pegel für die Vorschau
  const SEGS = 19, segs = []
  for (let i = 0; i < SEGS; i++) {
    const thr = (i + 1) / SEGS
    const cls = thr > 0.75 ? 'r' : thr > 0.667 ? 'y' : 'g'
    segs.push(<span key={i} class={'t-vu-seg' + (thr <= 0.58 ? ' on ' + cls : '')} />)   // statisch bis ~58% „an"
  }
  const icon = val.icon
  return (
    <div class={'t-fader s-' + (skin || 'brackets')} style={style}>
      <div class="t-fader-name" title={name}>{name}</div>
      <div class="t-fader-body">
        <div class="t-fader-track">
          <div class="t-fader-fill" style={`height:${lvl}%`} />
          <div class="t-fader-knob" style={`bottom:${lvl}%`} />
        </div>
        <div class="t-fader-vu">{segs}</div>
      </div>
      <div class="t-fader-foot">{lvl}%</div>
      {icon && (isGlyph(icon) && hasGlyph(glyphName(icon))
        ? <div class="t-fader-icon t-fader-glyph" title={name}><Glyph name={glyphName(icon)} /></div>
        : <div class="t-fader-icon" title={name}>{isGlyph(icon) ? glyphName(icon) : icon}</div>)}
    </div>
  )
}
