// v0.11 Commit19 — 手机侧 `/sessions` 用户任务概览命令（plan §10.18/§10.19）。
// 数据源单一：与 /tasks、管理台同用 projectTasks（registry + 宿主 agent 状态的只读投影）。
// 覆盖矩阵：empty / one / multi 顺序 / current 唯一标记 / attention 唯一标记 / 投影与 router
// 降级不崩 / zh+en / 未配对不可达 / 长列表单条文本（分段交给发送层）。
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
import { stringsOf } from '../src/strings.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SID_A = 'aaaaaaaa-0001-4aaa-8bbb-cccccccccccc'
const SID_B = 'bbbbbbbb-0002-4aaa-8bbb-dddddddddddd'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-sessions-')), 'state.json')
}

function makeAgent(id, status = 'idle', cwd = '/home/u/proj/alpha') {
  return { id, status, header: { cwd }, followup: () => {}, inject: () => {}, steer: () => {}, cancel: () => {} }
}

function makeRig({ agents = [], attentionOf, withRouter = true, lang = 'zh', throwingGet = false } = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const ctx = {
    agents: {
      get: throwingGet ? () => { throw new Error('agent get bomb') } : (id) => agentMap.get(id),
      list: () => [...agentMap.values()],
    },
    on: (event, handler) => { ;(handlers[event] ??= []).push(handler); return () => { handlers[event] = handlers[event].filter((h) => h !== handler) } },
  }
  let clockMs = 1_000_000
  const router = withRouter ? createAgentRouter({ store, agentsList: () => ctx.agents.list() }) : null
  const registry = createSessionRegistry({ ctx, store, now: () => clockMs, touchWriteMs: 0, sweepEveryMs: 0 })
  const t = stringsOf(lang).conversation
  const replies = []
  const dispose = registerConversationRouter({
    ctx, bus, store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs: 0 },
    logger: null,
    router, registry,
    channelTypes: () => ['telegram'],
    ...(attentionOf === undefined ? {} : { attentionOf }),
  }, stringsOf(lang))
  // 直接向台账建档（不触发 agent/created），从而不污染 conversation 的 latestSessionId——
  // 这样 /sessions 的「当前绑定」只由 /bind 决定，测试可控。
  const seed = (agent, advanceMs = 1) => { registry.ensureSession(agent); clockMs += advanceMs }
  const say = async (text, { userId = '42' } = {}) => {
    bus.accept({ channel: 'telegram', userId, chatId: userId, messageId: `m${Math.random()}`, text })
    await sleep(15)
    return replies.at(-1)?.text
  }
  return { store, bus, replies, dispose, seed, say, router, registry, t }
}

test('/sessions 空集合：回执「没有活跃会话」', async () => {
  const rig = makeRig({ agents: [] })
  const text = await rig.say('/sessions')
  assert.equal(text, rig.t.sessionsEmpty)
  rig.dispose()
})

test('/sessions 单会话：显示 workspace / sid 前缀 / 状态 / 当前绑定标记', async () => {
  const rig = makeRig({ agents: [makeAgent(SID_A, 'running')] })
  rig.seed(makeAgent(SID_A, 'running'))
  await rig.say(`/bind ${SID_A}`)
  const text = await rig.say('/sessions')
  assert.equal(text.includes(rig.t.sessionsTitle), true)
  assert.equal(text.includes('alpha'), true, '显示 workspace 名')
  assert.equal(text.includes(SID_A.slice(0, 8)), true, '显示 sid 前缀')
  assert.equal(text.includes('running'), true)
  assert.equal(text.includes(rig.t.sessionsCurrentMark), true, '当前绑定行有 * 标记')
  assert.equal(text.includes(SID_A), false, '不落完整 sessionId')
  assert.equal(text.includes(rig.t.sessionsFooter), true)
  rig.dispose()
})

test('/sessions 多会话：保持活跃降序（最近的在前）', async () => {
  const older = makeAgent(SID_A, 'idle')
  const newer = makeAgent(SID_B, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [older, newer] })
  rig.seed(older, 100)
  rig.seed(newer, 100)
  const text = await rig.say('/sessions')
  const lines = text.split('\n')
  assert.equal(lines[1].includes('beta'), true, '最近活跃的 beta 排第 1')
  assert.equal(lines[3].includes('alpha'), true, '较早的 alpha 排第 2')
  rig.dispose()
})

test('/sessions 当前绑定：只有匹配行带 * 标记', async () => {
  const a = makeAgent(SID_A, 'idle')
  const b = makeAgent(SID_B, 'idle', '/home/u/proj/beta')
  const rig = makeRig({ agents: [a, b] })
  rig.seed(a, 100)
  rig.seed(b, 100)
  await rig.say(`/bind ${SID_A}`)
  const text = await rig.say('/sessions')
  const lines = text.split('\n')
  const alphaHead = lines.find((line) => line.includes('alpha'))
  const betaHead = lines.find((line) => line.includes('beta'))
  assert.equal(alphaHead.includes(rig.t.sessionsCurrentMark), true)
  assert.equal(betaHead.includes(rig.t.sessionsCurrentMark), false)
  rig.dispose()
})

test('/sessions 待关注：只有 attention=true 的行带 ⚠', async () => {
  const a = makeAgent(SID_A, 'idle')
  const b = makeAgent(SID_B, 'idle', '/home/u/proj/beta')
  const attention = new Set([SID_A])
  const rig = makeRig({ agents: [a, b], attentionOf: (id) => attention.has(id) })
  rig.seed(a, 100)
  rig.seed(b, 100)
  const text = await rig.say('/sessions')
  assert.equal(text.split('\n').filter((line) => line.includes(rig.t.sessionsAttentionMark)).length, 1, '恰好一行带 ⚠')
  assert.equal(text.includes(SID_A.slice(0, 8)) && text.includes(rig.t.sessionsAttentionMark), true)
  rig.dispose()
})

test('/sessions 投影降级（宿主 get 抛错）：状态回落 unknown，绝不 crash', async () => {
  const rig = makeRig({ agents: [makeAgent(SID_A, 'running')], throwingGet: true })
  rig.seed(makeAgent(SID_A, 'running'))
  const text = await rig.say('/sessions')
  assert.equal(text.includes(rig.t.sessionsUnknownStatus), true, '取不到宿主状态回落 unknown')
  assert.equal(text.includes(rig.t.sessionsFooter), true, '仍正常出列表')
  rig.dispose()
})

test('/sessions router 缺失：仍列出会话（当前绑定可为空）', async () => {
  const rig = makeRig({ agents: [makeAgent(SID_A, 'running')], withRouter: false })
  rig.seed(makeAgent(SID_A, 'running'))
  const text = await rig.say('/sessions')
  assert.equal(text.includes(rig.t.sessionsTitle), true, 'router 缺失仍出列表')
  assert.equal(text.includes(SID_A.slice(0, 8)), true)
  rig.dispose()
})

test('/sessions 英文文案：英文回执完整', async () => {
  const rig = makeRig({ agents: [makeAgent(SID_A, 'running')], lang: 'en' })
  rig.seed(makeAgent(SID_A, 'running'))
  const text = await rig.say('/sessions')
  assert.equal(text.includes(rig.t.sessionsTitle), true)
  assert.equal(text.includes('Active sessions'), true)
  assert.equal(rig.t.sessionsTitle.includes('活跃'), false)
  rig.dispose()
})

test('/sessions 未配对身份：根本触达不到命令（无回执）', async () => {
  const rig = makeRig({ agents: [makeAgent(SID_A, 'running')] })
  rig.seed(makeAgent(SID_A, 'running'))
  await rig.say('/sessions', { userId: '99' })
  assert.equal(rig.replies.length, 0, '未配对用户不得触达 /sessions')
  rig.dispose()
})

test('/sessions 长列表：单条完整文本（分段交给发送层），不丢行', async () => {
  const agents = Array.from({ length: 40 }, (_, index) =>
    makeAgent(`sid-${String(index).padStart(4, '0')}-4aaa-8bbb-cccccccccccc`, index % 2 === 0 ? 'running' : 'idle', `/home/u/proj/w${index}`))
  const rig = makeRig({ agents })
  for (const agent of agents) rig.seed(agent, 1)
  const before = rig.replies.length
  const text = await rig.say('/sessions')
  assert.equal(rig.replies.length, before + 1, '命令层只产生一条回执（不自行分段）')
  assert.equal(text.split('\n').filter((line) => /^\s+\d+\./.test(line)).length, 40, '40 行任务全部保留')
  assert.equal(text.includes('w0') && text.includes('w39'), true)
  rig.dispose()
})