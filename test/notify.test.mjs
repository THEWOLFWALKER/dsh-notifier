import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/notify.mjs'
import { resolveConfig } from '../src/config.mjs'

/** 构造一个可注入 fetch 的 webhook 渠道 notifier。 */
function makeNotifier(channels, logger = { warn() {} }) {
  const resolved = resolveConfig({ channels })
  assert.equal(resolved.skipped.length, 0)
  return createNotifier({ logger }, resolved.channels)
}

const WARN = []

function webhookChannel(url) {
  return { type: 'webhook', url }
}

test('notify 到未配置渠道：静默跳过 + warn，不 send', async () => {
  const warns = []
  const notifier = createNotifier({ logger: { warn: (...a) => warns.push(a.join(' ')) } }, [])
  const result = await notifier.notify('telegram', { title: 't', content: 'c' })
  assert.equal(result.skipped, true)
  assert.equal(result.ok, false)
  assert.match(warns.join(' '), /telegram.*未配置/)
})

test('notify 到已配置渠道：请求体含 title/content', async () => {
  let seen
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([webhookChannel('http://127.0.0.1:1/hook')])
    const result = await notifier.notify('webhook', { title: '标题', content: '正文', level: 'critical' })
    assert.equal(result.ok, true)
    assert.equal(seen.body.title, '标题')
    assert.equal(seen.body.content, '正文')
    assert.equal(seen.body.level, 'critical')
    assert.ok(typeof seen.body.timestamp === 'string')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notify 失败返回 failed 结果而不是抛出', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'internal' })
  try {
    const notifier = makeNotifier([webhookChannel('http://x/hook')])
    const result = await notifier.notify('webhook', { title: 't', content: 'c' })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /HTTP 500/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll 广播所有已启用渠道', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(url)
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([
      webhookChannel('http://a/hook'),
      webhookChannel('http://b/hook'),
    ])
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.delivered.length, 2)
    assert.deepEqual(seen.sort(), ['http://a/hook', 'http://b/hook'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll: 一个渠道失败不影响其它渠道', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(url)
    if (url.includes('fail')) return { ok: false, status: 500, text: async () => 'boom' }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([
      webhookChannel('http://fail/hook'),
      webhookChannel('http://good/hook'),
    ])
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.delivered.length, 1)
    assert.deepEqual(result.delivered, ['webhook'])
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /HTTP 500/)
    assert.equal(result.ok, false)
    assert.equal(seen.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll: 无已启用渠道时返回空结果并 warn', async () => {
  const warns = []
  const notifier = createNotifier({ logger: { warn: (...a) => warns.push(a.join(' ')) } }, [])
  const result = await notifier.notifyAll({ title: 't', content: 'c' })
  assert.deepEqual(result, { ok: false, delivered: [], skipped: [], failed: [] })
  assert.match(warns.join(' '), /未配置任何已启用渠道/)
})

test('channelCount 与 channels 暴露', () => {
  const notifier = makeNotifier([webhookChannel('http://a/hook'), webhookChannel('http://b/hook')])
  assert.equal(notifier.channelCount, 2)
  assert.deepEqual(notifier.channels, ['webhook', 'webhook'])
})

test('flush 等待在途推送完成（headless 退出前送达）', async () => {
  let resolveSend
  let called = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    called += 1
    return new Promise((resolve) => {
      resolveSend = () => resolve({ ok: true, status: 200, json: async () => ({}) })
    })
  }
  try {
    const notifier = makeNotifier([webhookChannel('http://a/hook')])
    const promise = notifier.notifyAll({ title: 't', content: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(called, 1)
    const flushed = notifier.flush()
    let flushResolved = false
    flushed.then(() => { flushResolved = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushResolved, false, '在途 fetch 未完成时 flush 不应 resolve')
    resolveSend()
    await flushed
    assert.equal(flushResolved, true)
    await promise
  } finally {
    globalThis.fetch = originalFetch
  }
})
