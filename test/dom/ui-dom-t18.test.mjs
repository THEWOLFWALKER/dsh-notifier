// T18 real-DOM acceptance tests: save receipt vs refresh, no implicit send,
// list tri-state, and delivery-evidence grading (U01/U02/U03/U04/U08/U09/U12).
//
// Run with:  node test/dom/run.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actAsync, buttonByText, click, createContext, flush, hangingSurfaceWait,
  installDomEnvironment, loadClient, mount, React, textOf, typeInput,
} from './harness.mjs'

const { mod } = loadClient()

test.beforeEach(() => { installDomEnvironment() })

const teardown = []
test.afterEach(() => {
  while (teardown.length > 0) {
    const fn = teardown.pop()
    try { fn() } catch { /* teardown is best-effort */ }
  }
})
function own(controller, view) {
  teardown.push(() => { try { controller?.dispose() } catch {} })
  teardown.push(() => { try { view?.unmount() } catch {} })
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
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

// A channel detail fixture with one editable outbound field already applied.
const CHANNEL_FIXTURE = {
  type: 'webhook',
  notify: {
    configRevision: 1,
    applyMode: 'hot',
    fields: { url: { label: { en: 'URL' } } },
    editableValues: { url: 'https://old.example/hook' },
  },
}

/** Mount ChannelDetailView against a static (already-loaded) snapshot. */
function mountChannelDetail(controller, ctx, fixture) {
  const state = {
    ...controller.getSnapshot(),
    view: { kind: 'channel', type: 'webhook' },
    channel: { channel: fixture },
  }
  return mount(React.createElement(mod.__test.ChannelDetailView, { ctx, controller, state, t: (key) => key }))
}

test('T18/U01 — a save whose follow-up refresh fails is still reported as saved', async () => {
  const calls = []
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'channels.save') return { ok: true, value: { epoch: 'e', revision: 1 } }
      if (endpoint === 'channels.get') return { ok: false, error: { code: 'internal', message: 'read exploded' } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.SetupFlow, {
    ctx, controller, state: controller.getSnapshot(), channels: [WEBHOOK_CHANNEL], t: (key) => key, onDone: () => {},
  }))
  own(controller, view)
  click(buttonByText(view.container, 'Webhook'))
  typeInput(view.container.querySelector('input'), 'https://example.test/hook')

  await actAsync(async () => { click(buttonByText(view.container, 'save')) })
  await flush()

  // The commit stands even though the refresh failed; the failure is never
  // rewritten as "save failed" and the wizard still completes (U01/U12).
  assert.ok(calls.includes('channels.save') && calls.includes('channels.get'), 'the refresh was attempted')
  assert.match(textOf(view.container), /savedOk/, 'the committed receipt is shown')
  assert.equal(view.container.querySelector('[role=alert]'), null, 'a refresh failure is not a save failure')
  assert.ok(buttonByText(view.container, 'complete'), 'the flow can still complete')
})

test('T18/U02 — a slow save disables the action and a second click sends no duplicate', async () => {
  const calls = []
  const gate = deferred()
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'channels.list') {
        return { ok: true, value: { epoch: 'e', revision: 1, channels: [WEBHOOK_CHANNEL] } }
      }
      if (endpoint === 'channels.save') return gate.promise
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channels', setup: true })
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  await flush()

  click(buttonByText(view.container, 'Webhook'))
  typeInput(view.container.querySelector('input'), 'https://example.test/hook')

  click(buttonByText(view.container, 'save'))
  await flush()

  const busy = buttonByText(view.container, 'saving')
  assert.ok(busy, 'the action shows a busy label while the save is in flight')
  assert.equal(busy.disabled, true, 'the action is disabled while busy')
  click(busy)
  await flush()
  assert.equal(calls.filter((c) => c === 'channels.save').length, 1, 'no duplicate business submission')

  await actAsync(async () => { gate.resolve({ ok: true, value: { epoch: 'e', revision: 2 } }) })
  await flush()
  assert.equal(calls.filter((c) => c === 'channels.save').length, 1)
  assert.match(textOf(view.container), /savedOk/, 'the save lands once it settles')
})

test('T18/U03 — an unsaved edit disables the test action and no test is sent', async () => {
  const calls = []
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: CHANNEL_FIXTURE } }
      if (endpoint === 'channels.save') return { ok: true, value: { epoch: 'e', revision: 2 } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mountChannelDetail(controller, ctx, CHANNEL_FIXTURE)
  own(controller, view)
  await flush()

  const test = buttonByText(view.container, 'test')
  assert.ok(test, 'the outbound section renders a test action')
  assert.equal(test.disabled, false, 'a clean (saved) configuration can be tested')

  typeInput(view.container.querySelector('input'), 'https://new.example/hook')
  await flush()
  assert.equal(buttonByText(view.container, 'test').disabled, true, 'an unsaved edit blocks testing (U03)')
  assert.match(textOf(view.container), /unsavedChangesHint/, 'the reason is stated, not silently ignored')
  assert.ok(!calls.includes('channels.test'), 'testing a dirty form never silently saves and sends')

  // Saving clears the dirty state and re-enables the (still optional) test.
  await actAsync(async () => { click(buttonByText(view.container, 'save')) })
  await flush()
  assert.match(textOf(view.container), /savedOk/, 'the save reports its receipt')
  assert.equal(buttonByText(view.container, 'test').disabled, false, 'after save the committed config is testable')
})

test('T18/U04 — a list awaiting its first response shows loading, not "empty"', async () => {
  const gate = deferred()
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.list') return gate.promise
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channels' })
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  await flush()

  const pending = textOf(view.container)
  assert.match(pending, /loading/, 'a pending query renders the loading state')
  assert.doesNotMatch(pending, /noChannels/, 'a pending query is not mistaken for "no channels"')

  await actAsync(async () => { gate.resolve({ ok: true, value: { epoch: 'e', revision: 1, channels: [] } }) })
  await flush()
  assert.match(textOf(view.container), /noChannels/, 'once an empty list arrives it becomes the empty state')
})

test('T18/U08 — an accepted test is reported distinctly from a delivered one', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: CHANNEL_FIXTURE } }
      if (endpoint === 'channels.test') return { ok: true, value: { status: 'accepted', providerDetail: { en: 'HTTP 200' } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mountChannelDetail(controller, ctx, CHANNEL_FIXTURE)
  own(controller, view)
  await flush()

  await actAsync(async () => { click(buttonByText(view.container, 'test')) })
  await flush()
  const text = textOf(view.container)
  assert.match(text, /testAccepted/, 'accepted is reported as accepted')
  assert.doesNotMatch(text, /testDelivered/, 'accepted is never shown as delivered')
  assert.match(text, /testAcceptedDetail/, 'the accepted evidence level is explained')
})

test('T18/U09 — an unconfirmable test is graded "could not confirm", never "failed, retry"', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.save') return { ok: true, value: { epoch: 'e', revision: 1 } }
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: { type: 'webhook' } } }
      if (endpoint === 'channels.test') {
        return { ok: true, value: { status: 'unknown', reasonCode: 'timeout', detail: { en: 'no receipt' } } }
      }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.SetupFlow, {
    ctx, controller, state: controller.getSnapshot(), channels: [WEBHOOK_CHANNEL], t: (key) => key, onDone: () => {},
  }))
  own(controller, view)
  click(buttonByText(view.container, 'Webhook'))
  typeInput(view.container.querySelector('input'), 'https://example.test/hook')
  await actAsync(async () => { click(buttonByText(view.container, 'save')) })
  await flush()
  await actAsync(async () => { click(buttonByText(view.container, 'test')) })
  await flush()

  const text = textOf(view.container)
  assert.match(text, /testUnconfirmed/, 'an unknown outcome is named "could not confirm"')
  assert.match(text, /testReasonTimeout/, 'the concrete reason is surfaced')
  assert.match(text, /unknownNoRetry/, 'the user is told it is not auto-resent')
  assert.doesNotMatch(text, /testFailed/, 'unknown is never framed as a hard failure')
  // The flow is not trapped: it can still complete (U12).
  assert.ok(buttonByText(view.container, 'complete'), 'an unconfirmed test does not trap the user')
})