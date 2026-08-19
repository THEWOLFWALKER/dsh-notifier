// v0.3.2 测试：routing/agent-router（双向解析链、workspace/agentId 双键、diff 覆盖层、写入防御）。
// mock：内存 store（set 走 JSON 往返，贴近真实文件存储的序列化隔离）+ 可控 agentsList。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createAgentRouter } from '../src/routing/agent-router.mjs'

/** 全局已启用渠道池（测试基线）。 */
const GLOBAL = ['telegram', 'bark', 'ntfy']

/** 内存 mock store：接口对齐 src/inbound/store.mjs（get/set/delete/keys）。 */
function makeStore(initial = {}) {
  const state = { ...initial }
  return {
    state,
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback),
    set: (key, value) => { state[key] = JSON.parse(JSON.stringify(value === undefined ? null : value)) },
    delete: (key) => {
      const had = Object.prototype.hasOwnProperty.call(state, key)
      delete state[key]
      return had
    },
    keys: (prefix = '') => Object.keys(state).filter((key) => key.startsWith(prefix ?? '')),
  }
}

/** rig：mock store + mock agentsList（返回快照拷贝，贴近宿主 ctx.agents.list）。 */
function makeRouter({ state = {}, agents = [] } = {}) {
  const store = makeStore(state)
  const router = createAgentRouter({ store, agentsList: () => agents.map((agent) => ({ ...agent })) })
  return { store, router }
}

// ———————— 出站解析链（四层逐层命中与优先级） ————————

test('resolveOutbound：无任何路由配置 → 全局渠道池兜底（source=global，quiet=false）', () => {
  const { router } = makeRouter()
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: GLOBAL,
    quiet: false,
    source: 'global',
  })
})

test('resolveOutbound：workspace 条目命中 → source=agent-workspace', () => {
  const { router } = makeRouter({ state: { 'route:agents': { proj: { channels: ['bark'] } } } })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['bark'],
    quiet: false,
    source: 'agent-workspace',
  })
})

test('resolveOutbound：精确 agentId 条目优先于 workspace 条目', () => {
  const { router } = makeRouter({
    state: { 'route:agents': { 's-1': { channels: ['telegram'] }, proj: { channels: ['bark'] } } },
  })
  const resolved = router.resolveOutbound('s-1', 'proj', GLOBAL)
  assert.equal(resolved.source, 'agent-exact')
  assert.deepEqual(resolved.channelTypes, ['telegram'])
})

test('resolveOutbound：会话 diff 最高，覆盖精确/workspace 条目', () => {
  const { router } = makeRouter({
    state: {
      'route:agents': { 's-1': { channels: ['telegram'] }, proj: { channels: ['bark'] } },
      'route:sessions': { 's-1': { workspace: 'proj', outbound: { channels: ['ntfy'] } } },
    },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['ntfy'],
    quiet: false,
    source: 'session',
  })
})

test('resolveOutbound：绑定引用未启用渠道 → 剔除；全部未启用 → 空集合但来源层不变', () => {
  const { router } = makeRouter({
    state: { 'route:agents': { proj: { channels: ['telegram', 'slack'] }, other: { channels: ['discord'] } } },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL).channelTypes, ['telegram'])
  const empty = router.resolveOutbound('s-2', 'other', GLOBAL)
  assert.deepEqual(empty.channelTypes, [])
  assert.equal(empty.source, 'agent-workspace') // 显式配置了（哪怕全被过滤），不回落全局池
})

test('resolveOutbound：quiet 三层覆盖链（session > agent > false 兜底）', () => {
  const bare = makeRouter()
  assert.equal(bare.router.resolveOutbound('s-1', 'proj', GLOBAL).quiet, false)

  const { router } = makeRouter({ state: { 'route:agents': { proj: { quiet: true } } } })
  const resolved = router.resolveOutbound('s-1', 'proj', GLOBAL)
  assert.equal(resolved.quiet, true)
  assert.equal(resolved.source, 'global') // channels 未配置走全局池：两字段独立解析
  assert.deepEqual(resolved.channelTypes, GLOBAL)
})

test('resolveOutbound：diff 显式 quiet=false 不回落上游（agent 层为 true）', () => {
  const { router } = makeRouter({
    state: {
      'route:agents': { proj: { channels: ['bark'], quiet: true } },
      'route:sessions': { 's-1': { outbound: { quiet: false } } },
    },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['bark'],
    quiet: false,
    source: 'agent-workspace',
  })
})

test('resolveOutbound：channels 与 quiet 字段级独立（session 只覆盖 channels，quiet 跟随 workspace 条目）', () => {
  const { router } = makeRouter({
    state: {
      'route:agents': { proj: { quiet: true } },
      'route:sessions': { 's-1': { outbound: { channels: ['ntfy'] } } },
    },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['ntfy'],
    quiet: true,
    source: 'session',
  })
})

test('resolveOutbound：精确条目只设 quiet 时，channels 字段级回落 workspace 条目', () => {
  const { router } = makeRouter({
    state: { 'route:agents': { 's-1': { quiet: true }, proj: { channels: ['bark'] } } },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['bark'],
    quiet: true,
    source: 'agent-workspace',
  })
})

test('resolveOutbound：diff channels=[] 显式空集合 → 不回落上游，channelTypes=[]', () => {
  const { router } = makeRouter({
    state: {
      'route:agents': { proj: { channels: ['bark'] } },
      'route:sessions': { 's-1': { outbound: { channels: [] } } },
    },
  })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: [],
    quiet: false,
    source: 'session',
  })
})

// ———————— 入站解析链（四层 + workspace 消歧） ————————

test('resolveInbound：L1 显式 bind 命中（优先级最高，不做活跃过滤）', () => {
  const { router } = makeRouter({
    state: {
      'bind:telegram:42': 's-9', // s-9 不在 agentsList（已结束会话）：resume 语义仍命中
      'route:channels': { telegram: { defaultAgent: 'a-2' } },
    },
    agents: [{ id: 'a-1' }, { id: 'a-2' }],
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-1' }), {
    sessionId: 's-9',
    source: 'bind',
    ambiguous: false,
  })
})

test('resolveInbound：bind 值损坏（非字符串）→ 跳过 bind 层走后续链', () => {
  const { router } = makeRouter({
    state: { 'bind:telegram:42': { sid: 's-9' } },
    agents: [{ id: 'a-1' }],
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', {}), {
    sessionId: 'a-1',
    source: 'single-agent',
    ambiguous: false,
  })
})

test('resolveInbound：L2 通道默认为活跃 agentId → 直接命中', () => {
  const { router } = makeRouter({
    state: { 'route:channels': { telegram: { defaultAgent: 'a-2' } } },
    agents: [{ id: 'a-1' }, { id: 'a-2' }],
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-1' }), {
    sessionId: 'a-2',
    source: 'channel-default',
    ambiguous: false,
  })
})

test('resolveInbound：L2 通道默认为非活跃 agentId → 回落后续链（latest 兜底）', () => {
  const { router } = makeRouter({
    state: { 'route:channels': { telegram: { defaultAgent: 'a-2' } } },
    agents: [{ id: 'a-1' }, { id: 'a-3' }], // a-2 不活跃
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'l-1' }), {
    sessionId: 'l-1',
    source: 'latest',
    ambiguous: false,
  })
})

test('resolveInbound：L2 通道默认为 workspace 名且恰 1 个活跃会话 → 命中', () => {
  const { router } = makeRouter({
    state: {
      'route:channels': { telegram: { defaultAgent: 'proj' } },
      'route:sessions': {
        'a-1': { workspace: 'proj', lastActiveAt: '2026-08-15T10:00:00Z' },
        'a-9': { workspace: 'other', lastActiveAt: '2026-08-15T11:00:00Z' }, // 其他 workspace，不参与
      },
    },
    agents: [{ id: 'a-1' }, { id: 'a-9' }],
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-9' }), {
    sessionId: 'a-1',
    source: 'channel-default',
    ambiguous: false,
  })
})

test('resolveInbound：workspace 多活跃会话 → 投 lastActiveAt 最近者并 ambiguous + candidates（降序）', () => {
  const { router } = makeRouter({
    state: {
      'route:channels': { telegram: { defaultAgent: 'proj' } },
      'route:sessions': {
        'a-1': { workspace: 'proj', lastActiveAt: '2026-08-15T10:00:00Z' },
        'a-2': { workspace: 'proj', lastActiveAt: '2026-08-15T12:00:00Z' }, // 最近活跃
        'a-3': { workspace: 'other', lastActiveAt: '2026-08-15T13:00:00Z' }, // workspace 不匹配
        'a-4': { workspace: 'proj', lastActiveAt: '2026-08-15T11:00:00Z' }, // 不活跃（agentsList 无 a-4）
      },
    },
    agents: [{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }],
  })
  const resolved = router.resolveInbound('telegram', '42', { latestSessionId: 'a-3' })
  assert.equal(resolved.sessionId, 'a-2')
  assert.equal(resolved.source, 'channel-default')
  assert.equal(resolved.ambiguous, true)
  assert.deepEqual(resolved.candidates, ['a-2', 'a-1']) // lastActiveAt 降序，首位即被投递者
  assert.equal(resolved.candidates[0], resolved.sessionId)
})

test('resolveInbound：workspace 名下无活跃会话 → 回落（单 agent 兜底）', () => {
  const { router } = makeRouter({
    state: {
      'route:channels': { telegram: { defaultAgent: 'proj' } },
      'route:sessions': { 'a-9': { workspace: 'proj', lastActiveAt: '2026-08-15T10:00:00Z' } }, // a-9 不活跃
    },
    agents: [{ id: 'a-1' }],
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', {}), {
    sessionId: 'a-1',
    source: 'single-agent',
    ambiguous: false,
  })
})

test('resolveInbound：L3 唯一 agent 自动兜底（单 agent 用户零感知）', () => {
  const { router } = makeRouter({ agents: [{ id: 'a-1', status: 'busy' }] })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-1' }), {
    sessionId: 'a-1',
    source: 'single-agent',
    ambiguous: false,
  })
})

test('resolveInbound：L4 latestSessionId 最后兜底；为空时 sessionId=null', () => {
  const { router } = makeRouter({ agents: [{ id: 'a-1' }, { id: 'a-2' }] })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-2' }), {
    sessionId: 'a-2',
    source: 'latest',
    ambiguous: false,
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', {}), {
    sessionId: null,
    source: 'latest',
    ambiguous: false,
  })
})

// ———————— 绑定写读删（route:agents / route:channels） ————————

test('setAgentBinding：channels 去空去重归一 + getAgentBinding 往返（含 quiet 字符串归一）', () => {
  const { router } = makeRouter()
  assert.equal(router.setAgentBinding('proj', { channels: ['telegram', 'telegram', '  ', 'bark', ''], quiet: 'true' }), true)
  assert.deepEqual(router.getAgentBinding('proj'), { channels: ['telegram', 'bark'], quiet: true })
  assert.deepEqual(router.listAgentKeys(), ['proj'])
})

test('setAgentBinding：部分更新（只改 quiet 不动 channels）', () => {
  const { router } = makeRouter()
  router.setAgentBinding('proj', { channels: ['telegram'], quiet: false })
  assert.equal(router.setAgentBinding('proj', { quiet: true }), true)
  assert.deepEqual(router.getAgentBinding('proj'), { channels: ['telegram'], quiet: true })
})

test('setAgentBinding：非法 key / 非数组 channels / 非对象 patch → TypeError 且不落盘', () => {
  const { router } = makeRouter()
  assert.throws(() => router.setAgentBinding('', { channels: ['telegram'] }), TypeError)
  assert.throws(() => router.setAgentBinding(null, {}), TypeError)
  assert.throws(() => router.setAgentBinding('proj', { channels: 'telegram' }), TypeError)
  assert.throws(() => router.setAgentBinding('proj', 'nope'), TypeError)
  assert.equal(router.getAgentBinding('proj'), null)
  assert.deepEqual(router.listAgentKeys(), [])
})

test('deleteAgentBinding：存在删除返回 true，重复删返回 false，读取回落 null', () => {
  const { router } = makeRouter()
  router.setAgentBinding('proj', { channels: ['bark'] })
  assert.equal(router.deleteAgentBinding('proj'), true)
  assert.equal(router.getAgentBinding('proj'), null)
  assert.equal(router.deleteAgentBinding('proj'), false)
  assert.deepEqual(router.listAgentKeys(), [])
})

test('setChannelDefault/getChannelDefault/clearChannelDefault 往返；clear 不存在返回 false', () => {
  const { router } = makeRouter()
  assert.equal(router.getChannelDefault('telegram'), null)
  assert.equal(router.setChannelDefault('telegram', 'proj'), true)
  assert.equal(router.getChannelDefault('telegram'), 'proj')
  assert.equal(router.clearChannelDefault('telegram'), true)
  assert.equal(router.getChannelDefault('telegram'), null)
  assert.equal(router.clearChannelDefault('telegram'), false)
})

test('setChannelDefault：channel/agentKey 非法 → TypeError', () => {
  const { router } = makeRouter()
  assert.throws(() => router.setChannelDefault('', 'proj'), TypeError)
  assert.throws(() => router.setChannelDefault('telegram', '  '), TypeError)
  assert.throws(() => router.setChannelDefault('telegram', 42), TypeError)
})

// ———————— v0.6.5 整表替换（管理台 putBindings 批量落盘，审查 R4-2-P2-2） ————————

test('replaceAgentBindings：整表替换语义（旧键消失/空条目回收/归一）且单次落盘', () => {
  const { store, router } = makeRouter({ state: { 'route:agents': { old: { channels: ['bark'] }, keep: { quiet: true } } } })
  let setCalls = 0
  const rawSet = store.set.bind(store)
  store.set = (key, value) => { setCalls += 1; return rawSet(key, value) }
  assert.equal(router.replaceAgentBindings({
    keep: { quiet: 'true', channels: ['telegram', 'telegram', ''] }, // 归一：去重去空 + quiet 字符串归一
    fresh: { channels: ['ntfy'] },
    empty: { channels: [] }, // 归一后空 = 未配置语义 → 整键回收
  }), true)
  assert.deepEqual(store.state['route:agents'], {
    keep: { quiet: true, channels: ['telegram'] },
    fresh: { channels: ['ntfy'] },
  }) // old 消失（整表替换），empty 不留空条目
  assert.equal(setCalls, 1, '整表一次 writeMap（原逐键重建 = N 次全量落盘）')
})

test('replaceAgentBindings：非对象表/空键/条目非对象/非数组 channels → TypeError 且不落盘', () => {
  const { store, router } = makeRouter()
  assert.throws(() => router.replaceAgentBindings('nope'), TypeError)
  assert.throws(() => router.replaceAgentBindings({ '': {} }), TypeError)
  assert.throws(() => router.replaceAgentBindings({ proj: 'nope' }), TypeError)
  assert.throws(() => router.replaceAgentBindings({ proj: { channels: 'telegram' } }), TypeError)
  assert.equal(store.state['route:agents'], undefined) // 整表拒绝，零写入
})

test('replaceChannelDefaults：整表替换 + 单次落盘；defaultAgent 非法 → TypeError 零写入', () => {
  const { store, router } = makeRouter({ state: { 'route:channels': { telegram: { defaultAgent: 'old' } } } })
  let setCalls = 0
  const rawSet = store.set.bind(store)
  store.set = (key, value) => { setCalls += 1; return rawSet(key, value) }
  assert.equal(router.replaceChannelDefaults({ feishu: { defaultAgent: 'proj' }, qq: { defaultAgent: 'a-1' } }), true)
  assert.deepEqual(store.state['route:channels'], { feishu: { defaultAgent: 'proj' }, qq: { defaultAgent: 'a-1' } })
  assert.equal(setCalls, 1)
  assert.throws(() => router.replaceChannelDefaults({ telegram: {} }), TypeError) // 缺 defaultAgent
  assert.throws(() => router.replaceChannelDefaults({ telegram: { defaultAgent: ' ' } }), TypeError)
  assert.throws(() => router.replaceChannelDefaults('nope'), TypeError)
  assert.deepEqual(store.state['route:channels'], { feishu: { defaultAgent: 'proj' }, qq: { defaultAgent: 'a-1' } }) // 失败整表不落
})

// ———————— 会话出站 diff（字段级回落 + 惰性建档） ————————

test('setSessionOutbound：会话记录不存在时惰性建最小记录（不越权补 registry 字段）', () => {
  const { store, router } = makeRouter()
  assert.equal(router.setSessionOutbound('s-1', { channels: ['telegram'], quiet: true }), true)
  assert.deepEqual(store.get('route:sessions'), { 's-1': { outbound: { channels: ['telegram'], quiet: true } } })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['telegram'],
    quiet: true,
    source: 'session',
  })
})

test('setSessionOutbound：字段级回落——channels 覆盖但 quiet 回落上游（diff 只剩 channels）', () => {
  const { store, router } = makeRouter({ state: { 'route:agents': { proj: { quiet: true } } } })
  router.setSessionOutbound('s-1', { channels: ['ntfy'], quiet: true })
  // quiet: undefined = 从 diff 删除该字段 = 回落上游实时解析
  assert.equal(router.setSessionOutbound('s-1', { quiet: undefined }), true)
  assert.deepEqual(store.get('route:sessions')['s-1'].outbound, { channels: ['ntfy'] })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: ['ntfy'],
    quiet: true, // 来自 route:agents[proj].quiet
    source: 'session',
  })
})

test('setSessionOutbound：diff 清空后 outbound 键删除，解析整体回落全局池', () => {
  const { store, router } = makeRouter()
  router.setSessionOutbound('s-1', { quiet: true })
  assert.equal(router.setSessionOutbound('s-1', { quiet: undefined }), true)
  assert.deepEqual(store.get('route:sessions'), { 's-1': {} }) // 记录保留（registry 数据不丢），diff 清空
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: GLOBAL,
    quiet: false,
    source: 'global',
  })
})

// ———————— describe 与防御 ————————

test('describe：把出站解析每层来源串成可读文本（含各层键名与最终结果）', () => {
  const { router } = makeRouter({
    state: { 'route:agents': { 's-1': { quiet: true }, proj: { channels: ['bark', 'slack'] } } },
  })
  const text = router.describe('s-1', 'proj', GLOBAL)
  assert.ok(text.includes('L1 会话 diff') && text.includes('route:sessions[s-1].outbound'))
  assert.ok(text.includes('L2 精确条目') && text.includes('route:agents[s-1]'))
  assert.ok(text.includes('L3 workspace') && text.includes('route:agents[proj]'))
  assert.ok(text.includes('L4 全局渠道池') && text.includes('telegram'))
  assert.ok(/解析结果 channelTypes=\[bark\] quiet=true source=agent-workspace/.test(text))
  assert.ok(text.includes('[bark, slack]')) // L3 展示绑定原文（含未启用渠道）
})

test('写入防御：store 缺 set 方法 → 写操作不抛、返回 false，读取解析照常', () => {
  const broken = { get: (key, fallback) => fallback } // 只有 get
  const router = createAgentRouter({ store: broken, agentsList: () => [] })
  assert.equal(router.setAgentBinding('proj', { channels: ['telegram'] }), false)
  assert.equal(router.setChannelDefault('telegram', 'proj'), false)
  assert.equal(router.deleteAgentBinding('proj'), false)
  assert.equal(router.clearChannelDefault('telegram'), false)
  assert.equal(router.setSessionOutbound('s-1', { quiet: true }), false)
  assert.deepEqual(router.listAgentKeys(), [])
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: GLOBAL,
    quiet: false,
    source: 'global',
  })
})

test('防御：store.get/set 抛错 → 解析回落、写入失败，均不外泄', () => {
  const boom = {
    get: () => { throw new Error('boom') },
    set: () => { throw new Error('boom') },
    delete: () => { throw new Error('boom') },
    keys: () => { throw new Error('boom') },
  }
  const router = createAgentRouter({ store: boom, agentsList: () => [{ id: 'a-1' }] })
  assert.deepEqual(router.resolveOutbound('s-1', 'proj', GLOBAL), {
    channelTypes: GLOBAL,
    quiet: false,
    source: 'global',
  })
  assert.deepEqual(router.resolveInbound('telegram', '42', { latestSessionId: 'a-1' }), {
    sessionId: 'a-1',
    source: 'single-agent',
    ambiguous: false,
  })
  assert.equal(router.setAgentBinding('proj', {}), false)
  assert.equal(router.getAgentBinding('proj'), null)
  assert.equal(typeof router.describe('s-1', 'proj', GLOBAL), 'string')
})

test('防御：agentsList 抛错/缺省/返回非数组/元素缺 id → 一律视为无 agent', () => {
  const throwing = createAgentRouter({ store: makeStore(), agentsList: () => { throw new Error('boom') } })
  assert.deepEqual(throwing.resolveInbound('telegram', '42', { latestSessionId: 'l-1' }), {
    sessionId: 'l-1',
    source: 'latest',
    ambiguous: false,
  })
  const missing = createAgentRouter({ store: makeStore() }) // 未注入
  assert.equal(missing.resolveInbound('telegram', '42', {}).sessionId, null)
  const weird = createAgentRouter({ store: makeStore(), agentsList: () => 'nope' })
  assert.equal(weird.resolveInbound('telegram', '42', { latestSessionId: 'l-2' }).sessionId, 'l-2')
  // 缺 id 的元素被剔除：全部无效时不触发单 agent 兜底，走 latest
  const noIds = createAgentRouter({ store: makeStore(), agentsList: () => [{ status: 'idle' }, { status: 'busy' }] })
  assert.equal(noIds.resolveInbound('telegram', '42', { latestSessionId: 'l-3' }).source, 'latest')
  // 混入无效元素后只剩 1 个有效 agent：单 agent 兜底仍应命中
  const partial = createAgentRouter({ store: makeStore(), agentsList: () => [{ status: 'idle' }, { id: 'a-1' }] })
  assert.equal(partial.resolveInbound('telegram', '42', { latestSessionId: 'l-3' }).source, 'single-agent')
})
