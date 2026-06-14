import { useEffect, useRef } from 'preact/hooks'

// Gemeinsame SSE-Anbindung ans Cockpit (/api/events) für Live-Topics (Transkripte, Audio-VU,
// Health, Activity, Musik …). Pro Mount EINE EventSource mit genau den gebrauchten Topics
// (?topics=) → respektiert das Browser-6-Connection-Limit: nur die gerade sichtbare Seite
// hält Verbindungen, beim Verlassen werden sie geschlossen. handlers = { "<topic>": (data) => … }.
//
// HINWEIS (2026-06-07): Die kurzzeitige „eine geteilte EventSource pro Seite"-Variante
// (Topic-Multiplexer-Singleton) wurde zurückgerollt — sie verursachte beim Stream-Start ein
// hochfrequentes Flackern des Touch-Dashboards (vermutlich Reconnect-Kaskade: eine wackelnde
// Verbindung riss ALLE Topics mit + Server-Snapshot-Bursts). Dieses Modell hier (kleine,
// unabhängige Verbindungen pro Mount) lief monatelang stabil. Die Verhungerung der Steuerung
// im OBS/Live-Tab (HTTP/1.1 6-Connection-Limit) lösen wir später sauber + flackerfrei neu.
export function useEventStream(topics, handlers) {
  const hRef = useRef(handlers)
  hRef.current = handlers
  const key = (topics || []).join(',')
  useEffect(() => {
    if (!key) return
    const list = key.split(',')
    const es = new EventSource('/api/events?topics=' + encodeURIComponent(key))
    const bound = []
    for (const t of list) {
      const fn = (ev) => {
        let data
        try { data = JSON.parse(ev.data) } catch { return }
        const h = hRef.current && hRef.current[t]
        if (h) h(data)
      }
      es.addEventListener(t, fn)
      bound.push([t, fn])
    }
    return () => {
      for (const [t, fn] of bound) es.removeEventListener(t, fn)
      es.close()
    }
  }, [key])
}
