// Sessions and routing control application service.
//
// Single orchestration entry for the bindings snapshot, binding replacement, the
// session list projection and the per-session outbound/control overlays, shared by
// the Native control surface. It owns orchestration and projection only.
//
// It deliberately does NOT merge the three routing authorities into one god
// object — those are three distinct business facts (I1) and stay where they are:
//
//   - session lifecycle           -> session-registry (`src/routing/session-registry.mjs`)
//   - routing / outbound overrides -> agent-router     (`src/routing/agent-router.mjs`)
//   - control overlay normalization-> session-arbiter  (`src/control/session-arbiter.mjs`)
//
// The service composes them; it never re-implements the route table merge, the
// overlay normalization, or the lifecycle sweep. Crucially it does NOT reintroduce
// the historical `route:sessions` stale-cache whole-table overwrite: every write
// goes through the router setters, which re-read the latest store table and merge
// the field-level diff (I10). The bindings double-table replace, when both sides are
// supplied, is delegated to the router's single transaction (I3).
//
// It does NOT own:
//   - HTTP status mapping / ApiError / audit files (adapter-level, I9)
//   - request-shape validation and channel whitelists (adapter-level, I9)
//   - React / client state
//
// Failure semantics (I2 / I16): a failed durable commit is surfaced as
// `storage-failed`; the adapters must report failure, never success.

const KEY_AGENTS = 'route:agents'
const KEY_CHANNELS = 'route:channels'
const KEY_SESSIONS = 'route:sessions'

const isFn = (value) => typeof value === 'function'

/** 取「普通对象」：null / 数组 / 标量一律视为无条目（手工编辑或损坏数据防御）。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 深拷贝纯 JSON 值（copy-on-read：外部改返回值绝不污染 store）。 */
function deepCopyPlain(value) {
  try { return JSON.parse(JSON.stringify(value ?? null)) } catch { return value }
}

/** lastActiveAt → 毫秒时间戳（数字/ISO 字符串；缺失或非法视为 0，排序兜底）。 */
function lastActiveMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/**
 * 会话控制覆盖层的**安全脱敏摘要**（sessions 投影行 / patchSessionControl 返回值用）。
 * 只暴露 mode / approvalOwnerOnly / ownerConfigured / approvalMembersCount——绝不回显任何
 * 原始 owner、成员 channel/accountId/userId 标识（credential/identifier 零泄漏）。覆盖层缺失
 * 或损坏时返回 undefined（行内省略该键）。与 admin 原实现逐字等价。
 * @param {unknown} control - route:sessions[id].control 原始值。
 * @returns {{mode?: string, approvalOwnerOnly?: boolean, ownerConfigured?: boolean,
 *   approvalMembersCount?: number} | undefined}
 */
export function controlSummary(control) {
  const raw = plainObjectOf(control)
  if (raw === null || Object.keys(raw).length === 0) return undefined
  const summary = {}
  if (raw.mode === 'team' || raw.mode === 'personal') summary.mode = raw.mode
  if (typeof raw.approvalOwnerOnly === 'boolean') summary.approvalOwnerOnly = raw.approvalOwnerOnly
  if (typeof raw.owner === 'string' && raw.owner !== '') summary.ownerConfigured = true
  if (Array.isArray(raw.approvalMembers)) summary.approvalMembersCount = raw.approvalMembers.length
  return Object.keys(summary).length > 0 ? summary : undefined
}

/**
 * @param {object} deps
 * @param {object} [deps.router] - createAgentRouter() instance (route table + resolver authority)
 * @param {object} [deps.registry] - createSessionRegistry() instance (session lifecycle authority)
 * @param {object} [deps.store] - durable store (only for defensive read fallbacks)
 * @param {(message: string) => void} [deps.warn] - diagnostics sink for degraded writes
 */
export function createRoutingControlService({ router = null, registry = null, store = null, warn = null } = {}) {
  const hasRouter = router !== null && router !== undefined
  const emitWarn = (message) => { try { warn?.(message) } catch { /* 日志失败绝不致命 */ } }

  // ---- store 防御壳：方法缺失/抛错一律按「无此数据」处理，绝不外泄 ----
  const safeGet = (key, fallback = undefined) => {
    try {
      const value = typeof store?.get === 'function' ? store.get(key, fallback) : undefined
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  const readTable = (key) => plainObjectOf(safeGet(key)) ?? {}

  /** router setter 防御包装：非函数/抛错/返回非 true 一律视为写入失败。 */
  const callSetter = (setter, ...args) => {
    try {
      return typeof setter === 'function' ? setter(...args) === true : false
    } catch (error) {
      emitWarn(`路由写入失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // ————————————————————————— 双向绑定 —————————————————————————

  /** 整表绑定快照（读权威在 router；缺失时回落 store 原表读取以保持只读降级）。 */
  const bindingsSnapshot = () => {
    if (hasRouter && isFn(router.snapshotBindings)) return router.snapshotBindings()
    return {
      agents: deepCopyPlain(readTable(KEY_AGENTS)),
      channels: deepCopyPlain(readTable(KEY_CHANNELS)),
    }
  }

  /**
   * 整表替换双向绑定。两表一起出现时经 router 单事务提交（I3）；否则单键写。
   * @returns {{ ok: boolean, reason?: string }} reason='invalid' 形状拒绝 / 'storage-failed' 未落盘
   */
  const replaceBindings = ({ agents, channels } = {}) => {
    if (hasRouter && isFn(router.replaceBindings)) {
      try {
        const result = router.replaceBindings({ agents, channels })
        return result?.ok === true ? { ok: true } : { ok: false, reason: 'storage-failed' }
      } catch {
        return { ok: false, reason: 'invalid' }
      }
    }
    // Legacy router contract (pre-v0.6.5 / test stubs): per-table single-key replace.
    if (hasRouter) {
      const hasAgents = agents !== undefined && agents !== null
      const hasChannels = channels !== undefined && channels !== null
      if (!hasAgents && !hasChannels) return { ok: true }
      try {
        if (hasAgents && (!isFn(router.replaceAgentBindings) || router.replaceAgentBindings(agents) !== true)) {
          return { ok: false, reason: 'storage-failed' }
        }
        if (hasChannels && (!isFn(router.replaceChannelDefaults) || router.replaceChannelDefaults(channels) !== true)) {
          return { ok: false, reason: 'storage-failed' }
        }
        return { ok: true }
      } catch {
        return { ok: false, reason: 'invalid' }
      }
    }
    return { ok: false, reason: 'not-supported' }
  }

  // ————————————————————————— 会话 —————————————————————————

  /** registry.isActive 防御包装：缺失/抛错一律 false。 */
  const isActiveOf = (id) => {
    try { return typeof registry?.isActive === 'function' ? registry.isActive(id) === true : false } catch { return false }
  }
  /** registry.getSession 防御包装：缺失/抛错一律 undefined。 */
  const registrySessionOf = (id) => {
    try { return typeof registry?.getSession === 'function' ? registry.getSession(id) : undefined } catch { return undefined }
  }
  /** 会话是否曾建档：store 有记录或 registry 内存态有记录（registry 内存可能领先盘上）。 */
  const hasSession = (id) => plainObjectOf(readTable(KEY_SESSIONS)[id]) !== null || registrySessionOf(id) !== undefined

  /** route:sessions 表全部条目 id（含已 dispose 未回收）。 */
  const sessionIds = () => Object.keys(readTable(KEY_SESSIONS))

  /** 出站解析视图（实时，非快照）；router 缺失/抛错回落「无路由配置」等价解析。 */
  const resolveOutbound = (sessionId, workspace, enabledTypes = []) => {
    const enabled = Array.isArray(enabledTypes) ? enabledTypes : []
    try {
      if (isFn(router?.resolveOutbound)) return router.resolveOutbound(sessionId, workspace, enabled)
    } catch { /* 解析失败等价无路由配置 */ }
    return { channelTypes: [...enabled], quiet: false, source: 'global' }
  }

  /**
   * 会话列表投影（route:sessions 全量 + 实时出站解析 + 安全脱敏控制摘要）。
   * 排序：活跃在前、同组 lastActiveAt 降序；损坏条目跳过。
   * @param {{ enabledTypes?: string[] }} [options]
   * @returns {Array<object>} 行数组（与 admin getSessions 口径逐字等价）
   */
  const sessionsView = ({ enabledTypes = [] } = {}) => {
    const enabled = Array.isArray(enabledTypes) ? enabledTypes : []
    const rows = []
    for (const [id, record] of Object.entries(readTable(KEY_SESSIONS))) {
      const rec = plainObjectOf(record)
      if (rec === null) continue // 损坏条目（手工编辑/半截写入）：跳过，不弄崩列表
      const workspace = typeof rec.workspace === 'string' ? rec.workspace : undefined
      const row = {
        id,
        workspace: rec.workspace,
        inherit: rec.inherit,
        active: isActiveOf(id),
        lastActiveAt: rec.lastActiveAt,
        resolved: resolveOutbound(id, workspace, enabled),
      }
      if (rec.disposedAt !== undefined) row.disposedAt = rec.disposedAt
      if (rec.outbound !== undefined) row.outbound = deepCopyPlain(rec.outbound)
      if (rec.inbound !== undefined) row.inbound = deepCopyPlain(rec.inbound)
      const ctrl = controlSummary(rec.control)
      if (ctrl !== undefined) row.control = ctrl // Stage 4 安全脱敏覆盖层摘要（绝无原始标识符）
      rows.push(row)
    }
    rows.sort((a, b) => (a.active === b.active
      ? lastActiveMs(b.lastActiveAt) - lastActiveMs(a.lastActiveAt)
      : (a.active ? -1 : 1)))
    return rows
  }

  /**
   * 单会话详情视图（Native Session Detail）：与 sessionsView 同一行口径，按 id 取出。
   * 未建档 → null（适配器据此映射 not-found）。
   * @param {string} id
   * @param {{ enabledTypes?: string[] }} [options]
   * @returns {object|null}
   */
  const sessionView = (id, { enabledTypes = [] } = {}) => {
    const wanted = typeof id === 'string' ? id : ''
    return sessionsView({ enabledTypes }).find((row) => row.id === wanted) ?? null
  }

  /**
   * 编辑会话出站覆盖层（字段级 diff，经 router 的再读合并落盘，防 sibling clobber）。
   * @returns {{ ok: boolean, reason?: string, outbound?: object }}
   */
  const patchSessionOutbound = (id, diff) => {
    if (!callSetter(router?.setSessionOutbound, id, diff)) return { ok: false, reason: 'storage-failed' }
    const outbound = plainObjectOf(plainObjectOf(readTable(KEY_SESSIONS)[id])?.outbound)
    return { ok: true, outbound: outbound === null ? undefined : deepCopyPlain(outbound) }
  }

  /**
   * 写会话控制覆盖层（经 router 的再读合并 + session-arbiter 归一落盘）。
   * @returns {{ ok: boolean, reason?: string, control?: object }} control = 安全脱敏摘要
   */
  const patchSessionControl = (id, diff) => {
    if (!callSetter(router?.setSessionControl, id, diff)) return { ok: false, reason: 'storage-failed' }
    const control = plainObjectOf(plainObjectOf(readTable(KEY_SESSIONS)[id])?.control)
    return { ok: true, control: controlSummary(control) }
  }

  return {
    hasRouter,
    // bindings
    bindingsSnapshot,
    replaceBindings,
    // sessions
    sessionIds,
    hasSession,
    resolveOutbound,
    sessionsView,
    sessionView,
    patchSessionOutbound,
    patchSessionControl,
  }
}
