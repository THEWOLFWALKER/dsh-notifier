// 路线图阶段 2A：本地管理台远程提问裁决（脱敏查询 + 受保护结算）。
// 覆盖：脱敏快照（零 token/零完整标识符）、owner/admin 证明 fail-closed、缺依赖降级、
// 非法参数/过期/未知/重复、token 绝不出现在 JSON 响应与审计。种族/单次结算见
// questions-admin-settlement.test.mjs（桥 + Control Core 集成）。

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

function tempPath() { return join(mkdtempSync(join(tmpdir(), 'dsh-adminq-')), 'state.json') }
function tempDir() { return mkdtempSync(join(tmpdir(), 'dsh-adminq-dir-')) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OUT = { question: '选部署环境', options: [{ label: '测试' }, { label: '生产' }] }

/**
 * 组装「问题桥 + Control Core + 身份」联调台。
 * @param {object} [options]
 * @param {boolean} [options.wireControl] 桥/API 是否注入 control（false = 缺依赖）
 * @param {boolean} [options.wireQuestions] API 是否注入 questions（false = 缺依赖桥）
 * @param {boolean} [options.wireIdentity] 是否装配身份层并绑定首位 owner
 * @param {boolean} [options.identityNeverBind] 装配身份层但不绑定任何 owner（ownerCount=0）
 * @param {object} [options.controlPolicy] createControlEntry 的 policy
 * @param {{ chatId: string, userId: string } | null} [options.target] 送达目标（默认绑定 owner）
 * @param {object} [options.logger] admin api 的 host logger（缺省吞 warn；G-05 用例注入采集器）
 */
function makeRig({
  wireControl = true, wireQuestions = true, wireIdentity = true, identityNeverBind = false,
  controlPolicy = { mode: 'personal', capabilities: { approve: true } },
  target = { chatId: '900113', userId: 'the-owner' }, // telegram 形状守卫要求数值 chatId
  logger = { warn: () => {} },
} = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's3cret-that-must-never-leak-9ab4def' })
  const bus = createInboundBus({ allowUsers: [target.userId], store, vault })
  const identity = wireIdentity ? createIdentity({ store, logger: null }) : null
  // 首位绑定即 owner（identity.ownerCount() >= 1，满足 settle 的本地管理员证明）
  if (identity !== null && !identityNeverBind) identity.addBinding({ channel: target.channel ?? 'telegram', userId: target.userId })

  const channel = target.channel ?? 'telegram'
  const cards = []
  const notifier = {
    channels: [channel],
    notifyAll: async (msg) => ({ ok: true, delivered: [channel], skipped: [], failed: [] }),
  }
  const instance = {
    cards,
    raw: {
      channel,
      accountId: channel,
      notifyTargets: () => [{ chatId: String(target.chatId ?? target.userId), userId: String(target.userId) }],
      async sendQuestionCard(payload) { cards.push(payload); return { messageId: cards.length } },
      async editResolved() { return true },
      async sendText() { return true },
    },
  }
  const control = wireControl ? createControlEntry({ policy: controlPolicy, identity, logger: null }) : null

  const bridge = createQuestionBridge({
    bus, vault, store, notifier,
    identity, control,
    interactive: () => [instance.raw],
    config: { timeoutMs: 1500, escalation: { enabled: false } }, // 短超时：任何未结算行 1.5s 自行收尾
  })
  bridge.attach() // 注册 question-answer 到 control（生产装配序）

  const sentinel = 's3cret-that-must-never-leak-9ab4def'
  const api = createAdminApi({
    store,
    identity,
    pairing: null,
    stateDir: tempDir(),
    logger,
    questions: wireQuestions ? bridge : null,
    control: wireControl ? control : null,
  })
  return { store, vault, bus, identity, control, bridge, api, cards, target, sentinel, channel }
}

function askPending(rig) {
  const pending = rig.bridge.askQuestions({ questions: [OUT] })
  return pending
}

test('getPendingQuestions：脱敏快照，零 token/零完整标识符/不泄 pushedTo 原值', async () => {
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const rows = rig.api.getPendingQuestions()
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.match(String(row.ref), /^[0-9a-f]{12}$/, 'ref 是 12 位 sha256 短段，不可逆')
  assert.ok(!/^aq:/.test(String(row.ref)), 'ref 不是原始 aq 键')
  assert.equal(row.status, 'pending')
  assert.equal(row.question, OUT.question)
  assert.deepEqual(row.options, ['测试', '生产'])
  assert.equal(row.multiSelect, false)
  // 来源/agent 一律掩码短段，绝无原始 target 长 id
  assert.ok(row.agent === null || /^agent-[0-9a-f]+$/.test(row.agent))
  assert.equal(row.source.length, 1)
  const s = row.source[0]
  assert.equal(s.channel, rig.channel)
  assert.match(s.chat, /^chat-[0-9a-f]{6}$/, 'chat 掩码且不含原始 chatId')
  assert.match(s.user, /^user-[0-9a-f]{6}$/, 'user 掩码且不含原始 userId')
  // 序列化层面：sentinel 与其他敏感原值绝不出现
  const json = JSON.stringify(rows)
  assert.ok(!json.includes(rig.sentinel), 'token secret 绝不落入响应')
  assert.ok(!json.includes('900113'), '完整 chatId 绝不落入响应')
  assert.ok(!json.includes('the-owner'), '完整 userId 绝不落入响应')
  assert.ok(!json.includes('pushedTo') && !json.includes('hintTargets'), '不泄内部 list 字段')
  assert.ok(!json.includes('tokenSecret'), '不泄 tokenSecret 字段名')
})

test('getPendingQuestions：无待决问题返回空数组；缺 questions 依赖降级为空（不抛）', () => {
  const rig = makeRig()
  assert.deepEqual(rig.api.getPendingQuestions(), [])
  const degraded = makeRig({ wireQuestions: false })
  assert.deepEqual(degraded.api.getPendingQuestions(), [])
})

test('settleQuestion choose：合法选项生效，返回 not 泄漏原值，且进入审计', async () => {
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const ref = rig.api.getPendingQuestions()[0].ref
  const result = rig.api.settleQuestion({ ref, action: 'choose', options: [1] })
  assert.equal(result.settled, true)
  assert.equal(result.alreadyHandled, false)
  assert.equal(Array.isArray(result.optionLabels), true)
  assert.equal(result.optionLabels.length, 1)
  assert.equal(result.optionLabels[0], '生产')
  assert.ok(!JSON.stringify(result).includes(rig.sentinel))
  // 结算后不再待决
  assert.deepEqual(rig.api.getPendingQuestions(), [])
  // 审计记录只含 ref+action，不泄选择内容/原始 id
  const audit = rig.api.getAudit()
  const entry = audit.find((r) => r.action === 'settleQuestion')
  assert.ok(entry, '应写入 settleQuestion 审计')
  // G-05 正常路径：审计行字段完整（ref/action/handled/settled），与裁决结果一致
  assert.equal(entry.detail.ref, ref)
  assert.equal(entry.detail.action, 'choose')
  assert.equal(entry.detail.handled, false)
  assert.equal(entry.detail.settled, true)
  assert.equal(entry.detail.reason, undefined, '成功路径不携带 reason')
  const detail = JSON.stringify(entry.detail)
  assert.ok(!detail.includes(rig.sentinel), '审计不含 token secret')
  assert.ok(!detail.includes('optionLabels') && !detail.includes('900113'), '审计不泄选取/原始 chatId')
})

// G-05（2026-08-28）：审计写失败不得把已生效裁决翻成 500。裁决先行生效、审计只是
// 可观测性副作用——磁盘满/权限异常时调用点独立兜底（warn 后继续返回已生效结果），
// 绝不让前端拿到 500 去重试、再命中 already-handled 形成内外状态认知分叉。
test('G-05：appendAudit 抛错（mock 磁盘满）→ 响应仍 settled:true，降级 warn 可观测', async () => {
  const warns = []
  const rig = makeRig({ logger: { warn: (...args) => warns.push(args.join(' ')) } })
  askPending(rig)
  await sleep(10)
  const ref = rig.api.getPendingQuestions()[0].ref
  // mock：审计入口抛错（裁决将在 Control Core 内先行生效）
  const attempted = []
  const original = rig.api.appendAudit
  rig.api.appendAudit = (action) => { attempted.push(String(action)); throw new Error('ENOSPC: mock 磁盘满') }
  let result
  try {
    result = rig.api.settleQuestion({ ref, action: 'choose', options: [1] })
  } finally {
    rig.api.appendAudit = original
  }
  assert.equal(result.settled, true, '裁决已生效，审计失败不得改变返回语义')
  assert.equal(result.alreadyHandled, false)
  assert.deepEqual(attempted, ['settleQuestion'], '确实尝试过写审计（失败路径被真实走到，而非未被调用）')
  // 降级可观测：warn 经 host logger（另有 stderr 双写）出口，静默丢审计即事故
  assert.equal(warns.some((line) => /审计写入失败/.test(line) && /settleQuestion/.test(line)), true)
  // 该次审计行确实缺失（取舍：可观测性副作用让位于已生效事实，损失以 warn 留痕）
  assert.equal(rig.api.getAudit().some((r) => r.action === 'settleQuestion'), false)
  // 账本终态与响应一致：问题确已结算，重试命中 already-handled（409）——内外无认知分叉
  assert.deepEqual(rig.api.getPendingQuestions(), [])
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [0] }), (e) => e.status === 409)
  // 审计恢复后重试路径如实落账（settled:false + handled:true，不伪造成功）
  const retryEntry = rig.api.getAudit().find((r) => r.action === 'settleQuestion')
  assert.ok(retryEntry, '恢复后的审计调用正常落账')
  assert.equal(retryEntry.detail.settled, false)
  assert.equal(retryEntry.detail.handled, true)
})

test('settleQuestion reject（驳回）：交还桌面（aq-skip），不编造答案', async () => {
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const ref = rig.api.getPendingQuestions()[0].ref
  const result = rig.api.settleQuestion({ ref, action: 'reject' })
  assert.equal(result.settled, true)
  assert.equal(result.alreadyHandled, false)
  assert.deepEqual(rig.api.getPendingQuestions(), [])
})

test('settleQuestion 校验与安全错误映射 fail-closed', async () => {
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const ref = rig.api.getPendingQuestions()[0].ref
  // 缺参数 → 422
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'nonsense' }), (e) => e.status === 422)
  assert.throws(() => rig.api.settleQuestion({ action: 'choose' }), (e) => e.status === 422)
  assert.throws(() => rig.api.settleQuestion({ ref: '', action: 'choose' }), (e) => e.status === 422)
  // 非法选项：越界 → 422，且问题仍待决（未结算）
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [99] }), (e) => e.status === 422)
  assert.equal(rig.api.getPendingQuestions().length, 1)
  // 重复/单选多项 → 422，仍待决
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [0, 1] }), (e) => e.status === 422)
  assert.equal(rig.api.getPendingQuestions().length, 1)
  // 未知 ref → 404
  assert.throws(() => rig.api.settleQuestion({ ref: 'deadbeefdead', action: 'choose', options: [0] }), (e) => e.status === 404)
  // 响应体绝不含 token
  for (const attempt of [
    () => rig.api.settleQuestion({ ref, action: 'nonsense' }),
    () => rig.api.settleQuestion({ ref: 'deadbeefdead', action: 'choose', options: [0] }),
  ]) {
    try { attempt() } catch (e) { assert.ok(!String(e.message).includes(rig.sentinel)) }
  }
})

test('settleQuestion 重复提交 / 手机已先答 → 409 already-handled，不二次结算', async () => {
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const ref = rig.api.getPendingQuestions()[0].ref
  assert.equal(rig.api.settleQuestion({ ref, action: 'choose', options: [0] }).settled, true)
  // 同一问题再次结算 → 409 handled
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'choose', options: [1] }), (e) => e.status === 409)
  assert.throws(() => rig.api.settleQuestion({ ref, action: 'reject' }), (e) => e.status === 409)
  const key = rig.store.keys('aq:')[0]
  assert.equal(rig.store.get(key).decision, 'answered', '账本只记一次 answered，未被 reject 覆盖')
  assert.equal(rig.store.get(key).status, 'resolved')
})

test('settleQuestion 过期 → 410；缺依赖（questions/control/identity）→ 501 / 403 fail-closed', async () => {
  // 过期：建一个行后手动把 expiresAt 拨到过期，再结算
  const rig = makeRig()
  askPending(rig)
  await sleep(10)
  const key = rig.store.keys('aq:')[0]
  const row = rig.store.get(key)
  rig.store.set(key, { ...row, expiresAt: row.createdAt + 1 }) // 刚过 createdAt 且 <= now → 过期而非 invalid_timestamps
  // adminSettle 预检发现 status 仍 pending（未由定时器收），走 control → normalize expired
  assert.throws(() => rig.api.settleQuestion({ ref: rig.api.getPendingQuestions()[0].ref, action: 'choose', options: [0] }), (e) => e.status === 410)

  // 未接线 Control Core → 501
  const noCtrl = makeRig({ wireControl: false })
  askPending(noCtrl)
  await sleep(10)
  assert.throws(() => noCtrl.api.settleQuestion({ ref: noCtrl.api.getPendingQuestions()[0].ref, action: 'choose', options: [0] }), (e) => e.status === 501)

  // 未装配 questions 桥 → 501
  const noQ = makeRig({ wireQuestions: false })
  assert.throws(() => noQ.api.settleQuestion({ ref: 'abcdefabcdef', action: 'choose', options: [0] }), (e) => e.status === 501)

  // 未装配身份层（无法证明管理员操作者）→ 501
  const noId = makeRig({ wireIdentity: false })
  assert.throws(() => noId.api.settleQuestion({ ref: 'abcdefabcdef', action: 'choose' }), (e) => e.status === 501)

  // 身份层存在但无 owner（无法证明本地管理员）→ 403
  const noOwner = makeRig({ wireIdentity: true, identityNeverBind: true })
  assert.throws(() => noOwner.api.settleQuestion({ ref: 'abcdefabcdef', action: 'choose' }), (e) => e.status === 403)
})