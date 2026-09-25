// v0.11 Commit15 — 消费方测试工具 `dsh-notifier/testing`（ROADMAP W1 行为规格）。
// `src/testing.mjs` 刻意不 import 内部实现，所以这里也从公共子路径导入，
// 确保导出面本身就是消费方能拿到的那个面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeNotifier } from 'dsh-notifier/testing'
import { PUBLIC_API_VERSION } from '../src/public.mjs'

test('testing fake: version mirrors the public notifier API version', () => {
  const fake = createFakeNotifier()
  assert.equal(fake.version, '0.7')
  assert.equal(fake.version, PUBLIC_API_VERSION, 'fake 与真 facade 必须同一公共面版本')
  assert.equal(typeof fake.push, 'function')
  assert.equal(typeof fake.flush, 'function')
  assert.equal(Array.isArray(fake.calls), true)
  assert.deepEqual(fake.calls, [])
})

test('testing fake: a normal push records the call and reports the fake channel', async () => {
  const fake = createFakeNotifier({ now: () => 1234 })
  const result = await fake.push({ title: 'T', content: 'C', level: 'timeSensitive' }, { sourceName: 'consumer-demo' })
  assert.deepEqual(result, {
    ok: true,
    delivered: ['fake'],
    skipped: [],
    failed: [],
    source: { kind: 'plugin', name: 'consumer-demo' },
  })
  assert.deepEqual(fake.calls, [{
    message: { title: 'T', content: 'C', level: 'timeSensitive' },
    options: { sourceName: 'consumer-demo' },
    at: 1234,
  }])
})

test('testing fake: the public source kind is plugin, never dsh-notifier', async () => {
  const result = await createFakeNotifier().push({ content: 'hi' })
  assert.equal(result.source.kind, 'plugin')
  assert.notEqual(result.source.kind, 'dsh-notifier')
})

test('testing fake: title-only and content-only are valid pushes', async () => {
  const fake = createFakeNotifier()
  assert.deepEqual((await fake.push({ title: 'only title' })).delivered, ['fake'])
  assert.deepEqual((await fake.push({ content: 'only content' })).delivered, ['fake'])
  assert.equal(fake.calls.length, 2)
})

test('testing fake: a double-empty (or non-string) message is malformed but still ok', async () => {
  const fake = createFakeNotifier()
  const malformed = await fake.push({ title: 42, content: null })
  assert.deepEqual(malformed, {
    ok: true,
    delivered: [],
    skipped: ['(malformed)'],
    failed: [],
    source: { kind: 'plugin', name: 'anonymous' },
  })
  assert.deepEqual((await fake.push()).skipped, ['(malformed)'])
  assert.deepEqual(fake.calls[0].message, { title: '', content: '' })
})

test('testing fake: every simulate branch maps to its skipped marker', async () => {
  const fake = createFakeNotifier()
  for (const [simulate, marker] of [
    ['rate-limited', '(rate-limited)'],
    ['disabled', '(disabled)'],
    ['budget', '(budget)'],
    ['busy', '(busy)'],
  ]) {
    const result = await fake.push({ content: 'x' }, { simulate })
    assert.deepEqual(result.skipped, [marker], `${simulate} must map to ${marker}`)
    assert.equal(result.ok, true)
    assert.equal(fake.calls.at(-1).options.simulate, simulate)
  }
})

test('testing fake: an unknown simulate value behaves like a normal success', async () => {
  const result = await createFakeNotifier().push({ content: 'x' }, { simulate: 'nonsense' })
  assert.deepEqual(result.delivered, ['fake'])
  assert.deepEqual(result.skipped, [])
})

test('testing fake: calls is copy-on-read (mutating the returned array or entries is inert)', async () => {
  const fake = createFakeNotifier()
  await fake.push({ title: 'T', content: 'C', group: 'g' }, { channel: 'telegram' })
  const first = fake.calls
  first.push({ message: {}, options: {}, at: 0 })
  first[0].message.title = 'mutated'
  first[0].options.channel = 'mutated'
  const second = fake.calls
  assert.equal(second.length, 1)
  assert.equal(second[0].message.title, 'T')
  assert.equal(second[0].options.channel, 'telegram')
  assert.notEqual(first, second, '每次读取都返回新数组')
  assert.notEqual(first[0], second[0], '每次读取都返回新的内层对象')
})

test('testing fake: calls is copy-on-write (later input mutation cannot rewrite the record)', async () => {
  const fake = createFakeNotifier()
  const message = { title: 'T', content: 'C' }
  const options = { sourceName: 'mine' }
  await fake.push(message, options)
  message.title = 'mutated'
  message.content = 'mutated'
  options.sourceName = 'mutated'
  const [entry] = fake.calls
  assert.equal(entry.message.title, 'T')
  assert.equal(entry.message.content, 'C')
  assert.equal(entry.options.sourceName, 'mine')
})

test('testing fake: flush resolves undefined and stays idempotent', async () => {
  const fake = createFakeNotifier()
  assert.equal(await fake.flush(), undefined)
  assert.equal(await fake.flush(), undefined)
})

test('testing fake: hostile Proxy/getter input never rejects', async () => {
  const throwing = new Proxy({}, {
    get() { throw new Error('getter bomb') },
    has() { throw new Error('has bomb') },
    ownKeys() { throw new Error('ownKeys bomb') },
  })
  const fake = createFakeNotifier()
  // 读取全部走防御 helper：抛错的 get 按缺失处理 → 双空 malformed，push 仍 resolve（never-reject）。
  const bombed = await fake.push(throwing, throwing)
  assert.equal(bombed.ok, true)
  assert.deepEqual(bombed.skipped, ['(malformed)'])
  assert.deepEqual(bombed.source, { kind: 'plugin', name: 'anonymous' })

  const hostileMessage = {}
  Object.defineProperty(hostileMessage, 'title', { get() { throw new Error('title bomb') }, enumerable: true })
  const guarded = await fake.push(hostileMessage, { sourceName: 'ok' })
  assert.deepEqual(guarded.skipped, ['(malformed)'], '抛错的 getter 按非字符串处理，不炸')
  assert.deepEqual(guarded.source, { kind: 'plugin', name: 'ok' })

  const hostileOptions = {}
  Object.defineProperty(hostileOptions, 'sourceName', { get() { throw new Error('source bomb') }, enumerable: true })
  const optionBomb = await fake.push({ content: 'x' }, hostileOptions)
  assert.deepEqual(optionBomb.delivered, ['fake'], 'options 读取抛错回落缺省 sourceName')
  assert.deepEqual(optionBomb.source, { kind: 'plugin', name: 'anonymous' })
})

test('testing fake: a throwing clock never rejects push', async () => {
  const fake = createFakeNotifier({ now: () => { throw new Error('clock bomb') } })
  const result = await fake.push({ content: 'x' })
  assert.deepEqual(result.delivered, ['fake'])
  assert.equal(fake.calls[0].at, undefined)
})

test('testing fake: sourceName normalization matches the public facade rules', async () => {
  const fake = createFakeNotifier({ sourceName: 42 })
  assert.equal((await fake.push({ content: 'x' })).source.name, 'anonymous', '非字符串缺省 = anonymous')
  assert.equal((await fake.push({ content: 'x' }, { sourceName: '   ' })).source.name, 'anonymous', '空串 = anonymous')
  assert.equal((await fake.push({ content: 'x' }, { sourceName: '  spaced  ' })).source.name, 'spaced')
  const long = 'a'.repeat(80)
  assert.equal((await fake.push({ content: 'x' }, { sourceName: long })).source.name.length, 64, '截断到 64 码点')
})