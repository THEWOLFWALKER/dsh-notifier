// dsh-notifier WeChat iLink compatibility core (owned by the channel provider slice).
// 微信个人号 iLink Bot 双向入站（v0.3.0 阶段 4）：getupdates 长轮询 + sendmessage 回执。
// 协议细节全部在 _ilink-api.mjs（Hermes weixin.py MIT 移植）；本文件只做通道编排：
//  - 轮询节奏：连续失败 <3 等待 2s，≥3 退避 30s 后计数清零（weixin.py 行 110-112）
//  - 游标 wechat:sync_buf 必须持久化（丢失/回退会重复收消息）
//  - context_token：入站消息永远最新（收到即缓存 wechat:ctx:<uid>），发送回显最新值。
//    v0.8.7：写入前做形状校验（≤512 字符、无空白/控制字符）+ 键族 256 上限淘汰最旧（宪法#4）
//  - 发送分块（默认 2000 码点/块，块间 2s 降密度；码点切分不产生孤立代理项，G-03）
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
} from '../../inbound/_ilink-api.mjs'
import { createBreaker } from '../../inbound/_breaker.mjs'
import { createThrottledWarn } from '../../inbound/_bounded.mjs'
import { resolveNotifyTargets } from '../../inbound/target-guard.mjs'
import { splitByCodePoints } from '../../inbound/segment.mjs'
import { DEFAULT_INBOUND_MEDIA_TIMEOUT_MS, MAX_INBOUND_IMAGE_BYTES } from '../../inbound/message.mjs'
import { normalizeInboundMessage, normalizeUpdateBatch, boundedCursor, validAccountId } from './protocol.mjs'

const SYNC_BUF_KEY = 'wechat:sync_buf'
const ACCOUNT_KEY = 'wechat:account'
const CTX_PREFIX = 'wechat:ctx:'
// v0.8.7 P1-7（宪法#4 状态必须有界）：wechat:ctx:<uid> 此前每个发过消息的 uid 永久占一条
// state 键，唯一归宿是 sessionExpired 全清 —— 群/陌生人来一条消息就留一条，state.json
// 无界膨胀。上限 256 个 uid（真实场景：审批目标 + 若干成员，两个数量级余量），
// 超限从最旧一端淘汰。淘汰安全：ctx 只是「发送时回显最新 context_token」的缓存，
// 缺失走既有「不带 token 发 → -14/伪装 -2 → 剥 token 重试」路径，功能不丢。
const CTX_MAX_ENTRIES = 256
// D-7 廉价半边：context_token 由对端消息携带，陌生人可塞任意长/带控制字符的串进 state
// （膨胀 + 污染日志/后续 JSON 载荷）。真实 token 是短的可见字符串；超长或含空白/控制
// 字符一律拒收并 warn（宪法#3 不静默），本条消息其余处理照常。
const CTX_TOKEN_MAX_LEN = 512

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
  const accountId = validAccountId(cfg.accountId ?? cred.accountId)
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
      // G-12：轮询假死看门狗对账周期（默认 15s；在飞 getupdates 超 longPollTimeoutMs+
      // 一个对账周期仍无返回 → 判假死强制 abort 断开重试）
      watchdogIntervalMs: clampInt(cfg.watchdogIntervalMs, 15000, 5, 300000),
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
 * @param {ReturnType<typeof import('../../inbound/bus.mjs').createInboundBus>} options.bus
 * @param {import('../../inbound/store.mjs').store} [options.store] - 游标 / context_token / 凭证持久化
 * @param {string[]} [options.fallbackTargets] - 未配置 notifyUsers 时的推送目标（全局白名单回落）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 * @param {() => number} [options.now] - 时钟注入（测试用；默认 Date.now）
 * @param {(ms: number) => Promise<void>} [options.sleep] - sleep 注入（测试用）
 */
export function createWechatIlinkInbound(options = {}) {
  const { config, bus, store = null, fallbackTargets = [], logger = null, identity = null } = options
  // 新 provider slice 通过 accountScoped 开启账号命名空间；旧入口默认保留历史键名。
  const accountScoped = options.accountScoped === true
  const accountPrefix = accountScoped ? `wechat:${String(config?.accountId ?? '').trim()}:` : 'wechat:'
  const syncBufKey = accountScoped ? `${accountPrefix}sync_buf` : SYNC_BUF_KEY
  const accountKey = accountScoped ? `${accountPrefix}account` : ACCOUNT_KEY
  const contextKey = (uid) => accountScoped ? `${accountPrefix}ctx:${uid}` : `${CTX_PREFIX}${uid}`
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // G-12：看门狗对账周期（resolveWechatInboundConfig 已归一；直接构造时兜底默认 15s）
  const watchdogIntervalMs = clampInt(config.watchdogIntervalMs, 15000, 5, 300000)
  const imageDownloadTimeoutMs = clampInt(options.imageDownloadTimeoutMs, DEFAULT_INBOUND_MEDIA_TIMEOUT_MS, 1000, 60000)
  const imageDownloadMaxBytes = Math.min(MAX_INBOUND_IMAGE_BYTES,
    Math.max(1, Number(options.imageDownloadMaxBytes) || MAX_INBOUND_IMAGE_BYTES))
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
  // G-12 假死看门狗状态：pollStartedAt 记当前在飞 getupdates 的发起时刻（null=无在飞）；
  // watchdogKicks 计连续 kick 次数（任一次正常返回即清零——连续增长说明通道真死）。
  let pollStartedAt = null
  let watchdogTimer = null
  let watchdogKicks = 0
  let syncBuf = boundedCursor(store?.get(syncBufKey, ''))

  function ctxKey(uid) {
    return contextKey(uid)
  }

  // 淘汰/拒收都是高频路径（每条入站消息一次）：warn 走 60s 节流并报累计次数，
  // 既不静默（宪法#3）也不刷屏。
  const warnCtxEvicted = createThrottledWarn(warn, { now: options.now })
  const warnCtxRejected = createThrottledWarn(warn, { now: options.now })

  /**
   * D-7 廉价半边：context_token 形状校验。真实 token 是短的单行可见字符串；
   * 超长（>512）或含空白/控制字符视为异常载荷，拒收不落盘。
   */
  function isSaneContextToken(token) {
    if (token.length > CTX_TOKEN_MAX_LEN) return false
    return !/[\s\u0000-\u001f\u007f]/.test(token)
  }

  /**
   * 学习 context_token：形状校验 → 有界写入（键族 256 上限，超限淘汰最旧的先见 uid）。
   * 任何一步失败都只 warn：ctx 缺失只是回退到「不带 token 发 → 剥 token 重试」路径。
   */
  function rememberContextToken(uid, contextToken) {
    if (!isSaneContextToken(contextToken)) {
      warnCtxRejected((count) => `context_token 形状异常已拒收（长度 ${contextToken.length}，上限 ${CTX_TOKEN_MAX_LEN}，不接受空白/控制字符）：来自 ${uid} 的本条消息照常处理，发送将走无 token 重试路径${count > 1 ? `（近期累计 ${count} 次）` : ''}`)
      return
    }
    if (store === null) return
    const key = ctxKey(uid)
    try {
      const existing = store.get(key)
      if (existing === contextToken) return // 值未变：不写盘（省一次全量 save）
      if (existing === undefined) {
        // 新 uid 才可能撑破上限；键族按首见顺序淘汰（Object 键序 = 插入序，跨重启保序）。
        // 存量超量（上限调小 / 旧版本遗留）在此一并收敛。
        // store 无 keys()（精简 mock / 老实现）：跳过淘汰但照常写入——宁可无界也不丢功能，
        // 这条降级路径由测试钉死（不静默失败）。
        const keys = typeof store.keys === 'function' ? store.keys(accountScoped ? `${accountPrefix}ctx:` : CTX_PREFIX) : null
        if (Array.isArray(keys)) {
          let overflow = keys.length + 1 - CTX_MAX_ENTRIES
          let evicted = 0
          for (const stale of keys) {
            if (overflow <= 0) break
            if (stale === key) continue
            store.delete(stale)
            evicted += 1
            overflow -= 1
          }
          if (evicted > 0) {
            warnCtxEvicted((count) => `wechat:ctx 键族达上限 ${CTX_MAX_ENTRIES}，已淘汰 ${evicted} 个最旧会话的 context_token（缓存性质，受影响会话下次发送走无 token 重试）${count > 1 ? `（近期累计 ${count} 次）` : ''}`)
          }
        }
      }
      store.set(key, contextToken)
    } catch { /* 落盘/清扫失败不致命 */ }
  }

  /** Optional media bridge is isolated from control delivery and receives strict resource bounds. */
  function downloadImageBestEffort(envelope) {
    const download = options.mediaAdapter?.downloadInboundImage
    if (typeof download !== 'function') return
    const controller = new AbortController()
    let timeoutId = null
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject(new Error(`图片下载超时（${imageDownloadTimeoutMs}ms）`))
      }, imageDownloadTimeoutMs)
    })
    void Promise.race([
      Promise.resolve().then(() => download(envelope, {
        signal: controller.signal,
        maxBytes: imageDownloadMaxBytes,
        timeoutMs: imageDownloadTimeoutMs,
      })),
      timeout,
    ]).then((result) => {
      if (Number(result?.size) > imageDownloadMaxBytes) {
        warn(`图片下载结果超过上限 ${imageDownloadMaxBytes} bytes，已丢弃结果`)
      }
    }).catch((error) => {
      warn(`图片下载失败（文字路径已继续）：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { if (timeoutId !== null) clearTimeout(timeoutId) })
  }

  /** 会话过期善后：清缓存态 + 凭证，停用通道（需人工重新扫码）。 */
  function sessionExpired(detail) {
    warn(`iLink 会话过期（${detail}）：已清空游标/context_token/凭证并停用通道，请重新执行 node scripts/wechat-login.mjs 扫码登录`)
    try {
      for (const key of store?.keys(accountScoped ? `${accountPrefix}ctx:` : CTX_PREFIX) ?? []) store.delete(key)
      store?.delete(syncBufKey)
      store?.delete(accountKey)
    } catch { /* 清理失败不致命 */ }
    syncBuf = ''
    running = false
    disabled = true
    try { options.onSessionExpired?.(detail) } catch { /* 回调失败不影响停用 */ }
  }

  /** 单条入站消息：先学 context_token、复位熔断，再投 bus（白名单/去重在 bus 侧）。 */
  function handleInboundMsg(msg) {
    const normalizedRaw = msg?.channel === 'wechat' && typeof msg?.userId === 'string'
      ? msg
      : normalizeInboundMessage(msg, { accountId: config.accountId })
    const normalized = !accountScoped && normalizedRaw?.messageId?.startsWith(`wx:${config.accountId}:`)
      ? { ...normalizedRaw, messageId: normalizedRaw.messageId.slice(`wx:${config.accountId}:`.length).replace(/^/, 'wx:') }
      : normalizedRaw
    const from = String(normalized?.userId ?? '').trim()
    if (from === '' || from === config.accountId) return
    breaker.reset() // 任一入站消息复位熔断（新消息即解锁配额）
    const contextToken = String(normalized.contextToken ?? '').trim()
    if (contextToken !== '') rememberContextToken(from, contextToken)
    if (normalized.contextTokenRejected === true) {
      warnCtxRejected((count) => `context_token 形状异常已拒收（长度或字符不符合限制，上限 ${CTX_TOKEN_MAX_LEN}，不接受空白/控制字符）：来自 ${from} 的本条消息照常处理，发送将走无 token 重试路径${count > 1 ? `（近期累计 ${count} 次）` : ''}`)
    }
    const text = String(normalized.text ?? '')
    const rawMessageId = String(normalized.messageId ?? '')
    // G-46：hash6 兜底键标记 synthetic——bus 去重走 60s 短窗（原生 msgId 才配 24h）。
    const messageId = rawMessageId !== '' ? rawMessageId : `wx:${from}:${hash6(text)}`
    const messageIdSynthetic = rawMessageId === ''
    // v0.7：accept 返回值消费——拒绝/命令回执不再已读不回
    // context_token is transport state, never a Control Core/audit field.
    const envelope = { ...normalized, channel: 'wechat', accountId: String(config?.accountId ?? ''), userId: from, chatId: from, messageId, messageIdSynthetic, text }
    delete envelope.contextToken
    delete envelope.contextTokenRejected
    const result = bus.accept(envelope)
    if (result?.reply !== undefined) {
      sendTextInternal(from, String(result.reply)).catch((error) => {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
      })
    }
    // 图片下载是可选能力；先把消息交给 Control Core，再尽力下载。
    // 下载失败/超时只告警，不阻断文字或控制命令路径。
    if (normalized.image !== undefined) downloadImageBestEffort(normalized)
  }

  /**
   * G-12：轮询假死看门狗。长轮询挂死（TCP 活着但服务端永不回包）不产生任何异常——
   * 失败计数（只覆盖显式异常）与熔断（只覆盖 sendmessage 限流）都不触发，通道静默失效
   * 用户却以为插件在线。本层对账：在飞 getupdates 超过 longPollTimeoutMs + 一个对账
   * 周期仍未返回，即 abort 强制断开，让轮询循环保守的失败计数路径重建连接。
   * 对齐 dsh-im supervisor 思路（周期对账 + 防重入：仅在飞且超期才动手）。
   */
  function watchdogTick() {
    if (!running || currentAbort === null || pollStartedAt === null) return
    const nowMs = (options.now ?? Date.now)()
    const inflightMs = nowMs - pollStartedAt
    const deadlineMs = config.longPollTimeoutMs + Math.max(5000, watchdogIntervalMs)
    if (inflightMs <= deadlineMs) return
    watchdogKicks += 1
    warn(`轮询假死检测：getupdates 在飞 ${Math.round(inflightMs / 1000)}s 未归（长轮询上限 ${Math.round(config.longPollTimeoutMs / 1000)}s，连续第 ${watchdogKicks} 次），强制断开重试`)
    try { currentAbort.abort() } catch { /* 已完成不致命 */ }
  }

  async function pollLoop() {
    let failures = 0
    while (running) {
      const controller = new AbortController()
      currentAbort = controller
      pollStartedAt = (options.now ?? Date.now)() // G-12：在飞起点（finally 清）
      try {
        const response = await client.getUpdates(syncBuf, {
          timeoutMs: config.longPollTimeoutMs,
          signal: controller.signal,
        })
        watchdogKicks = 0 // 正常返回即证通道未死，连续 kick 计数清零
        const batch = normalizeUpdateBatch(response, { accountId: config.accountId })
        if (!batch.ok) {
          const verdict = batch
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
        if (batch.cursorRejected) warn('getupdates 返回超长或非法游标，已拒收并保留旧游标（上限 4096）')
        // 至少一次投递语义：先处理整批，再推进游标；游标只在本批全部消息成功处理后
        // 才落新值。只要任一消息处理抛异常——例如一条应执行的控制命令未被 bus 接受——
        // 就保留旧游标，让下一轮从同一点重投本批：未接受的控制命令因此重试、绝不永久
        // 跳过；已消费的消息由 bus 按 messageId 去重，重投也不会重复执行。
        let fullyConsumed = true
        for (const msg of batch.messages) {
          try { handleInboundMsg(msg) } catch (error) {
            fullyConsumed = false
            warn(`入站消息处理异常，本批游标不推进（至少一次投递，稍后将重投整批）: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (!fullyConsumed) continue // 保留旧游标：让 provider 重投本批，不丢未接受的控制命令
        const nextBuf = batch.cursor
        if (nextBuf !== '' && nextBuf !== syncBuf) {
          syncBuf = nextBuf
          try { store?.set(syncBufKey, syncBuf) } catch { /* 落盘失败不致命 */ }
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
        pollStartedAt = null // G-12：在飞结束（正常/异常/打断都算）
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

  /** 分块发送文本；任一块失败即返回 false（已发块不撤回）。
   *  G-03：块按 Unicode 码点切（splitByCodePoints）——旧 content.slice 是 UTF-16 码元
   *  语义，跨块的 emoji/生僻字会被切成孤立代理项，微信端显示乱码或拒收。ZWJ 序列
   *  仍可能在块边界拆成多个完整码点（显示为两个符号，无非法序列），属可接受降级。 */
  async function sendTextInternal(chatId, text) {
    const content = String(text ?? '').trim()
    if (content === '') return true
    const chunks = splitByCodePoints(content, config.chunkSize)
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) await sleep(config.sendChunkDelayMs) // 块间降密度，防主动消息限频
      await sendChunk(chatId, chunks[i])
    }
    return true
  }

  return {
    channel: 'wechat',
    accountId: String(config?.accountId ?? ''),
    capabilities: { buttons: false },

    /** 连接状态供本地管理台/上层 registry 展示；不包含 token 或 context。 */
    status() {
      return Object.freeze({
        state: disabled ? 'qr-required' : running ? 'connected' : 'disconnected',
        accountId: String(config.accountId ?? ''),
        qrRequired: disabled,
      })
    },

    /** 启动轮询循环（幂等；会话过期停用后不复活——需重新登录换新实例）。 */
    start() {
      if (running || loopPromise !== null || disabled) return
      running = true
      // G-12：假死看门狗与轮询循环同生命周期（unref：不独自挂住进程）
      watchdogTimer = setInterval(watchdogTick, watchdogIntervalMs)
      watchdogTimer.unref?.()
      loopPromise = pollLoop().finally(() => {
        loopPromise = null
        if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null }
      })
    },

    /** 停止：打断在途长轮询并等循环退出（幂等）。 */
    async stop() {
      running = false
      if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null }
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
