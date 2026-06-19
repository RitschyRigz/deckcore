import { useState, useEffect } from 'preact/hooks'

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

// Schriftgröße als Container-Query-Einheit (cqw = % der KachelBREITE) → skaliert automatisch mit der Kachel
// (4 Felder breit = 4× so groß). Braucht container-type:inline-size auf der Kachel (siehe deck.css). kind
// 'clock' rechnet enger (die Uhr hat mehr Zeichen). 'auto'/unbekannt = vernünftiger Default je Typ.
export const widgetFontSize = (opts, kind) => {
  const base = kind === 'clock' ? { s: 8, m: 11, l: 15, xl: 21 } : { s: 12, m: 18, l: 26, xl: 36 }
  return (base[(opts || {}).size] || (kind === 'clock' ? 11 : 18)) + 'cqw'
}

const pad = (n) => (n < 10 ? '0' + n : '' + n)

// Live-Uhr — digital (Text) ODER analog (SVG). Läuft client-seitig aus der lokalen Browser-Zeit.
export function Clock({ opts, fs }) {
  const o = opts || {}
  const withSeconds = o.seconds !== false
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), withSeconds ? 1000 : 15000)
    return () => clearInterval(iv)
  }, [withSeconds])
  const color = o.color || 'var(--fg)'

  if (o.mode === 'analog') {
    const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds()
    const hand = (ang, len, w, col) => {
      const r = (ang - 90) * Math.PI / 180
      return <line x1="50" y1="50" x2={(50 + Math.cos(r) * len).toFixed(1)} y2={(50 + Math.sin(r) * len).toFixed(1)}
                   stroke={col} stroke-width={w} stroke-linecap="round" vector-effect="non-scaling-stroke" />
    }
    return (
      <svg class="t-clock t-clock-analog" viewBox="0 0 100 100" style={`color:${color}`}>
        <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="2" opacity="0.45" />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
          const r = (i * 30 - 90) * Math.PI / 180
          return <circle key={i} cx={(50 + Math.cos(r) * 41).toFixed(1)} cy={(50 + Math.sin(r) * 41).toFixed(1)}
                         r={i % 3 === 0 ? 2.2 : 1.3} fill="currentColor" opacity="0.65" />
        })}
        {hand((h + m / 60) * 30, 25, 3.2, 'currentColor')}
        {hand((m + s / 60) * 6, 35, 2.2, 'currentColor')}
        {withSeconds && hand(s * 6, 39, 1, '#e0564b')}
        <circle cx="50" cy="50" r="2.6" fill="currentColor" />
      </svg>
    )
  }

  // digital
  const hr = o.format24 === false ? ((now.getHours() % 12) || 12) : now.getHours()
  let t = pad(hr) + ':' + pad(now.getMinutes())
  if (withSeconds) t += ':' + pad(now.getSeconds())
  return (
    <span class="t-clock t-clock-digital"
          style={`color:${color};font-family:${fontStack(o.font || 'mono')};font-size:${widgetFontSize(o, 'clock')}`}>{t}</span>
  )
}

// Schwellwert-Farbe grün→amber→rot (0..1). Feste Akzentfarbe (opts.color) gewinnt, wenn gesetzt.
export const gaugeColor = (t, fixed) => fixed || (t < 0.6 ? '#37e0a3' : t < 0.85 ? '#ffb454' : '#ff5d5d')

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
  const col = gaugeColor(t, o.color)
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
        {v !== null && <path d={arc(A0, A0 + SW * t)} fill="none" stroke={col} stroke-width="9" stroke-linecap="round"
                             style={`filter:drop-shadow(0 0 4px ${col})`} />}
        {v !== null && <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r="4.6" fill="#fff"
                               style={`filter:drop-shadow(0 0 6px ${col})`} />}
      </svg>
      <div class="t-gauge-v" style={`font-size:${widgetFontSize(o, 'gauge')}`}>{disp}<span class="t-gauge-u">{o.unit || ''}</span></div>
    </div>
  )
}
