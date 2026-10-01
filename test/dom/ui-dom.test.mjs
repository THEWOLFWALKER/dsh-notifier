// Real-React DOM tests for client.js (T03 test bottom). These mount the actual
// client views into a jsdom document with the REAL react/react-dom packages and
// drive them through a fake connection.rpc.call — no network, no fakeReact shim.
//
// Run with:  node test/dom/run.mjs   (see test/dom/run.mjs)

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actAsync, buttonByText, click, createContext, flush, hangingSurfaceWait,
  installDomEnvironment, loadClient, mount, React, textOf, typeInput,
} from './harness.mjs'

// client.js is loaded once; the DSH module factory only requires 'react'.
const { mod } = loadClient()

test.beforeEach(() => {
  // Fresh jsdom document per test so mounted containers never leak across cases.
  installDomEnvironment()
})

// Every test registers its controller + mounted root here so a failing assertion
// can never leak the controller's 30s fallback interval (which would hang the runner).
const teardown = []
test.afterEach(() => {
  while (teardown.length > 0) {
    const fn = teardown.pop()
    try { fn() } catch { /* teardown is best-effort */ }
  }
})

/** Register a controller + mounted view for deterministic teardown. */
function own(controller, view) {
  teardown.push(() => { try { controller?.dispose() } catch {} })
  teardown.push(() => { try { view?.unmount() } catch {} })
}

/** Deferred promise with external resolve/reject. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Route only `surface.wait` to the quiet hanging wait; everything else to the handler. */
function routed(rpcCall) {
  return (channel, endpoint, payload, signal) => {
    const wait = hangingSurfaceWait(channel, endpoint, payload, signal)
    if (wait) return wait
    if (endpoint === 'surface.wait') return { ok: true, value: { revision: 0 } }
    return rpcCall(endpoint, payload)
  }
}

const WEBHOOK_CHANNEL = {
  type: 'webhook',
  label: { en: 'Webhook' },
  notify: { editable: true, fields: { url: { label: { en: 'URL' } } } },
}

test('channel setup/save flow mounts, saves, and completes with no test sent', async () => {
  const calls = []
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'channels.save') return { ok: true, value: { epoch: 'e', revision: 1 } }
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: { type: 'webhook' } } }
      if (endpoint === 'channels.test') return { ok: true, value: { status: 'accepted' } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.SetupFlow, {
    ctx, controller, state: controller.getSnapshot(), channels: [WEBHOOK_CHANNEL], t: (key) => key, onDone: () => {},
  }))
  own(controller, view)

  // 1) picker renders the candidate channel as a real button.
  const picker = buttonByText(view.container, 'Webhook')
  assert.ok(picker, 'setup picker renders the channel candidate')
  click(picker)

  // 2) choosing a channel renders its schema field as a real <input>.
  const input = view.container.querySelector('input')
  assert.ok(input, 'setup form renders the channel field')
  assert.equal(input.getAttribute('type'), 'text')

  // 3) fill the draft, then save. T18/U03: the form action is a plain save — it
  // never silently sends a test message.
  typeInput(input, 'https://example.test/hook')
  const save = buttonByText(view.container, 'save')
  assert.ok(save, 'the form exposes a save action (no implicit save+send)')
  assert.equal(save.disabled, false, 'save enables once the draft is non-empty')
  await actAsync(async () => { click(save) })
  await flush()

  // U01/U12: save commits and refreshes; nothing is tested yet and the flow is
  // already completable (no account/network needed to finish the wizard).
  assert.deepEqual([...new Set(calls)], ['channels.save', 'channels.get'])
  assert.ok(!calls.includes('channels.test'), 'no test is sent implicitly (U03)')
  assert.match(textOf(view.container), /savedOk/, 'the committed receipt is reported')
  assert.ok(buttonByText(view.container, 'complete'), 'the flow can complete right after save (U12)')

  // 4) the optional test targets the saved configuration and grades its evidence.
  await actAsync(async () => { click(buttonByText(view.container, 'test')) })
  await flush()
  assert.ok(calls.includes('channels.test'), 'the explicit test reaches the provider')
  assert.match(textOf(view.container), /testAccepted/, 'accepted delivery is reported in the DOM')
})

test('U05 — a controlled input keeps its DOM node and focus across a state update', async () => {
  const { ctx } = createContext({ rpcCall: routed(() => ({ ok: true, value: { epoch: 'e', revision: 1 } })) })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.SetupFlow, {
    ctx, controller, channels: [WEBHOOK_CHANNEL], t: (key) => key, onDone: () => {},
  }))
  own(controller, view)
  click(buttonByText(view.container, 'Webhook'))

  const input = view.container.querySelector('input')
  input.focus()
  assert.equal(globalThis.document.activeElement, input, 'the input is focused')

  // A keystroke triggers a parent state update (setDraft). With real React the
  // element type/position is stable, so the SAME DOM node is updated in place —
  // no remount, focus and caret are preserved.
  typeInput(input, 'abc')
  await flush()
  assert.equal(view.container.querySelector('input'), input, 'input node is not remounted')
  assert.equal(globalThis.document.activeElement, input, 'focus survives the state update')
  assert.equal(input.value, 'abc')

  typeInput(input, 'abcd')
  await flush()
  assert.equal(view.container.querySelector('input'), input, 'input node still stable after a second update')
  assert.equal(globalThis.document.activeElement, input, 'focus still held')
  assert.equal(input.value, 'abcd')
})

test('U02 — a busy action disables and a second click produces no second RPC', async () => {
  const calls = []
  const gate = deferred()
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'members.list') {
        return {
          ok: true,
          value: {
            epoch: 'e', revision: 1, canUpdate: true, canRemove: true,
            members: [{ key: 'telegram:1', channel: 'telegram', userId: '1', role: 'member', label: 'Alice' }],
          },
        }
      }
      if (endpoint === 'members.update') return gate.promise
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'members' })
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  await flush()

  const promote = buttonByText(view.container, 'promote')
  assert.ok(promote, 'member row renders its promote control')
  assert.equal(promote.disabled, false)

  click(promote)
  await flush()
  assert.equal(promote.disabled, true, 'the control becomes busy (disabled) while the RPC is in flight')
  assert.equal(calls.filter((c) => c === 'members.update').length, 1)

  // Second click on the now-disabled button must not dispatch another mutation.
  click(promote)
  await flush()
  assert.equal(calls.filter((c) => c === 'members.update').length, 1, 'no duplicate business RPC')

  // Release the in-flight mutation; the button re-enables and the list refreshes once.
  await actAsync(async () => { gate.resolve({ ok: true, value: { epoch: 'e', revision: 2 } }) })
  await flush()
  assert.equal(promote.disabled, false, 'busy clears when the RPC settles')
  assert.equal(calls.filter((c) => c === 'members.update').length, 1)
  assert.equal(calls.filter((c) => c === 'members.list').length, 2, 'the list is refreshed exactly once after the write')
})

test('U01 — a mutation that succeeds is not reported as failed when the follow-up query fails', async () => {
  const calls = []
  let listCount = 0
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'members.list') {
        listCount += 1
        if (listCount === 1) {
          return {
            ok: true,
            value: {
              epoch: 'e', revision: 3, canUpdate: true, canRemove: true,
              members: [{ key: 'telegram:9', channel: 'telegram', userId: '9', role: 'member' }],
            },
          }
        }
        // The follow-up refresh fails; the committed mutation must still stand.
        return { ok: false, error: { code: 'internal', message: 'list exploded' } }
      }
      if (endpoint === 'members.update') return { ok: true, value: { epoch: 'e', revision: 4 } }
      return { ok: true, value: { epoch: 'e', revision: 3 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'members' })
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  await flush()

  let result
  await actAsync(async () => {
    result = await controller.updateMember('telegram:9', { role: 'owner' })
  })
  await flush()

  assert.deepEqual(result, { epoch: 'e', revision: 4 }, 'the committed write result is returned')
  // `busy` is clear when it is no longer `true` (the controller writes `false`).
  assert.notEqual(controller.getSnapshot().busy['member:telegram:9'], true, 'busy is cleared after settle')
  assert.equal(view.container.querySelector('[role=alert]'), null, 'a refresh failure is not surfaced as a commit failure')
  assert.ok(calls.includes('members.update') && listCount >= 2, 'the follow-up refresh was actually attempted')
})

test('U04 — a failed list query does not fabricate a "no data" empty state', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.list') return { ok: false, error: { code: 'internal', message: 'boom' } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channels' })
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  await flush()

  const text = textOf(view.container)
  assert.match(text, /channels/, 'the list view still mounts')
  assert.doesNotMatch(text, /noChannels/, 'a failed query must not render the "no channels" empty state')
  assert.doesNotMatch(text, /noChannelsHint/)
  assert.doesNotMatch(text, /暂无/)
  assert.equal(controller.getSnapshot().error?.code, 'internal', 'the failure is observable on the controller')
})

test('U01/U02 — a delayed, failing save surfaces an error in the DOM and keeps the draft', async () => {
  const gate = deferred()
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.save') return gate.promise
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.SetupFlow, {
    ctx, controller, state: controller.getSnapshot(), channels: [WEBHOOK_CHANNEL], t: (key) => key, onDone: () => {},
  }))
  own(controller, view)
  click(buttonByText(view.container, 'Webhook'))
  const input = view.container.querySelector('input')
  typeInput(input, 'https://example.test/hook')

  click(buttonByText(view.container, 'save'))
  await flush()
  // The RPC is still in flight (controllable delay): nothing has failed yet.
  assert.equal(view.container.querySelector('[role=alert]'), null, 'no premature error while the save is pending')

  await actAsync(async () => {
    gate.resolve({ ok: false, error: { code: 'storage-failed', message: 'disk is on fire' } })
  })
  await flush()

  const alert = view.container.querySelector('[role=alert]')
  assert.ok(alert, 'a failed commit is reported to the user')
  assert.match(alert.textContent, /disk is on fire/)
  assert.equal(view.container.querySelector('input').value, 'https://example.test/hook', 'the draft is preserved after failure')
})