// dsh-notifier adapters/_shared.mjs
// 所有渠道 adapter 共用的纯函数工具：稳定错误码、统一 fetch 封装、消息归一化。
// 零运行时依赖：只用全局 fetch + node:crypto。

/** 稳定错误码：跨渠道复用，供日志与工具渲染消费。 */
export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  HTTP_ERROR: 'HTTP_ERROR',
  API_ERROR: 'API_ERROR',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  BAD_UPSTREAM_RESPONSE: 'BAD_UPSTREAM_RESPONSE',
  // S-02（CWE-918）：SSRF 防护拦截（私网/保留段/scheme 非法），见 _urlguard.mjs
  UNSAFE_TARGET: 'UNSAFE_TARGET',
})

/**
 * 渠道键 → 用户可读中文名（公开文案用；未知键原样返回，不猜）。
 * G-53：用户不该看到 "qq-bot返回 HTTP 403" 这种适配器键拼英文句子。
 */
const CHANNEL_NAMES = {
  telegram: 'Telegram',
  feishu: '飞书',
  dingtalk: '钉钉',
  'qq-bot': 'QQ 官方机器人',
  'wecom-app': '企业微信应用',
  wxpusher: 'WxPusher',
  pushplus: 'PushPlus',
  serverchan: 'Server酱',
  bark: 'Bark',
  webhook: 'Webhook',
  bell: '铃铛',
  desktop: '桌面通知',
}

/** 渠道键转中文名（公开文案专用；未登记键原样透传）。 */
export function channelNameOf(key) {
  const name = CHANNEL_NAMES[String(key ?? '')]
  return name !== undefined ? name : (String(key ?? '') || '渠道')
}

/**
 * 带稳定错误码的推送失败。G-53 公开/内部分层：
 *  - message / publicMessage：公开文案（failed[].error、health detail、工具反馈、LLM 可见），
 *    不含响应体片段、底层网络原文、机器路径。
 *  - detail：内部细节（完整 HTTP 状态+响应体、底层 fetch 错误原文），仅进日志（warn/stderr），
 *    绝不进任何对用户可见的表面。
 * 未显式分层的旧构造（各 adapter 的中文指引文案）两个字段同值——那些文案本身就是
 * 面向用户的指引，公开无害。
 */
export class NotifyError extends Error {
  code = ERROR_CODES.NETWORK_ERROR
  publicMessage = ''
  detail = ''

  constructor(message, code = ERROR_CODES.NETWORK_ERROR, { detail } = {}) {
    super(message)
    this.name = 'NotifyError'
    this.code = code
    this.publicMessage = message
    this.detail = detail ?? message
  }
}

/** 取字符串配置项，trim 后返回（非字符串一律当空串）。 */
export function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取数字配置项，非有限数回退默认值。 */
export function num(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * v0.6.5（审查 R4-3-P3-3）：带上限读响应体。自托管端点（gotify/ntfy/onebot/mattermost
 * 的 baseUrl 任意可配）故障或恶意回包时可返回超大 body——原 response.text() 全量读入
 * 后才截断，内存与日志被放大。流式读前 cap 字符后主动 cancel。
 */
export async function readTextCapped(response, cap = 65536) {
  const body = response?.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ''
    try {
      while (out.length < cap) {
        const { done, value } = await reader.read()
        if (done) break
        out += decoder.decode(value, { stream: true })
      }
    } catch { /* 读取中断：已读部分尽力返回 */ } finally {
      try { reader.cancel().catch(() => {}) } catch { /* 已完结的 reader：无害 */ }
    }
    return out.slice(0, cap)
  }
  try { return (await response.text()).slice(0, cap) } catch { return '' }
}

/**
 * v0.6.5（审查 R4-3-P2-2）：构造非 2xx 的 HTTP_ERROR，并把 status/json/text 附在错误上。
 * 原实现 post* 直接抛「渠道返回 HTTP xxx: 响应体片段」，spec.fail 里精心写的中文排障
 * 指引（slack 403 去哪换 webhook、discord 404 重建、ntfy error 字段）在真实失败路径上
 * 永不可达。engine 现在会捕获 HTTP_ERROR 并拿现场调 spec.fail 合成指引。
 */
function httpError(channel, response, text) {
  // G-53 分层：公开文案只保留渠道中文名 + HTTP 状态码（排障必需且无内部信息）；
  // 响应体片段（可能含网关内部地址、HTML 错误页原文）只进 detail（日志专用）。
  const name = channelNameOf(channel)
  const error = new NotifyError(`${name}推送失败（HTTP ${response.status}）`, ERROR_CODES.HTTP_ERROR, {
    detail: `${channel}返回 HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ''}`,
  })
  error.status = response.status
  error.text = text.slice(0, 2048)
  try { error.json = JSON.parse(text) } catch { error.json = undefined }
  // G-08：TG 等网关 429 带 `parameters.retry_after`（秒）。解析出即附着 retryAfterMs，
  // 供 sendWithRetry 将退避抬到平台指定值（不再用固定 backoff 撞同一堵墙）。
  const retryAfter = Number(error.json?.parameters?.retry_after)
  if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000
  return error
}

/**
 * G-50：超时错误统一构造。超时 = 请求可能已到达对端，结果未知——盲目重试会造成
 * at-least-once 重复通知。标记 noRetry=true 让 sendWithRetry 立即放弃并计入 failed，
 * 错误码保持 TIMEOUT（宿主按码统计不受影响）。确定性失败（连接拒绝、HTTP 4xx/5xx
 * 明确响应）不经过这里，维持既有重试语义。
 */
function timeoutNoRetryError(channel, timeoutMs) {
  const error = new NotifyError(`${channelNameOf(channel)}投递超时（${timeoutMs}ms），结果未知，不再重试`, ERROR_CODES.TIMEOUT)
  error.noRetry = true
  return error
}

/** G-53 分层：网络层错误（DNS/连接/TLS）公开文案不带底层 message——里面可能有代理地址、证书路径、机器路径。 */
function networkError(channel, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new NotifyError(`${channelNameOf(channel)}网络连接失败`, ERROR_CODES.NETWORK_ERROR, {
    detail: `${channel}请求失败: ${detail}`,
  })
}

/**
 * S-02（CWE-918）：所有出站 fetch 一律 redirect:'manual'，3xx 视为失败。
 * 重定向可把「已校验的公网 URL」绕到任意内网地址——任何未来加的 URL 校验都会被
 * 一次 302 穿透，故重定向面在这里统一关闭（竞品 telegram-api/dingtalk-api 客户端
 * 同样 redirect:'error'，显式拒绝有先例）。Location 只进 detail（日志），不回显。
 */
function redirectError(channel, response) {
  const location = (() => { try { return response.headers?.get?.('location') ?? '' } catch { return '' } })()
  const name = channelNameOf(channel)
  return new NotifyError(`${name}推送失败（HTTP ${response.status} 重定向，已拒绝跟随）`, ERROR_CODES.HTTP_ERROR, {
    detail: `${channel}返回 HTTP ${response.status} → ${location === '' ? '(无 Location 头)' : location.slice(0, 512)}`,
  })
}

/** S-02：统一注入 redirect:'manual' 并对 3xx 显式报错（见 redirectError 注释）。 */
async function guardedFetch(url, init, channel) {
  const response = await fetch(url, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw redirectError(channel, response)
  return response
}

/** 统一 JSON POST：AbortController 超时、非 2xx 抛 HTTP_ERROR（附响应现场）。 */
export async function postJson(url, payload, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }, channel)
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw timeoutNoRetryError(channel, timeoutMs)
    throw networkError(channel, error)
  } finally {
    clearTimeout(timer)
  }
}

/** 统一 form-encoded POST（Server酱用），同样带超时与错误分类；超时同 G-50 语义（noRetry）。 */
export async function postForm(url, payload, { timeoutMs = 10000, channel = '渠道' } = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: controller.signal,
    }, channel)
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw timeoutNoRetryError(channel, timeoutMs)
    throw networkError(channel, error)
  } finally {
    clearTimeout(timer)
  }
}
// ^ postForm 的超时分支与 postJson 同语义（G-50）：Server酱投递走这条路径，
// 超时后盲目重试同样会造成重复通知，不能只修 postJson 留下这条漏网。

/** 统一 GET（token 换取用），带超时与错误分类；返回原始 Response（2xx 才 resolve）。 */
export async function getJson(url, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, { method: 'GET', headers, signal: controller.signal }, channel)
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    throw networkError(channel, error)
  } finally {
    clearTimeout(timer)
  }
}

/** 统一纯文本 body POST（ntfy 旧协议用；v0.6.5 起 ntfy 走 JSON 发布，保留给未来渠道）。 */
export async function postText(url, text, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      // G-45：纯文本 body 必须显式声明 content-type——不声明时 undici 会嗅探出
      // text/plain;charset=UTF-8，但语义上"默认"应来自调用方；显式声明同时防
      // 接收端按 JSON 误解析。调用方同名头覆盖默认值（展开序保证）。
      headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
      body: String(text ?? ''),
      signal: controller.signal,
    }, channel)
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    throw networkError(channel, error)
  } finally {
    clearTimeout(timer)
  }
}

/** 读响应 JSON，解析失败抛 API_ERROR（带中文指引）。 */
export async function responseJson(response, channel, { requireKey, successValue } = {}) {
  let body
  try {
    body = await response.json()
  } catch {
    throw new NotifyError(`${channel}返回非 JSON 响应（HTTP ${response.status}）`, ERROR_CODES.API_ERROR)
  }
  if (requireKey !== undefined && body?.[requireKey] !== successValue) {
    const detail = body?.errmsg ?? body?.message ?? body?.description ?? ''
    throw new NotifyError(
      `${channel}返回错误（${requireKey} != ${successValue}）${detail.length > 0 ? `: ${detail}` : ''}`,
      ERROR_CODES.API_ERROR,
    )
  }
  return body
}
