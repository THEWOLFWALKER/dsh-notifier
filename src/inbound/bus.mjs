// dsh-notifier inbound/bus.mjs
// 入站总线：所有回传能力的汇合点。
// 安全红线：
//  - 白名单默认全拒（绑定表与 allowUsers 均空 → 引导态：业务面仍全拒，只开放注册面）
//  - 持久化去重 + 内存 FIFO 双层（轮询 cursor 不落盘时，重启后全靠它防重复消费）
//  - 审批裁决先到先得；无等待者（已处理/超时）的裁决返回 already-resolved，绝不二次生效
//  - 静默永不批准：引导态/未绑定用户的一切消息（含伪造审批回复）不触审批
// token 校验在本层完成（vault 注入）；单次核销由 approval 账本的状态机保证。
//
// v0.7 身份层（计划书 §3.1/§3.2/§3.4）：
//  - 准入从 allows(userId) 扁平集合改为 allows(channel, userId) 复合键（identity 注入时）；
//    未注入 identity 的构造（旧测试/旧装配）保持 v0.6 扁平行为——签名兼容两者。
//  - 拒绝回执：reason whitelist/guided 携带 reply 文案（含发送者自身渠道身份），
//    每用户 60s 节流，防陌生人把机器人刷成回执轰炸器。
//  - 注册面命令（/whoami /pair /unpair + 引导态 /help）在业务扇出前拦截并消费。

import { createCommandHandler, getChannelName, parseCommand } from './commands.mjs'

const DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_FIFO_MAX = 512
/** 拒绝回执节流：每用户 60 秒至多一条（内存 Map，重启清零无妨）。 */
const REPLY_THROTTLE_MS = 60 * 1000

/**
 * 创建入站总线。
 * @param {object} options
 * @param {string[]} [options.allowUsers] - v0.6 白名单（identity 未注入时的准入依据；注入后仅参与引导态判定）
 * @param {import('./identity.mjs').createIdentity} [options.identity] - v0.7 身份绑定层（推荐注入）
 * @param {import('./pairing.mjs').createPairing} [options.pairing] - v0.7 配对码状态机（/pair 受理用）
 * @param {import('./store.mjs').store} [options.store] - 持久化 store（去重跨重启）
 * @param {object} [options.vault] - createTokenVault 实例
 * @param {number} [options.dedupWindowMs] - 去重窗口，默认 24h
 * @param {object} [options.logger] - cordis logger
 * @param {() => void} [options.onBootstrapRemint] - 引导码重铸回调（stderr 展示）
 */
export function createInboundBus(options = {}) {
  const allow = new Set((Array.isArray(options.allowUsers) ? options.allowUsers : []).map(String))
  const identity = options.identity ?? null
  const pairing = options.pairing ?? null
  const store = options.store ?? null
  const vault = options.vault ?? null
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/inbound]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound]', message) } catch { /* 控制台不可用不致命 */ }
  }
  const commands = identity !== null && pairing !== null
    ? createCommandHandler({ identity, pairing, logger: options.logger, onBootstrapRemint: options.onBootstrapRemint })
    : null

  // 双层去重：内存 FIFO（快速路径）+ store（重启恢复）
  const fifo = new Set()
  const dedupKeyOf = (envelope) => `dedup:${envelope.channel}:${envelope.messageId}`

  // 拒绝回执节流表：userId -> lastReplyAt
  const replyThrottle = new Map()

  const waiters = new Map() // approvalKey -> { resolve, timer, settled }
  const messageHandlers = new Set()
  const agentWaiters = new Map()
  let disposed = false

  function isDuplicate(envelope, now = Date.now()) {
    const key = dedupKeyOf(envelope)
    if (fifo.has(key)) return true
    if (store !== null) {
      const seenAt = store.get(key)
      if (typeof seenAt === 'number' && now - seenAt < dedupWindowMs) return true
    }
    return false
  }

  function remember(envelope, now = Date.now()) {
    const key = dedupKeyOf(envelope)
    fifo.add(key)
    if (fifo.size > DEFAULT_FIFO_MAX) {
      const oldest = fifo.keys().next().value
      fifo.delete(oldest)
    }
    if (store !== null) store.set(key, now)
  }

  /** 引导态：绑定表空 + 旧白名单空（此时六通道照常启动，仅开放注册面）。 */
  function isGuided() {
    return identity !== null && identity.isEmpty() && allow.size === 0
  }

  /** 节流判定：窗口内已回执过则吞掉本次（返回 false 表示应回执）。 */
  function shouldReply(userId, now = Date.now()) {
    const last = replyThrottle.get(String(userId)) ?? 0
    if (now - last < REPLY_THROTTLE_MS) return false
    replyThrottle.set(String(userId), now)
    if (replyThrottle.size > 1024) { // 有界：防长期运行内存无限涨
      const oldest = replyThrottle.keys().next().value
      replyThrottle.delete(oldest)
    }
    return true
  }

  function attachAgent(approvalKey, agentId) {
    const key = String(agentId ?? '')
    if (key === '') return
    let keys = agentWaiters.get(key)
    if (keys === undefined) {
      keys = new Set()
      agentWaiters.set(key, keys)
    }
    keys.add(approvalKey)
  }

  function detachAgent(approvalKey, agentId) {
    const key = String(agentId ?? '')
    if (key === '') return
    const keys = agentWaiters.get(key)
    if (keys === undefined) return
    keys.delete(approvalKey)
    if (keys.size === 0) agentWaiters.delete(key)
  }

  return {
    /** 准入判定（默认全拒）。v0.7 复合键；旧调用 allows(userId) 仍兼容（扁平集合期语义）。 */
    allows(channel, userId) {
      if (identity !== null) return identity.allows(String(channel ?? ''), String(userId ?? ''))
      const id = userId === undefined ? String(channel) : String(userId)
      return allow.has(id)
    },

    /** 是否处于引导态（诊断/管理台展示用）。 */
    guided() {
      return isGuided()
    },

    /**
     * 接收一条入站消息。
     * 判定链（v0.7 计划书 §3.2 图 1）：
     *   绑定成员 → 注册面命令拦截（消费）否则业务扇出
     *   引导态 → /help /whoami /pair 受理，其余引导回执
     *   名单非空未绑定 → /whoami /pair 受理，其余拒绝回执（含自身渠道身份）
     * @returns {{ ok: boolean, reason?: 'whitelist' | 'guided' | 'duplicate', reply?: string }}
     *   reply 存在时由 adapter 调本通道 sendText 回执（节流后吞掉的回执无 reply 字段）
     */
    accept(envelope) {
      if (isDuplicate(envelope)) {
        warn(`跳过重复入站消息：${envelope.channel}:${envelope.messageId}`)
        return { ok: false, reason: 'duplicate' }
      }
      const bound = this.allows(envelope.channel, envelope.userId)
      const guided = isGuided()

      // 注册面命令：绑定成员与未绑定者均可触达（/whoami /pair 是准入前的自助面）
      if (commands !== null && typeof envelope.text === 'string') {
        const command = parseCommand(envelope.text)
        if (command !== null) {
          // /pair /whoami 全员可用；/unpair 仅绑定者；/help 仅引导态由本层应答
          const identityFace = command.name === 'pair' || command.name === 'whoami'
            || (command.name === 'unpair' && bound)
            || (command.name === 'help' && guided)
          if (identityFace) {
            remember(envelope)
            const handled = commands.handle(envelope, command, guided)
            if (handled !== null) return { ok: true, reply: handled.reply }
          }
        }
      }

      if (bound) {
        remember(envelope)
        // v0.6.3 消费语义：handler 返回 true = 消息已被该处理器消费，停止扇出
        // （审批编号回复吃掉「1」后不再进对话路由，防同一消息双重消费）。
        for (const handler of messageHandlers) {
          try {
            if (handler(envelope) === true) break
          } catch (error) {
            // A listener never throws：入站消息处理异常不致命
            warn(`入站消息处理异常: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return { ok: true }
      }

      // 未绑定：拒绝也记账（R5 审查 R5-3-P3-2：平台对未回执消息会重投，不 remember 则
      // 同一 messageId 每次重投都重走判定链——60s 节流只兜回执不兜 warn 刷屏）
      remember(envelope)
      // 拒绝回执（引导态文案带配对指引；普通态带联系管理员指引）
      if (identity !== null && shouldReply(envelope.userId)) {
        const idLine = `你的${getChannelName(envelope.channel)}身份是 ${envelope.userId}。`
        const reply = guided
          ? `${idLine}\n当前为引导模式（白名单为空）。发送 /pair <配对码> 完成绑定（首位绑定者成为 owner），配对码见宿主启动日志；/whoami 查看你的身份。`
          : `${idLine}\n你不在白名单中。请联系管理员生成配对码，然后发送 /pair <配对码> 绑定。`
        warn(`拒绝入站消息：${envelope.channel} user ${envelope.userId} 不在白名单${guided ? '（引导态）' : ''}`)
        return { ok: false, reason: guided ? 'guided' : 'whitelist', reply }
      }
      warn(`拒绝入站消息：user ${envelope.userId} 不在白名单`)
      return { ok: false, reason: 'whitelist' }
    },

    /** 订阅通过白名单+去重的文本消息（conversation router 用）。 */
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },

    wait(approvalKey, timeoutMs = 120000, options = {}) {
      if (disposed) return Promise.resolve(null)
      const existing = waiters.get(approvalKey)
      if (existing !== undefined && !existing.settled) return existing.promise
      const agentId = typeof options.agentId === 'string' ? options.agentId : ''
      const onAbandon = typeof options.onAbandon === 'function' ? options.onAbandon : null
      const entry = { resolve: null, settled: false, timer: null, promise: null, agentId, onAbandon }
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve
        entry.timer = setTimeout(() => {
          if (entry.settled) return
          entry.settled = true
          waiters.delete(approvalKey)
          detachAgent(approvalKey, entry.agentId)
          resolve(null)
        }, timeoutMs)
      })
      if (agentId !== '') attachAgent(approvalKey, agentId)
      waiters.set(approvalKey, entry)
      return entry.promise
    },

    abandon(approvalKey, reason = 'manual') {
      const entry = waiters.get(approvalKey)
      if (entry === undefined) return false
      clearTimeout(entry.timer)
      entry.settled = true
      waiters.delete(approvalKey)
      detachAgent(approvalKey, entry.agentId)
      if (reason === 'agent/disposed') {
        try { entry.onAbandon?.() } catch { }
      }
      entry.resolve(null)
      return true
    },

    abandonByAgent(agentId) {
      const key = String(agentId ?? '')
      const keys = agentWaiters.get(key)
      if (key === '' || keys === undefined || keys.size === 0) return 0
      let count = 0
      for (const approvalKey of [...keys]) {
        if (this.abandon(approvalKey, 'agent/disposed')) count += 1
      }
      return count
    },

    settle(approvalKey, decision, via, userId) {
      const entry = waiters.get(approvalKey)
      if (entry === undefined || entry.settled) {
        return { ok: false, reason: 'already-resolved' }
      }
      entry.settled = true
      clearTimeout(entry.timer)
      waiters.delete(approvalKey)
      detachAgent(approvalKey, entry.agentId)
      entry.resolve({ decision, via, userId: String(userId) })
      return { ok: true }
    },

    decide({ approvalKey, decision, token, via = 'unknown', userId = '(unknown)' }) {
      if (decision !== 'allowed-once' && decision !== 'rejected') {
        return { ok: false, reason: 'invalid-decision' }
      }
      if (vault !== null) {
        if (token === undefined) return { ok: false, reason: 'token-required' }
        const verdict = vault.verify(token)
        if (!verdict.ok) return { ok: false, reason: verdict.reason }
        if (verdict.key !== approvalKey) return { ok: false, reason: 'key-mismatch' }
      }
      return this.settle(approvalKey, decision, via, userId)
    },

    decideTrusted({ approvalKey, decision, via = 'unknown', userId = '(unknown)' }) {
      if (decision !== 'allowed-once' && decision !== 'rejected') {
        return { ok: false, reason: 'invalid-decision' }
      }
      return this.settle(approvalKey, decision, via, userId)
    },

    pendingCount() {
      return waiters.size
    },

    dispose() {
      disposed = true
      for (const [approvalKey, entry] of waiters) {
        entry.settled = true
        clearTimeout(entry.timer)
        detachAgent(approvalKey, entry.agentId)
        try { entry.resolve(null) } catch { }
      }
      waiters.clear()
      agentWaiters.clear()
      messageHandlers.clear()
    },

    dedupWindowMs,
  }
}
