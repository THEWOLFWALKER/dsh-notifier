// Real-React DOM tests for the Native v2 channel detail + account cards (Stage 1 / S3).
//
// These mount the ACTUAL MainPanel through the real client module and drive the
// account card: collapsed by default, the basic / private-chat / more split, the
// secret tri-state (keep / replace / clear), the plain-language test receipt, and
// the Telegram fallback that only appears when it is actually needed.
//
// Run with:  node test/dom/run.mjs   (see test/dom/run.mjs)

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actAsync, buttonByText, click, createContext, flush, hangingSurfaceWait,
  installDomEnvironment, loadClient, mount, React, textOf, typeInput,
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

const RAIL = [
  { id: 'telegram', name: 'Telegram', usage: 'Instant alerts on your phone', brand: 'telegram', group: 'common', state: 'ready', stateText: 'Ready', notifyEnabled: true, privateChatEnabled: true },
  { id: 'qq', name: 'QQ', usage: 'Alerts inside QQ', brand: 'qq', group: 'common', state: 'ready', stateText: 'Ready', notifyEnabled: true, privateChatEnabled: false },
]

function snapshotValue() {
  return {
    epoch: 'e', revision: 1, cursor: 'tok.1',
    rail: RAIL,
    channels: RAIL,
    privateChat: { enabled: true, users: [] },
    pending: [],
    storage: { canSave: true, text: 'Changes are saved' },
    truncated: { rail: false, channels: false, pending: false },
  }
}

// Field shapes are exactly what channel-view.mjs projects: presence only, never a value.
const SECRET_FIELD = { key: 'botToken', label: 'Bot Token', required: true, secret: true, present: true, type: 'string' }
const CHAT_FIELD = { key: 'chatId', label: 'Chat ID', required: true, secret: false, present: true, type: 'string' }
const GATEWAY_FIELD = { key: 'apiBase', label: 'Gateway address', required: false, secret: false, present: false, type: 'string' }
const GATEWAY_KEY_FIELD = { key: 'gatewayKey', label: 'Gateway key', required: false, secret: true, present: false, type: 'string' }
const ALLOW_FIELD = { key: 'allowlist', label: 'Allowed users', required: false, secret: false, present: false, type: 'list' }

function telegramAccount(overrides = {}) {
  return {
    id: 'telegram:default', accountId: 'default', displayName: 'Telegram',
    maskedIdentity: '12•••89', state: 'ready', stateText: 'Ready',
    notify: { enabled: true, canTest: true, values: { chatId: '12345' } },
    privateChat: { enabled: true, canTest: true, users: 2, fields: [ALLOW_FIELD], values: {} },
    setupFields: [SECRET_FIELD, CHAT_FIELD, GATEWAY_FIELD, GATEWAY_KEY_FIELD],
    basicFields: [SECRET_FIELD, CHAT_FIELD],
    moreFields: [GATEWAY_FIELD, GATEWAY_KEY_FIELD],
    moreAvailable: true,
    ...overrides,
  }
}

function qqAccount() {
  return {
    id: 'qq:default', accountId: 'default', displayName: 'QQ',
    state: 'ready', stateText: 'Ready',
    notify: { enabled: true, canTest: true, values: {} },
    setupFields: [CHAT_FIELD],
    basicFields: [CHAT_FIELD],
    moreFields: [],
    moreAvailable: false,
  }
}

function channelDetail(type, accountOverrides = {}) {
  const row = RAIL.find((candidate) => candidate.id === type)
  const accounts = type === 'telegram'
    ? [telegramAccount(accountOverrides)]
    : [qqAccount()]
  return { channel: row, accounts }
}

/** Mount the real MainPanel (the router decides which view renders). */
function mountShell(ctx) {
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.MainPanel, { controller, ctx }))
  own(controller, view)
  return { controller, view }
}

function shellContext({ handlers = {}, accountOverrides = {} } = {}) {
  return createContext({
    rpcCall: routed((endpoint, payload) => {
      const handler = handlers[endpoint]
      if (typeof handler === 'function') return handler(payload)
      if (handler !== undefined) return handler
      if (endpoint === 'native.snapshot') return { ok: true, value: snapshotValue() }
      if (endpoint === 'native.channel') return { ok: true, value: channelDetail(payload.type, accountOverrides) }
      if (endpoint === 'native.saveChannel' || endpoint === 'native.saveInboundChannel') {
        return { ok: true, value: { saved: true, needsRestart: false } }
      }
      return OK
    }),
  })
}

/** Open a channel page by clicking its rail entry. */
async function openChannel(view, type) {
  const rail = view.container.querySelector('nav.dn-rail')
  const target = [...rail.querySelectorAll('button')].find((button) => button.getAttribute('data-nav') === type)
  assert.ok(target, `channel ${type} is listed in the rail`)
  await actAsync(async () => { click(target) })
  await flush()
}

/** The account card's expand/collapse toggle. */
function accountToggle(container) {
  return container.querySelector('.dn-accountToggle')
}

/** Find a <section> by its title key (the harness locale makes t(key) === key). */
function sectionByTitle(container, title) {
  return [...container.querySelectorAll('section.dn-section')]
    .find((section) => section.querySelector('.dn-sectionTitle')?.textContent === title)
}

/** The save button inside a given section. */
function saveIn(section) {
  return buttonByText(section, 'save')
}

test('S3 account — the card is collapsed by default and expands into sections', async () => {
  const { ctx } = shellContext()
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')

  assert.ok(view.container.querySelector('.dn-accountCard'), 'the account card renders')
  assert.equal(view.container.querySelector('.dn-accountBody'), null, 'the card starts collapsed')

  const toggle = accountToggle(view.container)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the toggle reports collapsed')

  await actAsync(async () => { click(toggle) })
  await flush()

  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'expanding updates aria-expanded')
  assert.ok(view.container.querySelector('.dn-accountBody'), 'the body renders once expanded')
  assert.ok(sectionByTitle(view.container, 'accountBasic'), 'the basic-settings section renders')
  assert.ok(sectionByTitle(view.container, 'overviewPrivate'), 'the private-chat section renders for a control-capable channel')

  const basic = sectionByTitle(view.container, 'accountBasic')
  const chat = basic.querySelector('input[type="text"]')
  assert.equal(chat?.value, '12345', 'a public value is pre-filled from the projection')
})

test('S3 account — a configured secret never echoes its value and offers keep/replace/clear', async () => {
  const { ctx, calls } = shellContext({
    handlers: {
      'native.saveChannel': (payload) => {
        // The browser must never be able to send the old secret back as a value.
        assert.equal(payload.patch?.botToken, undefined, 'the masked secret is never written back')
        return { ok: true, value: { saved: true, needsRestart: false } }
      },
    },
  })
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  const basic = sectionByTitle(view.container, 'accountBasic')
  const secretField = basic.querySelector('.dn-field--secret')
  assert.ok(secretField, 'the configured secret renders as a secret fieldset')
  const radios = [...secretField.querySelectorAll('input[type="radio"]')]
  assert.deepEqual(radios.map((radio) => radio.value), ['keep', 'replace', 'clear'], 'keep / replace / clear are offered')
  assert.equal(radios.find((radio) => radio.checked)?.value, 'keep', 'the default is to keep the stored value')
  assert.equal(secretField.querySelector('input[type="password"]'), null, 'no value input is shown while keeping')

  // Choosing "clear" and saving must go through the clearSecrets channel, never a value.
  const clearRadio = radios.find((radio) => radio.value === 'clear')
  await actAsync(async () => { click(clearRadio) })
  await flush()

  await actAsync(async () => { click(saveIn(basic)) })
  await flush()

  const save = calls.find((call) => call.endpoint === 'native.saveChannel')
  assert.ok(save, 'saving goes through the narrow native action')
  assert.deepEqual(save.payload.clearSecrets, ['botToken'], 'clearing is expressed as a clear list')
  assert.equal(save.payload.type, 'telegram')
})

test('S3 account — replacing a secret sends only the new value and re-hides the field', async () => {
  const { ctx, calls } = shellContext()
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  const basic = sectionByTitle(view.container, 'accountBasic')
  const secretField = basic.querySelector('.dn-field--secret')
  const replaceRadio = [...secretField.querySelectorAll('input[type="radio"]')].find((radio) => radio.value === 'replace')
  await actAsync(async () => { click(replaceRadio) })
  await flush()

  const password = basic.querySelector('input[type="password"]')
  assert.ok(password, 'choosing replace reveals a value input')
  await actAsync(async () => { typeInput(password, 'BRAND-NEW-TOKEN') })
  await flush()

  await actAsync(async () => { click(saveIn(basic)) })
  await flush()

  const save = calls.find((call) => call.endpoint === 'native.saveChannel')
  assert.ok(save, 'saving goes through the narrow native action')
  assert.equal(save.payload.patch.botToken, 'BRAND-NEW-TOKEN', 'the replacement value is sent')
  assert.equal(save.payload.clearSecrets, undefined, 'a replacement is not a clear')

  // After a successful save the secret input is dropped again (the projection only has presence).
  assert.equal(basic.querySelector('input[type="password"]'), null, 'the secret is re-hidden after saving')
})

test('S3 account — editing a public field saves it through native.saveChannel', async () => {
  const { ctx, calls } = shellContext()
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  const basic = sectionByTitle(view.container, 'accountBasic')
  const chat = basic.querySelector('input[type="text"]')
  await actAsync(async () => { typeInput(chat, '99999') })
  await flush()

  const testButton = buttonByText(basic, 'test')
  assert.equal(testButton.disabled, true, 'testing is blocked while there are unsaved edits')

  await actAsync(async () => { click(saveIn(basic)) })
  await flush()

  const save = calls.find((call) => call.endpoint === 'native.saveChannel')
  assert.equal(save.payload.patch.chatId, '99999', 'only the edited public field is sent')
})

test('S3 account — the test receipt is plain language and never claims confirmation it did not get', async () => {
  const { ctx, calls } = shellContext({
    handlers: {
      'native.testChannel': () => ({
        ok: true,
        value: { kind: 'sent', title: 'Test message sent', message: 'The platform accepted it; delivery is not yet confirmed.' },
      }),
    },
  })
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  const basic = sectionByTitle(view.container, 'accountBasic')
  await actAsync(async () => { click(buttonByText(basic, 'test')) })
  await flush()

  assert.ok(calls.some((call) => call.endpoint === 'native.testChannel' && call.payload.type === 'telegram'), 'testing goes through the narrow native action')
  const text = textOf(basic)
  assert.match(text, /Test message sent/, 'the receipt title is shown')
  assert.match(text, /delivery is not yet confirmed/, 'the receipt message is shown')
  assert.doesNotMatch(text, /delivered/i, 'an accepted send is never shown as delivered')
})

test('S3 account — the private-chat section only appears when the channel supports it', async () => {
  const { ctx, calls } = shellContext()
  const { view } = mountShell(ctx)
  await flush()

  // QQ has no inbound control capability → no private-chat section.
  await openChannel(view, 'qq')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()
  assert.equal(sectionByTitle(view.container, 'overviewPrivate'), undefined, 'no private-chat section without control capability')

  // Telegram does → the section renders and saves through the inbound action.
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()
  const pc = sectionByTitle(view.container, 'overviewPrivate')
  assert.ok(pc, 'the private-chat section renders for a control-capable channel')

  const allow = pc.querySelector('textarea')
  assert.ok(allow, 'the inbound field renders as a list control')
  await actAsync(async () => { typeInput(allow, 'alice\nbob') })
  await flush()
  await actAsync(async () => { click(saveIn(pc)) })
  await flush()

  const save = calls.find((call) => call.endpoint === 'native.saveInboundChannel')
  assert.ok(save, 'the private-chat save goes through the inbound native action')
  assert.deepEqual(save.payload.patch.allowlist, ['alice', 'bob'], 'the list is parsed into values')
})

test('S3 account — the Telegram fallback only appears when the connection needs help', async () => {
  const { ctx } = shellContext()
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  // Healthy connection: the fallback is behind an explicit "connection help" affordance.
  assert.equal(buttonByText(view.container, 'telegramAutoFallback'), undefined, 'no fallback copy is forced on a healthy channel')
  const help = buttonByText(view.container, 'connectionHelp')
  assert.ok(help, 'the connection-help affordance is offered')

  await actAsync(async () => { click(help) })
  await flush()
  assert.ok(buttonByText(view.container, 'telegramAutoFallback'), 'the automatic fallback appears after asking for help')
  assert.ok(buttonByText(view.container, 'telegramCustomAddress'), 'the custom-address option appears too')
})

test('S3 account — a Telegram channel needing attention shows the fallback without an extra click', async () => {
  const { ctx } = shellContext({ accountOverrides: { state: 'needs-attention', stateText: 'Needs attention' } })
  const { view } = mountShell(ctx)
  await flush()
  await openChannel(view, 'telegram')
  await actAsync(async () => { click(accountToggle(view.container)) })
  await flush()

  assert.ok(buttonByText(view.container, 'telegramAutoFallback'), 'a failing connection surfaces the fallback immediately')
})