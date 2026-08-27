import test from 'node:test'
import assert from 'node:assert/strict'

import { createInboundChannelRegistry } from '../src/assembly/inbound-channels.mjs'
import { disposeAll } from '../src/assembly/lifecycle.mjs'
import { createTelegramTransport } from '../src/channels/telegram/index.mjs'

function fakeDeps(overrides = {}) {
  const warnings = []
  const started = []
  const stopped = []
  const make = (name, { startError = null } = {}) => () => {
    const instance = {
      start() {
        started.push(name)
        if (startError !== null) throw new Error(startError)
      },
      async stop() { stopped.push(name) },
    }
    return instance
  }
  const deps = {
    bus: {}, vault: {}, store: { get() { return undefined } },
    identity: { size() { return 0 } }, control: {},
    warn: (message) => warnings.push(message),
    factories: {
      telegram: make('telegram'),
      feishu: make('feishu'),
      qq: make('qq'),
      wxpusher: make('wxpusher'),
      wechat: make('wechat'),
      dingtalk: make('dingtalk'),
    },
    started,
    stopped,
    warnings,
    ...overrides,
  }
  return deps
}

test('runtime assembly modules import with stable callable contracts', () => {
  assert.equal(typeof createInboundChannelRegistry, 'function')
  assert.equal(typeof disposeAll, 'function')
})

test('inbound channel registry isolates optional failures and stops started transports', async () => {
  const deps = fakeDeps({
    feishuOk: true,
    feishuResolved: { config: { appId: 'a' } },
    qqOk: true,
    qqResolved: { config: { appId: 'q' } },
    wxOk: true,
    wxResolved: { config: { appToken: 'w' } },
    dingtalkOk: true,
    dingtalkResolved: { config: { appKey: 'd' } },
  })
  // Replace QQ with a factory that fails before it can be registered.
  deps.factories.qq = () => { throw new Error('qq factory down') }
  const registry = createInboundChannelRegistry(deps)

  assert.deepEqual(deps.started.sort(), ['dingtalk', 'feishu', 'wxpusher'])
  assert.deepEqual([...registry.replyTargets.keys()].sort(), ['dingtalk', 'feishu', 'wxpusher'])
  assert.ok(deps.warnings.some((message) => /inbound:qq 装配失败，已跳过/.test(message)))

  await registry.dispose()
  assert.deepEqual(deps.stopped.sort(), ['dingtalk', 'feishu', 'wxpusher'])
})

test('registry cleans a transport whose start throws before abandoning it', async () => {
  const deps = fakeDeps({
    factories: {
      ...fakeDeps().factories,
      telegram: fakeDeps({}).factories.telegram,
    },
    inboundBotToken: 'token',
  })
  let stopCount = 0
  deps.factories.telegram = () => ({
    start() { throw new Error('start failed') },
    stop() { stopCount += 1 },
  })
  const registry = createInboundChannelRegistry(deps)
  assert.deepEqual(registry.interactiveInstances, [])
  assert.equal(stopCount, 1)
  assert.ok(deps.warnings.some((message) => /inbound:telegram 装配失败，已跳过/.test(message)))
  await registry.dispose()
  assert.equal(stopCount, 1, '失败实例未进入 registry，不会被重复 stop')
})

test('telegram assembly preserves a custom accountId on message and callback envelopes', async () => {
  const accepted = []
  const decisions = []
  const updates = [
    {
      update_id: 1,
      message: { message_id: 5, text: '在吗', from: { id: 42 }, chat: { id: 42, type: 'private' } },
    },
    {
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: 42 },
        message: { chat: { id: 42 }, message_id: 6 },
        data: 'ap:allowed-once:ap:assembly:1:token',
      },
    },
  ]
  let updateIndex = 0
  const fetchImpl = async (url, init = {}) => {
    const method = String(url).split('/').pop()
    if (method === 'getUpdates') {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (updateIndex < updates.length) return { ok: true, status: 200, json: async () => ({ ok: true, result: [updates[updateIndex++]] }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }
  }
  const deps = fakeDeps({
    inboundBotToken: 'SECRET_TOKEN',
    tgRaw: { apiBase: 'https://api.telegram.test', accountId: 'acct_custom' },
    store: { get() { return undefined }, set() {} },
    control: null,
    bus: {
      accept: (envelope) => { accepted.push(envelope) },
      decide: (envelope) => { decisions.push(envelope); return { ok: true } },
    },
    factories: {
      ...fakeDeps().factories,
      telegram: (options) => createTelegramTransport({ ...options, fetchImpl, errorBackoffMs: 1 }),
    },
  })

  const registry = createInboundChannelRegistry(deps)
  await new Promise((resolve) => setTimeout(resolve, 30))
  await registry.dispose()

  assert.deepEqual(accepted, [{
    channel: 'telegram', accountId: 'acct_custom', userId: '42', chatId: '42', chatType: 'private', messageId: 'msg:5:42', text: '在吗',
  }])
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].accountId, 'acct_custom')
  assert.equal(decisions[0].approvalKey, 'ap:assembly:1')
  assert.equal(decisions[0].userId, 42)
  assert.equal(decisions[0].chatId, 42)
})

test('disposeAll settles async cleanup and continues after a throwing disposer', async () => {
  const calls = []
  await disposeAll([
    () => { calls.push('first'); throw new Error('ignored') },
    async () => { calls.push('second') },
    () => { calls.push('third') },
  ])
  assert.deepEqual(calls, ['first', 'second', 'third'])
})
