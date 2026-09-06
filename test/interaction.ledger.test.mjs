// dsh-notifier interaction/ledger 统一状态账本（Interaction Core）单元测试。
// 覆盖状态机四态语义（pending→resolved / only-pending→terminated / 缺失行守卫）、
// decisionField 参数化（actions 的 outcome 字段名）、extra 不可覆写终态字段、
// scanKeys 前缀过滤、store 可空构造的 no-op 语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'

/** 内存 store 夹具：行为对齐 src/inbound/store.mjs 的 get/set/keys(prefix)。 */
function memStore() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); return true },
    keys: (prefix = '') => [...map.keys()].filter((key) => key.startsWith(prefix)),
    _map: map,
  }
}

test('账本：add 总是覆写为 pending + createdAt', () => {
  const store = memStore()
  let t = 1000
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store, now: () => (t += 1) })
  ledger.add('aq:1', { question: 'x', options: ['甲', '乙'] })
  const row = store.get('aq:1')
  assert.equal(row.status, 'pending')
  assert.equal(row.createdAt, 1001)
  assert.equal(row.question, 'x') // 业务字段原样并入
  assert.equal(row.options.length, 2)
})

test('账本：resolve 有行即翻终态，决策字段名可参数化（actions 用 outcome）；缺失行 false', () => {
  const store = memStore()
  const ledger = createInteractionLedger({ keyPrefix: 'act:', store, decisionField: 'outcome' })
  assert.equal(ledger.resolve('act:none', 'done'), false, '缺失行不翻')
  ledger.add('act:k', { kind: 'x', payload: {} })
  assert.equal(ledger.resolve('act:k', 'done', { via: 'telegram' }), true)
  const row = store.get('act:k')
  assert.equal(row.status, 'resolved')
  assert.equal(row.outcome, 'done') // actions 字段名保持 outcome（state key 格式不破）
  assert.equal(row.via, 'telegram') // extra 并入
  assert.equal(typeof row.resolvedAt, 'number')
  assert.equal(row.decision, undefined, '不写 decision 字段')
  // S-14（W12）：已终态不可再翻转——二次 resolve 返回 'already-resolved'，终态裁决保持
  assert.equal(ledger.resolve('act:k', 'again'), 'already-resolved')
  assert.equal(store.get('act:k').outcome, 'done', '终态裁决不被二次 resolve 覆写')
})

test('账本：resolve 已终态不翻转（S-14 双 resolve 幂等）；claimedSettle 逃生门供 actions 终局落地', () => {
  const store = memStore()
  const ledger = createInteractionLedger({ keyPrefix: 'aq:', store })
  ledger.add('aq:1', { payload: 1 })
  ledger.resolve('aq:1', 'answered', { payload: 2 })
  // 已终态二次 resolve：返回 already-resolved，extra 不再并入、终态字段不被覆写
  assert.equal(ledger.resolve('aq:1', 'timeout', { status: 'pending', decision: 'evil', resolvedAt: 5, payload: 3 }), 'already-resolved')
  const row = store.get('aq:1')
  assert.equal(row.status, 'resolved')
  assert.equal(row.decision, 'answered', '终态裁决不被迟到 settle 覆写')
  assert.equal(row.payload, 2, '旁注字段也不被二次 resolve 追加')
  assert.equal(row.resolvedAt !== 5, true, 'resolvedAt 恒取决议时刻')
  // 逃生门（仅 actions 的 executing→终局落地用）：claimedSettle 放行已占位行落定终态
  assert.equal(ledger.resolve('aq:1', 'done', { via: 'x' }, { claimedSettle: true }), true)
  const settled = store.get('aq:1')
  assert.equal(settled.decision, 'done')
  assert.equal(settled.via, 'x')
  assert.equal(settled.status, 'resolved')
  // 逃生门同样不放开 status/decision/resolvedAt 覆写（resolvedRowOf 恒覆盖决议字段）
  ledger.resolve('aq:1', 'final', { status: 'pending', decision: 'evil', resolvedAt: 5 }, { claimedSettle: true })
  const final = store.get('aq:1')
  assert.equal(final.status, 'resolved')
  assert.equal(final.decision, 'final')
  assert.ok(final.resolvedAt !== 5, 'resolvedAt 仍由决议时刻覆盖')
})

test('账本：terminate 仅待决可翻，已决/缺失返回 false（C2/P1-5 僵尸守卫）', () => {
  const store = memStore()
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  assert.equal(ledger.terminate('ap:none'), false)
  ledger.add('ap:k', { pushedTo: [] })
  assert.equal(ledger.terminate('ap:k'), true)
  const row = store.get('ap:k')
  assert.equal(row.status, 'resolved')
  assert.equal(row.decision, 'terminated')
  assert.equal(ledger.terminate('ap:k'), false, '已决行不可二次终止')
  assert.equal(ledger.terminate('ap:k', { extra: 1 }), false, '终止失败不改写')
})

test('账本：scanKeys 按前缀过滤，isPending 只认 pending（含旧行/僵尸行 fail-closed）', () => {
  const store = memStore()
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  store.set('ap:a', { status: 'pending' })
  store.set('ap:b', { status: 'resolved', decision: 'timeout' })
  store.set('aq:x', { status: 'pending' })
  assert.deepEqual([...ledger.scanKeys()].sort(), ['ap:a', 'ap:b'])
  assert.equal(ledger.isPending(store.get('ap:a')), true)
  assert.equal(ledger.isPending(store.get('ap:b')), false)
  assert.equal(ledger.isPending({ status: 'pending' }), true, '旧行无 decision 字段也是 pending')
  assert.equal(ledger.isPending(null), false)
  assert.equal(ledger.isPending(undefined), false)
  assert.equal(ledger.isPending('x'), false)
})

test('账本：store 可空（actions 缺账本构造）——add/get/scanKeys no-op，resolve/terminate false', () => {
  const ledger = createInteractionLedger({ keyPrefix: 'act:' })
  ledger.add('act:k', {})
  assert.equal(ledger.get('act:k'), undefined)
  assert.deepEqual([...ledger.scanKeys()], [])
  assert.equal(ledger.resolve('act:k', 'done'), false)
  assert.equal(ledger.terminate('act:k'), false)
  assert.equal(ledger.isPending(undefined), false)
})