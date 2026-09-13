import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminApi } from '../src/admin/api.mjs'
import { createAdminServer } from '../src/admin/server.mjs'

// v0.10 提交7：管理台暴露 DSH 连接与任务状态（/api/tasks 与 /api/host）。
// 函数层：getTasks 返回任务投影脱敏快照；getHostCapabilities 返回宿主能力快照；
// 二者在依赖缺失/ctx 缺档时安全降级且绝不带敏感字段。
// HTTP 层：两条只读路由的鉴权与路由分发（fake api 契约解耦，不 import api.mjs）。

/** 极简 registry 桩：activeSessions + getSession（任务投影的数据源）。 */
function fakeRegistry(sessions = {}) {
  return {
    activeSessions: () => Object.keys(sessions),
    getSession: (id) => sessions[id],
  }
}

/** 极简 router 桩：resolveOutbound 恒返回给定 channels。 */
function fakeRouter(channels = []) {
  return { resolveOutbound: () => ({ channelTypes: channels }) }
}

/** ctx 桩：带 agents.list/get 与版本 + userQuestions（可选）。 */
function fakeCtx(agents = [], extra = {}) {
  return {
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
    },
    ...extra,
  }
}

function makeApi(overrides = {}) {
  return createAdminApi({
    router: fakeRouter(['telegram']),
    registry: fakeRegistry({}),
    store: { get: () => undefined, set: () => true, delete: () => false, keys: () => [] },
    channelsEnabled: () => ['telegram'],
    ...overrides,
  })
}

test('getTasks: 返回只读任务投影快照，字段冻结且不含敏感域', () => {
  const registry = fakeRegistry({
    'sid-a': { workspace: 'proj', lastActiveAt: 200 },
    'sid-b': { workspace: 'proj', lastActiveAt: 100 },
  })
  const ctx = fakeCtx([
    { id: 'sid-a', status: 'running' },
    { id: 'sid-b', status: 'idle' },
  ])
  const api = makeApi({ registry, ctx, attentionOf: (id) => id === 'sid-a' })
  const snap = api.getTasks()
  assert.equal(snap.count, 2)
  assert.equal(snap.tasks.length, 2)
  for (const task of snap.tasks) {
    assert.deepEqual(
      Object.keys(task).sort(),
      ['attention', 'boundChannels', 'lastActivityAt', 'status', 'taskRef', 'workspace'].sort(),
    )
    assert.ok(task.taskRef === 'sid-a' || task.taskRef === 'sid-b')
    assert.ok(!/answer|credential|token|content|userId|chatId/.test(JSON.stringify(task)))
  }
  assert.equal(snap.tasks.find((t) => t.taskRef === 'sid-a').attention, true)
  assert.equal(snap.tasks.find((t) => t.taskRef === 'sid-b').attention, false)
})

test('getTasks: ctx/registry 缺档安全降级为零任务，绝不抛', () => {
  const api = makeApi({ registry: null, ctx: null, attentionOf: null })
  const snap = api.getTasks()
  assert.deepEqual(snap, { count: 0, activitySorted: false, tasks: [] })
})

test('getHostCapabilities: 返回五域快照且归一枚举', () => {
  const ctx = fakeCtx([], { version: '0.1.0-rc.6', on() {} })
  const api = makeApi({
    ctx,
    hostSnapshot: () => ({ events: { 'session/event': { received: 3, lastAt: 7 } } }),
    questionsFallbackEnabled: true,
    webLocal: 'available',
    imageInput: 'available',
  })
  const snap = api.getHostCapabilities()
  assert.deepEqual(Object.keys(snap).sort(), ['conversation', 'events', 'host', 'media', 'questions'].sort())
  assert.deepEqual(snap.host, { version: '0.1.0-rc.6' })
  assert.equal(snap.events.mode, 'current')
  assert.deepEqual(snap.events.received, { 'session/event': { received: 3, lastAt: 7 } })
  assert.equal(snap.questions.mode, 'plugin-tool-fallback')
  assert.equal(snap.questions.webLocal, 'available')
  assert.equal(snap.media.imageInput, 'available')
  assert.ok(!/sessionId|token|secret|credential|chatId|userId/.test(JSON.stringify(snap)))
})

test('getHostCapabilities: hostSnapshot 抛错/缺失按空事件降级，绝不抛', () => {
  const api = makeApi({ ctx: {}, hostSnapshot: () => { throw new Error('boom') } })
  const snap = api.getHostCapabilities()
  assert.deepEqual(snap.events.received, {})
  assert.equal(snap.events.mode, 'unsupported')
})

test('getHostCapabilities: ctx 抛错代理也不冒泡（查询方法红线：绝不抛）', () => {
  const throwingCtx = new Proxy({}, {
    get() { throw new Error('ctx getter boom') },
  })
  const api = makeApi({ ctx: throwingCtx })
  const snap = api.getHostCapabilities()
  assert.ok(snap && typeof snap === 'object')
  assert.equal(snap.host.version, 'unknown')
})

// ———————— HTTP 层：只读路由鉴权 + 分发 ————————

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

async function withServer(overrides = {}, fn) {
  const api = {
    getTasks: async () => ({ count: 1, activitySorted: true, tasks: [{ taskRef: 'sid-a' }] }),
    getHostCapabilities: async () => ({ host: { version: '0.1.0' } }),
    ...overrides,
  }
  const server = createAdminServer({
    api,
    verifyToken: (token) => token === 'secret',
    host: '127.0.0.1',
    port: 0,
    ui: '',
    logger: { warn: () => {} },
  })
  const info = await server.start()
  try {
    await fn({ base: `http://127.0.0.1:${info.port}`, api })
  } finally {
    await server.stop()
  }
}

test('GET /api/tasks 与 /api/host：鉴权通过返回 200 + api 结果；缺 token 401', async () => {
  await withServer({}, async ({ base }) => {
    const auth = { Authorization: 'Bearer secret' }
    const tasksRes = await fetch(`${base}/api/tasks`, { headers: auth })
    assert.equal(tasksRes.status, 200)
    assert.equal((await tasksRes.json()).count, 1)

    const hostRes = await fetch(`${base}/api/host`, { headers: auth })
    assert.equal(hostRes.status, 200)
    assert.deepEqual(await hostRes.json(), { host: { version: '0.1.0' } })

    // 没 token：/api/* 一律 401（对探测者只回 401，不泄露路由存在性）
    const noAuth = await fetch(`${base}/api/tasks`)
    assert.equal(noAuth.status, 401)
    await tick(0)
  })
})