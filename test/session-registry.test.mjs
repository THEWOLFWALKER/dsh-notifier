// v0.3.2 测试：routing/session-registry（会话生命周期、摊销写盘、惰性回收、迁移、防御）。
// mock 三件套：ctx（事件收集 + 可手动触发 + 可摘除的 agents.list）、内存 store（带写盘计数）、
// 可变时钟（now 注入，touch 摊销与 ttl 回收全部离线可测，不依赖真实时间流逝）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRegistry, workspaceOf } from '../src/routing/session-registry.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 内存 mock store：接口对齐 src/inbound/store.mjs（get/set/delete/keys/sweepPrefix），附写盘计数。 */
function makeStore(initial = {}) {
  const state = { ...initial }
  const writes = { count: 0, keys: [] }
  return {
    state,
    writes,
    get(key, fallback = undefined) { return key in state ? state[key] : fallback },
    set(key, value) { writes.count += 1; writes.keys.push(key); state[key] = value },
    delete(key) { const existed = key in state; delete state[key]; return existed },
    keys(prefix = '') { return Object.keys(state).filter((key) => key.startsWith(prefix)) },
    sweepPrefix(prefix, isExpired) {
      let removed = 0
      for (const key of Object.keys(state)) {
        if (!key.startsWith(prefix)) continue
        if (isExpired(key, state[key])) { delete state[key]; removed += 1 }
      }
      return removed
    },
  }
}

/** mock ctx：on 收集 listener 可手动触发；agents.list 可选（可运行时删字段模拟不可用）。 */
function makeCtx({ agents, withAgents = true, onThrows = false } = {}) {
  const handlers = new Map()
  const agentList = agents !== undefined ? [...agents] : []
  const ctx = {}
  if (withAgents) {
    ctx.agents = {
      list: () => agentList,
      get: (id) => agentList.find((agent) => agent.id === id),
    }
  }
  ctx.on = (event, handler) => {
    if (onThrows) throw new Error(`宿主无 ${event} 事件`)
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => { handlers.set(event, handlers.get(event).filter((h) => h !== handler)) }
  }
  return { ctx, handlers, agentList }
}

/** registry rig：可变时钟 + mock store/ctx；raw() 直读内存台账。 */
function makeRegistry({
  agents, withAgents = true, onThrows = false, store, ttlHours, touchWriteMs, sweepEveryMs, ctx,
} = {}) {
  const clock = { t: 1_000_000 }
  const mockStore = store ?? makeStore()
  const mock = ctx !== undefined ? { handlers: new Map(), agentList: [] } : makeCtx({ agents, withAgents, onThrows })
  const registry = createSessionRegistry({
    ctx: ctx ?? mock.ctx,
    store: mockStore,
    now: () => clock.t,
    ...(ttlHours !== undefined ? { ttlHours } : {}),
    ...(touchWriteMs !== undefined ? { touchWriteMs } : {}),
    ...(sweepEveryMs !== undefined ? { sweepEveryMs } : {}),
  })
  const fire = (event, payload) => { for (const handler of mock.handlers.get(event) ?? []) handler(payload) }
  const raw = () => mockStore.state['route:sessions']
  return { registry, clock, store: mockStore, fire, raw, agentList: mock.agentList }
}

const agentOf = (id, cwd) => (cwd === undefined ? { id } : { id, header: { cwd } })

// ---- workspaceOf（纯函数）----

test('workspaceOf：三种 cwd 形态（header / session.header / 直挂）都取 basename 末段', () => {
  assert.equal(workspaceOf({ header: { cwd: '/home/u/proj-a' } }), 'proj-a')
  assert.equal(workspaceOf({ id: 'agent-9', session: { id: 's', header: { cwd: '/srv/另一个项目' } } }), '另一个项目')
  assert.equal(workspaceOf({ cwd: '/a/b/c' }), 'c')
})

test('workspaceOf：cwd 全取不到时回落 id（含 session.id 包裹）；无线索时空串', () => {
  assert.equal(workspaceOf({ id: 'sid-1', status: 'idle' }), 'sid-1')
  assert.equal(workspaceOf({ session: { id: 'inner-2' } }), 'inner-2')
  assert.equal(workspaceOf({ header: { cwd: '' } , id: 'x' }), 'x') // 空 cwd 不算取到
  assert.equal(workspaceOf({}), '')
  assert.equal(workspaceOf(null), '')
})

// ---- ensureSession / 事件接线 ----

test('ensureSession：建档字段齐全（inherit=workspace 名）且落在 route:sessions 键下', () => {
  const { registry, raw } = makeRegistry()
  const record = registry.ensureSession(agentOf('s1', '/home/u/proj-a'))
  assert.equal(record.inherit, 'proj-a')
  assert.equal(record.workspace, 'proj-a')
  assert.equal(record.createdAt, 1_000_000)
  assert.equal(record.lastActiveAt, 1_000_000)
  assert.equal(record.disposedAt, undefined)
  assert.deepEqual(Object.keys(raw()).sort(), ['s1'])
  assert.equal(raw().s1.workspace, 'proj-a') // 台账持久化在 route:sessions 单键下
})

test('ensureSession：重复 created 只刷新 lastActiveAt，不覆盖 createdAt/workspace/outbound', () => {
  const { registry, clock } = makeRegistry()
  registry.ensureSession(agentOf('s1', '/w/alpha'))
  registry.setOutbound('s1', { channels: ['bark'], quiet: true })
  clock.t += 5_000
  registry.ensureSession(agentOf('s1', '/w/beta')) // 同 id 重建（换了 cwd）
  const record = registry.getSession('s1')
  assert.equal(record.createdAt, 1_000_000) // 创建时间不被覆盖
  assert.equal(record.lastActiveAt, 1_005_000) // 只刷新活跃时间
  assert.equal(record.workspace, 'alpha') // 非空快照不覆盖
  assert.deepEqual(record.outbound, { channels: ['bark'], quiet: true }) // 覆盖层 diff 保留
})

test('事件接线：agent/created 建档、agent/disposed 标记（容忍 { session } 包裹形态）', () => {
  const { registry, fire, raw } = makeRegistry({ ttlHours: 1 / 3600 })
  fire('agent/created', agentOf('s1', '/home/u/proj-a'))
  assert.equal(raw()?.s1?.workspace, 'proj-a')
  fire('agent/disposed', agentOf('s1'))
  assert.equal(raw().s1.disposedAt, 1_000_000)
  fire('agent/disposed', { session: { id: 's2' } }) // agent/error 总线负载形态
  assert.equal(raw().s2.disposedAt, 1_000_000)
  registry.dispose()
})

// ---- touch（摊销写盘）----

test('touch：摊销窗口 0 时每次都真写 store', () => {
  const { registry, store } = makeRegistry({ touchWriteMs: 0 })
  registry.ensureSession(agentOf('s1', '/w/p'))
  const before = store.writes.count
  registry.touch('s1')
  registry.touch('s1')
  assert.equal(store.writes.count, before + 2)
})

test('touch：大窗口内不写盘（内存态实时）跨窗后才真写', () => {
  const { registry, store, clock } = makeRegistry({ touchWriteMs: 60_000 })
  registry.ensureSession(agentOf('s1', '/w/p'))
  const before = store.writes.count
  clock.t += 1_000
  const touched = registry.touch('s1')
  assert.equal(store.writes.count, before) // 窗内：不写盘
  assert.equal(touched.lastActiveAt, 1_001_000) // 但内存态已刷新（摊销只影响落盘）
  clock.t += 60_000 // 距上次写盘超过窗口
  registry.touch('s1')
  assert.equal(store.writes.count, before + 1)
})

test('touch：记录不存在时忽略（不建档不写盘不抛）', () => {
  const { registry, store } = makeRegistry()
  assert.equal(registry.touch('ghost'), undefined)
  assert.equal(registry.getSession('ghost'), undefined)
  assert.equal(store.writes.count, 0)
})

// ---- markDisposed / reactive（生命周期）----

test('markDisposed：记 disposedAt、记录保留（不删）、isActive 转 false', () => {
  const { registry, clock } = makeRegistry({ withAgents: false, ttlHours: 1 / 3600 })
  registry.ensureSession(agentOf('s1', '/w/p'))
  assert.equal(registry.isActive('s1'), true)
  clock.t += 2_000
  registry.markDisposed('s1')
  const record = registry.getSession('s1')
  assert.equal(record.disposedAt, 1_002_000)
  assert.ok(record !== undefined && record.workspace === 'p') // 记录保留（24h 保留窗）
  assert.equal(registry.isActive('s1'), false)
  registry.dispose()
})

test('markDisposed：幂等——再次 dispose 不改 disposedAt', () => {
  const { registry, clock } = makeRegistry({ ttlHours: 1 / 3600 })
  registry.ensureSession(agentOf('s1'))
  registry.markDisposed('s1')
  clock.t += 9_000
  registry.markDisposed('s1')
  assert.equal(registry.getSession('s1').disposedAt, 1_000_000)
  registry.dispose()
})

test('markDisposed：未知会话惰性建档并标记（降级模式防御）', () => {
  const { registry } = makeRegistry({ ttlHours: 1 / 3600 })
  const record = registry.markDisposed('never-seen')
  assert.equal(record.disposedAt, 1_000_000)
  assert.equal(record.workspace, '') // 最小记录占位
  assert.equal(registry.getSession('never-seen').disposedAt, 1_000_000)
  registry.dispose()
})

test('reactive：resume 清 disposedAt 并刷新 lastActiveAt', () => {
  const { registry, clock } = makeRegistry({ withAgents: false, ttlHours: 1 / 3600 })
  registry.ensureSession(agentOf('s1', '/w/p'))
  registry.markDisposed('s1')
  clock.t += 3_000
  const record = registry.reactive('s1')
  assert.equal(record.disposedAt, undefined)
  assert.equal(record.lastActiveAt, 1_003_000)
  assert.equal(registry.isActive('s1'), true)
  registry.dispose()
})

test('resume：已 dispose 的会话再次 agent/created 也清 disposedAt', () => {
  const { registry, fire } = makeRegistry({ ttlHours: 1 / 3600 })
  fire('agent/created', agentOf('s1', '/w/p'))
  fire('agent/disposed', agentOf('s1'))
  fire('agent/created', agentOf('s1', '/w/p')) // 同 id 重建（resume）
  assert.equal(registry.getSession('s1').disposedAt, undefined)
  assert.equal(registry.getSession('s1').createdAt, 1_000_000) // createdAt 仍是首建时间
  registry.dispose()
})

// ---- sweep / 惰性回收 ----

test('sweep：按 ttl 回收过期 disposed 记录，未到期与未 disposed 的保留', () => {
  const t = 1_000_000
  const seeded = makeStore({
    'route:sessions': {
      old: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0, disposedAt: t - 40_000 },
      fresh: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0, disposedAt: t - 100 },
      alive: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0 },
    },
  })
  const { registry } = makeRegistry({ store: seeded, ttlHours: 0.01, sweepEveryMs: Number.MAX_SAFE_INTEGER })
  assert.deepEqual(registry.sweep(), ['old'])
  assert.equal(registry.getSession('old'), undefined)
  assert.equal(registry.getSession('fresh').disposedAt, t - 100) // 未到期保留（供重连）
  assert.ok(registry.getSession('alive') !== undefined) // 从未 dispose 的永不回收
})

test('惰性回收：首次调用启动清理；sweepEveryMs=0 每次真扫；大间隔时摊销不真扫', () => {
  const seed = () => makeStore({
    'route:sessions': { old: { inherit: '', workspace: '', createdAt: 0, lastActiveAt: 0, disposedAt: 960_000 } },
  })
  // 摊销窗口再大，构造后的首次内联 prune 也真扫一次（清掉停机期间过期的记录）
  const startup = makeRegistry({ store: seed(), ttlHours: 0.01, sweepEveryMs: Number.MAX_SAFE_INTEGER })
  assert.equal(startup.registry.getSession('old'), undefined)
  // sweepEveryMs=0：常规读即真扫
  const eager = makeRegistry({ store: seed(), ttlHours: 0.01, sweepEveryMs: 0 })
  assert.equal(eager.registry.getSession('old'), undefined)
  // 大间隔：启动清理过后，窗口内新增的过期记录不被内联扫掉，显式 sweep 才回收
  const lazy = makeRegistry({ store: seed(), ttlHours: 0.01, sweepEveryMs: Number.MAX_SAFE_INTEGER })
  lazy.registry.getSession('old') // 消耗掉启动清理
  lazy.store.state['route:sessions'].old2 = { inherit: '', workspace: '', createdAt: 0, lastActiveAt: 0, disposedAt: 960_000 }
  assert.ok(lazy.registry.getSession('old2') !== undefined) // 摊销窗口内：不真扫
  assert.deepEqual(lazy.registry.sweep(), ['old2']) // 显式 sweep 总是真扫
})

test('定时兜底：dispose 后 ttl 到期点自动回收（短 ttl 注入）', async () => {
  const { registry, clock, raw } = makeRegistry({ ttlHours: 1 / 3600 }) // ttl = 1s
  registry.ensureSession(agentOf('s1', '/w/p'))
  registry.markDisposed('s1')
  clock.t += 2_000 // 时钟推过到期点（定时回调里的过期判定用注入时钟）
  await sleep(1_300) // 定时兜底（1s）触发
  assert.equal(raw().s1, undefined)
  assert.equal(registry.getSession('s1'), undefined)
  registry.dispose()
})

// ---- inbound 挂钩 ----

test('attachInbound/detachInbound：去重追加、移除、摘空删键、未知会话惰性建档', () => {
  const { registry } = makeRegistry()
  registry.ensureSession(agentOf('s1', '/w/p'))
  registry.attachInbound('s1', { channel: 'telegram', userId: '42' })
  registry.attachInbound('s1', { channel: 'telegram', userId: '42' }) // 重复：去重
  registry.attachInbound('s1', { channel: 'bark', userId: '42' }) // 不同通道：追加
  assert.deepEqual(registry.getSession('s1').inbound, [
    { channel: 'telegram', userId: '42' },
    { channel: 'bark', userId: '42' },
  ])
  registry.detachInbound('s1', { channel: 'telegram', userId: '42' })
  assert.deepEqual(registry.getSession('s1').inbound, [{ channel: 'bark', userId: '42' }])
  registry.detachInbound('s1', { channel: 'bark', userId: '42' })
  assert.equal(registry.getSession('s1').inbound, undefined) // 摘空后整键移除
  registry.detachInbound('s1', { channel: 'nope', userId: '1' }) // 不存在的绑定：安全无操作
  assert.ok(registry.getSession('s1') !== undefined)
  const lazy = registry.attachInbound('s-new', { channel: 'qq', userId: '7' }) // 未知会话惰性建档
  assert.equal(lazy.workspace, '')
  assert.deepEqual(lazy.inbound, [{ channel: 'qq', userId: '7' }])
  assert.equal(registry.attachInbound('s2', {}), undefined) // 无效绑定：不建档不变更
  assert.equal(registry.getSession('s2'), undefined)
})

// ---- outbound 覆盖层 ----

test('setOutbound：字段级 diff 合并、undefined 删键、惰性建档、置空整键移除', () => {
  const { registry } = makeRegistry()
  registry.ensureSession(agentOf('s1', '/w/p'))
  registry.setOutbound('s1', { channels: ['telegram'] })
  registry.setOutbound('s1', { channels: ['bark', 'qq'], quiet: true }) // 字段级合并（非整替）
  assert.deepEqual(registry.getSession('s1').outbound, { channels: ['bark', 'qq'], quiet: true })
  registry.setOutbound('s1', { quiet: undefined }) // undefined 值 = 删该键
  assert.deepEqual(registry.getSession('s1').outbound, { channels: ['bark', 'qq'] })
  registry.setOutbound('s1', { channels: undefined })
  assert.equal(registry.getSession('s1').outbound, undefined) // 全删后 outbound 键移除
  const lazy = registry.setOutbound('ghost', { channels: ['bark'] }) // 未知会话惰性建档
  assert.equal(lazy.workspace, '')
  assert.deepEqual(lazy.outbound, { channels: ['bark'] })
})

// ---- 迁移兼容 ----

test('migrateLegacyBinds：为 bind:* 旧值补最小记录，跳过已有与非字符串，返回迁移数', () => {
  const seeded = makeStore({
    'bind:telegram:42': 's1',
    'bind:telegram:43': 's2',
    'bind:bark:7': 12345, // 非字符串值：跳过
    'bind:qq:1': 's3',
  })
  const { registry, clock } = makeRegistry({ store: seeded })
  registry.ensureSession(agentOf('s3', '/w/known')) // s3 已有记录：不迁移
  assert.equal(registry.migrateLegacyBinds(), 2)
  const s1 = registry.getSession('s1')
  assert.equal(s1.inherit, '') // 最小记录：空串占位
  assert.equal(s1.workspace, '')
  assert.equal(s1.createdAt, 1_000_000)
  assert.equal(registry.getSession('s2') !== undefined, true)
  assert.equal(registry.getSession('s3').workspace, 'known')
  clock.t += 4_000
  registry.ensureSession(agentOf('s1', '/w/proj')) // 等 agent/created 再补全占位
  const filled = registry.getSession('s1')
  assert.equal(filled.workspace, 'proj')
  assert.equal(filled.inherit, 'proj')
  assert.equal(filled.createdAt, 1_000_000) // 迁移建档时间保留
  assert.equal(registry.migrateLegacyBinds(), 0) // 再跑一次：全部已存在
})

// ---- 活跃集合与消歧 ----

test('activeSessions：与 agents.list 交集优先（list 中无记录的活跃 id 不列出），按 lastActiveAt 降序', () => {
  const { registry, clock } = makeRegistry({ agents: [{ id: 's1' }, { id: 's0' }, { id: 's-live' }] })
  registry.ensureSession(agentOf('s1', '/w/a'))
  clock.t += 500
  registry.ensureSession(agentOf('s0', '/w/a')) // 更晚活跃
  registry.ensureSession(agentOf('s3', '/w/b')) // 有记录但不在 agents.list（如已退出）
  assert.deepEqual(registry.activeSessions(), ['s0', 's1']) // 交集 + 降序；s-live（在 list 无记录）与 s3 不列出
  assert.equal(registry.isActive('s-live'), true) // 单点判活以宿主为准（交集只约束列表 API）
  assert.equal(registry.isActive('s3'), false)
})

test('agents.list 不可用时：activeSessions 回落未 disposed 记录，isActive 同步回落', () => {
  const { registry } = makeRegistry({ withAgents: false, ttlHours: 1 / 3600 })
  registry.ensureSession(agentOf('s1', '/w/a'))
  registry.ensureSession(agentOf('s2', '/w/a'))
  registry.markDisposed('s2')
  assert.deepEqual(registry.activeSessions(), ['s1'])
  assert.equal(registry.isActive('s1'), true)
  assert.equal(registry.isActive('s2'), false)
  assert.equal(registry.isActive('ghost'), false)
  registry.dispose()
})

test('sessionsOfWorkspace：活跃优先，含 disposed 未回收的标记', () => {
  const { registry } = makeRegistry({ agents: [{ id: 's1' }], ttlHours: 1 / 3600 })
  registry.ensureSession(agentOf('s1', '/w/proj'))
  registry.ensureSession(agentOf('s2', '/w/proj'))
  registry.ensureSession(agentOf('s9', '/w/other')) // 别的工作区：不出现
  registry.markDisposed('s2')
  const rows = registry.sessionsOfWorkspace('proj')
  assert.deepEqual(rows.map((row) => row.id), ['s1', 's2']) // 活跃在前
  assert.equal(rows[0].active, true)
  assert.equal(rows[0].disposedAt, undefined)
  assert.equal(rows[1].active, false)
  assert.equal(typeof rows[1].disposedAt, 'number') // disposed 未回收：标记呈现
  assert.deepEqual(registry.sessionsOfWorkspace('none'), [])
  registry.dispose()
})

test('latestActiveOf：返回 lastActiveAt 最大者；忽略未建档 id；全无则 undefined', () => {
  const { registry, clock } = makeRegistry()
  registry.ensureSession(agentOf('s1', '/w/a'))
  clock.t += 700
  registry.ensureSession(agentOf('s2', '/w/a'))
  clock.t += 100
  registry.touch('s1') // s1 反超为最近活跃
  assert.equal(registry.latestActiveOf(['s1', 's2']), 's1')
  assert.equal(registry.latestActiveOf(['s2', 's1']), 's1')
  assert.equal(registry.latestActiveOf(['s1', 'ghost']), 's1')
  assert.equal(registry.latestActiveOf(['ghost']), undefined)
  assert.equal(registry.latestActiveOf([]), undefined)
  assert.equal(registry.latestActiveOf(undefined), undefined)
})

// ---- dispose / 防御 ----

test('dispose：反注册事件、清理定时兜底（记录不被兜底回收）、重复调用安全', async () => {
  const { registry, fire, clock } = makeRegistry({ ttlHours: 1 / 3600 })
  fire('agent/created', agentOf('s1', '/w/p'))
  fire('agent/disposed', agentOf('s1')) // 排了一个 1s 的兜底定时器
  registry.dispose()
  clock.t += 3_000
  await sleep(1_300) // 定时器已被清理：不应触发回收
  assert.ok(registry.getSession('s1') !== undefined)
  fire('agent/created', agentOf('s2', '/w/q')) // 事件已反注册：不再建档
  assert.equal(registry.getSession('s2'), undefined)
  assert.deepEqual(registry.sweep(), ['s1']) // 显式 sweep 仍可回收
  registry.dispose() // 重复 dispose：安全无操作
})

test('防御：ctx 缺失 / ctx.on 抛错 / store 缺失——绝不抛，降级为惰性建档模式', () => {
  const clock = { t: 500 }
  // ctx 完全缺失
  const bare = createSessionRegistry({ store: makeStore(), now: () => clock.t })
  assert.equal(bare.ensureSession(agentOf('s1', '/w/p')).workspace, 'p')
  assert.equal(bare.isActive('s1'), true) // 回落语义：未 disposed 即活跃
  bare.dispose()
  // ctx.on 对所有事件抛错（宿主无事件总线）
  const hostile = makeRegistry({ onThrows: true })
  assert.equal(hostile.registry.ensureSession(agentOf('s2', '/w/p')).workspace, 'p')
  hostile.registry.dispose()
  // store 缺失：内存态照常工作
  const memoryOnly = createSessionRegistry({ ctx: null, now: () => clock.t })
  assert.equal(memoryOnly.ensureSession(agentOf('s3', '/w/p')).workspace, 'p')
  assert.equal(memoryOnly.getSession('s3').inherit, 'p')
  memoryOnly.dispose()
})
