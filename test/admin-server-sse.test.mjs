// dsh-notifier test/admin-server-sse.test.mjs
// GET /api/events SSE 端点测试：鉴权、流式头、缓冲重放、实时推送、心跳保活、
// 断连退订清理、events 未装配 501、stop() 收敛流连接。

import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { createAdminServer } from '../src/admin/server.mjs'
import { createEventHub } from '../src/admin/events.mjs'

const TOKEN = 'sse-test-token'
const RECORD = (title) => ({
  time: new Date().toISOString(),
  message: { title, content: '正文', level: 'active' },
  ok: true, delivered: ['bell'], skipped: [], failed: [],
})

/** 起 admin server（随机端口 + 真 hub），返回 { port, hub, stop }。 */
async function boot({ events = createEventHub(), heartbeatMs = 15_000 } = {}) {
  const server = createAdminServer({
    api: {}, // SSE 路由不触 api
    verifyToken: (token) => token === TOKEN,
    host: '127.0.0.1',
    port: 0,
    events,
    heartbeatMs,
  })
  const { port } = await server.start()
  return { port, hub: events, stop: () => server.stop() }
}

/**
 * 打开 SSE 连接（带 token），累积收到的原始文本；until(text) 命中期待子串即 resolve。
 * 返回 { text(): string, abort(): Promise<void>, done: Promise<void> }。
 */
function openStream(port, { token = TOKEN } = {}) {
  let text = ''
  let resolveWait = null
  let waitTarget = null
  const req = get({
    host: '127.0.0.1', port, path: '/api/events',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      text += chunk
      if (waitTarget !== null && text.includes(waitTarget)) {
        const resolve = resolveWait
        waitTarget = null
        resolveWait = null
        resolve()
      }
    })
  })
  req.on('error', () => { /* abort 后的 ECONNRESET 属预期 */ })
  const done = new Promise((resolve) => req.on('close', resolve))
  return {
    text: () => text,
    until: (target) => new Promise((resolve, reject) => {
      if (text.includes(target)) return resolve()
      waitTarget = target
      resolveWait = resolve
      setTimeout(() => {
        if (waitTarget === target) {
          waitTarget = null
          resolveWait = null
          reject(new Error(`等待 SSE 内容超时：${target}（已收到：${JSON.stringify(text)}）`))
        }
      }, 3000)
    }),
    abort: async () => { req.destroy(); await done },
    done,
  }
}

test('401：无 token 打不开事件流（与 /api/* 同闸）', async () => {
  const rig = await boot()
  try {
    const outcome = await new Promise((resolve) => {
      const req = get({ host: '127.0.0.1', port: rig.port, path: '/api/events' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', () => resolve(null))
    })
    assert.equal(outcome, 401)
  } finally {
    await rig.stop()
  }
})

test('200 + text/event-stream：连上即收 : connected，且重放缓冲里的历史事件', async () => {
  const rig = await boot()
  try {
    rig.hub.publish(RECORD('历史事件'))
    const stream = openStream(rig.port)
    await stream.until('data: ')
    assert.ok(stream.text().includes(': connected'))
    assert.ok(stream.text().includes('"replay":true'))
    assert.ok(stream.text().includes('历史事件'))
    await stream.abort()
  } finally {
    await rig.stop()
  }
})

test('实时推送：连接后 publish 即达（replay:false）', async () => {
  const rig = await boot()
  try {
    const stream = openStream(rig.port)
    await stream.until(': connected')
    rig.hub.publish(RECORD('实时事件'))
    await stream.until('实时事件')
    assert.ok(stream.text().includes('"replay":false'))
    await stream.abort()
  } finally {
    await rig.stop()
  }
})

test('心跳：heartbeatMs 周期性 : hb 注释行保活', async () => {
  const rig = await boot({ heartbeatMs: 60 })
  try {
    const stream = openStream(rig.port)
    await stream.until(': connected')
    await stream.until(': hb')
    await stream.abort()
  } finally {
    await rig.stop()
  }
})

test('断连清理：客户端 abort → hub 退订（listenerCount 归零）', async () => {
  const rig = await boot()
  try {
    const stream = openStream(rig.port)
    await stream.until(': connected')
    assert.equal(rig.hub.listenerCount(), 1)
    await stream.abort()
    // close 事件异步传播：轮询等归零
    for (let i = 0; i < 50 && rig.hub.listenerCount() !== 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(rig.hub.listenerCount(), 0, '断连后退订，绝不外泄订阅')
  } finally {
    await rig.stop()
  }
})

test('events 未装配 → 501 而非 404（能力不可用语义）', async () => {
  const rig = await boot({ events: null })
  try {
    const outcome = await new Promise((resolve) => {
      const req = get({
        host: '127.0.0.1', port: rig.port, path: '/api/events',
        headers: { authorization: `Bearer ${TOKEN}` },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', () => resolve(null))
    })
    assert.equal(outcome, 501)
  } finally {
    await rig.stop()
  }
})

test('stop() 掐断在开的流连接且幂等收敛', async () => {
  const rig = await boot()
  const stream = openStream(rig.port)
  await stream.until(': connected')
  await rig.stop() // closeAllConnections：流 done 应 settle
  await Promise.race([
    stream.done,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('stop 后流连接未收敛')), 1000) }),
  ])
  await rig.stop() // 幂等
})
