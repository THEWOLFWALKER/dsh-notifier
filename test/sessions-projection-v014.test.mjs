// v0.14 S08：Native 会话面（`sessions.*` RPC 投影）契约测试。
// 用真实 createRoutingControlService（真实 agent-router + 真实 store）：断言投影只做形态映射、
// 出站覆盖写入仍落 router 权威表并保留 sibling（I1/I10）、非法 diff → bad-request、未知会话 →
// not-found、服务缺失 fail-closed（not-supported）、control-surface sessions.* 记账 revision/activity。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionsProjection } from '../src/control-surface/sessions.mjs'
import { createRoutingControlService } from '../src/control-plane/sessions.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-sessions-projection-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

const makeRegistry = ({ records = {}, active = [] } = {}) => ({
  getSession: (id) => (Object.prototype.hasOwnProperty.call(records, id) ? { ...records[id] } : undefined),
  isActive: (id) => active.includes(id),
})

/** rig：真实 store/router + 共享 service + Native 投影。 */
const rig = ({ state = {}, active = [], records = {}, enabled = [] } = {}) => {
  const { dir, file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = makeRegistry({ records, active })
  const service = createRoutingControlService({ router, registry, store })
  const projection = createSessionsProjection({ service, enabledTypes: () => [...enabled] })
  return { store, router, registry, service, projection }
}

test('S08: 投影读取走共享服务，列表带实时出站解析与 canPatch', () => {
  const { projection } = rig({
    state: {
      'route:sessions': {
        's-active': { workspace: 'ws-a', lastActiveAt: '2026-01-01T00:00:00Z' },
        's-idle': { workspace: 'ws-b', lastActiveAt: 500 },
      },
      'route:agents': { 'ws-a': { channels: ['bark'] } },
    },
    active: ['s-active'],
    enabled: ['bark', 'webhook'],
  })

  assert.equal(projection.canList, true)
  assert.equal(projection.canPatch, true)
  const rows = projection.list()
  assert.deepEqual(rows.map((r) => r.id), ['s-active', 's-idle'], '活跃在前')
  assert.equal(rows[0].active, true)
  assert.deepEqual(rows[0].resolved.channelTypes, ['bark'])
})

test('S08: 出站覆盖写入落 router 权威表且保留 sibling（不 clobber）', () => {
  const { store, projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project', lastActiveAt: 1 } } },
    active: ['s1'],
    enabled: ['bark', 'webhook'],
  })

  assert.deepEqual(projection.patch({ id: 's1', diff: { channels: ['bark'] } }), { id: 's1', outbound: { channels: ['bark'] } })
  const second = projection.patch({ id: 's1', diff: { quiet: true } })
  assert.deepEqual(second.outbound, { channels: ['bark'], quiet: true }, '后一次写入不得清掉 channels')
  assert.deepEqual(store.get('route:sessions').s1.outbound, { channels: ['bark'], quiet: true })
  assert.equal(store.get('route:sessions').s1.workspace, 'ws-a', 'registry 字段不被覆盖')

  // null 显式清除单个键：channels=null 回落全局，quiet 保留
  const cleared = projection.patch({ id: 's1', diff: { channels: null } })
  assert.deepEqual(cleared.outbound, { quiet: true })
})

test('S08: 非法 diff / 未知会话 / 空 id → bad-request / not-found', () => {
  const { projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a' } } },
    active: ['s1'],
    enabled: ['bark'],
  })

  assert.throws(() => projection.patch({ id: 's1', diff: { channels: ['nope'] } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.patch({ id: 's1', diff: { quiet: 'yes' } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.patch({ id: 's1', diff: {} }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.patch({ id: 's1', diff: null }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.patch({ id: '  ', diff: { quiet: true } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.patch({ id: 'missing', diff: { quiet: true } }), (error) => error.code === 'not-found')
})

test('S08: 服务缺失 → 空表 / not-supported（fail-closed，不伪造会话）', () => {
  const projection = createSessionsProjection({})
  assert.equal(projection.canList, false)
  assert.equal(projection.canPatch, false)
  assert.deepEqual(projection.list(), [])
  assert.throws(() => projection.patch({ id: 's1', diff: { quiet: true } }), (error) => error.code === 'not-supported')
})

test('Stage 4（S402）：legacy sessions.* 已从 daily control-surface 删除（能力不存在）', async () => {
  const { store, service } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', lastActiveAt: 1 } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  const projection = createSessionsProjection({ service, enabledTypes: () => ['bark'] })
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()

  const build = (sessions) => createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    ...(sessions === undefined ? {} : { sessions }),
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const surface = build(projection)
  const before = revision.current().revision

  // 即便装配了 sessions 投影，daily 通话面也不再暴露 sessions.*（白名单外 → not-supported）。
  for (const [method, payload] of [
    ['sessions.list', {}],
    ['sessions.patch', { id: 's1', diff: { quiet: true } }],
  ]) {
    const result = await surface.call(method, payload)
    assert.equal(result.ok, false, `${method} 必须被拒`)
    assert.equal(result.error.code, 'dsh-notifier/not-supported', `${method} 是能力不存在`)
  }
  assert.equal(store.get('route:sessions').s1.outbound, undefined, '被拒的写入绝不落盘')
  assert.equal(revision.current().revision, before, '拒绝的调用绝不推进 revision')
  assert.deepEqual(activity.list(), [], '拒绝的调用绝不记 activity')
})