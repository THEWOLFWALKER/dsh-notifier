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
})

/** 带稳定错误码的推送失败，message 一律为中文指引（模型与用户都读）。 */
export class NotifyError extends Error {
  code = ERROR_CODES.NETWORK_ERROR

  constructor(message, code = ERROR_CODES.NETWORK_ERROR) {
    super(message)
    this.name = 'NotifyError'
    this.code = code
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
  const error = new NotifyError(`${channel}返回 HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ''}`, ERROR_CODES.HTTP_ERROR)
  error.status = response.status
  error.text = text.slice(0, 2048)
  try { error.json = JSON.parse(text) } catch { error.json = undefined }
  return error
}

/** 统一 JSON POST：AbortController 超时、非 2xx 抛 HTTP_ERROR（附响应现场）。 */
export async function postJson(url, payload, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    const detail = error instanceof Error ? error.message : String(error)
    throw new NotifyError(`${channel}请求失败: ${detail}`, ERROR_CODES.NETWORK_ERROR)
  } finally {
    clearTimeout(timer)
  }
}

/** 统一 form-encoded POST（Server酱用），同样带超时与错误分类。 */
export async function postForm(url, payload, { timeoutMs = 10000, channel = '渠道' } = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    const detail = error instanceof Error ? error.message : String(error)
    throw new NotifyError(`${channel}请求失败: ${detail}`, ERROR_CODES.NETWORK_ERROR)
  } finally {
    clearTimeout(timer)
  }
}

/** 统一 GET（token 换取用），带超时与错误分类；返回原始 Response（2xx 才 resolve）。 */
export async function getJson(url, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    const detail = error instanceof Error ? error.message : String(error)
    throw new NotifyError(`${channel}请求失败: ${detail}`, ERROR_CODES.NETWORK_ERROR)
  } finally {
    clearTimeout(timer)
  }
}

/** 统一纯文本 body POST（ntfy 旧协议用；v0.6.5 起 ntfy 走 JSON 发布，保留给未来渠道）。 */
export async function postText(url, text, { headers = {}, timeoutMs = 10000, channel = '渠道' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: String(text ?? ''),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw httpError(channel, response, await readTextCapped(response, 2048))
    }
    return response
  } catch (error) {
    if (error instanceof NotifyError) throw error
    const timedOut = error instanceof Error && error.name === 'AbortError'
    if (timedOut) throw new NotifyError(`${channel}请求超时（${timeoutMs}ms）`, ERROR_CODES.TIMEOUT)
    const detail = error instanceof Error ? error.message : String(error)
    throw new NotifyError(`${channel}请求失败: ${detail}`, ERROR_CODES.NETWORK_ERROR)
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
