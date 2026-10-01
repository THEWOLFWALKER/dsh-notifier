// T19 real-DOM acceptance tests: stable components + focus retention, schema-driven
// controls (bool/enum/number/list/secret), leave-draft confirmation, pairing-code copy
// with a manual fallback, nav layering, and destructive-action impact confirmation.
// (U05/U06/U07/U10/U11/U13)
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
function routed(rpcCall) {
  return (channel, endpoint, payload, signal) => {
    const wait = hangingSurfaceWait(channel, endpoint, payload, signal)
    if (wait) return wait
    if (endpoint === 'surface.wait') return { ok: true, value: { revision: 0 } }
    return rpcCall(endpoint, payload)
  }
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

const SCHEMA_FIXTURE = {
  type: 'webhook',
  notify: {
    configRevision: 1,
    applyMode: 'hot',
    fields: {
      mode: { type: 'enum', options: ['fast', 'safe'], label: { en: 'Mode' } },
      enabled: { type: 'boolean', label: { en: 'Enabled' } },
      count: { type: 'number', label: { en: 'Count' } },
      uids: { type: 'list', label: { en: 'UIDs' } },
      url: { type: 'string', label: { en: 'URL' } },
      token: { type: 'string', secret: true, configured: true, label: { en: 'Token' } },
    },
    editableValues: { url: 'https://old.example/hook' },
  },
}

test('T19/U06 — declared field types drive the right control (enum/boolean/number/list)', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: SCHEMA_FIXTURE } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mountChannelDetail(controller, ctx, SCHEMA_FIXTURE)
  own(controller, view)
  await flush()

  const select = view.container.querySelector('select')
  assert.ok(select, 'an enum field renders a <select>')
  assert.deepEqual(
    [...select.querySelectorAll('option')].map((option) => option.value),
    ['', 'fast', 'safe'],
    'the select carries the declared options (plus an empty choice)',
  )

  assert.ok(view.container.querySelector('input[type=checkbox]'), 'a boolean field renders a checkbox')
  assert.ok(view.container.querySelector('input[type=number]'), 'a number field renders a number input')
  assert.ok(view.container.querySelector('textarea'), 'a list field renders a textarea')
  assert.ok(view.container.querySelector('input[type=text]'), 'a plain string field still renders a text input')
})

test('T19/U06 — a configured secret never echoes its value and offers keep/replace/clear', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.get') {
        return {
          ok: true,
          value: {
            epoch: 'e', revision: 1,
            channel: {
              ...SCHEMA_FIXTURE,
              notify: { ...SCHEMA_FIXTURE.notify, editableValues: { url: 'https://old.example/hook', token: 'super-secret-value' } },
            },
          },
        }
      }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mountChannelDetail(controller, ctx, SCHEMA_FIXTURE)
  own(controller, view)
  await flush()

  const text = textOf(view.container)
  assert.match(text, /secretConfiguredKeep/, 'the keep-by-default state is stated')
  assert.doesNotMatch(text, /super-secret-value/, 'the saved secret is never rendered into the DOM')

  const radios = [...view.container.querySelectorAll('input[type=radio]')]
  assert.equal(radios.length, 3, 'keep / replace / clear are exposed as an explicit choice')
  assert.equal(view.container.querySelector('input[type=password]'), null, 'no plaintext field while keeping the saved value')

  const replace = radios.find((radio) => radio.value === 'replace')
  click(replace)
  await flush()
  assert.ok(view.container.querySelector('input[type=password]'), 'choosing "replace" reveals a fresh (masked) entry field')
})

test('T19/U05 — a continuous edit keeps the same input node, focus and caret', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: SCHEMA_FIXTURE } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mountChannelDetail(controller, ctx, SCHEMA_FIXTURE)
  own(controller, view)
  await flush()

  const input = view.container.querySelector('input[type=text]')
  assert.ok(input, 'the outbound section renders the editable field')
  input.focus()
  typeInput(input, 'https://first.example/hook')
  await flush()

  // A state update (the edit itself + the dirty bookkeeping it triggers) must not
  // remount the subtree: the very same DOM node stays focused.
  assert.equal(view.container.querySelector('input[type=text]'), input, 'the input DOM node is preserved (stable component)')
  assert.equal(globalThis.document.activeElement, input, 'focus is retained across the update')

  // Simulate a parent poll re-render (new state object, new revision bump).
  const nextState = {
    ...controller.getSnapshot(),
    view: { kind: 'channel', type: 'webhook' },
    channel: { channel: { ...SCHEMA_FIXTURE, notify: { ...SCHEMA_FIXTURE.notify, configRevision: 2 } } },
  }
  view.render(React.createElement(mod.__test.ChannelDetailView, { ctx, controller, state: nextState, t: (key) => key }))
  await flush()

  assert.equal(view.container.querySelector('input[type=text]'), input, 'a poll re-render does not replace the node')
  assert.equal(globalThis.document.activeElement, input, 'focus survives the poll re-render (U05)')
  assert.equal(input.value, 'https://first.example/hook', 'the local draft is preserved, not clobbered by the projection')
})

test('T19/U07 — leaving with unsaved edits can be cancelled; discard only on confirm', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: SCHEMA_FIXTURE } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channel', type: 'webhook' })
  const view = mountChannelDetail(controller, ctx, SCHEMA_FIXTURE)
  own(controller, view)
  await flush()

  typeInput(view.container.querySelector('input[type=text]'), 'https://draft.example/hook')
  await flush()

  click(buttonByText(view.container, 'back'))
  await flush()
  assert.ok(view.container.querySelector('[role=alertdialog]'), 'leaving a dirty form arms a confirmation dialog')
  assert.equal(controller.getSnapshot().view.kind, 'channel', 'no navigation happens while the dialog is open')

  click(buttonByText(view.container, 'leaveStay'))
  await flush()
  assert.equal(view.container.querySelector('[role=alertdialog]'), null, 'the user can cancel and stay')
  assert.equal(controller.getSnapshot().view.kind, 'channel', 'cancelling leaves the view in place')

  click(buttonByText(view.container, 'back'))
  await flush()
  click(buttonByText(view.container, 'leaveDiscard'))
  await flush()
  assert.equal(controller.getSnapshot().view.kind, 'channels', 'only an explicit discard navigates away')
})

test('T19/U10 — copying a pairing code reports success; without a clipboard it falls back to manual selection', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'pairing.list') return { ok: true, value: { epoch: 'e', revision: 1, codes: [], canMint: true, canRevoke: true } }
      if (endpoint === 'pairing.mint') return { ok: true, value: { epoch: 'e', revision: 1, code: 'ABCD-1234' } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const state = {
    ...controller.getSnapshot(),
    pairing: { codes: [], canMint: true, canRevoke: true },
  }
  const view = mount(React.createElement(mod.__test.PairingCodesView, { ctx, controller, state, t: (key) => key }))
  own(controller, view)
  await flush()

  const label = view.container.querySelector('input[type=text]')
  typeInput(label, 'phone')
  await actAsync(async () => { click(buttonByText(view.container, 'mintCode')) })
  await flush()
  assert.match(textOf(view.container), /ABCD-1234/, 'the freshly minted code is shown once')

  // 1) No clipboard capability → an honest fallback, never a false "copied".
  click(buttonByText(view.container, 'copyCode'))
  await flush()
  assert.match(textOf(view.container), /copyUnavailableSelect/, 'the manual fallback is offered when copying is impossible')
  assert.doesNotMatch(textOf(view.container), /codeCopied/, 'copying is never claimed when it did not happen')

  // 2) With a working clipboard → the code is written and success is reported.
  const copied = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  })
  try {
    click(buttonByText(view.container, 'copyCode'))
    await flush()
    assert.deepEqual(copied, ['ABCD-1234'], 'the exact code (and nothing else) is copied')
    assert.match(textOf(view.container), /codeCopied/, 'a successful copy is reported')
  } finally {
    delete globalThis.navigator
  }
})

test('T19/U11 — daily actions are one step away and management stays reachable in a separate group', async () => {
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      if (endpoint === 'home.get') return { ok: true, value: { epoch: 'e', revision: 1, summary: {} } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = mod.__test.createController(ctx)
  const view = mount(React.createElement(mod.__test.HomeView, { ctx, controller, state: controller.getSnapshot(), t: (key) => key }))
  own(controller, view)
  await flush()

  const navs = [...view.container.querySelectorAll('nav')]
  const daily = navs.find((nav) => nav.getAttribute('aria-label') === 'navDaily')
  const manage = navs.find((nav) => nav.getAttribute('aria-label') === 'navManage')
  assert.ok(daily, 'a labelled daily nav group exists (screen-reader navigable)')
  assert.ok(manage, 'a separate management nav group exists')

  const texts = (nav) => [...nav.querySelectorAll('button')].map((button) => button.textContent)
  assert.ok(texts(daily).includes('questions') && texts(daily).includes('channels'), 'daily entry points are in the daily group')
  assert.ok(texts(manage).includes('members') && texts(manage).includes('pairingCodes'), 'management entry points stay reachable in the management group')
  assert.equal(texts(manage).includes('questions'), false, 'daily items are not duplicated into the management group')
})

test('T19/U13 — a destructive action states its impact and only fires on explicit confirmation', async () => {
  const calls = []
  const { ctx } = createContext({
    rpcCall: routed((endpoint) => {
      calls.push(endpoint)
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    }),
  })
  const controller = {
    updateMember: (key, patch) => { calls.push(`update:${key}:${patch.role}`); return Promise.resolve() },
    removeMember: (key) => { calls.push(`remove:${key}`); return Promise.resolve() },
    reportError: () => {},
  }
  const member = { key: 'feishu:o1', role: 'owner', label: 'Owner One', channel: 'feishu' }
  const view = mount(React.createElement(mod.__test.MemberRow, {
    ctx, controller, member, t: (key) => key, busy: false, canUpdate: true, canRemove: true,
  }))
  teardown.push(() => { try { view.unmount() } catch {} })

  click(buttonByText(view.container, 'demote'))
  await flush()
  const armed = textOf(view.container)
  assert.match(armed, /memberDemoteImpact/, 'the concrete consequence is shown before confirming')
  assert.match(armed, /Owner One/, 'the specific subject of the action is named')
  assert.equal(calls.some((call) => String(call).startsWith('update:')), false, 'arming alone performs no write')

  click(buttonByText(view.container, 'cancelAction'))
  await flush()
  assert.equal(calls.some((call) => String(call).startsWith('update:')), false, 'cancelling performs no write')

  click(buttonByText(view.container, 'demote'))
  await flush()
  await actAsync(async () => { click(buttonByText(view.container, 'confirmDemote')) })
  await flush()
  assert.ok(calls.includes('update:feishu:o1:member'), 'only the confirmed action writes')
})