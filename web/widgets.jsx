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
