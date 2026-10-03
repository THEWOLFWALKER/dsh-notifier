// v0.15 Stage 4（S403）：admin/server（HTTP 级）——Recovery-only 后端：
//   GET  /                          只读管理台单页
//   POST /api/auth/exchange-ticket  启动票据兑换短会话
//   GET  /api/diagnostics           只读 canonical 诊断快照
// 覆盖：鉴权 / 路由 / body 限制 / 错误映射 / 生命周期 / Origin-Host 之外的未知路由 404。
// 旧日常写/读路由（bindings/sessions/channels/members/pairing/questions/tasks/host/scan/events）
// 必须**不在路由表**——见文末 S403 路由缺失矩阵（能力不存在，而不是 UI 不可见）。
// 全部用 fake api 对象（仅 getDiagnostics）+ verifyToken 只认 'secret'；不 import src/admin/api.mjs。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminServer } from '../src/admin/server.mjs'
import { ADMIN_UI_HTML } from '../src/admin/ui.mjs'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 伪造 ApiError（契约识别式：Error + 整数 status，无需 import api.mjs）。 */
function apiError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** fake api：Recovery 只读面只暴露 getDiagnostics（记录调用，overrides 可抛错/改返回）。 */
function makeApi(overrides = {}, { latencyMs = 0 } = {}) {
  const calls = []
  const api = {
    getDiagnostics: async (...args) => {
      calls.push({ name: 'getDiagnostics', args })
      if (latencyMs > 0) await tick(latencyMs)
      const override = overrides.getDiagnostics
      if (override !== undefined) return override(...args)
      return { via: 'getDiagnostics', process: { epoch: 'e1', revision: 3 } }
    },
  }
  return { api, calls }
}

/** 起一台随机端口 admin server（只绑 127.0.0.1），fn 结束后 finally 里必 stop。 */
async function withServer(options = {}, fn) {
  const { api, calls } = makeApi(options.apiOverrides ?? {}, { latencyMs: options.latencyMs ?? 0 })
  const lines = []
  const server = createAdminServer({
    api,
    verifyToken: options.verifyToken ?? ((token) => token === 'secret'),
    verifyLaunchTicket: options.verifyLaunchTicket,
    createSession: options.createSession,
    verifySession: options.verifySession,
    host: '127.0.0.1',
    port: 0, // 随机端口
    ui: options.ui ?? '',
    logger: { warn: (prefix, message) => lines.push(`${prefix} ${message}`) },
  })
  const info = await server.start()
  const rig = { server, info, api, calls, lines, base: `http://127.0.0.1:${info.port}` }
  try {
    await fn(rig)
  } finally {
    await server.stop()
  }
}

/**
 * 发请求。token=null 不带鉴权头；rawAuth 直接指定 authorization 原文（测 Bearer 格式错误）。
 * body 为字符串原样发（测非 JSON），对象 JSON.stringify。
 */
async function call(rig, path, options = {}) {
  const { method = 'GET', token = 'secret', rawAuth, body, cookie } = options
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  if (rawAuth !== undefined) headers.authorization = rawAuth
  else if (token !== null) headers.authorization = `Bearer ${token}`
  const init = { method, headers }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return fetch(`${rig.base}${path}`, init)
}

const jsonOf = (response) => response.json()
const textOf = (response) => response.text()

// ---------------------------------------------------------------- 生命周期 / 军规

test('start：port 0 → 随机端口生效；address 必须是 127.0.0.1（永不绑公网红线）；port getter 同步', async () => {
  await withServer({}, async (rig) => {
    assert.equal(typeof rig.info.port, 'number')
    assert.ok(rig.info.port > 0, 'port 0 应被替换为内核分配的随机端口')
    assert.equal(rig.info.address, '127.0.0.1', '管理台只许绑本机回环')
    assert.equal(rig.server.port, rig.info.port, 'port getter 返回实际监听端口')
    assert.equal((await call(rig, '/api/diagnostics')).status, 200, '随机端口真实可访问')
  })
})

test('start：忽略调用方提供的公网 host，管理台仍只绑定 127.0.0.1', async () => {
  const server = createAdminServer({
    api: makeApi().api,
    verifyToken: () => true,
    host: '0.0.0.0',
    port: 0,
  })
  try {
    const info = await server.start()
    assert.equal(info.address, '127.0.0.1')
  } finally {
    await server.stop()
  }
})

test('stop：幂等（二次调用不抛）；停止后端口不再响应；port 归 null', async () => {
  const lines = []
  const server = createAdminServer({
    api: makeApi().api,
    verifyToken: () => true,
    port: 0,
    logger: { warn: (p, m) => lines.push(`${p} ${m}`) },
  })
  const info = await server.start()
  await server.stop()
  await server.stop() // 幂等：不抛
  assert.equal(server.port, null)
  await assert.rejects(() => fetch(`http://127.0.0.1:${info.port}/api/diagnostics`))
})

// ---------------------------------------------------------------- GET /（ui 静态页）

test('GET /：无 token 也放行，返回 ui 串（text/html; charset=utf-8 + Content-Length）', async () => {
  const ui = '<!DOCTYPE html><html lang="zh"><title>dsh admin</title><p>面板</p>'
  await withServer({ ui }, async (rig) => {
    const response = await call(rig, '/', { token: null })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(ui))
    assert.equal(await textOf(response), ui)
  })
})

test('GET /：ui 未装配（空串）→ 最小占位页', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/', { token: null })
    assert.equal(response.status, 200)
    assert.equal(await textOf(response), '<!DOCTYPE html><p>admin ui 未装配</p>')
  })
})

test('Issue #10/#13：入口查询串不回显也不能充当 token，API 仍只认 Bearer 头', async () => {
  const urlToken = 'must-not-appear-in-ui-or-auth'
  await withServer({ ui: ADMIN_UI_HTML }, async (rig) => {
    const page = await call(rig, `/?token=${encodeURIComponent(urlToken)}`, { token: null })
    assert.equal(page.status, 200)
    assert.equal((await textOf(page)).includes(urlToken), false, '入口页不得回显 URL 中的 token')
    const api = await call(rig, `/api/diagnostics?token=${encodeURIComponent('secret')}`, { token: null })
    assert.equal(api.status, 401, '查询串 token 绝不替代 Bearer 鉴权')
  })
})

test('C8：一次性启动票据兑换为 HttpOnly 短会话；Bearer 仍保留为恢复通道', async () => {
  let ticketUses = 0
  await withServer({
    verifyLaunchTicket: (ticket) => ticket === 'launch-ticket' && (++ticketUses === 1),
    createSession: () => ({ token: 'session-secret', expiresAt: Date.now() + 300_000 }),
    verifySession: (token) => token === 'session-secret',
  }, async (rig) => {
    const exchange = await call(rig, '/api/auth/exchange-ticket', {
      method: 'POST', token: null, body: { ticket: 'launch-ticket' },
    })
    assert.equal(exchange.status, 200)
    const body = await jsonOf(exchange)
    assert.deepEqual(body, { accepted: true })
    assert.equal(JSON.stringify(body).includes('session-secret'), false, '会话明文不得进入响应体')
    const cookie = exchange.headers.get('set-cookie')
    assert.match(cookie ?? '', /dsh_notifier_session=session-secret/)
    assert.match(cookie ?? '', /HttpOnly/)
    assert.match(cookie ?? '', /SameSite=Strict/)
    assert.match(cookie ?? '', /Max-Age=\d+/)

    const viaCookie = await call(rig, '/api/diagnostics', { token: null, cookie })
    assert.equal(viaCookie.status, 200, 'HttpOnly 会话应可访问 API')
    const viaBadCookie = await call(rig, '/api/diagnostics', { token: null, cookie: 'dsh_notifier_session=wrong' })
    assert.equal(viaBadCookie.status, 401)
    assert.equal((await call(rig, '/api/diagnostics')).status, 200, 'Bearer 恢复路径不得被短会话替换')

    const replay = await call(rig, '/api/auth/exchange-ticket', {
      method: 'POST', token: null, body: { ticket: 'launch-ticket' },
    })
    assert.equal(replay.status, 401, '启动票据仍然只能兑换一次')

    const badTicket = await call(rig, '/api/auth/exchange-ticket', {
      method: 'POST', token: null, body: { ticket: 'nope' },
    })
    assert.equal(badTicket.status, 401, '无效票据 401')
  })
})

test('ADMIN_UI_HTML: recovery report replaces the old daily pages', () => {
  assert.ok(ADMIN_UI_HTML.includes('id="tab-diagnostics"'))
  assert.ok(!ADMIN_UI_HTML.includes('id="tab-notify"'))
  assert.ok(!ADMIN_UI_HTML.includes('id="setup"'))
  for (const id of ['tab-channels', 'tab-members', 'tab-bindings', 'tab-sessions']) {
    assert.ok(!ADMIN_UI_HTML.includes(`id="${id}"`), `recovery UI 不得含旧日常页 ${id}`)
  }
})

test('ADMIN_UI_HTML：移动端适配关键字（≤768px 纯 CSS 增量）', async () => {
  for (const keyword of [
    '@media (max-width: 768px)', // 断点块整体存在
    'nav { flex-wrap: nowrap; overflow-x: auto', // 导航标签横滚
    'button { min-height: 44px', // 触控目标 ≥44px
    'font-size: 16px', // iOS 聚焦不自动缩放
    'viewport', // 视口 meta（移动端渲染前提）
  ]) {
    assert.ok(ADMIN_UI_HTML.includes(keyword), `ADMIN_UI_HTML 应包含关键字 ${keyword}`)
  }
})

// ---------------------------------------------------------------- 鉴权（401）

test('401：缺 Authorization 头 → 401 + 中文 error（不区分缺/错，防探测）', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/diagnostics', { token: null })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(await jsonOf(response), { error: '鉴权失败：缺少或错误的 Bearer token' })
    assert.equal(rig.calls.length, 0, '未授权绝不触达 api')
  })
})

test('401：错误 token → 401', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/diagnostics', { token: 'wrong' })).status, 401)
    assert.equal((await call(rig, '/api/diagnostics', { token: '' })).status, 401)
  })
})

test('401：Bearer 格式错误（裸 token / Basic / 无空格 / 双空格错位）→ 401', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/diagnostics', { rawAuth: 'secret' })).status, 401, '缺 Bearer 前缀')
    assert.equal((await call(rig, '/api/diagnostics', { rawAuth: 'Basic secret' })).status, 401, '非 Bearer scheme')
    assert.equal((await call(rig, '/api/diagnostics', { rawAuth: 'Bearersecret' })).status, 401, '缺空格')
    assert.equal((await call(rig, '/api/diagnostics', { rawAuth: 'Bearer  secret' })).status, 401, '双空格 → token 带 lead space')
  })
})

test('401 优先于 404：未鉴权探测未知 /api 路径也只回 401（不泄露路由存在性）', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/definitely-not-exist', { token: null })
    assert.equal(response.status, 401)
    assert.equal(rig.calls.length, 0)
  })
})

// ---------------------------------------------------------------- 只读路由（diag）

test('GET /api/diagnostics：Bearer secret → 200 JSON，api.getDiagnostics() 结果透传', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/diagnostics')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.ok(Number(response.headers.get('content-length')) > 0, 'JSON 响应也带 Content-Length')
    assert.deepEqual(await jsonOf(response), { via: 'getDiagnostics', process: { epoch: 'e1', revision: 3 } })
    assert.deepEqual(rig.calls, [{ name: 'getDiagnostics', args: [] }])
  })
})

// ---------------------------------------------------------------- 路由不匹配（404 / 405）

test('404：未知 /api 路径 → { error: "接口不存在：<method> <path>" }；查询串不影响匹配', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/nope?utm=1')
    assert.equal(response.status, 404)
    assert.deepEqual(await jsonOf(response), { error: '接口不存在：GET /api/nope' })
    assert.equal((await call(rig, '/api')).status, 404, '/api 前缀根也是未知接口')
    assert.equal(rig.calls.length, 0)
  })
})

test('段匹配精确性：尾斜杠产生空段不命中 → 404', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/diagnostics/')).status, 404, '尾斜杠产生空段，不命中')
    assert.equal(rig.calls.length, 0, '以上皆不触达 api')
  })
})

test('405：路径存在但方法不符 → { error: "方法不允许：<method>" }', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/diagnostics', { method: 'POST' })).status, 405)
    assert.equal((await call(rig, '/', { method: 'POST', token: null })).status, 405, 'GET / 存在 → POST / 405')
    // /api/* 401 优先于 405（不泄露路由存在性）：public 路由方法不符也必须先过 Bearer。
    assert.equal((await call(rig, '/api/auth/exchange-ticket', { method: 'GET', token: null })).status, 401)
    assert.equal((await call(rig, '/api/auth/exchange-ticket', { method: 'GET' })).status, 405, 'GET 该路径存在（POST）→ 已鉴权则 405')
    assert.equal(rig.calls.length, 0, '405 绝不触达 api')
  })
})

// ---------------------------------------------------------------- body 解析与上限

test('400：非 JSON body → { error: "请求体不是合法 JSON" }', async () => {
  await withServer({
    verifyLaunchTicket: () => true,
    createSession: () => ({ token: 's', expiresAt: Date.now() + 1000 }),
  }, async (rig) => {
    const response = await call(rig, '/api/auth/exchange-ticket', { method: 'POST', token: null, body: 'not-json{' })
    assert.equal(response.status, 400)
    assert.deepEqual(await jsonOf(response), { error: '请求体不是合法 JSON' })
    assert.equal(rig.calls.length, 0)
  })
})

test('413：请求体超过 1MB 上限 → 请求被拒（413 或平台 fetch 抛错），绝不进 api', async () => {
  await withServer({
    verifyLaunchTicket: () => true,
    createSession: () => ({ token: 's', expiresAt: Date.now() + 1000 }),
  }, async (rig) => {
    let response
    try {
      response = await call(rig, '/api/auth/exchange-ticket', { method: 'POST', token: null, body: 'x'.repeat(1024 * 1024 + 1) })
    } catch (error) {
      assert.match(error.message, /fetch failed/, '客户端对超限 body 只能被拒（fetch failed）或拿到 413，不能成功')
    }
    if (response) {
      assert.equal(response.status, 413, '拿到响应则必须是 413')
      const payload = await jsonOf(response)
      assert.match(payload.error, /1MB/)
    }
    assert.equal(rig.calls.length, 0, '超限请求绝不触达 api')
  })
})

// ---------------------------------------------------------------- 错误映射

test('ApiError 透传：422 / 501 原样回 status + { error: message }', async () => {
  await withServer({
    apiOverrides: {
      getDiagnostics: () => { throw apiError(501, '诊断快照未装配') },
    },
  }, async (rig) => {
    const unsupported = await call(rig, '/api/diagnostics')
    assert.equal(unsupported.status, 501)
    assert.deepEqual(await jsonOf(unsupported), { error: '诊断快照未装配' })
  })
})

test('api 普通异常 → 500 { error: "内部错误" }；堆栈/原始消息绝不泄给客户端；logger warn 落日志', async () => {
  await withServer({
    apiOverrides: {
      getDiagnostics: () => { throw new Error('state.json 读取失败: EACCES at /secret/path') },
    },
  }, async (rig) => {
    const response = await call(rig, '/api/diagnostics')
    assert.equal(response.status, 500)
    const payload = await jsonOf(response)
    assert.deepEqual(payload, { error: '内部错误' })
    assert.equal(JSON.stringify(payload).includes('EACCES'), false, '原始消息不外泄')
    assert.equal(JSON.stringify(payload).includes('at '), false, '无堆栈帧')
    assert.ok(rig.lines.some((line) => line.includes('api 处理异常') && line.includes('EACCES')), '细节只进服务端日志')
  })
})

test('verifyToken 抛异常按未授权处理（绝不冒泡崩请求）', async () => {
  await withServer({ verifyToken: () => { throw new Error('state 损坏') } }, async (rig) => {
    const response = await call(rig, '/api/diagnostics')
    assert.equal(response.status, 401)
    assert.deepEqual(await jsonOf(response), { error: '鉴权失败：缺少或错误的 Bearer token' })
  })
})

// ---------------------------------------------------------------- 并发

test('并发：10 个并发请求（带 api 延迟）全部 200 且 body 各自正确', async () => {
  await withServer({ latencyMs: 8 }, async (rig) => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => call(rig, '/api/diagnostics')))
    assert.equal(responses.length, 10)
    for (let i = 0; i < responses.length; i += 1) {
      assert.equal(responses[i].status, 200, `第 ${i} 个请求`)
      const payload = await jsonOf(responses[i])
      assert.equal(payload.via, 'getDiagnostics')
    }
    assert.equal(rig.calls.length, 10)
  })
})

// ———————— XSS 回归（v0.6.5 审查 R4 补测） ————————

test('XSS 回归：用户可控内容只进 JSON 体（application/json），绝不进 HTML 上下文', async () => {
  await withServer({}, async (rig) => {
    // 404 反射路径带 payload：响应必须是 JSON（浏览器不执行 JSON MIME），payload 只作数据
    const payload = '<img src=x onerror=alert(1)>'
    const response = await call(rig, `/api/${encodeURIComponent(payload)}`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
    const body = await jsonOf(response)
    assert.ok(body.error.includes(encodeURIComponent(payload))) // 反射路径仅作为 JSON 字符串数据存在
    // /api/* 之外的 HTML 响应只有静态 ui 串（GET /），不存在任何反射式 HTML 渲染路径
    const html = await call(rig, '/')
    assert.match(html.headers.get('content-type') ?? '', /^text\/html/)
    const page = await html.text()
    assert.ok(!page.includes(payload), 'HTML 页面不含任何请求可控内容')
  })
})

test('XSS 回归：UI 渲染层 esc() 行为与覆盖面（innerHTML 拼接必须全部过转义）', () => {
  const match = ADMIN_UI_HTML.match(/function esc\(v\) \{[\s\S]*?\n\}/)
  assert.ok(match !== null, 'ui 内必须存在 esc() 转义函数')
  const esc = new Function(`return (${match[0]})`)()
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(esc('"\'&'), '&quot;&#39;&amp;')
  const uses = (ADMIN_UI_HTML.match(/esc\(/g) ?? []).length
  assert.ok(uses >= 30, `esc() 调用密度不足（实际 ${uses} 次，下限 30）——检查新增渲染路径是否漏转义`)
  for (const probe of ['esc(fmtTime(r.time))', 'esc(row.title)', "esc(c.type)", 'esc(id)']) {
    assert.ok(ADMIN_UI_HTML.includes(probe), `渲染层必须包含 ${probe}`)
  }
})

// ---------------------------------------------------------------- S403：旧日常路由必须不存在

test('S403：旧日常管理路由（读+写）已从 Recovery 后端删除（能力不存在）', async () => {
  await withServer({}, async (rig) => {
    const removed = [
      { method: 'GET', path: '/api/overview' },
      { method: 'GET', path: '/api/bindings' },
      { method: 'PUT', path: '/api/bindings', body: { agents: {} } },
      { method: 'GET', path: '/api/sessions' },
      { method: 'PATCH', path: '/api/sessions/sess-1', body: {} },
      { method: 'PATCH', path: '/api/sessions/sess-1/control', body: {} },
      { method: 'GET', path: '/api/channels' },
      { method: 'PUT', path: '/api/channels/telegram', body: { config: {} } },
      { method: 'POST', path: '/api/channels/telegram/test' },
      { method: 'PUT', path: '/api/channels/outbound/telegram', body: { config: {} } },
      { method: 'DELETE', path: '/api/channels/outbound/telegram' },
      { method: 'POST', path: '/api/channels/outbound/telegram/test' },
      { method: 'PUT', path: '/api/channels/inbound/feishu', body: { config: {} } },
      { method: 'DELETE', path: '/api/channels/inbound/feishu' },
      { method: 'POST', path: '/api/scan/qq' },
      { method: 'GET', path: '/api/members' },
      { method: 'PUT', path: '/api/members/feishu%3Aou_1', body: { label: 'x' } },
      { method: 'DELETE', path: '/api/members/feishu%3Aou_1' },
      { method: 'POST', path: '/api/members/feishu%3Aou_1/confirm' },
      { method: 'POST', path: '/api/members/feishu%3Aou_1/dismiss' },
      { method: 'POST', path: '/api/pairing', body: { ttlMin: 10 } },
      { method: 'DELETE', path: '/api/pairing/abcd1234' },
      { method: 'GET', path: '/api/questions' },
      { method: 'POST', path: '/api/questions/q1/settle', body: {} },
      { method: 'GET', path: '/api/audit' },
      { method: 'GET', path: '/api/tasks' },
      { method: 'GET', path: '/api/host' },
      { method: 'GET', path: '/api/events' },
    ]
    for (const route of removed) {
      const response = await call(rig, route.path, { method: route.method, body: route.body })
      assert.equal(response.status, 404, `${route.method} ${decodeURIComponent(route.path)} 必须 404（能力不存在）`)
    }
    assert.equal(rig.calls.length, 0, '删除的旧路由绝不触达任何 api 方法')
  })
})
