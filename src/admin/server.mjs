// dsh-notifier admin/server.mjs
// v0.3.3 Web 管理台 HTTP 服务器（设计 §5）：node:http 零依赖 + Bearer token 鉴权 + JSON API 路由。
// 职责边界：本文件只做 HTTP 壳（鉴权 / 路由 / body 上限 / 错误映射 / ui 静态串），
// 业务语义全部委托注入的 api 对象（src/admin/api.mjs，UI/CLI 共用同一套函数；本文件不 import 它，
// 契约解耦：任何 { overview, getBindings, ... } 形状的对象皆可注入，测试用 fake api）。
// 安全（§0.5-6 红线）：
//  - 永远只绑 host（默认 127.0.0.1）；公网暴露管理台 = 暴露全部凭证写权限，需公网由用户自行反代
//  - /api/* 一律 Authorization: Bearer <token> 且 verifyToken(token) === true；
//    401 响应不区分缺 token / 错 token / 格式错（不给探测者任何信息）
//  - api 异常只回 status + message；其余异常一律 500 '内部错误'（堆栈绝不泄给客户端，只 warn 日志）
// 军规：任何请求处理异常绝不崩进程；请求体上限 1MB（超限 413）；stop() 幂等（二次调用不抛）。

import { createServer } from 'node:http'

const MAX_BODY_BYTES = 1024 * 1024
const JSON_TYPE = 'application/json; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const SSE_TYPE = 'text/event-stream; charset=utf-8'
const FALLBACK_UI = '<!DOCTYPE html><p>admin ui 未装配</p>'
/** SSE 心跳间隔（ms）：注释行保活，防本机反代/浏览器空闲掐连接；测试可注入更小值。 */
const DEFAULT_HEARTBEAT_MS = 15_000
/**
 * v0.6.5（审查 R4-2-P3-4）：SSE 并发连接上限。持 token 客户端可开任意多条长连接
 * （每条同步重放 50 条缓冲 + 心跳定时器），无上限时耗尽 fd/内存——管理台是单用户
 * 场景，64 已远超「多标签页 + 多设备」的合理用量。
 */
const MAX_SSE_CONNECTIONS = 64

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
 * @param {object} options
 * @param {object} options.api - 管理台 API（overview/getBindings/putBindings/getSessions/patchSession/
 *                               getChannels/putChannel/testChannel/scanChannel/getMembers/
 *                               putMember/deleteMember/confirmPendingMember/dismissPendingMember/
 *                               mintPairingCode/revokePairingCode/getAudit）
 * @param {(token: string) => boolean} options.verifyToken - Bearer token 校验（严格 === true 才放行）
 * @param {string} [options.host='127.0.0.1'] - 只绑本机回环（红线：永不绑公网）
 * @param {number} [options.port=8104] - 监听端口；0 = 随机可用端口（测试用）
 * @param {string} [options.ui=''] - 单文件内嵌 HTML 串（空串时 GET / 返回最小占位页）
 * @param {object} [options.events] - 通知事件 hub（admin/events.mjs；提供 subscribe/publish）；
 *                                    未注入时 GET /api/events 回 501（能力不可用语义同 ApiError）
 * @param {number} [options.heartbeatMs=15000] - SSE 心跳间隔（测试注入小值）
 * @param {object} [options.logger] - { warn(message) } 注入；日志失败绝不致命
 * @returns {{ start: () => Promise<{ port: number, address: string }>,
 *             stop: () => Promise<void>,
 *             get port(): number | null }}
 */
export function createAdminServer({ api, verifyToken, host = '127.0.0.1', port = 8104, ui = '', events = null, heartbeatMs = DEFAULT_HEARTBEAT_MS, logger } = {}) {
  const warn = (message) => {
    // stderr 双写（R5 审查 R5-2-P1-2：与 api.mjs 同款纪律，web profile 下 logger 不落 stdout）
    try { logger?.warn?.('[dsh-notifier/admin:server]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/admin:server]', message) } catch { /* 控制台不可用不致命 */ }
  }
  const htmlPage = ui === '' ? FALLBACK_UI : String(ui)

  // 路由表（段匹配：':name' 匹配任意非空单段；先收集同路径全部方法再分派 → 405 可判定）。
  const routes = [
    { method: 'GET', segments: [], html: true, handler: () => htmlPage },
    { method: 'GET', segments: ['api', 'overview'], handler: () => api.overview() },
    { method: 'GET', segments: ['api', 'bindings'], handler: () => api.getBindings() },
    { method: 'PUT', segments: ['api', 'bindings'], handler: ({ body }) => api.putBindings(body) },
    { method: 'GET', segments: ['api', 'sessions'], handler: () => api.getSessions() },
    { method: 'PATCH', segments: ['api', 'sessions', ':id'], handler: ({ params, body }) => api.patchSession(params.id, body) },
    { method: 'GET', segments: ['api', 'channels'], handler: () => api.getChannels() },
    { method: 'PUT', segments: ['api', 'channels', ':type'], handler: ({ params, body }) => api.putChannel(params.type, body.config ?? body) },
    { method: 'POST', segments: ['api', 'channels', ':type', 'test'], handler: ({ params }) => api.testChannel(params.type) },
    { method: 'POST', segments: ['api', 'scan', ':channel'], handler: ({ params }) => api.scanChannel(params.channel) },
    // v0.7 成员与配对码（键形 "<channel>:<userId>"，冒号在路径段内合法——decodeSegment 已解 %3A）
    { method: 'GET', segments: ['api', 'members'], handler: () => api.getMembers() },
    { method: 'PUT', segments: ['api', 'members', ':key'], handler: ({ params, body }) => api.putMember(params.key, body) },
    { method: 'DELETE', segments: ['api', 'members', ':key'], handler: ({ params }) => api.deleteMember(params.key) },
    { method: 'POST', segments: ['api', 'members', ':key', 'confirm'], handler: ({ params }) => api.confirmPendingMember(params.key) },
    { method: 'POST', segments: ['api', 'members', ':key', 'dismiss'], handler: ({ params }) => api.dismissPendingMember(params.key) },
    { method: 'POST', segments: ['api', 'pairing'], handler: ({ body }) => api.mintPairingCode(body) },
    { method: 'DELETE', segments: ['api', 'pairing', ':id'], handler: ({ params }) => api.revokePairingCode(params.id) },
    { method: 'GET', segments: ['api', 'audit'], handler: () => api.getAudit() },
    { method: 'GET', segments: ['api', 'events'], sse: true }, // v0.4.0 通知事件流（handle 内特判）
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
   * Bearer 鉴权：头缺失 / 非 `Bearer <token>` 格式 / verifyToken 非 true / 校验抛异常，一律 false。
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  function authorized(request) {
    try {
      const header = request.headers.authorization
      if (typeof header !== 'string') return false
      const match = /^Bearer (.+)$/.exec(header)
      if (match === null) return false
      return verifyToken(match[1]) === true
    } catch {
      return false // verifyToken 自身异常按未授权处理，绝不冒泡
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
   * 打开 SSE 通知事件流（GET /api/events，鉴权已过）：写流式响应头 → 重放缓冲 + 订阅实时 →
   * 心跳注释行保活；客户端断连（close/error 任一）即退订 + 清定时器 + end，绝不外泄资源。
   * 军规：所有写操作 try/catch（客户端半途断开是常态不是异常）；本函数绝不抛。
   * v0.6.5（审查 R4-2-P3-4）：并发连接计数上限 MAX_SSE_CONNECTIONS，超限 503。
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {{ json: (status: number, payload: unknown) => void }} respond
   */
  let sseConnections = 0
  function openEventStream(request, response) {
    sseConnections += 1
    try {
      response.writeHead(200, {
        'content-type': SSE_TYPE,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // 本机反代（nginx 等）禁缓冲，事件即发即达
      })
      response.write(': connected\n\n')
    } catch {
      sseConnections -= 1 // 写头即失败（客户端已断）：释放配额，无资源可清
      return
    }
    let closed = false
    const send = (line) => {
      if (closed) return
      try { response.write(line) } catch { cleanup() /* 写失败视同断连 */ }
    }
    const unsubscribe = events.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`), { replay: true })
    const heartbeat = setInterval(() => send(': hb\n\n'), heartbeatMs)
    function cleanup() {
      if (closed) return
      closed = true
      sseConnections -= 1
      clearInterval(heartbeat)
      unsubscribe()
      try { response.end() } catch { /* 已断 */ }
    }
    request.on('close', cleanup)
    response.on('close', cleanup)
    response.on('error', cleanup)
  }

  /**
   * 单请求主流程：/api/* 先鉴权（401 优先于 404/405，不泄露路由存在性）→ 路由匹配 → 收 body → 委托 api。
   * @param {import('node:http').IncomingMessage} request
   * @param {{ json: (status: number, payload: unknown) => void,
   *           html: (status: number, text: string) => void,
   *           taken: () => void }} respond
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, respond, response) {
    const rawPath = String(request.url ?? '').split('?')[0]
    const pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const method = String(request.method ?? 'GET').toUpperCase()
    const segments = pathname === '/' ? [] : pathname.slice(1).split('/').map(decodeSegment)
    const { allowed, matched } = matchRoute(method, segments)

    if (segments[0] === 'api' && !authorized(request)) {
      return respond.json(401, { error: '鉴权失败：缺少或错误的 Bearer token' })
    }
    if (matched === null) {
      if (allowed.size > 0) return respond.json(405, { error: `方法不允许：${method}` })
      return respond.json(404, { error: `接口不存在：${method} ${pathname}` })
    }

    // v0.4.0 SSE 特判：流式响应接管连接（不走 readBody/一次性 write）。
    // events 未装配 → 501（能力不可用，语义对齐 ApiError；比 404 更能指引「升级/装配」）。
    if (matched.route.sse === true) {
      if (typeof events?.subscribe !== 'function') {
        return respond.json(501, { error: '通知事件流未装配（events hub 缺失）' })
      }
      // v0.6.5（审查 R4-2-P3-4）：连接数上限（检查须在 taken() 之前——响应权移交后 503 写不进）
      if (sseConnections >= MAX_SSE_CONNECTIONS) {
        return respond.json(503, { error: `事件流连接数已达上限（${MAX_SSE_CONNECTIONS}），请关闭闲置标签页后重试` })
      }
      respond.taken() // 响应权移交流实现：后续任何 json/html 兜底写入直接失效
      return openEventStream(request, response)
    }

    const body = await readBody(request, respond)
    if (body === null) return // 400/413/连接错误已响应

    let result
    try {
      result = await matched.route.handler({ params: matched.params, body, request })
    } catch (error) {
      const status = apiStatusOf(error)
      if (status !== null) return respond.json(status, { error: String(error.message ?? '') })
      warn(`api 处理异常: ${error instanceof Error ? error.message : String(error)}`)
      return respond.json(500, { error: '内部错误' }) // 堆栈只进日志，绝不回给客户端
    }
    if (matched.route.html) return respond.html(200, String(result))
    respond.json(200, result === undefined ? {} : result)
  }

  const server = createServer((request, response) => {
    let responded = false // 413 destroy 与后续事件可能竞态：只允许写一次响应
    const write = (status, payload, contentType) => {
      if (responded) return
      responded = true
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload)
      try {
        response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) })
        response.end(body)
      } catch { /* 响应写失败（客户端已断）：绝不向上抛 */ }
    }
    const respond = {
      json: (status, payload) => write(status, payload, JSON_TYPE),
      html: (status, text) => write(status, text, HTML_TYPE),
      taken: () => { responded = true }, // SSE 流接管响应：一次性写通道让位（幂等闸防双写）
    }
    handle(request, respond, response).catch((error) => {
      warn(`请求处理异常: ${error instanceof Error ? error.message : String(error)}`)
      respond.json(500, { error: '内部错误' })
    })
  })
  server.on('error', (error) => {
    warn(`server 异常: ${error instanceof Error ? error.message : String(error)}`)
  })
  // v0.6.5（审查 R4-2-P3-6）：显式固化连接超时，不再吃 Node 版本默认值（默认值随版本
  // 变化会悄悄改变慢速攻击面；慢速 body 连接原依赖 300s requestTimeout 兜底占资源）。
  // requestTimeout 覆盖「收完整请求」（头+body），不影响 SSE 已接管的长响应。
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

  /** 启动监听（幂等）；resolve 实际 { port, address }（port 0 时为内核分配的随机端口）。 */
  function start() {
    if (listenPromise !== null) return listenPromise
    listenPromise = new Promise((resolve, reject) => {
      const onListenError = (error) => {
        listenPromise = null
        reject(error) // listen 失败（端口占用等）要向上抛
      }
      server.once('error', onListenError)
      server.listen(port, host, () => {
        server.removeListener('error', onListenError)
        const address = server.address()
        listenInfo = {
          port: typeof address === 'object' && address !== null ? address.port : port,
          address: typeof address === 'object' && address !== null ? address.address : host,
        }
        warn(`admin 管理台已监听 ${listenInfo.address}:${listenInfo.port}（仅本机回环，永不绑公网）`)
        resolve({ ...listenInfo })
      })
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
