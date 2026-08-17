// v0.3.2 装配与分流回归（设计稿 §7 index 装配 + §8-5 工具分流）。
// 四个切面：
//  1) notify 工具分流：execContext 带 agentId 时广播按 agent 绑定通道过滤；
//     无 execContext / 无 router / 解析异常一律回落旧版全局广播（逐字节一致，向后兼容）；
//     单渠道路径与 rateLimiter 不受影响；quiet 永不作用于工具（agent 显式要求推送）。
//  2) index 装配：store 前移 + router/registry 创建 + 旧 bind 绑定迁移进 route:sessions
//     + registry.dispose 幂等 + 路由引擎三导出。
//  3) 审批分流：request.agent 可解析时 notifyAll 只发绑定通道；无 agent 回落全局广播。
//  4) 事件分流（event-listener 第 4 参 wiring）：quiet=true 只静音出站推送（不实际发送）
//     但仍走 notifyAll；registry.touch 收到活跃信号。
// harness 全部复用既有测试模式（fake ctx/notifier、globalThis.fetch 打桩），零第三方 mock。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as indexExports from '../src/index.mjs'
import { apply } from '../src/index.mjs'
import { registerNotifyTool } from '../src/tool-register.mjs'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createEventListener } from '../src/event-listener.mjs'
import { createNotifier } from '../src/notify.mjs'
import { resolveConfig } from '../src/config.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-notifier-wiring-'))
}

/** fake tools ctx（tool-register.test.mjs 同款）。 */
function fakeTools() {
  const defs = []
  const ctx = { tools: { register(def) { defs.push(def); return () => {} } } }
  return { ctx, defs }
}

/** fake notifier（tool-register.test.mjs 同款；notifyAll 可按 ...args 记录参数个数）。 */
function fakeNotifier(overrides = {}) {
  return {
    notify: async (channel, msg) => ({ ok: true, skipped: false, channel, error: undefined }),
    notifyAll: async (msg) => ({ ok: true, delivered: ['webhook'], failed: [] }),
    channelCount: 1,
    channels: ['webhook'],
    ...overrides,
  }
}

/** boot ctx（index.test.mjs 同款）。 */
function bootCtx() {
  const warnings = []
  const listeners = {}
  const defs = []
  const effects = []
  return {
    warnings,
    listeners,
    defs,
    effects,
    ctx: {
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      tools: { register(def) { defs.push(def); return () => {} } },
      on(event, fn) { (listeners[event] ??= []).push(fn); return () => {} },
      effect(fn) { effects.push(fn) },
    },
  }
}

// ---------------------------------------------------------------- notify 工具分流

test('notify 工具分流：execContext.agent.id 存在时 notifyAll 收到 channelTypes（quiet 不透传）', async () => {
  const { ctx, defs } = fakeTools()
  const calls = []
  const notifier = fakeNotifier({
    notifyAll: async (msg, options) => { calls.push({ msg, options }); return { ok: true, delivered: ['telegram'], failed: [] } },
  })
  const router = {
    resolveOutbound: () => ({ channelTypes: ['telegram'], quiet: true, source: 'agent-workspace' }),
  }
  registerNotifyTool(ctx, notifier, { router, channelTypes: () => ['telegram', 'webhook'] })
  const result = await defs[0].execute(
    { message: 'hi', title: 'T' },
    { agent: { id: 'agent-1', header: { cwd: '/tmp/ws-a' } } },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.delivered, ['telegram'])
  assert.equal(calls.length, 1)
  assert.deepEqual(
    calls[0].options,
    { channelTypes: ['telegram'] },
    '第二参只带 channelTypes；quiet 永不作用于工具（agent 显式要求推送，静音只管事件自动推送）',
  )
  assert.deepEqual(calls[0].msg, { title: 'T', content: 'hi' })
})

test('notify 工具分流：execContext.agent.session.id 与 execContext.session.id 两级兜底', async () => {
  const { ctx, defs } = fakeTools()
  const resolvedArgs = []
  const router = {
    resolveOutbound: (sessionId, workspace, globalTypes) => {
      resolvedArgs.push({ sessionId, workspace, globalTypes })
      return { channelTypes: ['webhook'], quiet: false, source: 'global' }
    },
  }
  const notifier = fakeNotifier({
    notifyAll: async (msg, options) => ({ ok: true, delivered: options.channelTypes, failed: [] }),
  })
  registerNotifyTool(ctx, notifier, { router, channelTypes: () => ['webhook'] })
  await defs[0].execute({ message: 'a' }, { agent: { session: { id: 's-via-session', header: { cwd: '/tmp/proj-a' } } } })
  await defs[0].execute({ message: 'b' }, { session: { id: 's-direct', header: { cwd: '/tmp/proj-b' } } })
  assert.equal(resolvedArgs.length, 2)
  assert.equal(resolvedArgs[0].sessionId, 's-via-session', 'agent.session.id 兜底')
  assert.equal(resolvedArgs[0].workspace, 'proj-a', 'workspaceOf 从 agent.session.header.cwd 取末段')
  assert.equal(resolvedArgs[1].sessionId, 's-direct', 'execContext.session.id 兜底')
  assert.equal(resolvedArgs[1].workspace, 'proj-b')
  assert.deepEqual(resolvedArgs[0].globalTypes, ['webhook'])
})

test('notify 工具分流：无 execContext 时行为与旧版逐字节一致', async () => {
  const { ctx, defs } = fakeTools()
  const calls = []
  const notifier = fakeNotifier({
    notifyAll: async (...args) => { calls.push(args); return { ok: true, delivered: ['webhook', 'bark'], failed: [] } },
  })
  registerNotifyTool(ctx, notifier, {
    router: { resolveOutbound: () => { throw new Error('无 execContext 不应触达 router') } },
    channelTypes: () => ['webhook'],
  })
  const result = await defs[0].execute({ message: 'hi' })
  assert.deepEqual(result, { ok: true, delivered: ['webhook', 'bark'], failed: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1, '旧版签名：notifyAll 只收一个 message 参数')
  assert.deepEqual(calls[0][0], { title: '', content: 'hi' })
})

test('notify 工具分流：未注入 router 时不受影响（即便带 execContext.agent.id）', async () => {
  const { ctx, defs } = fakeTools()
  const calls = []
  const notifier = fakeNotifier({
    notifyAll: async (...args) => { calls.push(args); return { ok: true, delivered: ['webhook'], failed: [] } },
  })
  registerNotifyTool(ctx, notifier, { channelTypes: () => ['webhook'] })
  await defs[0].execute({ message: 'hi' }, { agent: { id: 'agent-9' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1, 'router 缺省 = 旧版全局广播（向后兼容）')
})

test('notify 工具分流：resolveOutbound 抛错时回落全局广播', async () => {
  const { ctx, defs } = fakeTools()
  const calls = []
  const notifier = fakeNotifier({
    notifyAll: async (...args) => { calls.push(args); return { ok: true, delivered: ['webhook'], failed: [] } },
  })
  registerNotifyTool(ctx, notifier, {
    router: { resolveOutbound: () => { throw new Error('解析炸了') } },
    channelTypes: () => ['webhook'],
  })
  const result = await defs[0].execute({ message: 'hi' }, { agent: { id: 'agent-x' } })
  assert.equal(result.ok, true, '解析异常不弄崩工具调用')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 1, '异常回落 = 无第二参的全局广播')
})

test('notify 工具分流：单渠道路径不注入 channelTypes（notify 原样两参）', async () => {
  const { ctx, defs } = fakeTools()
  const notifyCalls = []
  const notifier = fakeNotifier({
    notify: async (...args) => { notifyCalls.push(args); return { ok: true, skipped: false, channel: 'webhook', error: undefined } },
    notifyAll: async () => { throw new Error('单渠道路径不应走 notifyAll') },
  })
  registerNotifyTool(ctx, notifier, {
    router: { resolveOutbound: () => { throw new Error('单渠道路径不应触达 router') } },
  })
  const result = await defs[0].execute({ message: 'hi', channel: 'webhook' }, { agent: { id: 'agent-1' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.delivered, ['webhook'])
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].length, 2, 'notify 保持旧签名 (channel, message)')
  assert.equal(notifyCalls[0][0], 'webhook')
  assert.deepEqual(notifyCalls[0][1], { title: '', content: 'hi' })
})

test('notify 工具分流：channelTypes 未提供时回落 notifier.channels 作为全局池', async () => {
  const { ctx, defs } = fakeTools()
  const resolvedArgs = []
  const router = {
    resolveOutbound: (sessionId, workspace, globalTypes) => {
      resolvedArgs.push({ sessionId, workspace, globalTypes })
      return { channelTypes: ['bark'], quiet: false, source: 'agent-exact' }
    },
  }
  const notifier = fakeNotifier({ channels: ['webhook', 'bark', 'telegram'] })
  registerNotifyTool(ctx, notifier, { router }) // 不传 channelTypes
  await defs[0].execute({ message: 'hi' }, { agent: { id: 'agent-1' } })
  assert.equal(resolvedArgs.length, 1)
  assert.equal(resolvedArgs[0].sessionId, 'agent-1')
  assert.deepEqual(resolvedArgs[0].globalTypes, ['webhook', 'bark', 'telegram'], '缺省回落 notifier.channels')
})

// ---------------------------------------------------------------- index 装配

test('index 装配：预置 bind:telegram:u1 旧绑定 → apply 后 route:sessions 出现 u1 目标会话最小记录', () => {
  const stateDir = tempDir()
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ 'bind:telegram:u1': 'sess-legacy' }))
  const { ctx, warnings } = bootCtx()
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { allowUsers: ['u1'], stateDir },
  })
  const sessions = createStore(join(stateDir, 'state.json')).get('route:sessions')
  const record = sessions?.['sess-legacy']
  assert.ok(record !== undefined, 'route:sessions 应出现旧绑定会话的最小记录（迁移生效）')
  assert.equal(record.inherit, '', 'inherit 空串占位（等 agent/created 或出站事件补全）')
  assert.equal(record.workspace, '', 'workspace 空串占位')
  assert.equal(typeof record.createdAt, 'number')
  assert.equal(typeof record.lastActiveAt, 'number')
  assert.ok(warnings.some((w) => /迁移/.test(w)), 'migrated > 0 应 warn')
})

test('index 装配：apply 返回 resolved；createAgentRouter/createSessionRegistry/workspaceOf 三导出可用', () => {
  const { ctx } = bootCtx()
  const resolved = apply(ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  assert.deepEqual(resolved.channels.map((entry) => entry.type), ['webhook'])
  assert.equal(typeof indexExports.createAgentRouter, 'function')
  assert.equal(typeof indexExports.createSessionRegistry, 'function')
  assert.equal(typeof indexExports.workspaceOf, 'function')
  assert.equal(indexExports.workspaceOf({ header: { cwd: '/tmp/dsh-notifier' } }), 'dsh-notifier')
})

test('index 装配：registry.dispose 幂等——apply 两次并重复执行清理不抛', () => {
  const stateDir = tempDir()
  const { ctx, effects } = bootCtx()
  const config = {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { allowUsers: ['u1'], stateDir },
  }
  apply(ctx, config)
  apply(ctx, config)
  assert.equal(effects.length, 2)
  assert.doesNotThrow(() => { for (const cleanup of effects) cleanup() })
  assert.doesNotThrow(() => { for (const cleanup of effects) cleanup() }, '重复清理（含 registry.dispose 二次调用）不抛')
})

test('index 装配冒烟：注入的真 router 生效——route:agents 绑定让 notify 工具广播只发绑定通道', async () => {
  const originalFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => { hits.push(String(url)); return { ok: true, status: 200, json: async () => ({ code: 200 }) } }
  try {
    const stateDir = tempDir()
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
      'route:agents': { 'ws-a': { channels: ['webhook'] } },
    }))
    const { ctx, defs } = bootCtx()
    apply(ctx, {
      channels: [
        { type: 'webhook', url: 'http://bound/hook' },
        { type: 'bark', key: 'k1' },
      ],
      inbound: { stateDir },
    })
    const notifyTool = defs.find((def) => def.name === 'notify')
    assert.ok(notifyTool !== undefined)
    const result = await notifyTool.execute({ message: 'hi' }, { agent: { id: 'agent-1', header: { cwd: '/x/ws-a' } } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.delivered, ['webhook'], 'workspace ws-a 只绑定 webhook（bark 被过滤）')
    assert.deepEqual(hits, ['http://bound/hook'], 'bark 未被路由命中，不应实际发送')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- 审批分流（approval/router deps.router）

/** 新契约假交互通道（approval.multi.test.mjs makeFake 同款，精简版）。 */
function makeFakeInbound(channel, targets = []) {
  const state = { cards: [], edits: [] }
  return {
    channel,
    state,
    notifyTargets: () => targets,
    async sendApprovalCard(payload) { state.cards.push(payload); return { messageId: `m${state.cards.length}` } },
    async editResolved(target, text) { state.edits.push({ target, text }) },
    async sendText() { return true },
  }
}

/** 审批 rig：真 bus/vault/store + 假 ctx/notifier（spy notifyAll 第二参）。 */
function makeApprovalRig({ interactive = [], routerFactory = null, notifierChannels = [] } = {}) {
  const store = createStore(join(tempDir(), 'state.json'))
  const vault = createTokenVault({ secret: 'wiring-secret' })
  const bus = createInboundBus({ allowUsers: ['u1', 'u2'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } } }
  const broadcasts = []
  const notifier = {
    channels: notifierChannels,
    notifyAll: async (msg, options) => { broadcasts.push({ msg, options }); return { ok: true, delivered: [], skipped: [], failed: [] } },
  }
  const router = routerFactory !== null ? routerFactory(store) : null
  const dispose = registerApprovalHandler({
    ctx,
    notifier,
    bus,
    vault,
    store,
    interactive,
    approvalConfig: { mode: 'answer', timeoutMs: 400 },
    ...(router !== null ? { router } : {}),
  })
  const handle = (request) => handlers['approval/request'](request, () => 'desktop')
  return { store, bus, broadcasts, dispose, handle }
}

test('审批分流：request.agent 有 id 时 notifyAll 收到的 channelTypes 只含绑定通道；无关交互渠道不发卡片', async () => {
  const feishu = makeFakeInbound('feishu', [{ chatId: 'oc_chat001', userId: 'u1' }])
  const qq = makeFakeInbound('qq', [{ chatId: 'opengrp01', userId: 'u2' }])
  const rig = makeApprovalRig({
    interactive: [feishu, qq],
    notifierChannels: ['webhook', 'qq'],
    routerFactory: (store) => {
      store.set('route:agents', { 'ws-a': { channels: ['qq'] } })
      return createAgentRouter({ store, agentsList: () => [] })
    },
  })
  const outcome = rig.handle({ toolName: 'bash', callId: 'c1', agent: { id: 'ws-a' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(rig.broadcasts[0].options, { channelTypes: ['qq'] }, '审批只发该 agent 绑定的通道')
  assert.equal(qq.state.cards.length, 1, '绑定的 qq 收到卡片')
  assert.equal(feishu.state.cards.length, 0, '未绑定的 feishu 不发卡片')
  const card = qq.state.cards[0]
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'rejected', token: card.token, via: 'qq:button', userId: 'u2' })
  assert.equal(await outcome, 'rejected')
  rig.dispose()
})

test('审批分流：request 无 agent 时回落全局广播（第二参空对象，卡片照发）', async () => {
  const qq = makeFakeInbound('qq', [{ chatId: 'opengrp01', userId: 'u2' }])
  const rig = makeApprovalRig({
    interactive: [qq],
    notifierChannels: ['webhook', 'qq'],
    routerFactory: (store) => createAgentRouter({ store, agentsList: () => [] }),
  })
  const outcome = rig.handle({ toolName: 'bash', callId: 'c1' }) // 无 agent 字段
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(rig.broadcasts[0].options, {}, '无 agent = 不分流，全局广播')
  assert.equal(qq.state.cards.length, 1, '全局广播下交互渠道照常收卡片')
  rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'opengrp01', messageId: 'msg:1:opengrp01', text: '1' })
  assert.equal(await outcome, 'allowed-once')
  rig.dispose()
})

// ---------------------------------------------------------------- 事件分流（event-listener 第 4 参 wiring）

function fakeListenerCtx() {
  const listeners = {}
  const ctx = {
    logger: { warn() {} },
    on(event, fn) { (listeners[event] ??= []).push(fn); return () => {} },
  }
  return { ctx, listeners }
}

/** 真 notifier + webhook/bark 渠道（notify.test.mjs 的 makeNotifier 同款思路）。 */
function makeRealNotifier(channels) {
  const resolved = resolveConfig({ channels })
  assert.equal(resolved.skipped.length, 0)
  return createNotifier({ logger: { warn() {} } }, resolved.channels)
}

test('事件分流：resolveOutbound 返回 quiet=true → notifyAll 收到 { channelTypes, quiet: true } 且不实际发送；registry.touch 被调用', async () => {
  const originalFetch = globalThis.fetch
  const fetches = []
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, status: 200, json: async () => ({ code: 200 }) } }
  try {
    const { ctx, listeners } = fakeListenerCtx()
    const notifier = makeRealNotifier([{ type: 'webhook', url: 'http://quiet/hook' }])
    const seenOptions = []
    const rawNotifyAll = notifier.notifyAll.bind(notifier)
    notifier.notifyAll = async (msg, options) => { seenOptions.push(options); return rawNotifyAll(msg, options) }
    const touched = []
    const router = { resolveOutbound: () => ({ channelTypes: ['webhook'], quiet: true, source: 'session' }) }
    const registry = { touch: (id) => touched.push(id) }
    const resolved = { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' }
    const dispose = createEventListener(ctx, notifier, resolved, { router, registry })
    listeners['session/event'][0](
      { id: 's9', header: { cwd: '/tmp/ws' }, events: [] },
      { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(seenOptions, [{ channelTypes: ['webhook'], quiet: true }], 'quiet=true 透传给 notifyAll')
    assert.deepEqual(touched, ['s9'], 'registry.touch 收到会话活跃信号')
    assert.equal(fetches.length, 0, 'quiet 会话不实际发送（静音只静出站推送，不吞事件线）')
    dispose()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('事件分流：quiet=false 时按 channelTypes 分流，只实际发送绑定通道（正控）', async () => {
  const originalFetch = globalThis.fetch
  const fetches = []
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, status: 200, json: async () => ({ code: 200 }) } }
  try {
    const { ctx, listeners } = fakeListenerCtx()
    const notifier = makeRealNotifier([
      { type: 'webhook', url: 'http://only-bound/hook' },
      { type: 'bark', key: 'k1' },
    ])
    const seenOptions = []
    const rawNotifyAll = notifier.notifyAll.bind(notifier)
    notifier.notifyAll = async (msg, options) => { seenOptions.push(options); return rawNotifyAll(msg, options) }
    const touched = []
    const router = { resolveOutbound: () => ({ channelTypes: ['webhook'], quiet: false, source: 'agent-workspace' }) }
    const registry = { touch: (id) => touched.push(id) }
    const resolved = { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' }
    const dispose = createEventListener(ctx, notifier, resolved, { router, registry })
    listeners['session/event'][0](
      { id: 's10', header: { cwd: '/tmp/ws' }, events: [] },
      { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(seenOptions, [{ channelTypes: ['webhook'], quiet: false }])
    assert.deepEqual(fetches, ['http://only-bound/hook'], '只发送路由命中的 webhook，bark 被过滤')
    assert.deepEqual(touched, ['s10'])
    dispose()
  } finally {
    globalThis.fetch = originalFetch
  }
})
