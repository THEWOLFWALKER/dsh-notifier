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
    "return {\n      __test: { createController, HelpView, NotifySettingsView, buildSupportReport },\n      inject: ['slots', 'connection', 'locale', 'layout'],",
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

test('controller keeps only Native and live secondary methods', () => {
  const { mod, ctx } = loadModule()
  const controller = mod.__test.createController(ctx)
  const removed = ['loadHome', 'loadChannels', 'loadTasks', 'loadQuestions', 'loadMembers', 'loadPending', 'loadPairingCodes', 'loadSessions', 'loadSession', 'loadBindings', 'loadActivity', 'loadDiagnostics', 'updateMember', 'removeMember', 'approvePending', 'dismissPending', 'mintPairingCode', 'revokePairingCode', 'patchSessionOutbound', 'patchSessionControl', 'putBindings', 'settleQuestion', 'saveChannel', 'testChannel']
  for (const name of removed) assert.equal(name in controller, false, `${name} must not be exposed by client.js`)
  for (const name of ['loadNative', 'loadNativeChannel', 'nativeSettlePending', 'nativeSaveChannel', 'nativeTestChannel', 'exportConfig', 'previewImport', 'commitImport', 'cloudCall', 'validateRemoteUrl', 'generateSupportReport']) {
    assert.equal(typeof controller[name], 'function', `${name} remains an active UI flow`)
  }
  controller.dispose()
})

test('controller treats Native epoch change as restart and clears stale Native cache', async () => {
  let epoch = 'epoch-a'
  let revision = 9
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'native.snapshot') return { ok: true, value: { epoch, revision, rail: [], channels: [], pending: [] } }
      if (endpoint === 'native.channel') return { ok: true, value: { epoch, revision, channel: { id: payload.type } } }
      return { ok: true, value: { epoch, revision } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadNative()
  await controller.loadNativeChannel('telegram')
  epoch = 'epoch-b'
  revision = 1
  await controller.loadNative()
  const restarted = controller.getSnapshot()
  assert.equal(restarted.epoch, 'epoch-b')
  assert.equal(restarted.revision, 1, '新 epoch 的低 revision 不得被旧进程高 revision 压住')
  assert.equal(restarted.nativeChannel, null, 'epoch 变化必须清除旧进程 Native 详情')
  controller.dispose()
})

test('Native channel navigation clears previous details before the next request resolves', async () => {
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'native.channel') return { ok: true, value: { epoch: 'e', revision: 1, channel: { id: payload.type } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'native-channel', type: 'telegram' })
  await controller.loadNativeChannel('telegram')
  assert.equal(controller.getSnapshot().nativeChannel.channel.id, 'telegram')
  controller.navigate({ kind: 'native-channel', type: 'feishu' })
  assert.equal(controller.getSnapshot().nativeChannel, null, 'B 详情加载前不得短暂显示 A 的数据')
  controller.dispose()
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
  assert.equal('diagnostics' in controller.getSnapshot(), false, '诊断快照只用于生成支持报告，不缓存为日常状态')
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



test('static safety invariants remain true', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const RPC_CHANNEL = '\/dsh-notifier'/)
  assert.doesNotMatch(source, /Authorization|Bearer|channels\.scan|esbuild|react-dom/)
  assert.doesNotMatch(source, /'_blank', 'noopener'/)
  // v0.15（Stage 1 / S2）：Native v2 只读入口只走窄动作表（快照 / 单渠道详情）。
  assert.match(source, /rpc\.call\('native\.snapshot'/)
  assert.match(source, /rpc\.call\('native\.channel'/)
  for (const method of ['surface.home', 'channels.list', 'channels.save', 'channels.test', 'tasks.list', 'questions.list', 'questions.settle', 'members.list', 'pairing.list', 'sessions.list', 'sessions.patch', 'sessions.control', 'bindings.get', 'bindings.put', 'activity.list']) {
    assert.equal(source.includes(method), false, `client.js must not retain obsolete RPC ${method}`)
  }
  assert.match(source, /class ErrorBoundary extends Component/)
  assert.match(source, /data-error-code/)
})
