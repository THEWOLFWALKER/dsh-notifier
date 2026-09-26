export const MAX_HANDLED_EVENTS = 4096
export const HANDLED_EVENT_TTL_MS = 30 * 60 * 1000

export function createHandledEvents({
  capacity = MAX_HANDLED_EVENTS,
  ttlMs = HANDLED_EVENT_TTL_MS,
  now = Date.now,
  seed = [],
} = {}) {
  const cap = Math.max(1, Math.min(MAX_HANDLED_EVENTS, Number(capacity) || MAX_HANDLED_EVENTS))
  const ttl = Math.max(1_000, Number(ttlMs) || HANDLED_EVENT_TTL_MS)
  const rows = new Map()

  const sweep = () => {
    const cutoff = now() - ttl
    for (const [key, seenAt] of rows) if (seenAt <= cutoff) rows.delete(key)
    while (rows.size > cap) rows.delete(rows.keys().next().value)
  }
  for (const value of seed ?? []) rows.set(String(value), now())
  sweep()

  return {
    has(value) {
      sweep()
      const key = String(value)
      const seenAt = rows.get(key)
      if (seenAt === undefined) return false
      rows.delete(key)
      rows.set(key, seenAt)
      return true
    },
    add(value) {
      const key = String(value)
      rows.delete(key)
      rows.set(key, now())
      sweep()
    },
    clear: () => rows.clear(),
    size: () => { sweep(); return rows.size },
  }
}
