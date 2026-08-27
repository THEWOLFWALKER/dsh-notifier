import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHostEventRegistrar,
  normalizeAgentLifecyclePayload,
  normalizeSessionEventArgs,
  scopeDiagnosticOf,
} from '../src/host-events.mjs'

test('host events: documented tuple, explicit envelope, and documented agent envelope normalize', () => {
  const session = { id: 's1' }
  const event = { type: 'turn/end', seq: 1 }
  assert.deepEqual(normalizeSessionEventArgs([session, event]), { session, event, shape: 'tuple' })
  assert.deepEqual(normalizeSessionEventArgs([{ session, event }]), { session, event, shape: 'envelope' })
  const agent = { id: 's1', session }
  assert.equal(normalizeAgentLifecyclePayload({ agent }), agent)
})

test('host events: malformed callback payloads are rejected instead of guessed', () => {
  assert.equal(normalizeSessionEventArgs([{ id: 's1' }, { type: 1 }]), undefined)
  assert.equal(normalizeSessionEventArgs([{ session: { id: 's1' }, event: {} }]), undefined)
  assert.equal(normalizeSessionEventArgs([{ session: { id: 's1' } }, { type: 'turn/end' }, 'extra']), undefined)
  assert.equal(normalizeAgentLifecyclePayload({ agent: null }), undefined)
})

test('host events: scoped child registers only host listeners on a feature-detected root context', () => {
  const listeners = {}
  const root = {
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return () => { listeners[event] = listeners[event].filter((entry) => entry !== listener) }
    },
  }
  root.root = root
  const scope = Symbol('dsh.scope')
  const scopedBase = { [scope]: {} }
  const child = Object.create(scopedBase)
  child.root = root
  child.on = () => { throw new Error('must not use scoped child') }
  assert.equal(scopeDiagnosticOf(child), 'tagged')
  const registrar = createHostEventRegistrar(child)
  const received = []
  registrar.on('session/event', (...args) => received.push(args))
  listeners['session/event'][0]({ id: 's1' }, { type: 'turn/end' })
  assert.equal(received.length, 1)
  assert.deepEqual(registrar.snapshot(), {
    context: 'root',
    scope: 'untagged',
    events: { 'session/event': { attempts: 1, registered: 1, failures: 0, received: 1 } },
  })
})

test('host events: a non-Cordis root-shaped service is not used as an event context', () => {
  const local = []
  const ctx = {
    root: { on() { throw new Error('must not use arbitrary service') } },
    on(event, listener) { local.push({ event, listener }); return () => {} },
  }
  const registrar = createHostEventRegistrar(ctx)
  registrar.on('session/event', () => {})
  assert.equal(registrar.snapshot().context, 'current')
  assert.equal(local.length, 1)
})

test('host events: registration errors and zero-event diagnostics stay observable without throwing', () => {
  const lines = []
  const registrar = createHostEventRegistrar({
    on() { throw new Error('host registration fault') },
  }, (line) => lines.push(line))
  assert.equal(registrar.on('agent/created', () => {}), undefined)
  assert.deepEqual(registrar.snapshot().events['agent/created'], { attempts: 1, registered: 0, failures: 1, received: 0 })
  assert.ok(lines.some((line) => /订阅失败.*agent\/created/.test(line)))

  const idleLines = []
  const idle = createHostEventRegistrar({ on: () => () => {} }, (line) => idleLines.push(line))
  idle.on('session/event', () => {})
  idle.reportZeroEvents()
  assert.ok(idleLines.some((line) => /未收到载荷.*session\/event/.test(line)))
})
