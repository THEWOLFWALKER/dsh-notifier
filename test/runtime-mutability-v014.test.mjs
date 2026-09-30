// v0.14（P0-01）运行时可变性契约：区分 adapter 私有 runtime object 与冻结投影。
//
// 背景（issue #45/#46）：旧 outbound source 对 resolved adapter config 做 JSON clone +
// deep-freeze 后交给所有人，而 qq-bot/wecom-app/desktop 会在 resolved 上**合法惰性写**
// 运行时缓存（token 管理器 / 限速门 / msg_seq / BurntToast 探测），冻结对象在严格模式下
// 直接 TypeError，发送失败。
//
// 本套用例把边界钉死：
//   1) 真实 adapter resolved shape 的 live 运行时对象可惰性缓存，且缓存跨调用保活；
//   2) 传输路径（notifier → adapter.send）拿到的必须是 live 对象——用真实 adapter.send
//      + 注入 fetch 端到端证明；负向对照证明冻结会真的让发送失败；
//   3) snapshot()/get() 是冻结投影：外部改动抛错且不污染内部真值，也不携带私有运行时字段。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createNotifier } from '../src/notify.mjs'

import * as qqBot from '../src/adapters/qq-bot.mjs'
import * as wecomApp from '../src/adapters/wecom-app.mjs'
import * as desktop from '../src/adapters/desktop.mjs'

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
})

/** 在测试作用域内临时替换 global fetch（node --test 每文件独立进程，恢复后不影响他人）。 */
async function withFetch(stub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const liveConfigOf = (source, type) => source.live(type).config

// ————————————— 1. 真实 adapter resolved shape 的惰性缓存 —————————————

test('P0-01 qq-bot：live runtime object 允许合法惰性缓存且跨调用保活', () => {
  const resolved = qqBot.resolve({ appId: '1', appSecret: 's', groupId: 'g1' })
  const source = createOutboundSource([{ type: 'qq-bot', config: resolved }])

  const config = liveConfigOf(source, 'qq-bot')
  assert.equal(Object.isFrozen(config), false, 'live 对象不得被冻结')
  assert.equal(Object.isExtensible(config), true, 'live 对象必须可扩展（adapter 惰性写）')

  // 模拟 adapter 的惰性写（??= 与直接赋值），绝不能抛。
  assert.doesNotThrow(() => { config._tokenManager = { get: async () => 't' } })
  assert.doesNotThrow(() => { config._rateGate = { gate: async () => {} } })
  assert.doesNotThrow(() => { config._msgSeq = 3 })

  // 引用稳定：下一次取 live 仍是同一对象，缓存保活。
  assert.equal(liveConfigOf(source, 'qq-bot'), config)
  assert.equal(source.liveEntries()[0].config._msgSeq, 3)
})

test('P0-01 wecom-app：live runtime object 允许合法惰性缓存且跨调用保活', () => {
  const resolved = wecomApp.resolve({ corpid: 'c', secret: 's', agentId: 1 })
  const source = createOutboundSource([{ type: 'wecom-app', config: resolved }])

  const config = liveConfigOf(source, 'wecom-app')
  assert.equal(Object.isFrozen(config), false)
  assert.doesNotThrow(() => { config._tokenManager = { get: async () => 't' } })
  assert.equal(liveConfigOf(source, 'wecom-app'), config)
  assert.ok(liveConfigOf(source, 'wecom-app')._tokenManager)
})

test('P0-01 desktop：live runtime object 允许合法惰性缓存（BurntToast 探测）', () => {
  const resolved = desktop.resolve({ sound: 'always' })
  const source = createOutboundSource([{ type: 'desktop', config: resolved }])

  const config = liveConfigOf(source, 'desktop')
  assert.equal(Object.isFrozen(config), false)
  // desktop.send 在 win32 上会写 resolved.__burntToastProbe（Promise）；此处直接验证契约。
  assert.doesNotThrow(() => { config.__burntToastProbe = Promise.resolve(true) })
  assert.equal(liveConfigOf(source, 'desktop'), config)
  assert.ok(config.__burntToastProbe)
})

// ————————————— 2. 端到端：传输路径拿 live 对象（含负向对照）—————————————

test('P0-01 端到端 qq-bot：notifier 走 live 配置，发送成功后 token/seq 缓存落在同一对象', async () => {
  const resolved = qqBot.resolve({ appId: '1', appSecret: 's', groupId: 'g1' })
  const source = createOutboundSource([{ type: 'qq-bot', config: resolved }])
  const manager = createRuntimeChannelManager({ source })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ id: 'm1', timestamp: 1 })
  }, async () => {
    const result = await notifier.notify('qq-bot', { title: '', content: 'hi' })
    assert.equal(result.ok, true, 'qq-bot 发送必须成功——冻结回归会让它 TypeError 失败')
  })

  const config = liveConfigOf(source, 'qq-bot')
  assert.ok(config._tokenManager, 'token 管理器缓存在 live 对象上')
  assert.ok(config._rateGate, '限速门缓存在 live 对象上')
  assert.equal(config._msgSeq, 1, 'msg_seq 推进写回 live 对象')
})

test('P0-01 端到端 wecom-app：notifier 走 live 配置，token 管理器缓存保活', async () => {
  const resolved = wecomApp.resolve({ corpid: 'c', secret: 's', agentId: 1 })
  const source = createOutboundSource([{ type: 'wecom-app', config: resolved }])
  const manager = createRuntimeChannelManager({ source })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes('gettoken')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ errcode: 0, errmsg: 'ok' })
  }, async () => {
    const result = await notifier.notify('wecom-app', { title: '', content: 'hi' })
    assert.equal(result.ok, true)
  })

  assert.ok(liveConfigOf(source, 'wecom-app')._tokenManager)
})

test('P0-01 负向对照：冻结的 live 配置会让发送失败（证明用例能抓住回归）', async () => {
  const resolved = qqBot.resolve({ appId: '1', appSecret: 's', groupId: 'g1' })
  Object.freeze(resolved) // 重新引入旧 bug 的效果
  const source = createOutboundSource([{ type: 'qq-bot', config: resolved }])
  const manager = createRuntimeChannelManager({ source })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ id: 'm1', timestamp: 1 })
  }, async () => {
    const result = await notifier.notify('qq-bot', { title: '', content: 'hi' })
    assert.equal(result.ok, false, '冻结对象上惰性写抛 TypeError → 发送失败')
  })
})

// ————————————— 3. snapshot()/get() 冻结投影与 mutation isolation —————————————

test('P0-01 snapshot()/get() 是冻结投影：外部改动抛错且不污染内部真值', () => {
  const internal = { headers: { Authorization: 'secret' }, timeoutMs: 7000 }
  const source = createOutboundSource([{ type: 'webhook', config: internal }])

  const snap = source.snapshot()
  assert.equal(snap.length, 1)
  assert.throws(() => { snap[0].config.headers.Authorization = 'changed' }, TypeError)
  assert.throws(() => { snap[0].config.timeoutMs = 1 }, TypeError)

  const got = source.get('webhook')
  assert.throws(() => { got.config.headers.Authorization = 'changed' }, TypeError)

  // 内部真值毫发无损，且投影与 live 无引用共享。
  assert.equal(liveConfigOf(source, 'webhook').headers.Authorization, 'secret')
  assert.equal(liveConfigOf(source, 'webhook').timeoutMs, 7000)
  assert.notEqual(source.get('webhook').config, liveConfigOf(source, 'webhook'))
  assert.notEqual(source.snapshot()[0].config, liveConfigOf(source, 'webhook'))
})

test('P0-01 投影剔除 adapter 私有运行时字段（不泄漏 token 管理器等运行态）', () => {
  const resolved = qqBot.resolve({ appId: '1', appSecret: 's', groupId: 'g1' })
  const source = createOutboundSource([{ type: 'qq-bot', config: resolved }])
  const config = liveConfigOf(source, 'qq-bot')
  config._tokenManager = { get: async () => 'secret-token' }
  config._msgSeq = 5

  const projected = source.get('qq-bot').config
  assert.equal(Object.prototype.hasOwnProperty.call(projected, '_tokenManager'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(projected, '_msgSeq'), false)
  assert.equal(projected.appId, '1', '公开配置字段仍在投影里')

  const snapEntry = source.snapshot()[0].config
  assert.equal(Object.prototype.hasOwnProperty.call(snapEntry, '_tokenManager'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(snapEntry, '_msgSeq'), false)
})

test('P0-01 replace() 之后 live 与投影仍分层', () => {
  const source = createOutboundSource([])
  source.replace('bark', { key: 'k1' })
  const live = liveConfigOf(source, 'bark')
  assert.doesNotThrow(() => { live._cache = 'runtime' })
  assert.equal(source.live('bark').config._cache, 'runtime')
  assert.equal(source.get('bark').config._cache, undefined, '投影不带私有运行态')
  assert.equal(source.get('bark').config.key, 'k1')
})