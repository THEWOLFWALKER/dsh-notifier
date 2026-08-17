// dsh-notifier event-listener.mjs
// 自动状态推送触发线：监听 session/event（turn/end、approval/asked）与 agent/error 总线，
// 统一走 notifyAll 广播。防抖：turn/end 按 session 做尾沿 10s 合并（同 session 不刷屏）；
// approval/asked 与 agent/error 即时推送。dedup：按 session.id:seq / agent.id:turn:step 去重（24h）。

import { basename } from 'node:path'
import { createKeywordFilter, createGraceQueue } from './rules.mjs'
// v0.5 状态上报 + 动作闭环
import { createTurnTracker } from './status/turn-tracker.mjs'
import { normalizeInbound, buildActionPayload } from './inbound/_contract.mjs'
import { guardTargets } from './inbound/target-guard.mjs'

/** 取会话所属工作区名：cwd 末段，否则 session id。 */
export function workspaceNameOf(session) {
  const cwd = session?.header?.cwd
  return cwd !== undefined && typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : String(session?.id ?? '')
}

/** 取会话日志里最后一条 assistant/message 的文本块。 */
export function lastAssistantText(session) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

/** turn/end reason.kind -> 文案/级别。kind 不在官方六值内（插件扩展）返回 undefined 保持沉默。 */
const TURN_END_META = {
  completed: { headline: '✅ 任务完成', level: 'active' },
  error: { headline: '❌ 任务出错', level: 'timeSensitive' },
  blocked: { headline: '🚫 任务被阻塞', level: 'timeSensitive' },
  aborted: { headline: '⏹ 任务已中止', level: 'passive' },
  'max-tokens': { headline: '⚠️ 达到 Token 上限', level: 'timeSensitive' },
  interrupted: { headline: '⏸ 任务异常中断', level: 'timeSensitive' },
}

/** 把 session/event 映射为可推送意图；不可推送返回 undefined。 */
export function intentOfSessionEvent(event) {
  switch (event?.type) {
    // v0.5 任务开始（默认关，events.turnStart.enabled === true 才放行）。
    // detail 留空：workspace 由 push 侧组装（intent 是纯函数，不持有 session）。
    case 'turn/start':
      return { event: 'turn/start', kind: 'start', headline: '🚀 任务开始', level: 'passive', detail: '' }
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      const meta = TURN_END_META[kind]
      if (meta === undefined) return undefined
      let detail = ''
      if (kind === 'error') detail = event.data.reason?.error?.message ?? '任务执行出错'
      else if (kind === 'blocked') detail = '任务被阻塞，等待你处理'
      else if (kind === 'max-tokens') detail = '某一步骤达到输出 Token 上限'
      else if (kind === 'interrupted') detail = '会话被异常中断，等待恢复'
      return { event: 'turn/end', kind, headline: meta.headline, level: meta.level, detail }
    }
    case 'approval/asked': {
      const data = event.data ?? {}
      const tool = typeof data.toolName === 'string' && data.toolName !== '' ? `工具 ${data.toolName}` : '一个操作'
      const reason = typeof data.reason === 'string' && data.reason !== '' ? `：${data.reason}` : ''
      return {
        event: 'approval/asked',
        kind: 'approval',
        headline: '🔐 需要你批准',
        level: 'timeSensitive',
        detail: `${tool} 需要授权${reason}`,
      }
    }
    default:
      return undefined
  }
}

/** 把 agent/error 总线负载映射为推送意图。 */
export function intentOfAgentError(payload = {}) {
  const error = payload.error
  const detail = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : (error?.message ?? 'agent 执行出错'))
  return { event: 'agent/error', kind: 'error', headline: '❌ Agent 执行出错', level: 'timeSensitive', detail }
}

/** 组装最终通知消息：标题前缀 + 正文截断（summaryMaxChars）。 */
export function intentToMessage(intent, { assistantText = '', config = {} } = {}) {
  const prefix = typeof config.titlePrefix === 'string' ? config.titlePrefix.trim() : ''
  const title = `${prefix.length > 0 ? `${prefix} ` : ''}${intent.headline}`
  let content = intent.detail
  if (assistantText.length > 0) content = content.length > 0 ? `${content}\n\n---\n${assistantText}` : assistantText
  const maxChars = typeof config.summaryMaxChars === 'number' && Number.isFinite(config.summaryMaxChars)
    ? Math.max(0, Math.trunc(config.summaryMaxChars))
    : 500
  if (maxChars > 0 && content.length > maxChars) content = `${content.slice(0, maxChars)}…`
  return { title, content, level: intent.level }
}

/** 有界 dedup 账本：一个 key 24h 窗口内只放行一次，超出 maxEntries 淘汰最旧。 */
export function createDedupLedger(maxEntries = 1000, windowMs = 24 * 60 * 60 * 1000) {
  const seen = new Map()
  return {
    /** 该 key 可放行则记录并返回 true，窗口内重复返回 false。 */
    test(key) {
      const now = Date.now()
      const previous = seen.get(key)
      if (previous !== undefined && now - previous < windowMs) return false
      seen.set(key, now)
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return true
    },
    size() {
      return seen.size
    },
  }
}

/** 尾沿防抖：每 key 一个定时器，窗口内连续触发只推送最后一次。 */
export function createTrailingDebounce(windowMs = 10000) {
  const timers = new Map()
  const pending = new Map()
  return {
    schedule(key, task) {
      pending.set(key, task)
      const previous = timers.get(key)
      if (previous !== undefined) clearTimeout(previous)
      timers.set(key, setTimeout(() => {
        timers.delete(key)
        const fn = pending.get(key)
        pending.delete(key)
        if (typeof fn === 'function') fn()
      }, windowMs))
    },
    /** 立即触发所有未到期的 pending 任务（headless 一次性运行退出前 flush 用），返回它们的返回值。 */
    flush() {
      const triggered = []
      for (const [key, fn] of pending) {
        triggered.push(typeof fn === 'function' ? fn() : undefined)
      }
      timers.clear()
      pending.clear()
      return triggered
    },
    pendingCount() {
      return pending.size
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
  }
}

/**
 * 订阅事件总线做自动推送。
 * @param ctx - cordis 上下文（ctx.on + ctx.logger）。
 * @param notifier - createNotifier 返回的 { notifyAll, channels }。
 * @param resolvedConfig - resolveConfig 返回的 { enabled, debounceMs, events, keywords, graceSeconds, ... }。
 * @param {object} [wiring] - v0.3.2 路由装配（全部可选，缺省 = v0.3.0 广播行为，零感知）。
 * @param {ReturnType<typeof import('./routing/agent-router.mjs').createAgentRouter>} [wiring.router]
 *   - agent 路由引擎：事件带 session 时按「会话 diff > 精确 agentId > workspace > 全局池」解析出站目标与 quiet。
 * @param {ReturnType<typeof import('./routing/session-registry.mjs').createSessionRegistry>} [wiring.registry]
 *   - 会话注册表：出站事件时 touch（活跃信号 + 惰性建档兜底，agent/created 未触达的会话也进台账）。
 * @param {() => ReturnType<typeof import('./actions.mjs').createActionDispatcher> | null} [wiring.actions]
 *   - v0.5 动作分发器惰性 getter：stall/心跳通知附带「停止任务」按钮。
 *     惰性求值（而非直传实例）：eventListener 装配早于 inbound 栈（vault/store/通道在其后
 *     才创建），先例 = tool-register 的 channelTypes: () => ...。缺省 = 永不带按钮（v0.4.0 行为）。
 * @param {() => object[]} [wiring.interactive]
 *   - 交互通道原始实例列表惰性 getter（sendActionCard 的投递面）。缺省 = 永不带按钮。
 * @returns 反注册函数。
 */
export function createEventListener(ctx, notifier, resolvedConfig, wiring = {}) {
  const enabled = resolvedConfig.enabled !== false
  const events = resolvedConfig.events ?? { turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true }
  const router = wiring.router ?? null
  const registry = wiring.registry ?? null
  // v0.5 动作闭环（全可选、惰性求值；调用点自带 try/catch + null 判定）
  const actionsFn = typeof wiring.actions === 'function' ? wiring.actions : null
  const interactiveFn = typeof wiring.interactive === 'function' ? wiring.interactive : null
  const keywords = createKeywordFilter(resolvedConfig.keywords)
  const debounce = createTrailingDebounce(resolvedConfig.debounceMs ?? 10000)
  // 空闲宽限窗：turn 结束后等 N 秒再打扰；期间用户输入（user/* 事件）即取消。
  // approval/agent/error 不进宽限窗——它们等人决策，晚到等于没到。
  const grace = createGraceQueue({ seconds: resolvedConfig.graceSeconds ?? 0 })
  const dedup = createDedupLedger()
  const warn = (message) => {
    try { ctx?.logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }

  /** 事件粒度门：配置关掉的事件线/结束原因直接静默（不占 dedup 名额）。
   *  容忍两种形状：resolveConfig 归一化的 { enabled, kinds } 与原始的 { completed: false } 直传。 */
  const eventAllowed = (intent) => {
    if (intent.event === 'turn/end') {
      const turnEnd = events.turnEnd
      if (turnEnd === false) return false
      if (turnEnd?.enabled === false) return false
      const kinds = turnEnd?.kinds ?? (turnEnd ?? {})
      return kinds[intent.kind] !== false
    }
    // v0.5 任务开始：默认关。旧形状直传（events 无此键）→ undefined !== true → 静默，
    // 既有调用方零感知（resolveConfig 归一后才有 enabled: false / true 之分）。
    if (intent.event === 'turn/start') return events.turnStart?.enabled === true
    if (intent.event === 'approval/asked') return events.approval !== false
    return events.agentError !== false
  }

  /**
   * v0.3.2 出站分流：事件带 session 时按解析链算出 { channelTypes, quiet }。
   * router 缺失 / session 无 id / 解析异常一律回落「不过滤、不静音」（广播，向后兼容）。
   */
  const resolveOutboundOf = (session) => {
    if (router === null || session?.id === undefined || session?.id === null) return {}
    try {
      const globalTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
      const resolved = router.resolveOutbound(String(session.id), workspaceNameOf(session), globalTypes)
      return { channelTypes: resolved.channelTypes, quiet: resolved.quiet }
    } catch (error) {
      warn(`出站路由解析失败，本次按全局广播: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  // ---- v0.5 状态上报：文案与动作卡片 ----

  /** 毫秒 → 人读时长（45s / 23m / 2h5m；不足 1s 计 0s）。 */
  const formatDuration = (ms) => {
    const totalSec = Math.max(0, Math.round(Number(ms) / 1000))
    if (totalSec < 60) return `${totalSec}s`
    const min = Math.floor(totalSec / 60)
    if (min < 60) return `${min}m`
    const hour = Math.floor(min / 60)
    return hour > 0 && min % 60 > 0 ? `${hour}h${min % 60}m` : `${hour}h`
  }

  /** longRunning / stall 的正文组装：workspace / sid / 运行时长 / hint（心跳附最近输出摘录）。 */
  const composeStatusBody = (intent, session) => {
    const workspace = workspaceNameOf(session)
    const sid = String(session?.id ?? '')
    const lines = sid !== '' && sid !== workspace ? [`${workspace} / ${sid.slice(0, 8)}`] : [workspace]
    if (intent.info !== undefined && intent.info !== null) {
      lines.push(`已运行 ${formatDuration(intent.info.elapsedMs)}，最近活动 ${formatDuration(intent.info.idleMs)} 前`)
    }
    if (intent.event === 'stall') {
      lines.push('长工具执行可能误报；可回复 /stop 取消，或调大 events.stall.afterMs')
    } else {
      const excerpt = lastAssistantText(session).slice(-200).trim()
      if (excerpt !== '') lines.push(`最近输出：${excerpt}`)
      lines.push('回复 /stop 取消')
    }
    return lines.join('\n')
  }

  /**
   * 对全部交互通道发动作卡片（stall / 心跳通知的「⏹ 停止任务」按钮）。
   * 尽力而为语义：dispatcher 缺失 / 铸造失败 / 单通道失败 → 静默跳过——通知文本里的
   * 「回复 /stop 取消」hint 已是全通道兜底，卡片是增强 UX 而非依赖路径。
   */
  const pushActionCard = (session, message) => {
    const dispatcher = (() => { try { return actionsFn() } catch { return null } })()
    const rawList = (() => { try { return interactiveFn() } catch { return null } })()
    if (dispatcher === null || dispatcher === undefined) return
    if (!Array.isArray(rawList) || rawList.length === 0) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    let minted = null
    try { minted = dispatcher.mintAction('turn/cancel', { sessionId }) } catch { /* 铸造失败降级纯文本 */ }
    if (minted === null || minted === undefined) return
    const data = buildActionPayload(minted.key, minted.token)
    for (const raw of rawList) {
      const inbound = normalizeInbound(raw)
      if (inbound === null) continue
      // v0.7 形状守卫：动作卡片与审批卡片同一道防线（跨渠道串门目标 skip）。
      // warn 必传（R5 审查 R5-3-P2-1：null 静默——守卫错杀在这条路径不可观测）
      const targets = inbound.notifyTargets()
      const { kept } = guardTargets(inbound.channel, targets, warn)
      if (kept.length === 0 && targets.length > 0) {
        warn(`动作卡片目标全被形状守卫拦截（${inbound.channel} ${targets.length} 个目标 0 个合格）——请核对通知目标 id 形态`)
      }
      for (const target of kept) {
        Promise.resolve(inbound.sendActionCard({
          chatId: target.chatId,
          title: message.title,
          content: message.content,
          actions: [{ label: '⏹ 停止任务', data }],
        })).catch(() => { /* 单通道失败不拖累其余 */ })
      }
    }
  }

  // v0.5 turn 跟踪器：心跳/卡住信号源。仅当对应 events 键 enabled 时装定时器
  // （旧形状直传 resolvedConfig——events 无此三键——则 tracker 空转，零感知）。
  // trackerOverrides 为测试注入口（now/定时器/minMs 钳制）；展开在前、显式配置在后，
  // 测试无法覆盖回调与启停语义。
  const heartbeatCfg = events.longRunning?.enabled === true
    ? { firstAfterMs: events.longRunning.firstAfterMs, everyMs: events.longRunning.everyMs }
    : null
  const stallCfg = events.stall?.enabled === true ? { afterMs: events.stall.afterMs } : null
  const statusIntent = (event, headline, level, info) => ({ event, kind: event, headline, level, detail: '', info })
  const trackerOverrides = (wiring.trackerOverrides !== null && typeof wiring.trackerOverrides === 'object')
    ? wiring.trackerOverrides
    : {}
  const tracker = createTurnTracker({
    ...trackerOverrides,
    heartbeat: heartbeatCfg,
    stall: stallCfg,
    onHeartbeat: (session, info) => push(statusIntent('longRunning', '⏱ 任务进行中', 'passive', info), session),
    onStall: (session, info) => push(statusIntent('stall', '⚠️ 疑似卡住', 'timeSensitive', info), session),
  })

  const push = (intent, session) => {
    // v0.5 状态上报文案组装：turn/start / longRunning / stall 三类 intent 的正文
    // 需要 workspace / 运行时长 / 最近输出，intent 纯函数不持有这些，push 侧组装。
    let message
    if (intent.event === 'turn/start') {
      message = intentToMessage(intent, { assistantText: '', config: resolvedConfig })
      message.content = workspaceNameOf(session)
    } else if (intent.event === 'longRunning' || intent.event === 'stall') {
      message = intentToMessage(intent, { assistantText: '', config: resolvedConfig })
      message.content = composeStatusBody(intent, session)
    } else {
      const assistantText = intent.event === 'turn/end' ? lastAssistantText(session) : ''
      message = intentToMessage(intent, { assistantText, config: resolvedConfig })
    }
    // 关键词规则（include 白名单 / exclude 黑名单，黑名单优先）拦下即静默跳过
    const reason = keywords.why(`${message.title}\n${message.content}`)
    if (reason !== undefined) {
      warn(`关键词规则拦截推送（${reason}）`)
      return Promise.resolve(undefined)
    }
    // v0.3.2：会话活跃信号 + 惰性建档（agent/created 兜底路径）
    if (registry !== null && session?.id !== undefined && session?.id !== null) {
      try { registry.touch(String(session.id)) } catch { /* 台账失败绝不影响推送 */ }
    }
    // v0.5 动作闭环：stall / 心跳通知附带「停止任务」按钮（尽力而为，文本 hint 已兜底）
    if ((intent.event === 'stall' || intent.event === 'longRunning') && actionsFn !== null) {
      pushActionCard(session, message)
    }
    return notifier.notifyAll(message, resolveOutboundOf(session)).catch((error) => {
      warn(`自动推送失败: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const sessionListener = (session, event) => {
    if (!enabled) return
    if (session == null || event == null) return
    // v0.5：永远最先喂 tracker（独立于 intent 过滤——events.turnEnd 关闭或未知
    // reason.kind 静默时，turn 生命周期的建档/清档仍需发生，否则卡住判定失真）
    tracker.observe(session, event)
    // 用户活动信号：任何 user/* 事件（发消息/编辑）都证明人在键盘，取消宽限窗内待发打扰
    if (typeof event.type === 'string' && event.type.startsWith('user/')) {
      grace.activity()
      return
    }
    const intent = intentOfSessionEvent(event)
    if (intent === undefined) return
    if (!eventAllowed(intent)) return
    const key = `${session.id ?? '(anon)'}:${event.seq ?? 0}`
    if (!dedup.test(key)) return
    if (intent.event === 'turn/end' || intent.event === 'turn/start') {
      // turn/end 与 turn/start 共用同一防抖 key（session.id）：10s 内 start→end 连续
      // 时后者替换前者（尾沿合并语义），只发「任务完成」一条；快速连续 turn 同理合并。
      debounce.schedule(String(session.id), () => grace.schedule(String(session.id), () => push(intent, session)))
    } else {
      push(intent, session)
    }
  }

  const errorListener = (payload = {}) => {
    if (!enabled) return
    if (events.agentError === false) return
    const agent = payload.agent
    const agentId = agent?.id ?? agent?.session?.id
    if (agentId === undefined || agentId === null) return
    const key = `agent:${agentId}:${payload.turn ?? 0}:${payload.step ?? 0}`
    if (!dedup.test(key)) return
    push(intentOfAgentError(payload), agent?.session)
  }

  const disposeSession = ctx.on('session/event', sessionListener)
  let disposeError = null
  const extraDisposers = []
  try {
    disposeError = ctx.on('agent/error', errorListener)
  } catch {
    // 某些宿主不提供 agent/error 总线：静默降级，session/event 触发线不受影响
  }
  try {
    // v0.5：agent 退出即清 tracker 档（turn/end 缺席的兜底，防泄漏）
    const disposeAgentDisposed = ctx.on('agent/disposed', (agent) => tracker.observeAgentDisposed(agent))
    if (typeof disposeAgentDisposed === 'function') extraDisposers.push(disposeAgentDisposed)
  } catch {
    // 宿主无 agent/disposed 事件：靠 turn/end + MAX_TRACKED 淘汰兜底
  }

  // 返回可被 cordis await 的清理：flush 未到期的 turn/end 防抖与宽限窗任务，并等待所有在途推送完成。
  // headless 一次性运行在 appExit 前会 dispose 整个树（5s 宽限），Pending 通知因此能送达。
  return () => {
    const triggered = [...debounce.flush(), ...grace.flush()]
    tracker.dispose() // v0.5：清心跳/卡住定时器
    disposeSession?.()
    if (disposeError != null) disposeError()
    for (const dispose of extraDisposers) {
      try { dispose() } catch { /* 反注册失败不致命 */ }
    }
    return Promise.allSettled([...triggered, notifier.flush()]).then(() => undefined)
  }
}
