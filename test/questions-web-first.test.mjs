// v0.10 Web-first 远程升级测试（任务书 3.3/11）：Stage 0（pending，Web 立即可见）
// → Stage 1（webFirstMs 后才推主绑定 IM）→ Stage 2（reminderMs 后备用目标提醒一次）。
// 红线：20s 前不远程、remoteEnabled=false 永不推 IM、终态（作答/超时）取消后续升级。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { resolveConfig } from '../src/config.mjs'
import { stringsOf } from '../src/strings.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-wf-')), 'state.json')
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '生产环境' }] }

/** 可编程 deferred（确定性时序，不用 sleep 猜顺序）。 */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 精简提问桥测试台，config 完全可控（webFirstMs/reminderMs/remoteEnabled 均注入）。
 * overrides：{ sendQuestionCard?, notifyTargets? }——发卡与目标表可注入。 */
function makeRig(config, overrides = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  // adminSettle（桥级结算）需要 identity + 配置过 policy 的 Control Core。
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel: 'telegram', userId: '100' })
  const broadcasts = []
  const notifier = { channels: ['telegram'], notifyAll: async (message, opts) => { broadcasts.push({ message, opts }); return { ok: true, delivered: [], skipped: [], failed: [] } } }
  const cards = []
  const texts = []
  const edits = []
  const editWaiters = [] // 编辑完成信号（事件驱动，替代轮询/排水猜时序）
  const waitForEdits = async (n) => {
    const deadline = Date.now() + 500
    while (edits.length < n) {
      if (Date.now() > deadline) throw new Error(`等待 ${n} 条编辑超时（实际 ${edits.length}）`)
      await Promise.race([new Promise((r) => editWaiters.push(r)), new Promise((r) => setTimeout(r, 50))])
    }
  }
  const instances = [{
    cards,
    texts,
    raw: {
      channel: 'telegram',
      accountId: 'TG_APP',
      notifyTargets: overrides.notifyTargets ?? (() => [{ chatId: '100', userId: '100' }]),
      async sendQuestionCard(payload) {
        cards.push(payload)
        if (overrides.sendQuestionCard !== undefined) return overrides.sendQuestionCard(payload)
        return { messageId: cards.length }
      },
      async editResolved(target, text) { edits.push({ target, text }); while (editWaiters.length) editWaiters.shift()() },
      async sendText(chatId, text) { texts.push({ chatId, text }); if (overrides.sendText !== undefined) return overrides.sendText(chatId, text); return true },
    },
  }]
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    identity,
    control: createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null }),
    interactive: () => instances.map((item) => item.raw),
    config,
  })
  bridge.attach()
  return { store, vault, bus, cards, texts, edits, broadcasts, waitForEdits, bridge }
}

test('web first: no remote push before webFirstMs, push at stage 1', async () => {
  const rig = makeRig({ timeoutMs: 1200, webFirstMs: 90, escalation: { enabled: false } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(35)
  assert.equal(rig.cards.length, 0, 'webFirstMs 前不得远程推卡（Stage 0 仅 Web 可见）')
  await sleep(140) // 总 ~175ms > 90ms
  assert.ok(rig.cards.length >= 1, 'webFirstMs 后推送主绑定 IM（Stage 1）')
  const result = await pending
  assert.equal(result.answered, false) // 无人作答 → 超时交还桌面
})

test('web first: remoteEnabled=false keeps pending web-visible without IM push', async () => {
  const rig = makeRig({ timeoutMs: 250, webFirstMs: 50, remoteEnabled: false, escalation: { enabled: false } })
  const result = await rig.bridge.askQuestions({ questions: [SINGLE] })
  assert.equal(result.answered, false)
  assert.equal(rig.cards.length, 0, 'remoteEnabled=false 永不推 IM')
})

test('web first: stage 2 reminder derives afterMs from reminderMs', async () => {
  const rig = makeRig({ timeoutMs: 3000, webFirstMs: 60, reminderMs: 260, escalation: { enabled: true } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(40)
  assert.equal(rig.cards.length, 0, 'webFirstMs 前不推')
  await sleep(100) // 总 ~140ms > 60ms：卡已推
  assert.ok(rig.cards.length >= 1, 'Stage 1 已推主 IM')
  await sleep(220) // 总 ~360ms > reminderMs(260)：Stage 2 提醒（afterMs=200）已发
  assert.ok(rig.texts.length >= 1, 'Stage 2 备用目标提醒已发送一次')
  await pending
})

test('web first: settlement cancels pending stage 2 (no reminder after answer)', async () => {
  // 用户在 Stage 1 之后、Stage 2 之前作答 → escalation 被 cancelDelivery 停掉，不再提醒。
  const rig = makeRig({ timeoutMs: 3000, webFirstMs: 50, reminderMs: 400, escalation: { enabled: true } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(80) // 卡已推（>50ms），Stage 2 未到（<400ms）
  assert.ok(rig.cards.length >= 1)
  // 模拟手机按钮作答（首达采纳）：直连 bus.settle 裁决该待决问题。
  const qKey = rig.store.keys('aq:')[0]
  rig.bus.settle(qKey, { kind: 'aq', idxs: [0] }, 'telegram:button', '42')
  const result = await pending
  assert.equal(result.answered, true)
  const textsAtAnswer = rig.texts.length
  await sleep(500) // 越过原 Stage 2 时点
  assert.equal(rig.texts.length, textsAtAnswer, '已作答后不得再发 Stage 2 提醒（定时器已取消）')
})

test('config: question defaults inject web-first 20s/60s remote-enabled', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.questions.webFirstMs, 20_000)
  assert.equal(resolved.questions.reminderMs, 60_000)
  assert.equal(resolved.questions.remoteEnabled, true)
  // 显式 0 关闭 Web-first（立即推），remoteEnable 可关
  const explicit = resolveConfig({ questions: { webFirstMs: 0, reminderMs: 0, remoteEnabled: false } })
  assert.equal(explicit.questions.webFirstMs, 0)
  assert.equal(explicit.questions.reminderMs, 0)
  assert.equal(explicit.questions.remoteEnabled, false)
})
// ---------- 拦截器范围取消信号（GUI 先答 → 绝不迟推卡） ----------

test('abort signal: GUI wins during Stage 0 — delayed push cancelled, no late card', async () => {
  const rig = makeRig({ timeoutMs: 1200, webFirstMs: 90, escalation: { enabled: false } })
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await sleep(35)
  assert.equal(rig.cards.length, 0, 'Stage 0：尚未推卡')
  controller.abort() // GUI（下游 answerer）此刻先答
  const result = await pending
  assert.equal(rig.cards.length, 0, 'abort 后 Stage 1 延迟推卡被取消——绝不迟推卡')
  assert.equal(result.answered, false, '本侧未作答（宿主答案来自下游，不代答）')
})

test('abort signal: multi-question ask — later questions never open after abort', async () => {
  const rig = makeRig({ timeoutMs: 1200, webFirstMs: 0, escalation: { enabled: false } })
  const controller = new AbortController()
  const SECOND = { question: '第二问', options: [{ label: 'A' }, { label: 'B' }] }
  const pending = rig.bridge.askQuestions({ questions: [SINGLE, SECOND] }, { signal: controller.signal })
  await sleep(35)
  assert.equal(rig.cards.length, 1, 'Q1 已即时推卡（webFirstMs=0）')
  controller.abort() // GUI 对整批先答
  const result = await pending
  assert.equal(rig.cards.length, 1, 'Q2 在 abort 后不再开卡')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[1].reason, 'stopped', '后续问题按 stopped 收束，不再等待')
  assert.equal(result.answered, false)
})

// ---------- abort handler 先于直投注册 + 显式 terminate（manual abandon 不触发 onAbandon） ----------

test('abort during a HELD card send: second target never starts, late card reconciled', async () => {
  const gates = []
  const sendStarted = deferred()
  const rig = makeRig(
    { timeoutMs: 5000, webFirstMs: 0, escalation: { enabled: false } },
    {
      notifyTargets: () => [{ chatId: '100', userId: '100' }, { chatId: '101', userId: '101' }],
      sendQuestionCard: async () => { const g = deferred(); gates.push(g); if (gates.length === 1) sendStarted.resolve(); return g.promise },
    },
  )
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await sendStarted.promise // 第一张卡真正在途（挂起中）
  controller.abort() // GUI 先答
  gates[0].resolve({ messageId: 1 }) // 在途卡随后成功返回
  const result = await pending
  assert.equal(gates.length, 1, '第二目标在取消后绝不启动发送')
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(rig.texts.length, 0, '无编号话术补发')
  assert.equal(rig.broadcasts.length, 0, '无广播兜底')
})

test('abort after delivered card: card edited with termination, not timeout', async () => {
  const rig = makeRig({ timeoutMs: 5000, webFirstMs: 0, escalation: { enabled: false } })
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await sleep(15)
  assert.equal(rig.cards.length, 1, '卡已推')
  controller.abort() // GUI 对已推卡的问题先答
  const result = await pending
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(rig.edits.length, 1, '已推卡按 terminated 话术收尾（markResolved 编辑一次）')
  assert.equal(rig.edits[0].text, stringsOf().questions.terminatedText, '精确 terminated 话术（非 timeout）')
})

test('abort while HELD send pending, send then returns null: no fallback sends of any kind', async () => {
  const gates = []
  const sendStarted = deferred()
  const rig = makeRig(
    { timeoutMs: 5000, webFirstMs: 0, escalation: { enabled: false } },
    { sendQuestionCard: async () => { const g = deferred(); gates.push(g); if (gates.length === 1) sendStarted.resolve(); return g.promise } },
  )
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await sendStarted.promise
  controller.abort()
  gates[0].resolve(null) // 在途发送以失败（null）返回
  const result = await pending
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(rig.texts.length, 0, 'hinted 编号话术：取消后不补发')
  assert.equal(rig.broadcasts.length, 0, '广播兜底：取消后不发起')
})

test('late Stage-1 card completing after wait termination is edited with exact termination text', async () => {
  const gates = []
  const sendStarted = deferred()
  const rig = makeRig(
    { timeoutMs: 5000, webFirstMs: 60, escalation: { enabled: false } },
    { sendQuestionCard: async () => { const g = deferred(); gates.push(g); sendStarted.resolve(); return g.promise } },
  )
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await sendStarted.promise // Stage 1 定时器已触发，卡发送挂起中
  controller.abort() // GUI 先答：行终止、wait 结算（此时 pushedTo 仍空）
  const result = await pending
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(rig.edits.length, 0, 'wait 结算时尚无已推卡')
  gates[0].resolve({ messageId: 1 }) // 迟到的成功投递
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rig.edits.length, 1, '迟到卡由 runPush 收尾路径编辑')
  assert.equal(rig.edits[0].text, stringsOf().questions.terminatedText, '按终态选 terminated 话术（非 timeout）')
})

// ---------- 迟到卡收尾必须呈现真实终态（绝不把成功作答覆盖成超时） ----------

/** 双目标门控发卡台：A/B 各自挂起，firstStarted/secondStarted 精确标记发送启动。 */
function gatedTwoTargets() {
  const gates = []
  const firstStarted = deferred()
  const secondStarted = deferred()
  return {
    notifyTargets: () => [{ chatId: '100', userId: '100' }, { chatId: '101', userId: '101' }],
    sendQuestionCard: async () => {
      const g = deferred()
      gates.push(g)
      if (gates.length === 1) firstStarted.resolve()
      if (gates.length === 2) secondStarted.resolve()
      return g.promise
    },
    gates,
    firstStarted,
    secondStarted,
  }
}

/** 断言两张卡（chatId 100/101，messageId 1/2）都被编辑过。 */
function assertBothCardsEdited(edits) {
  const covered = new Set(edits.map((e) => `${e.target?.chatId}:${e.target?.messageId}`))
  assert.ok(covered.has('100:1'), '卡 A（chat 100 / msg 1）被编辑')
  assert.ok(covered.has('101:2'), '卡 B（chat 101 / msg 2）被编辑')
}

test('late card after a CHOSEN answer shows the answer wording, never timeout (both cards)', async () => {
  // webFirstMs>0（定时器路径）：runPush 独立于 wait——卡 B 挂起不阻塞作答结算。
  const gt = gatedTwoTargets()
  const rig = makeRig({ timeoutMs: 5000, webFirstMs: 60, escalation: { enabled: false } }, gt)
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await gt.firstStarted.promise
  gt.gates[0].resolve({ messageId: 1 }) // 卡 A 成功 → persistPushed 落账
  await gt.secondStarted.promise // 卡 B 发送已启动（挂起中）
  const ref = rig.bridge.adminPending()[0].ref
  const settled = rig.bridge.adminSettle({ ref, action: 'choose', options: [0] })
  assert.equal(settled.ok, true, 'adminSettle（桥级结算，落账 answered）')
  const result = await pending
  assert.equal(result.results[0].answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  gt.gates[1].resolve({ messageId: 2 }) // 卡 B 迟到成功
  await rig.waitForEdits(3) // A 作答编辑 + 迟到收尾对 A/B 的编辑
  const answerText = stringsOf().questions.answeredWithLabelsVia(['测试环境'], 'admin:web')
  assertBothCardsEdited(rig.edits)
  for (const edit of rig.edits) {
    assert.equal(edit.text, answerText, '每张卡的每次编辑都是已答话术')
    assert.notEqual(edit.text, stringsOf().questions.timeoutResolvedText)
  }
})

test('late card after a SKIP shows skip wording, never timeout', async () => {
  const gt = gatedTwoTargets()
  const rig = makeRig({ timeoutMs: 5000, webFirstMs: 60, escalation: { enabled: false } }, gt)
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await gt.firstStarted.promise
  gt.gates[0].resolve({ messageId: 1 })
  await gt.secondStarted.promise
  const ref = rig.bridge.adminPending()[0].ref
  assert.equal(rig.bridge.adminSettle({ ref, action: 'reject' }).ok, true)
  const result = await pending
  assert.equal(result.results[0].reason, 'skipped-by-user')
  gt.gates[1].resolve({ messageId: 2 })
  await rig.waitForEdits(3)
  assertBothCardsEdited(rig.edits)
  for (const edit of rig.edits) {
    assert.equal(edit.text, stringsOf().questions.skippedResolvedText, '每张卡的每次编辑都是跳过话术')
    assert.notEqual(edit.text, stringsOf().questions.timeoutResolvedText)
  }
})

test('late card after a CUSTOM answer shows answeredCustom wording on both cards', async () => {
  const gt = gatedTwoTargets()
  const rig = makeRig({ timeoutMs: 5000, webFirstMs: 60, escalation: { enabled: false } }, gt)
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await gt.firstStarted.promise
  gt.gates[0].resolve({ messageId: 1 }) // 卡 A 送达 chat 100 → allowChats 放行该会话文本作答
  await gt.secondStarted.promise
  // 经认证入站路径提交「答：…」（bus 白名单 + 首达结算，非直调 bus.settle）
  const accepted = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100',
    chatType: 'private', messageId: 'm-custom-1', text: '答：先发预发环境',
  })
  assert.equal(accepted.ok, true, '自定义作答被受理')
  const result = await pending
  assert.equal(result.results[0].answered, true)
  assert.deepEqual(result.results[0].answers, ['先发预发环境'], '答：前缀剥离后的净化文本')
  gt.gates[1].resolve({ messageId: 2 }) // 卡 B 迟到成功
  await rig.waitForEdits(3)
  const customText = stringsOf().questions.answeredCustom('先发预发环境')
  assertBothCardsEdited(rig.edits)
  for (const edit of rig.edits) {
    assert.equal(edit.text, customText, '每张卡的每次编辑都是自定义作答话术')
    assert.notEqual(edit.text, stringsOf().questions.answeredWithLabelsVia(['测试环境'], 'telegram:text'))
    assert.notEqual(edit.text, stringsOf().questions.timeoutResolvedText)
  }
})

test('direct path (webFirstMs=0): held target never blocks settlement return; late card reconciles', async () => {
  // 直投与定时器路径同款后台化：卡 B 挂起时结算照常返回，B 迟到成功后按真实终态和解。
  const gt = gatedTwoTargets()
  const rig = makeRig({ timeoutMs: 5000, webFirstMs: 0, escalation: { enabled: false } }, gt)
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await gt.firstStarted.promise
  gt.gates[0].resolve({ messageId: 1 }) // 卡 A 送达
  await gt.secondStarted.promise // 卡 B 发送挂起中
  const ref = rig.bridge.adminPending()[0].ref
  const settled = rig.bridge.adminSettle({ ref, action: 'choose', options: [0] })
  assert.equal(settled.ok, true, 'adminSettle（桥级结算，落账 answered）')
  const result = await Promise.race([
    pending,
    sleep(2000).then(() => { throw new Error('askQuestions 被挂起的直投卡阻塞（终态后必须返回）') }),
  ])
  assert.equal(result.results[0].answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  gt.gates[1].resolve({ messageId: 2 }) // 卡 B 迟到成功
  await rig.waitForEdits(3) // A 作答编辑 + 迟到收尾对 A/B 的编辑
  const answerText = stringsOf().questions.answeredWithLabelsVia(['测试环境'], 'admin:web')
  assertBothCardsEdited(rig.edits)
  for (const edit of rig.edits) {
    assert.equal(edit.text, answerText, '每张卡的每次编辑都是已答话术')
    assert.notEqual(edit.text, stringsOf().questions.timeoutResolvedText)
  }
})

test('hinted numbered text: held first send + abort — second target never starts', async () => {
  // 编号话术兜底逐目标串行：第一目标在途时取消，第二目标绝不发起发送。
  const gates = []
  const firstStarted = deferred()
  const rig = makeRig(
    { timeoutMs: 5000, webFirstMs: 0, escalation: { enabled: false } },
    {
      notifyTargets: () => [{ chatId: '100', userId: '100' }, { chatId: '101', userId: '101' }],
      sendQuestionCard: async () => null, // 卡片不可用 → hinted 编号话术兜底
      sendText: async () => { const g = deferred(); gates.push(g); if (gates.length === 1) firstStarted.resolve(); return g.promise },
    },
  )
  const controller = new AbortController()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] }, { signal: controller.signal })
  await firstStarted.promise // 第一条编号话术真正在途（挂起中）
  controller.abort() // GUI 先答
  gates[0].resolve(true) // 在途发送随后成功返回
  const result = await pending
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(gates.length, 1, '第二目标的编号话术绝不启动（串行发送 + 取消复查）')
})
