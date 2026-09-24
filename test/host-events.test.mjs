import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHostEventRegistrar,
  normalizeAgentLifecyclePayload,
  normalizeSessionEventArgs,
  scopeDiagnosticOf,
  selectHostEventContext,
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

test('host events: the current ctx is the primary target and root is left untouched', () => {
  const rootCalls = []
  const root = {
    on(event, listener, options) { rootCalls.push({ event, options }); return () => {} },
  }
  root.root = root
  const currentCalls = []
  const ctx = {
    root,
    on(event, listener, options) { currentCalls.push({ event, options }); return () => {} },
  }
  const registrar = createHostEventRegistrar(ctx)
  registrar.on('session/event', () => {})
  assert.equal(rootCalls.length, 0, 'root must not be subscribed while current works')
  assert.equal(currentCalls.length, 1)
  assert.deepEqual(currentCalls[0].options, { global: true })
  assert.equal(registrar.snapshot().context, 'current')
})

test('host events: a failing current ctx falls back to root once and stays there', () => {
  const rootCalls = []
  const root = {
    on(event, listener, options) { rootCalls.push({ event, options }); return () => {} },
  }
  root.root = root
  let currentCalls = 0
  const ctx = {
    root,
    on() { currentCalls += 1; throw new Error('scoped registration fault') },
  }
  const lines = []
  const registrar = createHostEventRegistrar(ctx, (line) => lines.push(line))
  const first = registrar.on('session/event', () => {})
  const second = registrar.on('agent/error', () => {})
  assert.equal(typeof first, 'function')
  assert.equal(typeof second, 'function')
  assert.equal(currentCalls, 1, 'current is only attempted before the sticky fallback')
  assert.equal(rootCalls.length, 2, 'every later event registers on root')
  for (const entry of rootCalls) assert.deepEqual(entry.options, { global: true })
  const snapshot = registrar.snapshot()
  assert.equal(snapshot.context, 'root')
  assert.equal(snapshot.events['session/event'].attempts, 1)
  assert.equal(snapshot.events['session/event'].registered, 1)
  assert.equal(snapshot.events['session/event'].failures, 1)
  assert.ok(lines.some((line) => /订阅失败.*session\/event/.test(line)))
})

test('host events: a tagged scoped child registers host listeners through the root fallback', () => {
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
  child.on = () => { throw new Error('must not use scoped child registration') }
  assert.equal(scopeDiagnosticOf(child), 'tagged')
  const registrar = createHostEventRegistrar(child)
  const received = []
  registrar.on('session/event', (...args) => received.push(args))
  listeners['session/event'][0]({ id: 's1' }, { type: 'turn/end' })
  assert.equal(received.length, 1)
  const snapshot = registrar.snapshot()
  assert.equal(snapshot.context, 'root')
  assert.equal(snapshot.scope, 'untagged')
  const row = snapshot.events['session/event']
  assert.equal(row.attempts, 1)
  assert.equal(row.registered, 1)
  assert.equal(row.failures, 1, 'the failed current attempt stays observable')
  assert.equal(row.received, 1)
  assert.equal(typeof row.lastAt, 'number')
})

test('host events: a ctx without ctx.on uses the documented root context', () => {
  const rootCalls = []
  const root = {
    on(event, listener, options) { rootCalls.push({ event, options }); return () => {} },
  }
  root.root = root
  const registrar = createHostEventRegistrar({ root })
  registrar.on('session/event', () => {})
  assert.equal(rootCalls.length, 1)
  assert.deepEqual(rootCalls[0].options, { global: true })
  assert.equal(registrar.snapshot().context, 'root')
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

test('host events: a ctx with neither ctx.on nor a root ctx fails closed', () => {
  const lines = []
  const registrar = createHostEventRegistrar({}, (line) => lines.push(line))
  assert.equal(registrar.on('session/event', () => {}), undefined)
  assert.deepEqual(registrar.snapshot().events['session/event'], { attempts: 1, registered: 0, failures: 1, received: 0 })
  assert.ok(lines.some((line) => /无 ctx\.on/.test(line)))
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

test('host events: a throwing listener is contained to a warning', () => {
  const listeners = {}
  const ctx = {
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return () => {}
    },
  }
  const lines = []
  const registrar = createHostEventRegistrar(ctx, (line) => lines.push(line))
  registrar.on('session/event', () => { throw new Error('listener fault') })
  assert.doesNotThrow(() => listeners['session/event'][0]({ id: 's1' }, { type: 'turn/end' }))
  assert.equal(registrar.snapshot().events['session/event'].received, 1)
  assert.ok(lines.some((line) => /事件处理失败.*session\/event/.test(line)))
})

test('host events: the disposer is passed through only when it is a function', () => {
  const disposer = () => {}
  const registrar = createHostEventRegistrar({ on: () => disposer })
  assert.equal(registrar.on('session/event', () => {}), disposer)

  const noDisposer = createHostEventRegistrar({ on: () => undefined })
  assert.equal(noDisposer.on('session/event', () => {}), undefined)
})

test('host events: every host subscription opts into `global` so a scope carrier cannot drop it', () => {
  // DSH dispatches `session/event` through dsh-scope's `scopeTarget`, which admits
  // an untagged listener globally but a TAGGED one only for the dispatch key or its
  // ancestors. Without `global: true` a session whose owner scope is unrelated to
  // this plugin's ctx silently loses its events (upstream issue #16).
  const seen = []
  const ctx = {
    on(event, listener, options) {
      seen.push({ event, options })
      return () => {}
    },
  }
  const registrar = createHostEventRegistrar(ctx)
  registrar.on('session/event', () => {})
  registrar.on('agent/error', () => {})
  assert.equal(seen.length, 2)
  for (const entry of seen) {
    assert.deepEqual(entry.options, { global: true }, `${entry.event} must subscribe globally`)
  }
})

test('host events: selectHostEventContext describes current first, then root, else current', () => {
  const root = { on() {} }
  root.root = root
  assert.equal(selectHostEventContext({ root, on() {} }).source, 'current')
  assert.equal(selectHostEventContext({ root }).source, 'root')
  assert.equal(selectHostEventContext({}).source, 'current')
})