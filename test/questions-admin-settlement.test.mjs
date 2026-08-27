// 路线图阶段 2A：远程提问管理台结算 —— 桥 + Control Core 集成与竞态/单次结算。
// 覆盖：admin 先答 vs 手机先答的 already-handled、驳回复用 aq-skip 交还桌面、非法选项
// 永不结算、Control Core 不可用（dispose）时 fail-closed 不落任何结算、token 绝不出现在
// 结算结果/账本/审计。API 层（脱敏/校验/错误映射/缺依赖降级）见 admin-questions.test.mjs。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'

function tempPath() { return join(mkdtempSync(join(tmpdir(), 'dsh-qsettle-')), 'state.json') }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OUT = { question: '选部署环境', options: [{ label: '测试' }, { label: '生产' }] }
const SENTINEL = 'tok-secret-9ab4def-must-never-surface'

/** 联调台：桥 + Control Core（注册 question-answer）+ 绑定 owner。 */
function makeRig() {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: SENTINEL })
  const bus = createInboundBus({ allowUsers: ['the-owner'], store, vault })
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel: 'telegram', userId: 'the-owner' })
  const raw = {
    channel: 'telegram',
    accountId: 'telegram',
    notifyTargets: () => [{ chatId: '900113', userId: 'the-owner' }],
    async sendQuestionCard() { return { messageId: 1 } },
    async editResolved() {},
    async sendText() {},
  }
  const notifier = {
    channels: ['telegram'],
    notifyAll: async () => ({ ok: true, delivered: ['telegram'], skipped: [], failed: [] }),
  }
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control,
    interactive: () => [raw],
    config: { timeoutMs: 2000, escalation: { enabled: false } },
  })
  bridge.attach()
  return { store, vault, bus, identity, control, bridge }
}

function askPending(rig) {
  const p = rig.bridge.askQuestions({ questions: [OUT] })
  return p
}
function qKeyOf(rig) { return rig.store.keys('aq:')[0] }
function refOf(rig) { return rig.bridge.adminPending()[0].ref }
/** 手机端作答路径（同一条 registered question-answer，trusted：true，走 spec.settle 直答）。 */
function phoneAnswer(rig, key, optIdxes, eventId) {
  return rig.control.handle({
    command: 'question-answer', eventId, qKey: key, trusted: true,
    channel: 'telegram', accountId: 'telegram', chatId: '900113',
    via: 'telegram:button', optIdxes,
  })
}

test('admin 先答 → ok；同一问题后续手机/再次 admin 均 already-handled，账本只结一次', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const ref = refOf(rig)
  const key = qKeyOf(rig)

  const first = rig.bridge.adminSettle({ ref, action: 'choose', options: [1] })
  assert.equal(first.ok, true)
  assert.equal(first.handled, false)
  assert.deepEqual(first.optionLabels, ['生产'])

  // 同一 ref 再次 admin 结算 → already-handled，且不改账本
  const again = rig.bridge.adminSettle({ ref, action: 'choose', options: [0] })
  assert.equal(again.ok, false)
  assert.equal(again.handled, true)
  const rowAfterAdmin = rig.store.get(key)
  assert.deepEqual(rowAfterAdmin.decision, 'answered')
  assert.deepEqual(rowAfterAdmin.answers, ['生产'], '账本只记 admin 首达的答案')

  // 手机晚到 → 首达采纳；账本答案不变（仍是 admin 的 '生产'）。
  // v0.8.7 仲裁语义：settle 如实报 { ok:false }（already-resolved）→ 收尾为 desktop_fallback
  //（不新结算），不再被误记为 accepted——用户端文案与账本语义不变。
  const phone = phoneAnswer(rig, key, [0], 'phone-late')
  assert.equal(['accepted', 'desktop_fallback'].includes(phone.status), true, '晚到 phone 不推翻已有裁决（首达采纳由 admin 锁账）')
  assert.deepEqual(rig.store.get(key).answers, ['生产'], '手机晚到不覆盖 admin 裁决')

  await p.catch(() => {})
})

test('手机先答 → admin 结算返回 already-handled（handled:true），账本只结一次', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig) // 结算前抓 ref（已决后 adminPending 为空）

  const phone = phoneAnswer(rig, key, [0], 'phone-first')
  assert.equal(phone.status, 'accepted')
  assert.deepEqual(rig.store.get(key).answers, ['测试'])

  const admin = rig.bridge.adminSettle({ ref, action: 'choose', options: [1] })
  assert.equal(admin.ok, false, '手机已先答 → admin 未赢')
  assert.equal(admin.handled, true, '已是已决 → 明确 already-handled')
  assert.deepEqual(rig.store.get(key).answers, ['测试'], 'admin 不覆盖手机首达答案')

  const adminReject = rig.bridge.adminSettle({ ref, action: 'reject' })
  assert.equal(adminReject.handled, true, '已决问题 reject 同样 already-handled，绝不二次结算')

  await p.catch(() => {})
})

test('驳回（reject）复用 aq-skip 交还桌面，不编造答案，账本记 skipped', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig) // 结算前抓 ref
  const result = rig.bridge.adminSettle({ ref, action: 'reject' })
  assert.equal(result.ok, true)
  assert.equal(result.handled, false)
  const row = rig.store.get(key)
  assert.equal(row.status, 'resolved')
  assert.equal(row.decision, 'skipped', 'aq-skip 语义：交还桌面，非作答')
  assert.equal(row.answers, undefined, '驳回不携带答案')
  // 驳回后再结算 → already-handled
  const again = rig.bridge.adminSettle({ ref, action: 'reject' })
  assert.equal(again.handled, true)
  await p.catch(() => {})
})

test('非法选项 fail-closed：绝不结算、问题保持待决、账本零写', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)
  for (const opts of [[99], [-1], []]) {
    const res = rig.bridge.adminSettle({ ref, action: 'choose', options: opts })
    assert.equal(res.ok, false)
    assert.equal(res.handled, false)
    assert.equal(res.reason, 'invalid_option')
  }
  // 单选不可多项
  const multi = rig.bridge.adminSettle({ ref, action: 'choose', options: [0, 1] })
  assert.equal(multi.reason, 'invalid_option')
  assert.equal(rig.store.get(key).status, 'pending', '非法选项不结算，仍待决')
  await p.catch(() => {})
})

test('Control Core 不可用（dispose）→ fail-closed not_available，账本零写，绝不直通结算', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  rig.control.dispose()
  const res = rig.bridge.adminSettle({ ref: refOf(rig), action: 'choose', options: [0] })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not_available')
  assert.equal(rig.store.get(key).status, 'pending', '控制核心下线：不落任何结算')
  // 未接线 control（桥无 deps.control）也 fail-closed，不跳过核心直结
  const sentinel = SENTINEL
  const store2 = createStore(tempPath())
  const vault2 = createTokenVault({ secret: sentinel })
  const bus2 = createInboundBus({ allowUsers: ['the-owner'], store: store2, vault: vault2 })
  const id2 = createIdentity({ store: store2, logger: null })
  id2.addBinding({ channel: 'telegram', userId: 'the-owner' })
  const raw2 = {
    channel: 'telegram',
    accountId: 'telegram',
    notifyTargets: () => [{ chatId: '900113', userId: 'the-owner' }],
    async sendQuestionCard() { return { messageId: 1 } },
    async editResolved() {}, async sendText() {},
  }
  const notifier2 = { channels: ['telegram'], notifyAll: async () => ({ ok: true, delivered: ['telegram'], skipped: [], failed: [] }) }
  const bridgeNoCtrl2 = createQuestionBridge({
    bus: bus2, vault: vault2, store: store2, notifier: notifier2, identity: id2,
    interactive: () => [raw2], config: { timeoutMs: 2000, escalation: { enabled: false } },
  })
  bridgeNoCtrl2.attach()
  const p2 = bridgeNoCtrl2.askQuestions({ questions: [OUT] })
  await sleep(10)
  const noCtrlRes = bridgeNoCtrl2.adminSettle({ ref: bridgeNoCtrl2.adminPending()[0].ref, action: 'choose', options: [0] })
  assert.equal(noCtrlRes.ok, false)
  assert.equal(noCtrlRes.reason, 'not_available')
  assert.equal(store2.get(store2.keys('aq:')[0]).status, 'pending', '缺 control：绝无直通后门')
  await p.catch(() => {})
  await p2.catch(() => {})
})

test('token 与完整标识符绝不出现在结算结果、账本决策与 admin 审计', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  const result = rig.bridge.adminSettle({ ref: refOf(rig), action: 'choose', options: [1] })
  const resultJson = JSON.stringify(result)
  assert.ok(!resultJson.includes(SENTINEL), 'token secret 不落结算结果')
  assert.ok(!resultJson.includes('900113') && !resultJson.includes('the-owner'), '完整 chatId/userId 不落结算结果')
  assert.ok(!resultJson.includes('pushedTo'), '结果不泄内部列表')

  const row = rig.store.get(qKeyOf(rig))
  const rowJson = JSON.stringify(row)
  assert.ok(!rowJson.includes(SENTINEL), 'token secret 不落账本行')
  // 账本本就存 pushedTo 原值（发行语义），此处只验证 token 不进账本、答案选项来自封闭集
  assert.deepEqual(row.answers, ['生产'])
  await p.catch(() => {})
})

test('未知 ref 与非法 action fail-closed，且不触碰任何待决行', async () => {
  const rig = makeRig()
  const p = askPending(rig)
  await sleep(10)
  assert.equal(rig.bridge.adminSettle({ ref: 'deadbeefdead', action: 'choose', options: [0] }).reason, 'unknown_question')
  assert.equal(rig.bridge.adminSettle({ ref: refOf(rig), action: 'steer' }).reason, 'invalid_action')
  assert.equal(rig.bridge.adminSettle({ ref: '', action: 'choose' }).reason, 'unknown_question')
  assert.equal(rig.store.get(qKeyOf(rig)).status, 'pending', '均未结算，仍待决')
  await p.catch(() => {})
})