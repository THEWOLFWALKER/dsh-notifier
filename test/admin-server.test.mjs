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
