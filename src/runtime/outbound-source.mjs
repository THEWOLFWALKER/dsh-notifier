// dsh-notifier v0.12 — dynamic outbound runtime source.
// This module deliberately owns only the current resolved outbound channel set.
// Persistence, validation, UI and RPC belong elsewhere.

function normalize(entries) {
  const map = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const type = typeof entry?.type === 'string' ? entry.type.trim() : ''
    if (type === '' || entry?.config === null || typeof entry?.config !== 'object' || Array.isArray(entry.config)) continue
    map.set(type, Object.freeze({ type, config: entry.config }))
  }
  return map
}

export function createOutboundSource(initial = []) {
  let byType = normalize(initial)
  let version = 0
  const listeners = new Set()

  const emit = (event) => {
    version += 1
    const payload = Object.freeze({ version, ...event })
    for (const listener of [...listeners]) {
      try { listener(payload) } catch { /* runtime state change must never fail because observers fail */ }
    }
    return payload
  }

  const api = {
    snapshot() {
      return [...byType.values()]
    },

    types() {
      return [...byType.keys()]
    },

    has(type) {
      return byType.has(String(type ?? '').trim())
    },

    get(type) {
      return byType.get(String(type ?? '').trim()) ?? null
    },

    replace(type, config) {
      const key = typeof type === 'string' ? type.trim() : ''
      if (key === '' || config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError('replace(type, config) requires a non-empty type and object config')
      }
      const next = new Map(byType)
      next.set(key, Object.freeze({ type: key, config }))
      byType = next
      emit({ topic: 'replace', type: key })
      return api.get(key)
    },

    remove(type) {
      const key = typeof type === 'string' ? type.trim() : ''
      if (key === '' || !byType.has(key)) return false
      const next = new Map(byType)
      next.delete(key)
      byType = next
      emit({ topic: 'remove', type: key })
      return true
    },

    replaceAll(entries) {
      byType = normalize(entries)
      emit({ topic: 'replace-all', type: null })
      return api.snapshot()
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    get version() {
      return version
    },
  }

  return api
}
