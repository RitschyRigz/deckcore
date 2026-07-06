// 🎨 Icon-Bibliothek — kuratierte SVG-Glyphs für Deck-Tasten (host-agnostisch, generisch).
//
// WARUM: Emojis sind bunt + plattformabhängig (jedes OS rendert sie anders) und folgen NIE dem
// Theme. SVG-Glyphs zeichnen mit `currentColor` → sie nehmen die Farbe der Kachel an (Akzent/Theme/
// Button-Farbe) und sehen auf jedem Gerät identisch aus. Beides koexistiert: ein Symbol-Feld kann ein
// Emoji ("🎧") ODER einen Glyph ("g:headphones") tragen — entschieden wird beim Rendern.
//
// SCHEMA: Das bestehende `icon`-Feld (states[].icon / default.icon) bleibt ein freier String. Ein
// Glyph wird als `g:<name>` gespeichert. Das Backend reicht den String unverändert durch (kein
// Umbau nötig); NUR das Frontend interpretiert das Präfix. → Presets/Generatoren/Editor können
// Glyphs genauso setzen wie Emojis.
//
// STIL: 24×24-Grid, `fill:none`, `stroke:currentColor`, stroke-width 2, runde Enden — der ruhige,
// monochrome "Lucide/Feather"-Look. Die Pfade sind aus dem Lucide-Iconset (ISC-Lizenz, frei
// verwendbar) bzw. im selben Stil gezeichnet. Einzelne gefüllte Elemente setzen ihr fill explizit.

// name → innerer SVG-Markup (ohne <svg>-Wrapper; den liefert <Glyph>).
export const GLYPHS = {
  // ── 🎬 Medien ──────────────────────────────────────────────────────────
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  'play-circle': '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  'pause-circle': '<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
  next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  prev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  forward: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
  rewind: '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'list-music': '<path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/>',

  // ── 🔊 Audio ───────────────────────────────────────────────────────────
  'volume-2': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  'volume-1': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  'mic-off': '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  speaker: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 6h.01"/><circle cx="12" cy="14" r="4"/><path d="M12 14h.01"/>',
  radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
  sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  podcast: '<path d="M16.85 18.58a9 9 0 1 0-9.7 0"/><path d="M8 14a5 5 0 1 1 8 0"/><circle cx="12" cy="11" r="1"/><path d="M13 17a1 1 0 1 0-2 0l.5 4.5a.5.5 0 1 0 1 0Z"/>',

  // ── 📺 Streaming / OBS ─────────────────────────────────────────────────
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>',
  'video-off': '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z"/><line x1="2" x2="22" y1="2" y2="22"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  'camera-off': '<line x1="2" x2="22" y1="2" y2="22"/><path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16"/><path d="M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"/><path d="M14.121 15.121A3 3 0 1 1 9.88 10.88"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  cast: '<path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><line x1="2" x2="2.01" y1="20" y2="20"/>',
  record: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  broadcast: '<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7c-2.3 2.3-2.3 6.1 0 8.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 13.3c2.3-2.3 2.3-6.1 0-8.5"/><path d="M19.1 1.9c3.9 3.9 3.9 10.3 0 14.2"/><path d="M12 11v10"/><path d="M8 21h8"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  twitch: '<path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7" fill="none"/>',
  youtube: '<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>',

  // ── 👥 Community / Social ──────────────────────────────────────────────
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'bell-off': '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  'thumbs-up': '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  'at-sign': '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',

  // ── 🎮 Gaming ──────────────────────────────────────────────────────────
  gamepad: '<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="2"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  sword: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  skull: '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
  dice: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>',
  ghost: '<path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>',
  bomb: '<circle cx="11" cy="13" r="9"/><path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"/><path d="m22 2-1.5 1.5"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',

  // ── ⚙️ System / Apps ───────────────────────────────────────────────────
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  'hard-drive': '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',

  // ── 🏠 Smart Home / Wetter / Tools ─────────────────────────────────────
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  fan: '<path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"/><path d="M12 12v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C4 11.1 3 13 3 15a7 7 0 0 0 7 7z"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  snowflake: '<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
  wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  toggle: '<rect width="20" height="12" x="2" y="6" rx="6" ry="6"/><circle cx="16" cy="12" r="2"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',

  // ── ✨ Symbole / Status ────────────────────────────────────────────────
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  triangle: '<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
  hexagon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',

  // ── ➡️ Navigation ──────────────────────────────────────────────────────
  'arrow-up': '<line x1="12" x2="12" y1="19" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  'arrow-down': '<line x1="12" x2="12" y1="5" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  'arrow-left': '<line x1="19" x2="5" y1="12" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  'arrow-right': '<line x1="5" x2="19" y1="12" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  back: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  'chevrons-up': '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  'chevrons-down': '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>',
  'line-start': '<line x1="6" x2="6" y1="5" y2="19"/><line x1="10" x2="20" y1="12" y2="12"/><polyline points="14 8 10 12 14 16"/>',
  'line-end': '<line x1="18" x2="18" y1="5" y2="19"/><line x1="4" x2="14" y1="12" y2="12"/><polyline points="10 8 14 12 10 16"/>',

  // ── 🔢 Ziffernblock / Tasten ────────────────────────────────────────────
  divide: '<circle cx="12" cy="6" r="1"/><line x1="5" x2="19" y1="12" y2="12"/><circle cx="12" cy="18" r="1"/>',
  enter: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  insert: '<path d="M12 4v9"/><polyline points="8 9 12 13 16 9"/><line x1="5" x2="19" y1="19" y2="19"/>',
  delete: '<path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><line x1="18" x2="12" y1="9" y2="15"/><line x1="12" x2="18" y1="9" y2="15"/>',
}

// Such-Stichworte (deutsch + englisch) je Glyph — der Name selbst ist immer mit-durchsucht.
export const GLYPH_KW = {
  play: 'wiedergabe start abspielen', pause: 'anhalten', stop: 'stopp halt',
  next: 'weiter vor skip', prev: 'zurueck back skip', forward: 'vorspulen schnell',
  rewind: 'zurueckspulen', repeat: 'wiederholen loop', shuffle: 'zufall mix',
  music: 'musik song lied note', 'list-music': 'playlist warteschlange queue',
  film: 'video movie kino clip', disc: 'cd platte vinyl',
  'volume-2': 'lautstaerke lauter ton sound laut', 'volume-1': 'leiser ton sound',
  'volume-x': 'stumm mute lautlos', mic: 'mikrofon microphone aufnahme stimme',
  'mic-off': 'mikrofon stumm mute', headphones: 'kopfhoerer headset audio',
  speaker: 'lautsprecher box', radio: 'funk signal sender', sliders: 'mixer regler equalizer fader',
  podcast: 'podcast sendung',
  video: 'kamera webcam cam', 'video-off': 'kamera aus webcam off', camera: 'foto kamera bild',
  'camera-off': 'kamera aus', monitor: 'bildschirm display screen', cast: 'streaming uebertragen',
  record: 'aufnahme rec aufnehmen rot punkt', broadcast: 'live stream senden antenne turm',
  layers: 'szenen ebenen stapel scene', eye: 'sichtbar anzeigen quelle source',
  'eye-off': 'unsichtbar verstecken aus', grid: 'raster kacheln szenen layout',
  twitch: 'twitch stream', youtube: 'youtube yt video',
  users: 'zuschauer leute community gruppe', user: 'person profil',
  heart: 'herz liebe favorit like', star: 'stern favorit bewertung',
  bell: 'glocke benachrichtigung alarm', 'bell-off': 'stumm benachrichtigung aus',
  gift: 'geschenk sub gift donation', 'thumbs-up': 'daumen like gut',
  chat: 'chat nachricht message sprechblase', 'message-circle': 'chat nachricht',
  mail: 'email post nachricht', send: 'senden absenden pfeil', share: 'teilen',
  'at-sign': 'at mention erwaehnung', hash: 'raute hashtag kanal channel', coffee: 'kaffee pause tasse',
  gamepad: 'controller spiel gaming joystick', target: 'ziel fadenkreuz treffer',
  crosshair: 'fadenkreuz zielen aim', trophy: 'pokal sieg gewinn trophaee win',
  sword: 'schwert waffe angriff', swords: 'schwerter kampf duell vs', shield: 'schild schutz verteidigung',
  skull: 'totenkopf tod death gestorben', dice: 'wuerfel zufall glueck',
  ghost: 'geist gespenst', bomb: 'bombe explosion', flag: 'flagge fahne checkpoint markierung',
  rocket: 'rakete start boost launch',
  power: 'an aus power ein netzschalter', refresh: 'neu laden aktualisieren reload',
  settings: 'einstellungen zahnrad optionen', terminal: 'konsole cmd shell befehl',
  folder: 'ordner verzeichnis', 'folder-open': 'ordner offen', file: 'datei dokument',
  window: 'fenster app programm anwendung', cpu: 'prozessor chip', 'hard-drive': 'festplatte speicher ssd',
  download: 'herunterladen runter', upload: 'hochladen rauf', trash: 'muell loeschen papierkorb',
  lock: 'schloss sperren gesperrt', unlock: 'entsperren offen',
  wifi: 'wlan netzwerk internet', bluetooth: 'bluetooth funk',
  save: 'speichern diskette sichern', copy: 'kopieren', clipboard: 'zwischenablage',
  search: 'suche lupe finden', keyboard: 'tastatur makro hotkey', globe: 'web internet url netz welt',
  link: 'verknuepfung kette url', 'external-link': 'oeffnen extern link', command: 'befehl cmd taste',
  lightbulb: 'licht lampe gluehbirne idee', plug: 'stecker strom steckdose',
  thermometer: 'temperatur grad waerme', fan: 'luefter ventilator wind kuehlung',
  sun: 'sonne hell tag licht', moon: 'mond nacht dunkel', cloud: 'wolke wetter',
  droplet: 'tropfen wasser feucht', flame: 'feuer flamme heiss brennen',
  snowflake: 'schnee kalt frost eis', wind: 'wind luft', toggle: 'schalter umschalten an aus',
  zap: 'blitz energie strom power schnell',
  sparkles: 'glitzer funkeln neu magie effekt', crown: 'krone koenig vip premium',
  bookmark: 'lesezeichen merken', tag: 'etikett label schild', pin: 'stecknadel ort markierung pin',
  clock: 'uhr zeit', calendar: 'kalender datum termin', timer: 'timer stoppuhr countdown',
  alert: 'warnung achtung gefahr', info: 'information hinweis', help: 'hilfe frage',
  check: 'haken ok erledigt fertig', 'check-circle': 'haken ok bestaetigt', x: 'schliessen abbrechen kreuz',
  plus: 'plus hinzufuegen neu mehr', minus: 'minus weniger entfernen',
  circle: 'kreis punkt', square: 'quadrat box', triangle: 'dreieck', hexagon: 'sechseck wabe',
  'arrow-up': 'pfeil hoch oben', 'arrow-down': 'pfeil runter unten',
  'arrow-left': 'pfeil links', 'arrow-right': 'pfeil rechts',
  'chevron-up': 'pfeil hoch', 'chevron-down': 'pfeil runter aufklappen',
  'chevron-left': 'pfeil links', 'chevron-right': 'pfeil rechts weiter',
  back: 'zurueck zurueckpfeil', home: 'startseite haus zuhause pos1', menu: 'menue hamburger liste',
  more: 'mehr optionen punkte', maximize: 'vollbild vergroessern',
  'chevrons-up': 'bild hoch seite hoch page up doppelpfeil', 'chevrons-down': 'bild runter seite runter page down doppelpfeil',
  'line-start': 'pos1 zeilenanfang home anfang', 'line-end': 'ende zeilenende end',
  divide: 'geteilt division ziffernblock numpad', enter: 'eingabe enter return zeilenumbruch',
  insert: 'einfuegen einfg insert', delete: 'entfernen entf loeschen delete',
}

// Picker-Kategorien (Reihenfolge = Anzeige). Jeder Glyph genau einmal in einer Sparte.
export const GLYPH_CATS = [
  { label: '🎬 Medien', names: ['play', 'pause', 'stop', 'play-circle', 'pause-circle', 'next', 'prev', 'forward', 'rewind', 'repeat', 'shuffle', 'music', 'list-music', 'film', 'disc'] },
  { label: '🔊 Audio', names: ['volume-2', 'volume-1', 'volume-x', 'mic', 'mic-off', 'headphones', 'speaker', 'radio', 'sliders', 'podcast'] },
  { label: '📺 Streaming / OBS', names: ['video', 'video-off', 'camera', 'camera-off', 'monitor', 'cast', 'record', 'broadcast', 'layers', 'eye', 'eye-off', 'grid', 'twitch', 'youtube'] },
  { label: '👥 Community', names: ['users', 'user', 'heart', 'star', 'bell', 'bell-off', 'gift', 'thumbs-up', 'chat', 'message-circle', 'mail', 'send', 'share', 'at-sign', 'hash', 'coffee'] },
  { label: '🎮 Gaming', names: ['gamepad', 'target', 'crosshair', 'trophy', 'sword', 'swords', 'shield', 'skull', 'dice', 'ghost', 'bomb', 'flag', 'rocket'] },
  { label: '⚙️ System / Apps', names: ['power', 'refresh', 'settings', 'terminal', 'folder', 'folder-open', 'file', 'window', 'cpu', 'hard-drive', 'download', 'upload', 'trash', 'lock', 'unlock', 'wifi', 'bluetooth', 'save', 'copy', 'clipboard', 'search', 'keyboard', 'globe', 'link', 'external-link', 'command'] },
  { label: '🏠 Smart Home / Wetter', names: ['lightbulb', 'plug', 'thermometer', 'fan', 'sun', 'moon', 'cloud', 'droplet', 'flame', 'snowflake', 'wind', 'toggle', 'zap'] },
  { label: '✨ Symbole / Status', names: ['sparkles', 'crown', 'bookmark', 'tag', 'pin', 'clock', 'calendar', 'timer', 'alert', 'info', 'help', 'check', 'check-circle', 'x', 'plus', 'minus', 'circle', 'square', 'triangle', 'hexagon'] },
  { label: '➡️ Navigation', names: ['arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', 'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right', 'chevrons-up', 'chevrons-down', 'line-start', 'line-end', 'back', 'home', 'menu', 'more', 'maximize'] },
  { label: '🔢 Ziffernblock', names: ['divide', 'enter', 'insert', 'delete'] },
]

export const GLYPH_PREFIX = 'g:'

// Ist dieser Symbol-Wert ein Bibliotheks-Glyph (statt Emoji/leer)?
export function isGlyph(icon) {
  return typeof icon === 'string' && icon.indexOf(GLYPH_PREFIX) === 0
}
// Glyph-Name aus dem Symbol-Wert (ohne Präfix). '' wenn keiner.
export function glyphName(icon) {
  return isGlyph(icon) ? icon.slice(GLYPH_PREFIX.length) : ''
}
// Symbol-Wert für einen Glyph-Namen bauen.
export function glyphValue(name) {
  return GLYPH_PREFIX + name
}
// Existiert ein Glyph unter diesem Namen?
export function hasGlyph(name) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, name)
}

// Glyph als <svg> rendern — zeichnet mit currentColor (erbt die Textfarbe der Kachel → folgt
// Akzent/Theme/Button-Farbe). `dangerouslySetInnerHTML` ist hier sicher: die Markups sind statische,
// kuratierte Konstanten aus DIESER Datei (kein User-Input).
export function Glyph({ name, cls, style }) {
  const m = GLYPHS[name]
  if (!m) return null
  return (
    <svg class={'dc-glyph' + (cls ? ' ' + cls : '')} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: m }} />
  )
}

// Symbol-Wert anzeigen: Glyph (g:name) → <Glyph>, sonst der rohe String als Text (Emoji). Liefert
// `fallback` (oder null), wenn leer. Ein Glyph-Name ohne Treffer fällt auf den rohen Namen-Text zurück.
export function IconView({ icon, cls, fallback = null }) {
  if (isGlyph(icon)) {
    const nm = glyphName(icon)
    if (hasGlyph(nm)) return <Glyph name={nm} cls={cls} />
    return <span class={cls}>{nm}</span>
  }
  if (icon) return <span class={cls}>{icon}</span>
  return fallback
}

// ── 🪄 Auto-Symbol: aus Label + Funktion (Aktion/Überwachung) ein sinnvolles Glyph aus UNSERER Bibliothek
// vorschlagen. GENERISCH für jede Button-Art (nicht nur Wave Link). Liefert 'g:<name>' oder '' (kein Treffer).
// Quelle der „Intelligenz": GLYPH_KW (DE+EN-Stichworte je Glyph) + ein paar App-/Szenen-Hinweise + Typ-Defaults.

// Häufige Programm-/Begriffsnamen, die NICHT als Glyph-Stichwort stehen → direkt aufs passende Glyph.
const _AUTO_HINTS = {
  discord: 'message-circle', steam: 'gamepad', epic: 'gamepad', battlenet: 'gamepad', spotify: 'music',
  chrome: 'globe', edge: 'globe', firefox: 'globe', opera: 'globe', browser: 'globe', obs: 'video',
  explorer: 'folder-open', vscode: 'terminal', code: 'terminal', voicemeeter: 'sliders', wavelink: 'sliders',
  deck: 'sliders', mixer: 'sliders', cam: 'camera', webcam: 'video', stream: 'broadcast', brb: 'coffee',
  pause: 'coffee', intro: 'sparkles', outro: 'flag', starting: 'sparkles', ending: 'moon', alert: 'bell',
  raid: 'swords', follow: 'heart', sub: 'gift', bits: 'gift', vip: 'crown', mod: 'shield', timer: 'timer',
  desktop: 'monitor', pumpe: 'fan', luefter: 'fan', radiator: 'fan', wasser: 'droplet', kuehlung: 'fan',
}
// Typ-Default je Aktions-Art / Überwachungs-Art (Fallback, wenn die Stichwortsuche nichts findet).
const _AUTO_ACT = {
  open_folder: 'folder-open', open_deck: 'folder', http: 'globe', hotkey: 'keyboard', media: 'play',
  displayfusion: 'monitor', winaudio: 'volume-2', wavelink: 'sliders', launch: 'window', power: 'power',
  process_action: 'power', manual_event: 'flag', events_action: 'zap', alert: 'bell', obsbot_cam: 'video',
  obsbot_track: 'crosshair', scene_suggest: 'layers',
}
const _AUTO_MON = {
  fps: 'target', frametime: 'zap', weather: 'cloud', obs_scene: 'layers', obs_source_visible: 'eye',
  wavelink_main_output: 'speaker', winaudio_default: 'speaker', wavelink_level: 'sliders', wavelink_mute: 'volume-x',
  displayfusion_profile: 'monitor', process_alive: 'power', hwinfo: 'cpu', bot_vision: 'eye', bot_state: 'chat',
}

function _tokens(s) {
  // Umlaute auf die ASCII-Form normalisieren (GLYPH_KW nutzt luefter/kuehlung/… → so matchen Lüfter/Kühlung).
  const norm = String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  return norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
}
// Bestes Glyph per Stichwort-Match (GLYPH_KW + Glyph-Name). Punktet exakte Wort-Treffer höher als Teil-Treffer.
function _kwBest(text) {
  const toks = _tokens(text)
  if (!toks.length) return ''
  let best = '', score = 0
  for (const name in GLYPH_KW) {
    const words = (name + ' ' + GLYPH_KW[name]).split(/\s+/)
    let s = 0
    for (const t of toks) for (const w of words) {
      if (w === t) s += 3
      else if (w.length >= 4 && t.length >= 4 && (w.indexOf(t) === 0 || t.indexOf(w) === 0)) s += 1
    }
    if (s > score) { score = s; best = name }
  }
  return score > 0 ? best : ''
}

// ctx = { label, title, action, monitor }. Reihenfolge: App-/Begriffs-Hinweis → Stichwort-Match → Typ-Default.
export function suggestGlyphName(ctx) {
  const o = ctx || {}, a = o.action || {}, m = o.monitor || {}
  const text = [o.label, o.title, a.path, a.url, a.source, a.scene, a.profile, m.sensor, a.app_proc, a.device_id]
    .filter(Boolean).join(' ')
  // 1) direkte App-/Begriffs-Hinweise (Token-genau)
  for (const t of _tokens(text)) if (_AUTO_HINTS[t]) return _AUTO_HINTS[t]
  // 2) OBS Stream/Aufnahme/Quelle sind eindeutig → vor der Stichwortsuche (Szene NICHT: da gewinnt der Name)
  if (a.type === 'obs') {
    if (a.obs_action === 'stream') return 'broadcast'
    if (a.obs_action === 'record') return 'record'
    if (a.obs_action === 'source_toggle') return 'eye'
  }
  // 3) Stichwort-Match auf Label/Funktion (die „intelligente" Schicht — z.B. Szenenname „Gaming" → gamepad)
  const kw = _kwBest(text)
  if (kw && hasGlyph(kw)) return kw
  // 4) OBS-Szene ohne Namens-Treffer → Ebenen-Symbol
  if (a.type === 'obs') return 'layers'
  // 5) Typ-Default (Aktion vor Überwachung)
  const at = _AUTO_ACT[a.type]; if (at && hasGlyph(at)) return at
  const mt = _AUTO_MON[m.type]; if (mt && hasGlyph(mt)) return mt
  return ''
}
// Bequemer Wrapper → fertiger Symbol-Wert ('g:<name>' oder '').
export function suggestGlyph(ctx) {
  const n = suggestGlyphName(ctx)
  return n ? glyphValue(n) : ''
}
