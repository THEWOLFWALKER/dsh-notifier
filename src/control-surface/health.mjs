// dsh-notifier v0.12 — bounded operational evidence for channel health.

function blank(type) {
  return {
    type,
    delivered: 0,
    accepted: 0,
    skipped: 0,
    failed: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
  }
}

export function createSurfaceHealth({ window = 20, now = Date.now } = {}) {
  const limit = Math.max(5, Math.min(100, Number(window) || 20))
  const events = new Map()
  const listOf = (type) => {
    const key = String(type ?? '')
    if (!events.has(key)) events.set(key, [])
    return events.get(key)
  }
  const push = (type, kind, reason = null, at = now()) => {
    if (typeof type !== 'string' || type === '') return
    const list = listOf(type)
    list.unshift({ kind, reason: reason === null ? null : String(reason).slice(0, 240), at })
    if (list.length > limit) list.length = limit
  }
  const snapshot = (type) => {
    const out = blank(type)
    for (const event of listOf(type)) {
      if (event.kind === 'delivered') {
        out.delivered += 1
        if (out.lastSuccessAt === null) out.lastSuccessAt = event.at
      } else if (event.kind === 'accepted') {
        out.accepted += 1
      } else if (event.kind === 'failed') {
        out.failed += 1
        if (out.lastFailureAt === null) {
          out.lastFailureAt = event.at
          out.lastFailureReason = event.reason
        }
      } else out.skipped += 1
    }
    return out
  }

  return {
    recordSend(record = {}) {
      const parsed = Date.parse(record.time)
      const at = Number.isFinite(parsed) ? parsed : now()
      for (const type of Array.isArray(record.delivered) ? record.delivered : []) push(String(type), 'delivered', null, at)
      for (const type of Array.isArray(record.skipped) ? record.skipped : []) {
        if (typeof type === 'string' && !type.startsWith('(')) push(type, 'skipped', null, at)
      }
      for (const failure of Array.isArray(record.failed) ? record.failed : []) {
        push(String(failure?.channel ?? ''), 'failed', failure?.error ?? '发送失败', at)
      }
    },
    recordTest(type, result) {
      if (result?.ok === true) {
        const confirmed = result?.confirmed === true || result?.receipt === true
        push(type, confirmed ? 'delivered' : 'accepted')
      }
      else push(type, 'failed', result?.detail ?? '测试失败')
    },
    snapshot,
  }
}

export function healthState({ configured, active, health }) {
  if (configured !== true) return 'unconfigured'
  if (active !== true) return 'degraded'
  if ((health?.failed ?? 0) > 0 && (health?.lastFailureAt ?? 0) >= (health?.lastSuccessAt ?? 0)) return 'degraded'
  if ((health?.delivered ?? 0) > 0) return 'healthy'
  return 'ready'
}

export function healthView({ configured, active, health }) {
  const h = health ?? blank('')
  return {
    state: healthState({ configured, active, health: h }),
    delivered: Number(h.delivered ?? 0),
    accepted: Number(h.accepted ?? 0),
    skipped: Number(h.skipped ?? 0),
    failed: Number(h.failed ?? 0),
    ...(h.lastSuccessAt ? { lastSuccessAt: new Date(h.lastSuccessAt).toISOString() } : {}),
    ...(h.lastFailureAt ? { lastFailureAt: new Date(h.lastFailureAt).toISOString() } : {}),
    ...(h.lastFailureReason ? { lastFailureReason: { en: String(h.lastFailureReason), zh: String(h.lastFailureReason) } } : {}),
  }
}
