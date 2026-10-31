// T04 focused authorization matrix: ONE admission path for every inbound action.
//
// This suite builds the REAL bus + conversation router + Control Core (+ the real
// approval/question bridges for the button/numbered-reply shapes) and drives a
// controlled envelope through `bus.accept`. Nothing about the thing under test is
// mocked: the authorization decision runs inside the production control core
// (`control/session-arbiter.mjs` canAcceptCommand + admitCommand, reached through
// `control/entry.mjs`), and the conversation router is the production router.
//
// Asserted invariants (T04 acceptance):
//  1. converse=false cannot be bypassed by ANY command shape (text, !steer,
//     known slash, unknown slash, media-only, button callback, numbered reply).
//  2. An unknown slash is explicitly refused and NEVER delivered to the agent.
//  3. Sensitive group-chat entry points are rejected for every shape.
//  4. A permitted command still works (positive control), so the gate is not a
//     blanket denial.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'
import { createTaskSelection } from '../src/routing/task-selection.mjs'
import { buildApprovalAction, parseApprovalAction } from '../src/inbound/_contract.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FLUSH_MS = 60

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-admission-')), 'state.json')
}

/** 假宿主 agent：投递方法全部记入 calls（followup/inject/steer/cancel）。 */
function makeAgent(id, status = 'idle', cwd = `/tmp/proj/${id}`) {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id,
    status,
    header: { cwd },
    calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

/**
 * rig：真实 bus/store/identity/router/registry/control + 假 ctx.agents/notifier/
 * interactive channel + 回执 spy。Control Core 恒接线（生产装配恒接线，缺线是
 * fail-closed 的另一条路，不在此测）。policy 显式传入 → converse 由 policy 决定。
 * 审批/提问桥按需接线（button / numbered 形状）。
 */
function makeRig({ agents = [], policy = {}, interactive = null, withApproval = false, withQuestions = false, withSelection = false } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'admission-secret' })
  // identity：owner = 'owner-42'（/log owner-only 正控用）；其余为 member。
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel: 'telegram', accountId: 'tg-app', userId: 'owner-42', role: 'owner' })
  identity.addBinding({ channel: 'telegram', accountId: 'tg-app', userId: '42', role: 'member' })
  // 100 = the pushedTo/chat target user for the approval/question rig, so a
  // button callback / numbered reply from the card recipient passes the BUS
  // whitelist and genuinely exercises the admission gate.
  identity.addBinding({ channel: 'telegram', accountId: 'tg-app', userId: '100', role: 'member' })
  // QQ: a paired member exists so a group envelope passes the BUS whitelist and
  // genuinely exercises the group DENIAL in the admission gate (not the bus).
  identity.addBinding({ channel: 'qq', accountId: 'qa-app', userId: '42', role: 'member' })

  const bus = createInboundBus({ identity, store, vault })

  const handlers = {}
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]))
  const ctx = {
    agents: {
      get: (id) => agentMap.get(id),
      list: () => [...agentMap.values()],
    },
    on: (event, handler) => {
      ;(handlers[event] ??= []).push(handler)
      return () => { handlers[event] = handlers[event].filter((h) => h !== handler) }
    },
  }

  const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
  const registry = createSessionRegistry({ ctx, store, now: () => Date.now(), touchWriteMs: 0, sweepEveryMs: 0 })

  const control = createControlEntry({ policy, identity, logger: null })
  const replies = []
  const reply = (channel, chatId, text) => replies.push({ channel, chatId, text })

  // notifier stub（编号话术/广播只是记账，不实际外发）。
  const broadcasts = []
  const notifier = {
    channels: ['telegram'],
    notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true, delivered: ['telegram'], skipped: [], failed: [] } },
  }
  // interactive 通道 stub（卡片按钮/编号话术回执）。
  const texts = []
  const cards = []
  const interactiveEntry = interactive ?? {
    channel: 'telegram',
    accountId: 'tg-app',
    capabilities: { buttons: true },
    notifyTargets: () => [{ channel: 'telegram', chatId: '100', userId: '100' }],
    sendApprovalCard: async ({ chatId, approvalKey, token }) => {
      const card = { chatId, approvalKey, token, messageId: cards.length + 1 }
      cards.push(card)
      return { messageId: card.messageId }
    },
    sendQuestionCard: async ({ chatId, qKey, token }) => {
      const card = { chatId, qKey, token, messageId: cards.length + 1 }
      cards.push(card)
      return { messageId: card.messageId }
    },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
    editResolved: async () => true,
    editTarget: async () => true,
  }

  const disposers = []
  const taskSelection = withSelection ? createTaskSelection({ store }) : null
  disposers.push(registerConversationRouter({
    ctx, bus, store, reply, logger: null, router, registry, control,
    channelTypes: () => ['telegram'],
    identity,
    ...(taskSelection === null ? {} : { taskSelection }),
    config: { mergeWindowMs: 0 },
  }))

  let approval = null
  if (withApproval) {
    disposers.push(registerApprovalHandler({
      ctx, notifier, bus, vault, store, identity, control,
      interactive: [interactiveEntry],
      counterStart: 0,
      approvalConfig: { mode: 'answer', timeoutMs: 5000, escalation: { enabled: false } },
    }, undefined))
    approval = {
      request: (request) => {
        const list = handlers['approval/request'] ?? []
        return list.length > 0 ? list[0](request, () => 'desktop') : Promise.resolve('desktop')
      },
    }
  }

  let questions = null
  if (withQuestions) {
    questions = createQuestionBridge({
      bus, vault, store, notifier, identity, control,
      interactive: () => [interactiveEntry],
      config: { timeoutMs: 5000, escalation: { enabled: false } },
    }, undefined)
    questions.attach()
    disposers.push(() => questions.dispose())
  }

  const fire = (event, payload) => (handlers[event] ?? []).forEach((h) => h(payload))
  const accept = (envelope) => bus.accept({ messageId: `m${Math.random()}`, ...envelope })
  return {
    store, bus, vault, identity, control, replies, broadcasts, texts, cards, taskSelection,
    agentMap, router, registry, fire, accept, approval, questions,
    dispose: () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } },
  }
}

/**
 * A private Telegram envelope (allowed source) with a writable `/bind` target.
 * `accountId` is always present: a missing accountId is its own fail-closed path
 * (source must be a real local account, never the channel name).
 */
const privateEnvelope = (text, { userId = '42', chatId = '42', accountId = 'tg-app', channel = 'telegram', ...extra } = {}) => ({
  channel, accountId, userId, chatId, text, ...extra,
})
const groupEnvelope = (text, { userId = '42', chatId = 'grp-1', accountId = 'qa-app', channel = 'qq', chatType = 'group', ...extra } = {}) => ({
  channel, accountId, userId, chatId, chatType, text, ...extra,
})

const deliveries = (agent) => agent.calls.followup.length + agent.calls.inject.length + agent.calls.steer.length

// ------------------------------------------------------------------ 1. converse=false blocks every shape

test('T04 admission：converse=false 不投递——普通文本 / !steer / 已知 slash / 未知 slash 全部拒绝', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: {} }) // 默认 personal：converse 关
  rig.fire('agent/created', agent)

  for (const text of ['跑一下', '!改道', '/tasks', '/status', '/help', '/etc/passwd 看看', '/agent', '/quiet s1']) {
    rig.accept(privateEnvelope(text))
  }
  await sleep(FLUSH_MS)

  assert.equal(deliveries(agent), 0, '没有 converse 授权 → 任何文本形状都不投递')
  assert.deepEqual(agent.calls.cancel, [], '无 stop 授权 → 不取消')
  assert.ok(rig.replies.length > 0, '每一条被拒都应有回执（无回执黑洞）')
  rig.dispose()
})

test('T04 admission：converse=false 的媒体-only 也拒绝（占位正文不绕过政策）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: {} })
  rig.fire('agent/created', agent)
  // 纯附件（无正文）：envelope.text 为空，attachments 非空 → 占位正文 [图片消息]
  rig.accept(privateEnvelope('', { image: { url: 'http://127.0.0.1/img.png', mediaType: 'image/png' } }))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(agent), 0, '媒体-only 无 converse 授权 → 不投递')
  rig.dispose()
})

test('T04 admission：未知 slash 显式拒绝，绝不透传给 agent（converse 开也不透传）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: { capabilities: { converse: true } } })
  rig.fire('agent/created', agent)
  rig.accept(privateEnvelope('/definitely-not-a-command foo'))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(agent), 0, '未知 slash 不投递（即使 converse 已开）')
  assert.ok(rig.replies.some((r) => /未识别的命令 \/definitely-not-a-command/.test(r.text)), '显式拒绝回执')
  rig.dispose()
})

// ------------------------------------------------------------------ 2. button / numbered reply under converse=false

test('T04 admission：approve=false 时按钮回调（approval）不裁决、不落终态（fail-closed）', async () => {
  // Per CONTRACTS §命令政策最小表, approval/answer/action needs `approve` (a live
  // pending + correct source + validity), NOT `converse`. The T04 invariant is that
  // the button path still passes the ONE admission gate: disabling `approve`
  // denies it, and the settlement goes to the approval waiter — never to the agent.
  const rig = makeRig({ policy: { capabilities: { approve: false } }, withApproval: true })
  const pending = rig.approval.request({ toolName: 'rm', callId: 'c1', reason: '删除 x' })
  await sleep(30)
  const card = rig.cards.at(-1)
  assert.ok(card !== undefined, '卡片已下发')
  rig.accept(privateEnvelope('approve', {
    userId: '100', chatId: '100',
    approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  }))
  await sleep(30)
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', 'approve=false 下按钮不得放行审批（fail-closed）')
  assert.equal(await Promise.race([pending, sleep(20).then(() => 'still-pending')]), 'still-pending', '审批未被远程裁决')
  rig.dispose()
})

test('T04 admission：approve=false 时编号回复不裁决、不落终态（fail-closed）', async () => {
  const rig = makeRig({ policy: { capabilities: { approve: false } }, withApproval: true })
  const pending = rig.approval.request({ toolName: 'rm', callId: 'c2', reason: '删除 y' })
  await sleep(30)
  const card = rig.cards.at(-1)
  rig.accept(privateEnvelope('1', { userId: '100', chatId: '100' }))
  await sleep(30)
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', 'approve=false 下编号回复不得放行审批')
  assert.equal(await Promise.race([pending, sleep(20).then(() => 'still-pending')]), 'still-pending')
  rig.dispose()
})

test('T04 admission：approve=false 时问题编号回复不裁决（同一政策，同一闸）', async () => {
  const rig = makeRig({ policy: { capabilities: { approve: false } }, withQuestions: true })
  const ask = rig.questions.askQuestions({
    questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
    timeoutMs: 4000,
  })
  await sleep(40)
  const card = rig.cards.at(-1)
  assert.ok(card !== undefined && card.qKey !== undefined, '提问卡已下发')
  rig.accept(privateEnvelope('1', { userId: '100', chatId: '100' }))
  await sleep(30)
  assert.equal(rig.store.get(card.qKey).status, 'pending', 'approve=false 下问题编号回复不得裁决')
  rig.questions.dispose()
  await Promise.race([ask, sleep(20)])
  rig.dispose()
})

test('T04 admission：按钮/编号回复的来源不匹配被拒（source 也走同一闸）', async () => {
  // A correct-source clicker settles; a wrong user does NOT (source binding).
  const rig = makeRig({ policy: {}, withApproval: true })
  const pending = rig.approval.request({ toolName: 'rm', callId: 'c3', reason: '删除 z' })
  await sleep(30)
  const card = rig.cards.at(-1)
  // user 42 (not the card recipient) clicks the button: must NOT settle.
  rig.accept(privateEnvelope('approve', {
    userId: '42', chatId: '100',
    approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  }))
  await sleep(20)
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', '错误来源点击不裁决')
  // correct recipient (100) settles.
  rig.accept(privateEnvelope('approve', {
    userId: '100', chatId: '100',
    approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  }))
  await sleep(20)
  assert.equal(rig.store.get(card.approvalKey).status, 'resolved', '正确来源点击裁决')
  assert.equal(await pending, 'allowed-once')
  rig.dispose()
})

// ------------------------------------------------------------------ 3. group entry points rejected for every shape

test('T04 admission：QQ 群入口对每一种命令形状都拒绝（slash/unknown/media/文本/编号）', async () => {
  const agent = makeAgent('s1', 'running')
  // 即便 policy 显式开启 converse+groupChatControl，QQ 群控制仍恒拒（session-arbiter 硬规则）
  const rig = makeRig({ agents: [agent], policy: { mode: 'team', capabilities: { converse: true, groupChatControl: true, stop: true } } })
  rig.fire('agent/created', agent)
  rig.router.setAgentBinding('s1', { channels: ['qq'] })

  for (const text of ['/stop', '/tasks', '/status', '/help', '/nope', '跑一下', '!改道', '1']) {
    rig.accept(groupEnvelope(text))
  }
  rig.accept(groupEnvelope('', { image: { url: 'http://127.0.0.1/g.png', mediaType: 'image/png' } }))
  await sleep(FLUSH_MS)

  assert.equal(deliveries(agent), 0, '群聊入口不投递')
  assert.deepEqual(agent.calls.cancel, [], '群聊不取消')
  assert.ok(rig.replies.length > 0 && rig.replies.every((r) => /群聊不允许远程控制/.test(r.text)), '全部回执群控拒绝')
  rig.dispose()
})

test('T04 admission：通用群聊（非 QQ）也 fail-closed——groupChatControl 未开即拒', async () => {
  const agent = makeAgent('s1', 'running')
  // Telegram group, converse enabled but groupChatControl NOT enabled →
  // the generic isGroupChat path must fail closed.
  const rig = makeRig({ agents: [agent], policy: { capabilities: { converse: true, stop: true } } })
  rig.fire('agent/created', agent)
  rig.router.setAgentBinding('s1', { channels: ['telegram'] })
  rig.accept(privateEnvelope('/tasks', { chatId: '-100', chatType: 'group' }))
  rig.accept(privateEnvelope('跑一下', { chatId: '-100', chatType: 'group' }))
  rig.accept(privateEnvelope('/stop', { chatId: '-100', chatType: 'group' }))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(agent), 0, '通用群聊不投递')
  assert.deepEqual(agent.calls.cancel, [], '通用群聊不取消')
  assert.ok(rig.replies.length > 0 && rig.replies.every((r) => /群聊不允许远程控制/.test(r.text)))
  rig.dispose()
})

test('T04 admission：编号回复消解任务选择卡同走一闸——无 assets 授权则拒绝且待决保留', async () => {
  const a1 = makeAgent('s1', 'idle')
  const a2 = makeAgent('s2', 'idle')
  const rig = makeRig({ agents: [a1, a2], policy: {}, withSelection: true })
  rig.fire('agent/created', a1)
  rig.fire('agent/created', a2)
  // Prime a live pending selection this source created (as the ambiguity card would).
  rig.taskSelection.begin({ channel: 'telegram', accountId: 'tg-app', userId: '42', chatId: '42' }, ['s1', 's2'], '原消息', [])
  rig.accept(privateEnvelope('1'))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(a1) + deliveries(a2), 0, '无 assets 授权 → 编号回复不投递原消息')
  assert.ok(rig.taskSelection.get({ channel: 'telegram', accountId: 'tg-app', userId: '42', chatId: '42' }) !== undefined, '待决选择保留')
  rig.dispose()
})

test('T04 正控：assets 授权后编号回复消解任务选择卡——原消息投一次到所选任务', async () => {
  const a1 = makeAgent('s1', 'idle')
  const a2 = makeAgent('s2', 'idle')
  const rig = makeRig({ agents: [a1, a2], policy: { capabilities: { assets: true } }, withSelection: true })
  rig.fire('agent/created', a1)
  rig.fire('agent/created', a2)
  rig.taskSelection.begin({ channel: 'telegram', accountId: 'tg-app', userId: '42', chatId: '42' }, ['s1', 's2'], '原消息', [])
  rig.accept(privateEnvelope('1'))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(a1) + deliveries(a2), 1, 'assets 授权下编号回复投递原消息一次')
  assert.equal(rig.taskSelection.get({ channel: 'telegram', accountId: 'tg-app', userId: '42', chatId: '42' }), undefined, '待决已消解')
  rig.dispose()
})

// ------------------------------------------------------------------ 4. positive controls：permitted actions still work

test('T04 正控：converse 开 + 私聊 → 普通文本/steer 正常投递', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: { capabilities: { converse: true } } })
  rig.fire('agent/created', agent)
  rig.accept(privateEnvelope('跑一下'))
  await sleep(FLUSH_MS)
  assert.equal(agent.calls.followup.length, 1)
  assert.equal(agent.calls.followup[0].content[0].text, '跑一下')
  rig.accept(privateEnvelope('!改道'))
  await sleep(FLUSH_MS)
  assert.equal(agent.calls.steer.length, 1)
  assert.equal(agent.calls.steer[0].content[0].text, '改道')
  rig.dispose()
})

test('T04 正控：/tasks 经准入后正常列出（不再当普通文本投递给 agent）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: {} })
  rig.fire('agent/created', agent)
  rig.accept(privateEnvelope('/tasks'))
  await sleep(FLUSH_MS)
  assert.equal(deliveries(agent), 0, '/tasks 是命令，绝不投递给 agent')
  assert.ok(rig.replies.some((r) => /活跃任务|没有活跃任务/.test(r.text)), '/tasks 正常应答')
  rig.dispose()
})

test('T04 正控：/log owner-only——member 被拒、owner 通过（负控+正控）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: {} })
  rig.fire('agent/created', agent)
  // member（42）：owner-only → 拒绝
  rig.accept(privateEnvelope('/log', { userId: '42' }))
  await sleep(FLUSH_MS)
  assert.ok(rig.replies.some((r) => /仅 owner/.test(r.text)), 'member 用 /log 被拒')
  // owner（owner-42）：通过准入（remoteLog 默认关 → 「未开启」，但已过 owner 闸）
  rig.accept(privateEnvelope('/log', { userId: 'owner-42', chatId: 'owner-42' }))
  await sleep(FLUSH_MS)
  assert.ok(rig.replies.some((r) => /仅 owner/.test(r.text) === false && /远程日志未开启/.test(r.text)), 'owner 过闸后到功能开关判定')
  rig.dispose()
})

test('T04 正控：stop 开 + 私聊 → 裸 /stop 经 Control Core 核销后取消', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent], policy: { capabilities: { stop: true } } })
  rig.fire('agent/created', agent)
  rig.accept(privateEnvelope('/stop'))
  await sleep(FLUSH_MS)
  assert.deepEqual(agent.calls.cancel, [{ kind: 'user' }])
  rig.dispose()
})

// ------------------------------------------------------------------ 5. 未识别 slash 附言形态

test('T04 正控：assets/quiet 能力授予后 /bind /use /quiet 正常生效（资源访问走同一闸）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: { capabilities: { assets: true, quiet: true } } })
  rig.fire('agent/created', agent)
  // /bind：准入通过后写 bind 键
  rig.accept(privateEnvelope('/bind s1'))
  await sleep(FLUSH_MS)
  assert.equal(rig.store.get('bind:telegram:42'), 's1', '/bind 在 assets 授权下写入绑定')
  // /use：同样通过准入
  rig.accept(privateEnvelope('/use s1'))
  await sleep(FLUSH_MS)
  assert.ok(rig.replies.some((r) => /已选择|已绑定/.test(r.text)), '/use 在 assets 授权下生效')
  // /quiet：通过准入后写会话出站状态
  rig.accept(privateEnvelope('/quiet s1'))
  await sleep(FLUSH_MS)
  assert.ok(!rig.replies.some((r) => /远程控制被拒绝/.test(r.text)), '/quiet 在 quiet 授权下不被拒绝')
  rig.dispose()
})

test('T04 正控：assets/quiet 未授予时 /bind /use /quiet 被拒且无副作用（默认收紧）', async () => {
  const agent = makeAgent('s1', 'idle')
  const rig = makeRig({ agents: [agent], policy: {} })
  rig.fire('agent/created', agent)
  for (const text of ['/bind s1', '/use s1', '/quiet s1', '/unquiet s1']) {
    rig.accept(privateEnvelope(text))
  }
  await sleep(FLUSH_MS)
  assert.equal(rig.store.get('bind:telegram:42'), undefined, '未授权 /bind 不写绑定')
  assert.ok(!rig.replies.some((r) => /已选择|已绑定|已静默|已恢复/.test(r.text)), '未授权命令无成功回执')
  assert.ok(rig.replies.every((r) => /远程控制被拒绝/.test(r.text)), '全部回执拒绝')
  rig.dispose()
})

test('T04 admission：/stop 附言形态（非裸 /stop）→ 未知命令拒绝，不投递不取消', async () => {
  const agent = makeAgent('s1', 'running')
  const rig = makeRig({ agents: [agent], policy: { capabilities: { stop: true, converse: true } } })
  rig.fire('agent/created', agent)
  rig.accept(privateEnvelope('/stop 一下别急'))
  await sleep(FLUSH_MS)
  assert.deepEqual(agent.calls.cancel, [], '附言形态不取消')
  assert.equal(deliveries(agent), 0, '未识别 slash 不投递')
  assert.ok(rig.replies.some((r) => /未识别的命令 \/stop/.test(r.text)))
  rig.dispose()
})
