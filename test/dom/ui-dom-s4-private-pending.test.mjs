// Real-React DOM tests for the Native v2 private chat + pending flows (Stage 1 / S4).
//
// These mount the ACTUAL MainPanel through the real client module and drive:
//   - the first-run private-chat wizard (confirm it is you -> choose a task -> try),
//   - the ready state (current channel / task / people + close),
//   - pending items that settle IN PLACE through the narrow action table,
//   - the replay guard: an item already handled on the phone is not executed again.
//
// Pending is not permanent navigation: it is a light banner on the home page that
// opens a page. The rail only lists channels.
//
// Run with:  node test/dom/run.mjs   (see test/dom/run.mjs)

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actAsync, buttonByText, click, createContext, flush, hangingSurfaceWait,
  installDomEnvironment, loadClient, mount, React,
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

const PENDING_QUESTION = {
  id: 'abc123abc123',
  title: 'Deploy to production?',
  sourceText: 'From a task',
  createdText: '2 minutes ago',
  choices: [
    { id: '0', label: 'Deploy', kind: 'choose' },
    { id: '1', label: 'Wait', kind: 'choose' },
    { id: 'reject', label: 'Handle later', kind: 'reject' },
  ],
}

const PENDING_IDENTITY = {
  id: 'u_deadbeef1234',
  title: 'Someone wants to connect',
  sourceText: 'From Telegram',
  createdText: 'just now',
  choices: [
    { id: 'approve', label: 'Confirm it is me', kind: 'choose' },
    { id: 'dismiss', label: 'Ignore', kind: 'reject' },
  ],
}

const READY_PRIVATE_CHAT = {
  enabled: true,
  verified: true,
  verifiedText: 'verifiedYes',
  channel: { id: 'telegram:default', name: 'Telegram', accountName: 'default' },
  currentTask: { id: 'task-1', title: 'dsh-notifier' },
  users: [{ id: 'u_owner', displayName: 'Me', permissionText: 'can manage' }],
  setup: { step: 'ready', pendingIdentities: [], owners: [{ id: 'u_owner', displayName: 'Me', channelName: 'Telegram', currentTask: { id: 'task-1', title: 'dsh-notifier' } }], tasks: [] },
}

function snapshotValue({ pending = [], privateChat } = {}) {
  return {
    epoch: 'e', revision: 1, cursor: 'tok.1',
    rail: RAIL,
    channels: RAIL,
    privateChat: privateChat ?? READY_PRIVATE_CHAT,
    pending,
    storage: { canSave: true, text: 'Changes are saved' },
    truncated: { rail: false, channels: false, pending: false },
  }
}

function shellContext({ snapshot = {}, handlers = {} } = {}) {
  return createContext({
    rpcCall: routed((endpoint, payload) => {
      const handler = handlers[endpoint]
      if (typeof handler === 'function') return handler(payload)
      if (handler !== undefined) return handler
      if (endpoint === 'native.snapshot') return { ok: true, value: snapshotValue(snapshot) }
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

function articleByTitle(container, title) {
  return [...container.querySelectorAll('article.dn-question')]
    .find((article) => article.querySelector('.dn-rowTitle')?.textContent === title)
}

function sectionByTitle(container, title) {
  return [...container.querySelectorAll('section.dn-section')]
    .find((section) => section.querySelector('.dn-sectionTitle')?.textContent === title)
}

// ————————————————————————————— 待处理 —————————————————————————————

test('S4 pending — the home page shows a light banner, not a permanent nav entry', async () => {
  const { ctx } = shellContext({ snapshot: { pending: [PENDING_QUESTION] } })
  const { view } = mountShell(ctx)
  await flush()

  const banner = view.container.querySelector('.dn-pendingBanner')
  assert.ok(banner, 'a pending banner appears on the home page')
  assert.match(banner.textContent, /pendingBannerTitle/, 'the banner states what it is')
  assert.match(banner.textContent, /1/, 'the banner states how many')

  // Pending is not permanent navigation: the rail only lists channels.
  const nav = [...view.container.querySelectorAll('nav.dn-rail [data-nav]')].map((node) => node.getAttribute('data-nav'))
  assert.deepEqual(nav, ['all', 'telegram', 'qq', 'add'], 'the rail lists channels only — no pending / private entry')

  assert.equal(view.container.querySelector('article.dn-question'), null, 'the pending page is not open yet')
})

test('S4 pending — the banner opens a page and an answer settles in place through the narrow action', async () => {
  const { ctx, calls } = shellContext({
    snapshot: { pending: [PENDING_QUESTION, PENDING_IDENTITY] },
    handlers: {
      'native.settlePending': () => ({ ok: true, value: { settled: true, alreadyHandled: false } }),
    },
  })
  const { view } = mountShell(ctx)
  await flush()

  await actAsync(async () => { click(view.container.querySelector('.dn-pendingBanner')) })
  await flush()

  assert.ok(articleByTitle(view.container, 'Deploy to production?'), 'the question row renders on the pending page')
  assert.ok(articleByTitle(view.container, 'Someone wants to connect'), 'the identity row renders too')

  const question = articleByTitle(view.container, 'Deploy to production?')
  await actAsync(async () => { click(buttonByText(question, 'Deploy')) })
  await flush()

  const settle = calls.find((call) => call.endpoint === 'native.settlePending')
  assert.ok(settle, 'answering goes through the narrow native action')
  assert.deepEqual(settle.payload, { ref: 'abc123abc123', action: 'choose', options: ['0'] },
    'the ref and the chosen option are sent verbatim')
  assert.equal(calls.filter((call) => call.endpoint === 'native.settlePending').length, 1, 'the answer is sent once')
})

test('S4 pending — an item already handled on the phone is not replayed, only reported', async () => {
  const { ctx, calls } = shellContext({
    snapshot: { pending: [PENDING_QUESTION] },
    handlers: {
      'native.settlePending': () => ({ ok: true, value: { settled: false, alreadyHandled: true } }),
    },
  })
  const { view } = mountShell(ctx)
  await flush()

  await actAsync(async () => { click(view.container.querySelector('.dn-pendingBanner')) })
  await flush()

  const question = articleByTitle(view.container, 'Deploy to production?')
  await actAsync(async () => { click(buttonByText(question, 'Deploy')) })
  await flush()

  assert.equal(calls.filter((call) => call.endpoint === 'native.settlePending').length, 1,
    'the phone already settled it — the web must not fire a second settlement')
  assert.match(view.container.textContent, /pendingAlreadyHandled/, 'the user is told it was already handled')
})

test('S4 pending — an identity row confirms or ignores through the member action', async () => {
  const { ctx, calls } = shellContext({
    snapshot: { pending: [PENDING_IDENTITY] },
    handlers: {
      'native.approveUser': () => ({ ok: true, value: { approved: true } }),
      'native.dismissUser': () => ({ ok: true, value: { dismissed: true } }),
    },
  })
  const { view } = mountShell(ctx)
  await flush()

  await actAsync(async () => { click(view.container.querySelector('.dn-pendingBanner')) })
  await flush()

  const identity = articleByTitle(view.container, 'Someone wants to connect')
  await actAsync(async () => { click(buttonByText(identity, 'Confirm it is me')) })
  await flush()

  const approve = calls.find((call) => call.endpoint === 'native.approveUser')
  assert.ok(approve, 'confirming an identity uses the member action')
  assert.deepEqual(approve.payload, { id: 'u_deadbeef1234' }, 'the opaque user id is sent, never an internal member key')
})

test('S4 private — when private chat is off the home page offers to add a channel, not a dead end', async () => {
  const off = {
    enabled: false, verified: false, users: [],
    setup: { step: 'confirm', pendingIdentities: [], tasks: [] },
  }
  const { ctx } = shellContext({ snapshot: { privateChat: off } })
  const { view } = mountShell(ctx)
  await flush()

  const section = sectionByTitle(view.container, 'overviewPrivate')
  assert.ok(section, 'the private-chat section renders')
  assert.match(section.textContent, /overviewPrivateOff/, 'it says private chat is not on')
  assert.ok(buttonByText(section, 'pickerTitle'), 'it offers to add a channel instead of a dead-end page')
  assert.equal(buttonByText(section, 'privateView'), undefined, 'no entry into a page that cannot do anything')
  assert.equal(buttonByText(section, 'privateOpen'), undefined, 'nor a setup entry before a channel exists')
})

// ————————————————————————————— 私聊 —————————————————————————————

test('S4 private — the first-run wizard walks confirm -> task -> try and mints a code', async () => {
  const wizard = {
    enabled: true,
    verified: false,
    verifiedText: 'verifiedNo',
    users: [],
    setup: { step: 'confirm', pendingIdentities: [], tasks: [] },
  }
  const { ctx, calls } = shellContext({
    snapshot: { privateChat: wizard },
    handlers: { 'native.mintPairing': () => ({ ok: true, value: { id: 'p1', code: 'ABCD-1234', expiresAt: 0 } }) },
  })
  const { view } = mountShell(ctx)
  await flush()

  // Not yet confirmed: the home entry invites the user to set private chat up.
  await actAsync(async () => { click(buttonByText(view.container, 'privateOpen')) })
  await flush()

  const steps = [...view.container.querySelectorAll('.dn-step')].map((node) => node.textContent)
  assert.deepEqual(steps, ['privateStepConfirm', 'privateStepTask', 'privateStepTry'], 'the three steps are shown')
  assert.equal(view.container.querySelector('.dn-step.is-active')?.textContent, 'privateStepConfirm',
    'the wizard starts at "confirm it is you"')

  // No identity has reached the phone yet: the user is offered a one-time code instead.
  await actAsync(async () => { click(buttonByText(view.container, 'privateConfirmMint')) })
  await flush()

  const mint = calls.find((call) => call.endpoint === 'native.mintPairing')
  assert.ok(mint, 'generating the confirmation code goes through the native action')
  assert.match(view.container.textContent, /ABCD-1234/, 'the code is shown once so the user can type it on the phone')
})

test('S4 private — once confirmed, the page shows the current channel, task and people with a close action', async () => {
  const { ctx, calls } = shellContext({
    handlers: { 'native.setPrivateChatEnabled': () => ({ ok: true, value: { enabled: false } }) },
  })
  const { view } = mountShell(ctx)
  await flush()

  await actAsync(async () => { click(buttonByText(view.container, 'privateView')) })
  await flush()

  assert.match(view.container.textContent, /privateReadyTitle/, 'the ready title renders')
  assert.match(view.container.textContent, /dsh-notifier/, 'the current task is shown')
  assert.match(view.container.textContent, /privatePeople/, 'the people count is shown')

  // Closing private chat asks once and revokes admission while retaining the saved credentials.
  await actAsync(async () => { click(buttonByText(view.container, 'privateClose')) })
  await flush()
  assert.ok(view.container.querySelector('[role="alertdialog"]'), 'closing asks for confirmation first')
  assert.equal(calls.filter((call) => call.endpoint === 'native.setPrivateChatEnabled').length, 0, 'nothing changes before confirming')

  const dialog = view.container.querySelector('[role="alertdialog"]')
  await actAsync(async () => { click(buttonByText(dialog, 'privateClose')) })
  await flush()

  const toggle = calls.find((call) => call.endpoint === 'native.setPrivateChatEnabled')
  assert.ok(toggle, 'confirming disables private-chat admission')
  assert.deepEqual(toggle.payload, { type: 'telegram', enabled: false },
    'the toggle targets the current private-chat channel and retains credentials')
})

test('S4 private — choosing a task moves the wizard to the try step', async () => {
  const wizard = {
    enabled: true,
    verified: true,
    verifiedText: 'verifiedYes',
    users: [],
    setup: { step: 'task', pendingIdentities: [], owners: [{ id: 'u_owner', displayName: 'Me', channelName: 'Telegram' }], tasks: [{ id: 'task-9', title: 'payments-api' }] },
  }
  const { ctx, calls } = shellContext({ snapshot: { privateChat: wizard } })
  const { view } = mountShell(ctx)
  await flush()

  await actAsync(async () => { click(buttonByText(view.container, 'privateView')) })
  await flush()

  assert.equal(view.container.querySelector('.dn-step.is-active')?.textContent, 'privateStepTask',
    'the wizard is on the task step')
  await actAsync(async () => { click(buttonByText(view.container, 'privateTaskUse')) })
  await flush()

  assert.match(view.container.textContent, /privateStepTry/, 'picking a task advances to the try step')
  assert.match(view.container.textContent, /payments-api/, 'the picked task is reflected')
  assert.deepEqual(calls.find(call => call.endpoint === 'native.selectTask')?.payload, { taskRef: 'task-9', ownerId: 'u_owner' })
})

test('S4 private — multiple owners must select whose current task is being changed', async () => {
  const wizard = {
    enabled: true,
    verified: true,
    verifiedText: 'verifiedYes',
    users: [],
    setup: {
      step: 'task', pendingIdentities: [],
      owners: [
        { id: 'u_one', displayName: 'One', channelName: 'Telegram' },
        { id: 'u_two', displayName: 'Two', channelName: 'Feishu' },
      ],
      tasks: [{ id: 'task-9', title: 'payments-api' }],
    },
  }
  const { ctx, calls } = shellContext({ snapshot: { privateChat: wizard } })
  const { view } = mountShell(ctx)
  await flush()
  await actAsync(async () => { click(buttonByText(view.container, 'privateView')) })
  await flush()
  await actAsync(async () => { click(view.container.querySelectorAll('button[aria-pressed]')[1]) })
  await actAsync(async () => { click(buttonByText(view.container, 'privateTaskUse')) })
  await flush()
  assert.deepEqual(calls.find(call => call.endpoint === 'native.selectTask')?.payload, { taskRef: 'task-9', ownerId: 'u_two' })
})
