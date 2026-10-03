// dsh-notifier admin/server.mjs
// v0.15 Stage 4（S403）：Advanced Console 后端 = **Recovery-only**。本文件只暴露三条路由：
//   - GET  /                          管理台单页（只读 recovery UI 静态串）
//   - POST /api/auth/exchange-ticket  启动票据兑换短会话（本地鉴权握手）
//   - GET  /api/diagnostics           只读 canonical 诊断快照（support report / storage / version）
// 旧 Admin 日常写路由（bindings PUT、sessions PATCH、channel CRUD/test、member CRUD、
// pairing mint/revoke、question settlement、scan、outbound/inbound 写）连同其读路由、以及
// SSE 通知事件流（GET /api/events）一并删除——**不再存在于路由表**（能力不存在，而不是 UI 不可见）。
// 职责边界：本文件只做 HTTP 壳（鉴权 / 路由 / body 上限 / 错误映射 / ui 静态串），
// 业务语义全部委托注入的 api 对象（src/admin/api.mjs；本文件不 import 它，契约解耦：
// 任何 { getDiagnostics } 形状的对象皆可注入，测试用 fake api）。
// 安全（§0.5-6 红线）：
//  - 永远只绑 host（默认 127.0.0.1）；公网暴露管理台 = 暴露全部凭证写权限，需公网由用户自行反代
//  - /api/* 一律 Authorization: Bearer <token> 且 verifyToken(token) === true；
//    401 响应不区分缺 token / 错 token / 格式错（不给探测者任何信息）
//  - api 异常只回 status + message；其余异常一律 500 '内部错误'（堆栈绝不泄给客户端，只 warn 日志）
// 军规：任何请求处理异常绝不崩进程；请求体上限 1MB（超限 413）；stop() 幂等（二次调用不抛）。

import { createServer } from 'node:http'
import { diagnosticErrorMessage } from '../security/diagnostic.mjs'

const MAX_BODY_BYTES = 1024 * 1024
const JSON_TYPE = 'application/json; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const FALLBACK_UI = '<!DOCTYPE html><p>admin ui 未装配</p>'

/**
 * URL 段级 decode（%2F 不应劈出新段，故逐段而非整段 decode；畸编码回落原文不抛）。
 * @param {string} segment
 * @returns {string}
 */
function decodeSegment(segment) {
  try { return decodeURIComponent(segment) } catch { return segment }
}

/**
 * ApiError 识别（不 import api.mjs）：Error 且带整数 status 即契约错误，透传其 status。
 * 非法 status（越出 4xx/5xx）回落 null → 走 500，避免 writeHead 收到非法码二次抛错。
 * @param {unknown} error
 * @returns {number | null}
 */
function apiStatusOf(error) {
  if (!(error instanceof Error)) return null
  const status = error.status
  if (!Number.isInteger(status) || status < 400 || status > 599) return null
  return status
}

/**
 * 创建 Web 管理台服务器（构造即建 server，listen 由 start() 触发）。
 * Recovery-only：仅 { getDiagnostics } 需要注入（其余 api 方法在本路由表中无入口）。
 * @param {object} options
 * @param {object} options.api - Recovery 只读 API（仅 getDiagnostics 被路由表使用）
 * @param {(token: string) => boolean} options.verifyToken - Bearer token 校验（严格 === true 才放行）
 * @param {(ticket: string) => boolean} [options.verifyLaunchTicket] - 一次性启动票据校验器
 * @param {() => { token: string, expiresAt?: number }} [options.createSession] - 一次性票据兑换后的短会话创建器
 * @param {(token: string) => boolean} [options.verifySession] - HttpOnly 浏览器会话校验器
 * @param {number} [options.port=8104] - 监听端口；0 = 随机可用端口（测试用）
 * @param {string} [options.ui=''] - 单文件内嵌 HTML 串（空串时 GET / 返回最小占位页）
 * @param {string[]} [options.allowedOrigins=[]] - S-06 额外放行的 Origin（反代/HTTPS 场景）
 * @param {string[]} [options.allowedHosts=[]] - S-06 额外放行的 Host 头（反代请求头）
 * @param {object} [options.logger] - { warn(message) } 注入；日志失败绝不致命
 * @returns {{ start: () => Promise<{ port: number, address: string }>,
 *             stop: () => Promise<void>,
 *             get port(): number | null }}
 */
export function createAdminServer({ api, verifyToken, verifyLaunchTicket = null, createSession = null, verifySession = null, port = 8104, ui = '', allowedOrigins = [], allowedHosts = [], logger } = {}) {
  // Binding is an invariant, not a caller preference. Reverse proxies can connect over loopback.
  const host = '127.0.0.1'
  const warn = (message) => {
    // stderr 双写（R5 审查 R5-2-P1-2：与 api.mjs 同款纪律，web profile 下 logger 不落 stdout）
    try { logger?.warn?.('[dsh-notifier/admin:server]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/admin:server]', message) } catch { /* 控制台不可用不致命 */ }
  }
  const htmlPage = ui === '' ? FALLBACK_UI : String(ui)

  // ---- S-06（CWE-352/942）Origin/Host 第二道纵深 ----
  // Bearer 模型下浏览器不自动附带凭证（token 在 sessionStorage），经典 CSRF 难利用——
  // 反代场景仍有 Origin/Host 第二道防线：
  //  - Origin 头存在时必须在白名单（浏览器跨站请求必带；curl 等非浏览器客户端不带 → 放行，
  //    由 Bearer 鉴权兜底）；
  //  - Host 头必须在白名单（防 DNS rebinding：受害者浏览器被解析到 127.0.0.1 时
  //    Host 是攻击者域名，缺这道闸时同源策略完全失守）。
  // 服务器始终只绑定 127.0.0.1。回环 Host 自动放行 127.0.0.1/localhost/[::1] 三形态
  // （带不带端口、http/https 两种 Origin scheme 都接受）；反代请求头由
  // allowedOrigins/allowedHosts 显式注入。端口用实际监听值（port=0 测试随机分配）。
  const extraOrigins = (Array.isArray(allowedOrigins) ? allowedOrigins : []).map((value) => String(value).trim()).filter((value) => value !== '')
  const extraHostHeaders = (Array.isArray(allowedHosts) ? allowedHosts : []).map((value) => String(value).trim().toLowerCase()).filter((value) => value !== '')
  const hostVariants = ['127.0.0.1', 'localhost', '[::1]', '::1']

  /** 按实际监听端口构建当次请求的 Origin/Host 白名单（listen 前 port=0 时只比 extras）。 */
  function buildGateAllowlist() {
    const actualPort = listenInfo?.port ?? port
    const hosts = new Set(extraHostHeaders)
    const origins = new Set(extraOrigins)
    for (const variant of hostVariants) {
      hosts.add(variant)
      hosts.add(`${variant}:${actualPort}`)
      origins.add(`http://${variant}:${actualPort}`)
      origins.add(`https://${variant}:${actualPort}`)
      // 无端口形态：反代剥端口 / HTTP/1.0 客户端。监听端始终为回环地址。
      hosts.add(variant)
      origins.add(`http://${variant}`)
      origins.add(`https://${variant}`)
    }
    return { hosts, origins }
  }

  /**
   * S-06 请求闸：Origin（存在时）与 Host 必须命中白名单。
   * @returns {true | 'origin' | 'host'} 放行返回 true，否则返回被拒的头名。
   */
  function gateCheck(request) {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : ''
    if (origin !== '' && !buildGateAllowlist().origins.has(origin)) return 'origin'
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host.trim().toLowerCase() : ''
    if (hostHeader === '' || !buildGateAllowlist().hosts.has(hostHeader)) return 'host'
    return true
  }

  // 路由表（段匹配：':name' 匹配任意非空单段；先收集同路径全部方法再分派 → 405 可判定）。
  // Recovery-only：仅单页、票据兑换、只读诊断快照三条。任何旧日常写/读路由都不在此表。
  const routes = [
    { method: 'GET', segments: [], html: true, handler: () => htmlPage },
    { method: 'POST', segments: ['api', 'auth', 'exchange-ticket'], public: true, handler: ({ body }) => {
      if (typeof verifyLaunchTicket !== 'function' || verifyLaunchTicket(body?.ticket) !== true) {
        const error = new Error('启动票据无效或已过期')
        error.status = 401
        throw error
      }
      if (typeof createSession !== 'function') return { accepted: true }
      const session = createSession()
      if (session === null || typeof session !== 'object' || typeof session.token !== 'string' || session.token === '') {
        const error = new Error('管理台会话创建失败')
        error.status = 503
        throw error
      }
      const seconds = Number.isFinite(session.expiresAt)
        ? Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000))
        : 300
      return {
        accepted: true,
        __setCookie: `dsh_notifier_session=${encodeURIComponent(session.token)}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Strict`,
      }
    } },
    // v0.15（T20）Recovery 只读诊断快照：无 Native 时仍可查看 canonical diagnostics。
    // 只读（无副作用、不重放 interaction）；未装配由 api 层抛 501，能力语义透传。
    { method: 'GET', segments: ['api', 'diagnostics'], handler: () => api.getDiagnostics() },
  ]

  /**
   * 路径匹配：返回 allowed（该路径存在的全部方法集合）与 matched（方法命中的那条路由 + 路径参数）。
   * allowed 非空但 matched 为空 → 405；两者皆空 → 404。
   * @param {string} method
   * @param {string[]} segments - 已 decode 的路径段
   */
  function matchRoute(method, segments) {
    const allowed = new Set()
    let matched = null
    for (const route of routes) {
      if (route.segments.length !== segments.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < segments.length; i += 1) {
        const pattern = route.segments[i]
        if (pattern.startsWith(':')) {
          if (segments[i] === '') { ok = false; break } // 尾斜杠产生的空段不匹配
          params[pattern.slice(1)] = segments[i]
        } else if (segments[i] !== pattern) {
          ok = false
          break
        }
      }
      if (!ok) continue
      allowed.add(route.method)
      if (route.method === method && matched === null) matched = { route, params }
    }
    return { allowed, matched }
  }

  /**
   * Bearer 鉴权为恢复通道；浏览器首访兑换后的短会话走 HttpOnly cookie。
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  function authorized(request) {
    try {
      const header = request.headers.authorization
      if (typeof header === 'string') {
        const match = /^Bearer (.+)$/.exec(header)
        if (match !== null && verifyToken(match[1]) === true) return true
      }
      if (typeof verifySession !== 'function') return false
      const cookieHeader = typeof request.headers.cookie === 'string' ? request.headers.cookie : ''
      const match = /(?:^|;\s*)dsh_notifier_session=([^;]+)/.exec(cookieHeader)
      if (match === null) return false
      return verifySession(decodeURIComponent(match[1])) === true
    } catch {
      return false // 校验器自身异常按未授权处理，绝不冒泡
    }
  }

  /**
   * 收齐请求体并 JSON.parse。空 body 当 {}；非 JSON → 400；超 1MB → 413（中文 error）并掐断连接。
   * 永不 reject（连接层错误也 resolve null），调用方以 null 判定"已响应/中止"。
   * @param {import('node:http').IncomingMessage} request
   * @param {{ json: (status: number, payload: unknown) => void }} respond
   * @returns {Promise<object | null>}
   */
  function readBody(request, respond) {
    return new Promise((resolve) => {
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        respond.json(413, { error: '请求体超过 1MB 上限' })
        request.destroy()
        resolve(null)
        return
      }
      const chunks = []
      let size = 0
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      request.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          respond.json(413, { error: '请求体超过 1MB 上限' })
          request.destroy()
          finish(null)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (done) return
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return finish({}) // 空 body 当 {}（契约）
        try {
          finish(JSON.parse(text))
        } catch {
          respond.json(400, { error: '请求体不是合法 JSON' })
          finish(null)
        }
      })
      request.on('error', () => {
        // 连接层错误：能写则补一个 400，写不进（已响应/已断）由 responded 闸幂等吞掉
        respond.json(400, { error: '请求体不是合法 JSON' })
        finish(null)
      })
    })
  }

  /**
   * 单请求主流程：/api/* 先鉴权（401 优先于 404/405，不泄露路由存在性）→ 路由匹配 → 收 body → 委托 api。
   * @param {import('node:http').IncomingMessage} request
   * @param {{ json: (status: number, payload: unknown) => void,
   *           html: (status: number, text: string) => void }} respond
   */
  async function handle(request, respond) {
    // S-06 请求闸先于路由与鉴权（403 不泄露路由存在性；被拒请求也不消耗 api 配额）。
    const gate = gateCheck(request)
    if (gate !== true) {
      warn(`请求被 Origin/Host 闸拒绝（${gate} 头不在白名单）`)
      return respond.json(403, { error: '请求被拒绝：Origin/Host 校验未通过' })
    }
    const rawPath = String(request.url ?? '').split('?')[0]
    const pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const method = String(request.method ?? 'GET').toUpperCase()
    const segments = pathname === '/' ? [] : pathname.slice(1).split('/').map(decodeSegment)
    const { allowed, matched } = matchRoute(method, segments)

    const publicRoute = matched?.route?.public === true
    if (segments[0] === 'api' && !publicRoute && !authorized(request)) {
      return respond.json(401, { error: '鉴权失败：缺少或错误的 Bearer token' })
    }
    if (matched === null) {
      if (allowed.size > 0) return respond.json(405, { error: `方法不允许：${method}` })
      return respond.json(404, { error: `接口不存在：${method} ${pathname}` })
    }

    const body = await readBody(request, respond)
    if (body === null) return // 400/413/连接错误已响应

    let result
    try {
      result = await matched.route.handler({ params: matched.params, body, request })
    } catch (error) {
      const status = apiStatusOf(error) ?? (Number.isInteger(error?.status) ? error.status : null)
      if (status !== null) return respond.json(status, { error: diagnosticErrorMessage(error) })
      warn(`api 处理异常: ${diagnosticErrorMessage(error)}`)
      return respond.json(500, { error: '内部错误' }) // 堆栈只进日志，绝不回给客户端
    }
    if (matched.route.html) return respond.html(200, String(result))
    let payload = result === undefined ? {} : result
    let headers
    if (payload !== null && typeof payload === 'object' && typeof payload.__setCookie === 'string') {
      const cookie = payload.__setCookie
      payload = { ...payload }
      delete payload.__setCookie
      headers = { 'set-cookie': cookie }
    }
    respond.json(200, payload, headers)
  }

  const server = createServer((request, response) => {
    let responded = false // 413 destroy 与后续事件可能竞态：只允许写一次响应
    const write = (status, payload, contentType, headers = {}) => {
      if (responded) return
      responded = true
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload)
      try {
        response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...headers })
        response.end(body)
      } catch { /* 响应写失败（客户端已断）：绝不向上抛 */ }
    }
    const respond = {
      json: (status, payload, headers) => write(status, payload, JSON_TYPE, headers),
      html: (status, text) => write(status, text, HTML_TYPE),
    }
    handle(request, respond).catch((error) => {
      warn(`请求处理异常: ${error instanceof Error ? error.message : String(error)}`)
      respond.json(500, { error: '内部错误' })
    })
  })
  server.on('error', (error) => {
    warn(`server 异常: ${error instanceof Error ? error.message : String(error)}`)
  })
  // v0.6.5（审查 R4-2-P3-6）：显式固化连接超时，不再吃 Node 版本默认值（默认值随版本
  // 变化会悄悄改变慢速攻击面；慢速 body 连接原依赖 300s requestTimeout 兜底占资源）。
  server.headersTimeout = 60_000
  server.requestTimeout = 120_000
  server.keepAliveTimeout = 20_000
  server.on('clientError', (error, socket) => {
    warn(`client 异常: ${error instanceof Error ? error.message : String(error)}`)
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  let listenInfo = null
  let listenPromise = null
  let closePromise = null

  /** 启动监听（幂等）；resolve 实际 { port, address }（port 0 时为内核分配的随机端口）。
   * 零配置首访（admin-zero-config-onboarding）：首选端口被占用时自动回退到系统分配的
   * 空闲端口（port: 0），仍只绑定 127.0.0.1，并打印实际监听地址。回退在同一个 server
   * 生命周期内完成——listen 失败时先 close 清理半启动状态，再以 port=0 重新 listen。
   * Origin/Host allowlist 使用实际端口（buildGateAllowlist 读取 listenInfo?.port）。 */
  function start() {
    if (listenPromise !== null) return listenPromise
    listenPromise = new Promise((resolve, reject) => {
      let fallbackAttempted = false
      const onListenError = (error) => {
        if (!fallbackAttempted && error?.code === 'EADDRINUSE') {
          fallbackAttempted = true
          warn(`首选端口 ${port} 已被占用，自动回退到系统分配端口（仅本机回环）`)
          // 清理半启动状态：close 忽略错误（未 listen 时回调带错），然后以 port=0 重试
          try { server.close(() => { doListen(0) }) } catch { doListen(0) }
          return
        }
        listenPromise = null
        reject(error) // listen 失败（非端口占用或回退后仍失败）要向上抛
      }
      function doListen(listenPort) {
        server.once('error', onListenError)
        server.listen(listenPort, host, () => {
          server.removeListener('error', onListenError)
          const address = server.address()
          listenInfo = {
            port: typeof address === 'object' && address !== null ? address.port : listenPort,
            address: typeof address === 'object' && address !== null ? address.address : host,
          }
          warn(`admin 管理台已监听 ${listenInfo.address}:${listenInfo.port}（仅本机回环，永不绑公网）`)
          resolve({ ...listenInfo })
        })
      }
      doListen(port)
    })
    return listenPromise
  }

  /** 停止监听（幂等，二次调用不抛）；等 close 完成，keep-alive 连接直接砍以便真正收敛。 */
  async function stop() {
    const pending = listenPromise
    listenPromise = null
    listenInfo = null
    try { await pending } catch { /* 启动失败无需关闭 */ }
    if (closePromise === null) {
      closePromise = new Promise((resolveClose) => {
        server.close(() => resolveClose()) // 未监听时 close 回调带错：忽略，保证幂等不抛
        server.closeAllConnections?.()
      })
    }
    await closePromise
  }

  return {
    start,
    stop,
    /** 实际监听端口（未启动/已停止为 null；测试用）。 */
    get port() {
      return listenInfo?.port ?? null
    },
  }
}
