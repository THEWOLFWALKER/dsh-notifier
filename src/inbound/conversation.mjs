// dsh-notifier inbound/conversation.mjs
// 会话路由器（阶段 5）：手机回复 → 送进正在跑的 agent。
// 三个投递语义（对齐宿主 Agent API，见 docs/subsystems/core.md）：
//  - followup：agent 空闲 → 作为下一轮输入并唤醒（「任务做完了，再做一件」）
//  - inject：  agent 忙碌 → 排队到下一步边界，不唤醒不打断（排队补料）
//  - steer：   `!` 前缀 → 就近纠偏；空闲时等价 followup（「马上改，别跑偏」）
// 命令集：/help /status /bind <sessionId> /unbind /stop
// 军规：入站文本只能以 plugin 来源进会话流（source.kind = 'plugin'），永不直接执行 shell；
// 任何投递异常只回执用户，绝不弄崩宿主。

import { randomUUID } from 'node:crypto'

const DEFAULT_MERGE_WINDOW_MS = 1500
const SUMMARY_MAX_CHARS = 120

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
 * @returns {() => void} 反注册函数
 */
export function registerConversationRouter(deps) {
  const { ctx, bus, store } = deps
  const reply = typeof deps.reply === 'function' ? deps.reply : () => {}
  const cfg = deps.config ?? {}
  const mergeWindowMs = Math.max(0, Number(cfg.mergeWindowMs) || DEFAULT_MERGE_WINDOW_MS)
  const steerPrefix = typeof cfg.steerPrefix === 'string' && cfg.steerPrefix.length > 0 ? cfg.steerPrefix : '!'
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/conversation]', message) } catch { /* 日志失败绝不致命 */ }
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
  const boundSession = (envelope) => {
    const bound = store.get(bindingKey(envelope))
    if (typeof bound === 'string' && bound !== '') return bound
    return latestSessionId // 默认：最近活跃 agent
  }

  function handleCommand(envelope, text) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    const say = (message) => reply(envelope.channel, envelope.chatId, message)
    if (cmd === 'help') {
      say([
        '命令集：',
        '  /status — 查看绑定与 agent 状态',
        '  /bind <sessionId> — 绑定到指定会话',
        '  /unbind — 解绑（回到默认：最近活跃会话）',
        '  /stop — 取消当前 turn',
        '  /help — 本帮助',
        '',
        '直接发文本 = 对话；! 前缀 = 纠偏（steer）；.. 结尾 = 立即发送（合并窗内）。',
      ].join('\n'))
      return true
    }
    if (cmd === 'status') {
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      say([
        `绑定：${store.get(bindingKey(envelope)) ?? '（默认：最近活跃会话）'}`,
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
      say(`已绑定 ${target}`)
      return true
    }
    if (cmd === 'unbind') {
      store.delete(bindingKey(envelope))
      say('已解绑（回到默认：最近活跃会话）')
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
    return false // 未知命令：当普通文本处理（避免吞消息）
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
    const bound = boundSession(envelope)
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

  // 追踪最近活跃 agent（默认投递目标）；agent 退出时清理绑定与合并窗
  const trackAgent = (agent) => {
    if (agent?.id !== undefined) latestSessionId = agent.id
  }
  try {
    disposers.push(ctx.on('agent/created', trackAgent))
  } catch { /* 宿主无此事件：默认绑定不可用，仍可 /bind */ }
  try {
    disposers.push(ctx.on('agent/disposed', (agent) => {
      if (agent?.id !== undefined && agent.id === latestSessionId) latestSessionId = null
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
