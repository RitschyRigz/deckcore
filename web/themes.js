// Geteilte Theme-Paletten (Single-Source für ALLE Hüllen). Das globale Theme der RigzDeck-Hülle UND der
// per-Deck-Theme-Override (im geteilten Deck-Editor) ziehen aus DIESER Liste → Cockpit + RigzDeck zeigen
// dieselben Themes. Reine Daten (Farb-Variablen) — host-agnostisch, public-clean.
//
// Ein Deck-Theme-Override speichert die aufgelösten Farb-Variablen am Deck (deck.theme = {name, vars}); beim
// Aktivieren des Decks färbt sich das ganze Panel um (TouchDeck). Das GLOBALE Theme bleibt davon unberührt.

// Die personalisierbaren Farb-Variablen (Reihenfolge = Anzeige). `core` = die wichtigsten, `semantic` = Status.
export const THEME_VARS = [
  { key: '--bg', label: 'Hintergrund', core: true },
  { key: '--bg2', label: 'Fläche', core: true },
  { key: '--bg3', label: 'Kachel', core: true },
  { key: '--line', label: 'Linien / Rahmen', core: true },
  { key: '--fg', label: 'Text', core: true },
  { key: '--muted', label: 'Text gedämpft', core: true },
  { key: '--accent', label: 'Akzent', core: true },
  { key: '--accent2', label: 'Akzent 2', core: true },
  { key: '--ok', label: 'OK / Grün' },
  { key: '--warn', label: 'Warnung' },
  { key: '--err', label: 'Fehler' },
  { key: '--live', label: 'Live' },
]
export const THEME_VAR_KEYS = THEME_VARS.map((v) => v.key)

// Kuratierte Paletten. Jede liefert ALLE Variablen. id = stabiler Schlüssel, name = Anzeige.
export const THEME_PRESETS = [
  { id: 'slate', name: 'Slate Purple', vars: {
    '--bg': '#15171c', '--bg2': '#1c1f26', '--bg3': '#232733', '--line': '#2e3340',
    '--fg': '#e7e9ee', '--muted': '#8b93a4', '--accent': '#8a5cff', '--accent2': '#4ea1ff',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'cyan', name: 'Cyan Rig', vars: {
    '--bg': '#0e1116', '--bg2': '#141b25', '--bg3': '#172231', '--line': '#24364a',
    '--fg': '#e8eef5', '--muted': '#8a9bb3', '--accent': '#22d3ee', '--accent2': '#3b82f6',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'green', name: 'Signal Green', vars: {
    '--bg': '#0d1210', '--bg2': '#121c16', '--bg3': '#16241b', '--line': '#244232',
    '--fg': '#e6f1ea', '--muted': '#8aa595', '--accent': '#34d399', '--accent2': '#22d3ee',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff6b6b', '--live': '#ff5d6d' } },
  { id: 'amber', name: 'Amber Forge', vars: {
    '--bg': '#16110b', '--bg2': '#1e1710', '--bg3': '#261c10', '--line': '#3d2c14',
    '--fg': '#f2e9dd', '--muted': '#b09a82', '--accent': '#ff9e3d', '--accent2': '#ffb454',
    '--ok': '#3ecf8e', '--warn': '#ffcf6b', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'oled', name: 'OLED-Schwarz', vars: {
    '--bg': '#000000', '--bg2': '#0a0a0a', '--bg3': '#151515', '--line': '#2c2c2c',
    '--fg': '#ffffff', '--muted': '#9aa0aa', '--accent': '#22d3ee', '--accent2': '#8a5cff',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'gold', name: 'RitschyRigz Gold', vars: {
    '--bg': '#0d0b07', '--bg2': '#15110a', '--bg3': '#1d180d', '--line': '#3a2f17',
    '--fg': '#f5ecd8', '--muted': '#b09a6e', '--accent': '#e8b34a', '--accent2': '#d4943a',
    '--ok': '#3ecf8e', '--warn': '#ffcf6b', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'crimson', name: 'Crimson', vars: {
    '--bg': '#120a0c', '--bg2': '#1a0e11', '--bg3': '#241317', '--line': '#45222a',
    '--fg': '#f3e6e8', '--muted': '#b58a90', '--accent': '#ef4444', '--accent2': '#f87171',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff5d5d', '--live': '#ff2f5e' } },
  { id: 'synthwave', name: 'Synthwave', vars: {
    '--bg': '#0f0a1e', '--bg2': '#160d2b', '--bg3': '#1f1338', '--line': '#3a2566',
    '--fg': '#f5e9ff', '--muted': '#9d8ad0', '--accent': '#ff4ecd', '--accent2': '#36e0ff',
    '--ok': '#2bd9a6', '--warn': '#ffb454', '--err': '#ff5d8a', '--live': '#ff2f9e' } },
  { id: 'nord', name: 'Nord', vars: {
    '--bg': '#242933', '--bg2': '#2e3440', '--bg3': '#3b4252', '--line': '#4c566a',
    '--fg': '#eceff4', '--muted': '#9aa4b8', '--accent': '#88c0d0', '--accent2': '#81a1c1',
    '--ok': '#a3be8c', '--warn': '#ebcb8b', '--err': '#bf616a', '--live': '#d08770' } },
  { id: 'dracula', name: 'Dracula', vars: {
    '--bg': '#21222c', '--bg2': '#282a36', '--bg3': '#343746', '--line': '#44475a',
    '--fg': '#f8f8f2', '--muted': '#9ca0b0', '--accent': '#bd93f9', '--accent2': '#ff79c6',
    '--ok': '#50fa7b', '--warn': '#f1fa8c', '--err': '#ff5555', '--live': '#ff79c6' } },
  { id: 'rose', name: 'Rosé', vars: {
    '--bg': '#160f13', '--bg2': '#1e141a', '--bg3': '#281b22', '--line': '#46303c',
    '--fg': '#f7e9f0', '--muted': '#c096aa', '--accent': '#fb7185', '--accent2': '#f472b6',
    '--ok': '#3ecf8e', '--warn': '#ffb454', '--err': '#ff6b6b', '--live': '#ff4d8d' } },
  { id: 'mint', name: 'Mint', vars: {
    '--bg': '#0a1413', '--bg2': '#0f1c1a', '--bg3': '#142523', '--line': '#21433d',
    '--fg': '#e3f3ef', '--muted': '#88aaa3', '--accent': '#2dd4bf', '--accent2': '#34d399',
    '--ok': '#34d399', '--warn': '#ffcf6b', '--err': '#ff6b6b', '--live': '#ff4d6d' } },
  { id: 'mono', name: 'Mono', vars: {
    '--bg': '#101012', '--bg2': '#17171a', '--bg3': '#202024', '--line': '#313137',
    '--fg': '#ededf0', '--muted': '#8b8b93', '--accent': '#d4d4dc', '--accent2': '#a0a0aa',
    '--ok': '#8fd6a8', '--warn': '#d8c48a', '--err': '#d68a8a', '--live': '#d68aa0' } },
]
export const DEFAULT_THEME_ID = 'slate'
export const themeById = (id) => THEME_PRESETS.find((p) => p.id === id) || null
