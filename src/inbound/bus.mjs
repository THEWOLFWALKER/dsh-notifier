// dsh-notifier inbound/bus.mjs
// 入站总线：所有回传能力的汇合点。
// 安全红线：
//  - 白名单默认全拒（allowUsers 为空 → 任何入站消息都被拒绝）
//  - 持久化去重 + 内存 FIFO 双层（轮询 cursor 不落盘时，重启后全靠它防重复消费）
//  - 审批裁决先到先得；无等待者（已处理/超时）的裁决返回 already-resolved，绝不二次生效
// token 校验在本层完成（vault 注入）；单次核销由 approval 账本的状态机保证。

const DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_FIFO_MAX = 512

/**
 * 创建入站总线。
 * @param {object} options
 * @param {string[]} [options.allowUsers] - 白名单 user id（跨渠道全局）；空 = 全拒
 * @param {import('./store.mjs').store} [options.store] - 持久化 store（去重跨重启）
 * @param {object} [options.vault] - createTokenVault 实例
 * @param {number} [options.dedupWindowMs] - 去重窗口，默认 24h
 * @param {object} [options.logger] - cordis logger
 */
export function createInboundBus(options = {}) {
  const allow = new Set((Array.isArray(options.allowUsers) ? options.allowUsers : []).map(String))
  const store = options.store ?? null
  const vault = options.vault ?? null
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/inbound]', message) } catch { /* 日志失败绝不致命 */ }
  }

  // 双层去重：内存 FIFO（快速路径）+ store（重启恢复）
  const fifo = new Set()
  const dedupKeyOf = (envelope) => `dedup:${envelope.channel}:${envelope.messageId}`

  const waiters = new Map() // approvalKey -> { resolve, timer, settled }
  const messageHandlers = new Set()

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

  return {
    /** 白名单判定：默认全拒。 */
    allows(userId) {
      return allow.has(String(userId))
    },

    /**
     * 接收一条入站消息（白名单 + 去重通过后才交给处理器）。
     * @returns {{ ok: boolean, reason?: 'whitelist' | 'duplicate' }}
     */
    accept(envelope) {
      if (!this.allows(envelope.userId)) {
        warn(`拒绝入站消息：user ${envelope.userId} 不在白名单`)
        return { ok: false, reason: 'whitelist' }
      }
      if (isDuplicate(envelope)) {
        warn(`跳过重复入站消息：${envelope.channel}:${envelope.messageId}`)
        return { ok: false, reason: 'duplicate' }
      }
      remember(envelope)
      for (const handler of messageHandlers) {
        try {
          handler(envelope)
        } catch (error) {
          // A listener never throws：入站处理异常不致命
          warn(`入站消息处理异常: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { ok: true }
    },

    /** 订阅通过白名单+去重的文本消息（conversation router 用）。 */
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },

    /**
     * 等待某审批 key 的裁决；timeoutMs 内无人应答 resolve(null)（静默永不批准）。
     * @returns {Promise<null | { decision: 'allowed-once' | 'rejected', via: string, userId: string }>}
     */
    wait(approvalKey, timeoutMs = 120000) {
      return new Promise((resolve) => {
        const entry = { resolve, settled: false, timer: null }
        entry.timer = setTimeout(() => {
          if (entry.settled) return
          entry.settled = true
          waiters.delete(approvalKey)
          resolve(null)
        }, timeoutMs)
        waiters.set(approvalKey, entry)
      })
    },

    /** 主动放弃等待（桌面先处理时调用）；等待者以 null 收场（等同无人应答）。 */
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
  }
}
