// v0.15（T08）desired / resolved / resources 分层与 apply 语义回归。
//
// 锁定任务书 T08 与验收矩阵 C01–C04：
//   C01  frozen resolved 经**真实装配**（composeOutboundChannels → OutboundSource →
//        RuntimeChannelManager → notifier）发送 QQ/wecom 成功；投影冻结、live 可变、payload 一致。
//   C02  commit 失败 → apply 零调用；apply 失败但旧 runtime 仍在跑 → 同时显示新 desired 与旧 active。
//   C03  旧 revision 的迟到 apply 不得覆盖已更新的 runtime 状态（runtime truth 单调栅栏）。
//   T08  分层可观察：raw()=desired、snapshot()=冻结 resolved 投影、live()=可变 runtime 资源。

import test from 'node:test'
import assert from 'node:assert/strict'

import { composeOutboundChannels } from '../src/assembly/outbound.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createNotifier } from '../src/notify.mjs'

import * as qqBot from '../src/adapters/qq-bot.mjs'
import * as wecomApp from '../src/adapters/wecom-app.mjs'

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
})

/** 在测试作用域内临时替换 global fetch（node --test 每文件独立进程）。 */
async function withFetch(stub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** 事务型内存 store（对齐 createStore 语义：mutator 在 detached draft 上跑，成功才提交）。 */
function memoryStore(initial = {}) {
  let memory = JSON.parse(JSON.stringify(initial))
  return {
    get: (key, fallback = undefined) => (key in memory ? JSON.parse(JSON.stringify(memory[key])) : fallback),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

/** transact 恒失败（模拟 write/rename/commit 失败）。 */
function brokenStore() {
  return {
    get: () => undefined,
    keys: () => [],
    transact: () => ({ ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }),
    snapshot: () => ({}),
  }
}

/** 真·RuntimeChannelManager 叠加可控传输副作用（默认透传内层 OutboundSource）。 */
function runtimeManager({ entries = [], replace = null, remove = null } = {}) {
  const inner = createOutboundSource(entries)
  const source = {
    snapshot: () => inner.snapshot(),
    liveEntries: () => inner.liveEntries(),
    live: (type) => inner.live(type),
    types: () => inner.types(),
    has: (type) => inner.has(type),
    get: (type) => inner.get(type),
    replace: replace ?? ((type, config) => inner.replace(type, config)),
    remove: remove ?? ((type) => inner.remove(type)),
    replaceAll: (list) => inner.replaceAll(list),
    subscribe: (listener) => inner.subscribe(listener),
    get version() { return inner.version },
  }
  return createRuntimeChannelManager({ source, initial: entries })
}

const serviceOver = (store, source, yamlRows = new Map()) => createOutboundConfigService({
  store, yamlRows, source, allowLegacy: false,
})

// ————————————————— C01：真实装配 → 发送 —————————————————

test('T08-C01 qq-bot：真实装配的 resolved 经 notifier 发送成功；投影冻结、live 可变、payload 一致', async () => {
  const store = memoryStore({
    'channel:qq-bot:outbound': { appId: '1', appSecret: 's', groupId: 'g1' },
  })
  const overlay = composeOutboundChannels({
    channels: [], yamlRows: new Map(), store, adminEnabled: false, warn() {}, allowLegacy: false,
  })
  const entry = overlay.channels.find((item) => item.type === 'qq-bot')
  assert.ok(entry, '真实装配必须产出 qq-bot 渠道')

  const manager = createRuntimeChannelManager({ source: createOutboundSource(overlay.channels), initial: overlay.channels })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes('getAppAccessToken')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ id: 'm1', timestamp: 1 })
  }, async () => {
    const result = await notifier.notify('qq-bot', { title: '', content: 'hi' })
    assert.equal(result.ok, true, '装配产出的 resolved 必须可发送——冻结回归会让它 TypeError')
  })

  // 分层：live 是可变的 adapter 私有运行时对象；投影是冻结快照。
  const live = manager.live('qq-bot').config
  assert.equal(Object.isFrozen(live), false, 'live resolved 不得被冻结')
  assert.doesNotThrow(() => { live._msgSeq = 7 })
  assert.throws(() => { manager.get('qq-bot').config.appId = 'x' }, TypeError, '外部投影冻结')

  // payload 一致：装配 resolved 的公开字段 == 同输入直接 resolve。
  const direct = qqBot.resolve({ appId: '1', appSecret: 's', groupId: 'g1' })
  assert.equal(live.appId, direct.appId)
  assert.equal(live.groupId, direct.groupId)
})

test('T08-C01 wecom-app：真实装配的 resolved 经 notifier 发送成功；token 缓存落在 live 对象', async () => {
  const store = memoryStore({
    'channel:wecom-app:outbound': { corpid: 'c', secret: 's', agentId: 1 },
  })
  const overlay = composeOutboundChannels({
    channels: [], yamlRows: new Map(), store, adminEnabled: false, warn() {}, allowLegacy: false,
  })
  const entry = overlay.channels.find((item) => item.type === 'wecom-app')
  assert.ok(entry, '真实装配必须产出 wecom-app 渠道')

  const manager = createRuntimeChannelManager({ source: createOutboundSource(overlay.channels), initial: overlay.channels })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes('gettoken')) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ errcode: 0, errmsg: 'ok' })
  }, async () => {
    const result = await notifier.notify('wecom-app', { title: '', content: 'hi' })
    assert.equal(result.ok, true)
  })

  const live = manager.live('wecom-app').config
  assert.equal(Object.isFrozen(live), false)
  assert.ok(live._tokenManager, 'token 管理器缓存在 live 对象上')
  const direct = wecomApp.resolve({ corpid: 'c', secret: 's', agentId: 1 })
  assert.equal(live.corpid, direct.corpid)
})

// ————————————————— C02：commit 失败零 apply —————————————————

test('T08-C02 commit 失败 → apply 零调用，desired 不变，绝不谎报 saved', () => {
  const store = brokenStore()
  const inner = createOutboundSource([])
  let replaceCalls = 0
  let removeCalls = 0
  const source = {
    snapshot: () => inner.snapshot(),
    liveEntries: () => inner.liveEntries(),
    live: (type) => inner.live(type),
    types: () => inner.types(),
    has: (type) => inner.has(type),
    get: (type) => inner.get(type),
    replace: (type, config) => { replaceCalls += 1; return inner.replace(type, config) },
    remove: (type) => { removeCalls += 1; return inner.remove(type) },
    get version() { return inner.version },
  }
  const service = serviceOver(store, source)

  assert.throws(() => service.save('bark', { key: 'k1' }), (error) => error.code === 'storage-failed')
  assert.equal(replaceCalls, 0, 'commit 失败必须零 apply')
  assert.equal(removeCalls, 0)
  assert.deepEqual(store.snapshot(), {}, 'commit 失败不得留下任何 desired')
  assert.equal(source.has('bark'), false, '运行时不得出现未落盘配置')
})

// ————————————————— C02：apply 失败 → 新 desired + 旧 active —————————————————

test('T08-C02 apply 失败但旧 runtime 仍在跑 → 新 desired + 旧 active（diverged）', () => {
  const store = memoryStore()
  const source = runtimeManager({
    entries: [{ type: 'bark', config: { key: 'k0' } }],
    replace: () => { throw new Error('runtime apply exploded') },
  })
  const service = serviceOver(store, source)

  const result = service.save('bark', { key: 'k1' })
  assert.equal(result.saved, true, 'desired 已落盘')
  assert.equal(result.applied, false)
  assert.equal(result.applyMode, 'restart-pending')

  const view = service.describe('bark')
  assert.equal(view.configured, true, '新 desired 成立')
  assert.equal(view.active, true, '旧 runtime 仍在服务 → active 保持 true')
  assert.equal(view.restartPending, true)
  assert.equal(view.diverged, true, '新 desired 与旧 active 并存 = divergence')
  assert.equal(store.snapshot()['channel:bark:outbound'].key, 'k1', '新 desired 可重启收敛')
})

test('T08-C02 apply 失败且无旧 runtime → failed（不虚构旧 active）', () => {
  const store = memoryStore()
  const source = runtimeManager({ replace: () => { throw new Error('apply exploded') } })
  const service = serviceOver(store, source)

  const result = service.save('bark', { key: 'k2' })
  assert.equal(result.saved, true)
  assert.equal(result.applied, false)
  assert.equal(result.runtimeState, 'failed')
  assert.equal(service.describe('bark').active, false)
  assert.equal(service.describe('bark').diverged, false)
})

// ————————————————— C03：runtime truth 单调栅栏 —————————————————

test('T08-C03 旧 revision 的迟到 apply 不得覆盖已更新的 runtime 状态（N 不覆盖 N+1）', () => {
  const source = createRuntimeChannelManager({ source: createOutboundSource([]) })
  source.setState('bark', 'online', { restartPending: false, revision: 2 })
  assert.equal(source.runtimeState('bark').state, 'online')

  // 更旧 revision（被 N+1 超越的 apply N）迟到落地 → 必须被丢弃。
  source.setState('bark', 'failed', { revision: 1 })
  assert.equal(source.runtimeState('bark').state, 'online', 'N 不得覆盖 N+1')
  assert.equal(source.runtimeState('bark').restartPending, false)

  // 更新的 revision 正常生效。
  source.setState('bark', 'degraded', { revision: 3 })
  assert.equal(source.runtimeState('bark').state, 'degraded')

  // revision 只服务栅栏，不泄漏进 runtimeState 形状。
  assert.deepEqual(Object.keys(source.runtimeState('bark')).sort(), ['restartPending', 'state'])
})

test('T08-C03 端到端：保存推进 revision，栅栏随之抬升', () => {
  const store = memoryStore()
  const source = runtimeManager()
  const service = serviceOver(store, source)

  service.save('bark', { key: 'k1' })
  const firstRevision = source.version
  assert.ok(firstRevision >= 1)
  service.save('bark', { key: 'k2' })
  assert.ok(source.version > firstRevision, '每次 apply 推进 source.version')

  // 用更旧 revision 覆盖当前状态 → 被拒。
  source.setState('bark', 'failed', { revision: firstRevision })
  assert.equal(source.runtimeState('bark').state, 'online')
})

// ————————————————— desired / resolved / resources 分层 —————————————————

test('T08 分层：raw()=desired、snapshot()=冻结 resolved 投影、live()=可变 runtime 资源', () => {
  const store = memoryStore()
  const source = runtimeManager()
  const service = serviceOver(store, source)
  service.save('bark', { key: 'k1', device: 'phone' })

  // desired：raw() 是深拷贝，外部改动不影响持久化真值。
  const desired = service.raw('bark')
  assert.equal(desired.key, 'k1')
  assert.equal(desired.device, 'phone')
  desired.key = 'mutated'
  assert.equal(service.raw('bark').key, 'k1')
  assert.equal(store.snapshot()['channel:bark:outbound'].key, 'k1')

  // resolved 投影：冻结且剔除 adapter 私有运行时资源。
  const liveCfg = source.live('bark').config
  liveCfg._tokenManager = { get: async () => 't' }
  const projected = source.get('bark').config
  assert.equal(Object.isFrozen(projected), true)
  assert.equal(Object.prototype.hasOwnProperty.call(projected, '_tokenManager'), false, '私有运行态不进投影')
  assert.equal(projected.device, 'phone', '公开配置字段仍在投影里')
  assert.ok(String(projected.endpoint).includes('k1'), 'desired 的 secret 字段经 resolve 折进 endpoint')
})