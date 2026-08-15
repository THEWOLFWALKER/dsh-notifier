// dsh-notifier event-listener.mjs
// 自动状态推送触发线：监听 session/event（turn/end、approval/asked）与 agent/error 总线，
// 统一走 notifyAll 广播。防抖：turn/end 按 session 做尾沿 10s 合并（同 session 不刷屏）；
// approval/asked 与 agent/error 即时推送。dedup：按 session.id:seq / agent.id:turn:step 去重（24h）。

import { basename } from 'node:path'
import { createKeywordFilter, createGraceQueue } from './rules.mjs'

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
 * @param notifier - createNotifier 返回的 { notifyAll }。
 * @param resolvedConfig - resolveConfig 返回的 { enabled, debounceMs, events, keywords, graceSeconds, ... }。
 * @returns 反注册函数。
 */
export function createEventListener(ctx, notifier, resolvedConfig) {
  const enabled = resolvedConfig.enabled !== false
  const events = resolvedConfig.events ?? { turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true }
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
    if (intent.event === 'approval/asked') return events.approval !== false
    return events.agentError !== false
  }

  const push = (intent, session) => {
    const assistantText = intent.event === 'turn/end' ? lastAssistantText(session) : ''
    const message = intentToMessage(intent, { assistantText, config: resolvedConfig })
    // 关键词规则（include 白名单 / exclude 黑名单，黑名单优先）拦下即静默跳过
    const reason = keywords.why(`${message.title}\n${message.content}`)
    if (reason !== undefined) {
      warn(`关键词规则拦截推送（${reason}）`)
      return Promise.resolve(undefined)
    }
    return notifier.notifyAll(message).catch((error) => {
      warn(`自动推送失败: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const sessionListener = (session, event) => {
    if (!enabled) return
    if (session == null || event == null) return
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
    if (intent.event === 'turn/end') {
      // turn/end 双段延迟：先按 session 尾沿防抖合并（10s），到期后再进宽限窗
      // （graceSeconds 内用户接管即取消）。「任务完成」类打扰让位于「人在键盘」。
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
  try {
    disposeError = ctx.on('agent/error', errorListener)
  } catch {
    // 某些宿主不提供 agent/error 总线：静默降级，session/event 触发线不受影响
  }

  // 返回可被 cordis await 的清理：flush 未到期的 turn/end 防抖与宽限窗任务，并等待所有在途推送完成。
  // headless 一次性运行在 appExit 前会 dispose 整个树（5s 宽限），Pending 通知因此能送达。
  return () => {
    const triggered = [...debounce.flush(), ...grace.flush()]
    disposeSession?.()
    if (disposeError != null) disposeError()
    return Promise.allSettled([...triggered, notifier.flush()]).then(() => undefined)
  }
}
