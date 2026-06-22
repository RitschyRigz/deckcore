import { useEffect, useRef, useState } from 'preact/hooks'

// Seiten-Sichtbarkeit: true, solange der Tab/das Display aktiv ist. Tablet-Screen aus oder App im
// Hintergrund → false. Die schweren Live-Polls (Audio-VU, Fader, Frametime) hängen sich daran auf und
// PAUSIEREN, wenn niemand hinschaut — spart Akku, Funk und die HTTP/1.1-Verbindungsslots. Der SSE-Stream
// selbst bleibt bewusst offen (eine billige Verbindung; der Heartbeat-Watchdog hält sie gesund).
export function usePageVisible() {
  const [vis, setVis] = useState(() => (typeof document === 'undefined' ? true : !document.hidden))
  useEffect(() => {
    if (typeof document === 'undefined') return
    const on = () => setVis(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return vis
}

// Gemeinsame SSE-Anbindung an die Host-App (/api/events) für Live-Topics (Transkripte, Audio-VU,
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
//
// HEARTBEAT-WATCHDOG (2026-06-20): Tablets verloren „ab und zu" die Verbindung und mussten per
// App-Neustart wiederbelebt werden. Wurzel = STILLER TCP-Tod (WLAN-Doze/Roaming/AP-Hickup): die
// Verbindung wird halb-offen — der Browser-EventSource bekommt KEIN error-Event und reconnektet
// NICHT von selbst → UI eingefroren. Beide Hosts senden alle ~10–15 s einen benannten `ping`-Event;
// bleibt länger als STALE_MS JEDES Lebenszeichen aus, schließen wir die tote Verbindung aktiv und
// bauen sie mit Backoff neu auf. Konservativ getimt (40 s > 2 verpasste Pings) + Backoff → KEINE
// Reconnect-Kaskade wie beim alten Singleton-Modell.
const STALE_MS = 40000

export function useEventStream(topics, handlers) {
  const hRef = useRef(handlers)
  hRef.current = handlers
  const key = (topics || []).join(',')
  useEffect(() => {
    if (!key) return
    const list = key.split(',')
    let es = null
    let lastBeat = Date.now()
    let retries = 0
    let reconnectTimer = null
    let closed = false

    const beat = () => { lastBeat = Date.now(); retries = 0 }

    const open = () => {
      if (closed) return
      lastBeat = Date.now()
      es = new EventSource('/api/events?topics=' + encodeURIComponent(key))
      es.onopen = beat
      es.addEventListener('ping', beat)   // Server-Heartbeat = Lebenszeichen, auch ohne echte Topic-Events
      for (const t of list) {
        es.addEventListener(t, (ev) => {
          beat()
          let data
          try { data = JSON.parse(ev.data) } catch { return }
          const h = hRef.current && hRef.current[t]
          if (h) h(data)
        })
      }
      // Sauber gemeldeter Fehler UND der Browser hat aufgegeben (readyState CLOSED=2) → selbst neu
      // aufbauen. Bei CONNECTING (0) reconnektet der Browser bereits selbst → nicht eingreifen.
      es.onerror = () => { if (es && es.readyState === 2) reconnect() }
    }

    const reconnect = () => {
      if (closed || reconnectTimer) return
      try { es && es.close() } catch {}
      es = null
      const delay = Math.min(1000 * 2 ** retries, 15000)   // 1s, 2s, 4s, 8s … max 15s
      retries++
      reconnectTimer = setTimeout(() => { reconnectTimer = null; open() }, delay)
    }

    open()
    // Watchdog fängt den STILLEN Tod ab (kein error-Event) — da greift der Browser-Reconnect nicht.
    const watchdog = setInterval(() => {
      if (!closed && Date.now() - lastBeat > STALE_MS) reconnect()
    }, 5000)

    return () => {
      closed = true
      clearInterval(watchdog)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { es && es.close() } catch {}
    }
  }, [key])
}
