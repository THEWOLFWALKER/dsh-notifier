// v0.15（T09）简单 HTTP sender 试点回归。
//
// 锁定任务书 T09 与 C01（simpleHTTP 分支）：
//   1. 契约：stateless sender 只有 validate/send，**没有**任何资源生命周期动词；
//   2. 证据映射：成功无回执 → accepted；显式回执 → confirmed（delivery-evidence 权威）；
//   3. 旧 payload golden 一致：sender 不改 endpoint/payload/headers（协议实现仍在 adapter）；
//   4. 2xx / 4xx / timeout / SSRF 语义与旧 adapter 相同；
//   5. frozen resolved 可直接发送（immutable validated config 语义）；
//   6. 真实装配：notifier 对已登记简单 HTTP 渠道走 sender 契约；未登记渠道原状。

import test from 'node:test'
import assert from 'node:assert/strict'

import * as bark from '../src/adapters/bark.mjs'
import * as webhook from '../src/adapters/webhook.mjs'
import * as telegram from '../src/adapters/telegram.mjs'
import { SENDERS, senderOf, senderTypes } from '../src/adapters/senders.mjs'
import { SENDER_LIFECYCLE, defineStatelessSender, bridgeStatelessAdapter } from '../src/adapters/sender.mjs'
import { NotifyError, ERROR_CODES } from '../src/adapters/_shared.mjs'
import { composeOutboundChannels } from '../src/assembly/outbound.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createNotifier } from '../src/notify.mjs'

const MSG = { title: '标题', content: '正文 markdown **bold**', level: 'active', group: 'g1' }

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
})

/** 捕获一次 send 的 url/body/headers（可指定成功响应体）。 */
function capture(json) {
  const original = globalThis.fetch
  const seen = { value: null }
  globalThis.fetch = async (url, init) => {
    seen.value = { url: String(url), body: init.body, headers: init.headers }
    return jsonResponse(json ?? {})
  }
  return {
    async done() {
      const value = seen.value
      globalThis.fetch = original
      return value
    },
  }
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { return await fn() } finally { globalThis.fetch = original }
}

// ————————————————— 1. 契约形状 —————————————————

test('T09 契约：stateless sender 只含 validate/send，无 createRuntime/start/stop/candidate/dispose', () => {
  const sender = senderOf('bark')
  assert.equal(sender.lifecycle, SENDER_LIFECYCLE.STATELESS)
  assert.equal(typeof sender.validate, 'function')
  assert.equal(typeof sender.send, 'function')
  assert.deepEqual(Object.keys(sender).sort(), ['lifecycle', 'send', 'type', 'validate'],
    'stateless sender 不得伪造任何资源生命周期动词')
  for (const verb of ['createRuntime', 'start', 'stop', 'candidate', 'dispose']) {
    assert.equal(verb in sender, false, `stateless sender 不得有 ${verb}`)
  }
})

test('T09 契约：defineStatelessSender 拒绝缺动作的定义；bridge 保留 adapter.type', () => {
  assert.throws(() => defineStatelessSender({ type: 'x', send: () => {} }), /validate/)
  assert.throws(() => defineStatelessSender({ type: 'x', validate: () => {} }), /send/)
  assert.throws(() => defineStatelessSender({ type: '', validate: () => {}, send: () => {} }), /type/)
  assert.equal(bridgeStatelessAdapter(bark).type, 'bark')
})

// ————————————————— 2. 证据映射 —————————————————

test('T09 证据：成功但无回执 → accepted 且 confirmed=false', async () => {
  const cap = capture({ code: 200 })
  const evidence = await senderOf('bark').send(bark.resolve({ key: 'K1' }), MSG)
  await cap.done()
  assert.deepEqual(evidence, { accepted: true, confirmed: false })
})

test('T09 证据：adapter 返回显式回执 → confirmed=true（bridge 收敛二级证据）', async () => {
  const withReceipt = { type: 'mock', resolve: (c) => c, send: async () => ({ receipt: true }) }
  const noReceipt = { type: 'mock2', resolve: (c) => c, send: async () => undefined }
  assert.equal((await bridgeStatelessAdapter(withReceipt).send({}, MSG)).confirmed, true)
  assert.equal((await bridgeStatelessAdapter(noReceipt).send({}, MSG)).confirmed, false)
})

// ————————————————— 3. 旧 payload golden 一致 —————————————————

test('T09 bark：sender 发送的 url/body 与旧 adapter golden 逐字段一致', async () => {
  const resolved = bark.resolve({ key: 'K1', device: 'iPhone15' })
  const cap = capture({ code: 200 })
  await senderOf('bark').send(resolved, MSG)
  const viaSender = await cap.done()

  const cap2 = capture({ code: 200 })
  await bark.send(bark.resolve({ key: 'K1', device: 'iPhone15' }), MSG)
  const viaAdapter = await cap2.done()

  assert.equal(viaSender.url, viaAdapter.url)
  assert.deepEqual(JSON.parse(viaSender.body), JSON.parse(viaAdapter.body))
  assert.equal(viaSender.url, 'https://api.day.app/K1')
  const body = JSON.parse(viaSender.body)
  assert.equal(body.title, '标题')
  assert.equal(body.body, '正文 markdown **bold**')
  assert.equal(body.device, 'iPhone15')
})

test('T09 webhook：sender 发送的 url/body/headers golden 一致', async () => {
  const resolveCfg = { url: 'http://127.0.0.1:9/hook', headers: { 'x-token': 'abc' }, allowPrivateNetwork: true }
  const cap = capture()
  await senderOf('webhook').send(webhook.resolve(resolveCfg), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'http://127.0.0.1:9/hook')
  assert.equal(seen.headers['x-token'], 'abc')
  const body = JSON.parse(seen.body)
  assert.equal(body.title, '标题')
  assert.equal(body.content, '正文 markdown **bold**')
  assert.equal(typeof body.timestamp, 'string')
})

// ————————————————— 4. 2xx / 4xx / timeout / SSRF —————————————————

test('T09 4xx：bark 业务码非 200 → API_ERROR（中文指引，不泄露 endpoint）', async () => {
  const cap = capture({ code: 400, message: 'bad request' })
  await assert.rejects(
    senderOf('bark').send(bark.resolve({ key: 'K1' }), MSG),
    (e) => e instanceof NotifyError && e.code === ERROR_CODES.API_ERROR
      && /400/.test(e.publicMessage) && !e.publicMessage.includes('K1'),
  )
  await cap.done()
})

test('T09 4xx：webhook HTTP 4xx → HTTP_ERROR', async () => {
  await withFetch(async () => ({
    ok: false, status: 403, headers: { get: () => null }, body: null,
    text: async () => 'forbidden',
  }), async () => {
    await assert.rejects(
      senderOf('webhook').send(webhook.resolve({ url: 'https://example.com/hook' }), MSG),
      (e) => e instanceof NotifyError && e.code === ERROR_CODES.HTTP_ERROR,
    )
  })
})

test('T09 timeout：请求超时 → TIMEOUT 且 noRetry（结果未知，不盲目重试）', async () => {
  const resolved = bark.resolve({ key: 'K1', timeoutMs: 1000 })
  await withFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  }), async () => {
    await assert.rejects(
      senderOf('bark').send(resolved, MSG),
      (e) => e instanceof NotifyError && e.code === ERROR_CODES.TIMEOUT && e.noRetry === true,
    )
  })
})

test('T09 SSRF：webhook 私网目标默认拒绝（UNSAFE_TARGET）；显式放行可发', async () => {
  const blocked = webhook.resolve({ url: 'http://127.0.0.1:9/hook' })
  await assert.rejects(
    senderOf('webhook').send(blocked, MSG),
    (e) => e instanceof NotifyError && e.code === ERROR_CODES.UNSAFE_TARGET && /allowPrivateNetwork: true/.test(e.publicMessage),
  )

  const cap = capture()
  const allowed = webhook.resolve({ url: 'http://127.0.0.1:9/hook', allowPrivateNetwork: true })
  await senderOf('webhook').send(allowed, MSG)
  await cap.done()
})

// ————————————————— 5. frozen resolved 可发送 —————————————————

test('T09 frozen：冻结后的 resolved 仍可发送（immutable validated config 语义）', async () => {
  const frozen = Object.freeze({ ...bark.resolve({ key: 'K1' }) })
  assert.equal(Object.isFrozen(frozen), true)
  const cap = capture({ code: 200 })
  const evidence = await senderOf('bark').send(frozen, MSG)
  const seen = await cap.done()
  assert.equal(evidence.accepted, true)
  assert.equal(seen.url, 'https://api.day.app/K1')
})

// ————————————————— 6. 真实装配 + 回退边界 —————————————————

test('T09 真实装配：notifier 对已登记简单 HTTP 渠道走 sender 契约发送成功', async () => {
  const store = {
    get: (key, fallback = undefined) => (key === 'channel:bark:outbound'
      ? { key: 'K9', device: 'phone' }
      : fallback),
    keys: () => [],
    transact: () => ({ ok: true, committed: true, durable: true }),
  }
  const overlay = composeOutboundChannels({
    channels: [], yamlRows: new Map(), store, adminEnabled: false, warn() {}, allowLegacy: false,
  })
  assert.ok(overlay.channels.some((entry) => entry.type === 'bark'), '装配必须产出 bark 渠道')

  const manager = createRuntimeChannelManager({ source: createOutboundSource(overlay.channels), initial: overlay.channels })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  const cap = capture({ code: 200 })
  const result = await notifier.notify('bark', { title: 't', content: 'c' })
  const seen = await cap.done()
  assert.equal(result.ok, true)
  assert.equal(seen.url, 'https://api.day.app/K9')
  assert.equal(JSON.parse(seen.body).device, 'phone')
})

test('T09 回退边界：未登记渠道不走 sender（senderOf 返回 null），注册表仅收敛试点渠道', () => {
  assert.equal(senderOf('telegram'), null)
  // T10 起 qq-bot/wecom-app 以 stateful sender 接入（此处只断言登记事实，契约形状见 s4 套件）。
  assert.equal(senderOf('qq-bot')?.lifecycle, 'stateful')
  assert.equal(senderOf('wecom-app')?.lifecycle, 'stateful')
  assert.deepEqual(senderTypes().sort(), ['bark', 'qq-bot', 'webhook', 'wecom-app'])
  assert.deepEqual(Object.keys(SENDERS).sort(), ['bark', 'qq-bot', 'webhook', 'wecom-app'])
  assert.equal(senderOf('bark').type, bark.type)
  assert.equal(senderOf('webhook').type, webhook.type)
})

test('T09 回退边界：未登记渠道的 notifier 发送行为不变（telegram 旧路径）', async () => {
  const channels = [{ type: 'telegram', config: telegram.resolve({ botToken: '123:ABC', chatId: '-100' }) }]
  const notifier = createNotifier({ logger: { warn() {} } }, channels, { segment: { enabled: false } })
  const cap = capture({ ok: true, result: { message_id: 1 } })
  const result = await notifier.notify('telegram', { title: 't', content: 'c' })
  const seen = await cap.done()
  assert.equal(result.ok, true)
  assert.equal(seen.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
})