// dsh-notifier inbound/qq-gw.mjs
// QQ 官方机器人 WebSocket 网关入站（v0.3.0 阶段 2）：裸协议实现，零 SDK 依赖。
// 背景：QQ 官方 Node SDK（bot-node-sdk → qq-guild-bot）改名两次后事实弃维，
// 活下去的是协议本身——WS 网关收事件 + REST 发消息 + getAppAccessToken 换 token，
// 全是裸 HTTP/WS，原生 fetch + globalThis.WebSocket（Node 22 内置）即可。
//  - 事件：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群 @，仅被 @ 时投递）
//  - 网关协议：op10 HELLO → op2 IDENTIFY（或 op6 RESUME）→ op1/op11 心跳；
//    op0 DISPATCH 携带 s 序号（心跳带回）；op7 RECONNECT / op9 INVALID_SESSION 走重连
//  - 审批：QQ 官方机器人无通用交互按钮卡片 → capabilities.buttons = false，
//    审批走文本通知 + 「回复 1 批准 / 2 拒绝」降级（router 已按能力分流文案）
//  - intents 默认 GROUP_AND_C2C（1<<25）；被@/单聊事件都在这一档
// 军规：任何异常只 warn 不抛；断线指数退避重连（RESUME 优先）；stop() 清干净全部定时器。
// 频控：Bot 维度 60qpm ≈ 1 条/秒（复用出站 qq-bot 的限速门经验值）；被动回复
// （带 msg_id 关联事件）有独立配额，5 条内免主动消息权限。

import { createTokenManager, createRateGate } from '../adapters/_tokens.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'
const INTENT_GROUP_AND_C2C = 1 << 25

// WS op codes（QQ 网关协议）
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/**
 * 解析并校验 inbound.qq 配置。
 * @param {object} raw - inbound.qq 原始配置
 * @param {{ credentials?: object }} [options] - 扫码落盘凭证回退（store 'qq:account'，config 显式配置优先）
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function resolveQqInboundConfig(raw, options = {}) {
  const cfg = (raw !== null && typeof raw === 'object') ? raw : {}
  const creds = (options.credentials !== null && typeof options.credentials === 'object') ? options.credentials : {}
  const appId = String(cfg.appId ?? creds.appId ?? '').trim()
  const appSecret = String(cfg.appSecret ?? creds.appSecret ?? '').trim()
  if (appId === '' || appSecret === '') {
    return { ok: false, reason: `QQ inbound 需要 appId 与 appSecret（当前 appId ${appId !== '' ? '已配置' : '缺失'}，appSecret ${appSecret !== '' ? '已配置' : '缺失'}）。请在 QQ 开放平台 q.qq.com 机器人开发设置中获取，或执行 node scripts/channel-login.mjs qq 官方扫码自动写入` }
  }
  const notifyUsers = (Array.isArray(cfg.notifyUsers) ? cfg.notifyUsers : []).map((id) => String(id).trim()).filter((id) => id !== '')
  const notifyGroups = (Array.isArray(cfg.notifyGroups) ? cfg.notifyGroups : []).map((id) => String(id).trim()).filter((id) => id !== '')
  const intents = Number.isInteger(cfg.intents) && cfg.intents >= 0 ? cfg.intents : INTENT_GROUP_AND_C2C
  return {
    ok: true,
    config: {
      appId,
      appSecret,
      apiBase: (String(cfg.apiBase ?? '').trim() || DEFAULT_API_BASE).replace(/\/+$/, ''),
      intents,
      notifyUsers,
      notifyGroups,
      timeoutMs: Math.min(60000, Math.max(1000, Number(cfg.timeoutMs) || 10000)),
    },
  }
}

/** 群消息 content 常以 @机器人 占位开头（<@!BOTID> 或 @名字），剥掉再投递。 */
function stripMention(content) {
  return String(content ?? '').replace(/^(<@![A-Za-z0-9_]+>|@\S+)\s*/, '').trim()
}

/**
 * 创建 QQ 官方机器人入站通道（统一契约；buttons=false，审批走编号回复）。
 * @param {object} options
 * @param {{ appId: string, appSecret: string, apiBase?: string, intents?: number,
 *           notifyUsers?: string[], notifyGroups?: string[], timeoutMs?: number }} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {string[]} [options.fallbackTargets] - 未配置 notifyUsers/Groups 时的推送目标（全局白名单回落，按单聊用户处理）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 * @param {typeof WebSocket} [options.webSocketImpl] - WebSocket 构造器注入（测试用；默认 globalThis.WebSocket）
 * @param {number} [options.reconnectBaseMs=1000] - 重连退避基数
 * @param {number} [options.reconnectCapMs=30000] - 重连退避上限
 */
export function createQqInbound(options = {}) {
  const { config, bus, fallbackTargets = [], logger = null, identity = null } = options
  // 防御性兜底：绕过 resolveQqInboundConfig 直接构造时也保证 apiBase 可用
  const apiBase = (String(config?.apiBase ?? '').trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket
  const reconnectBaseMs = Math.max(1, Number(options.reconnectBaseMs) || 1000)
  const reconnectCapMs = Math.max(reconnectBaseMs, Number(options.reconnectCapMs) || 30000)

  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:qq]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:qq]', message) } catch { /* 控制台不可用不致命 */ }
  }

  // token 管理器（换 token → 缓存 → 提前刷新 → 失效作废），与出站 qq-bot 同一套逻辑
  const tokens = createTokenManager(async () => {
    if (fetchImpl === undefined) throw new Error('当前运行时无 fetch，QQ inbound 不可用')
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
    })
    const payload = await response.json().catch(() => null)
    if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new Error(`换取 access_token 失败（HTTP ${response.status}）：检查 appId/appSecret`)
    }
    return { token: payload.access_token, expiresInMs: (Number(payload.expires_in) || 7200) * 1000 }
  })
  const rateGate = createRateGate(1050) // 60qpm ≈ 1 条/秒

  // 运行态
  let running = false
  let startPromise = null
  let stopRequested = false
  let ws = null
  let heartbeatTimer = null
  let lastSeq = null
  let sessionId = null
  let awaitingAck = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  // 发送侧运行态：目标类型学习表（事件来时记下 chatId 是单聊还是群）+ 每目标 msg_seq
  const targetKinds = new Map() // chatId -> 'user' | 'group'
  const msgSeqs = new Map() // chatId -> 递增 seq

  function targetKindOf(chatId) {
    const learned = targetKinds.get(String(chatId))
    if (learned !== undefined) return learned
    return (config.notifyGroups ?? []).includes(String(chatId)) ? 'group' : 'user'
  }

  function scheduleReconnect({ resume = false } = {}) {
    if (stopRequested) return
    if (reconnectTimer !== null) return
    const delay = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, reconnectCapMs)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!resume || sessionId === null) {
        sessionId = null
        lastSeq = null
      }
      connect().catch((error) => {
        warn(`重连失败: ${error instanceof Error ? error.message : String(error)}`)
        scheduleReconnect()
      })
    }, delay)
  }

  function cleanupSocket() {
    if (heartbeatTimer !== null) { clearTimeout(heartbeatTimer); heartbeatTimer = null }
    if (ws !== null) {
      try { ws.removeAllListeners?.() } catch { /* fake/运行时差异 */ }
      try { ws.close() } catch { /* 已关闭 */ }
      ws = null
    }
  }

  async function fetchGatewayUrl() {
    const token = await tokens.get()
    const response = await fetchImpl(`${apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
    })
    const payload = await response.json().catch(() => null)
    if (typeof payload?.url !== 'string' || payload.url === '') {
      throw new Error(`获取 WS 网关地址失败（HTTP ${response.status}）`)
    }
    return payload.url
  }

  function sendFrame(payload) {
    if (ws === null || ws.readyState !== 1) return false
    try { ws.send(JSON.stringify(payload)) ; return true } catch { return false }
  }

  function startHeartbeat(intervalMs) {
    // 标准模式：每次 beat 检查上一次是否已 ACK；未 ACK 即判死重连（无独立 watchdog，
    // 间隔本身就是粒度，避免「watchdog 被后续 beat 不断重置」的死穴）。
    // awaitingAck 是连接级状态：新连接起搏前必须复位，否则上一连接的未确认心跳
    // 会把新连接的第一拍直接判死（曾导致重连后 RESUME/IDENTIFY 发不出去）。
    awaitingAck = false
    const beat = () => {
      if (awaitingAck) {
        warn('心跳 ACK 超时（上一个心跳未确认），主动断开重连')
        cleanupSocket()
        scheduleReconnect({ resume: true })
        return
      }
      if (!sendFrame({ op: OP_HEARTBEAT, d: lastSeq })) return
      awaitingAck = true
    }
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
    heartbeatTimer = setInterval(beat, Math.max(50, intervalMs))
    beat()
  }

  function handleDispatch(t, d) {
    if (t === 'READY') {
      reconnectAttempts = 0
      sessionId = String(d?.session_id ?? '') || null
      warn(`QQ 网关已就绪（session ${sessionId ?? '?'}）`)
      return
    }
    if (t === 'RESUMED') {
      reconnectAttempts = 0
      warn('QQ 网关断线恢复（RESUME 成功，事件不丢）')
      return
    }
    try {
      if (t === 'C2C_MESSAGE_CREATE') {
        const userId = String(d?.author?.user_openid ?? '')
        const messageId = String(d?.id ?? '')
        const text = String(d?.content ?? '').trim()
        if (messageId === '' || userId === '' || text === '') return
        targetKinds.set(userId, 'user')
        // v0.7：accept 返回值消费——拒绝/命令回执不再已读不回。
        // msg_id 必带（R5 审查 R5-3-P2-3：C2C 不带 msg_id 走主动消息额度，真机大概率被
        // 平台 4xx 拒掉——mock fetch 不校验被动回复权限，单测测不出；带 msg_id 走被动回复）
        const result = bus.accept({ channel: 'qq', userId, chatId: userId, messageId, text })
        if (result?.reply !== undefined) {
          postMessage(userId, String(result.reply), messageId).catch((error) => {
            warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
          })
        }
        return
      }
      if (t === 'GROUP_AT_MESSAGE_CREATE') {
        const userId = String(d?.author?.member_openid ?? '')
        const chatId = String(d?.group_openid ?? '')
        const messageId = String(d?.id ?? '')
        const text = stripMention(d?.content)
        if (messageId === '' || userId === '' || chatId === '' || text === '') return
        targetKinds.set(chatId, 'group')
        // v0.7：群聊拒绝回执发回群（含「请私聊发送 /pair」引导）
        const result = bus.accept({ channel: 'qq', userId, chatId, messageId, text })
        if (result?.reply !== undefined) {
          postMessage(chatId, String(result.reply), messageId).catch((error) => {
            warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
          })
        }
        return
      }
    } catch (error) {
      warn(`事件处理异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 发送 IDENTIFY（新会话）或 RESUME（断线恢复）；token 换取失败交给重连兜底。 */
  function sendAuth({ resume = false } = {}) {
    tokens.get().then((token) => {
      if (resume && sessionId !== null) {
        sendFrame({ op: OP_RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } })
        return
      }
      sendFrame({
        op: OP_IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: config.intents ?? INTENT_GROUP_AND_C2C,
          shard: [0, 1],
          properties: { $os: 'dsh-notifier', $browser: 'dsh-notifier', $device: 'dsh-notifier' },
        },
      })
    }).catch((error) => {
      warn(`${resume ? 'RESUME' : 'IDENTIFY'} 失败（token 换取异常）: ${error instanceof Error ? error.message : String(error)}`)
      cleanupSocket()
      scheduleReconnect()
    })
  }

  function handleFrame(raw) {
    let frame
    try { frame = JSON.parse(raw) } catch { return }
    if (typeof frame?.s === 'number') lastSeq = frame.s
    if (frame.op === OP_HELLO) {
      const intervalMs = Number(frame.d?.heartbeat_interval) || 30000
      sendAuth({ resume: sessionId !== null })
      startHeartbeat(intervalMs)
      return
    }
    if (frame.op === OP_HEARTBEAT_ACK) {
      awaitingAck = false
      return
    }
    if (frame.op === OP_DISPATCH) {
      handleDispatch(frame.t, frame.d)
      return
    }
    if (frame.op === OP_RECONNECT) {
      warn('服务端要求重连（op7）')
      cleanupSocket()
      scheduleReconnect({ resume: true })
      return
    }
    if (frame.op === OP_INVALID_SESSION) {
      warn('会话失效（op9）：丢弃 session 重新 IDENTIFY')
      sessionId = null
      lastSeq = null
      cleanupSocket()
      scheduleReconnect({ resume: false })
    }
  }

  async function connect() {
    const url = await fetchGatewayUrl()
    if (stopRequested) return
    if (WebSocketImpl === undefined) throw new Error('当前运行时无 WebSocket（需要 Node 22+）')
    ws = new WebSocketImpl(url)
    ws.addEventListener('open', () => { /* 等 HELLO */ })
    ws.addEventListener('message', (event) => {
      try { handleFrame(typeof event.data === 'string' ? event.data : String(event.data)) } catch (error) {
        warn(`帧处理异常: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ws.addEventListener('close', () => {
      cleanupSocket()
      scheduleReconnect({ resume: true })
    })
    ws.addEventListener('error', () => { /* close 会跟着来，重连在 close 里统一调度 */ })
  }

  async function postMessage(chatId, content, msgId = undefined) {
    if (fetchImpl === undefined) return null
    const token = await tokens.get()
    await rateGate.gate()
    const target = String(chatId)
    const seq = (msgSeqs.get(target) ?? 0) + 1
    msgSeqs.set(target, seq)
    const kind = targetKindOf(target)
    const url = kind === 'group'
      ? `${apiBase}/v2/groups/${target}/messages`
      : `${apiBase}/v2/users/${target}/messages`
    const body = { content: String(content ?? '').slice(0, 2000), msg_type: 0, msg_seq: seq }
    if (msgId !== undefined) body.msg_id = msgId
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || (typeof payload?.code === 'string' && payload.code !== '')) {
      throw new Error(`QQ 发送失败（HTTP ${response.status}${payload?.code ? ` code ${payload.code}` : ''}: ${payload?.message ?? ''}）`)
    }
    return typeof payload?.id === 'string' && payload.id !== '' ? payload.id : `qq:${target}:${seq}`
  }

  return {
    channel: 'qq',
    capabilities: { buttons: false },

    /** 启动网关连接（幂等；失败中文 warn 后允许再次 start 重试）。 */
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
          warn(`QQ inbound 启动失败（本通道不可用，不影响其他通道）: ${reason}`)
        }
      })()
    },

    /** 停止并清理全部定时器/连接（幂等）。 */
    async stop() {
      stopRequested = true
      running = false
      try { await startPromise } catch { /* 启动失败不影响停止 */ }
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
      cleanupSocket()
      startPromise = null
    },

    /** 审批推送目标（v0.7 三级解析）：绑定成员 → notifyUsers → 全局回落（仅绑定表整体空）；
     *  notifyGroups 是渠道属性（群通知）不是身份属性，无条件并入——绑定表接管用户
     *  目标不等于群通知就此消失（v0.6 行为保留）。 */
    notifyTargets() {
      return resolveNotifyTargets({
        identity,
        channel: 'qq',
        configTargets: (Array.isArray(config.notifyUsers) ? config.notifyUsers : []).map(String),
        fallbackTargets,
        extraTargets: (Array.isArray(config.notifyGroups) ? config.notifyGroups : []).map(String),
      })
    },

    /** 推审批文本通知（无按钮，回复 1/2 裁决）；失败 null 降级纯通知。 */
    async sendApprovalCard({ chatId, title, content }) {
      const text = `${title}\n${content}\n\n回复 1 批准 / 2 拒绝`
      try {
        const messageId = await postMessage(chatId, text)
        return messageId !== null ? { messageId } : null
      } catch (error) {
        warn(`审批通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 消息不可编辑：以回执文本补一条结果（尽力而为）。 */
    async editResolved(target, text) {
      if (target?.chatId === undefined || String(target.chatId) === '') return
      try {
        await postMessage(target.chatId, `[审批结果] ${text}`)
      } catch (error) {
        warn(`审批结果回执失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 发普通文本（命令回执 / 被动回复）。 */
    async sendText(chatId, text, msgId = undefined) {
      try {
        return (await postMessage(chatId, text, msgId)) !== null
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}
