// v0.14 S09：Native 高级绑定面（`bindings.*` RPC 投影）契约测试。
// 用真实 createRoutingControlService（真实 agent-router + 真实 store）：断言投影只做形态映射、
// 整表替换落 router 权威表（I1）、非法形状 → bad-request 零写入、真实落盘失败 → storage-failed
// （绝不假成功）、服务缺失 fail-closed（not-supported）、control-surface bindings.* 记账 revision。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBindingsProjection } from '../src/control-surface/bindings.mjs'
import { createRoutingControlService } from '../src/control-plane/sessions.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-bindings-projection-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 真实落盘必失败的 store：state.json 的父级是一个普通文件。 */
const failingStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-bindings-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  return createStore(join(blocker, 'state.json'))
}

const rig = ({ state = {} } = {}) => {
  const { dir, file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const service = createRoutingControlService({ router, store })
  const projection = createBindingsProjection({ service })
  return { store, router, service, projection }
}

test('S09: 投影整表替换落 router 权威表；编辑保留 sibling 键', () => {
  const { store, projection } = rig()
  assert.equal(projection.canRead, true)
  assert.equal(projection.canEdit, true)

  const written = projection.put({
    agents: { 'ws-a': { channels: ['bark', 'webhook'] }, 'ws-b': { quiet: true } },
    channels: { telegram: { defaultAgent: 'ws-a' } },
  })
  assert.deepEqual(written.agents, { 'ws-a': { channels: ['bark', 'webhook'] }, 'ws-b': { quiet: true } })
  assert.deepEqual(written.channels, { telegram: { defaultAgent: 'ws-a' } })
  assert.deepEqual(store.get('route:agents'), { 'ws-a': { channels: ['bark', 'webhook'] }, 'ws-b': { quiet: true } })

  // 单侧替换：只出现 agents → channels 表不动；整表替换语义下未出现的 ws-b 被回收
  const edited = projection.put({ agents: { 'ws-a': { channels: ['bark'], quiet: true } } })
  assert.deepEqual(edited.agents, { 'ws-a': { channels: ['bark'], quiet: true } })
  assert.deepEqual(edited.channels, { telegram: { defaultAgent: 'ws-a' } }, '未出现的表不动')
  assert.deepEqual(projection.get(), edited, '读回与写入同源')
  assert.equal(Object.keys(edited.agents).includes('ws-b'), false, '整表替换语义：未出现的键被回收')
})

test('S09: 非法形状 → bad-request 且零写入；未知出站渠道 / 保留键 / 非法入站键被拒', () => {
  const { store, projection } = rig()
  assert.throws(() => projection.put({ agents: { 'ws-a': { channels: ['nope'] } } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.put({ agents: { 'ws-a': { quiet: 'yes' } } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.put({ agents: { 'ws-a': 'bark' } }), (error) => error.code === 'bad-request')
  assert.throws(
    () => projection.put(JSON.parse('{"agents":{"__proto__":{"quiet":true}}}')),
    (error) => error.code === 'bad-request',
  )
  assert.throws(() => projection.put({ channels: { slack: { defaultAgent: 'ws-a' } } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.put({ channels: { telegram: { defaultAgent: '' } } }), (error) => error.code === 'bad-request')
  assert.throws(() => projection.put(null), (error) => error.code === 'bad-request')
  assert.equal(store.get('route:agents'), undefined, '被拒操作零写入')
  assert.equal(store.get('route:channels'), undefined, '被拒操作零写入')
})

test('S09: 大表整表替换（200 agent 行）不丢失任何行', () => {
  const { projection } = rig()
  const agents = {}
  for (let i = 0; i < 200; i += 1) agents[`ws-${i}`] = { channels: ['bark'], quiet: i % 2 === 0 }
  const written = projection.put({ agents })
  assert.equal(Object.keys(written.agents).length, 200)
  assert.deepEqual(written.agents['ws-7'], { channels: ['bark'], quiet: false })
})

test('S09: 真实落盘失败 → storage-failed（绝不假成功）；服务缺失 → not-supported', () => {
  const store = failingStore()
  const router = createAgentRouter({ store, agentsList: () => [] })
  const service = createRoutingControlService({ router, store })
  const projection = createBindingsProjection({ service })
  assert.throws(() => projection.put({ agents: { 'ws-a': { channels: ['bark'] } } }), (error) => error.code === 'storage-failed')
  assert.equal(store.get('route:agents'), undefined)

  const bare = createBindingsProjection({})
  assert.equal(bare.canRead, false)
  assert.equal(bare.canEdit, false)
  assert.deepEqual(bare.get(), { agents: {}, channels: {} })
  assert.throws(() => bare.put({ agents: { 'ws-a': { quiet: true } } }), (error) => error.code === 'not-supported')
})

test('S09: control-surface bindings.* 经投影记账 revision/activity；未装配 → bad-request', async () => {
  const { service } = rig()
  const projection = createBindingsProjection({ service })
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()

  const build = (bindings) => createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    ...(bindings === undefined ? {} : { bindings }),
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const surface = build(projection)
  const before = revision.current().revision

  const got = await surface.call('bindings.get', {})
  assert.equal(got.ok, true)
  assert.deepEqual(got.value.agents, {})
  assert.equal(got.value.canEdit, true)

  const put = await surface.call('bindings.put', { agents: { 'ws-a': { channels: ['bark'] } } })
  assert.equal(put.ok, true)
  assert.deepEqual(put.value.agents, { 'ws-a': { channels: ['bark'] } })
  assert.ok(revision.current().revision > before, '绑定写入推进 revision')
  assert.ok(activity.list().some((item) => item.title.en === 'Routing bindings replaced'))

  const bad = await surface.call('bindings.put', { agents: { 'ws-a': { channels: ['nope'] } } })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'dsh-notifier/bad-request')

  const bare = build(undefined)
  const unknown = await bare.call('bindings.get', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'dsh-notifier/bad-request')
})