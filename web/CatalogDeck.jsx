import { useEffect, useRef, useState } from 'preact/hooks'
import { IconView } from './icons.jsx'

// Optional, generic catalogue view. Roles are presentation data, never action/host names.
export function catalogLabel(label) {
  const full = String(label || '')
  const leading = full.match(/^(\d{4})-(\d{2})-(\d{2})\s*[-–]\s*(.+)$/)
  if (leading) return { title: leading[4], date: `${leading[3]}.${leading[2]}.${leading[1]}` }
  const trailing = full.match(/^(.+?)\s+(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/)
  if (trailing) return { title: trailing[1], date: `${trailing[2]}.${trailing[3]}.${trailing[4]}` }
  return { title: full, date: '' }
}

export function CatalogDeck({ groups, buttons, vis, onTap, pressed, scale = 1, back, title, extra, error }) {
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState(0)
  const [categoryPage, setCategoryPage] = useState(0)
  const [size, setSize] = useState({ width: 720, height: 370 })
  const bodyRef = useRef(null)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(old => old.width === width && old.height === height ? old : { width, height })
    })
    observer.observe(bodyRef.current)
    return () => observer.disconnect()
  }, [])

  const role = it => (buttons[it.button]?.catalog || {}).role || 'item'
  const controls = groups.flatMap(g => g.items.filter(it => role(it) === 'control'))
  const categories = groups.map(g => ({ ...g, items: g.items.filter(it => role(it) !== 'control') }))
    .filter(g => g.items.length)
  const current = categories.find(g => g.name === selected) || categories[0]
  const shortcuts = current?.items.filter(it => role(it) === 'primary') || []
  const items = current?.items.filter(it => role(it) !== 'primary') || []
  const columns = Math.max(1, Math.min(5, Math.floor((size.width + 12) / (176 * scale + 12))))
  const rows = Math.max(1, Math.min(3, Math.floor((size.height + 12) / (168 * scale + 12))))
  const perPage = columns * rows
  const pageCount = Math.max(1, Math.ceil(items.length / perPage))
  const shownPage = Math.min(page, pageCount - 1)
  // Category paging is only needed on unusually short screens / large libraries.
  const categoryFit = Math.max(1, Math.floor((size.height + 72) / 52))
  const categorySize = categories.length <= categoryFit ? categoryFit : Math.max(1, categoryFit - 1)
  const categoryPages = Math.max(1, Math.ceil(categories.length / categorySize))
  const shownCategoryPage = Math.min(categoryPage, categoryPages - 1)
  const smallButton = (it, cls = '') => {
    const b = buttons[it.button] || {}, v = vis[it.button] || b.default || {}
    return <button key={it.button} class={'catalog-command ' + cls}
      disabled={pressed === it.button} onClick={e => onTap(it.button, e)}
      title={b.label || v.label} aria-label={b.label || v.label}>
      <IconView icon={v.icon || b.default?.icon || '▶'} />
      <span>{b.catalog?.label || b.label || v.label}</span>
    </button>
  }
  return <div class="catalog-deck">
    <header class="catalog-top">
      {back && <button class="catalog-command" onClick={back}>‹ Hauptdeck</button>}
      <strong>{title}</strong>
      <div class="catalog-controls">{controls.map(it => smallButton(it, 'catalog-stop'))}{extra}</div>
    </header>
    {error && <div class="catalog-error" role="alert">{error}</div>}
    <div class="catalog-content">
      <aside class="catalog-sidebar" aria-label="Kategorien">
        <nav>
          {categories.slice(shownCategoryPage * categorySize, (shownCategoryPage + 1) * categorySize).map(g =>
            <button key={g.name} class={'catalog-category' + (g.name === current?.name ? ' active' : '')}
              aria-pressed={g.name === current?.name}
              onClick={() => { setSelected(g.name); setPage(0) }}>
              <span>{g.name}</span><small>{g.items.filter(it => role(it) !== 'primary').length}</small>
            </button>)}
        </nav>
        {categoryPages > 1 && <div class="catalog-category-pages">
          <button aria-label="Vorige Kategorien" disabled={!shownCategoryPage} onClick={() => setCategoryPage(shownCategoryPage - 1)}>↑</button>
          <span>{shownCategoryPage + 1}/{categoryPages}</span>
          <button aria-label="Weitere Kategorien" disabled={shownCategoryPage + 1 === categoryPages} onClick={() => setCategoryPage(shownCategoryPage + 1)}>↓</button>
        </div>}
      </aside>
      <main class="catalog-main">
        <div class="catalog-heading"><h2>{current?.name || 'Keine Einträge'}</h2>
          <div>{shortcuts.map(it => smallButton(it, 'catalog-primary'))}</div>
        </div>
        <div class="catalog-grid-space" ref={bodyRef}>
          <div class="catalog-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
            {items.slice(shownPage * perPage, (shownPage + 1) * perPage).map(it => {
              const b = buttons[it.button] || {}, v = vis[it.button] || b.default || {}
              const full = b.label || v.label || it.button
              const { title: name, date } = catalogLabel(full)
              const image = v.image || b.catalog?.image || b.default?.image
              const status = b.catalog?.status_labels?.[v.value]
              return <button key={it.button} class={'catalog-card' + (pressed === it.button ? ' pending' : '')}
                aria-label={full} title={full} disabled={pressed === it.button} onClick={e => onTap(it.button, e)}>
                <div class="catalog-art">
                  {image ? <img key={image} src={image} alt="" onError={e => { e.currentTarget.hidden = true }} /> : null}
                  <span class="catalog-art-fallback" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
                  {pressed === it.button && <span class="catalog-badge">Wird angefragt…</span>}
                  {pressed !== it.button && status && <span class="catalog-badge">{status}</span>}
                </div>
                <div class="catalog-caption"><strong>{name}</strong>
                  {(date || b.catalog?.subtitle) && <span>{date || b.catalog.subtitle}</span>}
                </div>
              </button>
            })}
          </div>
        </div>
        <footer class="catalog-pages">
          <span>{items.length} Titel</span>
          <div><button aria-label="Vorige Songseite" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>‹ Zurück</button>
            <span aria-live="polite">{shownPage + 1} / {pageCount}</span>
            <button aria-label="Nächste Songseite" disabled={shownPage + 1 === pageCount} onClick={() => setPage(shownPage + 1)}>Weiter ›</button></div>
        </footer>
      </main>
    </div>
  </div>
}
