// dsh-notifier inbound/wechat-ilink.mjs
// 微信个人号 iLink Bot 双向入站（v0.3.0 阶段 4）：getupdates 长轮询 + sendmessage 回执。
// 协议细节全部在 _ilink-api.mjs（Hermes weixin.py MIT 移植）；本文件只做通道编排：
//  - 轮询节奏：连续失败 <3 等待 2s，≥3 退避 30s 后计数清零（weixin.py 行 110-112）
//  - 游标 wechat:sync_buf 必须持久化（丢失/回退会重复收消息）
//  - context_token：入站消息永远最新（收到即缓存 wechat:ctx:<uid>），发送回显最新值
//  - 发送分块（默认 2000 字/块，块间 2s 降密度）
//  - 错误语义：
//      会话过期（-14 / 伪装的 -2 unknown error）→ 剥 context_token 重试一次；
//        仍失败 → 清 ctx tokens + 游标 + 凭证，通道停用，中文告警「重新扫码登录」
//      真限流（-2 其他 errmsg）→ 熔断计数（阈值 3/窗口 60s → 开路 15s）
//  - 任一入站消息复位熔断（Hermes 2026-08-06 实证：用户再发一条消息即解锁配额）
// 军规：任何异常只 warn；stop() abort 在途长轮询并等循环退出。
// 运行约束：单 token 同时只允许一个网关实例在线（协议本身如此，与 Hermes/OpenClaw 同）。

import { createHash, randomUUID } from 'node:crypto'
import {
  ILINK_BASE_URL,
  createIlinkClient,
  classifyIlinkResponse,
  extractIlinkText,
} from './_ilink-api.mjs'
import { createBreaker } from './_breaker.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const SYNC_BUF_KEY = 'wechat:sync_buf'
const ACCOUNT_KEY = 'wechat:account'
const CTX_PREFIX = 'wechat:ctx:'

/** content → 6 位十六进制摘要（合成 messageId 用）。 */
function hash6(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 6)
}

function clampInt(value, fallback, min, max) {
  const raw = value === undefined || value === null || value === '' ? fallback : Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : fallback))
}

/**
 * 解析并校验 inbound.wechat 配置（凭证可来自登录 CLI 落盘的 store 记录）。
 * @param {object} raw - inbound.wechat 原始配置
 * @param {{ credentials?: object }} [inject] - store.get('wechat:account') 的登录凭证
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function resolveWechatInboundConfig(raw, { credentials } = {}) {
  const cfg = (raw !== null && typeof raw === 'object') ? raw : {}
  const cred = (credentials !== null && typeof credentials === 'object') ? credentials : {}
  const accountId = String(cfg.accountId ?? cred.accountId ?? '').trim()
  const token = String(cfg.token ?? cred.token ?? '').trim()
  if (accountId === '' || token === '') {
    return {
      ok: false,
      reason: `wechat inbound 需要登录凭证（accountId + token，当前 accountId ${accountId !== '' ? '已配置' : '缺失'}，token ${token !== '' ? '已配置' : '缺失'}）。请先执行 node scripts/wechat-login.mjs 扫码登录，或在 inbound.wechat 显式填写`,
    }
  }
  return {
    ok: true,
    config: {
      accountId,
      token,
      baseUrl: (String(cfg.baseUrl ?? cred.baseUrl ?? '').trim() || ILINK_BASE_URL).replace(/\/+$/, ''),
      userId: String(cfg.userId ?? cred.userId ?? '').trim(),
      notifyUsers: (Array.isArray(cfg.notifyUsers) ? cfg.notifyUsers : []).map((id) => String(id).trim()).filter((id) => id !== ''),
      longPollTimeoutMs: clampInt(cfg.longPollTimeoutMs, 35000, 5000, 120000),
      timeoutMs: clampInt(cfg.timeoutMs, 15000, 1000, 60000),
      chunkSize: clampInt(cfg.chunkSize, 2000, 10, 4000),
      sendChunkDelayMs: clampInt(cfg.sendChunkDelayMs, 2000, 0, 30000),
      retryDelayMs: clampInt(cfg.retryDelayMs, 2000, 1000, 60000),
      backoffDelayMs: clampInt(cfg.backoffDelayMs, 30000, 1000, 300000),
      breakerThreshold: clampInt(cfg.breakerThreshold, 3, 1, 10),
      breakerWindowMs: clampInt(cfg.breakerWindowMs, 60000, 5000, 600000),
      breakerOpenMs: clampInt(cfg.breakerOpenMs, 15000, 0, 600000),
    },
  }
}

/**
 * 创建微信 iLink 入站通道（统一契约；buttons=false，审批走编号回复）。
 * @param {object} options
 * @param {ReturnType<typeof resolveWechatInboundConfig>['config']} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {import('./store.mjs').store} [options.store] - 游标 / context_token / 凭证持久化
 * @param {string[]} [options.fallbackTargets] - 未配置 notifyUsers 时的推送目标（全局白名单回落）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 * @param {() => number} [options.now] - 时钟注入（测试用；默认 Date.now）
 * @param {(ms: number) => Promise<void>} [options.sleep] - sleep 注入（测试用）
 */
export function createWechatIlinkInbound(options = {}) {
  const { config, bus, store = null, fallbackTargets = [], logger = null, identity = null } = options
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const client = createIlinkClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetchImpl: options.fetchImpl,
  })
  const breaker = createBreaker({
    threshold: config.breakerThreshold,
    windowMs: config.breakerWindowMs,
    openMs: config.breakerOpenMs,
    now: options.now,
  })

  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:wechat]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:wechat]', message) } catch { /* 控制台不可用不致命 */ }
  }

  let running = false
  let disabled = false // 会话过期后置位：轮询停 + 发送拒（需人工重新扫码）
  let loopPromise = null
  let currentAbort = null
  let syncBuf = String(store?.get(SYNC_BUF_KEY, '') ?? '')

  function ctxKey(uid) {
    return `${CTX_PREFIX}${uid}`
  }

  /** 会话过期善后：清缓存态 + 凭证，停用通道（需人工重新扫码）。 */
  function sessionExpired(detail) {
    warn(`iLink 会话过期（${detail}）：已清空游标/context_token/凭证并停用通道，请重新执行 node scripts/wechat-login.mjs 扫码登录`)
    try {
      for (const key of store?.keys(CTX_PREFIX) ?? []) store.delete(key)
      store?.delete(SYNC_BUF_KEY)
      store?.delete(ACCOUNT_KEY)
    } catch { /* 清理失败不致命 */ }
    syncBuf = ''
    running = false
    disabled = true
  }

  /** 单条入站消息：先学 context_token、复位熔断，再投 bus（白名单/去重在 bus 侧）。 */
  function handleInboundMsg(msg) {
    const from = String(msg?.from_user_id ?? '').trim()
    if (from === '' || from === config.accountId) return
    breaker.reset() // 任一入站消息复位熔断（新消息即解锁配额）
    const contextToken = String(msg.context_token ?? '').trim()
    if (contextToken !== '') {
      try { store?.set(ctxKey(from), contextToken) } catch { /* 落盘失败不致命 */ }
    }
    const text = extractIlinkText(msg.item_list)
    if (text === '') return // 非文本（图片/语音/视频）暂不支持，静默忽略
    const rawId = String(msg.message_id ?? '').trim() || String(msg.client_id ?? '').trim()
    const messageId = rawId !== '' ? `wx:${rawId}` : `wx:${from}:${hash6(text)}`
    // v0.7：accept 返回值消费——拒绝/命令回执不再已读不回
    const result = bus.accept({ channel: 'wechat', userId: from, chatId: from, messageId, text })
    if (result?.reply !== undefined) {
      sendTextInternal(from, String(result.reply)).catch((error) => {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
      })
    }
  }

  async function pollLoop() {
    let failures = 0
    while (running) {
      const controller = new AbortController()
      currentAbort = controller
      try {
        const response = await client.getUpdates(syncBuf, {
          timeoutMs: config.longPollTimeoutMs,
          signal: controller.signal,
        })
        const verdict = classifyIlinkResponse(response)
        if (!verdict.ok) {
          if (verdict.kind === 'session-expired') {
            sessionExpired(`ret=${verdict.ret} errcode=${verdict.errcode} errmsg=${verdict.errmsg}`)
            return
          }
          failures += 1
          const backoff = failures >= 3
          warn(`getupdates 失败 ret=${verdict.ret} errcode=${verdict.errcode} errmsg=${verdict.errmsg}（第 ${failures} 次，${backoff ? '退避' : '重试'}）`)
          if (backoff) failures = 0
          await sleep(backoff ? config.backoffDelayMs : config.retryDelayMs)
          continue
        }
        failures = 0
        const nextBuf = String(response?.get_updates_buf ?? '')
        if (nextBuf !== '' && nextBuf !== syncBuf) {
          syncBuf = nextBuf
          try { store?.set(SYNC_BUF_KEY, syncBuf) } catch { /* 落盘失败不致命 */ }
        }
        const msgs = Array.isArray(response?.msgs) ? response.msgs : []
        for (const msg of msgs) {
          try { handleInboundMsg(msg) } catch (error) {
            warn(`入站消息处理异常: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        if (!running) break // stop() 打断在途长轮询
        failures += 1
        const backoff = failures >= 3
        warn(`轮询异常（第 ${failures} 次）: ${error instanceof Error ? error.message : String(error)}`)
        if (backoff) failures = 0
        await sleep(backoff ? config.backoffDelayMs : config.retryDelayMs)
      } finally {
        currentAbort = null
      }
    }
  }

  /**
   * 发送单块：-14/伪装 -2 → 剥 context_token 重试一次（不计熔断）；真限流 → 熔断计数。
   * @throws {Error} 发送定性失败（调用方决定降级）
   */
  async function sendChunk(chatId, chunk) {
    if (disabled) {
      throw new Error('通道已停用（会话过期）：请重新执行 node scripts/wechat-login.mjs 扫码登录')
    }
    if (breaker.isOpen()) {
      throw new Error(`iLink 熔断开路中（剩余 ${breaker.remainingMs()}ms）：稍后重试或先给机器人发条消息解锁`)
    }
    let contextToken = String(store?.get(ctxKey(chatId), '') ?? '')
    let retriedTokenless = false
    for (;;) {
      const response = await client.sendMessage({
        to: chatId,
        text: chunk,
        contextToken,
        clientId: `dsh-notifier-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      })
      const verdict = classifyIlinkResponse(response)
      if (verdict.ok) {
        breaker.reset()
        return
      }
      if (verdict.kind === 'session-expired') {
        // context_token 过期伪装成限流/过期：剥 token 重试一次再定性（不计熔断）
        if (!retriedTokenless && contextToken !== '') {
          retriedTokenless = true
          contextToken = ''
          try { store?.delete(ctxKey(chatId)) } catch { /* 清理失败不致命 */ }
          warn(`context_token 已过期（ret=${verdict.ret}）：剥除后重试一次（不计熔断）`)
          continue
        }
        breaker.trip()
        throw new Error(`iLink 会话过期（ret=${verdict.ret} errcode=${verdict.errcode}）：需重新扫码登录`)
      }
      if (verdict.kind === 'rate-limited') {
        breaker.trip()
        throw new Error(`iLink 限流（ret=${verdict.ret} errcode=${verdict.errcode} errmsg=${verdict.errmsg}）`)
      }
      throw new Error(`iLink sendmessage 失败 ret=${verdict.ret} errcode=${verdict.errcode} errmsg=${verdict.errmsg}`)
    }
  }

  /** 分块发送文本；任一块失败即返回 false（已发块不撤回）。 */
  async function sendTextInternal(chatId, text) {
    const content = String(text ?? '').trim()
    if (content === '') return true
    const size = config.chunkSize
    const chunks = []
    for (let i = 0; i < content.length; i += size) chunks.push(content.slice(i, i + size))
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) await sleep(config.sendChunkDelayMs) // 块间降密度，防主动消息限频
      await sendChunk(chatId, chunks[i])
    }
    return true
  }

  return {
    channel: 'wechat',
    capabilities: { buttons: false },

    /** 启动轮询循环（幂等；会话过期停用后不复活——需重新登录换新实例）。 */
    start() {
      if (running || loopPromise !== null || disabled) return
      running = true
      loopPromise = pollLoop().finally(() => {
        loopPromise = null
      })
    },

    /** 停止：打断在途长轮询并等循环退出（幂等）。 */
    async stop() {
      running = false
      try { currentAbort?.abort() } catch { /* abort 不致命 */ }
      try { await loopPromise } catch { /* 循环异常已在内部吸收 */ }
      loopPromise = null
    },

    /** 审批推送目标（v0.7 三级解析）：绑定成员 → notifyUsers → 全局回落（仅绑定表整体空）。 */
    notifyTargets() {
      return resolveNotifyTargets({
        identity,
        channel: 'wechat',
        configTargets: Array.isArray(config.notifyUsers) ? config.notifyUsers.map(String) : [],
        fallbackTargets,
      })
    },

    /** 推审批文本通知（无按钮，回复 1/2 裁决）；失败 null 降级纯通知。 */
    async sendApprovalCard({ chatId, title, content }) {
      const text = `${title}\n${content}\n\n回复 1 批准 / 2 拒绝`
      try {
        return (await sendTextInternal(chatId, text)) ? { messageId: `wx:${hash6(text)}` } : null
      } catch (error) {
        warn(`审批通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 推送不可编辑：补发一条结果回执（尽力而为）。 */
    async editResolved(target, text) {
      if (target?.chatId === undefined || String(target.chatId) === '') return
      try {
        await sendTextInternal(String(target.chatId), text)
      } catch (error) {
        warn(`审批结果回执失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 定向推送文本（命令回执）。 */
    async sendText(chatId, text) {
      try {
        return await sendTextInternal(chatId, text)
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}

export { ACCOUNT_KEY }
