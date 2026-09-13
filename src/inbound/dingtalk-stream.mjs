// dsh-notifier inbound/dingtalk-stream.mjs
// 钉钉企业内部机器人 Stream 入站（v0.3.1）：官方 Stream 长连接裸协议，零 SDK 依赖
//（结构照抄 qq-gw.mjs：resolve 函数 / 契约方法 / start-stop / 重连退避 / notifyTargets /
//  sendApprovalCard 编号回复文案；凭证回退与熔断用法照抄 wechat-ilink.mjs）。
// 协议事实（仲裁源：dingtalk-stream 官方 SDK 2.1.4 / 2.1.6-beta.1 / 2.1.7-beta.1 三版
// dist/client.mjs 源码核对；未经真机验证，证据登记 docs/protocol-preflight/dingtalk.md）：
//  1. token：GET {oapi}/gettoken?appkey=&appsecret= → { errcode:0, access_token, expires_in }
//  2. 网关：POST {api}/v1.0/gateway/connections/open（Content-Type/Accept 均 application/json），
//     body { clientId, clientSecret, subscriptions:[{type:'CALLBACK',topic:'/v1.0/im/bot/messages/get'}],
//     ua } → { endpoint, ticket }。字段名就是 ua：三版 SDK getEndpoint 全系
//     `ua: this.config.ua`，「官方 SDK 拼写错误字段 uesrAgent、服务端认它」一说经三版源码
//     核对查无实据（G-10，勿再改回）。
//  3. WS：new WebSocket(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)；帧为 JSON 字符串
//     { specVersion, type, headers, data }——messageId 只存在于 headers.messageId（顶层无该
//     字段），data 本身又是 JSON 字符串（需二次 parse；parse 失败 warn 可观测后丢弃，G-42）。
//  4. ack：每条业务帧回 { code:200, headers:{ contentType:'application/json',
//     messageId:frame.headers.messageId }, data: JSON.stringify('OK') }（G-01：头字段名是
//     messageId 不是 requestId，data 是 JSON 字符串 '"OK"'）；未 ack 服务端 60s 重推
//     （msgId 去重 Map + 60s 窗口吸收；bus 侧 24h 持久去重再兜一层）。
//  5. 心跳分两层，不得合并处理：传输层 WS 协议 ping/pong——服务端 8s 发 ping、原生
//     WebSocket 自动回 pong（本实现不发心跳帧，与官方 SDK keepAlive:false 同态）；应用层
//     SYSTEM 帧子类 ping——须原样回显 headers+data（data 含必须回显的 opaque）；
//     disconnect/KEEPALIVE/REGISTERED 等 SYSTEM 子类记 debug 日志后返回，不进业务路径（G-02）。
//  6. 业务消息：{ conversationId, msgId, senderStaffId, senderNick, sessionWebhook,
//     sessionWebhookExpiredTime, robotCode, msgtype, text:{content} }；非 msgtype==='text'
//     静默忽略（richText 例外，见 parseRichTextMessage，G-23）；content 首尾 trim。
//  7. 被动回复：POST sessionWebhook，头 { content-type, x-acs-dingtalk-access-token }，
//     body { msgparam: JSON.stringify({content}), msgKey:'sampleText' }；webhook 到期
//     （毫秒时间戳 < now）不回复、告警，改走主动推送兜底；回执 messageId 合成
//     `dt:reply-<ts36>-<seq36>`（G-24：旧 hash6(chatId:content) 在同会话同内容时必同 ID）。
//  8. 主动推送：POST {api}/v1.0/robot/oToMessages/batchSend?robot_code=（body 为数组）；
//     robotCode 从首条入站消息学习（store 'dingtalk:robot-code'，跨重启恢复）；未学到前
//     主动推送失败告警；推送过 createBreaker（默认参数），任一入站消息 breaker.reset()。
//  9. token 到期前 60s 主动刷新；业务返回 errcode!==0 → token 作废重取后重试一次。
// 10. 重连：onclose/onerror 后 base*2^n + [0,1000) 抖动，封顶 60s（可注入 base/cap）。
// 军规：任何异常只 warn 不抛；stop() 幂等且清干净全部定时器/连接；错误文案不含 appSecret。

import { createHash } from 'node:crypto'
import { createTokenManager, normalizeTtlMs } from '../adapters/_tokens.mjs'
import { createBreaker } from './_breaker.mjs'
import { setBounded, createThrottledWarn } from './_bounded.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'
import { normalizeImageAttachment } from './message.mjs'
import { stripCommandMention, stripLeadingMention } from './commands.mjs'
import { stringsOf } from '../strings.mjs'

const DEFAULT_API_BASE = 'https://api.dingtalk.com'
const DEFAULT_OAPI_BASE = 'https://oapi.dingtalk.com'
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
const ROBOT_CODE_KEY = 'dingtalk:robot-code'
const MSG_DEDUP_WINDOW_MS = 60000 // 服务端未 ack 的重推间隔：60s 窗口内同 msgId 吸收
const MSG_DEDUP_MAX = 1024 // seenMsgIds 硬上限：窗口清扫后仍超量则淘汰最旧（宪法#4）
// v0.8.7 P1-7（宪法#4）：sessionWebhooks/chatSenders 以 conversationId 为键只增不减 ——
// 机器人被拉进大量群 / 陌生会话灌水时进程内存单调膨胀。1024 条上限（真实企业几十个会话，
// 三个数量级余量），超限淘汰最旧。淘汰安全：两表都是「最近一次入站学来的发送辅助信息」，
// 缺失分别回落 batchSend 兜底与「chatId 当 staffId」既有路径。
const CHAT_STATE_MAX = 1024

/** Keep only known image fields; arbitrary provider content never enters a control envelope. */
export function parseDingtalkImageMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null
  const type = String(msg.msgtype ?? '').toLowerCase()
  const candidates = []
  if (type === 'picture' || type === 'image') {
    candidates.push(msg.picture, msg.image, msg.content)
  } else if (msg.picture !== undefined || msg.image !== undefined) {
    // Mixed text + image has an explicit attachment field; do not inspect arbitrary text content.
    candidates.push(msg.picture, msg.image)
  }
  for (const candidate of candidates) {
    const image = normalizeImageAttachment(candidate)
    if (image !== null) return { kind: 'image', image }
  }
  return null
}

/** content → 6 位十六进制摘要（batchSend 无 processQueryKey 时的合成 messageId 用）。 */
function hash6(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 6)
}

/** 被动回复合成 messageId 的模块级单调序号（G-24）：同会话同内容两次回复不再同 ID。 */
let replySeq = 0

/**
 * richText 消息归一（G-23）。官方《机器人接收消息》文档形态：
 * { msgtype:'richText', content:{ richText:[ { text:'…' }, { downloadCode:'…', type:'picture' } ] } }
 * 遍历内容模块：text 段直接拼接进 text；图片段走既有 picture/image 管线
 * （normalizeImageAttachment 白名单字段 url/downloadUrl/…）。官方 downloadCode-only 图片段
 * 须另调「下载机器人接收消息的文件内容」接口才换得到临时 URL，本实现不发起该调用——
 * 解析不出安全 URL 即 fail-closed 丢弃该图片段，文本段照常投递。纯文本/纯图消息
 * （msgtype text/picture）不走本函数，行为不变。
 * @param {object} msg - data 二次 parse 后的业务消息
 * @returns {{ text: string, image: object | null } | null} 非 richText 消息返回 null
 */
function parseRichTextMessage(msg) {
  const modules = msg?.content?.richText
  if (!Array.isArray(modules)) return null
  let text = ''
  let image = null
  for (const module of modules) {
    if (module === null || typeof module !== 'object' || Array.isArray(module)) continue
    if (typeof module.text === 'string') text += module.text
    if (image === null) {
      // 图片模块走既有 picture/image 管线：模块本体或其 picture/image 子字段，任一能归一
      // 出安全 URL 即采用（首个命中为准）
      const candidate = normalizeImageAttachment(module)
        ?? normalizeImageAttachment(module.picture)
        ?? normalizeImageAttachment(module.image)
      if (candidate !== null) image = candidate
    }
  }
  return { text, image }
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
 * @param {object} [options.strings] - stringsOf(lang) 全文案表（读 `dingtalk` 节，跨节复用
 *   approval.fallbackText；缺省回落 zh——须先在 strings.mjs 落 `dingtalk` 节）
 */
export function createDingtalkInbound(options = {}) {
  const { config, bus, store = null, fallbackTargets = [], logger = null, identity = null } = options
  const STRINGS = options.strings ?? stringsOf()
  const t = STRINGS.dingtalk
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

  // debug 日志（G-02 SYSTEM 子类观察用）：仅宿主 logger，不双写 stderr——不是事故信号，
  // 无 debug 通道的宿主静默丢弃即可（KEEPALIVE 可能周期性到来，刷 stderr 反成噪音）。
  const debug = (message) => {
    try { logger?.debug?.('[dsh-notifier/inbound:dingtalk]', message) } catch { /* 日志失败绝不致命 */ }
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
    // G-55：同族归一——expires_in 非法（非有限/≤0）不再 || 7200 掩盖（同值不同命：
    // 0 在钉钉层曾活 7200s、在 wecom 层只活 1s）
    return { token: payload.access_token, expiresInMs: normalizeTtlMs(Number(payload.expires_in) * 1000, 'expires_in') }
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
  // 两表均有界（CHAT_STATE_MAX，setBounded 淘汰最旧；见文件头常量注释）
  const sessionWebhooks = new Map()
  const chatSenders = new Map()
  const seenMsgIds = new Map() // msgId → 首见时间戳（60s 重推吸收窗口 + MSG_DEDUP_MAX 硬顶）
  const warnChatStateEvicted = createThrottledWarn(warn)
  const warnDedupEvicted = createThrottledWarn(warn)

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
        // G-10：字段名就是 ua。三版官方 SDK（dingtalk-stream 2.1.4 / 2.1.6-beta.1 /
        // 2.1.7-beta.1）getEndpoint 全系 `ua: this.config.ua`；旧注释所称「官方 SDK 拼写
        // 错误字段名 uesrAgent，服务端认的就是它，照抄勿改」经三版源码核对查无实据，勿再犯。
        ua: 'dsh-notifier',
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

  /**
   * 每条业务帧都回执（未 ack 服务端 60s 重推）。
   * G-01（三版 SDK 源码核对）：messageId 只存在于 frame.headers.messageId（DWClientDownStream
   * 顶层无该字段）；回执头字段名就是 messageId（不是 requestId）；data 是 JSON 字符串
   * JSON.stringify('OK') === '"OK"'（不是裸 'ack'）。
   */
  function ackFrame(messageId) {
    if (messageId === '') return
    sendFrame({
      code: 200,
      headers: { contentType: 'application/json', messageId },
      data: JSON.stringify('OK'),
    })
  }

  /**
   * msgId 去重：60s 窗口内同 msgId 视为服务端重推，吸收不二次投递（惰性清扫防膨胀）。
   * v0.8.7（宪法#4）：原实现只在 size>1024 时清「已过窗口」的条目——60s 内涌入上万条
   * 新 msgId（群灌水/攻击）时无一条过期，表继续无界涨。补硬上限：清扫后仍超量则淘汰
   * 最旧（最旧条目离过窗最近，淘汰它最不影响去重语义；窗口内去重照旧生效）。
   * 清扫阈值必须是 `>=` 而非 `>`：setBounded 保证写后 size <= MSG_DEDUP_MAX，
   * `>` 永不成立会让惰性清扫变成死代码——稳态高流量主机每条新消息都走「淘汰 + 告警」，
   * 白丢去重记录还刷日志（自审发现的自引入缺陷）。表满即先清过窗条目，清不出空位才淘汰。
   */
  function isFreshMsgId(msgId) {
    const now = Date.now()
    if (seenMsgIds.size >= MSG_DEDUP_MAX) {
      for (const [id, at] of seenMsgIds) {
        if (now - at >= MSG_DEDUP_WINDOW_MS) seenMsgIds.delete(id)
      }
    }
    if (seenMsgIds.has(msgId)) return false
    const evicted = setBounded(seenMsgIds, msgId, now, MSG_DEDUP_MAX)
    if (evicted > 0) {
      warnDedupEvicted((count) => `钉钉入站去重表达上限 ${MSG_DEDUP_MAX}（60s 窗口内消息量异常），已淘汰 ${evicted} 条最旧记录${count > 1 ? `（近期累计 ${count} 次）` : ''}`)
    }
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
      const evicted = setBounded(
        sessionWebhooks,
        chatId,
        { url: webhook, expiredAt: Number(msg.sessionWebhookExpiredTime) || 0 },
        CHAT_STATE_MAX,
      )
      if (evicted > 0) {
        warnChatStateEvicted((count) => `钉钉会话状态表达上限 ${CHAT_STATE_MAX}，已淘汰最旧会话的 sessionWebhook（受影响会话回复改走主动推送兜底）${count > 1 ? `（近期累计 ${count} 次）` : ''}`)
      }
    }
    // 主动推送兜底目标（batchSend 要 staffId 而非 conversationId）；同样有界
    setBounded(chatSenders, chatId, userId, CHAT_STATE_MAX)
    // G-23：richText 消息（msgtype:'richText'）先归一（text 段拼接、图片段走既有管线）；
    // 非 richText 消息 parseRichTextMessage 返回 null，走原 text/picture 路径，行为不变
    const rich = parseRichTextMessage(msg)
    const image = rich !== null && rich.image !== null
      ? { kind: 'image', image: rich.image }
      : parseDingtalkImageMessage(msg)
    // G-06：@ 机器人剥离（钉钉群消息行首 '@机器人名 ' 字面提及；命令词 @ 后缀一并剥）。
    // 不剥会污染 agent 语境与 /pair 参数。行首只剥一处 '@名字'（名字后须有空白分隔），
    // 正文中间的 @ 不动；剥完为空 → 走下方既有空消息分支（不投递）。
    const text = stripCommandMention(stripLeadingMention(
      (rich === null ? String(msg.text?.content ?? '') : rich.text).trim(),
    ))
    if (text === '' && image === null) return
    // v0.7：conversationType 透传（'1' 单聊 / '2' 群聊，/pair 私聊判定）；
    // accept 返回值消费——拒绝/命令回执不再已读不回
    const result = bus.accept({
      channel: 'dingtalk',
      accountId: String(config?.appKey ?? ''),
      userId,
      chatId,
      chatType: String(msg.conversationType ?? ''),
      messageId: `dt:${msgId}`,
      text: text || '[图片消息]',
      ...(image === null ? {} : { image: image.image, ...(text === '' ? { kind: 'image' } : {}) }),
    })
    if (result?.reply !== undefined) {
      sendReply(chatId, String(result.reply)).catch((error) => {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
      })
    }
  }

  /**
   * SYSTEM 帧分发（G-02）。SDK 三版（2.1.4/2.1.6-beta.1/2.1.7-beta.1）onSystem 均按
   * headers.topic 分派子类：ping → 原样回显 { code:200, headers, data }（data 含必须回显的
   * opaque）；disconnect/KEEPALIVE/REGISTERED/CONNECTED → 仅记日志，不回显、不进业务路径。
   * 判定字段取 topic ∪ method ∪ event_type/eventType 并集：本批次仲裁结论点名
   * method/event_type，SDK 源码用 topic，无真机帧样本可裁决，并集防御性兼容；均未命中一律
   * 按「非 ping 的 SYSTEM 子类」处理（fail-closed，不回显不投递）。
   * 注意：这里是应用层 SYSTEM 帧，与传输层 WS 协议 ping/pong（原生 WebSocket 自动应答）是
   * 两码事，不得合并处理。
   */
  function handleSystemFrame(frame) {
    const headers = (frame.headers !== null && typeof frame.headers === 'object') ? frame.headers : {}
    const marker = String(headers.topic ?? headers.method ?? headers.event_type ?? headers.eventType ?? '').toLowerCase()
    if (marker === 'ping') {
      sendFrame({ code: 200, headers: frame.headers, data: frame.data })
      return
    }
    debug(`SYSTEM 子类 ${marker === '' ? '(未标注)' : marker} 不进业务路径（messageId=${String(headers.messageId ?? '')}）`)
  }

  function handleFrame(raw) {
    let frame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    if (frame === null || typeof frame !== 'object') return
    // G-02：SYSTEM 帧独立分发（ping 回显 / 其余 debug 后返回），一律不进业务路径、不走业务 ack
    if (frame.type === 'SYSTEM') {
      handleSystemFrame(frame)
      return
    }
    // G-01：messageId 只在 frame.headers.messageId（顶层无该字段，旧实现读顶层恒为空）
    const messageId = String(frame.headers?.messageId ?? '')
    ackFrame(messageId) // 先回执再处理：处理异常也不该挨 60s 重推
    if (frame.data === undefined || frame.data === null) return
    let data = frame.data // data 本身又是 JSON 字符串：二次 parse
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        // G-42：parse 失败不再静默——ack 已回执、服务端不会重推，丢消息至少要可观测
        warn(`data 二次 parse 失败，本条丢弃（ack 已回执，服务端不会重推）: messageId=${messageId} type=${String(frame.type ?? '')} data=${String(frame.data).slice(0, 64)}`)
        return
      }
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
        // G-24：旧 hash6(`${chatId}:${content}`) 合成在同会话同内容两次回复时必然同 ID
        // （回执关联/去重会把两次回复折叠成一条）。改为 时间戳36 + 模块级单调序号36：唯一、
        // 可读、跨进程重启不保证唯一（重启后 seq 归零，但同一毫秒内重启两次不现实）。
        return { messageId: `dt:reply-${Date.now().toString(36)}-${(++replySeq).toString(36)}` }
      }
    } catch (error) {
      warn(`sessionWebhook 回复失败，改走主动推送兜底: ${error instanceof Error ? error.message : String(error)}`)
    }
    return batchSend(chatSenders.get(target) ?? target, content)
  }

  return {
    channel: 'dingtalk',
    accountId: String(config?.appKey ?? ''),
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
      const text = STRINGS.approval.fallbackText(title, content)
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
        await sendReply(String(target.chatId), t.resultLine(text))
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
