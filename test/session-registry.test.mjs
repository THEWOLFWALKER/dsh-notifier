// v0.3.2 测试：routing/session-registry（会话生命周期、摊销写盘、惰性回收、迁移、防御）。
// mock 三件套：ctx（事件收集 + 可手动触发 + 可摘除的 agents.list）、内存 store（带写盘计数）、
// 可变时钟（now 注入，touch 摊销与 ttl 回收全部离线可测，不依赖真实时间流逝）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRegistry, workspaceOf } from '../src/routing/session-registry.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

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

test('事件接线：DSH documented { agent } 生命周期载荷在 root fallback 上建档和标记', () => {
  const handlers = new Map()
  const root = {
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(listener)
      return () => { handlers.set(event, handlers.get(event).filter((entry) => entry !== listener)) }
    },
  }
  root.root = root
  const ctx = { root, on() { throw new Error('scoped child must not receive host subscription') } }
  const { registry, raw } = makeRegistry({ ctx })
  const agent = agentOf('s-root', '/work/root-project')
  handlers.get('agent/created')[0]({ agent })
  assert.equal(raw()['s-root'].workspace, 'root-project')
  handlers.get('agent/disposed')[0]({ agent })
  assert.equal(raw()['s-root'].disposedAt, 1_000_000)
  registry.dispose()
})

// ---- touch（摊销写盘）----

test('touch：摊销窗口 0 时每次都真写 store', () => {
  const { registry, store } = makeRegistry({ touchWriteMs: 0 })
  registry.ensureSession(agentOf('s1', '/w'))
  const before = store.writes.count
  registry.touch('s1')
  registry.touch('s1')
  assert.equal(store.writes.count, before + 2)
})

test('touch：大窗口内不写盘（内存态实时）跨窗后才真写', () => {
  const { registry, store, clock } = makeRegistry({ touchWriteMs: 60_000 })
  registry.ensureSession(agentOf('s1', '/w'))
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
  registry.ensureSession(agentOf('s1', '/w'))
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
  fire('agent/created', agentOf('s1', '/w'))
  fire('agent/disposed', agentOf('s1'))
  fire('agent/created', agentOf('s1', '/w')) // 同 id 重建（resume）
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
  // 大间隔：启动清理过后，窗口内新增的过期记录不被内联扫掉，显式 sweep 才回收。
  // （v0.8.7 起注册表 persist 按值落盘，不再与 store.state 共享对象引用——窗口内新记录必须经
  //  注册表 API 建档才是 sweep 扫描的回收域；直接改 store.state 不再是注册表内记录。）
  const lazy = makeRegistry({ store: seed(), ttlHours: 0.01, sweepEveryMs: Number.MAX_SAFE_INTEGER })
  lazy.registry.getSession('old') // 消耗掉启动清理
  lazy.registry.ensureSession(agentOf('old2', '/w/p'))
  lazy.registry.markDisposed('old2')
  lazy.clock.t += 60_000 // 把 old2 推到 ttl 到期之后（ttl=36s），且晚于末次真扫
  assert.ok(lazy.registry.getSession('old2') !== undefined) // 摊销窗口内：内联读不真扫
  assert.deepEqual(lazy.registry.sweep(), ['old2']) // 显式 sweep 总是真扫
})

test('定时兜底：dispose 后 ttl 到期点自动回收（短 ttl 注入）', async () => {
  const { registry, clock, raw } = makeRegistry({ ttlHours: 1 / 3600 }) // ttl = 1s
  registry.ensureSession(agentOf('s1', '/w'))
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
  registry.ensureSession(agentOf('s1', '/w'))
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
  registry.ensureSession(agentOf('s1', '/w'))
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
  fire('agent/created', agentOf('s1', '/w'))
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

// ---- Stage 4：会话控制覆盖层（getControl / setControl / clearControl）----

test('setControl/getControl：minimal 覆盖层只落已批准字段，来源字段被丢弃，read 为深拷贝', () => {
  const { registry, raw } = makeRegistry()
  const rec = registry.setControl('s1', { mode: 'team', owner: 'u1', approvalOwnerOnly: true, approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }] })
  assert.equal(rec.control.mode, 'team')
  assert.deepEqual(registry.getControl('s1'), {
    mode: 'team', owner: 'u1', approvalOwnerOnly: true,
    approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }],
  })
  // copy-on-read：改返回值不污染内部
  const copy = registry.getControl('s1')
  copy.approvalOwnerOnly = false
  copy.approvalMembers[0].userId = 'hacked'
  assert.equal(registry.getControl('s1').approvalOwnerOnly, true)
  assert.equal(registry.getControl('s1').approvalMembers[0].userId, 'u2')
  // 来源字段绝不进店
  const hostile = registry.setControl('s1', { channel: 'feishu', accountId: 'z1', userId: 'evil', chatId: 'c9', sessionId: 's9' })
  assert.deepEqual(hostile.control, {
    mode: 'team', owner: 'u1', approvalOwnerOnly: true,
    approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }],
  })
  // 直接内存直写来源字段，下一次读/写即清洗
  raw().s1.control = { ...raw().s1.control, channel: 'feishu' }
  const cleaned = registry.getControl('s1')
  assert.equal('channel' in cleaned, false)
})

test('setControl 字段级 diff：null 删键、未出现键不动、个人默认 safe', () => {
  const { registry } = makeRegistry()
  registry.setControl('s1', { mode: 'team', owner: 'u1', approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }] })
  // 仅改 approvalOwnerOnly：其余保留
  let rec = registry.setControl('s1', { approvalOwnerOnly: true })
  assert.deepEqual(registry.getControl('s1'), {
    mode: 'team', owner: 'u1', approvalOwnerOnly: true,
    approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }],
  })
  // null 删键：owner 回退 basePolicy（个人）/默认
  rec = registry.setControl('s1', { owner: null })
  assert.equal(registry.getControl('s1').owner, undefined)
  // 清空全部后 control 键移除
  const emptied = registry.setControl('s1', { mode: null, approvalOwnerOnly: null, approvalMembers: null })
  assert.equal(registry.getControl('s1'), undefined)
  assert.equal('control' in emptied, false)
})

test('getControl/clearControl：损坏子键按缺失处理，clear 幂等并保留无关键', () => {
  const store = makeStore({ 'route:sessions': { 's1': { inherit: 'w', workspace: 'w', control: 'not-an-object' } } })
  const { registry, raw } = makeRegistry({ store })
  assert.equal(registry.getControl('s1'), undefined) // 损坏覆盖层 → undefined（按缺失处理）
  const clearedCorrupt = registry.clearControl('s1') // 损坏时 clear 仍删掉损坏子键
  assert.equal(clearCorruptControlKey(clearedCorrupt), true)
  // 正常覆盖 + 无关键保留（v0.8.7 起持久化按值落盘：clear 返回值反映注册表内存态，
  // 无关键的「保留」以盘上为准——clear 写盘只收走 control 键，绝不动 inbound 等兄弟键。
  // 注入无关键须经落盘（store.set) 而非引用直改，与真实 createStore 值语义一致。）
  registry.setControl('s2', { owner: 'u1' })
  const s2base = store.state['route:sessions'].s2
  store.set('route:sessions', { ...store.state['route:sessions'], s2: { ...s2base, inbound: [{ channel: 'telegram', userId: 'u9' }] } })
  const cleared = registry.clearControl('s2')
  assert.equal(registry.getControl('s2'), undefined)
  assert.equal(cleared.control, undefined) // 内存态返回已无 control
  assert.deepEqual(raw().s2.inbound, [{ channel: 'telegram', userId: 'u9' }]) // 无关键在盘上保留
  assert.equal(registry.getControl('nonexistent'), undefined)
  assert.equal(registry.clearControl('nonexistent'), undefined)
})

function clearCorruptControlKey(record) {
  return record !== undefined && record.control === undefined
}

test('setControl 越界/通配静默清洗：>128 owner、通配成员、超 64 项全部落不下', () => {
  const { registry } = makeRegistry()
  const computers = []
  for (let i = 0; i < 70; i++) computers.push({ channel: 'telegram', accountId: 'a1', userId: `u${i}` })
  registry.setControl('s1', { owner: 'x'.repeat(129), approvalMembers: computers })
  assert.equal(registry.getControl('s1').owner, undefined)          // >128 owner 被清洗
  assert.equal(registry.getControl('s1').approvalMembers.length, 64) // 成员封顶 64
  // 全通配/全局补丁：覆盖层里没有任何有效字段剩余 → 整键移除
  registry.setControl('s1', { owner: '*', approvalMembers: [{ channel: 'all', accountId: 'a1', userId: 'u9' }] })
  assert.equal(registry.getControl('s1'), undefined)
})

// ---- v0.8.7 跨组件回归：route:sessions 分写修复（P1-1）----
// 共享同一 store 的**真实 router + 真实 registry**。router.setSessionControl 把覆盖层直接落盘，
// 而 registry 生命周期 persist 现按「新鲜盘上基底 + 记录级合并」写回——保证生命周期写不再抹掉
// router 刚设的 control，也不再删掉 registry 内存态从未见过的跨会话记录。

/** 跨组件 rig：同一 store 上真实 router + 真实 registry + 可变时钟。 */
function crossRig({ ttlHours = 0.01 } = {}) {
  const clock = { t: 1_000_000 }
  const store = makeStore()
  const { ctx } = makeCtx({ withAgents: true })
  const registry = createSessionRegistry({
    store, ctx, now: () => clock.t, ttlHours,
    touchWriteMs: 0, // 每次生命周期写都立即落盘（放大「是否抹掉」的观察面）
    sweepEveryMs: Number.MAX_SAFE_INTEGER, // 默认不内联真扫（显式 sweep 才回收）
  })
  const router = createAgentRouter({ store, agentsList: () => [] })
  return { store, registry, router, clock }
}

test('跨组件：router 设的 control，registry.touch 生命周期写不抹掉（P1-1）', () => {
  const { store, registry, router } = crossRig()
  registry.ensureSession(agentOf('s1', '/w'))     // registry 先建档 s1（内存态无 control）
  router.setSessionControl('s1', { owner: 'u1' })   // router 把 control 写进盘的 s1——registry 缓存不知道
  registry.touch('s1')                              // 生命周期写：persist 现按新鲜基底合并
  assert.equal(store.state['route:sessions'].s1.control.owner, 'u1') // control 未被抹掉
  // 对照组：没有记录级合并修复时，registry 整缓存 persist 会把盘上 control 抹成 undefined
  assert.equal(store.state['route:sessions'].s1.inherit, 'w') // 生命周期字段仍在
})

test('跨组件收敛：router 后写 outbound/control 覆盖层，registry 生命周期写保留最新值', () => {
  const { store, registry, router, clock } = crossRig()
  registry.ensureSession(agentOf('s1', '/w'))
  registry.setOutbound('s1', { channels: ['bark'], quiet: false })
  router.setSessionOutbound('s1', { channels: ['telegram'], quiet: true })
  router.setSessionControl('s1', { owner: 'router' })
  clock.t += 1
  registry.touch('s1')
  assert.deepEqual(store.state['route:sessions'].s1.outbound, { channels: ['telegram'], quiet: true })
  assert.equal(store.state['route:sessions'].s1.control.owner, 'router')
})

test('跨组件收敛：router 先写 outbound，registry 后写其他字段不回退 router 渠道', () => {
  const { store, registry, router } = crossRig()
  router.setSessionOutbound('s1', { channels: ['telegram'] })
  registry.setOutbound('s1', { quiet: true })
  assert.deepEqual(store.state['route:sessions'].s1.outbound, { channels: ['telegram'], quiet: true })
})

test('registry 读取收敛：router 写入后 getSession/getOutbound/getControl 立即可见且深拷贝隔离', () => {
  const { store, registry, router } = crossRig()
  router.setSessionOutbound('s1', { channels: ['telegram'], quiet: true })
  router.setSessionControl('s1', { owner: 'u1', approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }] })
  const session = registry.getSession('s1')
  assert.deepEqual(session.outbound, { channels: ['telegram'], quiet: true })
  assert.deepEqual(registry.getOutbound('s1'), { channels: ['telegram'], quiet: true })
  assert.equal(registry.getControl('s1').owner, 'u1')
  session.outbound.channels.push('evil')
  const outbound = registry.getOutbound('s1')
  outbound.channels.push('evil')
  assert.deepEqual(registry.getOutbound('s1'), { channels: ['telegram'], quiet: true })
  assert.equal(registry.getControl('s1').approvalMembers[0].userId, 'u2')
  assert.equal(store.state['route:sessions'].s1.control.owner, 'u1')
})

test('生命周期写前规范化：未缓存会话的损坏 control 也会被清洗并保留兄弟字段', () => {
  const store = makeStore({
    'route:sessions': {
      uncached: {
        workspace: 'w',
        control: { owner: '*', channel: 'evil', approvalMembers: [{ channel: 'all', userId: 'u' }] },
        inbound: [{ channel: 'telegram', userId: 'u9' }],
      },
    },
  })
  const { registry } = makeRegistry({ store, touchWriteMs: 0, sweepEveryMs: Number.MAX_SAFE_INTEGER })
  registry.ensureSession(agentOf('new', '/new'))
  assert.equal(store.state['route:sessions'].uncached.control, undefined)
  assert.deepEqual(store.state['route:sessions'].uncached.inbound, [{ channel: 'telegram', userId: 'u9' }])
})

test('跨组件：router 才建档的会话，registry.ensureSession 的 persist 不删它、不碰其 control（P1-1）', () => {
  const { store, registry, router } = crossRig()
  registry.ensureSession(agentOf('s2', '/w'))     // registry 内存态只有 s2
  router.setSessionControl('s1', { owner: 'u1' })   // router 从盘上建档 s1（registry 缓存从未见过 s1）
  registry.ensureSession(agentOf('s3', '/w3'))      // registry persist → 须把盘上 s1 一并保留
  const sessions = store.state['route:sessions']
  assert.equal(sessions.s1.control.owner, 'u1')     // 跨会话：s1 与其 control 未被覆盖写抹掉
  assert.equal(sessions.s2.workspace, 'w')        // 无关会话保留
  assert.equal(sessions.s3.workspace, 'w3')         // 新记录正常落盘
})

test('跨组件：router 设完 control 后，同 store 新建 registry（重启）仍读得到（P1-1）', () => {
  const clock = { t: 1_000_000 }
  const store = makeStore()
  const router = createAgentRouter({ store, agentsList: () => [] })
  router.setSessionControl('s1', { owner: 'u1' })
  // 重启：同一 store 上新建 registry，fresh cache 从盘上加载
  const fresh = createSessionRegistry({
    store, ctx: makeCtx({ withAgents: true }).ctx, now: () => clock.t,
  })
  assert.equal(fresh.getControl('s1').owner, 'u1') // 重启的 registry 读到盘上的 control
})

test('跨组件：带 control 的会话被回收时，盘上墓碑删干净且无关会话保留（P1-1）', () => {
  const { store, registry, router, clock } = crossRig()
  registry.ensureSession(agentOf('s1', '/w'))
  registry.ensureSession(agentOf('s2', '/w'))
  router.setSessionControl('s1', { owner: 'u1' }) // 盘上基底为 s1 带上 control
  registry.markDisposed('s1')
  const s1DisposedAt = store.state['route:sessions'].s1.disposedAt
  clock.t = Number(s1DisposedAt) + 3600_000 * 10      // 远超 ttl（ttlHours=0.01）→ 过期
  assert.deepEqual(registry.sweep(), ['s1'])          // 显式回收 s1
  const sessions = store.state['route:sessions']
  assert.equal(sessions.s1, undefined)                // 盘上删干净：墓碑生效，不被基底复活
  assert.equal(sessions.s2.workspace, 'w')          // 未 dispose 的无关会话保留
})

// ---- Stage-4 P1 收官：回收墓碑持久化收官（durable 布尔传播）----
// createStore 自 v0.8.7 起 set() 返回持久化是否真正到达盘的布尔（durable）。sweep 落击杀时的
// persist 若 durable=false（写没到盘），removedIds 一旦被连带清掉，盘上仍残留过期记录；日后某次
// 生命周期写（ensure/touch）再次 persist，从盘上基底读回过期 id、又没了墓碑可删——过期会话复活。
// 修复后：只有 durable 成功（返回非 false）才清墓碑，失败的 sweep 写留下的墓碑在下次成功写时补删。

/** durable-fake store：模拟 createStore 的 durable 布尔 + 「false 即不改盘」语义。
 * 盘（disk）是持久化层，只被 durable=true 的 set() 提交；durable=false 时盘保持原样（写未到盘，
 * 下一次 get 仍见旧真相——正是「失败的 sweep 写 → 后续写读到过期基底」的复活窗口）。
 * get() 返回价值拷贝（value-copy），注册表内存态与盘上真相互不 alias——与真实 createStore 的
 * in-memory-alias get 不同，但更直接地命中「写未到盘 → 读回旧真相」这条持久化级病根。 */
function makeDurableStore(initial = {}, writeOk = () => true) {
  const disk = { ...initial }
  const writes = { attempts: 0, fails: 0 }
  const store = {
    disk,
    writes,
    setWriteOk(fn) { store._ok = fn },
    _ok: (typeof writeOk === 'function' ? writeOk : () => Boolean(writeOk)),
    get(key, fallback = undefined) { return key in disk ? structuredClone(disk[key]) : fallback },
    set(key, value) {
      writes.attempts += 1
      const ok = store._ok(key, value)
      if (ok) disk[key] = value
      else writes.fails += 1
      return ok
    },
    keys(prefix = '') { return Object.keys(disk).filter((key) => key.startsWith(prefix)) },
  }
  return store
}

test('墓碑持久化：sweep 写盘 durable=false 后，后续成功生命周期写不复活过期会话、无关记录/字段保留', () => {
  const t = 1_000_000
  // 盘上预置：过期 disposed 会话 old；无关 dispose 未到期会话 pending；无关活跃 keep（带兄弟键 inbound）。
  const disk = makeDurableStore({
    'route:sessions': {
      old: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0, disposedAt: t - 400_000 },
      keep: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: t - 50, inbound: [{ channel: 'telegram', userId: 'u9' }] },
      pending: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0, disposedAt: t - 10_000 },
    },
  })
  const clock = { t }
  const registry = createSessionRegistry({
    ctx: makeCtx({ withAgents: true }).ctx,
    store: disk,
    now: () => clock.t,
    ttlHours: 0.01,                    // ttl=36s：old(400s ago) 过期、pending(10s ago) 未过期
    touchWriteMs: 0,                   // 后续 lifecycle 写每次都真写
    sweepEveryMs: Number.MAX_SAFE_INTEGER, // 用显式 sweep()，避开内联扫
  })
  // 阶段一：sweep 触发 persist，但唯一写盘 slot = durable=false（写未到盘，盘仍含 old）。
  disk.setWriteOk(() => false)
  assert.deepEqual(registry.sweep(), ['old'])
  assert.equal(registry.getSession('old'), undefined) // 内存态已回收
  assert.ok(disk.writes.fails >= 1)                   // 这记写确实被标成失败
  assert.equal(disk.disk['route:sessions'].old.disposedAt, t - 400_000) // 盘上仍残留 old——正是复活根源

  // 阶段二：后续成功生命周期写（touch 触发 persist）。
  // 若 removedIds 在阶段一的失败写里被连带清掉，这次 persist 从盘上基底（仍含 old）读回又无墓碑可删
  // → old 在盘上复活；修复后墓碑保留，这次成功写把 old 补删干净。
  disk.setWriteOk(() => true)
  assert.ok(registry.touch('keep') !== undefined)
  const after = disk.disk['route:sessions']
  assert.equal(after.old, undefined)                  // 过期会话补删：未复活
  assert.equal(after.keep.workspace, 'w')             // 无关活跃会话保留
  assert.deepEqual(after.keep.inbound, [{ channel: 'telegram', userId: 'u9' }]) // 兄弟字段保留
  assert.equal(after.pending.disposedAt, t - 10_000)  // 未到期的 disposed 保留（供重连）
  assert.equal(registry.getSession('old'), undefined)
  registry.dispose()
})

test('墓碑持久化：store.set 返回 undefined 的既有 store 兼容——照常清墓碑（行为不破坏）', () => {
  // makeStore 的 set 返回 undefined（非 durable）。持久化无 durable 布尔时墓碑照清、sweep 正常落盘
  // ——回归既有语义，不被 false 判据误伤。
  const t = 1_000_000
  const seeded = makeStore({
    'route:sessions': {
      old: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: 0, disposedAt: t - 400_000 },
      keep: { inherit: 'w', workspace: 'w', createdAt: 0, lastActiveAt: t - 50 },
    },
  })
  const clock = { t }
  const registry = createSessionRegistry({
    ctx: makeCtx({ withAgents: true }).ctx,
    store: seeded,
    now: () => clock.t,
    ttlHours: 0.01,
    touchWriteMs: 0,
    sweepEveryMs: Number.MAX_SAFE_INTEGER,
  })
  assert.deepEqual(registry.sweep(), ['old'])
  assert.equal(seeded.state['route:sessions'].old, undefined) // 墓碑照删落盘
  assert.equal(seeded.state['route:sessions'].keep.workspace, 'w') // 无关会话保留
  registry.dispose()
})

test('墓碑持久化：sweep 的 store.set 抛错后，后续成功生命周期写不复活过期会话', () => {
  const t = 1_000_000
  const disk = makeDurableStore({
    'route:sessions': {
      old: { workspace: 'w', disposedAt: t - 400_000 },
      keep: { workspace: 'w', lastActiveAt: t - 10 },
    },
  })
  const clock = { t }
  const registry = createSessionRegistry({
    ctx: makeCtx({ withAgents: true }).ctx,
    store: disk,
    now: () => clock.t,
    ttlHours: 0.01,
    touchWriteMs: 0,
    sweepEveryMs: Number.MAX_SAFE_INTEGER,
  })
  disk.setWriteOk(() => { throw new Error('disk unavailable') })
  assert.deepEqual(registry.sweep(), ['old'])
  assert.equal(disk.disk['route:sessions'].old.workspace, 'w')
  disk.setWriteOk(() => true)
  registry.touch('keep')
  assert.equal(disk.disk['route:sessions'].old, undefined)
  assert.equal(disk.disk['route:sessions'].keep.workspace, 'w')
  registry.dispose()
})
