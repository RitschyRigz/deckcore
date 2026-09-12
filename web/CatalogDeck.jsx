import { useEffect, useRef, useState } from 'preact/hooks'

// Optional, generic catalogue view. Roles are presentation data, never action/host names.
export function catalogLabel(label) {
  const full = String(label || '')
  const leading = full.match(/^(\d{4})-(\d{2})-(\d{2})\s*[-–]\s*(.+)$/)
  if (leading) return { title: leading[4], date: `${leading[3]}.${leading[2]}.${leading[1]}` }
  const trailing = full.match(/^(.+?)\s+(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/)
  if (trailing) return { title: trailing[1], date: `${trailing[2]}.${trailing[3]}.${trailing[4]}` }
  return { title: full, date: '' }
}

export function CatalogDeck({ groups, renderItem, layout, scale = 1, back, title, extra, error }) {
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

  const role = it => it.style?.placement || 'grid'
  const controls = groups.flatMap(g => g.items.filter(it => role(it) === 'toolbar'))
  const categories = groups.map(g => ({ ...g, items: g.items.filter(it => role(it) !== 'toolbar') }))
    .filter(g => g.items.length)
  const current = categories.find(g => g.name === selected) || categories[0]
  const shortcuts = current?.items.filter(it => role(it) === 'category') || []
  const items = current?.items.filter(it => role(it) !== 'category') || []
  const gap = (layout.gap ?? 12) * scale
  const cell = (layout.button_size || 116) * scale
  const fit = Math.max(1, Math.floor((size.width + gap) / (cell + gap)))
  const columns = layout.cols > 0 ? Math.min(layout.cols, fit) : fit
  const rows = Math.max(1, Math.floor((size.height + gap) / (cell + gap)))
  const perPage = columns * rows
  const pageCount = Math.max(1, Math.ceil(items.length / perPage))
  const shownPage = Math.min(page, pageCount - 1)
  // Category paging is only needed on unusually short screens / large libraries.
  const categoryFit = Math.max(1, Math.floor((size.height + 72) / 52))
  const categorySize = categories.length <= categoryFit ? categoryFit : Math.max(1, categoryFit - 1)
  const categoryPages = Math.max(1, Math.ceil(categories.length / categorySize))
  const shownCategoryPage = Math.min(categoryPage, categoryPages - 1)
  return <div class="catalog-deck">
    <header class="catalog-top">
      {back && <button class="catalog-command" onClick={back}>‹ Zurück</button>}
      <strong>{title}</strong>
      <div class="catalog-controls">{controls.map(it => renderItem(it, true))}{extra}</div>
    </header>
    {error && <div class="catalog-error" role="alert">{error}</div>}
    <div class="catalog-content">
      <aside class="catalog-sidebar" aria-label="Kategorien">
        <nav>
          {categories.slice(shownCategoryPage * categorySize, (shownCategoryPage + 1) * categorySize).map(g =>
            <button key={g.name} class={'catalog-category' + (g.name === current?.name ? ' active' : '')}
              aria-pressed={g.name === current?.name}
              onClick={() => { setSelected(g.name); setPage(0) }}>
              <span>{g.name}</span><small>{g.items.filter(it => role(it) !== 'category').length}</small>
            </button>)}
        </nav>
        {categoryPages > 1 && <div class="catalog-category-pages">
          <button aria-label="Vorige Kategorien" disabled={!shownCategoryPage} onClick={() => setCategoryPage(shownCategoryPage - 1)}>↑</button>
          <span>{shownCategoryPage + 1}/{categoryPages}</span>
          <button aria-label="Weitere Kategorien" disabled={shownCategoryPage + 1 === categoryPages} onClick={() => setCategoryPage(shownCategoryPage + 1)}>↓</button>
        </div>}
      </aside>
      <main class="catalog-main">
        <div class="catalog-heading">{layout.show_category_titles !== false && <h2>{current?.name || 'Keine Einträge'}</h2>}
          <div>{shortcuts.map(it => renderItem(it, true))}</div>
        </div>
        <div class="catalog-grid-space" ref={bodyRef}>
          <div class="catalog-grid" style={{ gap, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
            {items.slice(shownPage * perPage, (shownPage + 1) * perPage).map(it => renderItem(it))}
          </div>
        </div>
        <footer class="catalog-pages">
          <span>{items.length} Einträge</span>
          <div><button aria-label="Vorige Seite" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>‹ Zurück</button>
            <span aria-live="polite">{shownPage + 1} / {pageCount}</span>
            <button aria-label="Nächste Seite" disabled={shownPage + 1 === pageCount} onClick={() => setPage(shownPage + 1)}>Weiter ›</button></div>
        </footer>
      </main>
    </div>
  </div>
}
