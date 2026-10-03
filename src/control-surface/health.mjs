// dsh-notifier v0.12/v0.15 — bounded operational evidence for channel health.
//
// T12：观察面收口为**有界 + 有时序**证据——
//   - 三种证据 kind：accepted（provider 接受请求）/ delivered（显式回执=confirmed）/
//     unknown（结果不确定：超时等，**既不冒充成功也不冒充失败**）；
//   - history 有 **cap**（window）与 **TTL**（ttlMs）：过期观察自动淘汰，进程长期运行不再无界累积；
//   - 每条观察带 **epoch**（所属 runtime 实例世代）：runtime 被替换/重建后，旧实例的迟到观察
//     一律丢弃（「断线旧 epoch 观察不污染新实例」）；
//   - observer（记账）失败绝不改业务结果：所有写入都在 notify 的 try/catch 之外无副作用。

import { normalizeDeliveryEvidence, isConfirmedReceipt } from '../delivery-evidence.mjs'

/** 默认 TTL：24h 内没有新观察的渠道不再计入健康证据（进程长期运行时防无界累积）。 */
export const DEFAULT_HEALTH_TTL_MS = 24 * 60 * 60 * 1000

function blank(type) {
  return {
    type,
    delivered: 0,
    accepted: 0,
    unknown: 0,
    skipped: 0,
    failed: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastUnknownAt: null,
    lastFailureReason: null,
    epoch: 0,
    observedAt: null,
  }
}

export function createSurfaceHealth({ window = 20, ttlMs = DEFAULT_HEALTH_TTL_MS, now = Date.now } = {}) {
  const limit = Math.max(5, Math.min(100, Number(window) || 20))
  const ttl = Math.max(0, Number(ttlMs) || 0)
  const events = new Map()
  /** type -> 当前 runtime 实例世代（单调递增）。 */
  const epochs = new Map()
  const epochOf = (type) => epochs.get(String(type ?? '')) ?? 0
  const listOf = (type) => {
    const key = String(type ?? '')
    if (!events.has(key)) {
      if (events.size >= 128 || (!epochs.has(key) && epochs.size >= 128)) return []
      events.set(key, [])
    }
    return events.get(key)
  }
  /** TTL 淘汰：只保留 ttl 内的观察（ttl=0 表示不过期）。 */
  const prune = (type, at = now()) => {
    if (ttl <= 0) return
    const list = events.get(String(type ?? "")) ?? []
    const cutoff = at - ttl
    const fresh = list.filter((event) => event.at >= cutoff)
    if (fresh.length !== list.length) events.set(String(type ?? ''), fresh)
  }
  const push = (type, kind, reason = null, at = now()) => {
    if (typeof type !== 'string' || type === '') return
    const list = listOf(type)
    list.unshift({ kind, reason: reason === null ? null : String(reason).slice(0, 240), at })
    if (list.length > limit) list.length = limit
  }
  /** 递增实例世代并丢弃旧世代观察（旧 epoch 的迟到观察不污染新实例）。 */
  const markEpoch = (type, epoch) => {
    const key = String(type ?? '')
    if (key === '' || (!epochs.has(key) && epochs.size >= 128)) return 0
    const incoming = Number.isFinite(epoch) ? Number(epoch) : epochOf(key) + 1
    const current = epochOf(key)
    if (incoming <= current) return current
    epochs.set(key, incoming)
    events.set(key, []) // 旧实例的观察一律作废
    return incoming
  }
  const snapshot = (type) => {
    prune(type)
    const out = blank(type)
    out.epoch = epochOf(type)
    for (const event of events.get(String(type ?? "")) ?? []) {
      if (out.observedAt === null) out.observedAt = event.at
      if (event.kind === 'delivered') {
        out.delivered += 1
        if (out.lastSuccessAt === null) out.lastSuccessAt = event.at
      } else if (event.kind === 'accepted') {
        // v0.13（C11.5 / R4）：provider accepted 也是成功信号（请求已被提供方接收），
        // 只是证据强度弱于 confirmed；计入 lastSuccessAt，避免被更早的失败永久压成 degraded。
        out.accepted += 1
        if (out.lastSuccessAt === null) out.lastSuccessAt = event.at
      } else if (event.kind === 'unknown') {
        // T12：结果不确定（超时等）——不计成功也不计失败，单独成桶供 UI 明确表达。
        out.unknown += 1
        if (out.lastUnknownAt === null) out.lastUnknownAt = event.at
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
    // T12：runtime 实例世代变化（渠道被替换/重建）时由 runtime truth owner 调用。
    markEpoch,
    epochOf,
    clear(type) {
      const key = String(type ?? '')
      if (key === '') return false
      events.delete(key)
      return true
    },
    recordSend(record = {}) {
      const parsed = Date.parse(record.time)
      const at = Number.isFinite(parsed) ? parsed : now()
      // v0.15（Gate 2C）：观察带 **捕获于发送开始** 的 runtime 世代。换实例后，旧 epoch 的
      // 迟到观察绝不计入当前健康（否则旧实例的结果会污染新实例的观察面）；账本与调用结果
      // 本身仍保留（那是投递事实，不是健康证据）。未携带 epoch 的 legacy record 维持兼容。
      const epochs = (record.channelEpochs !== null && typeof record.channelEpochs === 'object') ? record.channelEpochs : null
      const stale = (type) => {
        if (epochs === null) return false
        const carried = Number(epochs[type])
        return Number.isFinite(carried) && carried < epochOf(type)
      }
      // v0.13（C11.5 / R4）：provider accepted / confirmed delivered 必须分开计数。
      // legacy record 只有 delivered（旧语义 = 发送 resolve），按 accepted 归类，绝不
      // 再当作「已确认送达」；只有显式 confirmed/receipt 才计 delivered。
      const { accepted, confirmed } = normalizeDeliveryEvidence(record)
      for (const type of accepted) if (!stale(String(type))) push(String(type), 'accepted', null, at)
      for (const type of confirmed) if (!stale(String(type))) push(String(type), 'delivered', null, at)
      // T12：结果不确定（超时等）单独成桶——它既不是成功证据也不是确定性失败。失败行带
      // `uncertain: true` 时**只记 unknown、不记 failed**，否则一次不确定投递会被同时算作
      // 确定失败（健康度被误压成 degraded）与 unknown（自相矛盾）。
      const uncertain = new Set()
      for (const failure of Array.isArray(record.failed) ? record.failed : []) {
        const type = String(failure?.channel ?? '')
        if (stale(type)) continue
        if (failure?.uncertain === true) {
          push(type, 'unknown', failure?.error ?? '结果未知', at)
          uncertain.add(type)
        } else {
          push(type, 'failed', failure?.error ?? '发送失败', at)
        }
      }
      for (const type of Array.isArray(record.unknown) ? record.unknown : []) {
        if (!uncertain.has(String(type)) && !stale(String(type))) push(String(type), 'unknown', null, at)
      }
      for (const type of Array.isArray(record.skipped) ? record.skipped : []) {
        if (typeof type === 'string' && !type.startsWith('(') && !stale(type)) push(type, 'skipped', null, at)
      }
    },
    recordTest(type, result) {
      if (result?.ok === true) {
        push(type, isConfirmedReceipt(result) ? 'delivered' : 'accepted')
      }
      else if (result?.uncertain === true) push(type, 'unknown', result?.detail ?? '结果未知')
      else push(type, 'failed', result?.detail ?? '测试失败')
    },
    snapshot,
  }
}

// v0.14（Stage C）：restartPending 是运行时时序状态，与 evidence 派生健康度分层。
// 已配置且 runtime 仍在跑、但尚未收敛到 desired（divergence）时，健康度既不是 degraded
// （旧 runtime 其实还活着）也不是 healthy（它跑的不是 desired），必须显式表达为 restart-pending。
export function healthState({ configured, active, health, restartPending = false }) {
  if (configured !== true) return 'unconfigured'
  if (active !== true) return 'degraded'
  if (restartPending === true) return 'restart-pending'
  if ((health?.failed ?? 0) > 0 && (health?.lastFailureAt ?? 0) >= (health?.lastSuccessAt ?? 0)) return 'degraded'
  // v0.13（C11.5 / R4）：provider accepted 即视为操作健康（标签与证据强度在 UI 层区分，
  // 「已发送到提供方」≠「已确认送达」）；healthy 不再依赖端到端 confirmed 证据。
  if ((health?.delivered ?? 0) > 0 || (health?.accepted ?? 0) > 0) {
    // T12：最近一次结果是「不确定」（超时等）时不得报 healthy——证据不成立即不宣称健康。
    if ((health?.unknown ?? 0) > 0 && (health?.lastUnknownAt ?? 0) > (health?.lastSuccessAt ?? 0)) return 'unavailable'
    return 'healthy'
  }
  // T12：只有不确定证据时也不能报 ready（未证明可用）——显式 unavailable。
  if ((health?.unknown ?? 0) > 0) return 'unavailable'
  // 配置存在 + runtime 在跑 + **无任何成功/失败证据** → ready（绝不标 online/healthy）。
  return 'ready'
}

/**
 * 健康度投影（观察面专用）。
 * T12：status 带**时间**（observedAt / last*At）与**世代**（epoch），stale/unsupported 明确。
 * @param {object} params
 * @param {boolean} params.configured
 * @param {boolean} params.active
 * @param {object|null} params.health - createSurfaceHealth().snapshot() 产物
 * @param {boolean} [params.restartPending]
 * @param {boolean} [params.supported] - 该渠道是否在当前 Host/契约下声明支持（unsupported 显式）
 */
export function healthView({ configured, active, health, restartPending = false, supported = true } = {}) {
  const h = health ?? blank('')
  const state = supported === false
    ? 'unsupported'
    : healthState({ configured, active, health: h, restartPending })
  return {
    state,
    delivered: Number(h.delivered ?? 0),
    accepted: Number(h.accepted ?? 0),
    unknown: Number(h.unknown ?? 0),
    skipped: Number(h.skipped ?? 0),
    failed: Number(h.failed ?? 0),
    // 世代：观察所属 runtime 实例；换实例后旧观察已被丢弃，此值随之前进。
    epoch: Number(h.epoch ?? 0),
    // 观察时间：最近一条证据的时间戳（无证据则省略，绝不伪造时间）。
    ...(h.observedAt ? { observedAt: new Date(h.observedAt).toISOString() } : {}),
    ...(h.lastSuccessAt ? { lastSuccessAt: new Date(h.lastSuccessAt).toISOString() } : {}),
    ...(h.lastFailureAt ? { lastFailureAt: new Date(h.lastFailureAt).toISOString() } : {}),
    ...(h.lastUnknownAt ? { lastUnknownAt: new Date(h.lastUnknownAt).toISOString() } : {}),
    ...(h.lastFailureReason ? { lastFailureReason: { en: String(h.lastFailureReason), zh: String(h.lastFailureReason) } } : {}),
  }
}
