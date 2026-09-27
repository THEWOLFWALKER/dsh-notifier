// v0.14 S06：Native 成员面（`members.*` RPC 投影）契约测试。
// 用真实 createMembersControlService + 真实 createIdentity/createStore：断言投影只做形态映射、
// 写入仍落 identity 权威（I1）、末位 owner 守卫经投影映射成 conflict（不假成功，I16）、
// 键/字段非法 → bad-request、服务缺失 fail-closed（not-supported）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMembersProjection } from '../src/control-surface/members.mjs'
import { createMembersControlService } from '../src/control-plane/members.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createPairing } from '../src/inbound/pairing.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const rig = ({ withPairing = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-members-projection-'))
  const store = createStore(join(dir, 'state.json'))
  const identity = createIdentity({ store })
  const pairing = withPairing ? createPairing({ store }) : null
  const service = createMembersControlService({ identity, pairing })
  return { store, identity, pairing, service, projection: createMembersProjection({ service }) }
}

test('S06: 投影读取走共享服务，update/remove 落到 identity 权威', () => {
  const { identity, service, projection } = rig()
  service.addMember({ channel: 'feishu', userId: 'ou_owner', label: '张三' })
  service.addMember({ channel: 'qq', userId: 'qqmember01' })

  const rows = projection.list()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.key).sort(), ['feishu:ou_owner', 'qq:qqmember01'])
  // 脱敏形状：不得出现凭证/哈希等敏感字段
  assert.deepEqual(Object.keys(rows[0]).sort(), ['channel', 'key', 'label', 'lastSeenAt', 'origin', 'pairedAt', 'role', 'userId'])

  // 提升第二位为 owner 后删除首位 owner（末位守卫不触发）
  assert.deepEqual(projection.update({ key: 'qq:qqmember01', role: 'owner' }), { key: 'qq:qqmember01', saved: true })
  assert.equal(identity.list('qq')[0].role, 'owner', '写入落到 identity 权威')
  assert.deepEqual(projection.remove({ key: 'feishu:ou_owner' }), { key: 'feishu:ou_owner', deleted: true })
  assert.equal(identity.allows('feishu', 'ou_owner'), false, '删除落到 identity 权威')
  assert.equal(projection.list().length, 1)
})

test('S06: 末位 owner 降级/删除 → conflict（绝不假成功）', () => {
  const { service, projection } = rig()
  service.addMember({ channel: 'feishu', userId: 'ou_only', label: '唯一所有者' })

  assert.throws(() => projection.update({ key: 'feishu:ou_only', role: 'member' }), (error) => error.code === 'conflict')
  assert.throws(() => projection.remove({ key: 'feishu:ou_only' }), (error) => error.code === 'conflict')
  assert.equal(projection.list().length, 1, '被拒操作零副作用')
})

test('S06: 键/字段非法 → bad-request；未知成员 → not-found', () => {
  const { service, projection } = rig()
  service.addMember({ channel: 'feishu', userId: 'ou_owner' })

  assert.throws(() => projection.update({ key: 'feishu:ou_owner', role: 'admin' }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.update({ key: 'feishu:ou_owner' }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.update({ key: 'slack:u1', label: 'x' }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.remove({ key: 'qq:missing' }), (error) => error.code === 'not-found')
})

test('S06: 服务缺失 → 空表 / not-supported（fail-closed，不伪造成员）', () => {
  const projection = createMembersProjection({})
  assert.equal(projection.canList, false)
  assert.deepEqual(projection.list(), [])
  assert.throws(() => projection.update({ key: 'feishu:ou_owner', role: 'member' }), (error) => error.code === 'not-supported')
  assert.throws(() => projection.remove({ key: 'feishu:ou_owner' }), (error) => error.code === 'not-supported')
})

test('S06: control-surface members.* 经投影记账 revision/activity；未装配 → bad-request', async () => {
  const { service } = rig()
  service.addMember({ channel: 'feishu', userId: 'ou_owner' })
  service.addMember({ channel: 'qq', userId: 'qqmember01' })
  const projection = createMembersProjection({ service })
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()

  const build = (members) => createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    ...(members === undefined ? {} : { members }),
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const surface = build(projection)
  const before = revision.current().revision

  const list = await surface.call('members.list', {})
  assert.equal(list.ok, true)
  assert.equal(list.value.members.length, 2)
  assert.equal(list.value.canUpdate, true)
  assert.equal(list.value.canRemove, true)

  const updated = await surface.call('members.update', { key: 'qq:qqmember01', role: 'owner' })
  assert.equal(updated.ok, true)
  assert.deepEqual(updated.value, { key: 'qq:qqmember01', saved: true })

  const removed = await surface.call('members.remove', { key: 'feishu:ou_owner' })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.value, { key: 'feishu:ou_owner', deleted: true })

  assert.ok(revision.current().revision > before, '成员写入推进 revision')
  assert.ok(activity.list().some((item) => item.title.en === 'Member updated'))
  assert.ok(activity.list().some((item) => item.title.en === 'Member removed'))

  // 末位守卫经 RPC 映射为 conflict，且不回写成功
  const lastOwner = await surface.call('members.update', { key: 'qq:qqmember01', role: 'member' })
  assert.equal(lastOwner.ok, false)
  assert.equal(lastOwner.error.code, 'dsh-notifier/conflict')

  // 未装配 members 投影 → 未知方法（bad-request），绝不静默成功
  const bare = build(undefined)
  const unknown = await bare.call('members.list', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'dsh-notifier/bad-request')
})

// ————————————————————————— v0.14 S07：待确认身份 + 配对码 —————————————————————————

test('S07: 待确认身份投影 approve/dismiss 落到 identity 权威', () => {
  const { identity, service, projection } = rig()
  assert.equal(projection.canApprove, true)
  assert.equal(projection.canDismiss, true)

  service.addPending({ channel: 'qq', userId: 'u9', origin: 'learned' })
  const rows = projection.listPending()
  assert.equal(rows.length, 1)
  // 脱敏形状：只有复合键与来源，绝不透传内部 extra / 凭证
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'channel', 'key', 'origin', 'userId'])

  // 转正 → 正式成员（单事务提升，I3）
  assert.deepEqual(projection.approve({ key: 'qq:u9' }), { key: 'qq:u9', saved: true })
  assert.equal(identity.allows('qq', 'u9'), true, '转正落到 identity 权威')
  assert.equal(projection.listPending().length, 0)

  // 忽略 → 不转正，仅清除条目
  service.addPending({ channel: 'feishu', userId: 'ou_x' })
  assert.deepEqual(projection.dismiss({ key: 'feishu:ou_x' }), { key: 'feishu:ou_x', dismissed: true })
  assert.equal(identity.allows('feishu', 'ou_x'), false, '忽略不产生成员绑定')
  assert.equal(projection.listPending().length, 0)
})

test('S07: 待确认身份缺失 → not-found；非法键 → bad-request', () => {
  const { projection } = rig()
  assert.throws(() => projection.approve({ key: 'qq:missing' }), (error) => error.code === 'not-found')
  assert.throws(() => projection.dismiss({ key: 'qq:missing' }), (error) => error.code === 'not-found')
  assert.throws(() => projection.approve({ key: 'slack:u1' }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.dismiss({ key: '' }), (error) => error.code === 'bad-request')
})

test('S07: 配对码铸造只回一次码面，列表绝不泄漏码面/哈希', () => {
  const { service, projection } = rig({ withPairing: true })
  assert.equal(projection.canMint, true)
  assert.equal(projection.canRevoke, true)

  const minted = projection.mintCode({ label: 'laptop' })
  assert.equal(typeof minted.code, 'string')
  assert.ok(minted.code.length > 0)
  assert.ok(minted.id)
  assert.ok(Number.isFinite(minted.expiresAt))

  const list = projection.listCodes()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, minted.id)
  assert.ok(!('code' in list[0]), '列表视图绝不出现码面')
  assert.ok(!('hash' in list[0]), '列表视图绝不出现哈希')

  assert.deepEqual(projection.revokeCode({ id: minted.id }), { id: minted.id, revoked: true })
  assert.equal(projection.listCodes().length, 0)
  assert.equal(service.redeemPairingCode(minted.code).ok, false, '被撤销的码不可再核销')

  assert.throws(() => projection.mintCode({ ttlMs: -1 }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.revokeCode({}), (error) => error.code === 'bad-request')
})

test('S07: 配对层未装配 → 空列表 / not-supported（fail-closed）', () => {
  const { projection } = rig()
  assert.equal(projection.canMint, false)
  assert.equal(projection.canRevoke, false)
  assert.deepEqual(projection.listCodes(), [])
  assert.throws(() => projection.mintCode({}), (error) => error.code === 'not-supported')
  assert.throws(() => projection.revokeCode({ id: 'x' }), (error) => error.code === 'not-supported')
})

test('S07: control-surface pending/pairing.* 经投影记账 revision/activity', async () => {
  const { service } = rig({ withPairing: true })
  service.addPending({ channel: 'qq', userId: 'u9' })
  const projection = createMembersProjection({ service })
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()

  const surface = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    members: projection,
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const pending = await surface.call('members.pending', {})
  assert.equal(pending.ok, true)
  assert.equal(pending.value.pending.length, 1)
  assert.equal(pending.value.canApprove, true)
  assert.equal(pending.value.canDismiss, true)

  const approved = await surface.call('members.approve', { key: 'qq:u9' })
  assert.equal(approved.ok, true)
  assert.deepEqual(approved.value, { key: 'qq:u9', saved: true })

  const minted = await surface.call('pairing.mint', { label: 'laptop' })
  assert.equal(minted.ok, true)
  assert.equal(typeof minted.value.code, 'string')

  const list = await surface.call('pairing.list', {})
  assert.equal(list.value.codes.length, 1)
  assert.equal(list.value.canMint, true)
  assert.equal(list.value.canRevoke, true)

  const revoked = await surface.call('pairing.revoke', { id: minted.value.id })
  assert.equal(revoked.ok, true)
  assert.deepEqual(revoked.value, { id: minted.value.id, revoked: true })

  assert.ok(activity.list().some((item) => item.title.en === 'Pending identity approved'))
  assert.ok(activity.list().some((item) => item.title.en === 'Pairing code minted'))
  assert.ok(activity.list().some((item) => item.title.en === 'Pairing code revoked'))

  // 非法 id → bad-request；未装配投影方法 → 未知方法绝不静默成功
  const bad = await surface.call('pairing.revoke', { id: '' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'dsh-notifier/bad-request')
})