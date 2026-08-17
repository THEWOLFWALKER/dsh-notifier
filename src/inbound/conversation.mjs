// dsh-notifier inbound/conversation.mjs
// 会话路由器（阶段 5 + v0.3.2 路由引擎）：手机回复 → 送进正在跑的 agent。
// 三个投递语义（对齐宿主 Agent API，见 docs/subsystems/core.md）：
//  - followup：agent 空闲 → 作为下一轮输入并唤醒（「任务做完了，再做一件」）
//  - inject：  agent 忙碌 → 排队到下一步边界，不唤醒不打断（排队补料）
//  - steer：   `!` 前缀 → 就近纠偏；空闲时等价 followup（「马上改，别跑偏」）
// 命令集：/help /status /bind <sessionId> /unbind /stop /agent [/agent use|back] /route
//         /quiet <workspace|sid> /unquiet <workspace|sid>（v0.5 特性 C：静默/恢复会话出站推送）
// v0.3.2 入站去向（注入 router 时，设计稿 §3）：
//   显式 bind > 通道默认 agent（workspace 多活跃会话投最近活跃 + 消歧回执）
//   > 唯一 agent 兜底 > 最近活跃（现状）。router 缺省时保持 v0.3.1 旧行为（bind > latest）。
// 军规：入站文本只能以 plugin 来源进会话流（source.kind = 'plugin'），永不直接执行 shell；
// 任何投递异常只回执用户，绝不弄崩宿主。

import { randomUUID } from 'node:crypto'
import { workspaceOf } from '../routing/session-registry.mjs'
import { CHANNEL_TYPES } from '../config.mjs'

const DEFAULT_MERGE_WINDOW_MS = 1500
const SUMMARY_MAX_CHARS = 120

/** 入站解析来源层的展示标签（/route 入站段用，与 agent-router 的 source 值一一对应）。 */
const INBOUND_SOURCE_LABELS = {
  bind: '显式绑定（/bind 或 /agent use）',
  'channel-default': '通道默认 agent',
  'single-agent': '唯一 agent 兜底',
  latest: '最近活跃（默认兜底）',
}

/** 组装宿主 UserMessage（source.kind = 'plugin'，与 call-me 同构）。 */
function buildUserMessage(text, plugin = 'dsh-notifier') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: String(text).slice(0, SUMMARY_MAX_CHARS) },
  }
}

/**
 * 注册会话路由器。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（ctx.agents / ctx.on）
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} deps.bus
 * @param {import('./store.mjs').store} deps.store - 绑定关系持久化（bind:<channel>:<userId> → sessionId）
 * @param {(channel: string, chatId: string, text: string) => void} [deps.reply] - 回执通道（命令反馈）
 * @param {object} [deps.config] - { mergeWindowMs?, steerPrefix? }
 * @param {object} [deps.logger]
 * @param {ReturnType<typeof import('../routing/agent-router.mjs').createAgentRouter>} [deps.router]
 *   - v0.3.2 入站解析链（bind > 通道默认 > 单 agent > 最近活跃）；缺省回落旧行为
 * @param {ReturnType<typeof import('../routing/session-registry.mjs').createSessionRegistry>} [deps.registry]
 *   - 会话台账（/agent 命令族数据源、活跃信号 touch、入站对话挂钩维护）；缺省时命令族降级提示
 * @param {() => string[]} [deps.channelTypes] - 全局已启用渠道类型（v0.3.2 出站解析的兜底池
 *   与过滤白名单）；缺省回落 config.mjs 的 CHANNEL_TYPES 全量（乐观池）
 * @returns {() => void} 反注册函数
 */
export function registerConversationRouter(deps) {
  const { ctx, bus, store } = deps
  const reply = typeof deps.reply === 'function' ? deps.reply : () => {}
  const cfg = deps.config ?? {}
  const router = deps.router ?? null
  const registry = deps.registry ?? null
  // mergeWindowMs 归一：undefined/null → 默认；0 合法（README 承诺「0 = 关闭合并」，立即投递）；
  // 非数字/NaN → 默认；负数 → 0（Math.max 兜底）。注意不能用 `Number(x) || 默认`——那会把
  // 显式 0 当 falsy 回落 1500，使下方 `mergeWindowMs === 0` 的立即投递分支永不可达（v0.3.2 审查修复）。
  const mergeWindowRaw = cfg.mergeWindowMs
  const mergeWindowNumber = Number(mergeWindowRaw)
  const mergeWindowMs = mergeWindowRaw === undefined || mergeWindowRaw === null || !Number.isFinite(mergeWindowNumber)
    ? DEFAULT_MERGE_WINDOW_MS
    : Math.max(0, mergeWindowNumber)
  const steerPrefix = typeof cfg.steerPrefix === 'string' && cfg.steerPrefix.length > 0 ? cfg.steerPrefix : '!'
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/conversation]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/conversation]', message) } catch { /* 控制台不可用不致命 */ }
  }

  // 全局渠道池（v0.3.2 出站解析的兜底池 + 过滤白名单）。缺省回落 config 的全量渠道类型
  // （乐观池：装配层不注入时宁可多列也不漏，resolveOutbound 自带「全局池内存在」过滤）。
  const channelTypesFn = typeof deps.channelTypes === 'function' ? deps.channelTypes : () => CHANNEL_TYPES
  /** 防御：注入函数抛错 / 返回非数组 → []（绝不弄崩命令族）。 */
  const globalTypes = () => {
    try {
      const list = channelTypesFn()
      return Array.isArray(list) ? list.filter((type) => typeof type === 'string' && type !== '') : []
    } catch { return [] }
  }

  // 最近活跃的根 agent：未显式 /bind 时的默认投递目标
  let latestSessionId = null
  const disposers = []

  const agentsOf = () => {
    try { return typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : [] } catch { return [] }
  }
  const agentOf = (sessionId) => {
    try { return typeof ctx?.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined } catch { return undefined }
  }
  const bindingKey = (envelope) => `bind:${envelope.channel}:${envelope.userId}`

  // ---- v0.3.2 命令族支撑（军规：registry/router 任何缺失或抛错一律降级，绝不弄崩投递主线）----

  /** registry 方法防御壳：缺实例 / 缺方法 / 抛错 → undefined（调用方各自兜底）。 */
  const registryCall = (method, ...args) => {
    try {
      if (registry === null || typeof registry[method] !== 'function') return undefined
      return registry[method](...args)
    } catch (error) {
      warn(`registry.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  /** router 方法防御壳：同上。 */
  const routerCall = (method, ...args) => {
    try {
      if (router === null || typeof router[method] !== 'function') return undefined
      return router[method](...args)
    } catch (error) {
      warn(`router.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 会话的 workspace 名：registry 台账快照优先，缺档回落宿主 agent 的 cwd 末段。 */
  const workspaceOfSid = (sessionId) => {
    const record = registryCall('getSession', sessionId)
    if (typeof record?.workspace === 'string' && record.workspace !== '') return record.workspace
    const agent = agentOf(sessionId)
    return agent !== undefined ? workspaceOf(agent) : ''
  }

  /** 当前对话的入站挂钩（与 bind:<channel>:<userId> 键同源，registry.attach/detach 用）。 */
  const inboundBindingOf = (envelope) => ({ channel: envelope.channel, userId: String(envelope.userId ?? '') })

  /**
   * 活跃会话快照（/agent 列表与 /agent use 的数据源）。registry 注入时用台账
   * （activeSessions 已按 lastActiveAt 降序）；缺省降级宿主 ctx.agents.list()
   * + workspaceOf(agent)（无活跃信号，排序退化为宿主列表顺序）。
   * @returns {{ infos: Array<{id: string, workspace: string}>, activitySorted: boolean }}
   */
  const activeSessionInfos = () => {
    if (registry !== null) {
      const ids = registryCall('activeSessions')
      if (Array.isArray(ids)) {
        return {
          infos: ids
            .filter((id) => typeof id === 'string' && id !== '')
            .map((id) => ({ id, workspace: workspaceOfSid(id) })),
          activitySorted: true,
        }
      }
    }
    return { infos: agentsOf().map((agent) => ({ id: agent.id, workspace: workspaceOf(agent) })), activitySorted: false }
  }

  /** 候选中取最近活跃者（§0.5-4「投最近活跃」）：台账有序直取首位，无信号时取末位启发式。 */
  const pickLatest = (infos, activitySorted) => {
    if (infos.length === 0) return null
    if (activitySorted) return infos[0].id
    const best = registryCall('latestActiveOf', infos.map((info) => info.id))
    if (typeof best === 'string' && best !== '') return best
    return infos[infos.length - 1].id // 无活跃信号：取列表末位（最近创建）启发式
  }

  /**
   * 入站去向解析（v0.3.2 §3 四层链）。router 注入时走完整链（L1 bind 读同一 store 键，
   * 行为与旧 boundSession 等价）；未注入时回落 v0.3.1 旧行为。解析异常回落旧链（绝不弄崩投递）。
   * @returns {{ sessionId: string|null, source: string, ambiguous: boolean, candidates?: string[] }}
   */
  const resolveTarget = (envelope) => {
    if (router !== null) {
      try {
        return router.resolveInbound(envelope.channel, String(envelope.userId ?? ''), { latestSessionId })
      } catch (error) {
        warn(`入站路由解析失败，回落默认链: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const bound = store.get(bindingKey(envelope))
    if (typeof bound === 'string' && bound !== '') return { sessionId: bound, source: 'bind', ambiguous: false }
    return { sessionId: latestSessionId, source: 'latest', ambiguous: false }
  }
  // 旧名兼容（/status 等沿用）
  const boundSession = (envelope) => resolveTarget(envelope).sessionId

  function handleCommand(envelope, text) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    const say = (message) => reply(envelope.channel, envelope.chatId, message)
    if (cmd === 'help') {
      say([
        '命令集：',
        '  /status — 查看绑定与 agent 状态',
        '  /agent — 活跃会话分组视图（workspace | sid | 状态 | 出站通道 | quiet）',
        '  /agent use <workspace|sid 前缀> — 本对话切到该会话（智能绑定）',
        '  /agent back — 解除本对话绑定，回通道默认',
        '  /bind <sessionId> — 绑定到指定会话（sid 级精确操作）',
        '  /unbind — 解绑（回到通道默认路由：通道默认 agent，未配置则最近活跃）',
        '  /stop — 取消当前 turn',
        '  /route — 查看当前双向解析（会话→通道 / 通道→会话）',
        '  /quiet <workspace|sid> — 静默该会话的出站推送（远程对话不受影响）',
        '  /unquiet <workspace|sid> — 恢复该会话的出站推送',
        '  /help — 本帮助',
        '',
        '直接发文本 = 对话；! 前缀 = 纠偏（steer）；.. 结尾 = 立即发送（合并窗内）。',
        '长任务自动心跳（默认 15min 起）与疑似卡住提醒（默认 10min 无事件）；卡片通道可点按钮停止，其余 /stop。',
      ].join('\n'))
      return true
    }
    if (cmd === 'status') {
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      say([
        `绑定：${store.get(bindingKey(envelope)) ?? '（未显式绑定：走通道默认路由）'}`,
        `目标：${bound ?? '（无活跃会话，先 /bind 或等 agent 启动）'}`,
        `状态：${agent !== undefined ? agent.status : '未找到'}`,
        `活跃会话：${agentsOf().map((agent) => `${agent.id}(${agent.status})`).join('、') || '（无）'}`,
      ].join('\n'))
      return true
    }
    if (cmd === 'bind') {
      const target = args[0]
      if (target === undefined || target === '') {
        say('用法：/bind <sessionId>（可先用 /status 查看活跃会话）')
        return true
      }
      if (agentOf(target) === undefined) {
        say(`会话 ${target} 不存在（用 /status 查看活跃会话）`)
        return true
      }
      store.set(bindingKey(envelope), target)
      // v0.3.2：同步维护台账入站挂钩与活跃信号（防御壳内降级，不影响绑定本身）
      registryCall('attachInbound', target, inboundBindingOf(envelope))
      registryCall('touch', target)
      say(`已绑定 ${target}`)
      return true
    }
    if (cmd === 'unbind') {
      // 先读旧值再删：detachInbound 需要旧 sid 才能摘掉台账上的入站挂钩
      const key = bindingKey(envelope)
      const old = store.get(key)
      store.delete(key)
      if (typeof old === 'string' && old !== '') {
        registryCall('detachInbound', old, inboundBindingOf(envelope))
      }
      say('已解绑（回到通道默认路由）')
      return true
    }
    if (cmd === 'stop') {
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      if (agent === undefined) { say('当前没有可停止的会话'); return true }
      try {
        agent.cancel('remote-stop')
        say(`已请求取消 ${bound} 的当前 turn`)
      } catch (error) {
        warn(`/stop 失败: ${error instanceof Error ? error.message : String(error)}`)
        say('取消失败（agent 可能已空闲）')
      }
      return true
    }
    // ---- v0.3.2 会话路由命令族（设计稿 §4）：/agent [use|back] 与 /route ----
    if (cmd === 'agent') {
      const sub = String(args[0] ?? '').toLowerCase()
      if (sub === 'use') {
        handleAgentUse(envelope, args[1], say)
        return true
      }
      if (sub === 'back') {
        handleAgentBack(envelope, say)
        return true
      }
      if (sub === '') {
        say(renderAgentList())
        return true
      }
      say('用法：/agent（活跃会话列表）| /agent use <workspace|sid 前缀> | /agent back')
      return true
    }
    if (cmd === 'route') {
      if (router === null) {
        say('路由引擎未装配（v0.3.2 router 缺失）：/route 暂不可用；/status 仍可查看会话与绑定。')
        return true
      }
      say(renderRoute(envelope))
      return true
    }
    // ---- v0.5 特性 C：/quiet /unquiet（设计稿 §4，目标解析复用 /agent use 智能匹配）----
    if (cmd === 'quiet' || cmd === 'unquiet') {
      const quiet = cmd === 'quiet'
      if (router === null) {
        say('路由引擎未装配（v0.3.2 router 缺失）：/quiet 暂不可用；/status 仍可查看会话与绑定。')
        return true
      }
      const target = args[0]
      if (typeof target !== 'string' || target.trim() === '') {
        say(`用法：/${cmd} <workspace 名 | sessionId | sid 前缀（≥4 位）>`)
        return true
      }
      const matched = matchSessionByNeedle(target.trim())
      if (matched.sid === null) { say(matched.message); return true }
      const ok = routerCall('setSessionOutbound', matched.sid, { quiet })
      if (ok !== true) {
        say(`/${cmd} 写入失败（路由状态存储不可用），请稍后再试`)
        return true
      }
      const workspace = workspaceOfSid(matched.sid)
      const label = workspace === '' ? '(未知 workspace)' : workspace
      say([
        `${quiet ? '🔇 已静默' : '🔔 已恢复'} ${label} / ${matched.sid}（${matched.matchedBy}）的出站推送`,
        quiet ? '（远程审批与对话不受影响；/unquiet <workspace|sid> 恢复）' : '',
      ].filter((line) => line !== '').join('\n'))
      return true
    }
    return false // 未知命令：当普通文本处理（避免吞消息）
  }

  /**
   * /agent 无参：活跃会话分组视图（设计稿 §4）。每行
   * 「workspace | sid（8 位前缀）| 状态 | 出站通道集合 | quiet 标记」，按 workspace 聚合、
   * 组内保持活跃降序。数据源 registry.activeSessions() + agentOf(id).status +
   * router.resolveOutbound(sid, workspace, globalTypes())；registry 缺省降级宿主 agent 列表；
   * router 缺省整体降级提示（出站集合无从解析）。
   */
  function renderAgentList() {
    if (router === null) {
      return '路由引擎未装配（v0.3.2 router 缺失）：/agent 列表暂不可用；/status 仍可查看会话与绑定。'
    }
    const { infos } = activeSessionInfos()
    const lines = ['活跃会话分组视图（workspace | sid | 状态 | 出站通道 | quiet）：']
    if (registry === null) {
      lines.push('（会话台账 registry 未装配：按宿主 agent 列表降级展示，活跃排序不可用）')
    }
    if (infos.length === 0) {
      lines.push('  （无活跃会话：先在宿主开一个会话，或 /bind <sessionId>）')
    }
    const groups = new Map() // workspace -> 该组行（保持活跃降序；组顺序 = 最近活跃组的 workspace 在前）
    for (const info of infos) {
      const key = info.workspace === '' ? '(未知 workspace)' : info.workspace
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(info)
    }
    for (const [workspace, rows] of groups) {
      for (const info of rows) {
        const status = agentOf(info.id)?.status ?? '未知'
        const outbound = routerCall('resolveOutbound', info.id, info.workspace, globalTypes())
        const channels = outbound !== undefined && Array.isArray(outbound.channelTypes)
          ? `[${outbound.channelTypes.join(', ')}]`
          : '(解析不可用)'
        const quiet = outbound?.quiet === true ? 'quiet' : '-'
        lines.push(`  ${workspace} | ${info.id.slice(0, 8)} | ${status} | ${channels} | ${quiet}`)
      }
    }
    lines.push('（/agent use <workspace|sid 前缀> 切换；/agent back 回通道默认；/route 查看双向解析）')
    return lines.join('\n')
  }

  /**
   * 目标智能匹配（§0.5-5 解析顺序，/agent use 与 v0.5 /quiet|/unquiet 共用）：
   * workspace 名精确匹配（该 workspace 活跃会话取最近活跃者）> sessionId 精确 >
   * sid 前缀（≥4 位：唯一命中 / 多命中列候选 / 零命中提示）。
   * @param {string} needle - 用户输入的目标串。
   * @returns {{ sid: string, matchedBy: string } | { sid: null, message: string }}
   */
  const matchSessionByNeedle = (needle) => {
    const { infos, activitySorted } = activeSessionInfos()
    const ofWorkspace = infos.filter((info) => info.workspace !== '' && info.workspace === needle)
    if (ofWorkspace.length > 0) {
      const sid = pickLatest(ofWorkspace, activitySorted) // 同 workspace 多活跃会话 → 最近活跃者（§0.5-4）
      if (sid !== null) return { sid, matchedBy: `workspace=${needle}` }
    }
    if (infos.some((info) => info.id === needle)) return { sid: needle, matchedBy: 'sessionId 精确匹配' }
    if (needle.length >= 4) {
      const hits = infos.filter((info) => info.id.startsWith(needle)).map((info) => info.id)
      if (hits.length === 1) return { sid: hits[0], matchedBy: 'sid 前缀唯一命中' }
      if (hits.length > 1) {
        return {
          sid: null,
          message: [
            `前缀 ${needle} 命中 ${hits.length} 个活跃会话，请精确指定：`,
            ...hits.map((id) => `  ${id}`),
            '（或用 workspace 名精确匹配）',
          ].join('\n'),
        }
      }
    }
    return { sid: null, message: `未匹配到会话 ${needle}（用 /agent 查看活跃会话；sid 前缀匹配需至少 4 位）` }
  }

  /**
   * /agent use <target>：智能绑定（§0.5-5 解析顺序，匹配逻辑见 matchSessionByNeedle）。
   * 成功后 store 写 bind 键 + registry.attachInbound + touch，回执确认 workspace 与 sid。
   */
  function handleAgentUse(envelope, target, say) {
    if (typeof target !== 'string' || target.trim() === '') {
      say('用法：/agent use <workspace 名 | sessionId | sid 前缀（≥4 位）>')
      return
    }
    const matched = matchSessionByNeedle(target.trim())
    if (matched.sid === null) { say(matched.message); return }
    const sid = matched.sid
    const workspace = workspaceOfSid(sid)
    store.set(bindingKey(envelope), sid)
    registryCall('attachInbound', sid, inboundBindingOf(envelope))
    registryCall('touch', sid)
    say(`已绑定 ${workspace === '' ? '(未知 workspace)' : workspace} / ${sid}（${matched.matchedBy}；/agent back 回通道默认）`)
  }

  /** /agent back：读旧绑定 → 删 bind 键 + registry.detachInbound，回到通道默认路由。 */
  function handleAgentBack(envelope, say) {
    const key = bindingKey(envelope)
    const old = store.get(key)
    if (typeof old === 'string' && old !== '') {
      store.delete(key)
      registryCall('detachInbound', old, inboundBindingOf(envelope))
      say(`已回到通道默认（解除与 ${old} 的绑定）`)
    } else {
      say('当前没有显式绑定（本就走通道默认路由）')
    }
  }

  /**
   * /route：双向解析展示（排障用，§4）。出站段 = router.describe(当前解析到的 sid,
   * workspace, globalTypes()) 逐层来源（sid 为空时提示当前无目标会话）；入站段 =
   * resolveTarget 的来源层标签 + 目标 sid + ambiguous 标记 + getChannelDefault(channel)。
   */
  function renderRoute(envelope) {
    const resolved = resolveTarget(envelope)
    const sid = resolved.sessionId
    const lines = ['【出站】当前会话 → 通道（逐层解析）']
    if (sid === null) {
      lines.push('  当前无目标会话（无绑定且无活跃会话可兜底）')
    } else {
      const described = routerCall('describe', sid, workspaceOfSid(sid), globalTypes())
      for (const line of String(described ?? '').split('\n')) lines.push(`  ${line}`)
    }
    lines.push('', '【入站】本通道 → 会话（当前解析）')
    lines.push(`  来源：${INBOUND_SOURCE_LABELS[resolved.source] ?? String(resolved.source)}`)
    lines.push(`  目标：${sid ?? '（无）'}`)
    lines.push(`  歧义：${resolved.ambiguous ? '是（多活跃会话，已按最近活跃投递）' : '否'}`)
    if (resolved.ambiguous && Array.isArray(resolved.candidates) && resolved.candidates.length > 0) {
      lines.push(`  候选：${resolved.candidates.join('、')}`)
    }
    const channelDefault = routerCall('getChannelDefault', envelope.channel)
    lines.push(`  通道默认 agent（${envelope.channel}）：${channelDefault ?? '未配置'}`)
    return lines.join('\n')
  }

  /** 投递语义路由：! 前缀 steer；忙碌 inject；空闲 followup。 */
  function deliver(agent, text) {
    const wantsSteer = text.startsWith(steerPrefix)
    const body = (wantsSteer ? text.slice(steerPrefix.length) : text).trim()
    if (body === '') return 'empty'
    const payload = buildUserMessage(body)
    try {
      if (wantsSteer) {
        agent.steer(payload) // 空闲时宿主内部等价 followup
        return 'steer'
      }
      if (agent.status === 'running') {
        agent.inject(payload) // 忙碌：排队到下一步边界，不打断
        return 'inject'
      }
      agent.followup(payload) // 空闲：唤醒新 turn
      return 'followup'
    } catch (error) {
      warn(`投递失败: ${error instanceof Error ? error.message : String(error)}`)
      return 'error'
    }
  }

  // 合并窗：手机上打长句常拆多条；窗口内的连续消息合并为一条再投递。
  // `..` 结尾立即冲刷；`!!` 结尾立即冲刷并按 steer 投递。
  const pending = new Map() // `${channel}:${userId}` -> { parts: string[], timer, forceSteer }
  function flush(envelope) {
    const key = `${envelope.channel}:${envelope.userId}`
    const entry = pending.get(key)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(key)
    const text = entry.parts.join('\n').trim()
    if (text === '') return
    const merged = entry.forceSteer ? `${steerPrefix}${text}` : text
    route(envelope, merged)
  }
  function route(envelope, text) {
    if (text.startsWith('/')) {
      if (handleCommand(envelope, text)) return
    }
    // 完整解析结果（非仅 sid）：ambiguous 时投递后要回执消歧提示（§0.5-4）
    const resolved = resolveTarget(envelope)
    const bound = resolved.sessionId
    if (bound === null) {
      reply(envelope.channel, envelope.chatId, '没有活跃会话可投递（用 /bind <sessionId> 绑定，或 /status 查看）')
      return
    }
    const agent = agentOf(bound)
    if (agent === undefined) {
      reply(envelope.channel, envelope.chatId, `会话 ${bound} 不存在或已退出（用 /status 查看）`)
      return
    }
    const outcome = deliver(agent, text)
    if (outcome === 'error') {
      reply(envelope.channel, envelope.chatId, '投递失败（详见宿主日志）')
    } else if (outcome === 'empty') {
      // 空文本（如只有 !）：静默忽略
    } else {
      // 投递成功：刷新活跃信号（「投最近活跃」消歧的数据来源，§0.5-4；防御壳内降级）
      registryCall('touch', bound)
      if (resolved.ambiguous === true) {
        const count = Array.isArray(resolved.candidates) ? resolved.candidates.length : 1
        reply(envelope.channel, envelope.chatId,
          `已投 ${bound}（该 workspace 有 ${count} 个活跃会话，用 /agent use 或 /bind 精确指定）`)
      }
    }
  }

  const disposeMessage = bus.onMessage((envelope) => {
    const text = String(envelope.text ?? '').trim()
    if (text === '') return
    // 命令不进合并窗：立即处理
    if (text.startsWith('/')) {
      route(envelope, text)
      return
    }
    const key = `${envelope.channel}:${envelope.userId}`
    if (text.endsWith('..') || text.endsWith('!!')) {
      // 终止符：先并入再立即冲刷（!! 追加 steer 前缀）
      const entry = pending.get(key) ?? { parts: [], timer: null, forceSteer: false }
      entry.parts.push(text.slice(0, -2).trim())
      entry.forceSteer = entry.forceSteer || text.endsWith('!!')
      pending.set(key, entry)
      flush(envelope)
      return
    }
    if (mergeWindowMs === 0) {
      route(envelope, text)
      return
    }
    const entry = pending.get(key)
    if (entry !== undefined) {
      entry.parts.push(text)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flush(envelope), mergeWindowMs)
      return
    }
    pending.set(key, {
      parts: [text],
      timer: setTimeout(() => flush(envelope), mergeWindowMs),
      forceSteer: false,
    })
  })

  // 追踪最近活跃 agent（默认投递目标）；agent 退出时清理绑定与合并窗。
  // v0.7.3（#4）：DSH 的 agent/created | agent/disposed 事件签名是 (payload: { agent })，
  // 监听器收到的是载荷对象而非 agent 本身——旧代码 agent?.id 恒 undefined，
  // latestSessionId 永不赋值，未 /bind 用户的文本消息全部走到「没有活跃会话」被拒投
  // （现象：命令能回、文本全丢）。此处解包 payload.agent（兼容直接传 agent 的旧宿主）。
  const payloadAgent = (arg) => {
    const agent = arg?.agent ?? arg
    return (agent !== null && typeof agent === 'object' && agent.id !== undefined) ? agent : null
  }
  // 只追踪根 agent：后台 subagent 同样触发 agent/created，若不滤掉会把投递目标
  // 劫持到 subagent 会话。宿主暴露 ctx.agents.roots() 时用它判定；老宿主无此 API
  // 则退化为全量追踪（与修复前行为一致，仅解包修复生效）。
  const rootIds = () => {
    try {
      const roots = ctx?.agents?.roots?.()
      return (roots !== null && typeof roots === 'object') ? roots : null
    } catch { return null }
  }
  const trackAgent = (payload) => {
    const agent = payloadAgent(payload)
    if (agent === null) return
    const roots = rootIds()
    if (roots !== null) {
      const ids = (Array.isArray(roots) ? roots : Object.values(roots)).map((a) => a?.id)
      if (!ids.includes(agent.id)) return // subagent：不劫持默认投递目标
    }
    latestSessionId = agent.id
  }
  try {
    disposers.push(ctx.on('agent/created', trackAgent))
  } catch { /* 宿主无此事件：默认绑定不可用，仍可 /bind */ }
  try {
    disposers.push(ctx.on('agent/disposed', (payload) => {
      const agent = payloadAgent(payload)
      if (agent !== null && agent.id === latestSessionId) latestSessionId = null
      // 显式绑定到该 agent 的用户下次投递会收到「会话不存在」回执并自行 /bind，
      // 不在此清绑定：store 里的绑定在 agent 重启（同 id resume）后仍然有效。
    }))
  } catch { /* 同上 */ }

  return () => {
    disposeMessage?.()
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 反注册失败不致命 */ }
    }
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }
}
