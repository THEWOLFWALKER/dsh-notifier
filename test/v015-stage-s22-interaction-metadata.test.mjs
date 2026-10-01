// v0.15 RC（Gate 2A）— Interaction metadata 窄 mutation 的验收契约。
//
// 命令包 02-CORE-MANUAL-IMPLEMENTATION.md §A：
//   - patchMetadata 只在 store.transact() 的 fresh draft 里读 row；
//   - patcher 只拿 metadata view（拿不到 lifecycle writer）；
//   - 白名单 srcChats / pushedTo / hintTargets / deliveryEvidence；
//   - status、decision/outcome、claim 字段、终态时间戳永远从 fresh row 保留；
//   - row missing -> not-found；storage fail -> storage-failed；
//   - 并发 oracle：A 读 metadata 意图 → B claim/settle 成功 → A 再提交，终态仍是 B 的终态。
// 确定性 fake：真实 createStore（临时文件），无网络、无计时等待。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-s22-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  return { store, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ————————————————————————— 基本合并 / 生命周期保留 —————————————————————————

test('Gate2A: patchMetadata merges whitelisted metadata onto the fresh row', () => {
  const { store, ledger, cleanup } = rig()
  try {
    assert.equal(ledger.add('ap:1', { kind: 'approval', createdAt: 1, pushedTo: [{ channel: 'telegram' }] }), true)
    const result = ledger.patchMetadata('ap:1', (meta) => ({
      pushedTo: [...meta.pushedTo, { channel: 'feishu', chatId: 'c1' }],
      hintTargets: [{ channel: 'feishu', chatId: 'c1' }],
    }))
    assert.deepEqual(result, { ok: true, changed: true })
    const row = store.get('ap:1')
    assert.equal(row.status, 'pending')
    assert.deepEqual(row.pushedTo, [{ channel: 'telegram' }, { channel: 'feishu', chatId: 'c1' }])
    assert.deepEqual(row.hintTargets, [{ channel: 'feishu', chatId: 'c1' }])
  } finally { cleanup() }
})

test('Gate2A: the patcher only sees the metadata view, never lifecycle fields', () => {
  const { ledger, cleanup } = rig()
  try {
    ledger.add('ap:2', { kind: 'approval', createdAt: 1, pushedTo: [], secretExtra: 'x' })
    let seen = null
    ledger.patchMetadata('ap:2', (meta) => { seen = meta; return { pushedTo: [] } })
    assert.deepEqual(Object.keys(seen).sort(), ['pushedTo'])
    assert.equal(Object.isFrozen(seen), true)
    assert.equal('status' in seen, false)
    assert.equal('decision' in seen, false)
    assert.equal('createdAt' in seen, false)
  } finally { cleanup() }
})

test('Gate2A: non-whitelisted patch keys are dropped (lifecycle can never be rewritten)', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:3', { kind: 'approval', createdAt: 1 })
    const result = ledger.patchMetadata('ap:3', () => ({ status: 'pending', decision: 'approved', pushedTo: [{ channel: 'x' }] }))
    assert.deepEqual(result, { ok: true, changed: true })
    const row = store.get('ap:3')
    assert.equal(row.status, 'pending')
    assert.equal(row.decision, undefined)
    assert.deepEqual(row.pushedTo, [{ channel: 'x' }])
  } finally { cleanup() }
})

test('Gate2A: a patch with no whitelisted field is a zero-change no-op', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:4', { kind: 'approval', createdAt: 1 })
    const result = ledger.patchMetadata('ap:4', () => ({ status: 'resolved' }))
    assert.deepEqual(result, { ok: true, changed: false })
    assert.equal(store.get('ap:4').status, 'pending')
  } finally { cleanup() }
})

test('Gate2A: null deletes a metadata key', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:5', { kind: 'approval', createdAt: 1, srcChats: { telegram: ['c1'] } })
    const result = ledger.patchMetadata('ap:5', () => ({ srcChats: null }))
    assert.deepEqual(result, { ok: true, changed: true })
    assert.equal('srcChats' in store.get('ap:5'), false)
  } finally { cleanup() }
})

// ————————————————————————— 并发 oracle —————————————————————————

test('Gate2A concurrency oracle: a metadata commit after B settled never rolls lifecycle back', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:6', { kind: 'approval', createdAt: 1, pushedTo: [] })
    // A 读到的 metadata intent（迟到送达证据）。
    const aMetadataIntent = { channel: 'telegram', chatId: 'late' }
    // B 抢先结算为终态。
    assert.equal(ledger.resolve('ap:6', 'approved', { by: 'b' }), true)
    // A 再提交——旧实现会用 stale row 整行覆写，把 status 回退成 pending。
    const result = ledger.patchMetadata('ap:6', (meta) => ({ pushedTo: [...(meta.pushedTo ?? []), aMetadataIntent] }))
    assert.deepEqual(result, { ok: true, changed: true })
    const row = store.get('ap:6')
    assert.equal(row.status, 'resolved', 'B 的终态必须保留')
    assert.equal(row.decision, 'approved', 'B 的裁决必须保留')
    assert.equal(row.by, 'b')
    assert.deepEqual(row.pushedTo, [aMetadataIntent], 'A 的 metadata 仍然并入')
  } finally { cleanup() }
})

test('Gate2A concurrency oracle: metadata patched before a claim survives the claim', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:7', { kind: 'approval', createdAt: 1 })
    ledger.patchMetadata('ap:7', () => ({ pushedTo: [{ channel: 'telegram' }] }))
    assert.equal(ledger.claim('ap:7', { via: 'telegram' }).claimed, true)
    const row = store.get('ap:7')
    assert.equal(row.status, 'claimed')
    assert.deepEqual(row.pushedTo, [{ channel: 'telegram' }])
  } finally { cleanup() }
})

// ————————————————————————— 边界 —————————————————————————

test('Gate2A: missing row -> not-found; requirePending rejects a settled row', () => {
  const { ledger, cleanup } = rig()
  try {
    assert.deepEqual(ledger.patchMetadata('ap:nope', () => ({ pushedTo: [] })), { ok: false, reason: 'not-found' })
    ledger.add('ap:8', { kind: 'approval', createdAt: 1 })
    ledger.resolve('ap:8', 'rejected')
    assert.deepEqual(
      ledger.patchMetadata('ap:8', () => ({ pushedTo: [] }), { requirePending: true }),
      { ok: false, reason: 'not-pending' },
    )
    // 无 requirePending 时元数据仍可并入终态行（送达证据补记）。
    assert.deepEqual(ledger.patchMetadata('ap:8', () => ({ pushedTo: [{ channel: 'x' }] })), { ok: true, changed: true })
  } finally { cleanup() }
})

test('Gate2A: a storage commit failure reports storage-failed and mutates nothing', () => {
  const failing = {
    transact: () => ({ ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }),
    get: () => ({ status: 'pending', pushedTo: [] }),
    set: () => false,
  }
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store: failing })
  assert.deepEqual(ledger.patchMetadata('ap:9', () => ({ pushedTo: [{ channel: 'x' }] })), { ok: false, reason: 'storage-failed' })
})

test('Gate2A: patcher throwing is contained (reported as storage-failed, nothing published)', () => {
  const { store, ledger, cleanup } = rig()
  try {
    ledger.add('ap:10', { kind: 'approval', createdAt: 1, pushedTo: [] })
    assert.deepEqual(ledger.patchMetadata('ap:10', () => { throw new Error('boom') }), { ok: false, reason: 'storage-failed' })
    assert.deepEqual(store.get('ap:10').pushedTo, [])
    assert.equal(store.get('ap:10').status, 'pending')
  } finally { cleanup() }
})