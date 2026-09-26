// v0.13 (B1)：安全网络策略的测试路径必须等价于生产路径。
// 生产模块不得识别“测试模式”；这里用显式 seam 复现真实链路：
//   resolve → 校验地址 → pinnedLookupFor → 原生 http/https 请求
// 全部 hermetic（仅 loopback），不依赖外网，也不依赖 NODE_TEST_CONTEXT。

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  guardedNetworkFetch,
  nativeRequest,
  pinnedLookupFor,
  resolveNetworkTarget,
  __setRequestImplForTests,
} from '../src/security/network-policy.mjs'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

test('B1：已验证 target（含 pinned addresses）原样到达 request seam', async () => {
  const seen = []
  const response = await guardedNetworkFetch('https://validated-target.example.test/hook', {}, {
    channel: 'webhook',
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: async (target, init) => { seen.push({ target, init }); return { ok: true, status: 200 } },
  })
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1, 'request seam 必须收到一次调用')
  assert.equal(seen[0].target.host, 'validated-target.example.test')
  assert.deepEqual(seen[0].target.addresses, [{ address: '93.184.216.34', family: 4 }])
})

test('B1：只解析一次并固定地址，连接阶段无第二次（可重绑定）DNS 查询', async () => {
  let lookups = 0
  const lookupImpl = async () => {
    lookups += 1
    // 第二次解析若真被调用会返回私网地址；正确的实现不得调用它
    return lookups === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.7', family: 4 }]
  }
  const target = await resolveNetworkTarget('https://rebind-guard.example.test/hook', { channel: 'webhook', lookupImpl })
  assert.equal(lookups, 1)

  const selected = await new Promise((resolve, reject) => {
    pinnedLookupFor(target)('rebind-guard.example.test', { family: 0 }, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })
  assert.deepEqual(selected, { address: '93.184.216.34', family: 4 })
  assert.equal(lookups, 1, '连接阶段必须使用 pinned lookup，不得再次解析')

  const cached = await resolveNetworkTarget('https://rebind-guard.example.test/hook', { channel: 'webhook', lookupImpl })
  assert.deepEqual(cached.addresses, [{ address: '93.184.216.34', family: 4 }])
  assert.equal(lookups, 1, '短 TTL 缓存内不得重复解析')
})

test('B1：生产原生路径 hermetic 集成（loopback：resolve→pin→native request）', async () => {
  let hit = 0
  const server = http.createServer((req, res) => {
    hit += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pong: true, path: req.url }))
  })
  const port = await listen(server)
  try {
    const response = await guardedNetworkFetch(`http://127.0.0.1:${port}/ping`, {}, {
      channel: 'webhook', allowPrivate: true, requestImpl: nativeRequest,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { pong: true, path: '/ping' })
    assert.equal(hit, 1, '必须真正建立原生连接')
  } finally {
    await close(server)
  }
})

test('B1：默认 transport 仍是原生 pinned request（重置 seam 后直连 loopback）', async () => {
  __setRequestImplForTests(null) // 恢复生产默认
  let hit = 0
  const server = http.createServer((req, res) => { hit += 1; res.writeHead(204); res.end() })
  const port = await listen(server)
  try {
    const response = await guardedNetworkFetch(`http://127.0.0.1:${port}/default`, {}, {
      channel: 'webhook', allowPrivate: true,
    })
    assert.equal(response.status, 204)
    assert.equal(hit, 1, '未注入 seam 时必须走原生请求')
  } finally {
    await close(server)
    // 还原 hermetic 测试边界（suite 默认经由受控 fetch）
    __setRequestImplForTests((target, init) => globalThis.fetch(target.url.href, { ...init, redirect: 'manual' }))
  }
})

test('B1：原生路径不跟随 3xx（redirect 保持 manual）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/steal' })
    res.end()
  })
  const port = await listen(server)
  try {
    const response = await guardedNetworkFetch(`http://127.0.0.1:${port}/redirect`, {}, {
      channel: 'webhook', allowPrivate: true, requestImpl: nativeRequest,
    })
    assert.equal(response.status, 302, '必须原样返回 3xx，不得跟随')
    assert.equal(response.headers.get('location'), 'http://169.254.169.254/steal')
    await response.body?.cancel?.()
  } finally {
    await close(server)
  }
})