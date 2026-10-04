// Real-React DOM tests for the Native v2 shell (Stage 1 / S2).
//
// These mount the ACTUAL MainPanel through the real client module and drive the
// single "Notify & Private chat" page: channel rail / medium strip / mobile
// selector, the add-channel picker, the "More" menu, and the responsive CSS
// contract (360/390/520/680/880).
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

// Two configured channels in the rail (telegram / qq) plus one never-set channel
// (bark) that must only appear in the add-channel picker.
const CHANNELS = [
  { id: 'telegram', name: 'Telegram', usage: 'Instant alerts on your phone', brand: 'telegram', group: 'common', state: 'ready', stateText: 'Ready', notifyEnabled: true, privateChatEnabled: false },
  { id: 'qq', name: 'QQ', usage: 'Alerts inside QQ', brand: 'qq', group: 'common', state: 'ready', stateText: 'Ready', notifyEnabled: false, privateChatEnabled: false },
  { id: 'bark', name: 'Bark', usage: 'Push to your iPhone', brand: 'bark', group: 'other', state: 'not-set', stateText: 'Not set up', notifyEnabled: false, privateChatEnabled: false },
]

function snapshotValue(setup = null) {
  return {
    epoch: 'e', revision: 1, cursor: 'tok.1',
    rail: CHANNELS.filter((row) => row.state !== 'not-set'),
    channels: CHANNELS,
    privateChat: { enabled: false, users: [] },
    pending: [],
    storage: { canSave: true, text: 'Changes are saved' },
    setup,
    truncated: { rail: false, channels: false, pending: false },
  }
}

test('S2 shell — a fresh-state migration shows concrete reconfiguration steps', async () => {
  const { ctx } = shellContext({
    'native.snapshot': { ok: true, value: snapshotValue({ reconfigurationRequired: true, legacyBackupAvailable: true }) },
  })
  const { view } = mountShell(ctx)
  await flush()
  assert.match(view.container.textContent, /reconfigureStateTitle/)
  assert.match(view.container.textContent, /reconfigureStateSteps/)
  assert.ok(buttonByText(view.container, 'pickerTitle'), 'the notice offers an add-channel action')
})

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

/** Mount the real MainPanel (the router decides which view renders). */
function mountShell(ctx) {
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  return { controller, view }
}

function shellContext(handlers = {}) {
  return createContext({
    rpcCall: routed((endpoint, payload) => {
      const handler = handlers[endpoint]
      if (typeof handler === 'function') return handler(payload)
      if (handler !== undefined) return handler
      if (endpoint === 'native.snapshot') return { ok: true, value: snapshotValue() }
      return OK
    }),
  })
}

test('S2 shell — the default view is the single "Notify & Private chat" page', async () => {
  const { ctx } = shellContext()
  const { controller, view } = mountShell(ctx)
  await flush()

  assert.equal(controller.getSnapshot().view.kind, 'native', 'the default view is the single page')
  assert.match(textOf(view.container), /nativeTitle/, 'the product title renders')
  assert.ok(view.container.querySelector('.dn-settings'), 'the shell container renders')
})

test('S2 shell — rail, medium strip and mobile selector all render (no daily/manage pill groups)', async () => {
  const { ctx } = shellContext()
  const { view } = mountShell(ctx)
  await flush()

  assert.ok(view.container.querySelector('nav.dn-rail'), 'the desktop rail renders')
  assert.ok(view.container.querySelector('nav.dn-strip'), 'the medium horizontal strip renders')
  assert.ok(view.container.querySelector('.dn-channelSelect'), 'the mobile channel selector renders')
  assert.equal(view.container.querySelector('[aria-label="navDaily"]'), null, 'the old daily pill group is gone')
  assert.equal(view.container.querySelector('[aria-label="navManage"]'), null, 'the old management pill group is gone')

  // The rail is real logos + names, never dot glyphs.
  const railLogos = view.container.querySelectorAll('nav.dn-rail svg.dn-logo')
  assert.ok(railLogos.length >= 2, 'the rail uses real channel logos')
})

test('S2 shell — selecting a channel marks it current and opens its channel page', async () => {
  const { ctx, calls } = shellContext({
    'native.channel': (payload) => ({ ok: true, value: channelDetail(payload.type) }),
  })
  const { controller, view } = mountShell(ctx)
  await flush()

  const rail = view.container.querySelector('nav.dn-rail')
  const target = [...rail.querySelectorAll('button')].find((button) => button.getAttribute('data-nav') === 'telegram')
  assert.ok(target, 'the configured channel is listed in the rail')

  await actAsync(async () => { click(target) })
  await flush()

  assert.ok(calls.some((call) => call.endpoint === 'native.channel'), 'selecting a channel loads its detail')
  assert.equal(controller.getSnapshot().view.kind, 'native-channel', 'the view becomes the channel page')
  assert.ok(view.container.querySelector('nav.dn-rail [aria-current="page"]'), 'the selected channel is marked current')
  assert.match(textOf(view.container), /Ready/, 'the channel page shows its state in words')
})

test('S2 shell — the add-channel picker is a modal dialog grouped by common/other', async () => {
  const { ctx, calls } = shellContext()
  const { controller, view } = mountShell(ctx)
  await flush()

  const add = buttonByText(view.container, 'railAdd')
  assert.ok(add, 'the header exposes the add-channel action')
  await actAsync(async () => { click(add) })
  await flush()

  const dialog = view.container.querySelector('[role="dialog"][aria-modal="true"]')
  assert.ok(dialog, 'the picker is a modal dialog')
  assert.match(textOf(dialog), /pickerCommon/, 'channels are grouped under "common"')
  assert.match(textOf(dialog), /pickerOther/, 'the remaining channels are grouped under "other"')

  // Picking a never-set channel navigates straight into its channel page.
  const bark = [...dialog.querySelectorAll('button')].find((button) => button.getAttribute('data-channel') === 'bark')
  assert.ok(bark, 'a never-set channel is offered in the picker')
  await actAsync(async () => { click(bark) })
  await flush()
  assert.equal(controller.getSnapshot().view.kind, 'native-channel')
  assert.ok(calls.some((call) => call.endpoint === 'native.channel' && call.payload.type === 'bark'), 'the picked channel is loaded')
})

test('S2 shell — the "More" menu is labelled and holds the secondary settings', async () => {
  const { ctx } = shellContext()
  const { view } = mountShell(ctx)
  await flush()

  const trigger = [...view.container.querySelectorAll('button')].find((button) => button.getAttribute('aria-haspopup') === 'menu')
  assert.ok(trigger, 'the more-menu trigger is labelled for assistive tech')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'the menu starts collapsed')

  await actAsync(async () => { click(trigger) })
  await flush()
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'opening updates aria-expanded')
  const menu = view.container.querySelector('[role="menu"]')
  assert.ok(menu, 'the menu is a labelled menu')
  const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  assert.ok(
    items.includes('moreNotify') && items.includes('moreRemote') && items.includes('moreImport') && items.includes('moreHelp'),
    'the four secondary settings live in the more menu',
  )
})

test('S2 responsive contract — CSS defines desktop rail / medium strip / mobile selector', () => {
  const { ctx } = createContext({ rpcCall: routed(() => OK) })
  const effects = []
  ctx.effect = (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d); return d }
  ctx.slots = { inject(_name, fn) { return fn() }, register() { return () => {} } }
  ctx.layout = { selectPanel() {} }
  ctx.locale.register = () => () => {}
  try {
    mod.apply(ctx)
    const style = globalThis.document.head.querySelector('style[data-plugin="dsh-notifier"]')
    assert.ok(style, 'the shell stylesheet is injected')
    const css = style.textContent

    assert.ok(css.includes('.dn-rail{flex:0 0 176px'), 'desktop rail is a ~176px column')
    assert.ok(css.includes('.dn-strip{display:none;'), 'the medium strip is hidden by default')
    assert.ok(css.includes('.dn-channelSelect{display:none;'), 'the mobile selector is hidden by default')
    assert.ok(css.includes('@media(max-width:879px){.dn-rail{display:none}'), 'at <=879px the rail is replaced')
    assert.ok(css.includes('.dn-strip{display:flex}'), 'the horizontal strip takes over at medium width')
    assert.ok(css.includes('@media(max-width:679px){.dn-strip{display:none}.dn-channelSelect{display:block}}'), 'at <=679px the selector takes over')
    assert.ok(css.includes('.dn-content{flex:1 1 auto;min-width:0}'), 'content may shrink — no forced horizontal overflow')
    assert.ok(css.includes('@media(max-width:519px)'), 'the narrow-phone stage exists')
    assert.ok(css.includes('@media(max-width:389px)'), 'the small-phone stage exists')
  } finally {
    for (const dispose of effects.reverse()) { try { dispose() } catch { /* best-effort */ } }
  }
})
