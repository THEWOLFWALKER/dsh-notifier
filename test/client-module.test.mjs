import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function fakeReact() {
  const noop = () => {}
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
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
    if (typeof value === 'object') visit(value.children)
  }
  visit(node)
  return chunks.join('')
}

function loadModule({ rpcCall } = {}) {
  let source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  source = source.replace(
    "return {\n      inject: ['slots', 'connection', 'locale', 'layout'],",
    "return {\n      __test: { createController, launchAdvancedConsole, QuestionCard, TaskRow, ChannelRow, ActivityRow },\n      inject: ['slots', 'connection', 'locale', 'layout'],",
  )
  assert.match(source, /__test:/)
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } }, open() { return null } },
    document: {
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
  assert.equal(panellist.options.label(), 'Notify & Control')
  for (const d of effects.reverse()) d()
})

test('advanced console keeps popup handle, severs opener, renders disabled state', async () => {
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, location: { replaced: null, replace(url) { this.replaced = url } } }
  const { mod } = loadModule()
  const calls = []
  const result = mod.__test.launchAdvancedConsole(
    { async createStandaloneLaunch() { return { available: false, reason: 'disabled' } } },
    key => key,
    { open(url, target, features) { calls.push({ url, target, features }); return popup } },
  )
  assert.equal(result.opened, true)
  assert.equal(popup.opener, null)
  assert.deepEqual(calls[0], { url: 'about:blank', target: '_blank', features: undefined })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(popup.document.body.textContent, 'advancedDisabled')
  assert.equal(popup.location.replaced, null)
})

test('advanced console navigates the retained popup on successful launch', async () => {
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, location: { replaced: null, replace(url) { this.replaced = url } } }
  const { mod } = loadModule()
  mod.__test.launchAdvancedConsole(
    { async createStandaloneLaunch() { return { available: true, url: 'http://127.0.0.1:8104/#ticket=fake' } } },
    key => key,
    { open() { return popup } },
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(popup.opener, null)
  assert.equal(popup.location.replaced, 'http://127.0.0.1:8104/#ticket=fake')
})

test('question conflict race normalizes to alreadyHandled and refreshes home', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(channel, endpoint) {
      calls.push({ channel, endpoint })
      if (endpoint === 'questions.settle') return { ok: false, error: { code: 'dsh-notifier/conflict', message: 'already handled' } }
      if (endpoint === 'surface.home') return { ok: true, value: { revision: 3, summary: { status: 'healthy', detail: 'ok' }, questions: [], tasks: [], channels: [], activity: [] } }
      return { ok: true, value: { revision: 3 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  const result = await controller.settleQuestion('q1', 'reject', [])
  assert.deepEqual({ settled: result.settled, alreadyHandled: result.alreadyHandled }, { settled: false, alreadyHandled: true })
  assert.equal(calls.filter(x => x.endpoint === 'surface.home').length, 1)
  controller.dispose()
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
  assert.match(source, /windowObject\.open\('about:blank', '_blank'\)/)
  assert.match(source, /popup\.opener = null/)
  assert.match(source, /'aria-label': t\('advanced'\)/)
  assert.match(source, /task\?\.relativeTime/)
  assert.match(source, /item\?\.timeText/)
  assert.match(source, /question\?\.multiple === true/)
  assert.match(source, /option\.value/)
  assert.match(source, /channel\?\.health\?\.state/)
})
