// dsh-notifier v0.12 — Native Control Surface over the DSH authenticated Connection RPC channel.
//
// 真机结论（2026-09-25，DSH 0.1.7-rc.2，宿主内 probe 实测）：
//   * `ctx.connection.rpc.handle(channel, handler)` 对第三方不可用。其实现里
//     `get rpc() { const owner = this.ctx; ... }` 把 owner 固定为 connection 服务自身的
//     ctx，注册时执行 `owner.webServer.register(route)`；该 ctx 从未声明 webServer，
//     于是每次调用都抛 `cannot get property "webServer" without inject`（本插件与
//     带静态 inject 的探针插件均复现）。宿主自身也走不通这条缝。
//   * `ctx.connection.rpc.intercept('/api', ...)` 也被 API Gateway 先占（"already has an interceptor"）。
//   * `ctx.connection.fetch.register` 的路由挂在共享 `/api` 前缀下，而浏览器 carrier
//     发的是 `<channel>/<endpoint>` 相对路径，二者对不上。
//
// 因此通道改为直接挂在 webServer 上，与宿主挂载 `/api` 完全同款：`kind:'prefix'` 路由 +
// `connection.admit()` 准入 + Connection 的 client-request/server-response 信封。
// 若某天宿主修好了 `rpc.handle`，则优先走官方缝（旧版本如 alpha.1 兼容路径）。
//
// 信封/错误码形状与 @deepseek-ai/dsh-client-connection 的 rpcFetchHandler 对齐：
//   请求 { type:'client-request', rpcId, method, payload }
//   响应 { type:'server-response', rpcId, result: { ok:true, value } | { ok:false, error } }

export const CONTROL_SURFACE_CHANNEL = '/dsh-notifier'

const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

function endpointFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${CONTROL_SURFACE_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CONTROL_SURFACE_CHANNEL.length + 1)
  if (endpoint.length === 0) return undefined
  const segments = endpoint.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) return undefined
  return endpoint
}

function writeJson(res, body) {
  const payload = JSON.stringify(body)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function writeText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const isRequestEnvelope = (message) => message !== null
  && typeof message === 'object'
  && message.type === 'client-request'
  && typeof message.rpcId === 'string'
  && typeof message.method === 'string'

function badRequest(rpcId, message) {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message, details: {} } } }
}

/** 把通道挂到宿主 webServer 上（与 connection 插件挂 `/api` 同款）。 */
function mountOnWebServer(ctx, service) {
  const connection = ctx?.connection
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function' || typeof connection?.admit !== 'function') return null
  const route = {
    kind: 'prefix',
    path: CONTROL_SURFACE_CHANNEL,
    handler: async (req, res) => {
      try {
        const admission = connection.admit(req)
        if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
          writeText(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const pathname = new URL(String(req?.url ?? '/'), 'http://dsh.internal').pathname
        const endpoint = endpointFromPath(pathname)
        if (req?.method !== 'POST' || endpoint === undefined) { writeText(res, 404, 'not found'); return }
        const contentType = String(req?.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') { writeText(res, 415, 'content type must be application/json'); return }
        let message
        try { message = await readJsonBody(req) } catch { writeText(res, 400, 'body is not JSON'); return }
        if (!isRequestEnvelope(message)) { writeJson(res, badRequest('invalid-request', 'invalid client-request message')); return }
        if (message.method !== endpoint) {
          writeJson(res, badRequest(message.rpcId, `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
          return
        }
        // 长轮询（surface.wait）要能在客户端断开时中止：与宿主 bridge 同款，用 res close 触发 abort。
        const abort = new AbortController()
        res.on('close', () => { if (!res.writableEnded) abort.abort() })
        const result = await service.call(endpoint, message.payload, abort.signal)
        writeJson(res, { type: 'server-response', rpcId: message.rpcId, result })
      } catch (error) {
        try { writeText(res, 500, `handler failure: ${String(error)}`) } catch { /* 连接已断则无可写 */ }
      }
    },
  }
  const dispose = ctx.effect(() => webServer.register(route), 'dsh-notifier: native control surface channel')
  return typeof dispose === 'function' ? dispose : null
}

/**
 * 装配 Native Control Surface 通道。返回 disposer，或 null 表示宿主不提供任何可用接缝
 * （调用方据此降级为 Standalone）。
 */
export function registerControlSurfaceRpc(ctx, service) {
  const handler = (endpoint, payload, signal) => service.call(endpoint, payload, signal)
  if (typeof ctx?.connection?.rpc?.handle === 'function') {
    try {
      const dispose = ctx.connection.rpc.handle(CONTROL_SURFACE_CHANNEL, handler)
      if (typeof dispose === 'function') return dispose
    } catch { /* 宿主 rpc.handle 不可用（见文件头）→ 落到 webServer 直挂 */ }
  }
  return mountOnWebServer(ctx, service)
}