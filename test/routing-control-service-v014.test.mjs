// v0.14 S03 测试：RoutingControlService（会话 / 路由共享编排服务）。
//
// 覆盖面：Native 与 Admin 共用同一服务 → 同一 canonical 事实；双表整表替换的单事务
// 原子性（单次 transact、失败两表都不落盘）；整表形状违规归一为 invalid 且零写入；会话
// 列表投影（canonical 表 + 实时出站解析 + 脱敏控制摘要 + 损坏条目跳过 + 活跃排序）；
// 会话出站/控制覆盖层的字段级 diff（sibling 不 clobber）；真实落盘失败时绑定/会话写入
// 如实报错、绝不假成功。
//
// mock：真实 agent-router + 真实 store（文件落盘）/ 内存 registry 桩；stateDir 用
// mkdtempSync 临时目录，审计文件真实落盘。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoutingControlService, controlSummary } from '../src/control-plane/sessions.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createAdminApi, ApiError } from '../src/admin/api.mjs'
import { createStore } from '../src/inbound/store.mjs'

/** 临时 state 目录 + state.json 文件（可选预置内容）。 */
const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-routing-control-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 真实落盘必失败的 store：state.json 的父级是一个普通文件。 */
const failingStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-routing-control-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  return createStore(join(blocker, 'state.json'))
}

/** 最小 registry 桩：getSession（内存记录）+ isActive（活跃名单）。 */
const makeRegistry = ({ records = {}, active = [] } = {}) => ({
  getSession: (id) => (Object.prototype.hasOwnProperty.call(records, id) ? { ...records[id] } : undefined),
  isActive: (id) => active.includes(id),
})

/** 断言辅助：抛 ApiError 且 status 匹配。 */
const apiErrorOf = (status) => (error) => error instanceof ApiError && error.status === status

/** rig：真实 store + 真实 router + 共享 service + Admin 适配器。 */
const makeRig = ({ state = {}, active = [], records = {}, enabled = [] } = {}) => {
  const { dir, file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = makeRegistry({ records, active })
  const service = createRoutingControlService({ router, registry, store })
  const admin = createAdminApi({
    router, registry, store, routingControl: service,
    channelsEnabled: () => [...enabled], stateDir: dir,
  })
  return { store, router, registry, service, admin }
}

test('S03: Native 与 Admin 共用同一 RoutingControlService，写入同一 canonical 事实', () => {
  const { store, service, admin } = makeRig({ enabled: ['bark', 'webhook'] })

  // 经 Admin 写双向绑定 → 落在 router 的两张 canonical 表上，无第二套事实
  const written = admin.putBindings({
    agents: { 'ws-a': { channels: ['bark'] } },
    channels: { telegram: { defaultAgent: 'ws-a' } },
  })
  assert.deepEqual(store.get('route:agents'), { 'ws-a': { channels: ['bark'] } })
  assert.deepEqual(store.get('route:channels'), { telegram: { defaultAgent: 'ws-a' } })
  assert.deepEqual(service.bindingsSnapshot(), written, 'service 快照与 Admin 读回同源')
  assert.deepEqual(admin.getBindings(), service.bindingsSnapshot())

  // 经 service 单侧替换 → Admin 立即读到同一事实；未出现的表不动
  assert.equal(service.replaceBindings({ agents: { 'ws-b': { quiet: true } } }).ok, true)
  assert.deepEqual(store.get('route:agents'), { 'ws-b': { quiet: true } })
  assert.deepEqual(store.get('route:channels'), { telegram: { defaultAgent: 'ws-a' } }, '未出现的表不动')
  assert.deepEqual(admin.getBindings().channels, { telegram: { defaultAgent: 'ws-a' } })
})

test('S03: 双表整表替换走单事务；事务失败时两表都不落盘、如实报错', () => {
  const { store, router, service } = makeRig({
    state: { 'route:agents': { old: { channels: ['bark'] } }, 'route:channels': { telegram: { defaultAgent: 'old' } } },
  })
  const realTransact = store.transact
  let calls = 0
  store.transact = (mutator) => { calls += 1; return realTransact(mutator) }

  const result = service.replaceBindings({
    agents: { 'ws-a': { channels: ['bark'] } },
    channels: { feishu: { defaultAgent: 'ws-a' } },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1, '两张表必须在同一个事务里提交')
  assert.deepEqual(store.get('route:agents'), { 'ws-a': { channels: ['bark'] } })
  assert.deepEqual(store.get('route:channels'), { feishu: { defaultAgent: 'ws-a' } })

  // 落盘必失败的 store：事务不提交，两表保持「无记录」，绝不半提交
  const failing = failingStore()
  const failingRouter = createAgentRouter({ store: failing, agentsList: () => [] })
  const failingService = createRoutingControlService({ router: failingRouter, store: failing })
  const failed = failingService.replaceBindings({
    agents: { x: { quiet: true } },
    channels: { telegram: { defaultAgent: 'x' } },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'storage-failed')
  assert.equal(failing.get('route:agents'), undefined)
  assert.equal(failing.get('route:channels'), undefined)
})

test('S03: 整表形状违规由 router 抛 TypeError → service 归一为 invalid，零写入', () => {
  const { store, service } = makeRig()
  const result = service.replaceBindings({ agents: { 'ws-a': { channels: 'bark' } } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid')
  assert.equal(store.get('route:agents'), undefined)
})

test('S03: 会话列表投影 = canonical 表 + 实时解析 + 脱敏摘要；损坏条目跳过', () => {
  const { service } = makeRig({
    state: {
      'route:sessions': {
        's-active': {
          workspace: 'ws-a', inherit: 'project', lastActiveAt: '2026-01-01T00:00:00Z',
          outbound: { channels: ['webhook'] },
          control: {
            mode: 'team', owner: 'user:secret-1',
            approvalMembers: [{ channel: 'telegram', accountId: 'acc-42', userId: 'u-9' }],
          },
        },
        's-idle': { workspace: 'ws-a', lastActiveAt: 500, disposedAt: 999 },
        's-broken': 42, // 非普通对象：跳过，不弄崩列表
      },
      'route:agents': { 'ws-a': { channels: ['bark', 'webhook'], quiet: true } },
    },
    active: ['s-active'],
    enabled: ['bark', 'webhook', 'telegram'],
  })

  const rows = service.sessionsView({ enabledTypes: ['bark', 'webhook', 'telegram'] })
  assert.deepEqual(rows.map((r) => r.id), ['s-active', 's-idle'], '损坏条目跳过；活跃在前')
  assert.equal(rows[0].active, true)
  assert.equal(rows[1].active, false)
  assert.equal(rows[1].disposedAt, 999)

  // 字段级 diff：channels 来自 session 覆盖层，quiet 未覆盖 → 回落 workspace 绑定
  assert.deepEqual(rows[0].resolved, { channelTypes: ['webhook'], quiet: true, source: 'session' })
  assert.deepEqual(rows[1].resolved, { channelTypes: ['bark', 'webhook'], quiet: true, source: 'agent-workspace' })

  // 控制摘要：只暴露派生布尔/计数，绝不含原始 owner / 成员标识
  assert.deepEqual(rows[0].control, { mode: 'team', ownerConfigured: true, approvalMembersCount: 1 })
  const projected = JSON.stringify(rows)
  assert.equal(projected.includes('secret-1'), false, '投影绝不含原始 owner')
  assert.equal(projected.includes('acc-42'), false, '投影绝不含成员 accountId')
  assert.equal(projected.includes('u-9'), false, '投影绝不含成员 userId')
  assert.equal(controlSummary({ owner: '', mode: 'bogus' }), undefined)
})

test('S03: 会话覆盖层写入经共享 service 收敛，字段级 diff 不 clobber sibling', () => {
  const { store, admin } = makeRig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project', lastActiveAt: 1 } } },
    active: ['s1'],
    enabled: ['bark', 'webhook'],
  })

  assert.deepEqual(admin.patchSession('s1', { channels: ['bark'] }), { id: 's1', outbound: { channels: ['bark'] } })
  const second = admin.patchSession('s1', { quiet: true })
  assert.deepEqual(second.outbound, { channels: ['bark'], quiet: true }, '后一次写入不得清掉 channels')
  assert.deepEqual(store.get('route:sessions').s1.outbound, { channels: ['bark'], quiet: true })
  assert.equal(store.get('route:sessions').s1.workspace, 'ws-a', 'registry 字段不被覆盖')

  const ctrl = admin.patchSessionControl('s1', { owner: 'owner-xyz', approvalOwnerOnly: true })
  assert.deepEqual(ctrl.control, { approvalOwnerOnly: true, ownerConfigured: true })
  assert.equal('owner' in ctrl.control, false, '返回摘要不含原始 owner')
  assert.equal(store.get('route:sessions').s1.control.owner, 'owner-xyz', 'canonical 表保留归一后的原始值')

  assert.throws(() => admin.patchSession('nope', { quiet: true }), apiErrorOf(404))
  assert.throws(() => admin.patchSessionControl('nope', { owner: 'x' }), apiErrorOf(404))
})

test('S03: 真实落盘失败时绑定/会话写入如实报错，绝不假成功', () => {
  const store = failingStore()
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = makeRegistry({ records: { s1: { workspace: 'ws-a' } }, active: ['s1'] })
  const service = createRoutingControlService({ router, registry, store })
  const admin = createAdminApi({
    router, registry, store, routingControl: service,
    channelsEnabled: () => ['bark'],
    stateDir: mkdtempSync(join(tmpdir(), 'dsh-v014-routing-control-audit-')),
  })

  assert.equal(service.replaceBindings({
    agents: { 'ws-a': { channels: ['bark'] } },
    channels: { telegram: { defaultAgent: 'ws-a' } },
  }).ok, false)
  assert.throws(() => admin.putBindings({ agents: { 'ws-a': { channels: ['bark'] } } }), apiErrorOf(500))
  assert.throws(() => admin.patchSession('s1', { quiet: true }), apiErrorOf(500))
  assert.equal(store.get('route:agents'), undefined)
  assert.equal(store.get('route:sessions'), undefined)
})