import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createStore } from '../src/inbound/store.mjs'
import { createCurrentTaskAuthority, currentTaskKey } from '../src/routing/current-task.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createNativeActions } from '../src/native/actions.mjs'
import { createPrivateChatView } from '../src/native/private-chat-view.mjs'

function stateRig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dn-p0-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  return { dir, path, store: createStore(path) }
}
test('F01: same user on two accounts selects and clears independently, including restart and router', t => {
  const { store, path } = stateRig(t)
  const a = createCurrentTaskAuthority({ store })
  const p = { channel: 'telegram', userId: '42', accountId: 'one' }
  const q = { ...p, accountId: 'two' }
  assert.equal(a.select(p, 'task-a').ok, true); assert.equal(a.select(q, 'task-b').ok, true)
  const b = createCurrentTaskAuthority({ store: createStore(path) })
  const router = createAgentRouter({ store, currentTask: b })
  assert.equal(router.resolveInbound('telegram', '42', 'one').sessionId, 'task-a')
  assert.equal(router.resolveInbound('telegram', '42', 'two').sessionId, 'task-b')
  assert.equal(b.clear(p).ok, true); assert.equal(b.get(q), 'task-b')
})
test('F01: legacy task rows without account ownership remain untouched and unselected', t => {
  const { store } = stateRig(t)
  store.set('bind:telegram:42', 'legacy-task')
  const a = createCurrentTaskAuthority({ store })
  assert.equal(a.get({ channel: 'telegram', userId: '42', accountId: 'default' }), null)
  assert.equal(a.get({ channel: 'telegram', userId: '42' }), null)
  assert.equal(currentTaskKey('telegram', '42'), null)
  assert.equal(store.get('bind:telegram:42'), 'legacy-task')
})
test('F01: Native task selection uses the owner account and is visible after restart', t => {
  const { store, path } = stateRig(t)
  const members = { list: () => [{ key: 'telegram:bot-two:42', channel: 'telegram', userId: '42', accountId: 'bot-two', role: 'owner' }] }
  const tasks = { list: () => [{ taskRef: 'task-two', workspace: 'Workspace' }] }
  const a = createCurrentTaskAuthority({ store })
  const actions = createNativeActions({ currentTask: a, members, tasks })
  assert.deepEqual(actions.selectTask({ taskRef: 'task-two' }), { saved: true })
  const b = createCurrentTaskAuthority({ store: createStore(path) })
  const view = createPrivateChatView({ members, tasks, selectedTaskRef: owner => b.get(owner) })
  assert.equal(view.summary().currentTask.id, 'task-two')
  assert.equal(b.get({ channel: 'telegram', userId: '42' }), null)
  assert.throws(() => actions.selectTask({ taskRef: 'missing' }))
})

test('F06: Native chooses an explicit owner when multiple owners have separate current tasks', t => {
  const { store } = stateRig(t)
  const members = { list: () => [
    { key: 'telegram:bot-one:42', channel: 'telegram', userId: '42', accountId: 'bot-one', role: 'owner', label: 'One' },
    { key: 'telegram:bot-two:42', channel: 'telegram', userId: '42', accountId: 'bot-two', role: 'owner', label: 'Two' },
  ] }
  const tasks = { list: () => [{ taskRef: 'task-a' }, { taskRef: 'task-b' }] }
  const currentTask = createCurrentTaskAuthority({ store })
  const actions = createNativeActions({
    currentTask, members, tasks,
    resolveUserId: (id) => ({ one: 'telegram:bot-one:42', two: 'telegram:bot-two:42' })[id] ?? null,
  })
  assert.throws(() => actions.selectTask({ taskRef: 'task-a' }), /请选择/)
  assert.deepEqual(actions.selectTask({ ownerId: 'two', taskRef: 'task-b' }), { saved: true })
  assert.equal(currentTask.get(members.list()[0]), null)
  assert.equal(currentTask.get(members.list()[1]), 'task-b')
  const view = createPrivateChatView({ members, tasks, selectedTaskRef: owner => currentTask.get(owner) })
  const summary = view.summary()
  assert.equal(summary.verified, true)
  assert.equal(summary.currentTask, undefined, 'ambiguous owner does not project one owner task as global')
  assert.equal(summary.setup.owners.length, 2)
  assert.equal(summary.setup.owners.find(owner => owner.currentTask?.title === 'task-b').displayName, 'Two')
})
test('F02/F11: one replacement is one generation; state observations preserve it and stale results are excluded', () => {
  const manager = createRuntimeChannelManager({ source: createOutboundSource([]) })
  const health = createSurfaceHealth()
  manager.subscribe(event => { if (event.topic === 'runtime') health.markEpoch(event.type, event.generation) })
  manager.replace('telegram', {})
  assert.equal(manager.epochOf('telegram'), 1)
  const first = manager.capture('telegram')
  manager.setState('telegram', 'degraded'); manager.setState('telegram', 'online')
  assert.equal(manager.epochOf('telegram'), 1)
  manager.replace('telegram', {})
  assert.equal(manager.epochOf('telegram'), 2)
  health.recordSend({ accepted: ['telegram'], channelEpochs: { telegram: first.epoch } })
  assert.equal(health.snapshot('telegram').accepted, 0)
  manager.remove('telegram')
  health.recordSend({ accepted: ['telegram'], channelEpochs: { telegram: 2 } })
  assert.equal(health.snapshot('telegram').accepted, 0)
})
test('F07: Node reporter counts nested leaf tests exactly like TAP, excluding suite/file containers', t => {
  const { dir } = stateRig(t)
  const fixture = join(dir, 'nested.mjs')
  writeFileSync(fixture, "import {describe,it} from 'node:test'; describe('outer',()=>{ it('one',()=>{}); describe('inner',()=>{it('two',()=>{}); it('three',()=>{})}) })")
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const counted = execFileSync(process.execPath, ['--test', '--test-reporter=./scripts/test-count-reporter.mjs', fixture], { encoding: 'utf8', env })
  const tap = execFileSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', env })
  assert.equal(Number(/DSH_TEST_COUNT (\d+)/.exec(counted)[1]), 3)
  assert.match(tap, /# tests 3\b/)
})
