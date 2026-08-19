// dsh-notifier routing/session-registry.mjs
// 会话注册表（v0.3.2 设计 §2「route:sessions」数据模型 + §4 会话生命周期 + §0.5 终审结论）。
// 职责一句话：把「宿主 agent 生命周期」翻译成「state.json 里的会话台账」，供三处共用——
//   1) 出站路由（agent-router / event-listener 分流）读 outbound diff 与 workspace 快照；
//   2) 入站消歧（conversation 命令族）读 lastActiveAt / activeSessions / latestActiveOf（§0.5-4「投最近活跃」）；
//   3) v0.3.3 Web 管理台（admin/api）读写会话列表与会话覆盖层。
// 生命周期要点：
//   - agent/created 自动建档，inherit = workspace 名（§0.5-2 默认路由键）——「创建会话即继承默认通道与设置」；
//   - agent/disposed 只标记 disposedAt、不删记录，保留 ttlHours（默认 24h，§4）供同 id resume 重连；
//   - resume（同 id 重建）清 disposedAt：reactive() 显式调用，或下一次 agent/created 自动完成；
//   - 回收惰性化：常规调用内联摊销 sweep（默认 60s 至多一次真扫）+ disposed 后 ttl 到期点定时兜底
//     （最长 5min——防御性回收而非精确闹钟，配合内联摊销共同兜住长跑进程）；
//   - 迁移兼容：bind:<channel>:<userId> → sessionId 的旧绑定值补最小记录（apply 时调用一次）。
// 军规：与宿主事件 / store 的一切交互全防御——事件注册失败降级为「首次出站事件惰性建档」模式（§4），
// 存储失败退化为内存态，任何输入形状异常都不抛（上游是对话线与宿主总线，绝不能弄崩宿主）。

import { basename } from 'node:path'

/** state.json 会话表键（与既有 bind:* / *:account 同域，§2）。 */
const SESSIONS_KEY = 'route:sessions'
/** 已 dispose 记录的保留窗（§4：供同 id 重连；对应可配项 route.sessionTtlHours）。 */
const DEFAULT_TTL_HOURS = 24
/** touch 摊销写盘窗口：高频活跃信号至多 5s 真写一次 store（防 state.json 写放大）。 */
const DEFAULT_TOUCH_WRITE_MS = 5000
/** 内联惰性回收的摊销间隔：常规调用至多 60s 触发一次真扫。 */
const DEFAULT_SWEEP_EVERY_MS = 60000
/** dispose 后定时兜底的上限：ttl 再长也最多 5min 醒一次。 */
const MAX_SWEEP_DELAY_MS = 300000
const HOUR_MS = 3_600_000

/** 解析非负毫秒数选项（0 合法，NaN/负数/缺省回落默认值）。 */
const nonNegativeMs = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 从 agent / session 对象防御性取工作区名（纯导出函数，无状态）。
 * 取值顺序：agentLike.header?.cwd → agentLike.session?.header?.cwd → agentLike.cwd，
 * 取到后 basename 取末段（与 event-listener 的 workspaceNameOf 同语义：cwd 末段、稳定、人类可读）；
 * 全取不到回落 String(agentLike?.id ?? agentLike?.session?.id ?? '')（§8-2：cwd 缺失时回落 session.id）。
 * @param {object} [agentLike] - 宿主 agent 对象、session 对象，或 { session } 包裹形态（agent/error 总线负载）
 * @returns {string} 工作区名；完全无线索时为空串
 */
export function workspaceOf(agentLike) {
  const cwd = agentLike?.header?.cwd ?? agentLike?.session?.header?.cwd ?? agentLike?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return basename(cwd)
  const id = agentLike?.id ?? agentLike?.session?.id
  return id === undefined || id === null ? '' : String(id)
}

/** 取会话 id：agent.id === session.id（§0.5-2），容忍 { session } 包裹与裸字符串；取不到返回空串。 */
function sessionIdOf(agentLike) {
  if (typeof agentLike === 'string') return agentLike
  const id = agentLike?.id ?? agentLike?.session?.id
  return id === undefined || id === null ? '' : String(id)
}

/**
 * 创建会话注册表（会话生命周期的唯一写入口）。
 *
 * 数据形状（state.json 键 `route:sessions`，§2）：
 * ```
 * { "<sessionId>": {
 *     inherit: "<workspace|agentId>",              // 创建时自动绑定来源（默认 = workspace 名）
 *     workspace: "<name>",                         // 建档时的工作区名快照（展示/筛选用，解析仍实时取）
 *     outbound?: { channels?: [...], quiet?: bool }, // 会话覆盖层：仅存 diff，未覆盖项实时跟随上游
 *     inbound?:  [{ channel, userId }],            // 反查：哪些对话挂在此会话
 *     createdAt, lastActiveAt, disposedAt? } }
 * ```
 *
 * @param {object} [options]
 * @param {object} [options.ctx] - cordis 上下文（ctx.on('agent/created'|'agent/disposed')、ctx.agents.list()）；
 *   缺失或无事件时全防御降级为惰性建档模式，绝不抛
 * @param {import('../inbound/store.mjs').store} [options.store] - 键值持久化；缺失/失败时退化为内存态
 * @param {number} [options.ttlHours=24] - 已 dispose 记录的保留窗（小时），到期后惰性回收
 * @param {() => number} [options.now=Date.now] - 时钟注入（测试用可变时钟）
 * @param {number} [options.touchWriteMs=5000] - touch 摊销写盘窗口（毫秒）；测试置 0 关闭摊销
 * @param {number} [options.sweepEveryMs=60000] - 内联惰性回收的摊销间隔（毫秒）；测试置 0 每次真扫
 * @returns {object} 注册表实例（见各方法 JSDoc；dispose() 释放事件与定时器）
 */
export function createSessionRegistry(options = {}) {
  const ctx = options.ctx
  const store = options.store
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlHours = (() => {
    const n = Number(options.ttlHours)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_HOURS
  })()
  const ttlMs = ttlHours * HOUR_MS
  const touchWriteMs = nonNegativeMs(options.touchWriteMs, DEFAULT_TOUCH_WRITE_MS)
  const sweepEveryMs = nonNegativeMs(options.sweepEveryMs, DEFAULT_SWEEP_EVERY_MS)

  const warn = (message) => {
    try { ctx?.logger?.warn?.('[dsh-notifier/session-registry]', message) } catch { /* 日志失败绝不致命 */ }
  }

  // ---- store 防御壳：任何存储异常都退化为内存态，绝不向上抛 ----
  const loadSessions = () => {
    try {
      const value = store?.get?.(SESSIONS_KEY)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* 损坏/无 store：内存态起步 */ }
    return {}
  }
  /** 运行期权威内存态（构造时从 store 载入；此后变更写回 store）。 */
  const sessions = loadSessions()
  let lastWriteMs = now() // 构造即视为刚同步过（内存态来自盘上），touch 摊销的基准点
  let lastSweepMs = -Infinity // 首次内联 prune 即真扫一次（清掉停机期间过期的记录）
  const persist = () => {
    lastWriteMs = now()
    try { store?.set?.(SESSIONS_KEY, sessions) } catch { /* 写盘失败：内存态继续工作 */ }
  }

  /** 记录读取（形状异常当不存在，返回 undefined）。 */
  const recordOf = (sessionId) => {
    const record = sessions[String(sessionId ?? '')]
    return record !== null && typeof record === 'object' ? record : undefined
  }
  /** 记录兜底建档（不落盘，由调用方决定）；inherit/workspace 空串占位，等 agent/created 或出站事件补全。 */
  const ensureRecord = (id) => {
    let record = recordOf(id)
    if (record === undefined) {
      const nowMs = now()
      record = { inherit: '', workspace: '', createdAt: nowMs, lastActiveAt: nowMs }
      sessions[id] = record
    }
    return record
  }

  // ---- 回收（§4：disposed + ttl 到期才删；bind:* 不清——同 id resume 绑定仍有效）----
  /** 真扫：删除 disposedAt 距 now 超过 ttl 的记录，返回被删的 sessionId 数组。 */
  const sweepAll = () => {
    lastSweepMs = now()
    const nowMs = lastSweepMs
    const removed = []
    for (const [id, record] of Object.entries(sessions)) {
      const disposedAt = record?.disposedAt
      if (disposedAt === undefined || disposedAt === null) continue
      if (nowMs - Number(disposedAt) > ttlMs) removed.push(id)
    }
    if (removed.length > 0) {
      for (const id of removed) delete sessions[id]
      persist()
    }
    return removed
  }
  /** 内联摊销回收：挂在常规调用入口，距上次真扫超过 sweepEveryMs 才真扫。 */
  const prune = () => {
    if (now() - lastSweepMs >= sweepEveryMs) {
      try { sweepAll() } catch (error) { warn(`惰性回收失败: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  // ---- dispose 后的定时兜底：ttl 到期点（最长 5min）再扫一次 ----
  const sweepTimers = new Set()
  const scheduleSweepTimer = (disposedAt) => {
    const delay = Math.max(0, Math.min(Number(disposedAt) + ttlMs - now(), MAX_SWEEP_DELAY_MS))
    const timer = setTimeout(() => {
      sweepTimers.delete(timer)
      try { sweepAll() } catch (error) { warn(`定时回收失败: ${error instanceof Error ? error.message : String(error)}`) }
    }, delay)
    if (typeof timer?.unref === 'function') timer.unref() // 兜底扫描不拖住进程退出（dispose 时亦会清）
    sweepTimers.add(timer)
  }

  // ---- 活跃判定：宿主 agents.list() 是事实来源；不可用时回落注册表自身（未 disposed 记录）----
  /** 宿主活跃 id 列表；agents.list 不可用/抛错/形状异常返回 null（= 不可用）。 */
  const liveAgentIds = () => {
    try {
      if (typeof ctx?.agents?.list !== 'function') return null
      const list = ctx.agents.list()
      if (!Array.isArray(list)) return null
      const ids = []
      for (const agent of list) {
        const id = sessionIdOf(agent)
        if (id !== '') ids.push(id)
      }
      return ids
    } catch { return null }
  }
  const lastActiveMsOf = (id) => {
    const at = Number(recordOf(id)?.lastActiveAt)
    return Number.isFinite(at) ? at : 0
  }
  const byLastActiveDesc = (a, b) => lastActiveMsOf(b) - lastActiveMsOf(a)

  const registry = {
    /**
     * agent/created 时调用：为会话建档（不存在则建，存在则只刷新 lastActiveAt）。
     * 新建记录 = { inherit: workspace 名, workspace, createdAt, lastActiveAt }（§4 自动绑定）。
     * 已存在时不覆盖 createdAt / outbound diff / inbound；若此前已 dispose（同 id resume）则清
     * disposedAt；若 workspace 为迁移占位空串则补全（「等 agent/created 再补全」）。
     * @param {object} agentLike - 宿主 agent/session 对象（或 { session } 包裹形态）
     * @returns {object|undefined} 记录副本；取不到 sessionId 时 undefined
     */
    ensureSession(agentLike) {
      prune()
      const id = sessionIdOf(agentLike)
      if (id === '') return undefined
      const nowMs = now()
      const workspace = workspaceOf(agentLike)
      let record = recordOf(id)
      if (record === undefined) {
        record = { inherit: workspace, workspace, createdAt: nowMs, lastActiveAt: nowMs }
        sessions[id] = record
        persist()
        return { ...record }
      }
      record.lastActiveAt = nowMs
      if (record.disposedAt !== undefined) delete record.disposedAt // 同 id 重建 = resume
      if ((record.workspace === undefined || record.workspace === '') && workspace !== '') {
        record.workspace = workspace
        if (record.inherit === undefined || record.inherit === '') record.inherit = workspace
      }
      persist()
      return { ...record }
    },

    /**
     * 仅刷新 lastActiveAt（入站消歧「投最近活跃」的活跃信号，§0.5-4）。记录不存在时忽略。
     * 摊销写盘：距上次写盘超过 touchWriteMs（默认 5s）才真写 store——内存态实时、盘上至多滞后一个窗口。
     * @param {string} sessionId
     * @returns {object|undefined} 记录副本；记录不存在时 undefined
     */
    touch(sessionId) {
      prune()
      const record = recordOf(sessionId)
      if (record === undefined) return undefined
      const nowMs = now()
      record.lastActiveAt = nowMs
      if (nowMs - lastWriteMs >= touchWriteMs) persist()
      return { ...record }
    },

    /**
     * agent/disposed 时调用：记 disposedAt = now()，不删记录（保留 ttlHours 供同 id resume，§4）。
     * 幂等：已 dispose 再 dispose 不改 disposedAt、不重排定时器。记录不存在时惰性补最小记录再标记
     * （防御：事件注册降级期间漏建档的会话也进入保留窗语义）。
     * @param {string} sessionId
     * @returns {object|undefined} 记录副本
     */
    markDisposed(sessionId) {
      const id = String(sessionId ?? '')
      if (id === '') return undefined
      const record = ensureRecord(id)
      if (record.disposedAt === undefined) {
        record.disposedAt = now()
        scheduleSweepTimer(record.disposedAt)
        persist()
      }
      prune()
      return { ...record }
    },

    /**
     * resume：disposed 后同 id 重建（重连）时清 disposedAt 并刷新 lastActiveAt。
     * agent/created 路径会自动做同样的事；本方法供命令族 / 管理台显式调用（无 agentLike 对象时）。
     * @param {string} sessionId
     * @returns {object|undefined} 记录副本；记录不存在时 undefined（不建档）
     */
    reactive(sessionId) {
      prune()
      const record = recordOf(sessionId)
      if (record === undefined) return undefined
      if (record.disposedAt !== undefined) {
        delete record.disposedAt
        record.lastActiveAt = now()
        persist()
      }
      return { ...record }
    },

    /**
     * 惰性回收：删除 disposedAt 距 now 超过 ttlHours 的记录（含其 inbound 挂钩；
     * bind:* 不清——同 id resume 场景绑定仍有效，§4）。显式调用总是真扫。
     * @returns {string[]} 被删除的 sessionId 数组
     */
    sweep() {
      return sweepAll()
    },

    /**
     * 会话是否活跃。宿主 agents.list() 可用时以其为准（事实来源）；不可用时回落
     * 「注册表有记录且未 dispose」。
     * @param {string} sessionId
     * @returns {boolean}
     */
    isActive(sessionId) {
      prune()
      const id = String(sessionId ?? '')
      if (id === '') return false
      const live = liveAgentIds()
      if (live !== null) return live.includes(id)
      const record = recordOf(id)
      return record !== undefined && record.disposedAt === undefined
    },

    /**
     * 活跃会话 id 列表（lastActiveAt 降序，最新活跃在前）。
     * agents.list() 可用时取「宿主活跃 ∩ 注册表记录」交集优先（注册表可描述的会话）；
     * 不可用时回落「注册表中未 disposed 的记录」。
     * @returns {string[]}
     */
    activeSessions() {
      prune()
      const live = liveAgentIds()
      if (live === null) {
        return Object.keys(sessions)
          .filter((id) => recordOf(id)?.disposedAt === undefined)
          .sort(byLastActiveDesc)
      }
      return live.filter((id) => recordOf(id) !== undefined).sort(byLastActiveDesc)
    },

    /**
     * 某工作区下的会话列表（活跃优先，含 disposed 未回收的标记）。
     * @param {string} workspace - 工作区名（workspaceNameOf / workspaceOf 产物）
     * @returns {Array<{ id: string, active: boolean, inherit: string, workspace: string,
     *   outbound?: object, inbound?: Array<{channel: string, userId: string}>,
     *   createdAt: number, lastActiveAt: number, disposedAt?: number }>}
     *   记录副本数组：active 在前，同组内 lastActiveAt 降序；active = 宿主活跃（或回落语义下未 dispose）
     */
    sessionsOfWorkspace(workspace) {
      prune()
      const target = String(workspace ?? '')
      const live = liveAgentIds()
      const activeOf = (id) => (live !== null ? live.includes(id) : recordOf(id)?.disposedAt === undefined)
      return Object.keys(sessions)
        .filter((id) => recordOf(id)?.workspace === target)
        .map((id) => ({ ...recordOf(id), id, active: activeOf(id) }))
        .sort((a, b) => (a.active === b.active ? b.lastActiveAt - a.lastActiveAt : (a.active ? -1 : 1)))
    },

    /**
     * 候选会话中 lastActiveAt 最大者（入站多活跃会话消歧「投最近活跃」，§0.5-4 / §3）。
     * @param {Iterable<string>} sessionIds - 候选 id 集合（注册表外的 id 被忽略）
     * @returns {string|undefined} 最近活跃的 sessionId；候选中无已建档会话时 undefined
     */
    latestActiveOf(sessionIds) {
      prune()
      let best = undefined
      let bestAt = -Infinity
      for (const sessionId of sessionIds ?? []) {
        const id = String(sessionId ?? '')
        if (recordOf(id) === undefined) continue
        const at = lastActiveMsOf(id)
        if (at > bestAt) {
          bestAt = at
          best = id
        }
      }
      return best
    },

    /**
     * 读会话记录（副本，外部修改不会污染注册表内部状态）。
     * @param {string} sessionId
     * @returns {object|undefined} 记录副本；不存在时 undefined
     */
    getSession(sessionId) {
      prune()
      const record = recordOf(sessionId)
      return record === undefined ? undefined : { ...record }
    },

    /**
     * 写会话出站覆盖层（diff 合并，非快照——未覆盖项实时跟随上游，§1 决策 2）。
     * 与既有 route:sessions[id].outbound 字段级合并：diff 中值为 undefined 的键从 outbound 删除
     * （置空后 outbound 键整只移除，state.json 不膨胀）；记录不存在时惰性建最小记录
     * （事件注册降级为惰性建档模式的落点之一）。
     * @param {string} sessionId
     * @param {object} diff - 如 { channels?: string[], quiet?: boolean }；undefined 值 = 删该键
     * @returns {object|undefined} 记录副本
     */
    setOutbound(sessionId, diff) {
      prune()
      const id = String(sessionId ?? '')
      if (id === '') return undefined
      const record = ensureRecord(id)
      const source = diff !== null && typeof diff === 'object' ? diff : {}
      const merged = { ...(record.outbound ?? {}) }
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) delete merged[key]
        else merged[key] = value
      }
      if (Object.keys(merged).length > 0) record.outbound = merged
      else delete record.outbound
      persist()
      return { ...record }
    },

    /**
     * 挂入站对话到会话（反查表：哪些 channel:userId 对话挂在此会话）。同绑定去重追加。
     * 记录不存在时惰性建最小记录。绑定缺 channel/userId 时不做任何变更。
     * @param {string} sessionId
     * @param {{ channel: string, userId: string }} binding
     * @returns {object|undefined} 记录副本
     */
    attachInbound(sessionId, binding) {
      prune()
      const id = String(sessionId ?? '')
      if (id === '') return undefined
      const channel = binding?.channel
      const userId = binding?.userId
      if (channel === undefined || channel === null || userId === undefined || userId === null) {
        const existing = recordOf(id)
        return existing === undefined ? undefined : { ...existing }
      }
      const record = ensureRecord(id)
      const list = Array.isArray(record.inbound) ? record.inbound.filter((item) => item != null) : []
      if (!list.some((item) => item.channel === channel && item.userId === userId)) {
        record.inbound = [...list, { channel, userId }]
        persist()
      }
      return { ...record }
    },

    /**
     * 摘除会话上的一个入站对话绑定；摘空后 inbound 键整只移除。记录/绑定不存在时安全无操作。
     * @param {string} sessionId
     * @param {{ channel: string, userId: string }} binding
     * @returns {object|undefined} 记录副本；记录不存在时 undefined
     */
    detachInbound(sessionId, binding) {
      prune()
      const record = recordOf(sessionId)
      if (record === undefined) return undefined
      const channel = binding?.channel
      const userId = binding?.userId
      const list = Array.isArray(record.inbound) ? record.inbound : []
      const next = list.filter((item) => !(item?.channel === channel && item?.userId === userId))
      if (next.length !== list.length) {
        if (next.length === 0) delete record.inbound
        else record.inbound = next
        persist()
      }
      return { ...record }
    },

    /**
     * 迁移兼容（apply 时调用一次）：遍历 store.keys('bind:')，值为 sessionId 字符串但
     * route:sessions 尚无该记录时，惰性补一条最小记录（inherit/workspace 空串占位，
     * 等出站事件或 agent/created 再补全）——旧绑定会话在台账里立即可见。
     * @returns {number} 本次补建的记录数
     */
    migrateLegacyBinds() {
      let keys = []
      try { keys = store?.keys?.('bind:') ?? [] } catch { keys = [] }
      const nowMs = now()
      let migrated = 0
      for (const key of keys) {
        let value
        try { value = store?.get?.(key) } catch { continue }
        if (typeof value !== 'string' || value === '') continue
        if (recordOf(value) !== undefined) continue
        sessions[value] = { inherit: '', workspace: '', createdAt: nowMs, lastActiveAt: nowMs }
        migrated += 1
      }
      if (migrated > 0) persist()
      return migrated
    },

    /** 反注册宿主事件 + 清理全部定时兜底（幂等，可重复调用）。 */
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try { disposer() } catch { /* 反注册失败不致命 */ }
      }
      for (const timer of sweepTimers) clearTimeout(timer)
      sweepTimers.clear()
    },
  }

  // ---- 宿主事件接线（全防御：注册失败降级为惰性建档模式，绝不抛，§4）----
  const disposers = []
  const listen = (event, handler) => {
    let disposer = null
    try {
      disposer = ctx?.on?.(event, (payload) => {
        try { handler(payload) } catch (error) { warn(`${event} 处理失败: ${error instanceof Error ? error.message : String(error)}`) }
      })
    } catch { /* 宿主无此事件：降级为惰性建档模式 */ }
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  listen('agent/created', (agent) => { registry.ensureSession(agent) })
  listen('agent/disposed', (agent) => {
    const id = sessionIdOf(agent)
    if (id !== '') registry.markDisposed(id)
  })

  return registry
}
