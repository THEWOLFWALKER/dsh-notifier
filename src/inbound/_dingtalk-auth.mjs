// dsh-notifier inbound/_dingtalk-auth.mjs
// 钉钉开放平台设备授权流（RFC 8628 形态）：init（取码）→ begin（取二维码）→ poll（轮询凭证）。
// 端点/字段语义移植自 xmanrui/dsh-im device-auth.mjs（MIT），改写为零依赖 fetch。
//
// 定位：纯协议层——不碰 store、不碰 UI、不落盘（凭证只经 poll 的成功响应交给调用方）。
//
// 端点链（均相对 baseUrl，默认 https://oapi.dingtalk.com）：
//  1) POST /app/registration/init   body { registration_type: 2, template_types: [2] }
//     → { result: { verification_code, expire_in } }
//  2) POST /app/registration/begin  body { verification_code }
//     → { result: { qr_code_url, expire_in } }（二维码渲染交给 CLI/UI，本层只回 URL）
//  3) GET  /app/registration/poll?verification_code=xxx
//     → { result: { status, app_key?, app_secret?, fail_reason? } }
//     归一化：status 大写化 ∈ WAITING/SUCCESS/FAIL/EXPIRED；SUCCESS 时蛇形转驼峰出 credentials。
//
// 错误码七类（error.code，init/begin/poll 三步统一归类）：
//   timeout                 请求超时（AbortSignal.timeout 触发的 AbortError/TimeoutError）
//   http-error              HTTP 非 2xx
//   invalid-json            2xx 但响应体不是 JSON
//   api-error               服务端业务错误（errcode ≠ 0 / poll 返回未知 status）
//   network-error           fetch 抛错（DNS/断连/当前运行时无 fetch）
//   missing-field           响应结构缺陷（init 缺 verification_code、begin 缺 qr_code_url、
//                           poll 缺 status、调用方漏传 verificationCode）
//   incomplete-registration poll 已 SUCCESS 但 app_key/app_secret 不齐（半截凭证不如不给）
// 另有前置错误 invalid-base-url（工厂参数期校验，不属请求期七类）：baseUrl 非 https 或非 dingtalk.com 域。
//
// 安全军规（对应实现计划 §0.2 钉钉行）：
//  - baseUrl 白名单强校验（https + dingtalk.com / *.dingtalk.com）——防任意 URL 注入（SSRF）
//  - 错误对象与错误消息永不携带凭证值：app_secret/app_key 只出现在成功响应的 credentials 里；
//    非 2xx 响应体摘录必须先脱敏（疑似凭证字段按字段名掩码），无法安全脱敏（非 JSON 体）则整体省略
//  - 超时统一 AbortSignal.timeout(timeoutMs)，每请求独立信号
//  - fetchImpl 缺省回落 globalThis.fetch 且不重绑（保持引用相等，便于注入测试）
// 全部零依赖：仅用全局 fetch，无任何 import（node 内置模块也用不上）。

export const DINGTALK_BASE_URL = 'https://oapi.dingtalk.com'
export const DEFAULT_TIMEOUT_MS = 10_000

export const EP_REGISTRATION_INIT = '/app/registration/init'
export const EP_REGISTRATION_BEGIN = '/app/registration/begin'
export const EP_REGISTRATION_POLL = '/app/registration/poll'

// poll 归一化四态（服务端原始 status 大写化后落进这个集合）
export const POLL_WAITING = 'WAITING'
export const POLL_SUCCESS = 'SUCCESS'
export const POLL_FAIL = 'FAIL'
export const POLL_EXPIRED = 'EXPIRED'

// 错误码七类清单（CLI 层据此映射中文指引）
export const AUTH_ERROR_CODES = Object.freeze([
  'timeout',
  'http-error',
  'invalid-json',
  'api-error',
  'network-error',
  'missing-field',
  'incomplete-registration',
])

// 疑似凭证字段名（错误摘录脱敏用：宁可误掩，不可漏掩）
const SENSITIVE_KEY_RE = /secret|token|credential|app_?key|key/i

/** 造带 code 的 Error（detail 里允许的键：endpoint/httpStatus/errcode——绝不放凭证值）。 */
function authError(code, message, detail = {}) {
  const error = new Error(message)
  error.code = code
  for (const key of Object.keys(detail)) {
    if (detail[key] !== undefined) error[key] = detail[key]
  }
  return error
}

/** AbortSignal.timeout 触发的两种 DOMException（AbortError/TimeoutError）都算超时。 */
function isAbortError(error) {
  const name = error?.name ?? ''
  return name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR'
}

/**
 * 错误摘录脱敏（递归）：仅当响应体是 JSON 时按字段名掩码后截断；
 * 敏感字段嵌套在任意深度都掩（宁可误掩，不可漏掩）；
 * 非 JSON / 非对象体无法可靠脱敏 → 返回空串整体省略（军规「凭证永不进错误」优先于可诊断性）。
 */
function redact(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }
  const masked = maskValueDeep(parsed, 0)
  return JSON.stringify(masked).slice(0, 300)
}

/** 递归掩码：敏感键 → '***'；对象/数组下钻；下钻深度封顶 4（防循环引用/深嵌套炸弹）。 */
function maskValueDeep(value, depth) {
  if (depth > 4) return '...'
  if (Array.isArray(value)) return value.map((item) => maskValueDeep(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '***' : maskValueDeep(item, depth + 1)
    }
    return out
  }
  return value
}

/** 取第一个非空字符串（服务端错误文案可能落在多个字段名上，蛇形/驼峰都兜住）。 */
function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return String(value)
  }
  return ''
}

/** expire_in 归一：正有限数才透传，否则 0（调用方按 0 = 未知处理）。 */
function toExpireSeconds(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * baseUrl 强校验 + 归一（防任意 URL 注入）：
 *  - 协议必须 https（拒绝 http:// 与其他 scheme）
 *  - hostname 必须等于 dingtalk.com 或以 .dingtalk.com 结尾（evil-dingtalk.com / x.evil.com 一律拒）
 *  - 归一去尾斜杠；URL 构造器顺带把 host 大小写归一
 * @throws {Error} code=invalid-base-url
 * @returns {string} 归一后的 baseUrl（无尾斜杠）
 */
export function validateDingtalkBaseUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw ?? ''))
  } catch {
    throw authError('invalid-base-url', '钉钉授权 baseUrl 无法解析为 URL')
  }
  if (parsed.protocol !== 'https:') {
    throw authError('invalid-base-url', `钉钉授权 baseUrl 必须为 https 协议（当前 ${parsed.protocol}//）`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'dingtalk.com' && !host.endsWith('.dingtalk.com')) {
    throw authError('invalid-base-url', `钉钉授权 baseUrl 域名必须为 dingtalk.com 或其子域（当前 ${host}）`)
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * 创建钉钉设备授权客户端（纯协议层，无状态轮询循环——节奏由调用方掌握）。
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - fetch 注入（测试用；缺省回落 globalThis.fetch，不重绑）
 * @param {string} [options.baseUrl=DINGTALK_BASE_URL] - 必须是 https://*.dingtalk.com
 * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS] - 单请求超时（AbortSignal.timeout）
 * @param {() => number} [options.now=Date.now] - 时钟注入（记录 start 时序供调试；协议层
 *        不做本地过期短路——过期判定以服务端 poll 响应为准，避免与服务端状态漂移）
 * @returns {{ start: () => Promise<{verificationCode: string, qrUrl: string, expireIn: number}>,
 *             poll: (verificationCode: string) => Promise<{status: string, credentials?: {appKey: string, appSecret: string}, error?: string}>,
 *             baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch }}
 */
export function createDingtalkAuth({
  fetchImpl,
  baseUrl = DINGTALK_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  // 参数期即校验（fail-fast）：非法 baseUrl 在工厂调用时就抛，绝不等到发请求
  const normalizedBaseUrl = validateDingtalkBaseUrl(baseUrl)
  const impl = fetchImpl ?? globalThis.fetch
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS

  // start 时序记录（now 注入的落点；仅内部记录，不影响任何请求行为）
  const timing = { startedAt: null, expiresAt: null }

  /**
   * 统一请求：超时信号 + 七类错误归类。
   * GET 不带 body 也不带 content-type；POST body 为 JSON 字符串。
   * @throws {Error} code ∈ timeout/http-error/invalid-json/api-error/network-error
   */
  async function request(method, path, { body } = {}) {
    if (typeof impl !== 'function') {
      throw authError('network-error', `钉钉授权 ${path} 不可用：当前运行时无 fetch`, { endpoint: path })
    }
    const init = { method, signal: AbortSignal.timeout(requestTimeoutMs) }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await impl(`${normalizedBaseUrl}${path}`, init)
    } catch (error) {
      if (isAbortError(error)) {
        throw authError('timeout', `钉钉授权 ${path} 请求超时（${requestTimeoutMs}ms）`, { endpoint: path })
      }
      throw authError('network-error', `钉钉授权 ${path} 网络异常: ${error?.message ?? String(error)}`, { endpoint: path })
    }
    if (!response?.ok) {
      const status = response?.status ?? 0
      const raw = await response.text().catch(() => '')
      const detail = redact(raw) // 军规：摘录先脱敏，脱不了敏就不带
      throw authError(
        'http-error',
        `钉钉授权 ${path} HTTP ${status}${detail !== '' ? `: ${detail}` : ''}`,
        { endpoint: path, httpStatus: status },
      )
    }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw authError('invalid-json', `钉钉授权 ${path} 响应非 JSON: ${error?.message ?? String(error)}`, { endpoint: path })
    }
    // 钉钉 oapi 错误信封：errcode ≠ 0（数字或数字串）即业务错误
    const errcode = payload?.errcode
    if (errcode !== undefined && errcode !== null && Number(errcode) !== 0) {
      throw authError(
        'api-error',
        `钉钉授权 ${path} 服务端错误 errcode=${errcode} errmsg=${firstText(payload?.errmsg, payload?.err_msg)}`,
        { endpoint: path, errcode: Number(errcode) },
      )
    }
    return payload
  }

  /** 从响应里安全取 result 对象（缺失/非对象返回 null；不读任何凭证值）。 */
  function resultOf(payload) {
    if (payload !== null && typeof payload === 'object' && payload.result !== null && typeof payload.result === 'object') {
      return payload.result
    }
    return null
  }

  /**
   * 第一步 + 第二步串联：init 取 verification_code → begin 取 qr_code_url。
   * 任一步失败抛带 code 的 Error；成功返回冻结的 { verificationCode, qrUrl, expireIn }。
   */
  async function start() {
    // 1) init：注册流初始化，拿 verification_code（设备授权码）
    const initPayload = await request('POST', EP_REGISTRATION_INIT, {
      body: { registration_type: 2, template_types: [2] },
    })
    const initResult = resultOf(initPayload)
    const rawCode = initResult?.verification_code
    if (rawCode === undefined || rawCode === null || rawCode === '') {
      throw authError('missing-field', `钉钉授权 ${EP_REGISTRATION_INIT} 响应 result 缺少 verification_code`, { endpoint: EP_REGISTRATION_INIT })
    }
    const verificationCode = String(rawCode)
    const initExpireIn = toExpireSeconds(initResult?.expire_in)

    // 2) begin：凭 verification_code 取二维码地址（扫码入口）
    const beginPayload = await request('POST', EP_REGISTRATION_BEGIN, {
      body: { verification_code: verificationCode },
    })
    const beginResult = resultOf(beginPayload)
    const rawQrUrl = beginResult?.qr_code_url
    if (rawQrUrl === undefined || rawQrUrl === null || rawQrUrl === '') {
      throw authError('missing-field', `钉钉授权 ${EP_REGISTRATION_BEGIN} 响应 result 缺少 qr_code_url`, { endpoint: EP_REGISTRATION_BEGIN })
    }
    // expireIn 取 begin 响应优先（更贴近二维码真实有效期），缺省回落 init 响应，再缺省 0
    const expireIn = beginResult.expire_in === undefined || beginResult.expire_in === null
      ? initExpireIn
      : toExpireSeconds(beginResult.expire_in)

    timing.startedAt = now()
    timing.expiresAt = timing.startedAt + expireIn * 1000

    return Object.freeze({ verificationCode, qrUrl: String(rawQrUrl), expireIn })
  }

  /**
   * 第三步：轮询授权状态。FAIL/EXPIRED 是正常业务态（返回不抛），只有请求/结构层问题才抛。
   * @returns {Promise<{status: 'WAITING'|'SUCCESS'|'FAIL'|'EXPIRED',
   *                    credentials?: {appKey: string, appSecret: string}, error?: string}>}
   */
  async function poll(verificationCode) {
    const code = String(verificationCode ?? '')
    if (code === '') {
      throw authError('missing-field', `钉钉授权 ${EP_REGISTRATION_POLL} 需要 verification_code（来自 start() 返回值）`, { endpoint: EP_REGISTRATION_POLL })
    }
    const payload = await request('GET', `${EP_REGISTRATION_POLL}?verification_code=${encodeURIComponent(code)}`)
    // 服务端字段以 result 包裹为准；容错回落顶层（两种线上形态都见过）
    const result = resultOf(payload) ?? (payload !== null && typeof payload === 'object' ? payload : null) ?? {}
    const status = String(result.status ?? '').trim().toUpperCase()
    if (status === '') {
      throw authError('missing-field', `钉钉授权 ${EP_REGISTRATION_POLL} 响应缺少 status`, { endpoint: EP_REGISTRATION_POLL })
    }
    const serverError = firstText(result.fail_reason, result.failReason, result.error_msg, result.errorMsg, result.errmsg)

    if (status === POLL_SUCCESS) {
      // 军规：凭证只走这条成功路径，且必须成对完整——半截凭证不如明确报错
      const appKey = result.app_key
      const appSecret = result.app_secret
      if (String(appKey ?? '') === '' || String(appSecret ?? '') === '') {
        throw authError(
          'incomplete-registration',
          `钉钉授权 ${EP_REGISTRATION_POLL} 返回 SUCCESS 但凭证不完整（app_key/app_secret 未成对返回）`,
          { endpoint: EP_REGISTRATION_POLL },
        )
      }
      return Object.freeze({
        status: POLL_SUCCESS,
        credentials: Object.freeze({ appKey: String(appKey), appSecret: String(appSecret) }),
      })
    }
    if (status === POLL_WAITING) {
      return Object.freeze({ status: POLL_WAITING })
    }
    if (status === POLL_EXPIRED) {
      return Object.freeze({
        status: POLL_EXPIRED,
        error: serverError !== '' ? serverError : '二维码已过期，请重新 start() 获取',
      })
    }
    if (status === POLL_FAIL) {
      return Object.freeze({
        status: POLL_FAIL,
        error: serverError !== '' ? serverError : '钉钉扫码授权失败（服务端未返回原因）',
      })
    }
    // 未知状态：无法安全归一，按服务端异常归类（状态值非凭证，可进消息辅助诊断）
    throw authError('api-error', `钉钉授权 ${EP_REGISTRATION_POLL} 返回未知 status=${status}`, { endpoint: EP_REGISTRATION_POLL })
  }

  return Object.freeze({ start, poll, baseUrl: normalizedBaseUrl, timeoutMs: requestTimeoutMs, fetchImpl: impl })
}
