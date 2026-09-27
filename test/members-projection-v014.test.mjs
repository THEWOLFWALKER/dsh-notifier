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
import { createStore } from '../src/inbound/store.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const rig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-members-projection-'))
  const store = createStore(join(dir, 'state.json'))
  const identity = createIdentity({ store })
  const service = createMembersControlService({ identity })
  return { store, identity, service, projection: createMembersProjection({ service }) }
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