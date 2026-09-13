// dsh-notifier inbound/qq-gw.mjs
// QQ 官方机器人 WebSocket 网关入站（v0.3.0 阶段 2）：裸协议实现，零 SDK 依赖。
// 背景：QQ 官方 Node SDK（bot-node-sdk → qq-guild-bot）改名两次后事实弃维，
// 活下去的是协议本身——WS 网关收事件 + REST 发消息 + getAppAccessToken 换 token，
// 全是裸 HTTP/WS，原生 fetch + globalThis.WebSocket（Node 22 内置）即可。
//  - 事件：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群 @，仅被 @ 时投递）
//  - 网关协议：op10 HELLO → op2 IDENTIFY（或 op6 RESUME）→ op1/op11 心跳；
//    op0 DISPATCH 携带 s 序号（心跳带回）；op7 RECONNECT / op9 INVALID_SESSION 走重连
//  - 审批：v0.8.4 按钮化（2026-08 实测平台已开放 markdown+内嵌键盘）：审批卡优先
//    msg_type=2 + keyboard 长形式（content.rows），回调按钮 action.data 携带契约
//    协议「ap:<decision>:<approvalKey>:<token>」（与 telegram/飞书同构，HMAC 验签）；
//    发送失败自动降级文本编号回复（能力探测免配置）
//  - 点击回传：INTERACTION_CREATE（intent INTERACTION 1<<26）经本 WS 网关推送，
//    收到后立即异步 PUT /interactions/{id} ACK（3s 窗口），再把显式 key 裁决送 bus.decide
//  - intents 默认 GROUP_AND_C2C(1<<25) | INTERACTION(1<<26)；被@/单聊/按钮点击都在这两档
// 军规：任何异常只 warn 不抛；断线指数退避重连（RESUME 优先）；stop() 清干净全部定时器。
// 频控：Bot 维度 60qpm ≈ 1 条/秒（复用出站 qq-bot 的限速门经验值）；被动回复
// （带 msg_id 关联事件）有独立配额，5 条内免主动消息权限。

import { createTokenManager, createRateGate, normalizeTtlMs } from '../adapters/_tokens.mjs'
import { setBounded, createThrottledWarn } from './_bounded.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'
import { buildApprovalAction, parseApprovalAction, buildQuestionAction, parseQuestionAction } from './_contract.mjs'
import { parseQQImageMessage } from './message.mjs'
import { splitByCodePoints } from './segment.mjs'
import { stringsOf } from '../strings.mjs'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'
const INTENT_GROUP_AND_C2C = 1 << 25
const INTENT_INTERACTION = 1 << 26 // INTERACTION_CREATE：消息按钮点击回调（v0.8.4 按钮化）
const CHAT_STATE_MAX = 1024
// 出站单条上限按 Unicode 码点计（非 UTF-16 码元）：文本 2000 / Markdown 3000（官方限制）。
// 码点语义经 splitByCodePoints 保证——码元切片会把星体平面字符切成孤立代理项（G-22 同根）。
const QQ_TEXT_MAX_CODEPOINTS = 2000
const QQ_MARKDOWN_MAX_CODEPOINTS = 3000
/** G-22：被动回复条数配额（QQ 官方平台限制：c2c 4 条 / 群 5 条，按同一 msg_id 的被动回复计）。
 *  超限时平台静默丢弃（无错误码、无回执）——本侧不硬阻塞投递（硬阻塞把「可能仍送达」
 *  变成「必然不送达」），仅 warn 出声让丢弃可见。主动消息（无 msg_id）不受此配额约束。 */
const QQ_PASSIVE_REPLY_QUOTA = { user: 4, group: 5 }

// WS op codes（QQ 网关协议）
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/** G-07：close 4008（连接被限速）是服务端给出的硬性等待窗——按官方 SDK 语义固定等
 *  60s 再重连，不走指数退避（限流期短退避重连等于连续撞墙，反而加剧限流）。 */
const CLOSE_4008_WAIT_MS = 60000

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
  const intents = Number.isInteger(cfg.intents) && cfg.intents >= 0 ? cfg.intents : (INTENT_GROUP_AND_C2C | INTENT_INTERACTION)
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

/**
 * G-40：群消息 @ 机器人占位白名单化——仅剥已证实形态，绝不「假定剥不掉也无害」。
 * 已证实形态：`<@!数字ID>`、`<@数字ID>`（官方占位）与行首 `@名字+空格`（纯文本形态）。
 * 未命中白名单但形似提及（以 @ / <@ 开头）→ 保留原文并由调用方 debug 出声：
 * @ 残片会污染 agent 语境与 /pair 参数；平台若改格式，日志可见而非静默漏剥。
 * 官方文档称群 content 已自动去 @ 前缀（docs/protocol-preflight/qq-bot.md），但真机
 * 样本不足——白名单+出声是「漏剥可见」与「误剥可见」之间的保守中点。
 */
const MENTION_WHITELIST = [
  /^<@!\d+>\s*/, // 官方占位形态一：<@!数字ID>（占位自定界，尾随空格可缺省）
  /^<@\d+>\s*/, // 官方占位形态二：<@数字ID>
  /^@\S+\s+/, // 纯文本形态：行首 @名字+空格（空格是「名字结束」判据，缺空格视为未知）
]

/** 剥离群消息行首的 @ 机器人占位；返回 { text, matched, mentionLike }（matched=命中
 *  白名单已剥；mentionLike=形似提及但未命中，调用方据此 debug 出声）。 */
function stripMention(content) {
  const text = String(content ?? '')
  for (const pattern of MENTION_WHITELIST) {
    if (pattern.test(text)) return { text: text.replace(pattern, '').trim(), matched: true }
  }
  return { text: text.trim(), matched: false, mentionLike: /^(@|<@)/.test(text) }
}

/**
 * 审批按钮负载（v0.8.4）：直接复用契约协议 `ap:<decision>:<approvalKey>:<token>`
 * （buildApprovalAction/parseApprovalAction，与 telegram/feishu callback_data 完全
 * 同构，复用同一套 HMAC token 核销）。key+token 在卡片发送时写死进按钮——点击回传
 * 按显式 key 精确命中并验签，杜绝「最近待决」隐式匹配在多行并存/僵尸行/并行竞速下
 * 的目标劫持（2026-08-23 事故的病根）。
 */
/** 解析按钮回调数据；非契约格式 → null（调用方静默忽略）。见 parseApprovalAction。 */

/**
 * 创建 QQ 官方机器人入站通道（统一契约；v0.8.4 buttons=true——审批优先按钮卡片，
 * 发送失败自动降级文本编号回复）。
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
 * @param {object} [options.strings] - stringsOf(lang) 全文案表（读 `qq` 节，跨节复用
 *   approval.fallbackText；缺省回落 zh——须先在 strings.mjs 落 `qq` 节）
 */
export function createQqInbound(options = {}) {
  const { config, bus, fallbackTargets = [], logger = null, identity = null } = options
  const STRINGS = options.strings ?? stringsOf()
  const t = STRINGS.qq
  // 防御性兜底：绕过 resolveQqInboundConfig 直接构造时也保证 apiBase 可用
  const apiBase = (String(config?.apiBase ?? '').trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket
  const reconnectBaseMs = Math.max(1, Number(options.reconnectBaseMs) || 1000)
  const reconnectCapMs = Math.max(reconnectBaseMs, Number(options.reconnectCapMs) || 30000)
  // G-07：close 4008 的固定等待窗（默认 60s；测试注入缩短，不参与指数退避）
  const close4008WaitMs = Math.max(0, Number(options.close4008WaitMs) || CLOSE_4008_WAIT_MS)
  const ackThreshold = Number(options.maxMissedAcks)
  const maxMissedAcks = Number.isFinite(ackThreshold) && ackThreshold >= 1 ? Math.min(10, Math.floor(ackThreshold)) : 2

  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:qq]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:qq]', message) } catch { /* 控制台不可用不致命 */ }
  }
  // debug 级诊断只走宿主 logger（不双写 stderr）：@ 形态采样这类低频诊断由宿主按需开启，
  // 避免 stderr 噪音；宿主未接 debug 时静默跳过（fail-safe，不影响主路径）。
  const debug = (message) => {
    try { logger?.debug?.('[dsh-notifier/inbound:qq]', message) } catch { /* 日志失败绝不致命 */ }
  }
  const evictionWarn = createThrottledWarn(warn, { intervalMs: 1000 })
  const onEvict = (key) => evictionWarn((count) => `目标类型学习表达上限：淘汰 ${count} 个旧目标（最近淘汰 ${String(key).slice(0, 32)}）`)

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
    // G-55：与出站 qq-bot 同一归一——expires_in 非法（非有限/≤0）不再 || 7200 掩盖
    return { token: payload.access_token, expiresInMs: normalizeTtlMs(Number(payload.expires_in) * 1000, 'expires_in') }
  })
  const rateGate = createRateGate(1050) // 60qpm ≈ 1 条/秒

  // 运行态
  let running = false
  let startPromise = null
  let stopRequested = false
  let ws = null
  let heartbeatTimer = null
  let heartbeatIntervalMs = null
  let heartbeatArmed = false
  let lastSeq = null
  let sessionId = null
  let awaitingAck = false
  let missedAcks = 0
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

  function scheduleReconnect({ resume = false, delayMs = null } = {}) {
    if (stopRequested) return
    if (reconnectTimer !== null) return
    // G-07：4008（连接被限速）服务端给出的是硬性等待窗，不用指数退避——按计划固定 60s
    const delay = delayMs !== null ? Math.max(0, delayMs)
      : Math.min(reconnectBaseMs * 2 ** reconnectAttempts, reconnectCapMs)
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
    // 连接级心跳运行态复位：断开/重连/cleanup 后不得继承上一连接的脏 arming/ACK/miss 状态。
    // heartbeatIntervalMs 保留——重连后同一会话的节奏由新连接 HELLO 重新下发（仅作兜底用）。
    heartbeatArmed = false
    awaitingAck = false
    missedAcks = 0
    if (ws !== null) {
      try { ws.removeAllListeners?.() } catch { /* fake/运行时差异 */ }
      try { ws.close() } catch { /* 已关闭 */ }
      ws = null
    }
  }

  /** G-07：关闭码分支表（对齐官方 SDK reconnect 语义，dsh-im qqbot-connector 同源）：
   *  - 4004 认证失败：token 已被平台吊销——作废 token 缓存（此前全文件无一处
   *    tokens.invalidate()，带着死凭证无限重连直到 TTL 自然过期）+ 弃会话重 IDENTIFY
   *  - 4008 连接被限速：服务端硬性等待窗，固定等（不走指数退避）；会话仍有效走 RESUME
   *  - 4006 seq 非法 / 4007 shard 无效 / 4009 会话超时：会话不可恢复，弃之重 IDENTIFY
   *  - 其余（1000 正常关闭 / 1006 异常断开 / 无码）：现行为——RESUME 优先 + 指数退避 */
  function scheduleReconnectForClose(code) {
    if (code === 4004) {
      warn('QQ 网关认证失败（close 4004）：作废 access_token 缓存重取，弃会话重新 IDENTIFY')
      tokens.invalidate()
      sessionId = null
      lastSeq = null
      scheduleReconnect({ resume: false })
      return
    }
    if (code === 4008) {
      warn(`QQ 网关连接被限速（close 4008）：按服务端等待窗固定 ${Math.round(close4008WaitMs / 1000)}s 后 RESUME（不走指数退避）`)
      scheduleReconnect({ resume: true, delayMs: close4008WaitMs })
      return
    }
    if (code === 4006 || code === 4007 || code === 4009) {
      warn(`QQ 网关闭码 ${code}：会话不可恢复，弃会话重新 IDENTIFY`)
      sessionId = null
      lastSeq = null
      scheduleReconnect({ resume: false })
      return
    }
    scheduleReconnect({ resume: true })
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

  /** Issue #23：HELLO 只记录本连接的 heartbeat_interval，不发送、也不启动心跳。
   *  真机 A/B 证据：QQ 网关只对 READY/RESUMED 之后发出的心跳回 OP_HEARTBEAT_ACK，
   *  鉴权完成前起搏只会白耗且永远收不到 ACK，必然走到阈值判死死循环。故此函数
   *  只落盘 interval 并复位连接级心跳运行态，真正的起搏交给 armHeartbeat()（READY/RESUMED 触发）。 */
  function recordHeartbeatInterval(intervalMs) {
    heartbeatIntervalMs = intervalMs
    heartbeatArmed = false
    awaitingAck = false
    missedAcks = 0
  }

  /** Issue #23：READY/RESUMED 后才幂等启动心跳，并立即发送第一拍（携带当时最新 lastSeq）。
   *  幂等：重复 READY/RESUMED 不得创建多个定时器或重复首拍。
   *  单拍丢 ACK 且未达阈值时：记一次 miss、告警、仍发送下一拍（恢复路径不断）。 */
  function armHeartbeat() {
    if (heartbeatArmed) return
    if (heartbeatIntervalMs === null) return
    heartbeatArmed = true
    awaitingAck = false
    missedAcks = 0
    const beat = () => {
      if (heartbeatTimer === null) return // 连接已清理，本闭包随旧定时器废弃
      if (awaitingAck) {
        missedAcks += 1
        if (missedAcks < maxMissedAcks) {
          warn(`心跳 ACK 已连续丢失 ${missedAcks}/${maxMissedAcks} 拍（下一拍仍无 ACK 才断线重连）`)
        } else {
          warn(`心跳 ACK 已连续丢失 ${missedAcks}/${maxMissedAcks} 拍，判死主动断开重连`)
          cleanupSocket()
          scheduleReconnect({ resume: true })
          return // 达到阈值：本拍不再发送（清 socket 后经 RESUME 优先重连）
        }
      }
      if (!sendFrame({ op: OP_HEARTBEAT, d: lastSeq })) return
      awaitingAck = true
    }
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
    heartbeatTimer = setInterval(beat, Math.max(50, heartbeatIntervalMs))
    beat()
  }

  function handleDispatch(t, d) {
    if (t === 'READY') {
      reconnectAttempts = 0
      sessionId = String(d?.session_id ?? '') || null
      warn(`QQ 网关已就绪（session ${sessionId ?? '?'}）`)
      armHeartbeat() // Issue #23：鉴权完成（READY）后才幂等启动心跳，立即发首拍
      return
    }
    if (t === 'RESUMED') {
      reconnectAttempts = 0
      warn('QQ 网关断线恢复（RESUME 成功，事件不丢）')
      armHeartbeat() // Issue #23：RESUMED 后同样起搏（幂等，避免重复 READY/RESUMED 建多定时器）
      return
    }
    try {
      if (t === 'C2C_MESSAGE_CREATE') {
        const userId = String(d?.author?.user_openid ?? '')
        const messageId = String(d?.id ?? '')
        const text = String(d?.content ?? '').trim()
        // QQ's documented C2C image segment is carried by `extra`. Only the shared parser's
        // known fields survive; a malformed/unknown segment never becomes text or control data.
        const image = parseQQImageMessage(d)
        if (messageId === '' || userId === '' || (text === '' && image === null)) return
        setBounded(targetKinds, userId, 'user', CHAT_STATE_MAX, onEvict)
        // v0.7：accept 返回值消费——拒绝/命令回执不再已读不回。
        // msg_id 必带（R5 审查 R5-3-P2-3：C2C 不带 msg_id 走主动消息额度，真机大概率被
        // 平台 4xx 拒掉——mock fetch 不校验被动回复权限，单测测不出；带 msg_id 走被动回复）
        const envelope = {
          channel: 'qq', accountId: String(config?.appId ?? ''), userId, chatId: userId, messageId,
          chatType: 'private',
          text: text || '[图片消息]',
          ...(image === null ? {} : { image: image.image, ...(text === '' ? { kind: 'image' } : {}) }),
        }
        const result = bus.accept(envelope)
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
        // G-40：白名单未命中但形似提及 → 保留原文 + debug 出声（@ 残片会污染 agent 语境
        // 与 /pair 参数；平台改格式时靠日志发现而非静默漏剥）。头部截 32 字符便于采样。
        const mention = stripMention(d?.content)
        if (mention.mentionLike === true) {
          debug(`群消息 @ 形态未命中白名单，已保留原文（QQ @ 占位真机样本不足，出现即需采样登记）: ${JSON.stringify(String(d?.content ?? '').slice(0, 32))}`)
        }
        const text = mention.text
        if (messageId === '' || userId === '' || chatId === '' || text === '') return
        setBounded(targetKinds, chatId, 'group', CHAT_STATE_MAX, onEvict)
        // v0.7：群聊拒绝回执发回群（含「请私聊发送 /pair」引导）
        const result = bus.accept({ channel: 'qq', accountId: String(config?.appId ?? ''), userId, chatId, messageId, chatType: 'group', text })
        if (result?.reply !== undefined) {
          postMessage(chatId, String(result.reply), messageId).catch((error) => {
            warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
          })
        }
        return
      }
      if (t === 'INTERACTION_CREATE') {
        // v0.8.4 按钮回调（type=11 消息按钮）：先异步 ACK（PUT /interactions，3s 窗口，
        // 失败只影响客户端转圈不致命），再解析 apv 载荷送 bus——显式 key 裁决，
        // 不做任何隐式匹配；非本插件按钮静默忽略。
        const type = Number(d?.type ?? d?.data?.type ?? 0)
        if (type !== 11) return
        const interactionId = String(d?.id ?? '')
        const buttonData = String(d?.data?.resolved?.button_data ?? '')
        const userId = String(d?.group_member_openid ?? d?.user_openid ?? '')
        const groupOpenId = String(d?.group_openid ?? '')
        const userOpenId = String(d?.user_openid ?? '')
        const chatId = String(groupOpenId || userOpenId)
        if (interactionId === '' || userId === '' || chatId === '') return
        void ackInteraction(interactionId).catch((error) => {
          warn(`互动 ACK 失败: ${error instanceof Error ? error.message : String(error)}`)
        })
        setBounded(targetKinds, chatId, chatId === userId ? 'user' : 'group', CHAT_STATE_MAX, onEvict)
        const chatType = groupOpenId !== '' ? 'group' : 'private'
        const parsed = parseApprovalAction(buttonData)
        const question = parseQuestionAction(buttonData)
        if (question !== null) {
          const result = bus.accept({ channel: 'qq', accountId: String(config?.appId ?? ''), userId, chatId, chatType, messageId: interactionId,
            text: `[提问按钮:${question.optIdx}] ${question.qKey}`,
            questionAction: question })
          if (result?.reply !== undefined) postMessage(chatId, String(result.reply), interactionId).catch(() => {})
          return
        }
        if (parsed === null) return
        const result = bus.accept({
          channel: 'qq',
          accountId: String(config?.appId ?? ''),
          userId,
          chatId,
          chatType,
          messageId: interactionId,
          text: `[审批按钮:${parsed.decision}] ${parsed.approvalKey}`,
          approvalAction: { decision: parsed.decision, approvalKey: parsed.approvalKey, token: parsed.token },
        })
        if (result?.reply !== undefined) {
          postMessage(chatId, String(result.reply), interactionId).catch((error) => {
            warn(`按钮回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
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
          intents: config.intents ?? (INTENT_GROUP_AND_C2C | INTENT_INTERACTION),
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
      // Issue #23：HELLO 只记录本连接 heartbeat_interval 并发送鉴权，不启动心跳。
      // 心跳须待 READY/RESUMED 鉴权完成后由 armHeartbeat() 幂等启动（真机 A/B 证据：
      // 网关只对鉴权完成后的心跳回 OP_HEARTBEAT_ACK，提前起搏永远收不到 ACK 而死循环）。
      recordHeartbeatInterval(intervalMs)
      sendAuth({ resume: sessionId !== null })
      return
    }
    if (frame.op === OP_HEARTBEAT_ACK) {
      awaitingAck = false
      missedAcks = 0
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
      // G-21：按官方 SDK 语义看 d 标志——d:true 会话仍可恢复（保留 session 走 RESUME，
      // 事件续传不丢）；d:false 会话已死才弃之重 IDENTIFY。旧实现一律弃会话：
      // 每次可恢复失效都多付一次 IDENTIFY 握手 + 丢失续传窗。
      const resumable = frame.d === true
      warn(`会话失效（op9）：${resumable ? '可恢复，保留 session 走 RESUME' : '不可恢复，弃会话重新 IDENTIFY'}`)
      if (!resumable) {
        sessionId = null
        lastSeq = null
      }
      cleanupSocket()
      scheduleReconnect({ resume: resumable })
    }
  }

  async function connect() {
    const url = await fetchGatewayUrl()
    if (stopRequested) return
    if (WebSocketImpl === undefined) throw new Error('当前运行时无 WebSocket（需要 Node 22+）')
    ws = new WebSocketImpl(url)
    const conn = ws
    ws.addEventListener('open', () => { /* 等 HELLO */ })
    ws.addEventListener('message', (event) => {
      // Issue #23：连接级隔离——旧连接（已被 cleanupSocket 置 ws=null 或换成新连接）的
      // 迟到帧（含 op11 ACK）不得触碰新连接的心跳运行态或 reset 新连接的 awaitingAck。
      if (ws !== conn) return
      try { handleFrame(typeof event.data === 'string' ? event.data : String(event.data)) } catch (error) {
        warn(`帧处理异常: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ws.addEventListener('close', (event) => {
      cleanupSocket()
      // G-07：关闭码带语义——4004 刷 token / 4008 固定窗 / 4006/4007/4009 弃会话
      scheduleReconnectForClose(Number(event?.code))
    })
    ws.addEventListener('error', () => { /* close 会跟着来，重连在 close 里统一调度 */ })
  }

  /** 发文本：超长按码点分段逐条发送（每段独立 msg_seq，服务端按 msg_id+msg_seq 去重）。
   *  G-22 同根修复：旧 slice(0, 2000) 是 UTF-16 码元语义，第 2000 码元恰落在星体平面
   *  字符（emoji/生僻字）中间时产生孤立代理项（JSON 载荷非法，平台拒收或乱码）。
   *  G-22 配额：被动回复（携带 msg_id）分段数超平台配额时 warn 出声但不阻塞（超限部分
   *  平台静默丢弃，先让丢弃可见——见 QQ_PASSIVE_REPLY_QUOTA 注释）。
   *  任一段失败即抛错（已发段不撤回，与 iLink 分块语义一致）。 */
  async function postMessage(chatId, content, msgId = undefined) {
    if (fetchImpl === undefined) return null
    const token = await tokens.get()
    const target = String(chatId)
    const kind = targetKindOf(target)
    const url = kind === 'group'
      ? `${apiBase}/v2/groups/${target}/messages`
      : `${apiBase}/v2/users/${target}/messages`
    const chunks = splitByCodePoints(String(content ?? ''), QQ_TEXT_MAX_CODEPOINTS)
    const pieces = chunks.length > 0 ? chunks : ['']
    if (msgId !== undefined) {
      const quota = kind === 'group' ? QQ_PASSIVE_REPLY_QUOTA.group : QQ_PASSIVE_REPLY_QUOTA.user
      if (pieces.length > quota) {
        warn(`被动回复分段 ${pieces.length} 条超过${kind === 'group' ? '群' : 'c2c'}配额 ${quota} 条：超限部分平台将静默丢弃（本侧不硬阻塞，已照发）: ${target}`)
      }
    }
    let lastId = null
    for (const piece of pieces) {
      await rateGate.gate()
      const seq = (msgSeqs.get(target) ?? 0) + 1
      setBounded(msgSeqs, target, seq, CHAT_STATE_MAX, onEvict)
      const body = { content: piece, msg_type: 0, msg_seq: seq }
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
      lastId = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : `qq:${target}:${seq}`
    }
    return lastId
  }

  /** 互动事件回执（PUT /interactions/{id}，50QPS）：3 秒窗口内告知平台已受理，
   *  否则用户端按钮一直 loading。失败由调用方 catch（不致命）。 */
  async function ackInteraction(interactionId) {
    if (fetchImpl === undefined) return
    const token = await tokens.get()
    await fetchImpl(`${apiBase}/interactions/${encodeURIComponent(interactionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body: JSON.stringify({ code: 0 }),
    })
  }

  /** 发送 markdown + 内嵌键盘（审批按钮卡片，msg_type=2）。失败抛错，调用方降级文本。 */
  async function postMarkdownWithKeyboard(chatId, markdownContent, keyboard) {
    if (fetchImpl === undefined) return null
    const token = await tokens.get()
    await rateGate.gate()
    const target = String(chatId)
    const seq = (msgSeqs.get(target) ?? 0) + 1
    setBounded(msgSeqs, target, seq, CHAT_STATE_MAX, onEvict)
    const kind = targetKindOf(target)
    const url = kind === 'group'
      ? `${apiBase}/v2/groups/${target}/messages`
      : `${apiBase}/v2/users/${target}/messages`
    // Markdown+键盘是单张卡片：超长只按码点截断（取首块），不拆多卡——键盘必须与卡片
    // 同体，拆卡会重复按钮/permission；码点截断同样不产生孤立代理项（G-22 同根）。
    const markdownText = splitByCodePoints(String(markdownContent ?? ''), QQ_MARKDOWN_MAX_CODEPOINTS)[0] ?? ''
    const body = { msg_type: 2, msg_seq: seq, markdown: { content: markdownText }, keyboard }
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || (typeof payload?.code === 'string' && payload.code !== '')) {
      throw new Error(`QQ 按钮卡片发送失败（HTTP ${response.status}${payload?.code ? ` code ${payload.code}` : ''}: ${payload?.message ?? ''}）`)
    }
    return typeof payload?.id === 'string' && payload.id !== '' ? payload.id : `qq-kb:${target}:${seq}`
  }

  return {
    channel: 'qq',
    accountId: String(config?.appId ?? ''),
    // v0.8.4：按钮化落地（发送失败自动降级文本，capabilities 仅影响文案分流）
    capabilities: { buttons: true },

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
      // Issue #23：stop 后复位全部连接级心跳运行态，保证 restart 能重新正常握手与起搏。
      heartbeatArmed = false
      heartbeatIntervalMs = null
      awaitingAck = false
      missedAcks = 0
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

    /** 推审批通知（v0.8.4）：优先 markdown+内嵌键盘——两颗回调按钮（type 1）action.data
     *  携带契约协议「ap:<decision>:<approvalKey>:<token>」，click_limit=1 防重复，
     *  单聊场景 permission 锁定接收人。发送失败自动降级文本编号回复（无感切换）。 */
    async sendApprovalCard({ chatId, title, content, approvalKey, token }) {
      if (typeof approvalKey === 'string' && approvalKey !== '' && typeof token === 'string' && token !== '') {
        try {
          const isUserTarget = targetKindOf(chatId) === 'user'
          if (!isUserTarget) throw new Error('群聊审批仅提供文本回退，禁止可见按钮')
          const button = (id, label, visitedLabel, style, decision) => ({
            id,
            render_data: { label, visited_label: visitedLabel, style },
            action: {
              // type 必须 1（回调按钮：点击产生 INTERACTION_CREATE 推送到本网关）。
              // type 2 是「指令按钮」——客户端会把 data 当文本消息自动发出，不产生
              // 回调事件（2026-08-23 实测踩坑：官方 overview 示例的 type:2 是指令语义）。
              type: 1,
              ...(isUserTarget ? { permission: { type: 2, specify_user_ids: [String(chatId)] } } : {}),
              click_limit: 1,
              data: buildApprovalAction(decision, approvalKey, token),
            },
          })
          const keyboard = {
            content: {
              rows: [
                { buttons: [
                  button('btn_approve', t.approveLabel, t.approveVisited, 1, 'allowed-once'),
                  button('btn_reject', t.rejectLabel, t.rejectVisited, 2, 'rejected'),
                ] },
              ],
            },
          }
          const markdown = `${title}\n${content}\n\n${t.markdownFooter(isUserTarget)}`
          const messageId = await postMarkdownWithKeyboard(chatId, markdown, keyboard)
          if (messageId !== null) return { messageId }
        } catch (error) {
          warn(`按钮卡片发送失败，本次降级文本审批: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        const text = STRINGS.approval.fallbackText(title, content)
        const messageId = await postMessage(chatId, text)
        return messageId !== null ? { messageId } : null
      } catch (error) {
        warn(`审批通知发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    async sendQuestionCard({ chatId, title, content, qKey, token, options = [] }) {
      try {
        const isUserTarget = targetKindOf(chatId) === 'user'
        if (!isUserTarget) return null // 群聊不展示可操作提问卡，避免成员间信息/权限泄漏
        const buttons = options.slice(0, 5).map((label, index) => ({
          id: `q_${index}`,
          render_data: { label: `${index + 1}. ${String(label).slice(0, 40)}`, visited_label: t.selectedVisited, style: 0 },
          action: { type: 1, click_limit: 1, data: buildQuestionAction(qKey, String(index), token),
            ...(isUserTarget ? { permission: { type: 2, specify_user_ids: [String(chatId)] } } : {}) },
        }))
        buttons.push({ id: 'q_custom', render_data: { label: t.customAnswerLabel, visited_label: t.selectedVisited, style: 0 }, action: { type: 1, click_limit: 1, data: buildQuestionAction(qKey, 'c', token), permission: { type: 2, specify_user_ids: [String(chatId)] } } })
        const messageId = await postMarkdownWithKeyboard(chatId, `${title}\n${content}`, { content: { rows: buttons.map((button) => ({ buttons: [button] })) } })
        return messageId === null ? null : { messageId }
      } catch (error) {
        warn(`提问卡片发送失败，降级编号: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 消息不可编辑：以回执文本补一条结果（尽力而为）。 */
    async editResolved(target, text) {
      if (target?.chatId === undefined || String(target.chatId) === '') return
      try {
        await postMessage(target.chatId, t.resultLine(text))
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
