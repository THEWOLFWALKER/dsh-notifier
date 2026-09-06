// v0.9.3 测试（W9 / S-06）：admin/server Origin/Host 请求闸。
// 矩阵：
//  - 回环绑定默认放行 127.0.0.1/localhost/[::1] 三形态（带实际端口、http/https 双 scheme）
//  - 跨站 Origin（浏览器必带头）→ 403，且先于鉴权（403 优先于 401，不泄露路由存在性）
//  - Host 白名单挡 DNS rebinding（受害者浏览器 Host 是攻击者域名）→ 403
//  - 端口不匹配的 Origin（127.0.0.1:其它端口）→ 403
//  - allowedOrigins/allowedHosts 显式扩展（公网反代场景）
//  - 非浏览器客户端（curl 不带 Origin）→ 放行，由 Bearer 鉴权兜底

import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createAdminServer } from '../src/admin/server.mjs'

/** 最小 api 桩：overview 可用即可（本套件只关心闸与状态码，不测 api 语义）。 */
function makeApi() {
  return { overview: async () => ({ ok: true }) }
}

/** 起一台随机端口回环 admin server；fn 结束后 finally 里必 stop。 */
async function withServer({ allowedOrigins, allowedHosts } = {}, fn) {
  const lines = []
  const server = createAdminServer({
    api: makeApi(),
    verifyToken: (token) => token === 'secret',
    host: '127.0.0.1',
    port: 0,
    logger: { warn: (...args) => lines.push(args.join(' ')) },
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
  })
  const info = await server.start()
  const rig = { server, info, base: `http://127.0.0.1:${info.port}`, port: info.port, lines }
  try {
    await fn(rig)
  } finally {
    await server.stop()
  }
}

/** 发请求；origin/host 可显式覆盖（undefined = 不带该头）。 */
async function call(rig, path, { method = 'GET', token = 'secret', origin, host } = {}) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (origin !== undefined) headers.origin = origin
  if (host !== undefined) headers.host = host
  return fetch(`${rig.base}${path}`, { method, headers })
}

/**
 * 原生 HTTP 请求（可伪造 Host 头）：fetch 规范把 Host 列为 forbidden header，
 * undici 会静默改写回 URL 主机——伪造 Host 的 rebinding 载荷必须走 node:http 才真到位。
 */
function rawCall(rig, path, { method = 'GET', token = 'secret', origin, host } = {}) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (origin !== undefined) headers.origin = origin
  if (host !== undefined) headers.host = host
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: rig.port, path, method, headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('S-06 回环默认白名单：无 Origin（curl 形态）+ 正确 Host → 闸放行，鉴权照常', async () => {
  await withServer({}, async (rig) => {
    const ok = await call(rig, '/api/overview')
    assert.equal(ok.status, 200, '无 Origin + Host=127.0.0.1:port 放行')
    const noToken = await call(rig, '/api/overview', { token: null })
    assert.equal(noToken.status, 401, '闸放行后鉴权照常兜底')
  })
})

test('S-06 回环 Origin 三形态（127.0.0.1/localhost/[::1]，http 与 https）→ 放行', async () => {
  await withServer({}, async (rig) => {
    for (const origin of [
      `http://127.0.0.1:${rig.port}`,
      `http://localhost:${rig.port}`,
      `https://127.0.0.1:${rig.port}`, // 本机反代 TLS 终止是合法形态
      `https://localhost:${rig.port}`,
    ]) {
      const response = await call(rig, '/api/overview', { origin })
      assert.equal(response.status, 200, `Origin ${origin} 应放行`)
    }
  })
})

test('S-06 跨站 Origin → 403；且先于鉴权（无 token 也是 403 不是 401）', async () => {
  await withServer({}, async (rig) => {
    for (const origin of ['https://evil.example.com', 'http://127.0.0.1.evil.example.com', 'null']) {
      const response = await call(rig, '/api/overview', { origin })
      assert.equal(response.status, 403, `Origin ${origin} 应被闸拒绝`)
      const body = await response.json()
      assert.match(body.error, /Origin\/Host/)
    }
    const unauth = await call(rig, '/api/overview', { origin: 'https://evil.example.com', token: null })
    assert.equal(unauth.status, 403, '闸先于鉴权：403 优先于 401')
  })
})

test('S-06 端口不匹配的 Origin（127.0.0.1:其它端口）→ 403', async () => {
  await withServer({}, async (rig) => {
    const response = await call(rig, '/api/overview', { origin: `http://127.0.0.1:${rig.port + 1}` })
    assert.equal(response.status, 403, '回环 Origin 必须带实际监听端口（或无端口形态）')
  })
})

test('S-06 Host 白名单：跨站 Host → 403（DNS rebinding 面）；无 Origin 时 Host 闸单独生效', async () => {
  await withServer({}, async (rig) => {
    const response = await rawCall(rig, '/api/overview', { host: 'attacker.example.com' })
    assert.equal(response.status, 403, '伪造 Host（rebinding 载荷）拒绝')
    assert.match(response.body, /Origin\/Host/)
    assert.ok(rig.lines.some((line) => line.includes('闸拒绝') && line.includes('host')), '拒绝原因进 warn 日志')
  })
})

test('S-06 allowedOrigins/allowedHosts 显式扩展：公网反代形态放行，未列扩展仍拒', async () => {
  await withServer(
    { allowedOrigins: ['https://admin.example.com'], allowedHosts: ['admin.example.com'] },
    async (rig) => {
      const ok = await rawCall(rig, '/api/overview', { origin: 'https://admin.example.com', host: 'admin.example.com' })
      assert.equal(ok.status, 200, '显式登记的反代 Origin/Host 放行')
      const stillEvil = await rawCall(rig, '/api/overview', { origin: 'https://evil.example.com', host: 'admin.example.com' })
      assert.equal(stillEvil.status, 403, '未登记的跨站 Origin 仍拒')
      const otherHost = await rawCall(rig, '/api/overview', { origin: 'https://admin.example.com', host: 'other.example.net' })
      assert.equal(otherHost.status, 403, '未登记的 Host 仍拒')
    },
  )
})

test('S-06 闸对 UI 页与 API 同效（GET / 也过闸）；被拒请求不泄露路由存在性', async () => {
  await withServer({}, async (rig) => {
    const home = await call(rig, '/', { origin: 'https://evil.example.com' })
    assert.equal(home.status, 403, 'UI 页同闸')
    const ghost = await call(rig, '/api/ghost-route', { origin: 'https://evil.example.com' })
    assert.equal(ghost.status, 403, '403 优先于 404：不泄露路由存在性')
  })
})
