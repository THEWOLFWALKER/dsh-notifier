// Shared routing projection contracts retained after removal of the old Native session-detail page.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionsProjection } from '../src/control-surface/sessions.mjs'
import { createRoutingControlService } from '../src/control-plane/sessions.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-stage-e-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { file }
}

const rig = ({ state = {}, active = [], enabled = [] } = {}) => {
  const { file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = { getSession: () => undefined, isActive: (id) => active.includes(id) }
  const service = createRoutingControlService({ router, registry, store })
  const projection = createSessionsProjection({ service, enabledTypes: () => [...enabled] })
  return { store, service, projection }
}

test('E2 projection detail returns one row and rejects unknown sessions', () => {
  const { projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  assert.equal(projection.canDetail, true)
  assert.equal(projection.canControl, true)
  const { session } = projection.detail({ id: 's1' })
  assert.equal(session.id, 's1')
  assert.equal(session.workspace, 'ws-a')
  assert.deepEqual(session.resolved.channelTypes, ['bark'])
  assert.throws(() => projection.detail({ id: 'missing' }), (error) => error.code === 'not-found')
  assert.throws(() => projection.detail({ id: '  ' }), (error) => error.code === 'bad-request')
})

test('E2 projection patchControl merges into the router table without clobbering siblings', () => {
  const { store, projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  const first = projection.patchControl({ id: 's1', diff: { mode: 'team' } })
  assert.deepEqual(first, { id: 's1', control: { mode: 'team' } })
  const second = projection.patchControl({ id: 's1', diff: { approvalOwnerOnly: true } })
  assert.deepEqual(second.control, { mode: 'team', approvalOwnerOnly: true }, '后一次写入不得清掉 mode')
  assert.equal(store.get('route:sessions').s1.workspace, 'ws-a', 'registry 字段不被覆盖')
})

test('E2 projection patchControl rejects source fields and unknown keys (fail-closed)', () => {
  const { store, projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  for (const diff of [
    { channel: 'telegram' },
    { userId: 'u1' },
    { policyVersion: 2 },
    { owner: '*' },
    { mode: 'solo' },
    { approvalMembers: [{ channel: 'telegram', accountId: 'a', userId: 'u' }, { channel: '', accountId: 'a', userId: 'u' }] },
    {},
  ]) {
    assert.throws(() => projection.patchControl({ id: 's1', diff }), (error) => error.code === 'bad-request', `diff ${JSON.stringify(diff)} 必须被拒`)
  }
  assert.equal(store.get('route:sessions').s1.control, undefined, '非法写入零落盘')
})

test('E2 projection without the shared service is fail-closed (not-supported)', () => {
  const projection = createSessionsProjection({})
  assert.equal(projection.canDetail, false)
  assert.equal(projection.canControl, false)
  assert.throws(() => projection.detail({ id: 's1' }), (error) => error.code === 'not-supported')
  assert.throws(() => projection.patchControl({ id: 's1', diff: { mode: 'team' } }), (error) => error.code === 'not-supported')
})