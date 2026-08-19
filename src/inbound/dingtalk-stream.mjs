// dsh-notifier inbound/dingtalk-stream.mjs
// 钉钉企业内部机器人 Stream 入站（v0.3.1）：官方 Stream 长连接裸协议，零 SDK 依赖
//（结构照抄 qq-gw.mjs：resolve 函数 / 契约方法 / start-stop / 重连退避 / notifyTargets /
//  sendApprovalCard 编号回复文案；凭证回退与熔断用法照抄 wechat-ilink.mjs）。
// 协议事实（逐字段对照 dingtalk-stream-sdk-nodejs client.ts 核对）：
//  1. token：GET {oapi}/gettoken?appkey=&appsecret= → { errcode:0, access_token, expires_in }
//  2. 网关：POST {api}/v1.0/gateway/connections/open（Content-Type/Accept 均 application/json），
//     body { clientId, clientSecret, subscriptions:[{type:'CALLBACK',topic:'/v1.0/im/bot/messages/get'}],
//     uesrAgent } → { endpoint, ticket }。uesrAgent 是官方 SDK 的拼写错误字段名，服务端认的
//     就是它——照抄勿改。
//  3. WS：new WebSocket(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)；帧为 JSON 字符串
//     { headers, data, path, messageId }，data 本身又是 JSON 字符串（需二次 parse）。
//  4. ack：每条服务端消息回帧 { code:200, headers:{contentType:'application/json',
//     requestId:messageId}, messageId, data:'ack' }；未 ack 服务端 60s 重推
//     （msgId 去重 Map + 60s 窗口吸收；bus 侧 24h 持久去重再兜一层）。
//  5. 心跳：WS 协议层 ping/pong——服务端 8s 发 ping、原生 WebSocket 自动回 pong；本实现
//     不发自定义心跳帧（原生 WebSocket 客户端无法主动发 ping，与官方 SDK keepAlive:false
//     同态），onclose 即退避重连。
//  6. 业务消息：{ conversationId, msgId, senderStaffId, senderNick, sessionWebhook,
//     sessionWebhookExpiredTime, robotCode, msgtype, text:{content} }；非 msgtype==='text'
//     静默忽略；content 首尾 trim。
//  7. 被动回复：POST sessionWebhook，头 { content-type, x-acs-dingtalk-access-token }，
//     body { msgparam: JSON.stringify({content}), msgKey:'sampleText' }；webhook 到期
//     （毫秒时间戳 < now）不回复、告警，改走主动推送兜底。
//  8. 主动推送：POST {api}/v1.0/robot/oToMessages/batchSend?robot_code=（body 为数组）；
//     robotCode 从首条入站消息学习（store 'dingtalk:robot-code'，跨重启恢复）；未学到前
//     主动推送失败告警；推送过 createBreaker（默认参数），任一入站消息 breaker.reset()。
//  9. token 到期前 60s 主动刷新；业务返回 errcode!==0 → token 作废重取后重试一次。
// 10. 重连：onclose/onerror 后 base*2^n + [0,1000) 抖动，封顶 60s（可注入 base/cap）。
// 军规：任何异常只 warn 不抛；stop() 幂等且清干净全部定时器/连接；错误文案不含 appSecret。

import { createHash } from 'node:crypto'
import { createTokenManager } from '../adapters/_tokens.mjs'
import { createBreaker } from './_breaker.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const DEFAULT_API_BASE = 'https://api.dingtalk.com'
const DEFAULT_OAPI_BASE = 'https://oapi.dingtalk.com'
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
const ROBOT_CODE_KEY = 'dingtalk:robot-code'
const MSG_DEDUP_WINDOW_MS = 60000 // 服务端未 ack 的重推间隔：60s 窗口内同 msgId 吸收

/** content → 6 位十六进制摘要（合成 messageId 用，与 wechat-ilink 同款）。 */
function hash6(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 6)
}

/**
 * 解析并校验 inbound.dingtalk 配置。
 * @param {object} raw - inbound.dingtalk 原始配置
 * @param {{ credentials?: object }} [options] - 扫码落盘凭证回退（store 'dingtalk:account'，
 *   形如 { appKey, appSecret }；config 显式配置优先）
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function resolveDingtalkInboundConfig(raw, { credentials } = {}) {
  const cfg = (raw !== null && typeof raw === 'object') ? raw : {}
  const creds = (credentials !== null && typeof credentials === 'object') ? credentials : {}
  const appKey = String(cfg.appKey ?? creds.appKey ?? '').trim()
  const appSecret = String(cfg.appSecret ?? creds.appSecret ?? '').trim()
  if (appKey === '' || appSecret === '') {
    return {
      ok: false,
      reason: `钉钉 inbound 需要 appKey 与 appSecret（当前 appKey ${appKey !== '' ? '已配置' : '缺失'}，appSecret ${appSecret !== '' ? '已配置' : '缺失'}）。请在钉钉开放平台开发者后台创建企业内部应用并获取凭证，或执行 node scripts/channel-login.mjs dingtalk 官方扫码自动写入`,
    }
  }
  const notifyUsers = (Array.isArray(cfg.notifyUsers) ? cfg.notifyUsers : [])
    .map((id) => String(id).trim()).filter((id) => id !== '')
  return {
    ok: true,
    config: {
      appKey,
      appSecret,
      apiBase: (String(cfg.apiBase ?? '').trim() || DEFAULT_API_BASE).replace(/\/+$/, ''),
      oapiBase: (String(cfg.oapiBase ?? '').trim() || DEFAULT_OAPI_BASE).replace(/\/+$/, ''),
      notifyUsers,
      timeoutMs: Math.min(60000, Math.max(1000, Number(cfg.timeoutMs) || 10000)),
    },
  }
}

/**
 * 创建钉钉 Stream 入站通道（统一契约；buttons=false，审批走编号回复）。
 * @param {object} options
 * @param {ReturnType<typeof resolveDingtalkInboundConfig>['config']} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {import('./store.mjs').store} [options.store] - robotCode 学习持久化
 * @param {string[]} [options.fallbackTargets] - 未配置 notifyUsers 时的推送目标（全局白名单回落）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 * @param {typeof WebSocket} [options.webSocketImpl] - WebSocket 构造器注入（测试用；默认 globalThis.WebSocket）
 * @param {number} [options.reconnectBaseMs=1000] - 重连退避基数
 * @param {number} [options.reconnectCapMs=60000] - 重连退避上限
 */
export function createDingtalkInbound(options = {}) {
  const { config, bus, store = null, fallbackTargets = [], logger = null, identity = null } = options
  // 防御性兜底：绕过 resolveDingtalkInboundConfig 直接构造时也保证两个 base 可用
  const apiBase = (String(config?.apiBase ?? '').trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
  const oapiBase = (String(config?.oapiBase ?? '').trim() || DEFAULT_OAPI_BASE).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket
  const reconnectBaseMs = Math.max(1, Number(options.reconnectBaseMs) || 1000)
  const reconnectCapMs = Math.max(reconnectBaseMs, Number(options.reconnectCapMs) || 60000)
  // 抖动 [0,1000)：默认基数 1000 → 恰为协议语义；注入短退避时同步收缩（测试零长等）
  const jitterCapMs = Math.min(1000, reconnectBaseMs)

  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:dingtalk]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:dingtalk]', message) } catch { /* 控制台不可用不致命 */ }
  }

  // 主动推送熔断器（默认参数：阈值 3 / 窗口 60s / 开路 15s）；任一入站消息 reset
  const breaker = createBreaker()

  // token 管理器：缓存 → 到期前 60s 主动刷新（refreshMarginMs 默认值即 60000）→ 失效作废
  const tokens = createTokenManager(async () => {
    if (fetchImpl === undefined) throw new Error('当前运行时无 fetch，钉钉 inbound 不可用')
    const query = new URLSearchParams({ appkey: String(config.appKey), appsecret: String(config.appSecret) })
    const response = await fetchImpl(`${oapiBase}/gettoken?${query.toString()}`)
    const payload = await response.json().catch(() => null)
    if (Number(payload?.errcode) !== 0 || typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new Error(`获取钉钉 access_token 失败（HTTP ${response.status}${payload?.errcode !== undefined ? ` errcode ${payload.errcode}` : ''}）：请检查 appKey/appSecret`)
    }
    return { token: payload.access_token, expiresInMs: (Number(payload.expires_in) || 7200) * 1000 }
  })

  // 运行态
  let running = false
  let startPromise = null
  let stopRequested = false
  let ws = null
  let reconnectAttempts = 0
  let reconnectTimer = null
  let robotCode = String(store?.get(ROBOT_CODE_KEY, '') ?? '') // 首条入站消息学习（跨重启恢复）
  // chatId → 最近 sessionWebhook（被动回复专用，过期即弃）/ 最近发言人（batchSend 要 staffId）
  const sessionWebhooks = new Map()
  const chatSenders = new Map()
  const seenMsgIds = new Map() // msgId → 首见时间戳（60s 重推吸收窗口）

  function scheduleReconnect() {
    if (stopRequested) return
    if (reconnectTimer !== null) return
    const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, reconnectCapMs)
      + Math.floor(Math.random() * jitterCapMs)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect().catch((error) => {
        warn(`重连失败: ${error instanceof Error ? error.message : String(error)}`)
        scheduleReconnect()
      })
    }, delay)
  }

  function cleanupSocket() {
    if (ws !== null) {
      try { ws.removeAllListeners?.() } catch { /* fake/运行时差异 */ }
      try { ws.close() } catch { /* 已关闭 */ }
      ws = null
    }
  }

  /** 打开 Stream 网关（clientId/clientSecret 换 endpoint+ticket；此接口不走 access_token）。 */
  async function openGateway() {
    const response = await fetchImpl(`${apiBase}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: config.appKey,
        clientSecret: config.appSecret,
        subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
        uesrAgent: 'dsh-notifier', // 官方 SDK 的拼写错误字段名，服务端认它，照抄勿改
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok
      || typeof payload?.endpoint !== 'string' || payload.endpoint === ''
      || typeof payload?.ticket !== 'string' || payload.ticket === '') {
      throw new Error(`打开钉钉 Stream 网关失败（HTTP ${response.status}${payload?.code !== undefined ? ` code ${payload.code}` : ''}）`)
    }
    return payload
  }

  function sendFrame(payload) {
    if (ws === null || ws.readyState !== 1) return false
    try { ws.send(JSON.stringify(payload)); return true } catch { return false }
  }

  /** 每条服务端消息都回执（未 ack 服务端 60s 重推）。 */
  function ackFrame(messageId) {
    if (messageId === '') return
    sendFrame({
      code: 200,
      headers: { contentType: 'application/json', requestId: messageId },
      messageId,
      data: 'ack',
    })
  }

  /** msgId 去重：60s 窗口内同 msgId 视为服务端重推，吸收不二次投递（惰性清扫防膨胀）。 */
  function isFreshMsgId(msgId) {
    const now = Date.now()
    if (seenMsgIds.size > 1024) {
      for (const [id, at] of seenMsgIds) {
        if (now - at >= MSG_DEDUP_WINDOW_MS) seenMsgIds.delete(id)
      }
    }
    if (seenMsgIds.has(msgId)) return false
    seenMsgIds.set(msgId, now)
    return true
  }

  /** 业务消息（data 二次 parse 后）：学习态 → 去重 → 复位熔断 → 投 bus。 */
  function handleBotMessage(msg) {
    if (msg === null || typeof msg !== 'object') return
    const chatId = String(msg.conversationId ?? '')
    const msgId = String(msg.msgId ?? '')
    const userId = String(msg.senderStaffId ?? '')
    if (chatId === '' || msgId === '' || userId === '') return
    if (!isFreshMsgId(msgId)) return
    breaker.reset() // 任一入站消息复位熔断（新消息即解锁配额）
    const code = String(msg.robotCode ?? '')
    if (code !== '' && code !== robotCode) {
      robotCode = code
      try { store?.set(ROBOT_CODE_KEY, robotCode) } catch { /* 落盘失败不致命 */ }
    }
    const webhook = String(msg.sessionWebhook ?? '')
    if (webhook !== '') {
      sessionWebhooks.set(chatId, { url: webhook, expiredAt: Number(msg.sessionWebhookExpiredTime) || 0 })
    }
    chatSenders.set(chatId, userId) // 主动推送兜底目标（batchSend 要 staffId 而非 conversationId）
    if (String(msg.msgtype ?? '') !== 'text') return // 图片/富文本等暂不支持，静默忽略
    const text = String(msg.text?.content ?? '').trim()
    if (text === '') return
    // v0.7：conversationType 透传（'1' 单聊 / '2' 群聊，/pair 私聊判定）；
    // accept 返回值消费——拒绝/命令回执不再已读不回
    const result = bus.accept({
      channel: 'dingtalk',
      userId,
      chatId,
      chatType: String(msg.conversationType ?? ''),
      messageId: `dt:${msgId}`,
      text,
    })
    if (result?.reply !== undefined) {
      sendReply(chatId, String(result.reply)).catch((error) => {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
      })
    }
  }

  function handleFrame(raw) {
    let frame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    if (frame === null || typeof frame !== 'object') return
    ackFrame(String(frame.messageId ?? '')) // 先回执再处理：处理异常也不该挨 60s 重推
    if (frame.data === undefined || frame.data === null) return
    let data = frame.data // data 本身又是 JSON 字符串：二次 parse
    if (typeof data === 'string') {
      try { data = JSON.parse(data) } catch { return }
    }
    try { handleBotMessage(data) } catch (error) {
      warn(`入站消息处理异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function connect() {
    if (fetchImpl === undefined) throw new Error('当前运行时无 fetch，钉钉 inbound 不可用')
    const { endpoint, ticket } = await openGateway()
    if (stopRequested) return
    if (WebSocketImpl === undefined) throw new Error('当前运行时无 WebSocket（需要 Node 22+）')
    ws = new WebSocketImpl(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)
    ws.addEventListener('open', () => {
      reconnectAttempts = 0
      warn('钉钉 Stream 长连接已建立（心跳走 WS 协议层 ping/pong 自动应答，onclose 即重连）')
    })
    ws.addEventListener('message', (event) => {
      try { handleFrame(typeof event.data === 'string' ? event.data : String(event.data)) } catch (error) {
        warn(`帧处理异常: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ws.addEventListener('close', () => {
      cleanupSocket()
      scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* close 会跟着来，重连在 close 里统一调度 */ })
  }

  function errcodeOf(payload) {
    return payload !== null && typeof payload === 'object' && payload.errcode !== undefined
      ? Number(payload.errcode)
      : null
  }

  function postOnce(url, body, token) {
    return fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
    })
  }

  /**
   * 带 token 的业务 POST（被动回复/主动推送共用）：errcode!==0 → token 作废重取后重试
   * 一次；仍失败抛错（错误文案绝不含 appSecret）。
   */
  async function postJsonWithToken(url, body) {
    let token = await tokens.get()
    let response = await postOnce(url, body, token)
    let payload = await response.json().catch(() => null)
    let errcode = errcodeOf(payload)
    if (errcode !== null && errcode !== 0) {
      warn(`钉钉接口返回 errcode ${errcode}：作废 access_token 重取后重试一次`)
      tokens.invalidate()
      token = await tokens.get(true)
      response = await postOnce(url, body, token)
      payload = await response.json().catch(() => null)
      errcode = errcodeOf(payload)
    }
    if (!response.ok || (errcode !== null && errcode !== 0)) {
      const detail = String(payload?.errmsg ?? payload?.message ?? '')
      throw new Error(`钉钉接口失败（HTTP ${response.status}${errcode !== null ? ` errcode ${errcode}` : ''}${detail !== '' ? `: ${detail}` : ''}）`)
    }
    return payload
  }

  /** 被动回复：命中未过期缓存才发；无缓存/已过期返回 null（交主动推送兜底）。 */
  async function replyViaWebhook(chatId, text) {
    const cached = sessionWebhooks.get(chatId)
    if (cached === undefined) return null
    if (cached.expiredAt !== 0 && cached.expiredAt <= Date.now()) {
      sessionWebhooks.delete(chatId)
      warn(`sessionWebhook 已过期（sessionWebhookExpiredTime 到点）：会话 ${chatId} 改走主动推送兜底`)
      return null
    }
    const payload = await postJsonWithToken(cached.url, {
      msgparam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
    })
    return payload
  }

  /** 主动推送：batchSend 单元素数组；未学到 robotCode / 熔断开路时 null；失败计熔断。 */
  async function batchSend(staffId, text) {
    if (robotCode === '') {
      warn('钉钉主动推送不可用：尚未学习到 robotCode（收到首条入站消息后自动学习并落盘）')
      return null
    }
    if (breaker.isOpen()) {
      warn(`钉钉主动推送熔断开路中（剩余 ${breaker.remainingMs()}ms）：稍后重试，或先给机器人发条消息解锁`)
      return null
    }
    try {
      const url = `${apiBase}/v1.0/robot/oToMessages/batchSend?robot_code=${encodeURIComponent(robotCode)}`
      const payload = await postJsonWithToken(url, [{
        chatbotId: robotCode,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
        staffId: String(staffId),
      }])
      breaker.reset()
      const key = typeof payload?.processQueryKey === 'string' && payload.processQueryKey !== ''
        ? payload.processQueryKey
        : hash6(`${staffId}:${text}`)
      return { messageId: `dt:${key}` }
    } catch (error) {
      breaker.trip()
      throw error
    }
  }

  /**
   * 发文本：sessionWebhook 被动回复优先（按 chatId 缓存最近 webhook，过期弃用），
   * 兜底走 batchSend 主动推送（staffId 取该会话最近发言人，未学习过则视 chatId 为 staffId）。
   * @returns {Promise<{ messageId: string } | null>}
   */
  async function sendReply(chatId, text) {
    const target = String(chatId ?? '')
    const content = String(text ?? '').trim()
    if (target === '' || content === '') return null
    try {
      if (await replyViaWebhook(target, content) !== null) {
        return { messageId: `dt:${hash6(`${target}:${content}`)}` }
      }
    } catch (error) {
      warn(`sessionWebhook 回复失败，改走主动推送兜底: ${error instanceof Error ? error.message : String(error)}`)
    }
    return batchSend(chatSenders.get(target) ?? target, content)
  }

  return {
    channel: 'dingtalk',
    capabilities: { buttons: false },

    /** 启动 Stream 连接（幂等；失败中文 warn 后允许再次 start 重试）。 */
    start() {
      if (running || startPromise !== null) return
      running = true
      stopRequested = false
      startPromise = (async () => {
        try {
          await connect()
        } catch (error) {
          running = false
          startPromise = null
          const reason = error instanceof Error ? error.message : String(error)
          warn(`钉钉 inbound 启动失败（本通道不可用，不影响其他通道）: ${reason}`)
        }
      })()
    },

    /** 停止并清理全部定时器/连接（幂等、绝不弄崩宿主）。 */
    async stop() {
      stopRequested = true
      running = false
      try { await startPromise } catch { /* 启动失败不影响停止 */ }
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      cleanupSocket()
      startPromise = null
    },

    /** 审批推送目标（v0.7 三级解析）：绑定成员 → notifyUsers → 全局回落（仅绑定表整体空）。 */
    notifyTargets() {
      return resolveNotifyTargets({
        identity,
        channel: 'dingtalk',
        configTargets: Array.isArray(config?.notifyUsers) ? config.notifyUsers.map(String) : [],
        fallbackTargets,
      })
    },

    /** 推审批文本通知（无按钮，回复 1/2 裁决）；失败 null 降级纯通知。 */
    async sendApprovalCard({ chatId, title, content }) {
      const text = `${title}\n${content}\n\n回复 1 批准 / 2 拒绝`
      try {
        return await sendReply(chatId, text)
      } catch (error) {
        warn(`审批通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 消息不可编辑：以回执文本补一条结果（尽力而为）。 */
    async editResolved(target, text) {
      if (target?.chatId === undefined || String(target.chatId) === '') return
      try {
        await sendReply(String(target.chatId), `[审批结果] ${text}`)
      } catch (error) {
        warn(`审批结果回执失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 发普通文本（命令回执 / 被动回复）。 */
    async sendText(chatId, text) {
      try {
        return (await sendReply(chatId, text)) !== null
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}

export { ROBOT_CODE_KEY }
