// v0.14（Stage C）runtime truth 回归：configured / active / applied / restartPending 分层收口。
//
// 锁定 01-findings 的 P1-07：runtime truth 只有一个 owner（RuntimeChannelManager 拥有
// live lifecycle + restartPending），OutboundConfigService 只提交 desired 并驱动 manager，
// 两套状态机绝不竞争。逐场景覆盖任务书 Stage C 的五条：
//   1. valid save + hot apply success
//   2. desired save success + runtime apply fail
//   3. explicit secret clear -> desired invalid + old runtime remains（divergence）
//   4. remove desired success + runtime remove fail
//   5. restart convergence
// 并把 divergence 统一投影到 Native 行 / Diagnostics（不再只有 inbound 能表达 restartPending）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { summarizeChannels, buildDiagnosticsSnapshot } from '../src/control-surface/diagnostics.mjs'
import { createSurfaceHealth, healthState } from '../src/control-surface/health.mjs'

const CANONICAL_BARK = 'channel:bark:outbound'

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

/**
 * 真·RuntimeChannelManager 叠加可控的传输副作用：默认透传内层 OutboundSource，
 * 可用 overrides.replace / overrides.remove 注入「运行时 apply 失败」。
 * manager 仍是唯一的 runtime truth owner（setState/runtimeState/replace 全走它）。
 */
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

const serviceOver = (store, source) => createOutboundConfigService({
  store, yamlRows: new Map(), source, allowLegacy: false,
})

test('C1 valid save + hot apply success：saved/applied/hot，manager 无 restartPending', () => {
  const store = memoryStore()
  const source = runtimeManager()
  const service = serviceOver(store, source)

  const result = service.save('bark', { key: 'k1' })
  assert.equal(result.saved, true)
  assert.equal(result.applied, true)
  assert.equal(result.applyMode, 'hot')
  assert.deepEqual(source.runtimeState('bark'), { state: 'online', restartPending: false })

  const view = service.describe('bark')
  assert.equal(view.configured, true)   // desired 落盘
  assert.equal(view.active, true)       // runtime 生效
  assert.equal(view.restartPending, false)
  assert.equal(view.diverged, false)
})

test('C2 desired save success + runtime apply fail：saved 真、applied 假，runtimeState=failed', () => {
  const store = memoryStore()
  const source = runtimeManager({ replace: () => { throw new Error('runtime apply exploded') } })
  const service = serviceOver(store, source)

  const result = service.save('bark', { key: 'k2' })
  assert.equal(result.saved, true, 'desired 已落盘，绝不因运行时失败谎报存储失败')
  assert.equal(result.applied, false)
  assert.equal(result.applyMode, 'restart-pending')
  assert.equal(result.runtimeState, 'failed')

  const view = service.describe('bark')
  assert.equal(view.configured, true)
  assert.equal(view.active, false)
  assert.equal(view.restartPending, true)
  assert.equal(view.diverged, false)     // 没有旧 runtime 在跑，只是未起
  assert.equal(view.runtime.state, 'failed')
  assert.equal(store.snapshot()[CANONICAL_BARK].key, 'k2', 'desired 保持可重启收敛')
})

test('C3 explicit secret clear -> desired invalid + old runtime remains（divergence）', () => {
  const store = memoryStore()
  const source = runtimeManager()
  const service = serviceOver(store, source)
  assert.equal(service.save('bark', { key: 'k1' }).applied, true)
  assert.equal(source.has('bark'), true)

  const cleared = service.save('bark', { key: null })
  assert.equal(cleared.saved, true, 'desired 已落盘（清掉 key）')
  assert.equal(cleared.applied, false, '运行时未收敛不得说成已生效')
  assert.equal(cleared.applyMode, 'restart-pending')

  const view = service.describe('bark')
  assert.equal(view.valid, false, '清掉必需字段后 desired 不可 resolve')
  assert.equal(view.active, true, '旧 runtime 仍在跑 → active 保持 true')
  assert.equal(view.restartPending, true)
  assert.equal(view.diverged, true, 'divergence：旧 runtime 在跑但未收敛到 desired')
  assert.deepEqual(source.runtimeState('bark'), {
    state: 'online', restartPending: true, error: source.runtimeState('bark').error,
  })
})

test('C4 remove desired success + runtime remove fail：deleted=true/applied=false，不回滚 desired', () => {
  const store = memoryStore({ [CANONICAL_BARK]: { key: 'k1' } })
  const source = runtimeManager({
    entries: [{ type: 'bark', config: { key: 'k1' } }],
    remove: () => { throw new Error('runtime remove exploded') },
  })
  const service = serviceOver(store, source)

  const result = service.remove('bark')
  assert.equal(result.deleted, true, 'desired delete 已提交')
  assert.equal(result.applied, false)
  assert.equal(result.applyMode, 'restart-pending')
  assert.equal(result.runtimeState, 'failed')
  assert.equal(CANONICAL_BARK in store.snapshot(), false, '运行时失败绝不回滚 desired（否则重启复活）')
  assert.equal(service.describe('bark').runtime.state, 'failed')
})

test('C5 restart convergence：重启后 desired 重新收敛，restartPending 归零', () => {
  const store = memoryStore()
  const failing = runtimeManager({ replace: () => { throw new Error('apply exploded') } })
  const before = serviceOver(store, failing)
  before.save('bark', { key: 'k2' })
  assert.equal(before.describe('bark').restartPending, true)

  // 「重启」：从落盘 desired 重建 runtime（runtime truth 重新装配，restartPending 归零）。
  const desired = store.snapshot()[CANONICAL_BARK]
  const restarted = runtimeManager({ entries: [{ type: 'bark', config: desired }] })
  const after = serviceOver(store, restarted)

  assert.deepEqual(restarted.runtimeState('bark'), { state: 'online', restartPending: false })
  const view = after.describe('bark')
  assert.equal(view.configured, true)
  assert.equal(view.active, true)
  assert.equal(view.restartPending, false)
  assert.equal(view.diverged, false)
})

test('C6 divergence 统一投影：Native 行 + Diagnostics 都表达 restartPending/diverged', () => {
  const store = memoryStore()
  const source = runtimeManager()
  const service = serviceOver(store, source)
  service.save('bark', { key: 'k1', device: 'phone' })
  service.save('bark', { key: null }) // 清必需字段 → divergence（仍有 device，desired 仍 configured）

  const projection = createChannelProjection({
    outboundConfig: service,
    outboundSource: source,
    inboundConfig: { version: 1 },
    adminApi: { getChannels: () => [] },
    health: createSurfaceHealth(),
  })
  const row = projection.get('bark')
  assert.equal(row.notify.configured, true)
  assert.equal(row.notify.active, true)
  assert.equal(row.notify.restartPending, true, 'notify 行必须与 control 行同构表达 restartPending')
  assert.equal(row.notify.diverged, true)
  assert.equal(row.health.state, 'restart-pending', '健康度显式区分等待重启，而非谎报健康/degraded')

  const summary = summarizeChannels([row])
  assert.deepEqual(summary.restartPending, ['bark'])
  assert.deepEqual(summary.diverged, ['bark'])

  const snapshot = buildDiagnosticsSnapshot({
    version: '0.13.1',
    revision: { current: () => ({ epoch: 'e1', revision: 1 }) },
    storage: { readFailed: false },
    channels: { list: () => [row] },
  })
  assert.ok(
    snapshot.attention.reasons.some((reason) => reason.code === 'restart-pending'),
    'Diagnostics 必须明确 divergence（restart-pending reason）',
  )
  assert.deepEqual(snapshot.channels.diverged, ['bark'])
})

test('C7 healthState：restartPending 只在已配置且仍 active 时表达为 restart-pending', () => {
  assert.equal(healthState({ configured: true, active: true, health: null, restartPending: true }), 'restart-pending')
  assert.equal(healthState({ configured: true, active: true, health: null }), 'ready')
  // 未配置 / 未 active 时 restartPending 不得越权改写为 restart-pending。
  assert.equal(healthState({ configured: true, active: false, health: null, restartPending: true }), 'degraded')
  assert.equal(healthState({ configured: false, active: false, health: null, restartPending: true }), 'unconfigured')
})