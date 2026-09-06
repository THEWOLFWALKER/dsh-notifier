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
/** G-46：合成 messageId（内容哈希兜底键）短去重窗——只兜平台 HTTP 重投（秒级），
 *  绝不能像平台原生 msgId 一样扛 24h：合成键撞车 = 两条不同消息同文本（如用户对
 *  两次审批各回一条「1」），24h 窗会把第二条静默吞成 duplicate。60s 覆盖重投窗口，
 *  又把误吞面收敛到「同一分钟内同文本」这一本就歧义的窄缝。 */
const DEFAULT_SYNTHETIC_DEDUP_WINDOW_MS = 60 * 1000
const DEFAULT_FIFO_MAX = 512
/** 拒绝回执节流：每用户 60 秒至多一条（内存 Map，重启清零无妨）。 */
const REPLY_THROTTLE_MS = 60 * 1000

/**
 * G-31：onMessage 显式消费优先级（数值小者先收到消息；同优先级按注册先后稳定排序）。
 * 原实现是 Set 插入序即优先级——装配顺序（index.mjs 里 approval → questions →
 * conversation 的注册次序）成了隐式契约，questions 的 attach() 还专门注释「必须在
 * 审批路由注册之后调用」。显式化后任何装配顺序都得到同一判定链：
 *   cardAction      ap:/aq: 显式动作负载（卡片按钮/编号回执线）
 *   numberedReply   裸 1/2 编号回复（审批先于提问靠同优先级插入序：审批注册在前）
 *   conversation    会话路由兜底（最后；前层未消费的消息才进 agent 会话）
 */
export const MESSAGE_PRIORITY = Object.freeze({
  cardAction: 10,
  numberedReply: 20,
  default: 50,
  conversation: 100,
})

/**
 * 创建入站总线。
 * @param {object} options
 * @param {string[]} [options.allowUsers] - v0.6 白名单（identity 未注入时的准入依据；注入后仅参与引导态判定）
 * @param {import('./identity.mjs').createIdentity} [options.identity] - v0.7 身份绑定层（推荐注入）
 * @param {import('./pairing.mjs').createPairing} [options.pairing] - v0.7 配对码状态机（/pair 受理用）
 * @param {import('./store.mjs').store} [options.store] - 持久化 store（去重跨重启）
 * @param {object} [options.vault] - createTokenVault 实例
 * @param {number} [options.dedupWindowMs] - 去重窗口，默认 24h（平台原生 messageId）
 * @param {number} [options.syntheticDedupWindowMs] - 合成 messageId 去重窗口，默认 60s（G-46）
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
  const syntheticDedupWindowMs = options.syntheticDedupWindowMs ?? DEFAULT_SYNTHETIC_DEDUP_WINDOW_MS
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/inbound]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound]', message) } catch { /* 控制台不可用不致命 */ }
  }
  const commands = identity !== null && pairing !== null
    ? createCommandHandler({ identity, pairing, logger: options.logger, onBootstrapRemint: options.onBootstrapRemint })
    : null

  // 双层去重：内存 FIFO（快速路径）+ store（重启恢复）。
  // G-46 起条目带时间戳：短窗键（合成 messageId）到期自动放行——原实现是纯 Set，
  // 条目只按容量淘汰不按时间过期，60s 短窗会被 FIFO 永久挡死（同文本第二条在
  // 512 条新消息把它挤出去之前永远 duplicate）。
  const fifo = new Map()
  const dedupKeyOf = (envelope) => `dedup:${envelope.channel}:${envelope.messageId}`
  // G-46：合成键（adapter 侧内容哈希兜底）按 envelope 标记走短窗；平台原生 msgId 长窗不变。
  const dedupWindowOf = (envelope) => envelope?.messageIdSynthetic === true ? syntheticDedupWindowMs : dedupWindowMs

  // 拒绝回执节流表：(channel,userId) -> lastReplyAt；相同平台用户号在
  // 不同渠道属于不同身份，不能互相节流。
  const replyThrottle = new Map()

  const waiters = new Map() // approvalKey -> { resolve, timer, settled }
  // G-31：handler -> { priority, seq }；扇出按 (priority asc, seq asc) 稳定排序。
  const messageHandlers = new Map()
  let handlerSeq = 0
  const agentWaiters = new Map()
  let disposed = false

  function isDuplicate(envelope, now = Date.now()) {
    const key = dedupKeyOf(envelope)
    const fifoAt = fifo.get(key)
    if (typeof fifoAt === 'number' && now - fifoAt < dedupWindowOf(envelope)) return true
    if (store !== null) {
      const seenAt = store.get(key)
      if (typeof seenAt === 'number' && now - seenAt < dedupWindowOf(envelope)) return true
    }
    return false
  }

  function remember(envelope, now = Date.now()) {
    const key = dedupKeyOf(envelope)
    // 重置插入序：同 key 重复 remember 不占容量（Map.set 原地更新不挪位，语义无妨——
    // 容量淘汰只关心界内条目数）
    fifo.set(key, now)
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
  function shouldReply(channel, userId, now = Date.now()) {
    const key = JSON.stringify([String(channel ?? ''), String(userId ?? '')])
    const last = replyThrottle.get(key) ?? 0
    if (now - last < REPLY_THROTTLE_MS) return false
    replyThrottle.set(key, now)
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
        // G-31：按显式 priority 稳定排序扇出（原 Set 插入序 = 隐式装配顺序契约）。
        const ordered = [...messageHandlers.entries()]
          .sort((a, b) => (a[1].priority - b[1].priority) || (a[1].seq - b[1].seq))
        for (const [handler] of ordered) {
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
      if (identity !== null && shouldReply(envelope.channel, envelope.userId)) {
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

    /**
     * 订阅通过白名单+去重的文本消息（conversation router 用）。
     * G-31：options.priority 显式声明消费优先级（数值小者先收到；缺省 default=50，
     * 与旧插入序行为对齐——审批/提问/会话路由都已改传显式值）。同一 bus 实例上的
     * 注册顺序不再是行为契约。
     * @param {(envelope: object) => boolean | void} handler 返回 true = 消费并停止扇出
     * @param {{ priority?: number }} [options]
     * @returns {() => void} 反订阅
     */
    onMessage(handler, { priority = MESSAGE_PRIORITY.default } = {}) {
      messageHandlers.set(handler, { priority: Number(priority) || 0, seq: (handlerSeq += 1) })
      return () => messageHandlers.delete(handler)
    },

    wait(approvalKey, timeoutMs = 120000, options = {}) {
      if (disposed) return Promise.resolve(null)
      const existing = waiters.get(approvalKey)
      if (existing !== undefined && !existing.settled) return existing.promise
      const agentId = typeof options.agentId === 'string' ? options.agentId : ''
      const onAbandon = typeof options.onAbandon === 'function' ? options.onAbandon : null
      // v0.8.3 SEC-1：允许会话范围（channel → chatId 集合）。按钮裁决来源校验用；
      // 缺省 null = 不限制（编号回复/旧装配不受影响）。
      const allowChats = options.allowChats ?? null
      const entry = { resolve: null, settled: false, timer: null, promise: null, agentId, onAbandon, allowChats }
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

    decide({ approvalKey, decision, token, via = 'unknown', userId = '(unknown)', chatId = undefined }) {
      if (decision !== 'allowed-once' && decision !== 'rejected') {
        return { ok: false, reason: 'invalid-decision' }
      }
      if (vault !== null) {
        if (token === undefined) return { ok: false, reason: 'token-required' }
        const verdict = vault.verify(token)
        if (!verdict.ok) return { ok: false, reason: verdict.reason }
        if (verdict.key !== approvalKey) return { ok: false, reason: 'key-mismatch' }
      }
      // v0.8.3 SEC-1 → CRACK-002：来源会话校验（仅按钮裁决路径）改 fail-closed。
      // 有源证据（allowChats 范围 + 点击 chatId）才算有效按钮路径，缺一即无来源授权 → 拒绝，
      // 不核销 wait（合法原会话仍可裁决）；decideTrusted（编号回复）不走本分支，归属另校验。
      const entry = waiters.get(approvalKey)
      if (entry === undefined) {
        // 无 waiter：重放/已决。settle 会返回 already-resolved；不走本分支，保留 settle 语义。
      } else {
        const chatProvided = chatId !== undefined && chatId !== null && String(chatId) !== ''
        const scopeProvided = entry.allowChats !== null && entry.allowChats !== undefined
        if (!chatProvided || !scopeProvided) {
          // 缺点击会话或缺来源范围：无法确证来源 → 显式拒绝，不核销 wait。
          warn(`decide ${approvalKey} 来源校验失败（chatId 提供:${chatProvided}，allowChats:${scopeProvided}）`)
          return { ok: false, reason: 'source-chat-mismatch', message: '请到原会话操作' }
        }
        const channel = String(via ?? '').split(':')[0]
        const chatSet = entry.allowChats.get(channel)
        if (chatSet === undefined || !chatSet.has(String(chatId))) {
          return { ok: false, reason: 'source-chat-mismatch' }
        }
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
