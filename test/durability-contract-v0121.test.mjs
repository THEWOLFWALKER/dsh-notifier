// v0.12.1 Phase A 回归测试：durable 持久化失败必须传播到调用方。
//
// 覆盖清单：P0-01（outbound save）、P0-02（outbound remove）、
//           P0-03（ledger add）、P0-04（ledger resolve / terminate）。
//
// ⚠️ 本文件在修复前【必须失败】——那些失败就是 bug 的复现证据（AGENT-RUNBOOK 第 2 步）。
// 修复前的实际表现：
//   - outbound save   返回 { saved: true, applied: true }，但写盘失败
//   - outbound remove 返回 { deleted: true }，但盘上配置还在（重启后"复活"）
//   - ledger resolve  返回 true，但盘上仍是 pending（重启后已裁决的审批复活）
//   - ledger add      无返回值，调用方收不到任何信号
//
// 同时覆盖不变量 I9 —— 遗留 mock store 的 set() 返回 undefined 必须当作【成功】，
// 不得被判成写失败（仓库大量既有测试依赖此语义）。
//
// 【本文件刻意只 import 修复前就已存在的导出】：这样在基线上它会以**断言失败**报错，
// 如实展示 bug 的行为，而不是以「模块加载失败」掩盖掉真正的问题。
// 需要新导出（setDurable / deleteDurable）的测试在 durable-primitives-v0121.test.mjs。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'

const CANONICAL_BARK = 'channel:bark:outbound'

/**
 * 落盘必然失败的 store：set 返回 false（**不抛** —— 这正是 bug 的成因：
 * 调用方按「会抛」写的 try/catch 永不触发）。deleteDurable 报 durable:false。
 * @param {object} options.initial 内存中的既有键（供 remove/resolve 的前置校验通过）
 */
function failingStore({ initial = {} } = {}) {
  const memory = new Map(Object.entries(initial))
  return {
    get: (key) => memory.get(key),
    set: (key, value) => { memory.set(key, value); return false },
    delete: (key) => memory.delete(key),                    // existed 语义（R1：不得改）
    deleteDurable: (key) => ({ existed: memory.delete(key), durable: false }),
    keys: (prefix = '') => [...memory.keys()].filter((key) => key.startsWith(prefix)),
    _memory: memory,
  }
}

/** 正常落盘的 store（用于验证 happy path 未被改坏）。 */
function workingStore({ initial = {} } = {}) {
  const memory = new Map(Object.entries(initial))
  return {
    get: (key) => memory.get(key),
    set: (key, value) => { memory.set(key, value); return true },
    delete: (key) => memory.delete(key),
    deleteDurable: (key) => ({ existed: memory.delete(key), durable: true }),
    keys: (prefix = '') => [...memory.keys()].filter((key) => key.startsWith(prefix)),
    _memory: memory,
  }
}

/** 遗留 mock store：set **无 return**（返回 undefined）→ 必须当成功（I9）。 */
function legacyMockStore({ initial = {} } = {}) {
  const memory = new Map(Object.entries(initial))
  return {
    get: (key) => memory.get(key),
    set: (key, value) => { memory.set(key, value) },
    delete: (key) => memory.delete(key),
    keys: (prefix = '') => [...memory.keys()].filter((key) => key.startsWith(prefix)),
    _memory: memory,
  }
}

function outboundRig(store, initialTypes = []) {
  const source = createOutboundSource(initialTypes)
  const config = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source,
    adminEnabled: false,
  })
  return { config, source }
}

const captureThrow = (fn) => {
  try {
    return { value: fn(), error: null }
  } catch (error) {
    return { value: null, error }
  }
}

// ─────────────────────────── P0-01：outbound save ───────────────────────────

test('P0-01：outbound save 落盘失败必须抛 storage-failed，且不得触碰 live source', () => {
  const { config, source } = outboundRig(failingStore())

  const { value, error } = captureThrow(() => config.save('bark', { key: 'k1' }))

  assert.ok(error !== null, '落盘失败必须报错 —— 绝不能返回 saved:true 让用户以为保存成功')
  assert.equal(error.code, 'storage-failed')
  assert.equal(source.has('bark'), false, '持久化失败不得替换运行时 source（否则"视图热、重启丢"）')
})

test('P0-01：outbound save 成功后仍正常热替换（happy path 未被改坏）', () => {
  const store = workingStore()
  const { config, source } = outboundRig(store)

  const result = config.save('bark', { key: 'k1' })

  assert.equal(result.saved, true)
  assert.equal(result.applied, true)
  assert.equal(result.applyMode, 'hot')
  assert.equal(source.has('bark'), true, '成功后必须热替换')
  assert.ok(store._memory.has(CANONICAL_BARK), '成功后 canonical 已落内存')
})

test('P0-01：落盘失败后内存必须回滚，不留「内存新值 / 运行时旧值」的分裂', () => {
  // 前置：已有一份成功保存过的旧配置
  const store = failingStore({ initial: { [CANONICAL_BARK]: { key: 'old' } } })
  const { config, source } = outboundRig(store, [{ type: 'bark', config: { key: 'old' } }])

  captureThrow(() => config.save('bark', { key: 'new' }))

  // 不允许出现「重读 store 看到 new、运行时仍是 old、重启后又变回 old」的三方分裂
  const persisted = store.get(CANONICAL_BARK)
  assert.deepEqual(persisted, { key: 'old' }, '落盘失败必须把内存回滚到旧值')
  assert.equal(source.get('bark').config.key, 'old', '运行时保持旧值')
})

// ────────────────────────── P0-02：outbound remove ──────────────────────────

test('P0-02：outbound remove 落盘失败必须抛 storage-failed，且不得改动 source', () => {
  const store = failingStore({ initial: { [CANONICAL_BARK]: { key: 'k1' } } })
  const { config, source } = outboundRig(store, [{ type: 'bark', config: { key: 'k1' } }])

  const { value, error } = captureThrow(() => config.remove('bark'))

  assert.ok(error !== null, '删除未落盘必须报错 —— 否则重启后配置"复活"，用户以为已撤销')
  assert.equal(error.code, 'storage-failed')
  assert.equal(source.has('bark'), true, '删除失败不得移除运行时 source')
})

test('P0-02：outbound remove 成功后仍正常移除（happy path 未被改坏）', () => {
  const store = workingStore({ initial: { [CANONICAL_BARK]: { key: 'k1' } } })
  const { config, source } = outboundRig(store, [{ type: 'bark', config: { key: 'k1' } }])

  const result = config.remove('bark')

  assert.equal(result.deleted, true)
  assert.equal(source.has('bark'), false)
  assert.equal(store._memory.has(CANONICAL_BARK), false)
})

// ──────────────────── P0-03 / P0-04：interaction ledger ────────────────────

test('P0-03：ledger add 落盘失败必须返回 false，不得无返回值静默成功', () => {
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store: failingStore() })

  assert.equal(ledger.add('aq:1', { question: 'x' }), false, '写失败必须可传播给调用方')
})

test('P0-03：ledger add 成功后返回 true（happy path）', () => {
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store: workingStore() })

  assert.equal(ledger.add('aq:1', { question: 'x' }), true)
})

test('P0-04：ledger resolve 落盘失败必须返回 storage-failed，绝不返回 true', () => {
  const store = failingStore({ initial: { 'aq:1': { status: 'pending', question: 'x' } } })
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })

  assert.equal(
    ledger.resolve('aq:1', 'answered'),
    'storage-failed',
    '内存已 resolved 但盘上仍 pending —— 必须与成功区分，否则重启后审批复活',
  )
})

test('P0-04：ledger terminate 落盘失败必须返回 storage-failed', () => {
  const store = failingStore({ initial: { 'ap:1': { status: 'pending' } } })
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })

  assert.equal(ledger.terminate('ap:1'), 'storage-failed')
})

test('P0-04：ledger 既有返回语义未被破坏（缺失行 false / 已决 already-resolved / 成功 true）', () => {
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store: workingStore() })

  assert.equal(ledger.resolve('aq:none', 'done'), false, '缺失行仍返回 false')
  assert.equal(ledger.add('aq:1', {}), true)
  assert.equal(ledger.resolve('aq:1', 'answered'), true, '成功仍返回 true')
  assert.equal(ledger.resolve('aq:1', 'again'), 'already-resolved', '已决仍返回 already-resolved')
})

// ───────────────────────── 不变量守卫（I9） ─────────────────────────

test('I9：遗留 mock store 的 set() 返回 undefined 必须当作成功，不得判成写失败', () => {
  const store = legacyMockStore({ initial: { 'aq:1': { status: 'pending' } } })
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })

  assert.equal(ledger.add('aq:2', {}), true, 'mock store 下 add 必须报成功，否则打挂既有测试')
  assert.equal(ledger.resolve('aq:1', 'answered'), true, 'mock store 下 resolve 必须报成功')

  const { config, source } = outboundRig(store)
  assert.equal(config.save('bark', { key: 'k1' }).saved, true, 'mock store 下 save 必须报成功')
  assert.equal(source.has('bark'), true)
})