import test from 'node:test'
import assert from 'node:assert/strict'
import { projectTasks, tasksSnapshot } from '../src/routing/task-projection.mjs'
import { createTaskSelection } from '../src/routing/task-selection.mjs'

/** 内存 store（Map 实现 get/set/delete/keys 的极简子集）。 */
function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get(key, fallback) { return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : fallback },
    set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); return true },
    delete(key) { const had = map.has(key); map.delete(key); return had },
    keys(prefix = '') { return [...map.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

/** 假 registry：activeSessions 返回给定 id 列表，getSession 返回台账记录。 */
function fakeRegistry(sessions = {}) {
  return {
    activeSessions: () => Object.keys(sessions),
    getSession: (id) => sessions[id],
  }
}

/** 假 router：resolveOutbound 返回给定 channels。 */
function fakeRouter(channelsBySession = {}) {
  return {
    resolveOutbound: (sid) => ({ channelTypes: channelsBySession[sid] ?? [] }),
  }
}

function fakeCtx(agents = {}) {
  return {
    agents: {
      list: () => Object.entries(agents).map(([id, agent]) => ({ id, ...agent })),
      get: (id) => agents[id],
    },
  }
}

test('task projection: exposes the frozen read-only shape', () => {
  const registry = fakeRegistry({
    'sid-a': { workspace: 'proj', lastActiveAt: 100 },
    'sid-b': { workspace: 'proj', lastActiveAt: 200 },
  })
  const ctx = fakeCtx({ 'sid-a': { status: 'running', header: { cwd: '/x/proj' } }, 'sid-b': { status: 'idle' } })
  const router = fakeRouter({ 'sid-a': ['telegram'], 'sid-b': ['feishu'] })
  const { tasks } = projectTasks({ registry, router, ctx, channelTypes: ['telegram', 'feishu'] })
  const keys = Object.keys(tasks[0]).sort()
  assert.deepEqual(keys, ['attention', 'boundChannels', 'lastActivityAt', 'status', 'taskRef', 'workspace'].sort())
  assert.deepEqual(tasks[0], {
    taskRef: 'sid-a', workspace: 'proj', status: 'running',
    attention: false, lastActivityAt: 100, boundChannels: ['telegram'],
  })
  // 无敏感字段：正文/凭证/回答/审批原因/绑定身份一律不出现
  for (const task of tasks) {
    const blob = JSON.stringify(task)
    assert.ok(!/answer|credential|token|reason|body|content|userId/.test(blob))
  }
})

test('task projection: is derived read-only (mutating result does not leak back)', () => {
  const registry = fakeRegistry({ 'sid-a': { workspace: 'proj', lastActiveAt: 100 } })
  const ctx = fakeCtx({ 'sid-a': { status: 'running' } })
  const deps = { registry, router: fakeRouter({}), ctx, channelTypes: [] }
  const first = projectTasks(deps)
  first.tasks[0].workspace = 'MUTATED'
  first.tasks[0].boundChannels.push('injected')
  first.tasks[0].attention = true
  const second = projectTasks(deps)
  assert.equal(second.tasks[0].workspace, 'proj')
  assert.deepEqual(second.tasks[0].boundChannels, [])
  assert.equal(second.tasks[0].attention, false)
})

test('task projection: attention is derived from the injected resolver', () => {
  const registry = fakeRegistry({ 'sid-a': { workspace: 'w', lastActiveAt: 1 }, 'sid-b': { workspace: 'w', lastActiveAt: 2 } })
  const ctx = fakeCtx({ 'sid-a': { status: 'idle' }, 'sid-b': { status: 'idle' } })
  const attention = new Set(['sid-b'])
  const { tasks } = projectTasks({ registry, router: fakeRouter({}), ctx, attentionOf: (id) => attention.has(id) })
  const byRef = Object.fromEntries(tasks.map((t) => [t.taskRef, t.attention]))
  assert.equal(byRef['sid-a'], false)
  assert.equal(byRef['sid-b'], true)
})

test('task projection: falls back to host agent list when registry is absent', () => {
  const ctx = fakeCtx({ 'sid-a': { status: 'running', header: { cwd: '/x/proj' } } })
  const { tasks, activitySorted } = projectTasks({ registry: null, router: fakeRouter({}), ctx })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskRef, 'sid-a')
  assert.equal(tasks[0].workspace, 'proj')
  assert.equal(tasks[0].status, 'running')
  assert.equal(activitySorted, false)
})

test('task selection: begin stores a pending selection and get reads it back', () => {
  const store = memoryStore()
  const sel = createTaskSelection({ store })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  const result = sel.begin(eg, ['sid-a', 'sid-b', 'sid-a'], '帮我构建')
  assert.deepEqual(result, { candidates: ['sid-a', 'sid-b'], originalText: '帮我构建', image: null })
  assert.equal(sel.has(eg), true)
  assert.deepEqual(sel.get(eg), { candidates: ['sid-a', 'sid-b'], originalText: '帮我构建', image: null })
})

test('task selection: resolving by number clears pending so original text delivers exactly once', () => {
  const store = memoryStore()
  const sel = createTaskSelection({ store })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  sel.begin(eg, ['sid-a', 'sid-b'], 'msg')
  const resolved = sel.resolve(eg, '2')
  assert.deepEqual(resolved, { ok: true, sessionId: 'sid-b', originalText: 'msg', image: null })
  assert.equal(sel.has(eg), false)
  // 二次消解 = no-pending：原消息不会二次投递
  assert.deepEqual(sel.resolve(eg, '1'), { ok: false, reason: 'no-pending', candidates: [] })
})

test('task selection: out-of-range number does not clear pending', () => {
  const store = memoryStore()
  const sel = createTaskSelection({ store })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  sel.begin(eg, ['sid-a'], 'msg')
  const bad = sel.resolve(eg, '99')
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'invalid')
  assert.deepEqual(bad.candidates, ['sid-a'])
  assert.equal(sel.has(eg), true)
})

test('task selection: expired pending is pruned and reads as absent', () => {
  const store = memoryStore()
  let clock = 0
  const sel = createTaskSelection({ store, now: () => clock, ttlMs: 1000 })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  sel.begin(eg, ['sid-a'], 'msg')
  assert.equal(sel.has(eg), true)
  clock = 2000
  sel.sweep()
  assert.equal(sel.has(eg), false)
})

test('task selection: pending view redacts originalText body', () => {
  const store = memoryStore()
  const sel = createTaskSelection({ store })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  sel.begin(eg, ['sid-a'], '机密正文')
  const rows = sel.pending()
  assert.equal(rows.length, 1)
  assert.equal('originalText' in rows[0], false)
  assert.equal(JSON.stringify(rows).includes('机密正文'), false)
  assert.deepEqual(rows[0].candidates, ['sid-a'])
})

test('task selection: missing store degrades to in-memory state without throwing', () => {
  const sel = createTaskSelection({ store: null })
  const eg = { channel: 'telegram', userId: 'u1', chatId: 'u1' }
  assert.equal(sel.has(eg), false)
  const result = sel.begin(eg, ['sid-a'], 'msg')
  assert.equal(result !== null, true)
  assert.equal(sel.has(eg), true)
})

test('tasks snapshot: exposes count and a defensive copy', () => {
  const registry = fakeRegistry({ 'sid-a': { workspace: 'proj', lastActiveAt: 1 } })
  const ctx = fakeCtx({ 'sid-a': { status: 'running' } })
  const snap = tasksSnapshot({ registry, router: fakeRouter({}), ctx })
  assert.equal(snap.count, 1)
  assert.equal(snap.tasks[0].taskRef, 'sid-a')
})