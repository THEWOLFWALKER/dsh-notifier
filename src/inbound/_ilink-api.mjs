// dsh-notifier inbound/_ilink-api.mjs
// 腾讯 iLink Bot API 裸协议层（v0.3.0 阶段 4）。
// 移植来源（MIT）：Hermes weixin.py（refs/weixin/weixin.py 行 91-126/231-251/400-502）
// 交叉验证 openclaw-weixin api.ts 与协议文档（weixin-ilink.md / wechatbot.dev）。
// 全部零依赖：fetch + node:crypto。
//
// 协议要点（生产实证，全部来自 Hermes 2026-05/08 日志踩坑记录）：
//  - 每请求头：AuthorizationType/Authorization Bearer <bot_token>；X-WECHAT-UIN =
//    base64(String(random_uint32)) 防重放（每次重生成，绝不能缓存）；ClientVersion 0x020200
//  - 所有 POST body 自动附加 base_info {channel_version: "2.2.0"}（协议版本锁定，防漂移）
//  - getupdates 长轮询 35s 挂起；超时视作空轮询（游标原样带回）
//  - sendmessage：msg.to_user_id + context_token 回显（无 token 时省略字段）
//  - 错误语义：
//      ret/errcode = -14                → 会话过期（重扫码登录）
//      ret/errcode = -2 + errmsg="unknown error" → 实为 stale context_token（伪装成限流）
//      ret/errcode = -2 其他 errmsg     → 真限流（熔断计数）

import { randomInt } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CHANNEL_VERSION = '2.2.0'
export const ILINK_APP_ID = 'bot'
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0) // 0x020200

export const EP_GET_UPDATES = 'ilink/bot/getupdates'
export const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
export const EP_GET_BOT_QRCODE = 'ilink/bot/get_bot_qrcode'
export const EP_GET_QRCODE_STATUS = 'ilink/bot/get_qrcode_status'

export const LONG_POLL_TIMEOUT_MS = 35_000
export const API_TIMEOUT_MS = 15_000

export const SESSION_EXPIRED_ERRCODE = -14
export const RATE_LIMIT_ERRCODE = -2

// 消息结构常量（weixin.py 行 167-175）
export const ITEM_TEXT = 1
export const MSG_TYPE_BOT = 2
export const MSG_STATE_FINISH = 2

/** X-WECHAT-UIN：base64(String(random_uint32))，防重放，每请求重生成。 */
export function randomWechatUin() {
  return Buffer.from(String(randomInt(0, 2 ** 32)), 'utf8').toString('base64')
}

/** POST 请求头（token 缺省时省略 Authorization——登录前的 QR 流程用 GET，不需要）。 */
export function ilinkHeaders(token) {
  const headers = {
    'content-type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** GET 请求头（QR 流程无 token；对照 weixin.py _api_get 只带 App 头）。 */
export function ilinkGetHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
}

/** stale context_token 判定：-2 + errmsg 恰为 "unknown error"（伪装限流）。 */
export function isStaleSessionRet(ret, errcode, errmsg) {
  if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) return false
  return String(errmsg ?? '').toLowerCase() === 'unknown error'
}

/**
 * 归类 iLink 响应（getupdates / sendmessage 共用错误语义）。
 * @returns {{ ok: true } | { ok: false, kind: 'session-expired' | 'rate-limited' | 'error',
 *            ret: number, errcode: number, errmsg: string }}
 */
export function classifyIlinkResponse(response) {
  const ret = typeof response?.ret === 'number' ? response.ret : 0
  const errcode = typeof response?.errcode === 'number' ? response.errcode : 0
  if (ret === 0 && errcode === 0) return { ok: true }
  const errmsg = String(response?.errmsg ?? response?.msg ?? '')
  if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
    return { ok: false, kind: 'session-expired', ret, errcode, errmsg }
  }
  if (isStaleSessionRet(ret, errcode, errmsg)) {
    return { ok: false, kind: 'session-expired', ret, errcode, errmsg }
  }
  if (ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE) {
    return { ok: false, kind: 'rate-limited', ret, errcode, errmsg }
  }
  return { ok: false, kind: 'error', ret, errcode, errmsg }
}

/** 从入站 msgs[].item_list 提取文本（type=1 text_item.text；引用消息拼前缀）。 */
export function extractIlinkText(itemList) {
  if (!Array.isArray(itemList)) return ''
  for (const item of itemList) {
    if (item?.type !== ITEM_TEXT) continue
    const text = String(item?.text_item?.text ?? '')
    const ref = item?.ref_msg
    if (ref !== null && typeof ref === 'object' && Object.keys(ref).length > 0) {
      const parts = [String(ref.title ?? ''), extractIlinkText([ref.message_item].filter(Boolean))]
      const joined = parts.filter((part) => part !== '').join(' | ')
      return `[引用: ${joined}]\n${text}`.trim()
    }
    return text
  }
  return ''
}

/**
 * 创建 iLink API 客户端。
 * @param {object} options
 * @param {string} [options.baseUrl=ILINK_BASE_URL] - 登录返回的 baseurl 恒优先（跨机房切换）
 * @param {string} [options.token] - bot_token
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用）
 */
export function createIlinkClient(options = {}) {
  const baseUrl = String(options.baseUrl ?? ILINK_BASE_URL).replace(/\/+$/, '')
  const token = String(options.token ?? '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)

  async function post(endpoint, payload, { timeoutMs = API_TIMEOUT_MS, signal } = {}) {
    if (fetchImpl === undefined) throw new Error('当前运行时无 fetch')
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
    const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: ilinkHeaders(token),
      body,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw new Error(`iLink POST ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }
    return response.json()
  }

  async function get(endpoint, { timeoutMs = API_TIMEOUT_MS } = {}) {
    if (fetchImpl === undefined) throw new Error('当前运行时无 fetch')
    const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      method: 'GET',
      headers: ilinkGetHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw new Error(`iLink GET ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }
    return response.json()
  }

  return {
    baseUrl,
    /** 长轮询（35s 挂起；signal 由调用方在 stop() 时打断）。 */
    getUpdates(syncBuf, { timeoutMs = LONG_POLL_TIMEOUT_MS, signal } = {}) {
      return post(EP_GET_UPDATES, { get_updates_buf: String(syncBuf ?? '') }, { timeoutMs, signal })
    },
    /** 发文本（contextToken 缺省省略字段；无 token 可能落错会话窗口，尽量先入站学习）。 */
    sendMessage({ to, text, contextToken = '', clientId }) {
      const msg = {
        from_user_id: '',
        to_user_id: String(to ?? ''),
        client_id: String(clientId ?? ''),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text: String(text ?? '') } }],
      }
      if (contextToken !== '') msg.context_token = String(contextToken)
      return post(EP_SEND_MESSAGE, { msg })
    },
    /** 登录第一步：取二维码（qrcode=hex token；qrcode_img_content=可扫 liteapp URL）。 */
    getBotQrcode(botType = '3') {
      return get(`${EP_GET_BOT_QRCODE}?bot_type=${encodeURIComponent(botType)}`)
    },
    /** 登录轮询：status ∈ wait|scaned|scaned_but_redirect|expired|confirmed。 */
    getQrcodeStatus(qrcode) {
      return get(`${EP_GET_QRCODE_STATUS}?qrcode=${encodeURIComponent(qrcode)}`)
    },
  }
}
