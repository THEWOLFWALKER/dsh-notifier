// dsh-notifier v0.12 — bounded operational evidence for channel health.

import { normalizeDeliveryEvidence, isConfirmedReceipt } from '../delivery-evidence.mjs'

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
        // v0.13（C11.5 / R4）：provider accepted 也是成功信号（请求已被提供方接收），
        // 只是证据强度弱于 confirmed；计入 lastSuccessAt，避免被更早的失败永久压成 degraded。
        out.accepted += 1
        if (out.lastSuccessAt === null) out.lastSuccessAt = event.at
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
      // v0.13（C11.5 / R4）：provider accepted / confirmed delivered 必须分开计数。
      // legacy record 只有 delivered（旧语义 = 发送 resolve），按 accepted 归类，绝不
      // 再当作「已确认送达」；只有显式 confirmed/receipt 才计 delivered。
      const { accepted, confirmed } = normalizeDeliveryEvidence(record)
      for (const type of accepted) push(String(type), 'accepted', null, at)
      for (const type of confirmed) push(String(type), 'delivered', null, at)
      for (const type of Array.isArray(record.skipped) ? record.skipped : []) {
        if (typeof type === 'string' && !type.startsWith('(')) push(type, 'skipped', null, at)
      }
      for (const failure of Array.isArray(record.failed) ? record.failed : []) {
        push(String(failure?.channel ?? ''), 'failed', failure?.error ?? '发送失败', at)
      }
    },
    recordTest(type, result) {
      if (result?.ok === true) {
        push(type, isConfirmedReceipt(result) ? 'delivered' : 'accepted')
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
  // v0.13（C11.5 / R4）：provider accepted 即视为操作健康（标签与证据强度在 UI 层区分，
  // 「已发送到提供方」≠「已确认送达」）；healthy 不再依赖端到端 confirmed 证据。
  if ((health?.delivered ?? 0) > 0 || (health?.accepted ?? 0) > 0) return 'healthy'
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
