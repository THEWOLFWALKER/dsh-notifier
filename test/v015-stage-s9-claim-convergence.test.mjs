// v0.15（T15）交互 claim 边界收敛验证：三条交互入口（actions / approval / questions）
// 共用同一套「授权 → durable claim → 首达结算 → host effect」边界，各自保留业务差异。
//
// 契约（对齐 04 必测矩阵 I01–I04 / H02）：
//   I02 · claim（durable 首达转换）提交失败 → Host/provider 特权 effect 0 次，
//         调用方拿到非 accepted 回执，绝不误报成功；
//   I03 · claim 提交后 kill / 终态落盘失败 → 行标 uncertain（不解除 claim、不退回 pending），
//         重启结果绝不自动重放 effect；
//   I04 · 多入口（Web-first / 手机按钮 / 编号回复）争答 → 最多一次 effect，
//         迟到 settle 被拒且不反转既有终态；
//   I01 · 来源不匹配（跨 chat/channel/account） → 不结算、不消耗正确来源的待决；
//   H02 · live Host waiter（bus.wait 内存）与本地 ledger（durable）各守自身事实：
//         一方终结不复活另一方，迟到结算不翻转终态。
//
// 本套件只经生产入口（bus.accept / bridge.adminSettle / control.handle / dispatcher.dispatch）
// 驱动，不直写内部状态。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createActionDispatcher } from '../src/actions.mjs'

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '生产环境' }] }

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-t15-')), 'state.json')
}

/** 让「写某键为某终态值」的事务失败一次，其余写入照常（模拟定向磁盘故障）。
 * field 默认 'decision'（approval/questions）；actions 用例传 'outcome'。 */
function sabotageWrite(store, { keyPrefix, decision, field = 'decision' }) {
  const original = store.transact.bind(store)
  store.transact = (mutator) => original((draft) => {
    const out = mutator(draft)
    for (const [k, v] of Object.entries(draft)) {
      if (k.startsWith(keyPrefix) && v !== null && typeof v === 'object' && v[field] === decision) {
        throw new Error(`sabotage: persist ${decision} for ${k}`)
      }
    }
    return out
  })
}

/** 有界轮询（事件驱动不可得时的确定上界，绝不 sleep 猜时序）。 */
async function until(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${label}`)
}

/** bus.settle 计数探针（host effect = 释放 live waiter）。 */
function spySettle(bus) {
  const calls = []
  const real = bus.settle.bind(bus)
  bus.settle = (...args) => { calls.push(args); return real(...args) }
  return calls
}

function makeQuestionRig({ sabotage = null, timeoutMs = 400 } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-q' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel: 'telegram', userId: '100' })
  const notifier = { channels: ['telegram'], notifyAll: async () => ({ ok: true, delivered: [], skipped: [], failed: [] }) }
  const cards = []
  const instances = [{
    channel: 'telegram',
    accountId: 'TG_APP',
    notifyTargets: () => [{ chatId: '100', userId: '100' }],
    async sendQuestionCard(payload) { cards.push(payload); return { messageId: cards.length } },
    async editResolved() {},
    async sendText() { return true },
  }]
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    identity,
    control,
    interactive: () => instances,
    config: { timeoutMs, webFirstMs: 0, remoteEnabled: true, escalation: { enabled: false } },
  })
  bridge.attach()
  const settleCalls = spySettle(bus)
  if (sabotage !== null) sabotageWrite(store, sabotage)
  return { store, vault, bus, bridge, control, cards, settleCalls }
}

const qKeyOf = (rig) => rig.store.keys('aq:')[0]
const waitPushed = (rig) => until(() => {
  const key = qKeyOf(rig)
  return key !== undefined && Array.isArray(rig.store.get(key)?.pushedTo) && rig.store.get(key).pushedTo.length >= 1
}, '问题卡已推送并落账 pushedTo')

function makeApprovalRig({ sabotage = null, timeoutMs = 400 } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-ap' })
  const bus = createInboundBus({ allowUsers: ['u1'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } } }
  const notifier = { notifyAll: async () => ({ ok: true, delivered: [], skipped: [], failed: [] }) }
  const interactive = [{
    channel: 'telegram',
    accountId: 'TG_APP',
    notifyTargets: () => [{ chatId: '10001', userId: 'u1' }],
    async sendApprovalCard() { return { messageId: 'm1' } },
    async editResolved() {},
    async sendText() { return true },
  }]
  const control = createControlEntry()
  registerApprovalHandler({ ctx, notifier, bus, vault, store, interactive, control, approvalConfig: { mode: 'answer', timeoutMs } })
  const settleCalls = spySettle(bus)
  if (sabotage !== null) sabotageWrite(store, sabotage)
  const handle = (request = { toolName: 'bash', callId: 'call-1' }) => handlers['approval/request'](request, () => 'desktop')
  return { store, bus, vault, control, handle, settleCalls }
}

const apKeyOf = (rig) => rig.store.keys('ap:')[0]

// ----------------------------------------------------------------- I02 claim 前无 host effect

test('T15/I02：提问 durable 首达结算失败 → host waiter 零释放、零 effect，行保持 pending 可重试', async () => {
  const rig = makeQuestionRig({ sabotage: { keyPrefix: 'aq:', decision: 'answered' }, timeoutMs: 400 })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await waitPushed(rig)
  const qKey = qKeyOf(rig)
  const ref = rig.bridge.adminPending()[0].ref

  const settled = rig.bridge.adminSettle({ ref, action: 'choose', options: [0] })
  assert.equal(settled.ok, false, 'durable 结算未落盘 → 绝不报成功')
  assert.equal(rig.settleCalls.length, 0, 'claim 未提交 → 零 host effect（live waiter 不释放）')
  assert.equal(rig.store.get(qKey).status, 'pending', '写盘失败行保持 pending，可再次授权重试')

  const result = await pending
  assert.equal(result.answered, false, '无人成功作答 → 超时交还桌面')
})

test('T15/I02：Control Core 对提交失败的 settle 返回非 accepted（不误报已生效）', async () => {
  const rig = makeQuestionRig({ sabotage: { keyPrefix: 'aq:', decision: 'answered' }, timeoutMs: 400 })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await waitPushed(rig)
  const qKey = qKeyOf(rig)

  const receipt = rig.control.handle({
    eventId: 't15-q-receipt', command: 'question-answer', qKey, trusted: true, via: 'admin:web',
    channel: 'telegram', accountId: 'TG_APP', chatId: '100', userId: '100', optIdxes: [0],
  })
  assert.notEqual(receipt.status, 'accepted', 'durable 失败不得返回 accepted')
  assert.equal(receipt.status, 'desktop_fallback')
  assert.equal(rig.settleCalls.length, 0, '共享边界下同样零 host effect')
  await pending
})

test('T15/I02：审批 durable 首达结算失败 → host waiter 零释放，行标 uncertain 不解除 claim', async () => {
  const rig = makeApprovalRig({ sabotage: { keyPrefix: 'ap:', decision: 'allowed-once' }, timeoutMs: 250 })
  const decision = rig.handle()
  await until(() => {
    const key = apKeyOf(rig)
    return key !== undefined && (rig.store.get(key)?.pushedTo ?? []).length >= 1
  }, '审批卡已推送')

  const receipt = rig.control.handle({
    eventId: 't15-ap-claim', command: 'approval', approvalKey: apKeyOf(rig), decision: 'allowed-once',
    via: 'telegram:button', channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', trusted: true,
  })
  assert.notEqual(receipt.status, 'accepted')
  assert.equal(rig.settleCalls.length, 0, 'claim 未落盘 → 不释放 live waiter（静默永不批准）')
  const row = rig.store.get(apKeyOf(rig))
  assert.equal(row.status, 'uncertain', '终态写失败 → 标 uncertain，绝不退回 pending（claim 不解除）')
  assert.equal(await decision, 'desktop', '审批静默交还桌面')
})

test('T15/I02：动作 claim 落盘失败 → handler 零调用（三条入口同一 claim 语义）', () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-act' })
  let writes = 0
  const original = store.transact.bind(store)
  store.transact = (mutator) => {
    writes += 1
    if (writes === 2) return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }
    return original(mutator)
  }
  const dispatcher = createActionDispatcher({ vault, store })
  let runs = 0
  dispatcher.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const card = dispatcher.mintAction('turn/cancel', {})
  const click = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(click.ok, false)
  assert.equal(click.reason, 'storage-failed')
  assert.equal(runs, 0, 'claim 失败绝不执行不可逆 handler')
  assert.equal(store.get(card.key).status, 'pending', 'pending 保留，待重试')
})

// ----------------------------------------------------------------- I03 claim 后 kill → uncertain

test('T15/I03：动作 claim 后终态落盘失败 → 保持 claimed，重启只报 uncertain 且不重跑', () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-act-kill' })
  const dispatcher = createActionDispatcher({ vault, store, logger: { warn() {} } })
  let runs = 0
  dispatcher.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const card = dispatcher.mintAction('turn/cancel', {})
  sabotageWrite(store, { keyPrefix: 'act:', decision: 'done', field: 'outcome' })

  const click = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(click.ok, true, 'claim 已提交、handler 已执行 → 本次点击生效')
  assert.equal(runs, 1)
  assert.equal(store.get(card.key).status, 'claimed', '终态未落盘 → claim 不解除')

  const restarted = createActionDispatcher({ vault, store, logger: { warn() {} } })
  restarted.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const again = restarted.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'uncertain', '重启看到 claimed 只报 uncertain')
  assert.equal(runs, 1, '绝不自动重放不可逆 effect')
})

test('T15/I03：提问超时终态落盘失败 → uncertain，重启不再是 live pending', async () => {
  const rig = makeQuestionRig({ sabotage: { keyPrefix: 'aq:', decision: 'timeout' }, timeoutMs: 120 })
  const result = await rig.bridge.askQuestions({ questions: [SINGLE] })
  assert.equal(result.answered, false)
  assert.equal(result.results[0].uncertain, true, '终态未落盘必须在结果里如实可见')
  const row = rig.store.get(qKeyOf(rig))
  assert.equal(row.status, 'uncertain')
  assert.equal(row.decision, 'uncertain')
})

// ----------------------------------------------------------------- I04 多入口争答最多一次 effect

test('T15/I04：手机先答 → Web 迟到裁决被拒、终态不反转、最多一次 effect', async () => {
  const rig = makeQuestionRig({ timeoutMs: 600 })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await waitPushed(rig)
  const qKey = qKeyOf(rig)
  const ref = rig.bridge.adminPending()[0].ref

  const mobile = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', chatType: 'private',
    text: '1', messageId: 'm-mobile',
  })
  assert.equal(mobile.ok, true)
  assert.equal(rig.store.get(qKey).status, 'resolved')
  assert.deepEqual(rig.store.get(qKey).answers, ['测试环境'], '手机编号 1 → 第一项')
  assert.equal(rig.settleCalls.length, 1, '手机作答恰好一次 host effect')

  const late = rig.bridge.adminSettle({ ref, action: 'choose', options: [1] })
  assert.equal(late.ok, false, '首达已定 → Web 迟到裁决不生效')
  assert.equal(late.reason, 'already_handled')
  assert.deepEqual(rig.store.get(qKey).answers, ['测试环境'], '终态绝不被迟到裁决反转')
  assert.equal(rig.settleCalls.length, 1, '迟到裁决零第二次 effect')

  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
})

test('T15/I04：审批同一 key 二次 settle → 只生效一次，终态不翻转', async () => {
  const rig = makeApprovalRig({ timeoutMs: 400 })
  const decision = rig.handle()
  await until(() => {
    const key = apKeyOf(rig)
    return key !== undefined && (rig.store.get(key)?.pushedTo ?? []).length >= 1
  }, '审批卡已推送')
  const key = apKeyOf(rig)

  const first = rig.control.handle({
    eventId: 't15-ap-win', command: 'approval', approvalKey: key, decision: 'allowed-once',
    via: 'telegram:button', channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', trusted: true,
  })
  assert.equal(first.status, 'accepted', '首达裁决生效')
  assert.equal(rig.store.get(key).decision, 'allowed-once')
  assert.equal(rig.settleCalls.length, 1)

  const second = rig.control.handle({
    eventId: 't15-ap-late', command: 'approval', approvalKey: key, decision: 'rejected',
    via: 'telegram:button', channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', trusted: true,
  })
  assert.notEqual(second.status, 'accepted', '二次 settle 不生效')
  assert.equal(rig.store.get(key).decision, 'allowed-once', '终态不被迟到裁决反转')
  assert.equal(rig.settleCalls.length, 1, '最多一次 host effect')
  assert.equal(await decision, 'allowed-once', '首达批准 → 交还桌面同一授权决策，迟到拒绝绝不反转')
})

test('T15/I04：动作重复点击 → handler 恰好一次，二次 already-resolved', () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-act-dup' })
  const dispatcher = createActionDispatcher({ vault, store })
  let runs = 0
  dispatcher.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const card = dispatcher.mintAction('turn/cancel', {})
  const first = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(first.ok, true)
  const second = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-resolved')
  assert.equal(runs, 1, '不可逆 handler 恰好执行一次')
  assert.equal(store.get(card.key).outcome, 'done', '终态不被二次点击覆盖')
})

// ----------------------------------------------------------------- I01 来源/归属不匹配

test('T15/I01：同 user 跨 chat 的编号回复不结算、不消耗正确来源的待决', async () => {
  const rig = makeQuestionRig({ timeoutMs: 600 })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await waitPushed(rig)
  const qKey = qKeyOf(rig)

  const wrong = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '999', chatType: 'private',
    text: '1', messageId: 'm-wrong',
  })
  assert.equal(wrong.ok, true, '错误会话消息被消费（阻断扇出）')
  assert.equal(rig.store.get(qKey).status, 'pending', '归属错误 → 绝不消耗正确来源的待决')
  assert.equal(rig.settleCalls.length, 0, '错误 chat 零 effect')

  const right = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', chatType: 'private',
    text: '1', messageId: 'm-right',
  })
  assert.equal(right.ok, true)
  assert.equal(rig.store.get(qKey).status, 'resolved', '原会话仍可正常裁决')
  assert.equal(rig.settleCalls.length, 1)
  await pending
})

test('T15/I01：跨通道转发点卡 → 拒绝且不消耗 token，原会话仍可裁决', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 't15-act-src' })
  const dispatcher = createActionDispatcher({ vault, store })
  let runs = 0
  dispatcher.register('turn/cancel', () => { runs += 1; return { ok: true } })
  const card = dispatcher.mintAction('turn/cancel', {}, { channel: 'telegram', chatId: '10001' })
  dispatcher.markSource(card.key, 'telegram', '10001')

  const forwarded = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '99999' })
  assert.equal(forwarded.ok, false)
  assert.equal(forwarded.reason, 'source-chat-mismatch')
  assert.equal(runs, 0, '转发点击零 effect')
  assert.equal(store.get(card.key).status, 'pending', 'token 未核销，待决保留')

  const original = dispatcher.dispatch({ actionKey: card.key, token: card.token, via: 'telegram:action', userId: 42, chatId: '10001' })
  assert.equal(original.ok, true, '原会话仍可裁决')
  assert.equal(runs, 1)
})

// ----------------------------------------------------------------- H02 live waiter ↔ ledger

test('T15/H02：终态已定后迟到结算不翻转，且不复活已终结的 live waiter', async () => {
  const rig = makeQuestionRig({ timeoutMs: 800 })
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await waitPushed(rig)
  const qKey = qKeyOf(rig)

  controller.abort() // GUI 先答：本侧有界等待结束、行终结、waiter 结算 null
  const result = await pending
  assert.equal(result.results[0].reason, 'terminated')
  const terminal = rig.store.get(qKey)
  assert.equal(terminal.status, 'resolved')
  assert.equal(terminal.decision, 'terminated')
  const settleAfterTerminal = rig.settleCalls.length

  // 迟到的手机结算：ledger 已是终态 → 拒绝，绝不翻转，也不再释放 waiter。
  const late = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', chatType: 'private',
    text: '1', messageId: 'm-late',
  })
  assert.equal(late.ok, true)
  assert.equal(rig.store.get(qKey).decision, 'terminated', '终态不被迟到结算反转')
  assert.equal(rig.settleCalls.length, settleAfterTerminal, '已终结的 live waiter 不复活（零新增 effect）')
})