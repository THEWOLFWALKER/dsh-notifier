// Real-React DOM tests for the Native v2 "More" consolidation (Stage 1 / S5).
//
// These mount the ACTUAL MainPanel through the real client module and drive the
// secondary settings that S5 folded into the "More" menu:
//   - the menu itself is exactly four items (notification settings / remote /
//     import old settings / help) and nothing else,
//   - the notification overview lists notify-capable channels, reuses the narrow
//     native.testChannel action for "test", and opens a channel page for setup,
//   - help is user-facing (symptom -> what to do) and never leaks internal
//     diagnostics; the support report is pulled on demand via diagnostics.snapshot.
//
// Run with:  node test/dom/run.mjs   (see test/dom/run.mjs)

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actAsync, buttonByText, click, createContext, flush, hangingSurfaceWait,
  installDomEnvironment, loadClient, mount, React, textOf,
} from './harness.mjs'

const { mod } = loadClient()

test.beforeEach(() => {
  installDomEnvironment()
})

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

/** Route surface.wait to the quiet hanging wait; everything else to the handler. */
function routed(rpcCall) {
  return (channel, endpoint, payload, signal) => {
    const wait = hangingSurfaceWait(channel, endpoint, payload, signal)
    if (wait) return wait
    return rpcCall(endpoint, payload)
  }
}

const OK = { ok: true, value: { epoch: 'e', revision: 1 } }

// telegram can notify (ready) -> belongs in the overview; bark cannot -> excluded.
const CHANNELS = [
  { id: 'telegram', name: 'Telegram', usage: 'Instant alerts on your phone', brand: 'telegram', group: 'common', state: 'ready', stateText: 'Ready', notifyEnabled: true, canNotify: true, privateChatEnabled: false },
  { id: 'bark', name: 'Bark', usage: 'Push to your iPhone', brand: 'bark', group: 'other', state: 'not-set', stateText: 'Not set up', notifyEnabled: false, canNotify: false, privateChatEnabled: false },
]

function snapshotValue() {
  return {
    epoch: 'e', revision: 1, cursor: 'tok.1',
    rail: CHANNELS.filter((row) => row.state !== 'not-set'),
    channels: CHANNELS,
    privateChat: { enabled: false, users: [] },
    pending: [],
    storage: { canSave: true, text: 'Changes are saved' },
    truncated: { rail: false, channels: false, pending: false },
  }
}

function channelDetail(type) {
  const row = CHANNELS.find((candidate) => candidate.id === type)
  return {
    channel: row,
    accounts: [{
      id: `${type}:default`, accountId: 'default', displayName: row.name,
      state: row.state, stateText: row.stateText,
      notify: { enabled: row.notifyEnabled, canTest: row.notifyEnabled, values: {} },
      setupFields: [], moreAvailable: false,
    }],
  }
}

function shellContext(handlers = {}) {
  return createContext({
    rpcCall: routed((endpoint, payload) => {
      const handler = handlers[endpoint]
      if (typeof handler === 'function') return handler(payload)
      if (handler !== undefined) return handler
      if (endpoint === 'native.snapshot') return { ok: true, value: snapshotValue() }
      if (endpoint === 'native.channel') return { ok: true, value: channelDetail(payload.type) }
      return OK
    }),
  })
}

function mountShell(ctx) {
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  return { controller, view }
}

async function openMore(container) {
  const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-haspopup') === 'menu')
  assert.ok(trigger, 'the more-menu trigger exists')
  await actAsync(async () => { click(trigger) })
  await flush()
  const menu = container.querySelector('[role="menu"]')
  assert.ok(menu, 'the menu is open')
  return menu
}

test('S5 more — the menu is exactly the four consolidated secondary settings', async () => {
  const { ctx } = shellContext()
  const { view } = mountShell(ctx)
  await flush()

  const menu = await openMore(view.container)
  const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  assert.deepEqual(items, ['moreNotify', 'moreRemote', 'moreImport', 'moreHelp'],
    'the menu holds notification settings / remote / import old settings / help — in that order')
})

test('S5 notify — the overview lists notify-capable channels and reuses the narrow test action', async () => {
  const { ctx, calls } = shellContext({
    'native.testChannel': () => ({ ok: true, value: { kind: 'sent', title: 'sentTitle', message: 'sentMessage' } }),
  })
  const { controller, view } = mountShell(ctx)
  await flush()

  const menu = await openMore(view.container)
  await actAsync(async () => { click([...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'moreNotify')) })
  await flush()

  assert.equal(controller.getSnapshot().view.kind, 'notify-settings', 'the menu opens the notification overview')
  assert.match(textOf(view.container), /notifySettingsTitle/)
  assert.match(textOf(view.container), /Telegram/, 'a notify-capable channel is listed')
  assert.doesNotMatch(textOf(view.container), /Bark/, 'a channel that cannot notify is not listed')

  // "Test" goes through the one existing business authority, never a bespoke write.
  const testButton = buttonByText(view.container, 'test')
  assert.ok(testButton, 'a ready channel offers a test action')
  await actAsync(async () => { click(testButton) })
  await flush()

  const testCall = calls.find((call) => call.endpoint === 'native.testChannel')
  assert.ok(testCall, 'the test uses the narrow native.testChannel action')
  assert.equal(testCall.payload.type, 'telegram', 'the tested channel is sent verbatim')
  assert.match(textOf(view.container), /sentMessage/, 'the receipt is shown in the row')

  // "Open settings" routes into the existing channel page instead of duplicating it.
  await actAsync(async () => { click(buttonByText(view.container, 'notifySettingsOpen')) })
  await flush()
  assert.equal(controller.getSnapshot().view.kind, 'native-channel', 'opening settings goes to the channel page')
  assert.equal(controller.getSnapshot().view.type, 'telegram')
})

test('S5 notify — with no notify-capable channel the overview states the next step', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'native.snapshot') {
        return { ok: true, value: { ...snapshotValue(), channels: CHANNELS.map((row) => ({ ...row, canNotify: false })) } }
      }
      return OK
    }),
  })
  const { controller, view } = mountShell(ctx)
  await flush()

  const menu = await openMore(view.container)
  await actAsync(async () => { click([...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'moreNotify')) })
  await flush()

  assert.equal(controller.getSnapshot().view.kind, 'notify-settings')
  assert.match(textOf(view.container), /notifySettingsEmpty/, 'an empty overview tells the user to add a channel first')
})

test('S5 help — the page is user-facing (symptom -> what to do) and pulls the report on demand', async () => {
  // Stub the clipboard so the report is "copied" instead of triggering a download
  // (jsdom cannot navigate a download anchor and logs a not-implemented error).
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async () => {} }, configurable: true,
  })
  const { ctx, calls } = shellContext({
    'diagnostics.snapshot': () => ({ ok: true, value: { epoch: 'e', revision: 1, version: '0.13.1', generatedAt: '2026-09-27T00:00:00.000Z', attention: { required: false, reasons: [] } } }),
  })
  const { controller, view } = mountShell(ctx)
  await flush()

  const menu = await openMore(view.container)
  await actAsync(async () => { click([...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'moreHelp')) })
  await flush()

  assert.equal(controller.getSnapshot().view.kind, 'help', 'the menu opens help')
  const text = textOf(view.container)
  assert.match(text, /helpTipPhone/)
  assert.match(text, /helpTipConnect/)
  assert.match(text, /helpTipReply/)
  assert.match(text, /helpTipRestart/)
  // The user never reads internal diagnostics vocabulary.
  assert.doesNotMatch(text, /pluginVersion|hostVersion|storageState|evidenceLevel|processId/)

  assert.equal(calls.some((call) => call.endpoint === 'diagnostics.snapshot'), false,
    'help renders no snapshot by itself')
  await actAsync(async () => { click(buttonByText(view.container, 'generateReport')) })
  await flush()
  assert.equal(calls.filter((call) => call.endpoint === 'diagnostics.snapshot').length, 1,
    'the report is pulled exactly once, on demand')
})

test('S5 secondary views — every More entry returns to the notify shell, never the legacy channels page', async () => {
  const { ctx } = shellContext()
  const { controller, view } = mountShell(ctx)
  await flush()

  for (const [label, kind] of [['moreRemote', 'remote'], ['moreImport', 'portability']]) {
    const menu = await openMore(view.container)
    await actAsync(async () => { click([...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label)) })
    await flush()
    assert.equal(controller.getSnapshot().view.kind, kind, `${label} opens ${kind}`)

    // "Back" must return to the single notify shell — the legacy channels page is
    // no longer part of the user IA, so landing there would strand the user.
    const back = [...view.container.querySelectorAll('button')].find((button) => button.textContent.includes('back'))
    assert.ok(back, `${label} offers a back control`)
    await actAsync(async () => { click(back) })
    await flush()
    assert.equal(controller.getSnapshot().view.kind, 'native', `${label} returns to the notify shell`)
  }
})