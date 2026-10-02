import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function fakeReact() {
  const noop = () => {}
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...patch } }
  }
  return {
    Component,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged, children }
    },
    useCallback(fn) { return fn },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, noop] },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
}

function textOf(node) {
  const chunks = []
  const visit = value => {
    if (value === null || value === undefined || value === false) return
    if (typeof value === 'string' || typeof value === 'number') { chunks.push(String(value)); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value === 'object') {
      if (typeof value.type === 'function') { visit(value.type(value.props ?? {})); return }
      visit(value.children)
    }
  }
  visit(node)
  return chunks.join('')
}

function loadModule({ rpcCall } = {}) {
  let source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  source = source.replace(
    "return {\n      inject: ['slots', 'connection', 'locale', 'layout'],",
    "return {\n      __test: { createController, QuestionCard, QuestionsView, MemberRow, MembersView, PendingRow, PendingIdentitiesView, PairingCodeRow, PairingCodesView, SessionRow, SessionsView, BindingAgentRow, BindingChannelRow, BindingsView, TaskRow, ChannelRow, ActivityRow, HelpView, NotifySettingsView, buildSupportReport },\n      inject: ['slots', 'connection', 'locale', 'layout'],",
  )
  assert.match(source, /__test:/)
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } }, open() { return null } },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      head: { appendChild() {} },
      createElement() { return { dataset: {}, textContent: '', remove() {} } },
    },
    setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout, AbortController, console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(registration.id, 'dsh-notifier')
  const mod = registration.factory(name => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require ${name}`)
  })
  const ctx = {
    locale: { resolveText(value) { return typeof value === 'string' ? value : value?.en ?? '' } },
    connection: { rpc: { call: rpcCall ?? (async () => ({ ok: true, value: { revision: 0 } })) } },
  }
  return { mod, ctx }
}

test('client module registers the four intended DSH slots', () => {
  const { mod } = loadModule()
  assert.deepEqual(Array.from(mod.inject), ['slots', 'connection', 'locale', 'layout'])
  const registrations = []
  const effects = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    locale: { register() { return () => {} }, bind() { return key => key }, subscribe() { return () => {} }, resolveText(v) { return typeof v === 'string' ? v : v?.en ?? '' } },
    layout: { selectPanel() {} },
    connection: { rpc: { async call() { return { ok: true, value: { revision: 0 } } } } },
    slots: { inject(_name, fn) { return fn() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
  }
  mod.apply(ctx)
  assert.deepEqual(registrations.map(x => x.options.name).sort(), ['main', 'plugins.bundle.activation', 'plugins.bundle.config', 'sidebar.panellist'])
  assert.equal(registrations.find(x => x.options.name === 'main').options.key, 'dsh-notifier')
  const panellist = registrations.find(x => x.options.name === 'sidebar.panellist')
  assert.equal(panellist.options.id, 'dsh-notifier')
  // 宿主 resolveSlotLabel 只对函数求值：label 必须是 thunk（对象会被当 React child 渲染并崩掉 sidebar）
  assert.equal(typeof panellist.options.label, 'function')
  assert.equal(panellist.options.label(), 'Notify & Private chat')
  for (const d of effects.reverse()) d()
})

// v0.15（Stage 1 / S2）：旧的「高级控制台」弹窗入口随 Home 的「常用 / 管理」pill 导航一并删除，
// 相关弹窗测试作废（二级能力统一收进「更多」菜单，见 S5）。

test('question conflict race normalizes to alreadyHandled and refreshes the current view', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(channel, endpoint) {
      calls.push({ channel, endpoint })
      if (endpoint === 'questions.settle') return { ok: false, error: { code: 'dsh-notifier/conflict', message: 'already handled' } }
      // 默认视图现在是「通知与私聊」：refreshCurrent 走 native.snapshot（不再读 surface.home）。
      if (endpoint === 'native.snapshot') return { ok: true, value: { epoch: 'e', revision: 3, cursor: 'tok.3', rail: [], channels: [], privateChat: { enabled: false, users: [] }, pending: [], storage: { canSave: true, text: 'ok' }, truncated: { rail: false, channels: false, pending: false } } }
      return { ok: true, value: { revision: 3 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  const result = await controller.settleQuestion('q1', 'reject', [])
  assert.deepEqual({ settled: result.settled, alreadyHandled: result.alreadyHandled }, { settled: false, alreadyHandled: true })
  assert.equal(calls.filter(x => x.endpoint === 'native.snapshot').length, 1)
  controller.dispose()
})

test('controller treats epoch change as restart and clears old revision/cache truth', async () => {
  let epoch = 'epoch-a'
  let revision = 9
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'surface.home') return { ok: true, value: { epoch, revision, summary: {}, questions: [], tasks: [], channels: [], activity: [] } }
      if (endpoint === 'channels.list') return { ok: true, value: { epoch, revision, channels: [{ type: 'telegram' }] } }
      if (endpoint === 'channels.get') return { ok: true, value: { epoch, revision, channel: { type: payload.type } } }
      return { ok: true, value: { epoch, revision } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadHome()
  await controller.loadChannels()
  assert.equal(controller.getSnapshot().revision, 9)
  epoch = 'epoch-b'
  revision = 1
  await controller.loadHome()
  const restarted = controller.getSnapshot()
  assert.equal(restarted.epoch, 'epoch-b')
  assert.equal(restarted.revision, 1, '新 epoch 的低 revision 不得被旧进程高 revision 压住')
  assert.equal(restarted.channels, null, 'epoch 变化必须清除旧进程缓存')
  controller.dispose()
})

test('channel navigation clears previous channel before the next request resolves', async () => {
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: { type: payload.type } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channel', type: 'telegram' })
  await controller.loadChannel('telegram')
  assert.equal(controller.getSnapshot().channel.channel.type, 'telegram')
  controller.navigate({ kind: 'channel', type: 'feishu' })
  assert.equal(controller.getSnapshot().channel, null, 'B 详情加载前不得短暂显示 A 的数据')
  controller.dispose()
})

test('questions inbox loads the full pending list from questions.list', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'questions.list') return { ok: true, value: { epoch: 'e', revision: 2, questions: [{ ref: 'q1' }] } }
      return { ok: true, value: { epoch: 'e', revision: 2 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadQuestions()
  assert.deepEqual(calls, ['questions.list'])
  assert.deepEqual(controller.getSnapshot().questions.questions, [{ ref: 'q1' }])
  controller.dispose()
})

test('questions inbox renders every pending row and an empty state', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = { async loadQuestions() { return {} }, reportError() {}, navigate() {}, async settleQuestion() { return { settled: true } } }
  const view = mod.__test.QuestionsView({
    ctx, t, controller,
    state: {
      error: null, busy: {},
      questions: { questions: [
        { ref: 'q1', question: 'Pick one', multiple: false, status: 'pending', options: [{ value: '0', label: 'Alpha' }] },
        { ref: 'q2', question: 'Pick many', multiple: true, status: 'pending', options: [{ value: '0', label: 'Beta' }] },
      ] },
    },
  })
  assert.match(textOf(view), /Pick one/)
  assert.match(textOf(view), /Alpha/)
  assert.match(textOf(view), /Pick many/)
  assert.match(textOf(view), /Beta/)
  assert.match(textOf(view), /questions/)

  const empty = mod.__test.QuestionsView({
    ctx, t, controller,
    state: { error: null, busy: {}, questions: { questions: [] } },
  })
  assert.match(textOf(empty), /noQuestions/)
})

test('settling from the inbox refreshes the inbox list, not the home cache', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'questions.settle') return { ok: true, value: { epoch: 'e', revision: 5, settled: true, alreadyHandled: false } }
      if (endpoint === 'questions.list') return { ok: true, value: { epoch: 'e', revision: 5, questions: [] } }
      return { ok: true, value: { epoch: 'e', revision: 5 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'questions' })
  await controller.settleQuestion('q1', 'choose', ['0'])
  assert.deepEqual(calls, ['questions.settle', 'questions.list'], '结算后必须重载当前 questions 视图')
  controller.dispose()
})

test('members view loads the member list from members.list', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'members.list') return { ok: true, value: { epoch: 'e', revision: 2, members: [{ key: 'telegram:u1', role: 'owner' }], canUpdate: true, canRemove: true } }
      return { ok: true, value: { epoch: 'e', revision: 2 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadMembers()
  assert.deepEqual(calls, ['members.list'])
  assert.equal(controller.getSnapshot().members.members[0].key, 'telegram:u1')
  controller.dispose()
})

test('members view renders rows with role actions and an empty state', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadMembers() { return {} }, reportError() {}, navigate() {},
    async updateMember() { return {} }, async removeMember() { return {} },
  }
  const view = mod.__test.MembersView({
    ctx, t, controller,
    state: {
      error: null, busy: {},
      members: {
        canUpdate: true, canRemove: true,
        members: [
          { key: 'telegram:1', channel: 'telegram', userId: '1', role: 'owner', label: 'Alice' },
          { key: 'telegram:2', channel: 'telegram', userId: '2', role: 'member' },
        ],
      },
    },
  })
  assert.match(textOf(view), /Alice/)
  assert.match(textOf(view), /owner/)
  assert.match(textOf(view), /demote/)
  assert.match(textOf(view), /promote/)
  assert.match(textOf(view), /remove/)

  const empty = mod.__test.MembersView({ ctx, t, controller, state: { error: null, busy: {}, members: { members: [] } } })
  assert.match(textOf(empty), /noMembers/)
})

test('member role change and removal refresh the member list', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'members.list') return { ok: true, value: { epoch: 'e', revision: 3, members: [] } }
      return { ok: true, value: { epoch: 'e', revision: 3 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.updateMember('telegram:1', { role: 'owner' })
  await controller.removeMember('telegram:2')
  assert.deepEqual(calls, ['members.update', 'members.list', 'members.remove', 'members.list'])
  controller.dispose()
})

test('pending identities load and approve/dismiss refresh the list', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'members.pending') {
        return { ok: true, value: { epoch: 'e', revision: 4, pending: [{ key: 'qq:u9', channel: 'qq', userId: 'u9', origin: 'learned' }], canApprove: true, canDismiss: true } }
      }
      return { ok: true, value: { epoch: 'e', revision: 4 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadPending()
  assert.deepEqual(calls, ['members.pending'])
  assert.equal(controller.getSnapshot().pending.pending[0].key, 'qq:u9')
  await controller.approvePending('qq:u9')
  await controller.dismissPending('qq:u10')
  assert.deepEqual(calls, [
    'members.pending', 'members.approve', 'members.pending', 'members.dismiss', 'members.pending',
  ])
  controller.dispose()
})

test('pending identities view renders rows with approve/dismiss and an empty state', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadPending() { return {} }, reportError() {}, navigate() {},
    async approvePending() { return {} }, async dismissPending() { return {} },
  }
  const view = mod.__test.PendingIdentitiesView({
    ctx, t, controller,
    state: {
      error: null, busy: {},
      pending: {
        canApprove: true, canDismiss: true,
        pending: [{ key: 'qq:u9', channel: 'qq', userId: 'u9', origin: 'learned' }],
      },
    },
  })
  assert.match(textOf(view), /u9/)
  assert.match(textOf(view), /learned/)
  assert.match(textOf(view), /approve/)
  assert.match(textOf(view), /dismiss/)

  const empty = mod.__test.PendingIdentitiesView({ ctx, t, controller, state: { error: null, busy: {}, pending: { pending: [] } } })
  assert.match(textOf(empty), /noPending/)
})

test('pairing codes load, mint returns the code once, revoke refreshes', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'pairing.list') {
        return { ok: true, value: { epoch: 'e', revision: 5, codes: [{ id: 'abcd1234', origin: 'owner', state: 'minted-active' }], canMint: true, canRevoke: true } }
      }
      if (endpoint === 'pairing.mint') {
        return { ok: true, value: { id: 'ef567890', code: 'ABCD-EFGH', expiresAt: 1 } }
      }
      return { ok: true, value: { epoch: 'e', revision: 5 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadPairingCodes()
  assert.equal(controller.getSnapshot().pairing.codes[0].id, 'abcd1234')
  const minted = await controller.mintPairingCode('laptop')
  assert.equal(minted.code, 'ABCD-EFGH', '码面只在铸造响应中出现一次')
  await controller.revokePairingCode('abcd1234')
  assert.deepEqual(calls, [
    'pairing.list', 'pairing.mint', 'pairing.list', 'pairing.revoke', 'pairing.list',
  ])
  controller.dispose()
})

test('pairing view renders active codes, mint control, and an empty state', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadPairingCodes() { return {} }, reportError() {}, navigate() {},
    async mintPairingCode() { return { code: 'X' } }, async revokePairingCode() { return {} },
  }
  const view = mod.__test.PairingCodesView({
    ctx, t, controller,
    state: {
      error: null, busy: {},
      pairing: {
        canMint: true, canRevoke: true,
        codes: [{ id: 'abcd1234', origin: 'owner', mintedBy: 'native', state: 'minted-active' }],
      },
    },
  })
  assert.match(textOf(view), /abcd1234/)
  assert.match(textOf(view), /mintCode/)
  assert.match(textOf(view), /revoke/)

  const empty = mod.__test.PairingCodesView({ ctx, t, controller, state: { error: null, busy: {}, pairing: { codes: [] } } })
  assert.match(textOf(empty), /noCodes/)
})

test('sessions list loads and outbound override patch refreshes the list', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'sessions.list') {
        return { ok: true, value: { epoch: 'e', revision: 6, canPatch: true, sessions: [{ id: 's1', workspace: 'ws-a', active: true, resolved: { channelTypes: ['bark'], quiet: false, source: 'agent-workspace' } }] } }
      }
      return { ok: true, value: { epoch: 'e', revision: 6, id: 's1', outbound: { quiet: true } } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadSessions()
  assert.equal(controller.getSnapshot().sessions.sessions[0].id, 's1')
  const patched = await controller.patchSessionOutbound('s1', { quiet: true })
  assert.deepEqual(patched.outbound, { quiet: true })
  assert.deepEqual(calls, ['sessions.list', 'sessions.patch', 'sessions.list'], '写入后必须重载会话列表')
  controller.dispose()
})

test('sessions view renders rows, a silence toggle, and an empty state', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadSessions() { return {} }, reportError() {}, navigate() {},
    async patchSessionOutbound() { return {} },
  }
  const view = mod.__test.SessionsView({
    ctx, t, controller,
    state: {
      error: null, busy: {}, sessions: {
        canPatch: true,
        sessions: [
          { id: 's1', workspace: 'ws-a', active: true, resolved: { channelTypes: ['bark', 'webhook'], quiet: false, source: 'session' } },
          { id: 's2', active: false, resolved: { channelTypes: [], quiet: true, source: 'global' } },
        ],
      },
    },
  })
  assert.match(textOf(view), /ws-a/)
  assert.match(textOf(view), /bark, webhook/)
  assert.match(textOf(view), /sessionActive/)
  assert.match(textOf(view), /sessionIdle/)
  assert.match(textOf(view), /silence/)
  assert.match(textOf(view), /resumeNotify/)
  assert.match(textOf(view), /noChannelsResolved/)
  assert.match(textOf(view), /s2/)

  const empty = mod.__test.SessionsView({ ctx, t, controller, state: { error: null, busy: {}, sessions: { sessions: [] } } })
  assert.match(textOf(empty), /noSessions/)
})

test('sessions view hides the override control when patching is unsupported', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = { async loadSessions() { return {} }, reportError() {}, navigate() {}, async patchSessionOutbound() { return {} } }
  const view = mod.__test.SessionsView({
    ctx, t, controller,
    state: { error: null, busy: {}, sessions: { canPatch: false, sessions: [{ id: 's1', workspace: 'ws-a', active: true, resolved: { channelTypes: ['bark'] } }] } },
  })
  assert.doesNotMatch(textOf(view), /silence/)
  assert.doesNotMatch(textOf(view), /resumeNotify/)
})

test('bindings view loads bindings.get and putBindings reloads the snapshot', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'bindings.get') {
        return { ok: true, value: { epoch: 'e', revision: 7, canEdit: true, agents: { 'ws-a': { channels: ['bark'] } }, channels: { telegram: { defaultAgent: 'ws-a' } } } }
      }
      return { ok: true, value: { epoch: 'e', revision: 7, canEdit: true, agents: { 'ws-a': { channels: ['bark'], quiet: true } }, channels: {} } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadBindings()
  assert.deepEqual(controller.getSnapshot().bindings.agents, { 'ws-a': { channels: ['bark'] } })
  const written = await controller.putBindings({ agents: { 'ws-a': { channels: ['bark'], quiet: true } } })
  assert.deepEqual(written.agents, { 'ws-a': { channels: ['bark'], quiet: true } })
  assert.deepEqual(calls, ['bindings.get', 'bindings.put', 'bindings.get'], '写入后必须重载绑定快照')
  controller.dispose()
})

test('bindings view renders agent + channel rows, a raw-identifier collapse, and empty states', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadBindings() { return {} }, reportError() {}, navigate() {}, async putBindings() { return {} },
  }
  const view = mod.__test.BindingsView({
    ctx, t, controller,
    state: {
      error: null, busy: {}, bindings: {
        canEdit: true,
        agents: { 'ws-a': { channels: ['bark', 'webhook'], quiet: true } },
        channels: { telegram: { defaultAgent: 'ws-a' } },
      },
    },
  })
  assert.match(textOf(view), /agentBindings/)
  assert.match(textOf(view), /channelBindings/)
  assert.match(textOf(view), /ws-a/)
  assert.match(textOf(view), /bark, webhook/)
  assert.match(textOf(view), /telegram/)
  assert.match(textOf(view), /viewRawIdentifiers/)
  assert.match(textOf(view), /resumeNotify/)

  const empty = mod.__test.BindingsView({ ctx, t, controller, state: { error: null, busy: {}, bindings: { agents: {}, channels: {} } } })
  assert.match(textOf(empty), /noBindings/)
})

test('bindings view hides edit controls when canEdit is false', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = { async loadBindings() { return {} }, reportError() {}, navigate() {}, async putBindings() { return {} } }
  const view = mod.__test.BindingsView({
    ctx, t, controller,
    state: { error: null, busy: {}, bindings: { canEdit: false, agents: { 'ws-a': { quiet: true } }, channels: { telegram: { defaultAgent: 'ws-a' } } } },
  })
  assert.doesNotMatch(textOf(view), /resumeNotify/)
  assert.doesNotMatch(textOf(view), /remove/)
  assert.match(textOf(view), /silence/, '只读时仍显示状态，但不显示编辑控件')
})

test('help support report loads the canonical snapshot on demand', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      calls.push(endpoint)
      if (endpoint === 'diagnostics.snapshot') {
        return { ok: true, value: { epoch: 'e', revision: 8, version: '0.13.1', generatedAt: '2026-09-27T00:00:00.000Z', attention: { required: false, reasons: [] } } }
      }
      return { ok: true, value: { epoch: 'e', revision: 8 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  const result = await controller.generateSupportReport()
  assert.deepEqual(calls, ['diagnostics.snapshot'], '支持报告只在用户点击时按需读取一次诊断快照')
  assert.equal(controller.getSnapshot().diagnostics.version, '0.13.1')
  // 沙箱没有剪贴板 / 下载能力：明确回落为失败结果，绝不抛出。
  assert.equal(result.type, 'failed')
  controller.dispose()
})

test('help view renders the troubleshooting steps and a support-report control', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = { reportError() {}, navigate() {}, async generateSupportReport() { return { ok: true, type: 'copied' } } }
  const view = mod.__test.HelpView({ ctx, t, controller, state: { error: null, busy: {} } })
  const text = textOf(view)
  assert.match(text, /helpTipPhone/)
  assert.match(text, /helpTipConnect/)
  assert.match(text, /helpTipReply/)
  assert.match(text, /helpTipRestart/)
  assert.match(text, /generateReport/)
  // 用户向帮助绝不暴露内部诊断细节（宿主版本 / 存储 / 能力矩阵）。
  assert.doesNotMatch(text, /pluginVersion|hostVersion|storageState|evidenceLevel|processId/)
})

test('notify settings view lists notify-capable channels and reuses test + channel navigation', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const navigations = []
  const controller = {
    reportError() {},
    navigate(view) { navigations.push(view) },
    async nativeTestChannel() { return { message: 'sent' } },
  }
  const state = {
    error: null, busy: {},
    native: {
      channels: [
        { id: 'telegram', name: 'Telegram', brand: 'telegram', state: 'ready', stateText: 'Ready', notifyEnabled: true, canNotify: true },
        { id: 'bark', name: 'Bark', brand: 'bark', state: 'not-set', stateText: 'Not set up', notifyEnabled: false, canNotify: false },
      ],
    },
  }
  const view = mod.__test.NotifySettingsView({ ctx, t, controller, state })
  const text = textOf(view)
  assert.match(text, /Telegram/)
  assert.match(text, /test/, '已开启通知的渠道显示「测试」')
  assert.match(text, /notifySettingsOpen/)
  assert.doesNotMatch(text, /Bark/, 'canNotify=false 的渠道不进入通知总览')
  assert.deepEqual(navigations, [], '渲染本身不触发导航（写动作只在点击后发生）')

  const loading = mod.__test.NotifySettingsView({ ctx, t, controller, state: { error: null, busy: {}, native: null } })
  assert.match(textOf(loading), /loading/)

  const empty = mod.__test.NotifySettingsView({ ctx, t, controller, state: { error: null, busy: {}, native: { channels: [] } } })
  assert.match(textOf(empty), /notifySettingsEmpty/)
})

test('support report is deterministic, redacted, and states the evidence level', () => {
  const { mod } = loadModule()
  const snapshot = { version: '0.13.1', generatedAt: '2026-09-27T00:00:00.000Z', attention: { required: true }, channels: { latestEvidence: 'accepted' }, host: { version: '1.2.3' } }
  const first = mod.__test.buildSupportReport(snapshot)
  assert.equal(first, mod.__test.buildSupportReport(snapshot), '同一快照必须产出同一报告')
  assert.match(first, /plugin version: 0\.13\.1/)
  assert.match(first, /attention required: yes/)
  assert.match(first, /evidence level: accepted/)
  assert.match(first, /"host"/)

  const fallback = mod.__test.buildSupportReport(null)
  assert.match(fallback, /evidence level: none/)
  assert.doesNotMatch(fallback, /undefined/)
})

test('frozen Question/Task/Channel/Activity view fields render exactly', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const question = mod.__test.QuestionCard({
    ctx, t, busy: false,
    controller: { async settleQuestion() { return { settled: true, alreadyHandled: false } } },
    question: {
      ref: 'q1', question: { en: 'Choose', zh: '选择' }, context: { en: 'Context', zh: '上下文' }, multiple: true, status: 'pending',
      options: [{ value: 'a', label: { en: 'Alpha', zh: '甲' } }, { value: 'b', label: { en: 'Beta', zh: '乙' } }],
    },
  })
  assert.match(textOf(question), /Alpha/)
  assert.match(textOf(question), /Beta/)
  assert.match(textOf(question), /submit/)
  assert.doesNotMatch(textOf(question), /undefined/)

  const expired = mod.__test.QuestionCard({ ctx, t, busy: false, controller: {}, question: { ref: 'q2', question: 'Expired Q', multiple: false, status: 'expired', expiresText: '1 min ago', options: [] } })
  assert.match(textOf(expired), /expired/)
  assert.doesNotMatch(textOf(expired), /reject/)

  const task = mod.__test.TaskRow({ ctx, task: { taskRef: 'task-1', workspace: 'ws', status: 'running', attention: false, boundChannels: ['telegram'], lastActivityAt: '2026-09-25T00:00:00.000Z', relativeTime: '2 min ago' } })
  assert.match(textOf(task), /2 min ago/)
  assert.doesNotMatch(textOf(task), /2026-09-25T00:00:00/)

  const channel = mod.__test.ChannelRow({ ctx, t, onOpen() {}, channel: { type: 'telegram', label: 'Telegram', capabilities: { notify: true, control: true }, health: { state: 'healthy' } } })
  assert.match(textOf(channel), /healthy/)

  const activity = mod.__test.ActivityRow({ ctx, item: { id: 'a1', at: '2026-09-25T00:00:00.000Z', timeText: 'just now', level: 'warn', title: 'Delivery warning' } })
  assert.match(textOf(activity), /just now/)
  assert.match(textOf(activity), /Delivery warning/)
  assert.doesNotMatch(textOf(activity), /2026-09-25T00:00:00/)
})

test('static safety invariants remain true', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const RPC_CHANNEL = '\/dsh-notifier'/)
  assert.doesNotMatch(source, /Authorization|Bearer|channels\.scan|esbuild|react-dom/)
  assert.doesNotMatch(source, /'_blank', 'noopener'/)
  // v0.15（Stage 1 / S2）：Native v2 只读入口只走窄动作表（快照 / 单渠道详情）。
  assert.match(source, /rpc\.call\('native\.snapshot'/)
  assert.match(source, /rpc\.call\('native\.channel'/)
  assert.match(source, /task\?\.relativeTime/)
  assert.match(source, /item\?\.timeText/)
  assert.match(source, /question\?\.multiple === true/)
  assert.match(source, /option\.value/)
  assert.match(source, /channel\?\.health\?\.state/)
  assert.match(source, /class ErrorBoundary extends Component/)
  assert.match(source, /data-error-code/)
  assert.match(source, /if \(fields\[key\]\?\.secret === true\) delete next\[key\]/)
})
