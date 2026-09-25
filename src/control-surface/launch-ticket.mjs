import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest()

export function createLaunchTickets({ ttlMs = 60_000, now = Date.now, max = 32 } = {}) {
  const ttl = Math.max(10_000, Math.min(5 * 60_000, Number(ttlMs) || 60_000))
  const capacity = Math.max(4, Math.min(128, Number(max) || 32))
  const rows = new Map()

  const sweep = () => {
    const t = now()
    for (const [id, row] of rows) if (row.expiresAt <= t || row.used === true) rows.delete(id)
    while (rows.size > capacity) rows.delete(rows.keys().next().value)
  }

  return {
    mint() {
      sweep()
      const token = randomBytes(32).toString('base64url')
      const id = randomBytes(12).toString('base64url')
      rows.set(id, { hash: digest(token), expiresAt: now() + ttl, used: false })
      return { ticket: `${id}.${token}`, expiresAt: now() + ttl }
    },

    consume(ticket) {
      sweep()
      const raw = String(ticket ?? '')
      const dot = raw.indexOf('.')
      if (dot <= 0) return false
      const id = raw.slice(0, dot)
      const secret = raw.slice(dot + 1)
      const row = rows.get(id)
      if (!row || row.used === true || row.expiresAt <= now()) return false
      const actual = digest(secret)
      if (actual.length !== row.hash.length || !timingSafeEqual(actual, row.hash)) return false
      row.used = true
      rows.delete(id)
      return true
    },

    dispose() {
      rows.clear()
    },
  }
}
