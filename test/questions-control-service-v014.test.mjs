// v0.14 S04：远程提问结算契约合并 —— Native RPC 投影 / Admin HTTP / 宿主原生桥共用同一个
// QuestionsControlService（单一结算入口）。
// 覆盖：三面同一结算权威（首达采纳 / 单次结算）、手机先答竞态、Native 先答、超时窗口 vs 结算、
// 结算后迟到作答、Control Core dispose / 桥缺失 fail-closed、多选 / 自定义 / 驳回语义不退化、
// 待决投影脱敏。桥内竞态与 token 脱敏的完整矩阵见 questions-admin-settlement.test.mjs。

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
import { createAdminApi } from '../src/admin/api.mjs'
import { createQuestionsControlService } from '../src/control-plane/questions.mjs'
import { createQuestionProjection } from '../src/control-surface/questions.mjs'
import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'

function tempPath() { return join(mkdtempSync(join(tmpdir(), 'dsh-qsvc-')), 'state.json') }
function tempDir() { return mkdtempSync(join(tmpdir(), 'dsh-qsvc-dir-')) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OUT = { question: '选部署环境', options: [{ label: '测试' }, { label: '生产' }] }
const MULTI = { question: '选多个', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }
const SENTINEL = 'tok-secret-9ab4def-must-never-surface'

/**
 * 联调台：桥 + Control Core + 身份，并装配共享服务与三个适配器
 * （Native 投影 / Admin HTTP / 宿主原生桥）——三者注入同一 service 实例。
 */
function makeRig({ timeoutMs = 2000 } = {}) {
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
  const notifier = { channels: ['telegram'], notifyAll: async () => ({ ok: true, delivered: ['telegram'], skipped: [], failed: [] }) }
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control,
    interactive: () => [raw],
    config: { timeoutMs, escalation: { enabled: false } },
  })
  bridge.attach()
  const service = createQuestionsControlService({ bridge })
  const surface = createQuestionProjection({ service })
  const api = createAdminApi({
    store, identity, pairing: null, stateDir: tempDir(), logger: { warn() {} },
    questions: bridge, questionsControl: service, control,
  })
  const native = createNativeQuestionBridge({ ctx: {}, questionBridge: bridge, questionsControl: service })
  return { store, bus, identity, control, bridge, service, surface, api, native }
}

function ask(rig, question = OUT) { return rig.bridge.askQuestions({ questions: [question] }) }
function qKeyOf(rig) { return rig.store.keys('aq:')[0] }
function refOf(rig) { return rig.service.pending()[0].ref }
/** 手机端作答路径（同一条 registered question-answer，trusted：true，走 spec.settle 直答）。 */
function phoneAnswer(rig, key, optIdxes, eventId) {
  return rig.control.handle({
    command: 'question-answer', eventId, qKey: key, trusted: true,
    channel: 'telegram', accountId: 'telegram', chatId: '900113',
    via: 'telegram:button', optIdxes,
  })
}

test('S04: Native/Admin/宿主桥共用同一服务 → 同一结算权威（首达采纳、账本只结一次）', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)

  // 三面读同一投影源（同一 service），ref 一致
  assert.equal(rig.surface.list().length, 1)
  assert.equal(rig.native.pending().length, 1)
  assert.equal(rig.api.getPendingQuestions().length, 1)
  assert.equal(rig.surface.list()[0].ref, ref)
  assert.equal(rig.native.pending()[0].ref, ref)

  // Admin 胜出
  const admin = rig.api.settleQuestion({ ref, action: 'choose', options: [1] })
  assert.equal(admin.settled, true)
  assert.equal(admin.alreadyHandled, false)
  assert.deepEqual(admin.optionLabels, ['生产'])
  assert.equal(rig.store.get(key).decision, 'answered', '账本只记一次 answered')
  assert.deepEqual(rig.store.get(key).answers, ['生产'])

  // 三面待决投影均清空
  assert.deepEqual(rig.surface.list(), [])
  assert.deepEqual(rig.native.pending(), [])
  assert.deepEqual(rig.api.getPendingQuestions(), [])

  // Native 同 ref 再结算 → RPC 语义 alreadyHandled（投影不抛，明确「已被裁决」），不覆盖账本
  assert.deepEqual(rig.surface.settle({ ref, action: 'choose', options: [0] }), { settled: false, alreadyHandled: true })
  // 宿主桥同 ref 再结算 → handled，不覆盖账本
  assert.equal(rig.native.settle({ ref, action: 'choose', options: [0] }).handled, true)
  assert.deepEqual(rig.store.get(key).answers, ['生产'], '首达采纳后绝不二次结算')
  await p.catch(() => {})
})

test('S04: 手机先答 → 经同一服务的 Native/Admin 结算均 already-handled，不覆盖首达答案', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)

  const phone = phoneAnswer(rig, key, [0], 'phone-first')
  assert.equal(phone.status, 'accepted')
  assert.deepEqual(rig.store.get(key).answers, ['测试'])

  assert.equal(rig.native.settle({ ref, action: 'choose', options: [1] }).handled, true)
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [1] }), (e) => e.status === 409)
  assert.deepEqual(rig.store.get(key).answers, ['测试'], '手机首达答案不被晚到结算覆盖')
  await p.catch(() => {})
})

test('S04: Native（RPC 投影）先答 → Admin 晚到 409 already-handled，账本保持 Native 首达', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)

  const native = rig.surface.settle({ ref, action: 'choose', options: [0] })
  assert.deepEqual(native, { settled: true, alreadyHandled: false })
  assert.deepEqual(rig.store.get(key).answers, ['测试'])
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [1] }), (e) => e.status === 409)
  assert.deepEqual(rig.store.get(key).answers, ['测试'], 'Native 首达不被 Admin 覆盖')
  await p.catch(() => {})
})

test('S04: 超时窗口 vs 结算 —— 过期行结算 fail-closed（不落账），余下待决仍可正常作答', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)
  // 手动把 expiresAt 拨到过去（行仍 pending）→ 过期而非已决
  const row = rig.store.get(key)
  rig.store.set(key, { ...row, expiresAt: row.createdAt + 1 })

  // Native 投影：conflict；Admin：410；账本零写、仍待决
  assert.throws(() => rig.surface.settle({ ref, action: 'choose', options: [0] }), (e) => e.code === 'conflict')
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [0] }), (e) => e.status === 410)
  assert.equal(rig.store.get(key).status, 'pending', '过期结算不落任何终态')
  await p.catch(() => {})
})

test('S04: 超时收尾后迟到结算 → already-handled，绝不把超时翻成作答', async () => {
  const rig = makeRig({ timeoutMs: 1000 })
  const p = ask(rig)
  await sleep(1200) // 等超时收尾（1s）落地
  const key = qKeyOf(rig)
  const row = rig.store.get(key)
  assert.equal(row.status, 'resolved', '超时后行已收尾')
  assert.equal(row.decision, 'timeout', '终态为 timeout，非 answered')
  // 迟到结算：待决快照为空，ref 解析不到 → 服务 fail-closed，不写账本
  assert.deepEqual(rig.service.pending(), [])
  const res = rig.service.settle({ ref: 'deadbeefdead', action: 'choose', options: [0] })
  assert.equal(res.handled, false)
  assert.equal(res.reason, 'unknown_question')
  assert.equal(rig.store.get(key).decision, 'timeout', '超时终态不被迟到结算改写')
  await p.catch(() => {})
})

test('S04: 结算后迟到手机作答 → 首达采纳，账本不覆盖', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)

  assert.equal(rig.service.settle({ ref, action: 'choose', options: [1] }).ok, true)
  assert.deepEqual(rig.store.get(key).answers, ['生产'])
  const phone = phoneAnswer(rig, key, [0], 'phone-late')
  assert.equal(['accepted', 'desktop_fallback'].includes(phone.status), true, '迟到 phone 不推翻已有裁决')
  assert.deepEqual(rig.store.get(key).answers, ['生产'], '结算后迟到作答不改写首达账本')
  await p.catch(() => {})
})

test('S04: Control Core dispose → 经共享服务结算 fail-closed not_available，账本零写', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)
  rig.control.dispose()
  const res = rig.service.settle({ ref, action: 'choose', options: [0] })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not_available')
  assert.equal(rig.store.get(key).status, 'pending', '控制核心下线：不落任何结算')
  // Admin 侧经同一服务同样 fail-closed（501）
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [0] }), (e) => e.status === 501)
  assert.equal(rig.store.get(key).status, 'pending')
  await p.catch(() => {})
})

test('S04: 多选 / 驳回语义不退化（多选落多标签；驳回 aq-skip 交还桌面不带答案）', async () => {
  const rig = makeRig()
  const pMulti = ask(rig, MULTI)
  await sleep(10)
  const multiKey = qKeyOf(rig)
  const multiRef = refOf(rig)
  const multi = rig.service.settle({ ref: multiRef, action: 'choose', options: [0, 2] })
  assert.equal(multi.ok, true)
  assert.deepEqual(multi.optionLabels, ['A', 'C'], '多选按封闭集落多标签')
  assert.deepEqual(rig.store.get(multiKey).answers, ['A', 'C'])

  const pReject = ask(rig)
  await sleep(10)
  const rejectKey = rig.store.keys('aq:').find((k) => k !== multiKey)
  const rejectRef = rig.service.pending()[0].ref
  const reject = rig.service.settle({ ref: rejectRef, action: 'reject' })
  assert.equal(reject.ok, true)
  assert.equal(rig.store.get(rejectKey).decision, 'skipped', '驳回复用 aq-skip，交还桌面')
  assert.equal(rig.store.get(rejectKey).answers, undefined, '驳回不编造答案')
  // 再次驳回 → handled，不二次结算
  assert.equal(rig.service.settle({ ref: rejectRef, action: 'reject' }).handled, true)
  await pMulti.catch(() => {})
  await pReject.catch(() => {})
})

test('S04: 自定义文本作答（答：）后经服务结算 → already-handled，账本保留自定义答案', async () => {
  const rig = makeRig()
  const p = ask(rig)
  await sleep(10)
  const key = qKeyOf(rig)
  const ref = refOf(rig)
  // 走认证入站路径提交「答：…」（bus 白名单 + 首达结算）
  rig.bus.accept({
    channel: 'telegram', accountId: 'telegram', userId: 'the-owner',
    chatId: '900113', chatType: 'private', messageId: 'm-custom-1', text: '答：先发预发环境',
  })
  await sleep(10)
  const row = rig.store.get(key)
  assert.equal(row.decision, 'answered')
  assert.deepEqual(row.answers, ['先发预发环境'], '自定义答案落账')
  // 经共享服务再结算 → already-handled，不改写自定义答案
  const res = rig.service.settle({ ref, action: 'choose', options: [0] })
  assert.equal(res.handled, true)
  assert.deepEqual(rig.store.get(key).answers, ['先发预发环境'])
  await p.catch(() => {})
})

test('S04: 桥内异常 → fail-closed（Native internal / Admin 500），绝不假成功', () => {
  const throwingBridge = { adminPending: () => [], adminSettle: () => { throw new Error('boom') } }
  const service = createQuestionsControlService({ bridge: throwingBridge })
  assert.equal(service.settle({ ref: 'r', action: 'choose', options: [0] }).reason, 'settle_failed')
  const surface = createQuestionProjection({ service })
  assert.throws(() => surface.settle({ ref: 'r', action: 'choose', options: [0] }), (e) => e.code === 'internal')

  const api = createAdminApi({
    store: createStore(tempPath()), identity: { ownerCount: () => 1 }, pairing: null,
    stateDir: tempDir(), logger: { warn() {} }, questionsControl: service, control: { handle: () => ({}) },
  })
  assert.throws(() => api.settleQuestion({ ref: 'r', action: 'choose', options: [0] }), (e) => e.status === 500)
})

test('S04: 无桥降级 fail-closed；待决投影脱敏', () => {
  const bare = createQuestionsControlService()
  assert.equal(bare.hasBridge, false)
  assert.equal(bare.canList, false)
  assert.equal(bare.canSettle, false)
  assert.deepEqual(bare.pending(), [])
  assert.deepEqual(bare.settle({ ref: 'r', action: 'choose', options: [0] }), {
    ok: false, handled: false, reason: 'not_available', message: '问题桥未装配，无法结算远程提问',
  })

  const rig = makeRig()
  const p = ask(rig)
  const rows = rig.service.pending()
  assert.equal(rows.length, 1)
  const json = JSON.stringify(rows)
  assert.ok(!json.includes(SENTINEL), 'token secret 绝不落入待决投影')
  assert.ok(!json.includes('900113') && !json.includes('the-owner'), '完整 chatId/userId 绝不落入待决投影')
  // native 桥待决投影追加来源标记，仍不含敏感原值
  const nativeRows = rig.native.pending()
  assert.equal(nativeRows[0].source, 'native')
  assert.ok(!JSON.stringify(nativeRows).includes('900113'))
  return p.catch(() => {})
})