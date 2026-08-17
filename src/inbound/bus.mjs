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
  // v0.6.5（审查 R4-1-P3-4）：停机终态——dispose 后 wait() 一律按无人应答（null）收场，
  // 不再注册新 waiter（其 120s 定时器会拖住进程退出，R2-P2-5 有意不 unref 的副作用
  // 在停机窗口失去对冲）。语义与 dispose 收场一致：回落桌面。
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

    /**
     * 等待某审批 key 的裁决；timeoutMs 内无人应答 resolve(null)（静默永不批准）。
     * v0.6.3：同 key 未决时复用既有 waiter 的 promise——原实现无条件覆盖注册位，
     * 旧 entry 的超时回调会误删新注册（跨重启 counter 归零 + 同 callId 可复现 key）。
     * v0.6.4（R2-P2-5 修正）：不再对 waiter 定时器 unref——unref 会让「仅剩超时定时器
     * 存活」的事件循环直接退出（测试 await 超时路径全炸；生产中在途审批也不该因
     * 恰好空闲而蒸发）。停机清理由 dispose() 承担（clearTimeout 全量收场），职责单一。
     */
    wait(approvalKey, timeoutMs = 120000) {
      if (disposed) return Promise.resolve(null) // 停机期新审批：无人应答，回落桌面
      const existing = waiters.get(approvalKey)
      if (existing !== undefined && !existing.settled) return existing.promise
      const entry = { resolve: null, settled: false, timer: null, promise: null }
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve
        entry.timer = setTimeout(() => {
          if (entry.settled) return
          entry.settled = true
          waiters.delete(approvalKey)
          resolve(null)
        }, timeoutMs)
      })
      waiters.set(approvalKey, entry)
      return entry.promise
    },

    /**
     * 主动放弃等待（桌面先处理时调用）；等待者以 null 收场（等同无人应答）。
     */
    abandon(approvalKey) {
      const entry = waiters.get(approvalKey)
      if (entry === undefined) return false
      clearTimeout(entry.timer)
      entry.settled = true
      waiters.delete(approvalKey)
      entry.resolve(null)
      return true
    },

    /** 首达采纳：把裁决交给等待者；二次裁决返回 already-resolved。 */
    settle(approvalKey, decision, via, userId) {
      const entry = waiters.get(approvalKey)
      if (entry === undefined || entry.settled) {
        return { ok: false, reason: 'already-resolved' }
      }
      entry.settled = true
      clearTimeout(entry.timer)
      waiters.delete(approvalKey)
      entry.resolve({ decision, via, userId: String(userId) })
      return { ok: true }
    },

    /**
     * 提交一次审批裁决（按钮点击）。
     * token 必须由 vault 验签通过且 key 匹配；首达采纳，其余拒绝。
     * @returns {{ ok: boolean, reason?: string }}
     */
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

    /**
     * 可信裁决（编号回复降级，无按钮渠道）：信任已由 accept 的白名单+去重建立，
     * 跳过 token 校验，但仍受「首达采纳」约束。
     */
    decideTrusted({ approvalKey, decision, via = 'unknown', userId = '(unknown)' }) {
      if (decision !== 'allowed-once' && decision !== 'rejected') {
        return { ok: false, reason: 'invalid-decision' }
      }
      return this.settle(approvalKey, decision, via, userId)
    },

    /** 待决数量（诊断用）。 */
    pendingCount() {
      return waiters.size
    },

    /**
     * v0.6.4（审查 R2-P2-5）：总线整体停机——全部 waiter 以 null 收场（等同无人应答，
     * 在途审批超时回退桌面语义）、清定时器、摘全部消息处理器。幂等，可重复调用。
     */
    dispose() {
      disposed = true
      for (const entry of waiters.values()) {
        entry.settled = true
        clearTimeout(entry.timer)
        try { entry.resolve(null) } catch { /* resolve 异常不致命 */ }
      }
      waiters.clear()
      messageHandlers.clear()
    },

    /** v0.6.4：去重窗口毫秒数（index 清扫阈值联动用——窗口可配时清扫线必须跟随）。 */
    dedupWindowMs,
  }
}
