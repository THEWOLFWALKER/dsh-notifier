// v0.15 S10（T16）：应用入口与 Recovery/CLI 同权威。
//
// 锁定 03-TASKS T16 的验收：
//   1. 同一操作经 Native RPC 与 Advanced Console（Admin HTTP）落到**同一权威**，durable diff
//      逐字一致、兄弟字段不丢（`<authority>` 是唯一 writer，入口只做鉴权/输入映射/表现映射）；
//   2. storage failure 绝不改写成 not-found：Native 上报 `storage-failed`，Admin 上报 500；
//   3. query 在能力不可用时 fail-closed（Native `not-supported`），绝不返回 `ok:true` 的空表，
//      从而「缺 service」不被误当成「暂无数据」；
//   4. 末位 owner 守卫单一权威——service 不再自持锁外预检（重复规则已收敛到 identity 锁内）。
//
// 关键回归：members service 旧实现持有一份锁外 `ownerCount()` 预检，与 identity 的锁内写入
// 形成 TOCTOU；同时 Admin 适配器把 `storage-failed` 误映射成 404，让调用方误判「不存在」而
// 放弃重试。本套件以真实 store 钉死「多入口同权威」与「失败语义可分」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createMembersControlService } from '../src/control-plane/members.mjs'
import { createMembersProjection } from '../src/control-surface/members.mjs'
import { createRoutingControlService } from '../src/control-plane/sessions.mjs'
import { createSessionsProjection } from '../src/control-surface/sessions.mjs'
import { createBindingsProjection } from '../src/control-surface/bindings.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createAdminApi, ApiError } from '../src/admin/api.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { CHANNEL_TYPES } from '../src/config.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-s10-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/**
 * 装配 rig：**同一** store / identity / pairing / router 之上同时建 Native 控制面与 Advanced
 * Console —— 与 src/index.mjs 的生产装配同构（共享 service 单例，谁都不持第二 writer）。
 */
function buildRig({ state = {} } = {}) {
  const { dir, file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = { getSession: () => undefined, isActive: () => false }
  const identity = createIdentity({ store })
  const pairing = createPairing({ store })

  const membersControl = createMembersControlService({ identity, pairing })
  const routingControl = createRoutingControlService({ router, registry, store })
  const members = createMembersProjection({ service: membersControl })
  const sessions = createSessionsProjection({ service: routingControl, enabledTypes: () => [...CHANNEL_TYPES] })
  const bindings = createBindingsProjection({ service: routingControl })

  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  const surface = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    members,
    sessions,
    bindings,
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const admin = createAdminApi({
    router,
    registry,
    store,
    identity,
    pairing,
    membersControl,
    routingControl,
    guidedProbe: () => identity.isEmpty(),
    stateDir: dir,
  })
  return { dir, file, store, router, identity, pairing, membersControl, routingControl, surface, admin }
}

/** 持锁：让后续 transact 落 STATE_BUSY → 上层归一为 storage-failed（真实 IO 失败路径）。 */
const holdLock = (file) => writeFileSync(`${file}.lock`, `${process.pid}:v015-s10-live-holder`)

// ————————————————————— 1. 多入口同权威：durable diff 一致 —————————————————————

test('T16: 成员更新经 Native 与 Admin 落到同一权威，字段级合并不丢兄弟字段', async () => {
  const rig = buildRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' }) // 首条 = owner
  rig.identity.addBinding({ channel: 'qq', userId: 'qqm1' })        // member
  const before = { ...rig.store.get('inbound:bindings')['qq:qqm1'] }

  // Native 入口：只改 label
  const native = await rig.surface.call('members.update', { key: 'qq:qqm1', label: 'native-label' })
  assert.equal(native.ok, true)
  const afterNative = rig.store.get('inbound:bindings')['qq:qqm1']
  assert.equal(afterNative.label, 'native-label')
  assert.equal(afterNative.role, before.role, '改 label 不得动 role')
  assert.equal(afterNative.pairedAt, before.pairedAt, '改 label 不得动 pairedAt')

  // Admin 入口：只改 role —— 必须与 Native 共享同一 identity 权威，且保留 Native 写的 label
  const admin = rig.admin.putMember('qq:qqm1', { role: 'owner' })
  assert.equal(admin.saved, true)
  const afterAdmin = rig.store.get('inbound:bindings')['qq:qqm1']
  assert.equal(afterAdmin.role, 'owner', 'Admin 写入落到 identity 权威')
  assert.equal(afterAdmin.label, 'native-label', 'Admin 改 role 不得丢 Native 写的 label（同权威字段级合并）')
  assert.equal(afterAdmin.pairedAt, before.pairedAt)
})

test('T16: 会话出站覆盖经 Native 与 Admin 落到同一 route:sessions、sibling 共存', async () => {
  const rig = buildRig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project', lastActiveAt: 1 } } },
  })

  const native = await rig.surface.call('sessions.patch', { id: 's1', diff: { channels: ['bark'] } })
  assert.equal(native.ok, true)
  const admin = rig.admin.patchSession('s1', { quiet: true })
  assert.deepEqual(admin.outbound, { channels: ['bark'], quiet: true }, 'Admin 写入不得清掉 Native 写的 channels')

  const row = rig.store.get('route:sessions').s1
  assert.deepEqual(row.outbound, { channels: ['bark'], quiet: true }, '两个入口写同一 route:sessions 权威键')
  assert.equal(row.workspace, 'ws-a', 'registry 生命周字段不被覆盖')
})

test('T16: 绑定整表替换经 Native 与 Admin 落到同一 route:* 权威', async () => {
  const rig = buildRig()

  const native = await rig.surface.call('bindings.put', { agents: { 'ws-a': { channels: ['bark'] } } })
  assert.equal(native.ok, true)
  assert.deepEqual(native.value.agents, { 'ws-a': { channels: ['bark'] } })

  rig.admin.putBindings({ channels: { telegram: { defaultAgent: 'ws-a' } } })
  assert.deepEqual(rig.store.get('route:agents'), { 'ws-a': { channels: ['bark'] } }, 'Native 写的 agents 权威保留')
  assert.deepEqual(rig.store.get('route:channels'), { telegram: { defaultAgent: 'ws-a' } }, 'Admin 写的 channels 权威落同一键域')
})

// ————————————————————— 2. storage failure 不转 not-found —————————————————————

test('T16: 成员更新/删除 IO 失败——Native=storage-failed、Admin=500（绝不伪装 not-found）', async () => {
  const rig = buildRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_owner' }) // owner（保留，不触发末位守卫）
  rig.identity.addBinding({ channel: 'qq', userId: 'qqm1' })        // member（可改）
  holdLock(rig.file)

  const nativeUpdate = await rig.surface.call('members.update', { key: 'qq:qqm1', label: 'x' })
  assert.equal(nativeUpdate.ok, false)
  assert.equal(nativeUpdate.error.code, 'dsh-notifier/storage-failed', 'Native 上报 IO 失败，不是 not-found')

  const nativeRemove = await rig.surface.call('members.remove', { key: 'qq:qqm1' })
  assert.equal(nativeRemove.ok, false)
  assert.equal(nativeRemove.error.code, 'dsh-notifier/storage-failed')

  assert.throws(() => rig.admin.putMember('qq:qqm1', { label: 'x' }), (error) => error instanceof ApiError && error.status === 500)
  assert.throws(() => rig.admin.deleteMember('qq:qqm1'), (error) => error instanceof ApiError && error.status === 500)
})

test('T16: 待确认转正/忽略 IO 失败——Native=storage-failed、Admin=500', async () => {
  const rig = buildRig()
  rig.identity.addPending({ channel: 'qq', userId: 'u9', origin: 'learned' })
  holdLock(rig.file)

  const nativeApprove = await rig.surface.call('members.approve', { key: 'qq:u9' })
  assert.equal(nativeApprove.ok, false)
  assert.equal(nativeApprove.error.code, 'dsh-notifier/storage-failed')

  const nativeDismiss = await rig.surface.call('members.dismiss', { key: 'qq:u9' })
  assert.equal(nativeDismiss.ok, false)
  assert.equal(nativeDismiss.error.code, 'dsh-notifier/storage-failed')

  assert.throws(() => rig.admin.confirmPendingMember('qq:u9'), (error) => error instanceof ApiError && error.status === 500)
  assert.throws(() => rig.admin.dismissPendingMember('qq:u9'), (error) => error instanceof ApiError && error.status === 500)
})

test('T16: 配对码撤销 IO 失败——Native=storage-failed、Admin=500（不伪装 404）', async () => {
  const rig = buildRig()
  const minted = rig.pairing.mint({ origin: 'admin', mintedBy: 'test' })
  assert.equal(minted.ok, true)
  holdLock(rig.file)

  const nativeRevoke = await rig.surface.call('pairing.revoke', { id: minted.id })
  assert.equal(nativeRevoke.ok, false)
  assert.equal(nativeRevoke.error.code, 'dsh-notifier/storage-failed')

  assert.throws(() => rig.admin.revokePairingCode(minted.id), (error) => error instanceof ApiError && error.status === 500)
})

test('T16: 会话覆盖写入 IO 失败——Native=storage-failed、Admin=500', async () => {
  const rig = buildRig({ state: { 'route:sessions': { s1: { workspace: 'ws-a', lastActiveAt: 1 } } } })
  holdLock(rig.file)

  const native = await rig.surface.call('sessions.patch', { id: 's1', diff: { quiet: true } })
  assert.equal(native.ok, false)
  assert.equal(native.error.code, 'dsh-notifier/storage-failed')

  assert.throws(() => rig.admin.patchSession('s1', { quiet: true }), (error) => error instanceof ApiError && error.status === 500)
})

// ————————————————————— 3. query 缺 service fail-closed（不假空） —————————————————————

test('T16: 查询在能力不可用时 fail-closed —— not-supported，绝不 ok:true 空表', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()

  // 投影层存在但底层 service 缺失 → canList/canRead=false
  const surface = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    members: createMembersProjection({ service: null }),
    sessions: createSessionsProjection({ service: null }),
    bindings: createBindingsProjection({ service: null }),
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  for (const method of ['members.list', 'members.pending', 'pairing.list', 'sessions.list', 'bindings.get']) {
    const result = await surface.call(method, {})
    assert.equal(result.ok, false, `${method} 必须 fail-closed，不得返回 ok:true`)
    assert.equal(result.error.code, 'dsh-notifier/not-supported', `${method} 报 not-supported（缺 service 不当空）`)
  }
})

// ————————————————————— 4. 末位 owner 守卫单一权威 —————————————————————

test('T16: 末位 owner 守卫不再由 service 锁外预检——重复规则已收敛到 identity 锁内', async () => {
  const rig = buildRig()
  rig.identity.addBinding({ channel: 'feishu', userId: 'ou_only' }) // 唯一 owner

  // 唯一权威判定：Native 与 Admin 都经 identity 锁内守卫，业务拒绝映射一致（conflict / 422），
  // 且不是 storage-failed（证明 service 未在锁外另持一份预检、也未吞掉业务语义）。
  const native = await rig.surface.call('members.remove', { key: 'feishu:ou_only' })
  assert.equal(native.ok, false)
  assert.equal(native.error.code, 'dsh-notifier/conflict', '末位 owner 是业务拒绝 → conflict')

  assert.throws(() => rig.admin.deleteMember('feishu:ou_only'), (error) => error instanceof ApiError && error.status === 422)
  assert.equal(rig.identity.ownerCount(), 1, 'owner 未被清零')
})