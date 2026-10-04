// v0.15 S1（T04 / T05）：窄事务 abort 语义 + 成员权威的锁内 last-owner 守卫。
//
// 锁定 02-BOUNDARIES 的 K01/K02/K03/K04/K05：
//   - K01 abort 零 write、零 publish；
//   - K02 同键兄弟字段不丢；
//   - K03 last-owner 判断与写入同锁（不再由 service 锁外预检独自保证）；
//   - K04/K05 业务拒绝、锁忙、IO 失败彼此可分，storage-failed 绝不改写成 not-found。
//
// 关键回归：旧实现把「末位 owner 不可删/不可降级」放在 MembersControlService 的锁外
// `ownerCount()` 预检里——两个并发请求各自看到「还有 2 个 owner」，双双通过，owner 清零。
// 修复后该守卫落在 identity 的**同一个 fresh 事务**内判定。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, transactOutcome } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createMembersControlService } from '../src/control-plane/members.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-s1-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/**
 * 最小 mock store：读自内存表，`transact` 会**真实跑 mutator**（以便锁内业务 abort 生效——
 * 与真 store 一致：守卫先于变更判定，abort 零写盘），但提交结果恒为传入的失败值。
 * 用于钉死「业务拒绝（owner-last）与 IO 失败（storage-failed）互不改写」，不碰真盘。
 */
const mockStore = (initial, txResult) => ({
  get: (key, fallback) => (key in initial ? initial[key] : fallback),
  transact: (mutator) => {
    mutator({ ...initial })
    return txResult
  },
})

// ————————————————————— T04：窄事务 abort / 失败分类 —————————————————————

test('T04: 业务 abort 零写盘零发布，且与提交成功可区分（K01/K05）', () => {
  const { file } = tempState()
  const store = createStore(file)
  assert.equal(store.set('keep', { v: 1 }), true)
  const before = readFileSync(file, 'utf8')

  const aborted = transactOutcome(store, (draft, control) => {
    draft.shouldNotLand = true
    return control.abort('business-no')
  })
  assert.equal(aborted.committed, false, '业务拒绝不是提交')
  assert.equal(aborted.aborted, true, '业务拒绝显式标记 aborted')
  assert.equal(aborted.code, 'BUSINESS_ABORT')
  assert.equal(aborted.reason, 'business-no', 'reason 原样带出')
  assert.equal(aborted.ok, false)
  assert.equal(readFileSync(file, 'utf8'), before, 'abort 不得写盘')
  assert.equal(store.get('shouldNotLand'), undefined, 'abort 不得发布内存')

  const committed = transactOutcome(store, (draft) => { draft.landed = 1; return true })
  assert.equal(committed.committed, true)
  assert.equal(committed.aborted, false)
  assert.equal(committed.code, 'COMMITTED')
  assert.equal(store.get('landed'), 1)
})

test('T04: 锁忙是 IO 失败而非业务拒绝（aborted=false / code 可分）', () => {
  const { file } = tempState()
  const store = createStore(file)
  assert.equal(store.set('stable', 1), true)
  writeFileSync(`${file}.lock`, `${process.pid}:live-test-holder`)
  try {
    const busy = transactOutcome(store, (draft) => { draft.late = true; return true })
    assert.equal(busy.committed, false)
    assert.equal(busy.aborted, false, '锁忙不是业务拒绝')
    assert.equal(busy.code, 'STATE_BUSY')
  } finally {
    unlinkSync(`${file}.lock`)
  }
})

test('T04: 无事务能力的 store 显式报 TRANSACTION_UNAVAILABLE（不伪造原子成功）', () => {
  const legacy = { get: () => ({}), set: () => true }
  const result = transactOutcome(legacy, (draft) => draft)
  assert.equal(result.committed, false)
  assert.equal(result.aborted, false)
  assert.equal(result.code, 'TRANSACTION_UNAVAILABLE')
})

// ————————————————————— T05：成员权威的锁内守卫 —————————————————————

test('T05: 末位 owner 守卫在锁内——跨实例并发删除/降级不清零（K03）', () => {
  const { file } = tempState()
  const storeA = createStore(file)
  const idA = createIdentity({ store: storeA })
  assert.equal(idA.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'owner_1' }).ok, true) // 首条即 owner
  assert.equal(idA.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'owner_2' }).ok, true)
  assert.equal(idA.updateBinding('feishu', 'owner_2', { role: 'owner' }, 'feishu-app').ok, true)
  assert.equal(idA.ownerCount(), 2)

  // 第二个 identity 持有**陈旧**快照；守卫必须读锁内 fresh state，而非启动时的视图。
  const storeB = createStore(file)
  const idB = createIdentity({ store: storeB })

  assert.equal(idA.removeBinding('feishu', 'owner_1', 'feishu-app').ok, true, '还剩一个 owner，可删')
  const second = idB.removeBinding('feishu', 'owner_2', 'feishu-app')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'owner-last', '末位 owner 删除必须被锁内拒绝')

  const downgrade = idB.updateBinding('feishu', 'owner_2', { role: 'member' }, 'feishu-app')
  assert.equal(downgrade.ok, false)
  assert.equal(downgrade.reason, 'owner-last', '末位 owner 降级必须被锁内拒绝')
  assert.equal(idA.ownerCount(), 1, 'owner 未被清零')
})

test('T05: 同键兄弟字段在事务内保留——改 label 不丢 role/pairedAt（K02）', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  const added = identity.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'u1', label: 'before' })
  assert.equal(added.ok, true)

  const updated = identity.updateBinding('feishu', 'u1', { label: 'after' }, 'feishu-app')
  assert.equal(updated.ok, true)
  assert.equal(updated.record.label, 'after')
  assert.equal(updated.record.role, 'owner', '改 label 不得丢 role')
  assert.equal(updated.record.pairedAt, added.record.pairedAt, '其它字段原样保留')
  // 读回一致（真落盘，不只是返回值）
  assert.equal(identity.list().find((record) => record.userId === 'u1').label, 'after')
})

test('T05: storage-failed 与 owner-last 互不改写——IO 失败不伪装 not-found/owner-last（K04/K05）', () => {
  // 两个 owner 之外的普通成员：service 预检放行，真正失败发生在锁内 IO 层。
  const table = {
    'feishu:feishu-app:o1': { channel: 'feishu', accountId: 'feishu-app', userId: 'o1', label: '', role: 'owner', origin: 'paired', pairedAt: 1, lastSeenAt: 0 },
    'feishu:feishu-app:m1': { channel: 'feishu', accountId: 'feishu-app', userId: 'm1', label: '', role: 'member', origin: 'paired', pairedAt: 1, lastSeenAt: 0 },
  }
  const failing = mockStore(
    { 'inbound:bindings': table },
    { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' },
  )
  const identity = createIdentity({ store: failing })
  const service = createMembersControlService({ identity })

  const removed = service.removeMember('feishu:feishu-app:m1')
  assert.equal(removed.ok, false)
  assert.equal(removed.reason, 'storage-failed', 'IO 失败必须原样上抛 storage-failed')

  const updated = service.updateMember('feishu:feishu-app:m1', { label: 'x' })
  assert.equal(updated.ok, false)
  assert.equal(updated.reason, 'storage-failed')

  // 末位 owner 仍是业务拒绝（与 IO 失败不同），且在锁内判定。
  assert.equal(service.removeMember('feishu:feishu-app:o1').reason, 'owner-last')
})

test('T05: pending 转正的业务拒绝零写盘、不误报 storage-failed（K01/K05）', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  assert.equal(store.set('sentinel', { keep: true }), true)
  const before = readFileSync(file, 'utf8')

  const miss = identity.confirmPending('feishu', 'ghost', 'feishu-app')
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'not-found', '不存在的 pending 是业务拒绝，不是 storage-failed')
  assert.equal(readFileSync(file, 'utf8'), before, '业务拒绝不得触发全量写盘')

  // 真落盘后仍能正常转正（回归）。
  assert.equal(identity.addPending({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_x' }).ok, true)
  const promoted = identity.confirmPending('feishu', 'ou_x', 'feishu-app')
  assert.equal(promoted.ok, true)
  assert.equal(store.get('inbound:bindings')['feishu:feishu-app:ou_x'].origin, 'confirmed')
})

// ————————————————————— T06：identity 剩余写入收口 —————————————————————

test('T06: addPending 已绑定是业务拒绝（abort 零写盘），不误报 storage-failed', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  assert.equal(identity.addBinding({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_x' }).ok, true)
  const before = readFileSync(file, 'utf8')

  const rejected = identity.addPending({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_x' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'already-bound', '业务拒绝必须与 storage-failed 区分')
  assert.equal(readFileSync(file, 'utf8'), before, '业务拒绝不得触发整表写盘')

  const ok = identity.addPending({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_y' })
  assert.equal(ok.ok, true)
})

test('T06: dismissPending 保留同表其它条目，缺失项为业务拒绝（K02/K05）', () => {
  const { file } = tempState()
  const store = createStore(file)
  const identity = createIdentity({ store })
  assert.equal(identity.addPending({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_a' }).ok, true)
  assert.equal(identity.addPending({ channel: 'feishu', accountId: 'feishu-app', userId: 'ou_b' }).ok, true)

  assert.equal(identity.dismissPending('feishu', 'ou_a', 'feishu-app').ok, true)
  const left = store.get('inbound:pending', {})
  assert.equal(left['feishu:feishu-app:ou_a'], undefined, '被忽略项已移除')
  assert.ok(left['feishu:feishu-app:ou_b'], '同表其它条目保留')

  const miss = identity.dismissPending('feishu', 'ghost', 'feishu-app')
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'not-found', '不存在的待确认是业务拒绝')
})