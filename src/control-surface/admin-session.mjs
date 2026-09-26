import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest()

/**
 * Short-lived browser session for the Advanced Console.
 * The raw token is returned only at mint time and is never retained in memory
 * or written to state; recovery clients may continue using the Bearer token.
 */
export function createAdminSessions({ ttlMs = 5 * 60_000, now = Date.now, max = 64 } = {}) {
  const ttl = Math.max(30_000, Math.min(15 * 60_000, Number(ttlMs) || 5 * 60_000))
  const capacity = Math.max(4, Math.min(256, Number(max) || 64))
  const rows = new Map()

  const sweep = () => {
    const timestamp = now()
    for (const [id, row] of rows) {
      if (row.expiresAt <= timestamp) rows.delete(id)
    }
    while (rows.size > capacity) rows.delete(rows.keys().next().value)
  }

  const split = (token) => {
    const raw = String(token ?? '')
    const dot = raw.indexOf('.')
    if (dot <= 0 || dot === raw.length - 1) return null
    return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) }
  }

  return {
    mint() {
      sweep()
      const id = randomBytes(12).toString('base64url')
      const secret = randomBytes(32).toString('base64url')
      const token = `${id}.${secret}`
      const expiresAt = now() + ttl
      rows.set(id, { hash: digest(secret), expiresAt })
      return { token, expiresAt }
    },

    verify(token) {
      sweep()
      const parts = split(token)
      if (parts === null) return false
      const row = rows.get(parts.id)
      if (row === undefined || row.expiresAt <= now()) return false
      const actual = digest(parts.secret)
      if (actual.length !== row.hash.length || !timingSafeEqual(actual, row.hash)) return false
      return true
    },

    revoke(token) {
      const parts = split(token)
      if (parts === null) return false
      return rows.delete(parts.id)
    },

    dispose() {
      rows.clear()
    },
  }
}
