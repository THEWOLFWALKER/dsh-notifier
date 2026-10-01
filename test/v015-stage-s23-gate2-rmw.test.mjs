// v0.15（Gate 2）Core correctness：RMW / epoch / safe projection 的并发与冻结边界回归。
//
// 锁定 02-CORE-MANUAL-IMPLEMENTATION.md 的 C/D/E 三节：
//   C. epoch evidence：发送开始捕获 runtime 世代；旧世代迟到观察不进当前健康；
//   D. Identity / Pairing / Routing：普通 patch/delete 全部 transaction 内 fresh read；
//   E. Outbound snapshot：JSON 序列化失败时绝不 freeze live runtime object。
//
// 并发 oracle：`makeStaleReadStore` 让 `get()` 返回**过期快照**、`transact()` 读**提交瞬间
// 的真值**——正是「锁外读旧表 → 整表写回」丢兄弟键的真实并发交错。旧的「锁外读 +
// setDurable 整表覆写」实现必然吃掉 `externalCommit` 的兄弟键；新的事务内 fresh read 必须保住。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createNotifier } from '../src/notify.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing, hashPairingCode } from '../src/inbound/pairing.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import * as bark from '../src/adapters/bark.mjs'

const quiet = { warn: () => {}, info: () => {} }

/**
 * 并发 oracle store：`get()` 只看**发布过的旧快照**，`transact()` 读**当前真值**。
 * `externalCommit` 模拟另一个写者（CLI / 管理台 / 宿主）已提交的并发变更——它只更新真值、
 * 不刷新 `get()` 快照，于是「锁外读 → 整表写回」的旧代码会把它的兄弟键吃掉。
 */
function makeStaleReadStore(initial = {}) {
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  let current = clone(initial)
  let published = clone(initial)
  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(published, key) ? clone(published[key]) : fallback
    },
    set(key, value) {
      current[key] = clone(value)
      published[key] = clone(value)
      return true
    },
    transact(mutator) {
      const draft = clone(current)
      const value = mutator(draft)
      current = draft
      return { ok: true, committed: true, durable: true, value }
    },
    /** 另一个写者直接提交（只动真值，不刷新 get() 快照）。 */
    externalCommit(key, value) { current[key] = clone(value) },
    /** 观察真值（断言用）。 */
    snapshot() { return clone(current) },
  }
}

// ————————————————————————— C. Epoch evidence —————————————————————————

test('Gate 2C：旧 epoch 的迟到观察不进当前健康，未携带 epoch 的 legacy record 仍兼容', () => {
  const health = createSurfaceHealth()
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [] }) // epoch 0
  assert.equal(health.snapshot('bark').accepted, 1)
  health.markEpoch('bark') // 换实例 → epoch 1，旧观察作废
  assert.equal(health.snapshot('bark').accepted, 0)

  // 旧实例的迟到观察（捕获于 epoch 0）→ 丢弃，不污染新实例健康（但调用结果/账本本身保留）。
  health.recordSend({ accepted: ['bark'], confirmed: ['bark'], skipped: [], failed: [], channelEpochs: { bark: 0 } })
  assert.equal(health.snapshot('bark').accepted, 0, '旧世代 accepted 不得计入新实例健康')
  assert.equal(health.snapshot('bark').delivered, 0)

  // 当前实例（epoch 1）的观察 → 计入。
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [], channelEpochs: { bark: 1 } })
  assert.equal(health.snapshot('bark').accepted, 1)

  // legacy record（无 channelEpochs）→ 维持兼容，计入。
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [] })
  assert.equal(health.snapshot('bark').accepted, 2)
})

test('Gate 2C：runtime 换实例推高 epoch；capture() 返回不可变世代与 live entry', () => {
  const source = createOutboundSource([{ type: 'bark', config: bark.resolve({ key: 'K1' }) }])
  const manager = createRuntimeChannelManager({ source })
  assert.equal(manager.epochOf('bark'), 0)
  const first = manager.capture('bark')
  assert.equal(first.epoch, 0)
  assert.equal(first.entry.type, 'bark')
  manager.setState('bark', 'online')
  assert.equal(manager.epochOf('bark'), 1)
  assert.equal(manager.capture('bark').epoch, 1)
  assert.equal(first.epoch, 0, '已捕获的世代是不可变值，不随后续更新漂移')
})

test('Gate 2C：notify 在发送开始捕获 epoch（不在结束时查询当前）', async () => {
  let calls = 0
  const source = {
    snapshot: () => [{ type: 'bark', config: { key: 'K1' } }],
    liveEntries: () => [{ type: 'bark', config: { key: 'K1' } }],
    epochOf: () => { calls += 1; return calls },
  }
  const records = []
  const notifier = createNotifier(quiet, source, { segment: { enabled: false }, onSend: (record) => records.push(record) })
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(Object.assign(new Error('network down'), { name: 'TypeError' }))
  try {
    await notifier.notify('bark', { title: 't', content: 'c' })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 1, 'epoch 只在发送开始捕获一次（发送期间换代也只记开始时的那一代）')
  assert.deepEqual(records.at(-1).channelEpochs, { bark: 1 }, 'record 携带开始时的世代，而非结束时的当前世代')
})

// ————————————————— D. Identity / Routing / Pairing RMW —————————————————

test('Gate 2D identity：addBinding 事务内 fresh read——并发写者的兄弟绑定不被吞', () => {
  const store = makeStaleReadStore()
  const identity = createIdentity({ store, logger: quiet })
  identity.addBinding({ channel: 'telegram', userId: '1' })
  // 另一个写者并发提交 qq:9（真值更新，get() 快照仍是旧的）。
  store.externalCommit('inbound:bindings', {
    'telegram:1': { channel: 'telegram', userId: '1', label: '', role: 'owner', pairedAt: 0, lastSeenAt: 0, origin: 'paired' },
    'qq:9': { channel: 'qq', userId: '9', label: '', role: 'member', pairedAt: 0, lastSeenAt: 0, origin: 'paired' },
  })
  assert.equal(identity.addBinding({ channel: 'telegram', userId: '2' }).ok, true)
  const table = store.snapshot()['inbound:bindings']
  assert.ok(table['qq:9'], '并发提交的兄弟绑定必须存活（旧实现锁外读 + 整表覆写会吞掉它）')
  assert.ok(table['telegram:1'])
  assert.ok(table['telegram:2'])
})

test('Gate 2D routing：setAgentBinding 事务内 fresh map——并发兄弟键不被旧快照覆盖', () => {
  const store = makeStaleReadStore()
  const router = createAgentRouter({ store, agentsList: [] })
  router.setAgentBinding('agent-a', { channels: ['telegram'] })
  store.externalCommit('route:agents', {
    'agent-a': { channels: ['telegram'] },
    'agent-b': { channels: ['qq'], quiet: true },
  })
  assert.equal(router.setAgentBinding('agent-a', { quiet: true }), true)
  const agents = store.snapshot()['route:agents']
  assert.deepEqual(agents['agent-b'], { channels: ['qq'], quiet: true }, '并发写入的兄弟 agent 必须存活')
  assert.deepEqual(agents['agent-a'], { channels: ['telegram'], quiet: true }, '字段级合并：channels 保留')
})

test('Gate 2D pairing：mint 事务内 fresh 表——并发兄弟码不被旧快照吞掉', () => {
  const store = makeStaleReadStore()
  const pairing = createPairing({ store, logger: quiet })
  assert.equal(pairing.mint({ origin: 'admin', mintedBy: 'a' }).ok, true)
  const keepHash = hashPairingCode('KEEPME42')
  store.externalCommit('inbound:pairing', {
    [keepHash]: {
      id: keepHash.slice(0, 8), hash: keepHash, state: 'minted-active', origin: 'admin',
      mintedBy: '', mintedAt: 1, issuedAt: 1, expiresAt: Date.now() + 60_000,
      attempts: 0, label: '', redeemedAt: 0, redeemedBy: '',
    },
  })
  assert.equal(pairing.mint({ origin: 'admin', mintedBy: 'b' }).ok, true)
  const table = store.snapshot()['inbound:pairing']
  assert.ok(table[keepHash], '并发提交的兄弟码必须存活（旧实现锁外读 + 整表覆写会吞掉它）')
  assert.ok(Object.keys(table).length >= 2)
})

// ———————————————————— E. Outbound safe projection ————————————————————

test('Gate 2E outbound：JSON 不可序列化时安全投影——绝不 freeze live 运行时对象', () => {
  const live = { key: 'K1' }
  live.self = live                 // 环 → JSON.stringify 抛错，走安全结构投影兜底
  live._tokenManager = { hits: 0 } // adapter 私有运行时缓存
  const source = createOutboundSource([{ type: 'qq-bot', config: live }])

  const projection = source.get('qq-bot')
  assert.equal(Object.isFrozen(projection.config), true, '投影必须冻结')
  assert.equal('_tokenManager' in projection.config, false, '私有运行态绝不进投影')
  assert.equal('self' in projection.config, false, '环分支断链丢弃')
  assert.equal(projection.config.key, 'K1')

  assert.equal(Object.isFrozen(live), false, 'live 运行时对象绝不能被冻死（否则下次惰性缓存写入 TypeError）')
  source.live('qq-bot').config._tokenManager.hits = 1 // 合法惰性缓存写入
  assert.equal(live._tokenManager.hits, 1, 'live 对象身份保持，可跨调用累积缓存')
})

test('Gate 2E outbound：冻结投影与内部真值无引用共享', () => {
  const live = { key: 'K1', nested: { a: 1 } }
  const source = createOutboundSource([{ type: 'bark', config: live }])
  const snap = source.snapshot()
  assert.throws(() => { snap[0].config.key = 'hacked' }, TypeError)
  assert.equal(source.get('bark').config.key, 'K1')
  assert.equal(source.live('bark').config, live, '传输路径拿到的仍是同一 live 对象')
})