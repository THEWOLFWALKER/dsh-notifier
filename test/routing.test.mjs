import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRouting, routeTargets, retryPolicyOf, sendWithRetry, normalizeLevel } from '../src/routing.mjs'

test('resolveRouting：未配置时 configured=false，三个 level 均为空', () => {
  const routing = resolveRouting(undefined)
  assert.equal(routing.configured, false)
  assert.deepEqual(routing.byLevel, { timeSensitive: [], active: [], passive: [] })
})

test('resolveRouting：解析 channel + 语义覆盖字段，剔除非对象行', () => {
  const routing = resolveRouting({
    timeSensitive: [
      { channel: 'telegram', sound: true },
      { channel: 'bark', level: 'critical' },
      null,
      { notChannel: true },
    ],
  })
  assert.equal(routing.configured, true)
  assert.deepEqual(routing.byLevel.timeSensitive, [
    { channel: 'telegram', overrides: { sound: true } },
    { channel: 'bark', overrides: { level: 'critical' } },
  ])
})

test('routeTargets：未配置 routing 广播全部渠道（向后兼容基线）', () => {
  const routing = resolveRouting()
  const channels = [{ type: 'telegram' }, { type: 'ntfy' }]
  const msg = { title: 't', content: 'c', level: 'passive' }
  const targets = routeTargets(routing, channels, msg)
  assert.deepEqual(targets.map((target) => target.type), ['telegram', 'ntfy'])
  assert.equal(targets[0].message.silent, undefined)
})

test('routeTargets：配置后按 level 过滤渠道并浅合并覆盖字段', () => {
  const routing = resolveRouting({
    timeSensitive: [{ channel: 'telegram' }, { channel: 'bark', level: 'critical' }],
    passive: [{ channel: 'ntfy', silent: true }],
  })
  const channels = [{ type: 'telegram' }, { type: 'bark' }, { type: 'ntfy' }]
  const targets = routeTargets(routing, channels, { title: '', content: 'c', level: 'timeSensitive' })
  assert.deepEqual(targets.map((target) => target.type), ['telegram', 'bark'])
  assert.equal(targets[1].message.level, 'critical')

  const passive = routeTargets(routing, channels, { title: '', content: 'c', level: 'passive' })
  assert.deepEqual(passive.map((target) => target.type), ['ntfy'])
  assert.equal(passive[0].message.silent, true)

  // active 未配置：该 level 广播全部渠道
  const active = routeTargets(routing, channels, { title: '', content: 'c', level: 'active' })
  assert.deepEqual(active.map((target) => target.type), ['telegram', 'bark', 'ntfy'])
})

test('routeTargets：路由指向未配置渠道时静默跳过', () => {
  const routing = resolveRouting({ timeSensitive: [{ channel: 'slack' }] })
  const targets = routeTargets(routing, [{ type: 'telegram' }], { title: '', content: 'c', level: 'timeSensitive' })
  assert.equal(targets.length, 0)
})

test('retryPolicyOf 分档：timeSensitive 3 次、active 2 次、passive 不重试；可全局覆盖', () => {
  assert.deepEqual(retryPolicyOf('timeSensitive'), { attempts: 3, backoffMs: 2000 })
  assert.deepEqual(retryPolicyOf('active'), { attempts: 2, backoffMs: 2000 })
  assert.deepEqual(retryPolicyOf('passive'), { attempts: 1, backoffMs: 0 })
  assert.deepEqual(retryPolicyOf('nonsense'), retryPolicyOf('active')) // 未知归 active
  assert.deepEqual(retryPolicyOf('timeSensitive', { enabled: false }), { attempts: 1, backoffMs: 0 })
  assert.equal(retryPolicyOf('passive', { attempts: 4 }).attempts, 4)
})

test('sendWithRetry：首次成功不重试', async () => {
  let calls = 0
  await sendWithRetry(async () => { calls += 1 }, { attempts: 3 })
  assert.equal(calls, 1)
})

test('sendWithRetry：第 3 次成功，前两次触发 onRetry；退避为 0（测试注入）', async () => {
  let calls = 0
  const retries = []
  await sendWithRetry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error('flaky')
    },
    { attempts: 3, backoffMs: 0, onRetry: (attempt, error) => retries.push([attempt, error.message]) },
  )
  assert.equal(calls, 3)
  assert.deepEqual(retries, [[1, 'flaky'], [2, 'flaky']])
})

test('sendWithRetry：全部失败抛最后一次错误', async () => {
  await assert.rejects(
    sendWithRetry(async () => { throw new Error(`boom-${Date.now()}`) }, { attempts: 2, backoffMs: 0 }),
    /boom-/,
  )
})

test('normalizeLevel：未知值归 active', () => {
  assert.equal(normalizeLevel('timeSensitive'), 'timeSensitive')
  assert.equal(normalizeLevel(undefined), 'active')
  assert.equal(normalizeLevel('critical'), 'active')
})

test('notifyAll 集成：路由 silent 覆盖落到 telegram disable_notification；ntfy 优先级映射', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body })
    const u = String(url)
    if (u.includes('/bot')) return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 })
    return new Response('{"id":"x"}', { status: 200 })
  }
  try {
    const { createNotifier } = await import('../src/notify.mjs')
    const channels = [
      { type: 'telegram', config: { botToken: 'T', chatId: '1', apiBase: 'https://tg.example', timeoutMs: 1000 } },
      { type: 'ntfy', config: { server: 'https://ntfy.example.com', topic: 't', auth: '', timeoutMs: 1000 } },
    ]
    // passive 只路由 telegram 且 silent
    const notifier = createNotifier(null, channels, {
      routing: { passive: [{ channel: 'telegram', silent: true }] },
      retry: { enabled: false },
    })
    const outcome = await notifier.notifyAll({ title: '完成', content: 'ok', level: 'passive' })
    assert.deepEqual(outcome.delivered, ['telegram'])
    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].body)
    assert.equal(body.disable_notification, true)

    // timeSensitive 广播：ntfy 优先级 5 + telegram 响铃
    // v0.6.5：ntfy 改 JSON 发布协议（topic/title/message/priority 全进 body，
    // 中文标题不再走 x-title 头触发 undici ByteString 校验必炸）
    calls.length = 0
    const notifier2 = createNotifier(null, channels, {
      routing: { timeSensitive: [{ channel: 'ntfy' }, { channel: 'telegram' }] },
      retry: { enabled: false },
    })
    await notifier2.notifyAll({ title: '批准', content: '?', level: 'timeSensitive' })
    assert.equal(calls.length, 2)
    const ntfyCall = calls.find((call) => call.url.includes('ntfy'))
    const tgCall = calls.find((call) => call.url.includes('/bot'))
    assert.equal(ntfyCall.url, 'https://ntfy.example.com')
    const ntfyBody = JSON.parse(ntfyCall.body)
    assert.equal(ntfyBody.topic, 't')
    assert.equal(ntfyBody.title, '批准')
    assert.equal(ntfyBody.priority, 5)
    assert.equal(tgCall.body.disable_notification, undefined)
  } finally {
    delete globalThis.fetch
  }
})

test('notifyAll 集成：timeSensitive 渠道失败按策略重试（指数退避，测试注入 0）', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls < 3) return new Response('err', { status: 500 })
    return new Response('{"ok":true,"result":{}}', { status: 200 })
  }
  try {
    const { createNotifier } = await import('../src/notify.mjs')
    const channels = [{ type: 'telegram', config: { botToken: 'T', chatId: '1', apiBase: 'https://tg.example', timeoutMs: 1000 } }]
    const notifier = createNotifier(null, channels, {
      routing: { timeSensitive: [{ channel: 'telegram' }] },
      retry: { attempts: 3, backoffMs: 0 },
    })
    const outcome = await notifier.notifyAll({ title: 't', content: 'c', level: 'timeSensitive' })
    assert.deepEqual(outcome.delivered, ['telegram'])
    assert.equal(calls, 3)
  } finally {
    delete globalThis.fetch
  }
})
