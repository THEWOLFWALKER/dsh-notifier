// v0.14（Stage B）持久化 / 事务正确性回归。
//
// 锁定 01-findings 的 P1-01 .. P1-07 修复边界：
//   B1 MembersControlService 透传底层 reason（storage-failed 绝不伪装 not-found）
//   B2 identity.migrate bindings + marker 单事务原子（失败两键都不变，重跑幂等，不覆盖 canonical）
//   B3 SessionRegistry commit -> publish memory（落盘失败内存/盘都不变，重启无幽灵）
//   B4 已授权 inbound 消息 durable dedup 失败 fail-closed（handler 计数 0）
//   B5 inbound config same-key sibling 合并（事务内基于 draft 最新值）
//   B6 outbound canonical same-key sibling 合并 + 失败提交不覆盖 concurrent winner
//   C/divergence required secret clear -> saved true / applied false / restartPending true
//
// 规则：同一业务事实只有一个 owner；storage-failed 绝不报成功；同 key 不丢兄弟字段。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createIdentity } from '../src/inbound/identity.mjs'
import { createMembersControlService } from '../src/control-plane/members.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'

/**
 * 事务型内存 store：
 *  - transact 在 detached draft 上运行 mutator，成功才提交（对齐 createStore 语义）；
 *  - set 走同一内存，可注入失败（模拟 durable=false）；transact 亦可注入失败。
 * get 返回价值拷贝，注册表内存态与盘上真相互不 alias。
 */
function txMemoryStore(initial = {}) {
  let memory = JSON.parse(JSON.stringify(initial))
  let fail = false
  return {
    get(key, fallback = undefined) {
      return key in memory ? JSON.parse(JSON.stringify(memory[key])) : fallback
    },
    keys(prefix = '') { return Object.keys(memory).filter((key) => key.startsWith(prefix)) },
    set(key, value) {
      if (fail) return false
      memory[key] = JSON.parse(JSON.stringify(value))
      return true
    },
    transact(mutator) {
      if (fail) return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot() { return JSON.parse(JSON.stringify(memory)) },
    setFail(value) { fail = value === true },
  }
}

/** durable 布尔 store：set 返回持久化是否真正到达盘（false 即写未到盘，盘保持原样）。 */
function durableStore(initial = {}) {
  const disk = JSON.parse(JSON.stringify(initial))
  let ok = () => true
  return {
    disk,
    get(key, fallback = undefined) { return key in disk ? JSON.parse(JSON.stringify(disk[key])) : fallback },
    keys(prefix = '') { return Object.keys(disk).filter((key) => key.startsWith(prefix)) },
    set(key, value) {
      if (!ok()) return false
      disk[key] = JSON.parse(JSON.stringify(value))
      return true
    },
    setWriteOk(fn) { ok = fn },
  }
}

// ——————————————————— B1 Members error taxonomy ———————————————————

test('B1 members: update storage-failed 不得改写成 not-found（透传底层 reason）', () => {
  const store = txMemoryStore()
  const identity = createIdentity({ store })
  assert.equal(identity.addBinding({ channel: 'telegram', userId: '1', label: 'A' }).ok, true)
  assert.equal(identity.addBinding({ channel: 'telegram', userId: '2', label: 'B' }).ok, true)
  const members = createMembersControlService({ identity })

  store.setFail(true)
  const updated = members.updateMember('telegram:1', { label: 'A2' })
  assert.equal(updated.ok, false)
  assert.equal(updated.reason, 'storage-failed') // 绝非 not-found
  const removed = members.removeMember('telegram:2')
  assert.equal(removed.ok, false)
  assert.equal(removed.reason, 'storage-failed')
  store.setFail(false)

  // 明确不存在才 not-found；末位 owner 降级/删除仍是 owner-last——三类错误不串码。
  assert.equal(members.updateMember('telegram:999', { label: 'x' }).reason, 'not-found')
  assert.equal(members.updateMember('telegram:1', { role: 'member' }).reason, 'owner-last')
  assert.equal(members.removeMember('telegram:1').reason, 'owner-last')
  // 失败写不留下任何内存/盘上痕迹：label 原值仍在。
  assert.equal(members.listMembers('telegram').find((m) => m.key === 'telegram:1').label, 'A')
})

// ——————————————————— B2 identity.migrate 单事务 ———————————————————

test('B2 migrate: 事务失败 -> bindings/marker 都不变', () => {
  const store = txMemoryStore()
  const identity = createIdentity({ store })
  store.setFail(true)
  assert.deepEqual(identity.migrate(['42'], ['telegram']), { added: 0, reason: 'storage-failed' })
  assert.deepEqual(store.snapshot(), {}) // 半提交被消除：两键都不落盘
})

test('B2 migrate: 成功一次提交两键 + 重跑幂等 + 不覆盖更新的 canonical', () => {
  const store = txMemoryStore()
  const identity = createIdentity({ store })
  const first = identity.migrate(['42'], ['telegram'])
  assert.equal(first.added, 1)
  const snap = store.snapshot()
  assert.ok(snap['inbound:bindings']['telegram:42'])
  assert.equal(snap['inbound:migrated'], true) // 同一次事务一起落盘

  assert.deepEqual(identity.migrate(['42'], ['telegram']), { added: 0, skipped: true })

  const store2 = txMemoryStore({
    'inbound:bindings': {
      'telegram:42': { channel: 'telegram', userId: '42', label: '自定义', role: 'owner', pairedAt: 1, lastSeenAt: 0, origin: 'paired' },
    },
  })
  const identity2 = createIdentity({ store: store2 })
  const r = identity2.migrate(['42', '43'], ['telegram'])
  assert.equal(r.added, 1) // 只补 43
  const table = store2.snapshot()['inbound:bindings']
  assert.equal(table['telegram:42'].label, '自定义') // 更新的 canonical 不被 legacy 覆盖
  assert.equal(table['telegram:43'].origin, 'migrated')
})

// ——————————————————— B3 SessionRegistry commit -> publish ———————————————————

test('B3 session-registry: 落盘失败 -> 内存与盘都不变，caller 得到失败；重启无幽灵', () => {
  const store = durableStore({
    'route:sessions': { s1: { workspace: 'w', control: { mode: 'team', owner: 'u1' } } },
  })
  const registry = createSessionRegistry({ store, now: () => 1000 })
  assert.equal(registry.getControl('s1').mode, 'team')

  store.setWriteOk(() => false)
  assert.equal(registry.setControl('s1', { mode: 'personal' }), undefined) // caller 得到失败
  assert.equal(registry.getControl('s1').mode, 'team') // 内存未 publish 新值
  assert.equal(store.disk['route:sessions'].s1.control.mode, 'team') // 盘未变

  // 重启（新实例读同一 disk）：无未持久化的幽灵新值。
  const reborn = createSessionRegistry({ store, now: () => 1001 })
  assert.equal(reborn.getControl('s1').mode, 'team')

  store.setWriteOk(() => true)
  assert.equal(registry.setControl('s1', { mode: 'personal' }).control.mode, 'personal')
  assert.equal(store.disk['route:sessions'].s1.control.mode, 'personal')
  registry.dispose()
  reborn.dispose()
})

// ——————————————————— B4 inbound bus fail-closed ———————————————————

test('B4 bus: 已授权消息 durable dedup 失败 -> handler 计数 0（fail-closed）；成功恰好一次；重启不重放', () => {
  const store = txMemoryStore()
  const bus = createInboundBus({ allowUsers: ['u1'], store })
  let hits = 0
  bus.onMessage(() => { hits += 1; return true })

  const envelope = { channel: 'telegram', userId: 'u1', messageId: 'm1', text: 'hi' }
  store.setFail(true)
  assert.deepEqual(bus.accept(envelope), { ok: false, reason: 'storage-failed' })
  assert.equal(hits, 0) // 去重未落盘 -> 绝不释放业务副作用
  store.setFail(false)

  assert.deepEqual(bus.accept(envelope), { ok: true })
  assert.equal(hits, 1) // exactly once
  bus.dispose()

  // 重启：新 bus 共享同一 store，provider 重投同 messageId 不得重复进入业务链。
  const reborn = createInboundBus({ allowUsers: ['u1'], store })
  let hits2 = 0
  reborn.onMessage(() => { hits2 += 1; return true })
  assert.equal(reborn.accept(envelope).reason, 'duplicate')
  assert.equal(hits2, 0)
  reborn.dispose()
})

// ——————————————————— B5 inbound config same-key sibling ———————————————————

test('B5 inbound config: 同 key 不同字段并发 patch -> 兄弟字段都保留（事务内基于 draft 合并）', () => {
  const store = txMemoryStore()
  const port = createInboundChannelConfigPort({ store })
  // 模拟并发：提交瞬间盘上已由别的 writer 写入 appSecret——事务内以 draft 最新值合并则两者并存。
  const origTransact = store.transact.bind(store)
  store.transact = (mutator) => origTransact((draft) => {
    const current = draft['feishu:account'] ?? {}
    if (current.appSecret === undefined) draft['feishu:account'] = { ...current, appSecret: '并发写入的 secret' }
    return mutator(draft)
  })

  const res = port.put('feishu', { appId: 'cli_app' })
  assert.equal(res.saved, true)
  const row = store.snapshot()['feishu:account']
  assert.equal(row.appId, 'cli_app')                 // 本次 patch
  assert.equal(row.appSecret, '并发写入的 secret')    // 兄弟字段不被整对象覆盖
})

test('B5 inbound config: clear 与兄弟 patch 并存', () => {
  const store = txMemoryStore()
  const port = createInboundChannelConfigPort({ store })
  port.put('feishu', { appId: 'cli_app', appSecret: 'sec_1' })
  const res = port.put('feishu', { appId: null, appSecret: 'sec_2' })
  assert.equal(res.saved, true)
  const row = store.snapshot()['feishu:account']
  assert.equal(row.appId, undefined)   // clear 生效
  assert.equal(row.appSecret, 'sec_2') // 兄弟字段更新保留
})

test('B5 inbound config: 事务失败 -> 报告 saved:false，盘不变', () => {
  const store = txMemoryStore({ 'feishu:account': { appId: 'old' } })
  const port = createInboundChannelConfigPort({ store })
  store.setFail(true)
  const res = port.put('feishu', { appId: 'new' })
  assert.equal(res.saved, false)
  assert.equal(store.snapshot()['feishu:account'].appId, 'old')
})

// ——————————————————— B6 outbound canonical same-key sibling ———————————————————

function outboundRig(store) {
  const source = createOutboundSource([])
  const service = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  return { source, service }
}

test('B6 outbound: 同 key 不同字段并发 patch -> 兄弟字段都保留', () => {
  const store = txMemoryStore()
  const { service } = outboundRig(store)
  const origTransact = store.transact.bind(store)
  store.transact = (mutator) => origTransact((draft) => {
    const current = draft['channel:bark:outbound'] ?? {}
    if (current.device === undefined) draft['channel:bark:outbound'] = { ...current, device: '并发设备' }
    return mutator(draft)
  })
  const res = service.save('bark', { key: 'k1' })
  assert.equal(res.saved, true)
  const row = store.snapshot()['channel:bark:outbound']
  assert.equal(row.key, 'k1')
  assert.equal(row.device, '并发设备') // sibling 不丢
})

test('B6 outbound: failed commit 不覆盖 concurrent winner（desired durable 保持分层）', () => {
  const store = txMemoryStore({ 'channel:bark:outbound': { key: 'winner' } })
  const { service } = outboundRig(store)
  store.setFail(true)
  assert.throws(() => service.save('bark', { key: 'loser' }), (error) => error.code === 'storage-failed')
  assert.equal(store.snapshot()['channel:bark:outbound'].key, 'winner') // winner 未被回滚抹掉
})

test('B6 outbound: secret clear -> saved true / applied false / restartPending（divergence）', () => {
  const store = txMemoryStore()
  const { source, service } = outboundRig(store)
  assert.equal(service.save('bark', { key: 'k1' }).applied, true)
  assert.equal(source.has('bark'), true) // 旧 runtime 仍在跑
  const cleared = service.save('bark', { key: null })
  assert.equal(cleared.saved, true)          // desired 已落盘（删 key）
  assert.equal(cleared.applied, false)       // 运行时未收敛
  assert.equal(cleared.applyMode, 'restart-pending')
  const view = service.describe('bark')
  assert.equal(view.active, true)            // 旧 runtime 继续 active
  assert.equal(view.restartPending, true)
  assert.equal(view.diverged, true)          // diagnostics 明确 divergence
})