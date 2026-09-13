// v0.10 移动任务选择（任务书提交5）集成测试：歧义前置 → 任务选择卡 → 编号回复投原消息一次。
// 覆盖：多活跃任务无绑定不下发最近活跃（先选择卡）、编号命中投递一次、越界编号不回投、
// /use 选定后投原消息一次、/tasks 展示投影（含 attention 标记与脱敏）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'
import { createTaskSelection } from '../src/routing/task-selection.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FLUSH_MS = 60
const ALPHA_1 = 'aaaaaaaa-0001-4aaa-8bbb-cccccccccccc'
const ALPHA_2 = 'aaaaaaaa-0002-4aaa-8bbb-dddddddddddd'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-tasksel-')), 'state.json')
}

function makeAgent(id, status = 'idle', cwd = '/home/u/proj/alpha') {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id, status, header: { cwd }, calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

function makeRig({ agents = [], attentionOf } = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const ctx = {
    agents: { get: (id) => agentMap.get(id), list: () => [...agentMap.values()] },
    on: (event, handler) => { ;(handlers[event] ??= []).push(handler); return () => { handlers[event] = handlers[event].filter((h) => h !== handler) } },
  }
  let clockMs = 1_000_000
  const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
  const registry = createSessionRegistry({ ctx, store, now: () => clockMs, touchWriteMs: 0, sweepEveryMs: 0 })
  const taskSelection = createTaskSelection({
    store,
    isActive: ({ sessionId }) => { try { return registry.isActive(sessionId) === true } catch { return false } },
  })
  const replies = []
  const dispose = registerConversationRouter({
    ctx, bus, store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs: FLUSH_MS },
    logger: null,
    router, registry,
    channelTypes: () => ['telegram'],
    taskSelection,
    ...(attentionOf === undefined ? {} : { attentionOf }),
  })
  const userSays = (text, { userId = '42', chatId = userId } = {}) =>
    bus.accept({ channel: 'telegram', userId, chatId, messageId: `m${Math.random()}`, text })
  const flush = async (text) => { userSays(text); await sleep(FLUSH_MS + 10) }
  const fire = (event, payload) => (handlers[event] ?? []).forEach((h) => h(payload))
  const advance = (ms = 1) => { clockMs += ms }
  return { store, bus, replies, dispose, userSays, flush, fire, agentMap, router, registry, taskSelection, advance }
}

test('多活跃任务无绑定：先下发任务选择卡，不投最近活跃', async () => {
  const older = makeAgent(ALPHA_1, 'idle')
  const newer = makeAgent(ALPHA_2, 'idle')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer)
  rig.router.setChannelDefault('telegram', 'alpha')

  await rig.flush('帮我看看构建')
  assert.equal(older.calls.followup.length, 0, '歧义时不得先投最近活跃')
  assert.equal(newer.calls.followup.length, 0)
  const card = rig.replies.at(-1)
  assert.ok(card !== undefined)
  assert.match(card.text, /有多个活跃任务/)
  assert.match(card.text, /1\. alpha/)
  assert.match(card.text, /2\. alpha/)
  assert.equal(rig.taskSelection.has({ channel: 'telegram', userId: '42', chatId: '42' }), true)
  rig.dispose()
})

test('编号回复消解选择卡：原消息只投一次到所选任务', async () => {
  const older = makeAgent(ALPHA_1, 'idle')
  const newer = makeAgent(ALPHA_2, 'idle')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer)
  rig.router.setChannelDefault('telegram', 'alpha')

  await rig.flush('帮我看看构建')
  assert.equal(rig.taskSelection.has({ channel: 'telegram', userId: '42', chatId: '42' }), true)

  // 候选按 lastActiveAt 降序：newer(2) 在 1 号，older 在 2 号
  await rig.flush('2')
  assert.equal(older.calls.followup.length, 1, '选择 2 号投递到 older')
  assert.equal(older.calls.followup[0].content[0].text, '帮我看看构建')
  assert.equal(newer.calls.followup.length, 0)
  assert.equal(rig.taskSelection.has({ channel: 'telegram', userId: '42', chatId: '42' }), false, '消解后待决清空')
  assert.match(rig.replies.at(-1).text, /已选择 .* 并投递/)
  rig.dispose()
})

test('越界编号：不清待决并提示有效范围，原消息不投', async () => {
  const older = makeAgent(ALPHA_1, 'idle')
  const newer = makeAgent(ALPHA_2, 'idle')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer)
  rig.router.setChannelDefault('telegram', 'alpha')

  await rig.flush('帮我看看构建')
  await rig.flush('99')
  assert.equal(older.calls.followup.length, 0)
  assert.equal(newer.calls.followup.length, 0)
  assert.match(rig.replies.at(-1).text, /请回复 1\.\.2 选择任务/)
  assert.equal(rig.taskSelection.has({ channel: 'telegram', userId: '42', chatId: '42' }), true)
  rig.dispose()
})

test('/use <workspace> 选择后投原消息一次', async () => {
  const older = makeAgent(ALPHA_1, 'idle')
  const newer = makeAgent(ALPHA_2, 'idle')
  const rig = makeRig({ agents: [older, newer] })
  rig.fire('agent/created', older)
  rig.advance(100)
  rig.fire('agent/created', newer)
  rig.router.setChannelDefault('telegram', 'alpha')

  await rig.flush('帮我看看构建')
  rig.userSays('/use alpha') // 命令不进合并窗，立即处理
  const followups = older.calls.followup.length + newer.calls.followup.length
  assert.equal(followups, 1, '/use 选定后原消息只投一次')
  assert.equal(rig.taskSelection.has({ channel: 'telegram', userId: '42', chatId: '42' }), false)
  rig.dispose()
})

test('/tasks 展示任务投影（脱敏 + attention 标记）', () => {
  const a = makeAgent(ALPHA_1, 'running')
  const b = makeAgent(ALPHA_2, 'idle', '/home/u/proj/beta')
  const attention = new Set([ALPHA_1])
  const rig = makeRig({ agents: [a, b], attentionOf: (id) => attention.has(id) })
  rig.fire('agent/created', a)
  rig.fire('agent/created', b)

  rig.userSays('/tasks')
  const text = rig.replies.at(-1).text
  assert.ok(text.includes('alpha | aaaaaaaa | running ⚠'), '待关注任务带有 ⚠ 标记')
  assert.ok(text.includes('beta | aaaaaaaa | idle'))
  assert.ok(!text.includes(ALPHA_1), '不落完整 sessionId')
  rig.dispose()
})