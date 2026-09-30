// v0.15（T14）：Session/Routing 收敛 —— route:sessions 单事务写者。
//
// 事实所有者是 store 的键级事务锁：session-registry（生命周期）与 agent-router（出站/控制覆盖）
// 都必须在**同一个 store.transact() draft 内**读取最新整表再合并，才能在并发下互不覆盖兄弟字段。
// 本套件用一个可注入「提交瞬间最新值 vs. 过期读取视图」的内存事务 store 来稳定复现 TOCTOU 窗口，
// 而不是依赖真实竞速；并覆盖无事务旧 store 的回退、事务未提交的失败语义。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

const KEY = 'route:sessions'
const clone = (value) => (value === undefined ? undefined : structuredClone(value))

/**
 * 内存事务 store（接口对齐 src/inbound/store.mjs）：
 *  - `transact(mutator)` 在内部 `state` 上取 detached draft，成功才提交；支持 `control.abort()`。
 *  - `get()` 可返回一个**过期视图** `staleView`（缺省即最新 state），用来模拟「读取发生在并发提交之前」。
 *  - `commitExternal()` 模拟另一个写者（router/admin/CLI）在注册表缓存之外经事务提交。
 */
function makeTxStore(initial = {}, { staleView = null, commitFail = false } = {}) {
  let state = clone(initial) ?? {}
  const readView = staleView === null ? () => state : () => staleView
  return {
    get(key, fallback = undefined) {
      const view = readView()
      return key in view ? clone(view[key]) : fallback
    },
    set(key, value) { state[key] = clone(value) },
    delete(key) { const had = key in state; delete state[key]; return had },
    keys(prefix = '') { return Object.keys(state).filter((key) => key.startsWith(prefix)) },
    transact(mutator) {
      const draft = clone(state)
      const control = { aborted: false, abort(reason) { this.aborted = true; this.reason = reason } }
      let result
      try { result = mutator(draft, control) } catch { return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' } }
      if (control.aborted) return { ok: false, committed: false, durable: false, aborted: true, code: 'BUSINESS_ABORT', reason: control.reason }
      if (commitFail) return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }
      state = draft
      return { ok: true, committed: true, durable: true, value: result }
    },
    /** 另一个写者以真实事务提交（注册表缓存不可见）。 */
    commitExternal(mutate) {
      const draft = clone(state)
      mutate(draft)
      state = draft
    },
    state: () => state,
  }
}

const agentOf = (id, cwd) => (cwd === undefined ? { id } : { id, header: { cwd } })

test('T14/K02：注册表生命周期写以事务内最新 draft 为基底，并发 outbound 兄弟字段不丢', () => {
  // 权威状态：S1 已被另一个写者写入出站覆盖；注册表构造时的读取视图是「并发写之前」的旧快照。
  const seed = { [KEY]: { S1: { inherit: 'w', workspace: 'w', createdAt: 1, lastActiveAt: 1, outbound: { channels: ['telegram'], quiet: true } } } }
  const store = makeTxStore(seed, { staleView: { [KEY]: {} } })
  const registry = createSessionRegistry({ store, now: () => 1_000 })

  // 注册表只拥有 S1 的生命周期字段（workspace/lastActiveAt）；outbound 是 router 的兄弟字段。
  registry.ensureSession(agentOf('S1', '/home/u/w'))

  const persisted = store.state()[KEY]
  assert.deepEqual(persisted.S1.outbound, { channels: ['telegram'], quiet: true }, '并发写入的 outbound 兄弟字段必须保留')
  assert.equal(persisted.S1.workspace, 'w')
  assert.equal(persisted.S1.lastActiveAt, 1_000, '注册表的活跃字段落到同一记录')
})

test('T14/K02：注册表与 router 同会话兄弟字段共存（lifecycle ↔ outbound/control）', () => {
  const store = makeTxStore()
  const registry = createSessionRegistry({ store, now: () => 2_000 })
  const router = createAgentRouter({ store })

  registry.ensureSession(agentOf('S1', '/srv/proj'))
  assert.equal(router.setSessionOutbound('S1', { channels: ['ntfy'], quiet: true }), true)
  assert.equal(router.setSessionControl('S1', { mode: 'team', approvalOwnerOnly: true }), true)
  registry.touch('S1') // touchWriteMs 缺省 5s，但 clock 从 2_000 起、lastWriteMs 也是 2_000 → 不真写；强制一次 ensure 落盘

  registry.ensureSession(agentOf('S1', '/srv/proj')) // 记忆态 lastActiveAt 刷新并落盘

  const row = store.state()[KEY].S1
  assert.deepEqual(row.outbound, { channels: ['ntfy'], quiet: true }, 'router 的出站覆盖不被生命周期写抹掉')
  assert.equal(row.control?.mode, 'team', 'router 的控制覆盖不被生命周期写抹掉')
  assert.equal(row.workspace, 'proj', '注册表工作区字段仍在')
})

test('T14/K02：注册表不覆盖并发写入的其他会话记录（跨会话无关行保留）', () => {
  const seed = { [KEY]: { S9: { inherit: 'other', workspace: 'other', createdAt: 1, lastActiveAt: 1, outbound: { quiet: true } } } }
  const store = makeTxStore(seed, { staleView: { [KEY]: {} } })
  const registry = createSessionRegistry({ store, now: () => 3_000 })

  registry.ensureSession(agentOf('S1', '/srv/one'))

  const table = store.state()[KEY]
  assert.deepEqual(table.S9.outbound, { quiet: true }, '无关会话（注册表缓存不可见）原样保留')
  assert.equal(table.S1.workspace, 'one', '本次生命周期会话已落盘')
})

test('T14：事务未提交（committed=false）→ 生命周期写如实失败，不 publish 未持久化值', () => {
  const store = makeTxStore({}, { commitFail: true })
  const registry = createSessionRegistry({ store, now: () => 4_000 })

  const record = registry.ensureSession(agentOf('S1', '/srv/x'))
  assert.equal(record, undefined, '落盘失败时 ensureSession 不返回成功记录')
  assert.deepEqual(store.state(), {}, '提交失败不得留下半提交数据')
})

test('T14：无真实事务的旧 store 回退单键读-改-写，仍按字段级合并保留兄弟字段', () => {
  const state = { [KEY]: { S1: { inherit: 'w', workspace: 'w', createdAt: 1, lastActiveAt: 1, outbound: { quiet: true } } } }
  const store = {
    get(key, fallback = undefined) { return key in state ? clone(state[key]) : fallback },
    set(key, value) { state[key] = clone(value) },
    keys(prefix = '') { return Object.keys(state).filter((key) => key.startsWith(prefix)) },
  }
  assert.equal(typeof store.transact, 'undefined')
  const registry = createSessionRegistry({ store, now: () => 5_000 })

  registry.ensureSession(agentOf('S1', '/home/u/w'))

  assert.deepEqual(state[KEY].S1.outbound, { quiet: true }, '旧 store 路径同样不丢兄弟字段')
  assert.equal(state[KEY].S1.lastActiveAt, 5_000)
})

test('T14：注入事务 abort（OTHER 写者业务拒绝）不影响本写者语义——注册表写独立提交', () => {
  const store = makeTxStore()
  // 模拟 router 的一次业务 abort（零写盘），随后注册表生命周期写仍能独立提交。
  const aborted = store.transact((draft, control) => { control.abort('not-found') })
  assert.equal(aborted.code, 'BUSINESS_ABORT')
  assert.deepEqual(store.state(), {}, '业务 abort 零写盘')

  const registry = createSessionRegistry({ store, now: () => 6_000 })
  registry.ensureSession(agentOf('S1', '/srv/y'))
  assert.equal(store.state()[KEY].S1.workspace, 'y')
})