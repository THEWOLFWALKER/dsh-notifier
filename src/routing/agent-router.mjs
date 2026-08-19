// dsh-notifier routing/agent-router.mjs
// v0.3.2 路由解析引擎：多 agent × 多通道的双向解析链（纯解析/落盘层，不含发送）。
// 与既有 src/routing.mjs（level → 渠道语义矩阵）互补不冲突：本模块解决「agent/会话 →
// 哪些通道」与「通道消息 → 哪个 agent」两个维度；level 路由仍在全局层独立生效。
//
// 数据模型（设计稿 §2，state.json 新增键，与既有 bind:* 同域）：
//   route:agents    { "<workspace|agentId>": { channels?: string[], quiet?: bool } }
//                   键两类：workspace 名（默认键：稳定、可读、同项目多会话天然聚合）与
//                   精确 agentId（高级键：会话粒度、优先级更高，agent.id === session.id）。
//   route:channels  { "<channel>": { defaultAgent: "<workspace|agentId>" } }  // 入站默认去向
//   route:sessions  { "<sessionId>": { outbound?: { channels?, quiet? }, workspace?, lastActiveAt? } }
//                   由 session-registry 维护，本模块只读（仅 outbound diff 惰性写入）。
//
// 出站解析链（§3，字段级 diff 回落——未覆盖字段实时跟随上游，改默认立即生效）：
//   channels: route:sessions[sid].outbound.channels ?? route:agents[sid].channels
//          ?? route:agents[workspace].channels ?? 全局渠道池（v0.3.0 行为，存量用户零感知）
//   quiet:   同链回退，兜底 false。true 只静音出站推送（仍写账本），入站照常不受影响。
//
// 入站解析链（§3 + §0.5-4）：
//   显式 bind > 通道默认 agent（精确 agentId 直接用；workspace 名下多活跃会话投
//   lastActiveAt 最近者并标 ambiguous）> 唯一 agent 自动兜底 > latestSessionId（现状兜底）。
//
// 防御红线：store 方法缺失/抛错、agentsList 抛错均不外泄——解析失败等价「无路由配置」
// （回落全局池/现状链路），写入失败返回 false；setter 的入参契约违规抛 TypeError（快速
// 暴露调用方 bug），但绝不因存储层故障弄崩调用方。

const KEY_AGENTS = 'route:agents'
const KEY_CHANNELS = 'route:channels'
const KEY_SESSIONS = 'route:sessions'

/** 入站显式绑定键前缀（与 conversation.mjs 既有键格式一致：bind:<channel>:<userId>）。 */
const BIND_PREFIX = 'bind:'

/** 取「普通对象」：null / 数组 / 标量一律视为无条目（手工编辑或损坏数据防御）。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 归一渠道类型列表：仅保留非空字符串、trim、去重（保序）。非数组返回 []。 */
function normalizeChannelTypes(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const type = item.trim()
    if (type === '' || seen.has(type)) continue
    seen.add(type)
    out.push(type)
  }
  return out
}

/** 归一 quiet：宽容字符串（'false'/'FALSE' → false），其余按真值。 */
function normalizeQuiet(value) {
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return Boolean(value)
}

/** quiet 的 diff 判定：undefined = 未覆盖（回落上游）；其余归一为 bool（显式 false 不回落）。 */
function quietOverrideOf(entry) {
  if (entry === null || entry.quiet === undefined) return undefined
  return normalizeQuiet(entry.quiet)
}

/** lastActiveAt → 毫秒时间戳（数字/ISO 字符串；缺失或非法视为 0，排序兜底）。 */
function lastActiveMs(record) {
  const value = plainObjectOf(record)?.lastActiveAt
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/** setter 入参校验：非空字符串，否则 TypeError（程序员错误，契约层面快速失败）。 */
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`agent-router: ${name} 必须是非空字符串`)
  }
}

/**
 * 创建 agent 路由解析引擎（CLI 与 Web 管理台共用，API 面保持稳定）。
 *
 * @param {object} options
 * @param {object} options.store - 键值存储（src/inbound/store.mjs 形态：get/set/delete/
 *   keys/sweepPrefix，键 → JSON 值）。方法缺失或抛错一律静默容错：读按「无此数据」处理，
 *   写返回 false。
 * @param {() => Array<{id: string, status?: string}>} [options.agentsList] - 活跃 agent 快照
 *   （宿主 ctx.agents.list 的注入形态）。可能抛错，内部防御为 []。
 * @returns {object} 路由器实例，方法面见各 JSDoc。
 * @example
 *   const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
 *   const { channelTypes, quiet, source } = router.resolveOutbound(sid, workspace, enabledTypes)
 */
export function createAgentRouter({ store, agentsList } = {}) {
  // —— store 防御包装：方法缺失 / 抛错一律按「无此数据」处理，绝不外泄 ——
  const safeGet = (key, fallback = undefined) => {
    try {
      const value = typeof store?.get === 'function' ? store.get(key, fallback) : undefined
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  const safeSet = (key, value) => {
    try {
      if (typeof store?.set !== 'function') return false
      store.set(key, value)
      return true
    } catch {
      return false
    }
  }
  /** 读整表 map：值损坏（非普通对象）时回退 {}（下次写入顺带修复）。 */
  const readMap = (key) => plainObjectOf(safeGet(key)) ?? {}
  const writeMap = (key, next) => safeSet(key, next)

  // —— agentsList 防御包装：非函数 / 抛错 / 返回非数组 / 元素缺 id → 过滤为空 ——
  const listAgents = () => {
    try {
      const list = typeof agentsList === 'function' ? agentsList() : []
      if (!Array.isArray(list)) return []
      return list.filter((agent) => plainObjectOf(agent) !== null && typeof agent.id === 'string' && agent.id !== '')
    } catch {
      return []
    }
  }
  /** 「活跃」判定集合：agentsList() 里存在的 id。 */
  const activeAgentIds = () => new Set(listAgents().map((agent) => agent.id))

  /**
   * 出站逐层解析（resolveOutbound 与 describe 共用）。channels 与 quiet 各自独立走
   * 「会话 diff → 精确 agentId 条目 → workspace 条目 → 兜底」的字段级链。
   */
  function resolveOutboundLayered(sessionId, workspace, globalChannelTypes = []) {
    const global = normalizeChannelTypes(globalChannelTypes)
    const sessionDiff = plainObjectOf(plainObjectOf(readMap(KEY_SESSIONS)[sessionId])?.outbound)
    const agents = readMap(KEY_AGENTS)
    const exactEntry = plainObjectOf(agents[sessionId])
    const workspaceEntry = plainObjectOf(agents[workspace])
    const layers = [
      ['session', sessionDiff],
      ['agent-exact', exactEntry],
      ['agent-workspace', workspaceEntry],
    ]

    let source = 'global'
    let channelTypes = global
    for (const [name, entry] of layers) {
      if (entry === null || !Array.isArray(entry.channels)) continue
      source = name
      // 绑定引用了未启用渠道的剔除：只保留全局渠道池里存在的类型
      channelTypes = normalizeChannelTypes(entry.channels).filter((type) => global.includes(type))
      break
    }

    let quiet = false
    let quietSource = 'default'
    for (const [name, entry] of layers) {
      const override = quietOverrideOf(entry)
      if (override === undefined) continue
      quiet = override
      quietSource = name
      break
    }

    return { global, sessionDiff, exactEntry, workspaceEntry, channelTypes, source, quiet, quietSource }
  }

  return {
    /**
     * 解析出站目标（设计稿 §3）：某会话的一条事件应发往哪些通道、是否静音。
     *
     * channels 按字段级链取第一个「显式配置」的层（空数组也算显式配置），
     * 再过滤到 globalChannelTypes 中存在的类型；quiet 独立走同一条链，兜底 false。
     *
     * @param {string} sessionId - 会话 id（=== agent.id）。
     * @param {string} workspace - 工作区名（workspaceNameOf(session) 实时取名）。
     * @param {string[]} globalChannelTypes - 全局已启用渠道类型（兜底池 + 过滤白名单）。
     * @returns {{ channelTypes: string[], quiet: boolean,
     *   source: 'session'|'agent-exact'|'agent-workspace'|'global' }}
     *   source 标记 channels 的实际来源层（排障/Web 展示用）。
     */
    resolveOutbound(sessionId, workspace, globalChannelTypes = []) {
      const { channelTypes, quiet, source } = resolveOutboundLayered(sessionId, workspace, globalChannelTypes)
      return { channelTypes, quiet, source }
    },

    /**
     * 解析入站去向（设计稿 §3）：某通道某用户的一条消息应投给哪个会话。
     * 链：显式 bind > 通道默认 agent（活跃 agentId 直接用；workspace 名下活跃会话
     * 唯一直接用、多个投 lastActiveAt 最近者并标 ambiguous）> 唯一 agent > latestSessionId。
     * 「活跃」= agentsList() 里存在该 id；bind 层不做活跃过滤（同 id resume 绑定仍有效）。
     *
     * @param {string} channel - 通道类型（如 'telegram'）。
     * @param {string} userId - 通道侧用户 id。
     * @param {{ latestSessionId?: string|null }} [options] - 宿主最近活跃会话（最后兜底）。
     * @returns {{ sessionId: string|null, source: 'bind'|'channel-default'|'single-agent'|'latest',
     *   ambiguous: boolean, candidates?: string[] }}
     *   ambiguous=true 时附带 candidates（该 workspace 全部活跃会话，按 lastActiveAt 降序，
     *   首位即被投递的 sessionId）；sessionId=null 表示无处可投。
     */
    resolveInbound(channel, userId, { latestSessionId } = {}) {
      // L1 显式绑定：值为字符串即命中（损坏数据跳过）
      if (typeof channel === 'string' && typeof userId === 'string') {
        const bound = safeGet(`${BIND_PREFIX}${channel}:${userId}`)
        if (typeof bound === 'string' && bound.trim() !== '') {
          return { sessionId: bound, source: 'bind', ambiguous: false }
        }
      }

      const active = activeAgentIds()

      // L2 通道默认 agent：精确 agentId 优先（撞名时按 agentId 语义解析）
      const defaultAgent = plainObjectOf(readMap(KEY_CHANNELS)[channel])?.defaultAgent
      if (typeof defaultAgent === 'string' && defaultAgent !== '') {
        if (active.has(defaultAgent)) {
          return { sessionId: defaultAgent, source: 'channel-default', ambiguous: false }
        }
        // workspace 名：该 workspace 下全部活跃会话，按 lastActiveAt 降序
        const candidates = Object.entries(readMap(KEY_SESSIONS))
          .filter(([sid, record]) => plainObjectOf(record)?.workspace === defaultAgent && active.has(sid))
          .sort(([, a], [, b]) => lastActiveMs(b) - lastActiveMs(a))
          .map(([sid]) => sid)
        if (candidates.length === 1) {
          return { sessionId: candidates[0], source: 'channel-default', ambiguous: false }
        }
        if (candidates.length > 1) {
          // §0.5-4 多活跃会话消歧：投最近活跃，回执可提示「已投 <sid>，/bind 精确指定」
          return { sessionId: candidates[0], source: 'channel-default', ambiguous: true, candidates }
        }
      }

      // L3 唯一 agent 自动兜底：单 agent 用户零感知直达
      const agents = listAgents()
      if (agents.length === 1) {
        return { sessionId: agents[0].id, source: 'single-agent', ambiguous: false }
      }

      // L4 最后兜底：最近活跃（现状语义；为空表示无处可投，由调用方回执兜底）
      const latest = typeof latestSessionId === 'string' && latestSessionId !== '' ? latestSessionId : null
      return { sessionId: latest, source: 'latest', ambiguous: false }
    },

    /**
     * 写 agent 绑定（route:agents[key]，字段级更新）。
     *
     * patch 里**出现**的字段写入（channels 归一为非空字符串数组：trim 去重去空；
     * quiet 归一为 bool）；显式 `undefined`/`null` = 从条目删除该字段（回落上游）；
     * **未出现**的字段不动。条目被清空时整键回收（空条目无覆盖语义）。
     *
     * @param {string} key - 路由键：workspace 名（默认）或精确 agentId（高级）。
     * @param {{ channels?: string[], quiet?: boolean }} [patch] - 见字段级语义。
     * @returns {boolean} 是否落盘成功（store 故障返回 false，不抛）。
     * @throws {TypeError} key 非空字符串校验失败、channels 非数组、patch 非对象。
     */
    setAgentBinding(key, patch = {}) {
      assertNonEmptyString(key, 'setAgentBinding: key')
      const normalized = patch === undefined || patch === null ? {} : patch
      if (plainObjectOf(normalized) === null) throw new TypeError('agent-router: setAgentBinding: patch 必须是对象')
      const agents = readMap(KEY_AGENTS)
      const entry = { ...plainObjectOf(agents[key]) }
      if (Object.prototype.hasOwnProperty.call(normalized, 'channels')) {
        if (normalized.channels === undefined || normalized.channels === null) {
          delete entry.channels
        } else {
          if (!Array.isArray(normalized.channels)) {
            throw new TypeError('agent-router: setAgentBinding: channels 必须是字符串数组')
          }
          entry.channels = normalizeChannelTypes(normalized.channels)
        }
      }
      if (Object.prototype.hasOwnProperty.call(normalized, 'quiet')) {
        if (normalized.quiet === undefined || normalized.quiet === null) delete entry.quiet
        else entry.quiet = normalizeQuiet(normalized.quiet)
      }
      const next = { ...agents }
      if (Object.keys(entry).length > 0) next[key] = entry
      else delete next[key] // 条目清空（或本就为空）= 不留无语义的空条目
      return writeMap(KEY_AGENTS, next)
    },

    /**
     * v0.6.5（审查 R4-2-P2-2）整表替换 agent 绑定（管理台 putBindings 专用）。
     *
     * 语义与逐键 setAgentBinding 的重建链等价（未出现字段删除、空条目整键回收），
     * 但只做**一次** writeMap（= 一次锁周期 + 一次整文件写）——原「clear + set 逐键」
     * 对 N 键表做 N 次全量落盘，20 键表 = 20 次锁竞争 + 20 次整文件重写。
     * 归一复用 setAgentBinding 同款（channels: trim 去重去空；quiet: 归一 bool）。
     *
     * @param {object} table - { [key]: { channels?: string[], quiet?: boolean } }，
     *   键 = workspace 名或精确 agentId；值损坏（非普通对象）抛 TypeError（整表拒绝，零写入）。
     * @returns {boolean} 是否落盘成功（store 故障返回 false，不抛）。
     * @throws {TypeError} table 非普通对象、键非字符串/空串、条目非普通对象、channels 非数组。
     */
    replaceAgentBindings(table) {
      if (plainObjectOf(table) === null) throw new TypeError('agent-router: replaceAgentBindings: table 必须是对象')
      const next = {}
      for (const [key, rawEntry] of Object.entries(table)) {
        assertNonEmptyString(key, 'replaceAgentBindings: key')
        const entry = plainObjectOf(rawEntry)
        if (entry === null) throw new TypeError(`agent-router: replaceAgentBindings: "${key}" 必须是对象`)
        const normalized = {}
        if (entry.channels !== undefined && entry.channels !== null) {
          if (!Array.isArray(entry.channels)) {
            throw new TypeError('agent-router: replaceAgentBindings: channels 必须是字符串数组')
          }
          const channels = normalizeChannelTypes(entry.channels)
          if (channels.length > 0) normalized.channels = channels // 归一后为空 = 未配置语义
        }
        if (entry.quiet !== undefined && entry.quiet !== null) normalized.quiet = normalizeQuiet(entry.quiet)
        if (Object.keys(normalized).length > 0) next[key] = normalized // 空条目 = 整键回收
      }
      return writeMap(KEY_AGENTS, next)
    },

    /**
     * 读 agent 绑定（返回拷贝，外部修改不污染存储）。
     *
     * @param {string} key - workspace 名或精确 agentId。
     * @returns {{ channels?: string[], quiet?: boolean }|null} 无条目时 null。
     */
    getAgentBinding(key) {
      const entry = plainObjectOf(readMap(KEY_AGENTS)[key])
      if (entry === null) return null
      const copy = { ...entry }
      if (Array.isArray(copy.channels)) copy.channels = [...copy.channels]
      return copy
    },

    /**
     * 删除 agent 绑定整条目。
     *
     * @param {string} key - workspace 名或精确 agentId。
     * @returns {boolean} 键存在并删除返回 true；不存在或 store 故障返回 false。
     * @throws {TypeError} key 非空字符串校验失败。
     */
    deleteAgentBinding(key) {
      assertNonEmptyString(key, 'deleteAgentBinding: key')
      const agents = readMap(KEY_AGENTS)
      if (!Object.prototype.hasOwnProperty.call(agents, key)) return false
      const next = { ...agents }
      delete next[key]
      return writeMap(KEY_AGENTS, next)
    },

    /**
     * 写通道默认 agent（route:channels[channel].defaultAgent，入站默认去向）。
     *
     * @param {string} channel - 通道类型。
     * @param {string} agentKey - workspace 名或精确 agentId（解析语义同出站双键）。
     * @returns {boolean} 是否落盘成功。
     * @throws {TypeError} channel / agentKey 非空字符串校验失败。
     */
    setChannelDefault(channel, agentKey) {
      assertNonEmptyString(channel, 'setChannelDefault: channel')
      assertNonEmptyString(agentKey, 'setChannelDefault: agentKey')
      const channels = readMap(KEY_CHANNELS)
      const entry = { ...plainObjectOf(channels[channel]) }
      entry.defaultAgent = agentKey
      return writeMap(KEY_CHANNELS, { ...channels, [channel]: entry })
    },

    /**
     * 读通道默认 agent。
     *
     * @param {string} channel - 通道类型。
     * @returns {string|null} defaultAgent 键值；未配置或数据损坏返回 null。
     */
    getChannelDefault(channel) {
      const value = plainObjectOf(readMap(KEY_CHANNELS)[channel])?.defaultAgent
      return typeof value === 'string' && value !== '' ? value : null
    },

    /**
     * 清除通道默认 agent 整条目。
     *
     * @param {string} channel - 通道类型。
     * @returns {boolean} 键存在并删除返回 true；不存在或 store 故障返回 false。
     * @throws {TypeError} channel 非空字符串校验失败。
     */
    clearChannelDefault(channel) {
      assertNonEmptyString(channel, 'clearChannelDefault: channel')
      const channels = readMap(KEY_CHANNELS)
      if (!Object.prototype.hasOwnProperty.call(channels, channel)) return false
      const next = { ...channels }
      delete next[channel]
      return writeMap(KEY_CHANNELS, next)
    },

    /**
     * v0.6.5（审查 R4-2-P2-2）整表替换通道默认去向（管理台 putBindings 专用）。
     * 一次 writeMap 落整表（原 clear + set 逐键 = N 次全量落盘）。
     *
     * @param {object} table - { [channel]: { defaultAgent: string } }；
     *   defaultAgent 非非空字符串抛 TypeError（整表拒绝，零写入）。
     * @returns {boolean} 是否落盘成功（store 故障返回 false，不抛）。
     * @throws {TypeError} table 非普通对象、条目非普通对象、defaultAgent 非非空字符串。
     */
    replaceChannelDefaults(table) {
      if (plainObjectOf(table) === null) throw new TypeError('agent-router: replaceChannelDefaults: table 必须是对象')
      const next = {}
      for (const [channel, rawEntry] of Object.entries(table)) {
        const entry = plainObjectOf(rawEntry)
        if (entry === null) throw new TypeError(`agent-router: replaceChannelDefaults: "${channel}" 必须是对象`)
        if (typeof entry.defaultAgent !== 'string' || entry.defaultAgent.trim() === '') {
          throw new TypeError(`agent-router: replaceChannelDefaults: "${channel}".defaultAgent 必须是非空字符串`)
        }
        next[channel] = { defaultAgent: entry.defaultAgent }
      }
      return writeMap(KEY_CHANNELS, next)
    },

    /**
     * 写会话出站 diff（route:sessions[sessionId].outbound，仅存覆盖项）。
     *
     * 字段级语义：patch 里**出现**的字段写入 diff；**显式 `undefined`/`null` 的字段从
     * diff 中删除（= 回落上游实时解析）**；**未出现**的字段不动。会话记录不存在时惰性
     * 建最小记录（registry 事件注册失败时的等价兜底），不越权补 inherit/workspace 等
     * registry 字段；diff 清空后删除 outbound 键（记录本身保留，不丢 registry 数据）。
     *
     * @param {string} sessionId - 会话 id。
     * @param {{ channels?: string[], quiet?: boolean }} [patch] - 见字段级语义。
     * @returns {boolean} 是否落盘成功。
     * @throws {TypeError} sessionId 非空字符串、patch 非对象、channels 非数组。
     */
    setSessionOutbound(sessionId, patch = {}) {
      assertNonEmptyString(sessionId, 'setSessionOutbound: sessionId')
      const normalized = patch === undefined || patch === null ? {} : patch
      if (plainObjectOf(normalized) === null) throw new TypeError('agent-router: setSessionOutbound: patch 必须是对象')
      const sessions = readMap(KEY_SESSIONS)
      const record = { ...plainObjectOf(sessions[sessionId]) }
      const diff = { ...plainObjectOf(record.outbound) }
      if (Object.prototype.hasOwnProperty.call(normalized, 'channels')) {
        if (normalized.channels === undefined || normalized.channels === null) {
          delete diff.channels
        } else {
          if (!Array.isArray(normalized.channels)) {
            throw new TypeError('agent-router: setSessionOutbound: channels 必须是字符串数组')
          }
          diff.channels = normalizeChannelTypes(normalized.channels)
        }
      }
      if (Object.prototype.hasOwnProperty.call(normalized, 'quiet')) {
        if (normalized.quiet === undefined || normalized.quiet === null) delete diff.quiet
        else diff.quiet = normalizeQuiet(normalized.quiet)
      }
      if (Object.keys(diff).length > 0) record.outbound = diff
      else delete record.outbound
      return writeMap(KEY_SESSIONS, { ...sessions, [sessionId]: record })
    },

    /**
     * 列出全部 agent 路由键（workspace 名 + 精确 agentId 混排，绑定矩阵 UI 用）。
     *
     * @returns {string[]} 键列表；store 故障返回 []。
     */
    listAgentKeys() {
      return Object.keys(readMap(KEY_AGENTS))
    },

    /**
     * 把出站解析每层来源串成可读文本（/route 命令与 Web 排障用）。
     *
     * @param {string} sessionId - 会话 id。
     * @param {string} workspace - 工作区名。
     * @param {string[]} [globalChannelTypes] - 全局已启用渠道类型。
     * @returns {string} 多行文本：L1 会话 diff / L2 精确条目 / L3 workspace 条目 /
     *   L4 全局渠道池各层的键与值，末行为最终解析结果（channelTypes/quiet/source）。
     */
    describe(sessionId, workspace, globalChannelTypes = []) {
      const layered = resolveOutboundLayered(sessionId, workspace, globalChannelTypes)
      const fmt = (entry) => {
        if (entry === null) return '未配置'
        const channels = Array.isArray(entry.channels)
          ? `[${normalizeChannelTypes(entry.channels).join(', ')}]`
          : '未设置'
        const quiet = entry.quiet === undefined ? '未设置' : String(normalizeQuiet(entry.quiet))
        return `channels=${channels}, quiet=${quiet}`
      }
      return [
        `出站路由解析 session=${String(sessionId)} workspace=${String(workspace)}`,
        `  L1 会话 diff   route:sessions[${String(sessionId)}].outbound → ${fmt(layered.sessionDiff)}`,
        `  L2 精确条目   route:agents[${String(sessionId)}] → ${fmt(layered.exactEntry)}`,
        `  L3 workspace  route:agents[${String(workspace)}] → ${fmt(layered.workspaceEntry)}`,
        `  L4 全局渠道池 → [${layered.global.join(', ')}]`,
        `  解析结果 channelTypes=[${layered.channelTypes.join(', ')}] quiet=${layered.quiet} source=${layered.source}`,
      ].join('\n')
    },
  }
}
