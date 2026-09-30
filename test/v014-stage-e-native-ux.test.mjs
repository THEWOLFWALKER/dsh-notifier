// v0.14 Stage E — Native-first UX completion 契约测试。
//
// 覆盖：
//   E1 破坏性操作统一二次确认（ConfirmButton 必须点两次才执行，取消不执行）；
//   E2 Session Detail（路由 / 出站 / 静默 / 控制 / 绑定）读取、控制覆盖层写入的 RPC 收敛；
//   E3 原始标识默认折叠 + 脱敏（RawIdentifiers / redactIdentifier）。
//
// 只断言「投影 + 写入口编排」：路由权威仍在 agent-router、控制归一在 session-arbiter，
// 本层不另造 authority。

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionsProjection } from '../src/control-surface/sessions.mjs'
import { createRoutingControlService } from '../src/control-plane/sessions.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'

// ————————————————————————— client.js 装载器（可控 React） —————————————————————————

/** 可控 React：useState 会真正保留状态，便于断言「点击后重渲染」的两步确认。 */
function controllableReact() {
  const noop = () => {}
  const states = []
  let cursor = 0
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
    useState(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    __resetCursor() { cursor = 0 },
    __states: states,
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

/** 收集渲染树里所有 button 节点的 onClick（用于模拟点击）。 */
function collectButtons(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const item of node) collectButtons(item, out); return out }
  if (typeof node === 'object') {
    if (node.type === 'button' && typeof node.props?.onClick === 'function') out.push(node.props.onClick)
    if (typeof node.type === 'function') collectButtons(node.type(node.props ?? {}), out)
    else collectButtons(node.children, out)
  }
  return out
}

function loadModule({ rpcCall } = {}) {
  const react = controllableReact()
  let source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  source = source.replace(
    "return {\n      inject: ['slots', 'connection', 'locale', 'layout'],",
    "return {\n      __test: { createController, ConfirmButton, redactIdentifier, RawIdentifiers, SessionDetailView },\n      inject: ['slots', 'connection', 'locale', 'layout'],",
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
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  })
  const ctx = {
    locale: { resolveText(value) { return typeof value === 'string' ? value : value?.en ?? '' } },
    connection: { rpc: { call: rpcCall ?? (async () => ({ ok: true, value: { revision: 0 } })) } },
  }
  return { mod, ctx, react }
}

// ————————————————————————— E1：破坏性确认 —————————————————————————

test('E1 confirm button requires a second click and cancel aborts', () => {
  const { mod, react } = loadModule()
  const t = key => key
  const calls = []
  const onConfirm = () => calls.push('confirmed')

  react.__resetCursor()
  const first = mod.__test.ConfirmButton({ children: 'Remove', confirmLabel: 'ConfirmRemove', t, onConfirm })
  // 首次渲染只有原按钮，确认词尚未出现。
  assert.match(textOf(first), /Remove/)
  assert.doesNotMatch(textOf(first), /ConfirmRemove/)

  // 第一次点击：只「武装」，未执行。
  const firstButtons = collectButtons(first)
  assert.equal(firstButtons.length, 1)
  react.__resetCursor()
  firstButtons[0]()
  assert.deepEqual(calls, [], '首次点击不得执行破坏性操作')

  // 重渲染后出现确认 / 取消两个按钮。
  react.__resetCursor()
  const armed = mod.__test.ConfirmButton({ children: 'Remove', confirmLabel: 'ConfirmRemove', t, onConfirm })
  assert.match(textOf(armed), /ConfirmRemove/)
  assert.match(textOf(armed), /cancelAction/)
  const armedButtons = collectButtons(armed)
  assert.equal(armedButtons.length, 2)

  // 点取消：不执行。
  react.__resetCursor()
  armedButtons[1]()
  assert.deepEqual(calls, [], '取消不得执行')

  // 点确认：执行一次。
  react.__resetCursor()
  armedButtons[0]()
  assert.deepEqual(calls, ['confirmed'])
})

// ————————————————————————— E3：脱敏 —————————————————————————

test('E3 redactIdentifier keeps only the edges of an identifier', () => {
  const { mod } = loadModule()
  const redact = mod.__test.redactIdentifier
  assert.equal(redact(''), '')
  assert.equal(redact('abcd'), 'a***')
  assert.equal(redact('1234567890'), '12***90')
  assert.equal(redact('telegram:1234567'), 'tel***567')
  assert.doesNotMatch(redact('telegram:1234567'), /telegram:1234567/)
})

test('E3 RawIdentifiers folds by default and only renders redacted values', () => {
  const { mod } = loadModule()
  const t = key => key
  const node = mod.__test.RawIdentifiers({ t, value: { userId: 'telegram-987654321', workspace: 'ws-a' } })
  // 折叠（details 未 open）+ 脱敏：完整标识不得出现在渲染文本里。
  assert.equal(node.type, 'details')
  assert.match(textOf(node), /viewRawIdentifiers/)
  assert.doesNotMatch(textOf(node), /telegram-987654321/)
  assert.match(textOf(node), /tel\*\*\*321/)
})

// ————————————————————————— E2：Session Detail —————————————————————————

test('E2 session detail loads sessions.detail and control write reuses it', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      if (endpoint === 'sessions.detail') {
        return { ok: true, value: { epoch: 'e', revision: 3, canPatch: true, canControl: true, session: { id: 's1', workspace: 'ws-a' } } }
      }
      return { ok: true, value: { epoch: 'e', revision: 4, id: 's1', control: { mode: 'team' } } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'session', id: 's1' })
  await controller.loadSession('s1')
  assert.equal(controller.getSnapshot().session.session.id, 's1')

  const written = await controller.patchSessionControl('s1', { mode: 'team' })
  assert.deepEqual(written.control, { mode: 'team' })
  assert.deepEqual(calls.map(c => c.endpoint), ['sessions.detail', 'sessions.control', 'sessions.detail'], '控制写入后必须重载详情')
  assert.equal(calls[1].payload.id, 's1')
  assert.equal(calls[1].payload.diff.mode, 'team')
  controller.dispose()
})

test('E2 session detail discards a stale load after navigating to another session', async () => {
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'sessions.detail') return { ok: true, value: { epoch: 'e', revision: 1, session: { id: payload.id } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'session', id: 's1' })
  const pending = controller.loadSession('s1')
  controller.navigate({ kind: 'session', id: 's2' })
  await pending
  assert.equal(controller.getSnapshot().session, null, '迟到响应不得写入已切走的会话详情')
  controller.dispose()
})

test('E2 session detail view renders routing / outbound / control / bindings sections', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = {
    async loadSession() { return {} }, reportError() {}, navigate() {},
    async patchSessionOutbound() { return {} }, async patchSessionControl() { return {} },
  }
  const view = mod.__test.SessionDetailView({
    ctx, t, controller,
    state: {
      view: { kind: 'session', id: 's1' },
      error: null, busy: {},
      session: {
        canPatch: true, canControl: true,
        session: {
          id: 's1', workspace: 'ws-a', inherit: 'project', active: true, lastActiveAt: '2026-01-01T00:00:00Z',
          resolved: { channelTypes: ['bark'], quiet: false, source: 'agent-workspace' },
          control: { mode: 'team', approvalOwnerOnly: true, ownerConfigured: true, approvalMembersCount: 2 },
          outbound: { quiet: false },
        },
      },
    },
  })
  const text = textOf(view)
  assert.match(text, /sessionDetail/)
  assert.match(text, /routingSection/)
  assert.match(text, /outboundSection/)
  assert.match(text, /controlSection/)
  assert.match(text, /bindingsSection/)
  assert.match(text, /ws-a/)
  assert.match(text, /bark/)
  assert.match(text, /modeTeam/)
  assert.match(text, /viewRawIdentifiers/)
  // 原始 outbound / 标识只在折叠的 raw 区出现，且详情正文不泄漏 id。
  assert.doesNotMatch(text, /"id": "s1"/)
})

test('E2 session detail hides control writes when the projection is read-only', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const controller = { async loadSession() { return {} }, reportError() {}, navigate() {} }
  const view = mod.__test.SessionDetailView({
    ctx, t, controller,
    state: {
      view: { kind: 'session', id: 's1' },
      error: null, busy: {},
      session: {
        canPatch: false, canControl: false,
        session: { id: 's1', workspace: 'ws-a', resolved: { channelTypes: ['bark'], quiet: false, source: 'global' } },
      },
    },
  })
  assert.doesNotMatch(textOf(view), /saveControl/)
  assert.match(textOf(view), /unavailable/)
})

// ————————————————————————— E2：投影 / 服务接线 —————————————————————————

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-stage-e-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { file }
}

const rig = ({ state = {}, active = [], enabled = [] } = {}) => {
  const { file } = tempState(state)
  const store = createStore(file)
  const router = createAgentRouter({ store, agentsList: () => [] })
  const registry = { getSession: () => undefined, isActive: (id) => active.includes(id) }
  const service = createRoutingControlService({ router, registry, store })
  const projection = createSessionsProjection({ service, enabledTypes: () => [...enabled] })
  return { store, service, projection }
}

test('E2 projection detail returns one row and rejects unknown sessions', () => {
  const { projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  assert.equal(projection.canDetail, true)
  assert.equal(projection.canControl, true)
  const { session } = projection.detail({ id: 's1' })
  assert.equal(session.id, 's1')
  assert.equal(session.workspace, 'ws-a')
  assert.deepEqual(session.resolved.channelTypes, ['bark'])
  assert.throws(() => projection.detail({ id: 'missing' }), (error) => error.code === 'not-found')
  assert.throws(() => projection.detail({ id: '  ' }), (error) => error.code === 'bad-request')
})

test('E2 projection patchControl merges into the router table without clobbering siblings', () => {
  const { store, projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a', inherit: 'project' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  const first = projection.patchControl({ id: 's1', diff: { mode: 'team' } })
  assert.deepEqual(first, { id: 's1', control: { mode: 'team' } })
  const second = projection.patchControl({ id: 's1', diff: { approvalOwnerOnly: true } })
  assert.deepEqual(second.control, { mode: 'team', approvalOwnerOnly: true }, '后一次写入不得清掉 mode')
  assert.equal(store.get('route:sessions').s1.workspace, 'ws-a', 'registry 字段不被覆盖')
})

test('E2 projection patchControl rejects source fields and unknown keys (fail-closed)', () => {
  const { store, projection } = rig({
    state: { 'route:sessions': { s1: { workspace: 'ws-a' } } },
    active: ['s1'],
    enabled: ['bark'],
  })
  for (const diff of [
    { channel: 'telegram' },
    { userId: 'u1' },
    { policyVersion: 2 },
    { owner: '*' },
    { mode: 'solo' },
    { approvalMembers: [{ channel: 'telegram', accountId: 'a', userId: 'u' }, { channel: '', accountId: 'a', userId: 'u' }] },
    {},
  ]) {
    assert.throws(() => projection.patchControl({ id: 's1', diff }), (error) => error.code === 'bad-request', `diff ${JSON.stringify(diff)} 必须被拒`)
  }
  assert.equal(store.get('route:sessions').s1.control, undefined, '非法写入零落盘')
})

test('E2 projection without the shared service is fail-closed (not-supported)', () => {
  const projection = createSessionsProjection({})
  assert.equal(projection.canDetail, false)
  assert.equal(projection.canControl, false)
  assert.throws(() => projection.detail({ id: 's1' }), (error) => error.code === 'not-supported')
  assert.throws(() => projection.patchControl({ id: 's1', diff: { mode: 'team' } }), (error) => error.code === 'not-supported')
})