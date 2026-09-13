// dsh-notifier event-listener.mjs
// 自动状态推送触发线：监听 session/event（turn/end、approval/asked）与 agent/error 总线，
// 统一走 notifyAll 广播。防抖：turn/end 按 session 做尾沿 10s 合并（同 session 不刷屏）；
// approval/asked 与 agent/error 即时推送。dedup：按 session.id:seq / agent.id:turn:step 去重（24h）。

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { createKeywordFilter, createGraceQueue } from './rules.mjs'
import { createHostEventRegistrar, normalizeSessionEventArgs } from './host-events.mjs'
// v0.5 状态上报 + 动作闭环
import { createTurnTracker } from './status/turn-tracker.mjs'
import { normalizeInbound, buildActionPayload } from './inbound/_contract.mjs'
import { guardTargets } from './inbound/target-guard.mjs'
// S-05（CWE-200）出站片段脱敏：minimal（默认）打码密钥形态 + 摘录降为 80 字符
import { maskSecrets, normalizeRedaction, MINIMAL_EXCERPT_CHARS } from './redact.mjs'
// lang: 'zh' | 'en' 自动推送文案表（未知值回落 zh）
import { stringsOf } from './strings.mjs'

/** 取会话所属工作区名：cwd 末段，否则 session id。 */
export function workspaceNameOf(session) {
  const cwd = session?.header?.cwd
  return cwd !== undefined && typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : String(session?.id ?? '')
}

/** G-18：6 位十六进制负载摘要（dedup 键追加用，与 wxpusher hash6 同法）。 */
function hash6(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 6)
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

/** turn/end reason.kind -> 级别（文案来自 strings 表）。kind 不在官方六值内（插件扩展）返回 undefined 保持沉默。 */
const TURN_END_META = {
  completed: { level: 'active' },
  error: { level: 'timeSensitive' },
  blocked: { level: 'timeSensitive' },
  aborted: { level: 'passive' },
  'max-tokens': { level: 'timeSensitive' },
  interrupted: { level: 'timeSensitive' },
}

/** 把 session/event 映射为可推送意图；不可推送返回 undefined。
 *  strings 可选（缺省 zh 文案表）——既有调用方零感知，lang 路径显式传入。 */
export function intentOfSessionEvent(event, strings = stringsOf()) {
  switch (event?.type) {
    // v0.5 任务开始（默认关，events.turnStart.enabled === true 才放行）。
    // detail 留空：workspace 由 push 侧组装（intent 是纯函数，不持有 session）。
    case 'turn/start':
      return { event: 'turn/start', kind: 'start', headline: strings.turnStart, level: 'passive', detail: '' }
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      const meta = TURN_END_META[kind]
      if (meta === undefined) return undefined
      let detail = ''
      if (kind === 'error') detail = event.data.reason?.error?.message ?? strings.turnEndDetail.error
      else if (kind === 'blocked') detail = strings.turnEndDetail.blocked
      else if (kind === 'max-tokens') detail = strings.turnEndDetail['max-tokens']
      else if (kind === 'interrupted') detail = strings.turnEndDetail.interrupted
      return { event: 'turn/end', kind, headline: strings.turnEndHeadline[kind], level: meta.level, detail }
    }
    case 'approval/asked': {
      const data = event.data ?? {}
      const tool = typeof data.toolName === 'string' && data.toolName !== ''
        ? strings.approval.toolName(data.toolName)
        : strings.approval.toolFallback
      const reason = typeof data.reason === 'string' && data.reason !== '' ? `${strings.approval.reasonPrefix}${data.reason}` : ''
      return {
        event: 'approval/asked',
        kind: 'approval',
        headline: strings.approval.headline,
        level: 'timeSensitive',
        detail: strings.approval.detail(tool, reason),
      }
    }
    default:
      return undefined
  }
}

/** 把 agent/error 总线负载映射为推送意图。strings 可选（缺省 zh 文案表）。 */
export function intentOfAgentError(payload = {}, strings = stringsOf()) {
  const error = payload.error
  const detail = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : (error?.message ?? strings.agentError.detailFallback))
  return { event: 'agent/error', kind: 'error', headline: strings.agentError.headline, level: 'timeSensitive', detail }
}

/**
 * 组装最终通知消息：标题前缀 + 正文截断（summaryMaxChars）。
 * S-05：redaction: 'minimal'（默认）下，宿主会话数据片段（assistantText 摘录 / 错误全文）
 * 先打码密钥形态、摘录压到 MINIMAL_EXCERPT_CHARS（80）；'extended' 维持原行为。
 * 摘录上限只作用于「宿主数据片段」，intent.detail（自家文案）不额外截短——
 * 总正文仍受 summaryMaxChars（默认 500）钳制。
 */
export function intentToMessage(intent, { assistantText = '', config = {} } = {}) {
  const prefix = typeof config.titlePrefix === 'string' ? config.titlePrefix.trim() : ''
  const title = `${prefix.length > 0 ? `${prefix} ` : ''}${intent.headline}`
  const minimal = normalizeRedaction(config.redaction) === 'minimal'
  let excerpt = assistantText
  if (minimal && excerpt.length > MINIMAL_EXCERPT_CHARS) {
    excerpt = excerpt.slice(-MINIMAL_EXCERPT_CHARS) // 尾沿：结论通常在最后
  }
  let content = intent.detail
  if (excerpt.length > 0) content = content.length > 0 ? `${content}\n\n---\n${excerpt}` : excerpt
  if (minimal) content = maskSecrets(content)
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

/** 尾沿防抖：每 key 一个定时器，窗口内连续触发只推送最后一次。
 *  v0.8.7 P1-7（宪法#4 状态必须有界）：timers/pending 以 sessionId 为键，条目靠自己的
 *  定时器到点自清——窗口 `debounceMs` 可配且无上限（config.mjs:207 只钳下限 0），
 *  配成分钟/小时级 + 会话高频轮换时两表可无界堆积（每条还挂一个活定时器）。
 *  补 maxKeys 上限：新 key 撑破上限时**立即触发最旧一条**（提前送达，绝不静默丢弃——
 *  宪法#3；语义退化仅限「本该再等窗口末尾」），并交给调用方 warn。
 * @param {number} [windowMs=10000]
 * @param {object} [options]
 * @param {number} [options.maxKeys=256] - 在途 key 上限（会话并发量的三个数量级余量）
 * @param {(key: string, pendingCount: number) => void} [options.onOverflow] - 提前触发通报（异常被吞）
 */
export function createTrailingDebounce(windowMs = 10000, { maxKeys = 256, onOverflow } = {}) {
  const timers = new Map()
  const pending = new Map()
  const cap = Math.max(1, Math.trunc(Number(maxKeys)) || 256)
  const fireNow = (key) => {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    const fn = pending.get(key)
    pending.delete(key)
    if (typeof fn === 'function') { try { return fn() } catch { /* 任务异常绝不外抛 */ } }
    return undefined
  }
  return {
    schedule(key, task) {
      // 腾位在写入前：只有「新 key」才可能撑破上限（同 key 重排不增长）
      while (!pending.has(key) && pending.size + 1 > cap) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        if (typeof onOverflow === 'function') {
          try { onOverflow(oldest, pending.size) } catch { /* 通报失败不致命 */ }
        }
        fireNow(oldest)
      }
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
      // v0.8.7（宪法#4）：必须逐个 clearTimeout 再清表——只 `timers.clear()` 会让已挂起的
      // 定时器留在事件循环里（回调本身已是空转，但 Node 进程要等它们全部到点才退出）。
      // debounceMs 配成分钟级 + 有界表满 256 条时，卸载后进程可被吊住整个窗口时长。
      // grace 侧 flush 一直是这么做的（rules.mjs:152），此处对齐。
      for (const timer of timers.values()) clearTimeout(timer)
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
  // lang 文案表：resolvedConfig.lang 已归一（未知值回落 zh），此处不再兜底
  const strings = stringsOf(resolvedConfig.lang)
  const events = resolvedConfig.events ?? { turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true }
  const router = wiring.router ?? null
  const registry = wiring.registry ?? null
  const busFn = typeof wiring.bus === 'function' ? wiring.bus : null
  // v0.5 动作闭环（全可选、惰性求值；调用点自带 try/catch + null 判定）
  const actionsFn = typeof wiring.actions === 'function' ? wiring.actions : null
  const interactiveFn = typeof wiring.interactive === 'function' ? wiring.interactive : null
  const keywords = createKeywordFilter(resolvedConfig.keywords)
  // 有界防抖（宪法#4）：溢出时提前触发最旧会话的待推送并告警（warn 在下方定义前先声明引用）
  const debounce = createTrailingDebounce(resolvedConfig.debounceMs ?? 10000, {
    onOverflow: (key, size) => warn(`防抖表达上限（在途 ${size} 个会话），提前推送最旧会话 ${key} 的待发通知（合并窗提前收口，不丢通知）`),
  })
  // 空闲宽限窗：turn 结束后等 N 秒再打扰；期间用户输入（user/* 事件）即取消。
  // approval/agent/error 不进宽限窗——它们等人决策，晚到等于没到。
  const grace = createGraceQueue({
    seconds: resolvedConfig.graceSeconds ?? 0,
    onOverflow: (key, size) => warn(`宽限窗表达上限（在途 ${size} 个会话），提前推送最旧会话 ${key} 的待发通知（宽限提前收口，不丢通知）`),
  })
  const dedup = createDedupLedger()
  const warn = (message) => {
    try { ctx?.logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }
  // P1-2 错误可见性（2026-08-20，Trae1）：keywords.regex 开启时，非法正则条目会静默
  // 降级为字面量子串匹配——语义从「正则命中」变「子串包含」，include 规则可能因此
  // 永不命中（通知静默停止）、exclude 规则可能漏拦。降级本身保留（宁可漏拦不炸启动），
  // 但必须让用户看见哪些条目降级了。
  if (Array.isArray(keywords.regexFallbacks) && keywords.regexFallbacks.length > 0) {
    warn(`keywords.regex 中 ${keywords.regexFallbacks.length} 条非法正则已降级为字面量匹配（语义变化，请修正）: ${keywords.regexFallbacks.join(' | ').slice(0, 200)}`)
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
      lines.push(strings.status.runtimeLine(formatDuration(intent.info.elapsedMs), formatDuration(intent.info.idleMs)))
    }
    if (intent.event === 'stall') {
      lines.push(strings.status.stallHint)
    } else {
      // S-05：minimal（默认）摘录 200→80 + 密钥形态打码；extended 维持原文
      const minimal = normalizeRedaction(resolvedConfig.redaction) === 'minimal'
      const cap = minimal ? MINIMAL_EXCERPT_CHARS : 200
      let excerpt = lastAssistantText(session).slice(-cap).trim()
      if (minimal) excerpt = maskSecrets(excerpt)
      if (excerpt !== '') lines.push(`${strings.status.recentOutputPrefix}${excerpt}`)
      lines.push(strings.status.stopHint)
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
        // v0.8.4 F-08：发送前先登记来源会话（channel + chatId），dispatch 据此校验点击
        // 来源（转发拒绝）。登记先行避免「已发出卡片但账本无来源」的竞态窗口；发送失败
        // /降级 null 时撤销登记，绝不含糊地放行未知来源。尽力而为：失败不拖累主链路。
        try { dispatcher.markSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 登记失败不致命 */ }
        Promise.resolve(inbound.sendActionCard({
          chatId: target.chatId,
          title: message.title,
          content: message.content,
          actions: [{ label: strings.status.stopActionLabel, data }],
        })).then((card) => {
          if (card === null || card === undefined) {
            try { dispatcher.unmarkSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 撤销失败不致命 */ }
          }
        }).catch(() => {
          try { dispatcher.unmarkSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 撤销失败不致命 */ }
        })
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
    onHeartbeat: (session, info) => push(statusIntent('longRunning', strings.status.longRunningHeadline, 'passive', info), session),
    onStall: (session, info) => push(statusIntent('stall', strings.status.stallHeadline, 'timeSensitive', info), session),
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
    const intent = intentOfSessionEvent(event, strings)
    if (intent === undefined) return
    if (!eventAllowed(intent)) return
    // G-18：approval/asked 即时推送键追加负载摘要（hash6(detail)——detail 由 toolName/
    // reason 构成）。宿主重放（同 session 同 seq）但负载不同（先请 toolA 后请 toolB）时
    // 不再互吞；turn 类维持现状——同 seq 即同一事件，负载不参与判定。
    const base = `${session.id ?? '(anon)'}:${event.seq ?? 0}`
    const key = intent.event === 'approval/asked' ? `${base}:${hash6(intent.detail)}` : base
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
    push(intentOfAgentError(payload, strings), agent?.session)
  }

  const hostEvents = createHostEventRegistrar(ctx, warn)
  // v0.10 提交7：把宿主事件 registrar 的只读诊断快照外泄给装配层（管理台 /host 的
  // events.received 视图）。快照只含计数+context/scope 状态，无正文/标识符/凭证。
  // 回调接线失败绝不致命（诊断能力降级，事件订阅主链路不受影响）。
  if (typeof wiring.onHostEvents === 'function') {
    try { wiring.onHostEvents(hostEvents) } catch { /* 诊断接线失败不致命 */ }
  }
  const disposeSession = hostEvents.on('session/event', (...args) => {
    const normalized = normalizeSessionEventArgs(args)
    if (normalized === undefined) {
      warn('宿主 session/event 载荷已拒绝（仅接受 (session, event) 或 { session, event }）')
      return
    }
    sessionListener(normalized.session, normalized.event)
  })
  let disposeError = null
  const extraDisposers = []
  disposeError = hostEvents.on('agent/error', errorListener)
  const disposeAgentDisposed = hostEvents.on('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload
      tracker.observeAgentDisposed(agent)
      const bus = busFn !== null ? (() => { try { return busFn() } catch { return null } })() : null
      const agentId = typeof agent?.id === 'string' ? agent.id : typeof agent?.session?.id === 'string' ? agent.session.id : ''
      if (bus !== null && agentId !== '' && typeof bus.abandonByAgent === 'function') {
        try { bus.abandonByAgent(agentId) } catch { }
      }
    })
  if (typeof disposeAgentDisposed === 'function') extraDisposers.push(disposeAgentDisposed)

  // 返回可被 cordis await 的清理：flush 未到期的 turn/end 防抖与宽限窗任务，并等待所有在途推送完成。
  // headless 一次性运行在 appExit 前会 dispose 整个树（5s 宽限），Pending 通知因此能送达。
  return () => {
    const triggered = [...debounce.flush(), ...grace.flush()]
    tracker.dispose() // v0.5：清心跳/卡住定时器
    disposeSession?.()
    disposeError?.()
    for (const dispose of extraDisposers) {
      try { dispose() } catch { /* 反注册失败不致命 */ }
    }
    hostEvents.reportZeroEvents()
    return Promise.allSettled([...triggered, notifier.flush()]).then(() => undefined)
  }
}
