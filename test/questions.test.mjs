// v0.8 远程提问桥测试（questions/router.mjs，规划书《选项卡通知》M1）。
// 核心断言（用户拍板的两个行为）：
//  - 选项卡为主：卡片送达的渠道不再收编号文案；编号只发卡片未送达的渠道（P4）
//  - 发错可再答：越界编号 / 单选回多项 → 回执提示 + 选项重发，问题保持待决
// 附加红线：超时永不代答（answered=false）、token 伪造拒绝、首达采纳、参数校验、限流。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuestionBridge, validateAskArgs, registerAskUserTool } from '../src/questions/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-aq-')), 'state.json')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 组装提问桥测试台。
 * @param {object} [options]
 * @param {Array<{channel: string, card: boolean|null, targets?: object[]}>} [options.inbounds]
 *   card: true = 卡片成功（记录 payload）；false = 无卡片能力（sendQuestionCard 恒 null）
 * @param {string[]} [options.channelTypes] - notifier.channels（编号兜底的广播池）
 */
function makeRig({ inbounds = [{ channel: 'telegram', card: true }], channelTypes = ['telegram'] } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const broadcasts = [] // { msg, opts } —— 编号兜底/提醒广播
  const notifier = {
    channels: channelTypes,
    notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true, delivered: [], skipped: [], failed: [] } },
  }
  const instances = []
  for (const spec of inbounds) {
    const cards = []
    const texts = []
    const edits = []
    instances.push({
      cards,
      texts,
      edits,
      raw: {
        channel: spec.channel,
        notifyTargets: () => (spec.targets ?? [{ chatId: '100', userId: '100' }]),
        async sendQuestionCard(payload) {
          if (spec.card !== true) return null
          cards.push(payload)
          return { messageId: cards.length }
        },
        async editResolved(target, text) { edits.push({ target, text }) },
        async sendText(chatId, text) { texts.push({ chatId, text }); return true },
      },
    })
  }
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    interactive: () => instances.map((item) => item.raw),
    config: { timeoutMs: 800, escalation: { enabled: false } },
  })
  bridge.attach() // 挂编号回复处理器（生产装配序：审批之后）
  return { store, vault, bus, broadcasts, instances, bridge }
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '预发环境' }, { label: '生产环境' }] }
const MULTI = { question: '勾选要通知的人', options: [{ label: '张三' }, { label: '李四' }, { label: '王五' }], multiSelect: true }

// ---------------------------------------------------------------- P4 选项卡为主

test('P4 卡片为主：卡片送达的渠道不再收编号文案（零广播）', async () => {
  const rig = makeRig({ channelTypes: ['telegram'] }) // 广播池只有卡片渠道
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, '卡片已送达')
  assert.equal(rig.broadcasts.length, 0, '卡片已到手，不得再广播编号文案')
  const payload = rig.instances[0].cards[0]
  rig.bridge.decide({ qKey: payload.qKey, optIdx: '1', token: payload.token, via: 'telegram', userId: '100' })
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['预发环境'])
  rig.bridge.dispose()
})

test('P4 编号兜底只发卡片未送达的渠道（分流 channelTypes）', async () => {
  const rig = makeRig({ channelTypes: ['telegram', 'wxpusher', 'webhook'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // telegram 卡片已送达 → 编号文案只补发给 wxpusher / webhook
  assert.equal(rig.broadcasts.length, 1)
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['wxpusher', 'webhook'] })
  assert.match(rig.broadcasts[0].msg.content, /回复编号/, '编号话术在场')
  assert.equal(rig.broadcasts[0].msg.level, 'timeSensitive')
  const payload = rig.instances[0].cards[0]
  rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'telegram', userId: '100' })
  await pending
  rig.bridge.dispose()
})

test('P4 全渠道无卡片：编号文案广播全部渠道，白名单用户回编号可作答', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq', 'wxpusher'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 0, 'qq 无卡片能力')
  assert.equal(rig.broadcasts.length, 1)
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['qq', 'wxpusher'] })
  assert.match(rig.broadcasts[0].msg.content, /1\. 测试环境[\s\S]*3\. 生产环境/, '选项列表随编号文案下发')
  // qq 用户 42（白名单）回复 2 → 裁决为「预发环境」
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:1', text: '2' }),
    { ok: true },
  )
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['预发环境'])
  assert.match(result.results[0].via, /qq:reply/)
  rig.bridge.dispose()
})

test('P4 卡片投递失败（异常）也走编号兜底：normalizeInbound 吞异常归 null', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const broadcasts = []
  const notifier = {
    channels: ['feishu'],
    notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true } },
  }
  const raw = {
    channel: 'feishu',
    notifyTargets: () => [{ chatId: '100', userId: '100' }],
    sendQuestionCard: async () => { throw new Error('feishu down') },
    editResolved: async () => {},
    sendText: async () => true,
  }
  const bridge = createQuestionBridge({ bus, vault, store, notifier, interactive: () => [raw], config: { escalation: { enabled: false } } })
  bridge.attach()
  const pending = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(broadcasts.length, 1, '卡片炸了 → feishu 落回编号文案')
  assert.deepEqual(broadcasts[0].opts, { channelTypes: ['feishu'] })
  bus.accept({ channel: 'feishu', userId: '42', chatId: '100', messageId: 'm1', text: '3' })
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['生产环境'])
  bridge.dispose()
})

// ---------------------------------------------------------------- 发错可再答（用户诉求）

test('发错编号（越界）：回执提示 + 选项重发，问题保持待决，随后正确作答成功', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qq = rig.instances[0]
  // 9 越界（只有 3 个选项）
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:1', text: '9' }),
    { ok: true },
  )
  await sleep(10)
  assert.equal(qq.texts.length, 1, '发错了要说话：回执已发')
  assert.match(qq.texts[0].text, /编号需在 1-3 之间/, '提示错在哪')
  assert.match(qq.texts[0].text, /1\. 测试环境[\s\S]*3\. 生产环境/, '选项已重发一遍')
  // 问题未被作废：仍是 pending
  const rows = rig.store.keys('aq:').map((key) => rig.store.get(key))
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1, '发错不作废')
  // 直接再发一次正确编号即可作答
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:2', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.equal(qq.texts.length, 2)
  assert.match(qq.texts[1].text, /已作答：测试环境/)
  rig.bridge.dispose()
})

test('单选回多项（1,2）：提示本题单选 + 选项重发，保持待决，改回单编号成功', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qq = rig.instances[0]
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:1', text: '1,2' })
  await sleep(10)
  assert.equal(qq.texts.length, 1)
  assert.match(qq.texts[0].text, /本题是单选，请只回复一个编号/)
  assert.match(qq.texts[0].text, /1\. 测试环境/, '选项重发在场')
  const rows = rig.store.keys('aq:').map((key) => rig.store.get(key))
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1, '问题保持待决')
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:2', text: '2' })
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['预发环境'])
  rig.bridge.dispose()
})

test('多选作答：中文逗号 1，3 也认，去重后两项落账', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({ questions: [MULTI] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', userId: '100', chatId: '100', messageId: 'msg:q:1', text: '1，3' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['张三', '王五'])
  rig.bridge.dispose()
})

test('裸编号消费语义：有效作答被消费（不进对话路由），无待决时裸编号不拦', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:1', text: '1' })
  await pending
  // 提问处理器返回 true 已消费 → 后注册的观察者看不到（注册序：提问先于观察者）
  assert.equal(seen.length, 0, '作答消息被提问处理器消费')
  // 无待决提问时裸编号放行（交回对话路由语义由后置观察者见证）
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:2', text: '2' })
  assert.deepEqual(seen, ['2'], '无待决时裸编号不拦')
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- SEC-2 裸回复竞态收紧（latestPendingFor any→hint）

test('SEC-2 关闭跨渠道抢答：feishu 卡片送达 u1，qq u2 未收到话术回裸 1 → 不消费不裁决，超时未答', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'feishu', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] }],
    channelTypes: ['feishu'], // 广播池只有 feishu（已送卡）→ hintChannels=[]
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  // qq 白名单成员 u2=42 回裸 1：qq 既未送卡也未广播编号话术 → 越权面关闭
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '跨渠道裸编号不被消费，落回对话路由')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', '越权作答不落终态')
  const result = await pending
  assert.equal(result.answered, false, '超时未作答（不代答）')
  assert.equal(result.results[0].answered, false)
  rig.bridge.dispose()
})

test('SEC-2 正控：qq 收到编号话术（hintChannels 含 qq）后 qq u2 回 1 → 命中作答', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'feishu', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] }],
    channelTypes: ['feishu', 'qq'], // feishu 送卡，qq 未送卡 → hintChannels=['qq']
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['qq'] }, '编号话术只发 qq')
  // qq u2=42 回 1 → hint 命中
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.match(result.results[0].via, /qq:reply/)
  rig.bridge.dispose()
})

test('SEC-2 多 pending 定向隔离：telegram 回复只命中 telegram 定向的问题，feishu 问题不受影响', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const broadcasts = []
  const notifier = { channels: ['feishu'], notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true } } }
  const feishu = {
    channel: 'feishu',
    notifyTargets: () => [{ chatId: '100', userId: '100' }],
    async sendQuestionCard(p) { return { messageId: 1 } },
    async editResolved() {},
    async sendText() { return true },
  }
  const telegram = {
    channel: 'telegram',
    notifyTargets: () => [{ chatId: '100', userId: '100' }],
    async sendQuestionCard(p) { return { messageId: 1 } },
    async editResolved() {},
    async sendText() { return true },
  }
  const bridge = createQuestionBridge({ bus, vault, store, notifier, interactive: () => [feishu, telegram], config: { timeoutMs: 800, escalation: { enabled: false } } })
  bridge.attach()
  // 问题 A：只推 feishu（channelTypes=['feishu']）→ hintChannels=[]
  const pendingA = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // 问题 B：只推 telegram（channelTypes=['telegram']）→ hintChannels=[]
  notifier.channels = ['telegram']
  const pendingB = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // telegram 白名单成员回 1 → 只命中 B（telegram 定向），A 不受影响
  bus.accept({ channel: 'telegram', userId: '100', chatId: '100', messageId: 'm1', text: '1' })
  const resultB = await pendingB
  assert.equal(resultB.answered, true)
  assert.deepEqual(resultB.results[0].answers, ['测试环境'])
  const aRows = store.keys('aq:').map((k) => store.get(k))
  assert.equal(aRows.filter((r) => r.status === 'pending').length, 1, 'A 未被 telegram 命中，仍 pending')
  const resultA = await pendingA
  assert.equal(resultA.answered, false, 'A 超时未作答')
  bridge.dispose()
})

test('SEC-2 旧行无 hintChannels + 无 pushedTo → 编号作答拒绝（fail-closed 从严）', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  // 手工塞一条旧版在途 aq 行：无 hintChannels、无 pushedTo
  const oldKey = 'aq:oldrow'
  rig.store.set(oldKey, { question: '旧问题', options: ['甲', '乙'], multiSelect: false, status: 'pending', pushedTo: [], createdAt: Date.now() })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 任一渠道回 1 → 不消费（落回对话路由），不裁决
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '旧行无 hintChannels → 编号不被消费，落回对话路由')
  assert.equal(rig.store.get(oldKey).status, 'pending', '旧行不被裁决，仍 pending')
  rig.bridge.dispose()
})

test('SEC-2 hint 与 exact 优先级稳定：exact 行优先于 hint 行', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'telegram', card: true }], channelTypes: ['telegram'] })
  // 行 X：telegram:u1 推送过（exact）+ hintChannels 含 telegram（hint 也成立）
  const xKey = 'aq:x'
  rig.store.set(xKey, { question: 'X', options: ['甲', '乙'], multiSelect: false, status: 'pending', pushedTo: [{ channel: 'telegram', chatId: '100', userId: '100', messageId: 1, kind: 'aq' }], hintChannels: ['telegram'], createdAt: Date.now() })
  // 行 Y：仅 hintChannels 含 telegram（无推送）
  const yKey = 'aq:y'
  rig.store.set(yKey, { question: 'Y', options: ['甲', '乙'], multiSelect: false, status: 'pending', pushedTo: [], hintChannels: ['telegram'], createdAt: Date.now() + 1 })
  // 为两端注册 waiter（生产路径由 askQuestions/bus.wait 注册；手工种行需等价注册才能 settle）
  rig.bus.wait(xKey, 800, {})
  rig.bus.wait(yKey, 800, {})
  // telegram u1 回 1 → 命中 X（exact 优先于 hint），Y 不受影响
  rig.bus.accept({ channel: 'telegram', userId: '100', chatId: '100', messageId: 'm1', text: '1' })
  assert.equal(rig.store.get(xKey).status, 'resolved', 'exact 行被命中')
  assert.equal(rig.store.get(xKey).decision, 'answered')
  assert.equal(rig.store.get(yKey).status, 'pending', 'hint 行不被 exact 抢走')
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- 按钮路径与红线

test('按钮作答：token 裁决 → 卡片终态编辑（已作答文案）+ 账本落定', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const tg = rig.instances[0]
  const payload = tg.cards[0]
  const verdict = rig.bridge.decide({ qKey: payload.qKey, optIdx: '2', token: payload.token, via: 'telegram', userId: '100' })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.answers, ['生产环境'])
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['生产环境'])
  assert.equal(tg.edits.length, 1)
  assert.match(tg.edits[0].text, /已作答：生产环境/)
  const row = rig.store.get(payload.qKey)
  assert.equal(row.status, 'resolved')
  assert.equal(row.decision, 'answered')
  rig.bridge.dispose()
})

test('按钮作答：转发点击 chat 不一致 → 拒绝并保留待决，原会话仍可正常作答', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const tg = rig.instances[0]
  const payload = tg.cards[0]
  const wrong = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'telegram', userId: '100', chatId: '999' })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /请到原会话操作/)
  const row = rig.store.get(payload.qKey)
  assert.equal(row.status, 'pending')
  const right = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'telegram', userId: '100', chatId: '100' })
  assert.equal(right.ok, true)
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

// v0.8.3 SEC-1：来源校验把通道一并纳入——chatId 相同但通道不同视为不同来源（拒绝）。
test('按钮作答：chatId 相同但跨通道（via 非原通道）→ 拒绝，不改判原卡', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const payload = rig.instances[0].cards[0]
  // 卡片实际送达 telegram chat 100；伪造来自 qq 的同 chatId 100 → 拒绝
  const crossChannel = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'qq:button', userId: 'u2', chatId: '100' })
  assert.equal(crossChannel.ok, false)
  assert.match(crossChannel.message, /请到原会话操作/)
  assert.equal(rig.store.get(payload.qKey).status, 'pending', '跨通道点击不落终态')
  // 原通道 telegram 同 chatId → 通过
  const right = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'telegram', userId: '100', chatId: '100' })
  assert.equal(right.ok, true)
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

test('首达采纳：作答后同 token 再点按钮被拒（问题已回答）', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const payload = rig.instances[0].cards[0]
  assert.equal(rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token }).ok, true)
  const again = rig.bridge.decide({ qKey: payload.qKey, optIdx: '1', token: payload.token })
  assert.equal(again.ok, false)
  assert.match(again.message, /已回答或已过期/)
  await pending
  rig.bridge.dispose()
})

test('伪造 token 被拒，问题继续等到超时（不代答）', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const payload = rig.instances[0].cards[0]
  const forged = rig.vault.mint('aq:other:9')
  const bad = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: 'garbage.sig' })
  assert.equal(bad.ok, false)
  const mismatch = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: forged })
  assert.equal(mismatch.ok, false)
  const result = await pending // 超时收场（800ms 配置）
  assert.equal(result.ok, true)
  assert.equal(result.answered, false)
  assert.equal(result.results[0].answered, false)
  assert.equal(result.results[0].answers, undefined, '超时绝不编造答案')
  const row = rig.store.get(payload.qKey)
  assert.equal(row.decision, 'timeout')
  assert.equal(rig.instances[0].edits.length, 1)
  assert.match(rig.instances[0].edits[0].text, /超时未作答/)
  rig.bridge.dispose()
})

test('多问逐问推送逐问独立作答：全答 answered=true，一问超时 answered=false', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'qq', card: false }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({
    questions: [SINGLE, MULTI],
    timeoutMs: 500,
  })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', userId: '42', chatId: '42', messageId: 'msg:q:1', text: '1' })
  // 第二问不答 → 超时
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.answered, false)
  assert.equal(result.results[0].answered, true)
  assert.equal(result.results[1].answered, false)
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- validateAskArgs

test('validateAskArgs：questions 边界（0/5 个、选项 1/6 项、label 空/超长）全拒', () => {
  const base = { question: 'q', options: [{ label: 'a' }, { label: 'b' }] }
  assert.equal(validateAskArgs({ questions: [] }).ok, false)
  assert.match(validateAskArgs({ questions: [] }).reason, /1 到 4/)
  assert.equal(validateAskArgs({ questions: Array.from({ length: 5 }, () => base) }).ok, false)
  assert.equal(validateAskArgs({ questions: [{ question: '', options: base.options }] }).ok, false)
  assert.equal(validateAskArgs({ questions: [{ question: 'q', options: [{ label: 'a' }] }] }).ok, false)
  assert.equal(validateAskArgs({
    questions: [{ question: 'q', options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })) }],
  }).ok, false)
  assert.equal(validateAskArgs({
    questions: [{ question: 'q', options: [{ label: '' }, { label: 'b' }] }],
  }).ok, false)
  assert.equal(validateAskArgs({
    questions: [{ question: 'q', options: [{ label: 'x'.repeat(61) }, { label: 'b' }] }],
  }).ok, false)
  const ok = validateAskArgs({ questions: [base] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.questions, [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }])
})

test('validateAskArgs：timeoutMs 钳制到 30s-30min，缺省 300s；context 截 300', () => {
  const questions = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }]
  assert.equal(validateAskArgs({ questions, timeoutMs: 1000 }).timeoutMs, 30_000)
  assert.equal(validateAskArgs({ questions, timeoutMs: 99_999_999 }).timeoutMs, 1_800_000)
  assert.equal(validateAskArgs({ questions }).timeoutMs, 300_000)
  assert.equal(validateAskArgs({ questions, timeoutMs: 'abc' }).timeoutMs, 300_000)
  const withContext = validateAskArgs({ questions, context: 'x'.repeat(500) })
  assert.equal(withContext.context.length, 300)
})

// ---------------------------------------------------------------- registerAskUserTool

function makeToolCtx() {
  const defs = []
  return {
    defs,
    ctx: { tools: { register: (def) => { defs.push(def); return () => {} } } },
  }
}

test('registerAskUserTool：宿主无 tools 服务返回 null（静默跳过不崩）', () => {
  assert.equal(registerAskUserTool({}, {}), null)
  assert.equal(registerAskUserTool({ tools: {} }, {}), null)
})

test('registerAskUserTool：参数校验失败返回明确原因，不触达桥', async () => {
  const forbidden = { askQuestions: () => { throw new Error('不应触达桥') } }
  const { ctx, defs } = makeToolCtx()
  const dispose = registerAskUserTool(ctx, forbidden, { rateLimitPerMinute: 6 })
  assert.equal(defs.length, 1)
    const result = await defs[0].execute({ questions: [] }, { agent: { id: 'agent-1' } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /1 到 4/)
  assert.equal(result.answered, false)
  assert.ok(dispose !== null)
  dispose()
})

test('registerAskUserTool：完整注册形状 + 渲染 + 端到端作答', async () => {
  const rig = makeRig()
  const { ctx, defs } = makeToolCtx()
  const dispose = registerAskUserTool(ctx, rig.bridge, { rateLimitPerMinute: 6 })
  assert.equal(defs.length, 1)
  const def = defs[0]
  assert.equal(def.name, 'ask_user')
  assert.deepEqual(def.parameters.required, ['questions'])
  const first = def.execute({ questions: [{ question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] }, { agent: { id: 'agent-1' } })
  await sleep(30)
  const payload = rig.instances[0].cards[0]
  rig.bridge.decide({ qKey: payload.qKey, optIdx: '1', token: payload.token, via: 'telegram', userId: '100' })
  const firstResult = await first
  assert.equal(firstResult.ok, true)
  assert.equal(firstResult.answered, true)
  assert.match(def.output.render({}, firstResult)[0].text, /用户已作答/)
  const invalid = await def.execute({ questions: [] })
  assert.equal(invalid.ok, false)
  assert.match(invalid.reason, /1 到 4/)
  assert.match(def.output.render({}, invalid)[0].text, /提问未发出/)
  const timeoutShape = { ok: true, answered: false, results: [{ question: 'q', answered: false }] }
  assert.match(def.output.render({}, timeoutShape)[0].text, /未在时限内完成全部作答/)
  dispose()
  rig.bridge.dispose()
})

test('registerAskUserTool：限流——每分钟第二次调用直接拒，不触达桥', async () => {
  const forbidden = { askQuestions: () => { throw new Error('不应触达桥') } }
  const { ctx, defs } = makeToolCtx()
  const dispose = registerAskUserTool(ctx, forbidden, { rateLimitPerMinute: 1 })
  const def = defs[0]
  const questions = [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }]
  const first = await def.execute({ questions, timeoutMs: 1 }) // 30s 钳制不影响：限流先判
  assert.notEqual(first.rateLimited, true, '第一次应放行')
  const limited = await def.execute({ questions })
  assert.equal(limited.rateLimited, true)
  assert.equal(limited.ok, false)
  assert.match(def.output.render({}, limited)[0].text, /已限流/)
  dispose()
})

test('B3 dispose 级联：ask_user 任务在 agent/disposed 后标记 terminated', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const broadcasts = []
  const notifier = { channels: ['telegram'], notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true, delivered: [], skipped: [], failed: [] } } }
  const instances = [{
    raw: {
      channel: 'telegram',
      notifyTargets: () => [{ chatId: '100', userId: '100' }],
      async sendQuestionCard(payload) { return { messageId: 1 } },
      async editResolved(target, text) { broadcasts.push({ target, text }) },
      async sendText() { return true },
    },
  }]
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    interactive: () => instances.map((item) => item.raw),
    config: { timeoutMs: 800, escalation: { enabled: false } },
  })
  bridge.attach()
  const pending = bridge.askQuestions({ questions: [SINGLE] }, { agent: { id: 'agent-9' } })
  await sleep(30)
  assert.equal(bus.abandonByAgent('agent-9'), 1)
  const result = await pending
  assert.equal(result.answered, false)
  assert.equal(result.results[0].reason, 'terminated')
  assert.equal(store.keys('aq:').length, 1)
  assert.equal(store.get(store.keys('aq:')[0]).decision, 'terminated')
  bridge.dispose()
})
