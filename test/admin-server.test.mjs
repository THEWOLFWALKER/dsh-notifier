// v0.3.3 测试：admin/server（HTTP 级）——鉴权 / 路由 / body 限制 / 错误映射 / 生命周期。
// 全部用 fake api 对象（每方法返回固定对象，按需抛 ApiError/普通 Error）+ verifyToken 只认 'secret'；
// 不 import src/admin/api.mjs（并行开发解耦）。真实临时端口 server + 本机 fetch。

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

/**
 * fake api：十个方法全部记录调用并返回固定对象；overrides 按名替换（抛错/改返回值）。
 * @returns {{ api: object, calls: Array<{ name: string, args: unknown[] }> }}
 */
function makeApi(overrides = {}, { latencyMs = 0 } = {}) {
  const calls = []
  const api = {}
  const results = {
    overview: { via: 'overview', sessions: 3 },
    getBindings: { via: 'getBindings' },
    putBindings: { via: 'putBindings', saved: true },
    getSessions: { via: 'getSessions', sessions: [] },
    patchSession: { via: 'patchSession', patched: true },
    getChannels: { via: 'getChannels', channels: [] },
    putChannel: { via: 'putChannel', written: true },
    testChannel: { via: 'testChannel', healthy: true },
    scanChannel: { via: 'scanChannel', qr: 'QR-CONTENT' },
    getAudit: { via: 'getAudit', entries: [] },
    getMembers: { via: 'getMembers', guided: false, members: [], pending: [], pairingCodes: [] },
    putMember: { via: 'putMember', saved: true },
    deleteMember: { via: 'deleteMember', deleted: true },
    confirmPendingMember: { via: 'confirmPendingMember', confirmed: true },
    dismissPendingMember: { via: 'dismissPendingMember', dismissed: true },
    mintPairingCode: { via: 'mintPairingCode', id: 'abcd1234', code: 'ABCDEFGH', expiresAt: 0 },
    revokePairingCode: { via: 'revokePairingCode', revoked: true },
  }
  for (const [name, result] of Object.entries(results)) {
    api[name] = async (...args) => {
      calls.push({ name, args })
      if (latencyMs > 0) await tick(latencyMs)
      const override = overrides[name]
      if (override !== undefined) return override(...args)
      return result
    }
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
async function call(rig, path, { method = 'GET', token = 'secret', rawAuth, body } = {}) {
  const headers = {}
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
    assert.equal((await call(rig, '/api/overview')).status, 200, '随机端口真实可访问')
  })
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
  await assert.rejects(() => fetch(`http://127.0.0.1:${info.port}/api/overview`))
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

// §5.3 修补验收（最小静态断言）：fields 驱动建单 / editable 只读行 / 审计 detail 归一 /
// 扫码 error 分支 / 凭证热更新提示——UI 是纯静态串，关键字在即可，交互留给浏览器。
test('ADMIN_UI_HTML：含 fields 建单与 editable 只读的关键字（§5.3 五缺口最小断言）', () => {
  for (const keyword of [
    'c.fields',          // 缺口 1：空配置通道按 fields 渲染新建表单
    'data-req',          // 缺口 1：必填字段标记（required）
    'c.editable',        // 缺口 2：editable=false 只读行判定
    'YAML bootstrap',    // 缺口 2：只读提示文案
    'JSON.stringify',    // 缺口 3：审计 detail 对象归一展示
    '扫码失败：',         // 缺口 4：scanChannel 终态 error 分支
    '下次启动',           // 缺口 5：store 凭证热更新边界提示
    'plain(r).saved === false', // 缺口 5：saved=false 写入失败分支（不只看成功路径）
  ]) {
    assert.ok(ADMIN_UI_HTML.includes(keyword), `ADMIN_UI_HTML 应包含关键字 ${keyword}`)
  }
})

test('ADMIN_UI_HTML：通知页关键字（v0.4.0 SSE → 浏览器系统通知）', () => {
  for (const keyword of [
    'id="tab-notify"',        // 第五标签页
    '/api/events',            // SSE 事件流端点
    "Notification.permission", // 权限状态渲染
    'requestPermission',      // 授权按钮
    'new Notification',       // 系统通知构造（含 tag 复用）
    "tag: 'dsh-notify-'",     // 同级别 tag 顶掉旧横幅
    'AudioContext',           // Web Audio 提示音
    'getReader',              // fetch 流式读（EventSource 不支持 Authorization 头）
    'startNotifyStream',      // 连接生命周期（断线 5s 重连）
    'e.replay === true',      // 重放事件只进日志不弹窗
    'dsh-notify-prefs',       // 偏好 localStorage 持久化
    'hiddenOnly',             // 「仅页面不可见时弹」偏好键
  ]) {
    assert.ok(ADMIN_UI_HTML.includes(keyword), `ADMIN_UI_HTML 应包含关键字 ${keyword}`)
  }
})

test('ADMIN_UI_HTML：移动端适配关键字（v0.5 特性 D，≤768px 纯 CSS 增量）', () => {
  for (const keyword of [
    '@media (max-width: 768px)', // 断点块整体存在
    'nav { flex-wrap: nowrap; overflow-x: auto', // 导航标签横滚
    'table { display: block; overflow-x: auto', // 宽表横向滚动
    'label.fld { flex-direction: column', // 表单字段单列（标签上移）
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
    const response = await call(rig, '/api/overview', { token: null })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(await jsonOf(response), { error: '鉴权失败：缺少或错误的 Bearer token' })
    assert.equal(rig.calls.length, 0, '未授权绝不触达 api')
  })
})

test('401：错误 token → 401', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/overview', { token: 'wrong' })).status, 401)
    assert.equal((await call(rig, '/api/audit', { token: '' })).status, 401)
  })
})

test('401：Bearer 格式错误（裸 token / Basic / 无空格 / 双空格错位）→ 401', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/overview', { rawAuth: 'secret' })).status, 401, '缺 Bearer 前缀')
    assert.equal((await call(rig, '/api/overview', { rawAuth: 'Basic secret' })).status, 401, '非 Bearer scheme')
    assert.equal((await call(rig, '/api/overview', { rawAuth: 'Bearersecret' })).status, 401, '缺空格')
    assert.equal((await call(rig, '/api/overview', { rawAuth: 'Bearer  secret' })).status, 401, '双空格 → token 带 lead space')
  })
})

test('401 优先于 404：未鉴权探测未知 /api 路径也只回 401（不泄露路由存在性）', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/definitely-not-exist', { token: null })
    assert.equal(response.status, 401)
    assert.equal(rig.calls.length, 0)
  })
})

// ---------------------------------------------------------------- 只读路由

test('GET /api/overview：Bearer secret → 200 JSON，api.overview() 结果透传', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/overview')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.ok(Number(response.headers.get('content-length')) > 0, 'JSON 响应也带 Content-Length')
    assert.deepEqual(await jsonOf(response), { via: 'overview', sessions: 3 })
    assert.deepEqual(rig.calls, [{ name: 'overview', args: [] }])
  })
})

test('GET /api/bindings / sessions / channels / audit：全部 200 且各调对应 api 方法', async () => {
  await withServer({}, async (rig) => {
    for (const [path, name, expected] of [
      ['/api/bindings', 'getBindings', { via: 'getBindings' }],
      ['/api/sessions', 'getSessions', { via: 'getSessions', sessions: [] }],
      ['/api/channels', 'getChannels', { via: 'getChannels', channels: [] }],
      ['/api/audit', 'getAudit', { via: 'getAudit', entries: [] }],
    ]) {
      const response = await call(rig, path)
      assert.equal(response.status, 200, path)
      assert.deepEqual(await jsonOf(response), expected)
      assert.equal(rig.calls.at(-1).name, name)
    }
    assert.equal(rig.calls.length, 4)
  })
})

// ---------------------------------------------------------------- 写路由（body 透传）

test('PUT /api/bindings：body 解析后透传 api.putBindings(body)', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/bindings', { method: 'PUT', body: { agents: { dsh: { channels: ['bark'] } } } })
    assert.equal(response.status, 200)
    assert.deepEqual(await jsonOf(response), { via: 'putBindings', saved: true })
    assert.deepEqual(rig.calls, [{ name: 'putBindings', args: [{ agents: { dsh: { channels: ['bark'] } } }] }])
  })
})

test('PUT /api/bindings：空 body 当 {} 传入（契约）', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/bindings', { method: 'PUT', body: '' })
    assert.equal(response.status, 200)
    assert.deepEqual(rig.calls[0].args, [{}])
  })
})

test('PATCH /api/sessions/:id：路径参数与 body 一起透传 api.patchSession(id, body)', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/sessions/sess-abc-123', { method: 'PATCH', body: { outbound: { quiet: true } } })
    assert.equal(response.status, 200)
    assert.deepEqual(await jsonOf(response), { via: 'patchSession', patched: true })
    assert.deepEqual(rig.calls, [{ name: 'patchSession', args: ['sess-abc-123', { outbound: { quiet: true } }] }])
  })
})

test('PUT /api/channels/:type：body.config 优先；无 config 键时整个 body 直传', async () => {
  await withServer({}, async (rig) => {
    await call(rig, '/api/channels/telegram', { method: 'PUT', body: { config: { botToken: 'T1' } } })
    assert.deepEqual(rig.calls[0], { name: 'putChannel', args: ['telegram', { botToken: 'T1' }] })

    await call(rig, '/api/channels/bark', { method: 'PUT', body: { deviceKey: 'K' } })
    assert.deepEqual(rig.calls[1], { name: 'putChannel', args: ['bark', { deviceKey: 'K' }] })
  })
})

test('POST /api/channels/:type/test → api.testChannel(type)；带 JSON body 也放行', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/channels/telegram/test', { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(await jsonOf(response), { via: 'testChannel', healthy: true })
    assert.deepEqual(rig.calls, [{ name: 'testChannel', args: ['telegram'] }])

    assert.equal((await call(rig, '/api/channels/wxpusher/test', { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(rig.calls[1].args, ['wxpusher'])
  })
})

test('POST /api/scan/:channel → api.scanChannel(channel)', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/scan/qq', { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(await jsonOf(response), { via: 'scanChannel', qr: 'QR-CONTENT' })
    assert.deepEqual(rig.calls, [{ name: 'scanChannel', args: ['qq'] }])
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

test('段匹配精确性：:type 只吞单段（/api/channels/telegram/test 只认 POST）；多余段/尾斜杠 → 404', async () => {
  await withServer({}, async (rig) => {
    // 该路径存在（POST .../test），PUT 属方法不符 → 405，而非被 :type 吞成 putChannel('telegram/test')
    assert.equal((await call(rig, '/api/channels/telegram/test', { method: 'PUT', body: {} })).status, 405)
    assert.equal((await call(rig, '/api/channels/telegram/test/x', { method: 'PUT', body: {} })).status, 404, '5 段路径无路由')
    assert.equal((await call(rig, '/api/overview/')).status, 404, '尾斜杠产生空段，不命中')
    assert.equal(rig.calls.length, 0, '以上皆不触达 api')
  })
})

test('405：路径存在但方法不符 → { error: "方法不允许：<method>" }（多个角度）', async () => {
  await withServer({}, async (rig) => {
    assert.deepEqual(await jsonOf(await call(rig, '/api/bindings', { method: 'DELETE' })), { error: '方法不允许：DELETE' })
    assert.equal((await call(rig, '/api/overview', { method: 'POST' })).status, 405)
    assert.equal((await call(rig, '/api/sessions/abc', { method: 'PUT' })).status, 405)
    assert.equal((await call(rig, '/', { method: 'POST', token: null })).status, 405, 'GET / 存在 → POST / 405')
    assert.equal((await call(rig, '/api/channels/telegram/test', { method: 'GET' })).status, 405)
    assert.equal(rig.calls.length, 0, '405 绝不触达 api')
  })
})

// ---------------------------------------------------------------- body 解析与上限

test('400：非 JSON body → { error: "请求体不是合法 JSON" }', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/bindings', { method: 'PUT', body: 'not-json{' })
    assert.equal(response.status, 400)
    assert.deepEqual(await jsonOf(response), { error: '请求体不是合法 JSON' })
    assert.equal(rig.calls.length, 0)
  })
})

test('413：请求体超过 1MB 上限 → 中文 error，绝不进 api', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/bindings', { method: 'PUT', body: 'x'.repeat(1024 * 1024 + 1) })
    assert.equal(response.status, 413)
    const payload = await jsonOf(response)
    assert.match(payload.error, /1MB/)
    assert.equal(rig.calls.length, 0)
  })
})

// ---------------------------------------------------------------- 错误映射

test('ApiError 透传：422 / 404 / 501 原样回 status + { error: message }', async () => {
  await withServer({
    apiOverrides: {
      putBindings: () => { throw apiError(422, '绑定矩阵格式不合法') },
      patchSession: () => { throw apiError(404, '会话不存在') },
      scanChannel: () => { throw apiError(501, '该通道不支持扫码授权') },
    },
  }, async (rig) => {
    const unprocessable = await call(rig, '/api/bindings', { method: 'PUT', body: { bad: 1 } })
    assert.equal(unprocessable.status, 422)
    assert.deepEqual(await jsonOf(unprocessable), { error: '绑定矩阵格式不合法' })

    const missing = await call(rig, '/api/sessions/gone', { method: 'PATCH', body: {} })
    assert.equal(missing.status, 404)
    assert.deepEqual(await jsonOf(missing), { error: '会话不存在' })

    const unsupported = await call(rig, '/api/scan/bark', { method: 'POST' })
    assert.equal(unsupported.status, 501)
    assert.deepEqual(await jsonOf(unsupported), { error: '该通道不支持扫码授权' })
  })
})

test('api 普通异常 → 500 { error: "内部错误" }；堆栈/原始消息绝不泄给客户端；logger warn 落日志', async () => {
  await withServer({
    apiOverrides: {
      getAudit: () => { throw new Error('state.json 读取失败: EACCES at /secret/path') },
    },
  }, async (rig) => {
    const response = await call(rig, '/api/audit')
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
    const response = await call(rig, '/api/overview')
    assert.equal(response.status, 401)
    assert.deepEqual(await jsonOf(response), { error: '鉴权失败：缺少或错误的 Bearer token' })
  })
})

// ---------------------------------------------------------------- 并发

test('并发：10 个并发请求（带 api 延迟）全部 200 且 body 各自正确', async () => {
  await withServer({ latencyMs: 8 }, async (rig) => {
    const plan = [
      ['/api/overview', 'overview'],
      ['/api/bindings', 'getBindings'],
      ['/api/sessions', 'getSessions'],
      ['/api/channels', 'getChannels'],
      ['/api/audit', 'getAudit'],
    ]
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(rig, plan[i % plan.length][0])),
    )
    assert.equal(responses.length, 10)
    for (let i = 0; i < responses.length; i += 1) {
      assert.equal(responses[i].status, 200, `第 ${i} 个请求`)
      const payload = await jsonOf(responses[i])
      assert.equal(payload.via, plan[i % plan.length][1], `第 ${i} 个请求 body 指向正确的 api 方法`)
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
  // 1) 行为断言：从 ui 串提取 esc() 求值，注入 payload 必须被五类字符转义
  const match = ADMIN_UI_HTML.match(/function esc\(v\) \{[\s\S]*?\n\}/)
  assert.ok(match !== null, 'ui 内必须存在 esc() 转义函数')
  const esc = new Function(`return (${match[0]})`)()
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
  assert.equal(esc('"\'&'), '&quot;&#39;&amp;')
  // 2) 覆盖面断言：所有 innerHTML 拼接点（渲染函数族）保持 esc() 使用密度——
  //    未来重构若新增裸拼接（丢 esc），该下限断言立即红
  const uses = (ADMIN_UI_HTML.match(/esc\(/g) ?? []).length
  assert.ok(uses >= 30, `esc() 调用密度不足（实际 ${uses} 次，下限 30）——检查新增渲染路径是否漏转义`)
  // 3) 关键渲染点抽查：审计行/事件行/卡片/会话行的动态插值均以 esc( 包裹
  for (const probe of ['esc(fmtTime(r.time))', 'esc(row.title)', "esc(c.type)", 'esc(id)']) {
    assert.ok(ADMIN_UI_HTML.includes(probe), `渲染层必须包含 ${probe}`)
  }
})

// ---------------------------------------------------------------- v0.7 成员/配对码路由（鉴权 + 参数透传 + 错误映射）

test('v0.7 路由：成员与配对码七条路由全挂载，鉴权先行（无 token 401，错误 token 401）', async () => {
  await withServer({}, async (rig) => {
    const routes = [
      { method: 'GET', path: '/api/members' },
      { method: 'PUT', path: '/api/members/feishu%3Aou_1', body: { label: 'x' } },
      { method: 'DELETE', path: '/api/members/feishu%3Aou_1' },
      { method: 'POST', path: '/api/members/feishu%3Aou_1/confirm' },
      { method: 'POST', path: '/api/members/feishu%3Aou_1/dismiss' },
      { method: 'POST', path: '/api/pairing', body: { ttlMin: 10 } },
      { method: 'DELETE', path: '/api/pairing/abcd1234' },
    ]
    for (const route of routes) {
      assert.equal((await call(rig, route.path, { method: route.method, body: route.body, token: null })).status, 401,
        `${route.method} ${decodeURIComponent(route.path)} 无 token 必 401`)
      assert.equal((await call(rig, route.path, { method: route.method, body: route.body, token: 'wrong' })).status, 401,
        `${route.method} ${decodeURIComponent(route.path)} 错 token 必 401`)
    }
    // 正确 token：全部 200 且命中对应 api 方法
    for (const route of routes) {
      const response = await call(rig, route.path, { method: route.method, body: route.body })
      assert.equal(response.status, 200, `${route.method} ${decodeURIComponent(route.path)} 正确 token 应 200`)
    }
    const names = rig.calls.map((entry) => entry.name)
    assert.deepEqual(names.sort(), [
      'confirmPendingMember', 'deleteMember', 'dismissPendingMember', 'getMembers',
      'mintPairingCode', 'putMember', 'revokePairingCode',
    ])
  })
})

test('v0.7 路由：:key/:id 参数解码透传（URL 编码的复合键与配对码 id）', async () => {
  await withServer({}, async (rig) => {
    await call(rig, '/api/members/feishu%3Aou_user01', { method: 'PUT', body: { role: 'owner' } })
    assert.deepEqual(rig.calls.at(-1).args, ['feishu:ou_user01', { role: 'owner' }], '复合键解码后透传')

    await call(rig, '/api/pairing/abcd1234', { method: 'DELETE' })
    assert.deepEqual(rig.calls.at(-1).args, ['abcd1234'])

    await call(rig, '/api/pairing', { method: 'POST', body: { ttlMin: 30, label: '新成员' } })
    assert.deepEqual(rig.calls.at(-1).args, [{ ttlMin: 30, label: '新成员' }], 'JSON body 解析后透传')
  })
})

test('v0.7 路由：ApiError status 映射（422/404/501）与错误形状 { error }', async () => {
  const statusOf = (status) => async (...args) => { throw apiError(status, `boom-${args.length}`) }
  await withServer({ apiOverrides: {
    putMember: statusOf(422),
    deleteMember: statusOf(404),
    mintPairingCode: statusOf(501),
    confirmPendingMember: statusOf(409),
  } }, async (rig) => {
    const cases = [
      { method: 'PUT', path: '/api/members/k', body: {}, expected: 422 },
      { method: 'DELETE', path: '/api/members/k', expected: 404 },
      { method: 'POST', path: '/api/pairing', body: {}, expected: 501 },
      { method: 'POST', path: '/api/members/k/confirm', expected: 409 },
    ]
    for (const item of cases) {
      const response = await call(rig, item.path, { method: item.method, body: item.body })
      assert.equal(response.status, item.expected)
      const body = await jsonOf(response)
      assert.match(body.error, /^boom-/)
    }
  })
})

test('v0.7 路由：路径段数不匹配 404（/api/members/:key/confirm 后再多一段不命中任何路由）', async () => {
  await withServer({}, async (rig) => {
    assert.equal((await call(rig, '/api/members/a/b/c/d')).status, 404)
    assert.equal((await call(rig, '/api/pairing/abc/extra')).status, 404)
    assert.equal((await call(rig, '/api/members/feishu%3Aou_1/reject', { method: 'POST' })).status, 404,
      '未知子动作 reject 不是路由')
    assert.equal(rig.calls.length, 0, '未命中路由不触碰 api 层')
  })
})
