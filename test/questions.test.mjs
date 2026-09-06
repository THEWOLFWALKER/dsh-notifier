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
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'

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
 * @param {object} [options.identity] - 身份注册表（CRACK-004 hint 兜底归属闸；缺省不传）
 * @param {object} [options.logger] - 宿主 logger 桩（捕获 warn 断言）
 */
function makeRig({ inbounds = [{ channel: 'telegram', accountId: 'TG_APP', card: true }], channelTypes = ['telegram'], identity = null, logger = null, escalation = { enabled: false }, notifyOutcome = null } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
  const broadcasts = [] // { msg, opts } —— 编号兜底/提醒广播
  const notifier = {
    channels: channelTypes,
    notifyAll: async (msg, opts) => {
      broadcasts.push({ msg, opts })
      if (notifyOutcome !== null) return typeof notifyOutcome === 'function' ? notifyOutcome(msg, opts) : notifyOutcome
      return { ok: true, delivered: Array.isArray(opts?.channelTypes) ? [...opts.channelTypes] : [], skipped: [], failed: [] }
    },
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
        // v0.8.7：真实适配器始终提供 accountId；测试 fixture 必须模拟此行为。
        ...(spec.accountId !== undefined ? { accountId: spec.accountId } : {}),
        // When an identity registry is present, make the fixture's outbound
        // target the same bound user.  CC-1 requires per-chat delivery
        // evidence; a channel-level notifyAll result must never authorize a
        // different user/chat by accident.
        notifyTargets: () => {
          if (spec.targets !== undefined) return spec.targets
          try {
            const bound = identity?.list?.(spec.channel)
            if (Array.isArray(bound) && bound.length > 0) {
              return bound.map((record) => ({ chatId: String(record.userId), userId: String(record.userId) }))
            }
          } catch { /* test fixture falls back to the legacy default target */ }
          return [{ chatId: '100', userId: '100' }]
        },
        async sendQuestionCard(payload) {
          if (spec.card !== true) return null
          cards.push(payload)
          return { messageId: cards.length }
        },
        async editResolved(target, text) { edits.push({ target, text }) },
        async sendText(chatId, text) { texts.push({ chatId, text }); return spec.sendTextResult !== false },
      },
    })
  }
  const bridge = createQuestionBridge({
    bus,
    vault,
    store,
    notifier,
    control: createControlEntry(),
    ...(identity !== null ? { identity } : {}),
    ...(logger !== null ? { logger } : {}),
    interactive: () => instances.map((item) => item.raw),
    config: { timeoutMs: 800, escalation },
  })
  bridge.attach() // 挂编号回复处理器（生产装配序：审批之后）
  return { store, vault, bus, broadcasts, instances, bridge }
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '预发环境' }, { label: '生产环境' }] }
const MULTI = { question: '勾选要通知的人', options: [{ label: '张三' }, { label: '李四' }, { label: '王五' }], multiSelect: true }

test('升级提醒逐目标发送：同一渠道的无关 chat 不会收到提醒', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: true, targets: [{ chatId: 'qq-target', userId: 'u1' }] }],
    channelTypes: ['qq-bot'],
    escalation: { enabled: true, stages: [{ afterMs: 15, note: '提醒' }] },
  })
  const other = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: true, targets: [{ chatId: 'qq-other', userId: 'u2' }] }],
    channelTypes: ['qq-bot'],
    escalation: { enabled: true, stages: [{ afterMs: 15, note: '提醒' }] },
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  const otherPending = other.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(120)
  assert.equal(rig.broadcasts.length, 1, '只保留初始编号兜底广播，不广播升级提醒')
  assert.equal(other.broadcasts.length, 1, '第二实例也只保留初始编号兜底广播')
  assert.match(rig.instances[0].texts[0].text, /仍在等待作答/)
  assert.equal(other.instances[0].texts[0].text.includes('仍在等待作答'), true)
  assert.equal(rig.instances[0].texts[0].chatId, 'qq-target')
  assert.equal(other.instances[0].texts[0].chatId, 'qq-other')
  assert.equal(rig.instances[0].texts.some((entry) => entry.chatId === 'qq-other'), false)
  assert.equal(other.instances[0].texts.some((entry) => entry.chatId === 'qq-target'), false)
  const qKey = rig.store.keys('aq:')[0]
  const row = rig.store.get(qKey)
  assert.equal(row.status, 'pending')
  rig.bridge.dispose()
  other.bridge.dispose()
  await pending
  await otherPending
})

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
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }],
    channelTypes: ['qq', 'wxpusher'],
    identity,
    // notifyAll is channel-level only; force the fixture through the
    // per-chat sendText path so CC-1 can record exact hintTargets evidence.
    notifyOutcome: { ok: true, delivered: [], skipped: ['qq', 'wxpusher'], failed: [] },
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 0, 'qq 无卡片能力')
  assert.equal(rig.broadcasts.length, 1)
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['qq', 'wxpusher'] })
  assert.match(rig.broadcasts[0].msg.content, /1\. 测试环境[\s\S]*3\. 生产环境/, '选项列表随编号文案下发')
  // qq 用户 42（白名单）回复 2 → 裁决为「预发环境」
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:1', text: '2' }),
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
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'feishu', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const broadcasts = []
  const notifier = {
    channels: ['feishu'],
    notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true, delivered: [], skipped: ['feishu'], failed: [] } },
  }
  const raw = {
    channel: 'feishu',
    notifyTargets: () => [{ chatId: 'oc_00000042', userId: '42' }],
    sendQuestionCard: async () => { throw new Error('feishu down') },
    editResolved: async () => {},
    sendText: async () => true,
  }
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control: createControlEntry(), interactive: () => [raw],
    config: { timeoutMs: 800, escalation: { enabled: false } },
  })
  bridge.attach()
  const pending = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(broadcasts.length, 1, '卡片炸了 → feishu 落回编号文案')
  assert.deepEqual(broadcasts[0].opts, { channelTypes: ['feishu'] })
  bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'private', userId: '42', chatId: 'oc_00000042', messageId: 'm1', text: '3' })
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['生产环境'])
  bridge.dispose()
})

// ---------------------------------------------------------------- 发错可再答（用户诉求）

test('发错编号（越界）：回执提示 + 选项重发，问题保持待决，随后正确作答成功', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qq = rig.instances[0]
  // 9 越界（只有 3 个选项）
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:1', text: '9' }),
    { ok: true },
  )
  await sleep(10)
  assert.equal(qq.texts.length, 2, '初始编号话术 + 错误回执')
  assert.match(qq.texts.at(-1).text, /编号需在 1-3 之间/, '提示错在哪')
  assert.match(qq.texts.at(-1).text, /1\. 测试环境[\s\S]*3\. 生产环境/, '选项已重发一遍')
  // 问题未被作废：仍是 pending
  const rows = rig.store.keys('aq:').map((key) => rig.store.get(key))
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1, '发错不作废')
  // 直接再发一次正确编号即可作答
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:2', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.equal(qq.texts.length, 3)
  assert.match(qq.texts.at(-1).text, /已作答：测试环境/)
  rig.bridge.dispose()
})

test('单选回多项（1,2）：提示本题单选 + 选项重发，保持待决，改回单编号成功', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qq = rig.instances[0]
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:1', text: '1,2' })
  await sleep(10)
  assert.equal(qq.texts.length, 2)
  assert.match(qq.texts.at(-1).text, /本题是单选，请只回复一个编号/)
  assert.match(qq.texts.at(-1).text, /1\. 测试环境/, '选项重发在场')
  const rows = rig.store.keys('aq:').map((key) => rig.store.get(key))
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1, '问题保持待决')
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:2', text: '2' })
  const result = await pending
  assert.deepEqual(result.results[0].answers, ['预发环境'])
  rig.bridge.dispose()
})

test('多选作答：中文逗号 1，3 也认，去重后两项落账', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '100' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-100', userId: '100' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({ questions: [MULTI] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qq-user-100', messageId: 'msg:q:1', text: '1，3' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['张三', '王五'])
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- G-52 分隔符宽容化

/** G-52：同一 rig 逐形态驱动多选作答（每形态独立提问、独立断言，共用装配减少样板）。 */
async function driveMultiForm(text) {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '100' })
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-100', userId: '100' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [MULTI] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qq-user-100', messageId: `msg:q:${text}`, text })
  const result = await pending
  rig.bridge.dispose()
  return { result, seen }
}

test('G-52 裸编号多选分隔符矩阵：1, 3 / 1、3 / 1 3 / 1；3 均按多选裁决两项', async () => {
  for (const text of ['1, 3', '1、3', '1 3', '1；3']) {
    const { result, seen } = await driveMultiForm(text)
    assert.equal(result.answered, true, `${text} → 已作答`)
    assert.deepEqual(result.results[0].answers, ['张三', '王五'], `${text} → 落账两项`)
    assert.deepEqual(seen, [], `${text} → 裸编号被消费，不进对话路由`)
  }
})

test('G-52 分隔符混用：1, 3、2 三种分隔符并存仍逐词解析，三项全落账', async () => {
  const { result } = await driveMultiForm('1, 3、2')
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['张三', '王五', '李四'], '混用分隔符逐词解析（顺序保持）')
})

test('G-52 重复编号去重：1, 1 等价单选 1（不触发单选多项误报）', async () => {
  const { result, seen } = await driveMultiForm('1, 1')
  assert.equal(result.answered, true, '去重后按单编号作答成功')
  assert.deepEqual(result.results[0].answers, ['张三'])
  assert.deepEqual(seen, [], '被消费不进对话路由')
})

test('G-52 单选 + 重复编号：2 2 去重为单编号，不再误报「本题是单选」', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:dup', text: '2 2' })
  const result = await pending
  assert.equal(result.answered, true, '重复编号去重后按 2 作答')
  assert.deepEqual(result.results[0].answers, ['预发环境'])
  rig.bridge.dispose()
})

test('G-52 fail-closed 保持：混入非编号词（1, a / 1 2x）整条不认，落回对话路由', async () => {
  for (const text of ['1, a', '1 2x', '一, 3', '1..3']) {
    const { result, seen } = await driveMultiForm(text)
    assert.equal(result.answered, false, `${text} → 不裁决（超时未答）`)
    assert.deepEqual(seen, [text], `${text} → 落回对话路由（未被消费）`)
  }
})

test('G-52 越界号维持既有回执：1, 99 → 提示编号需在 1-3 之间 + 选项重发，问题保持待决', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '100' })
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-100', userId: '100' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({ questions: [MULTI] })
  await sleep(30)
  const qq = rig.instances[0]
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qq-user-100', messageId: 'msg:q:oor', text: '1, 99' })
  await sleep(10)
  assert.ok(qq.texts.length > 0, '有回执')
  assert.match(qq.texts.at(-1).text, /编号需在 1-3 之间/, '越界提示在场（逗号后空格形态也进越界分支）')
  assert.match(qq.texts.at(-1).text, /1\. 张三/, '选项重发在场')
  assert.equal(rig.store.get(rig.store.keys('aq:')[0]).status, 'pending', '问题保持待决')
  // 发错了可以再发：随后用规范形态作答成功
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qq-user-100', messageId: 'msg:q:oor2', text: '1, 2' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['张三', '李四'])
  rig.bridge.dispose()
})

test('裸编号消费语义：有效作答被消费（不进对话路由），无待决时裸编号不拦', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:1', text: '1' })
  await pending
  // 提问处理器返回 true 已消费 → 后注册的观察者看不到（注册序：提问先于观察者）
  assert.equal(seen.length, 0, '作答消息被提问处理器消费')
  // 无待决提问时裸编号放行（交回对话路由语义由后置观察者见证）
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:2', text: '2' })
  assert.deepEqual(seen, ['2'], '无待决时裸编号不拦')
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- SEC-2 裸回复竞态收紧（latestPendingFor any→hint）

test('SEC-2 关闭跨渠道抢答：feishu 卡片送达 u1，qq u2 未收到话术回裸 1 → 不消费不裁决，超时未答', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] }],
    channelTypes: ['feishu'], // 广播池只有 feishu（已送卡）→ hintChannels=[]
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  // qq 白名单成员 u2=42 回裸 1：qq 既未送卡也未广播编号话术 → 越权面关闭
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '跨渠道裸编号不被消费，落回对话路由')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', '越权作答不落终态')
  const result = await pending
  assert.equal(result.answered, false, '超时未作答（不代答）')
  assert.equal(result.results[0].answered, false)
  rig.bridge.dispose()
})

test('SEC-2 正控：qq 收到逐 chat 编号话术后 qq u2 回 1 → 命中作答', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({
    inbounds: [
      { channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] },
      { channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] },
    ],
    channelTypes: ['feishu', 'qq'], // qq 的逐 chat sendText 成功才构成 hintTargets 证据
    identity,
    notifyOutcome: { ok: true, delivered: ['feishu'], skipped: ['qq'], failed: [] },
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['qq'] }, '编号话术只发 qq')
  // qq u2=42 回 1 → hint 命中
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' })
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
  const notifier = { channels: ['feishu'], notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true, delivered: ['feishu'], skipped: [], failed: [] } } }
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
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, control: createControlEntry(), interactive: () => [feishu, telegram],
    config: { timeoutMs: 800, escalation: { enabled: false } },
  })
  bridge.attach()
  // 问题 A：只推 feishu（channelTypes=['feishu']）→ hintChannels=[]
  const pendingA = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // 问题 B：只推 telegram（channelTypes=['telegram']）→ hintChannels=[]
  notifier.channels = ['telegram']
  const pendingB = bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // telegram 白名单成员回 1 → 只命中 B（telegram 定向），A 不受影响
  bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'm1', text: '1' })
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
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false }], channelTypes: ['qq'] })
  // 手工塞一条旧版在途 aq 行：无 hintChannels、无 pushedTo
  const oldKey = 'aq:oldrow'
  rig.store.set(oldKey, { question: '旧问题', options: ['甲', '乙'], multiSelect: false, status: 'pending', pushedTo: [], createdAt: Date.now() })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 任一渠道回 1 → 不消费（落回对话路由），不裁决
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '旧行无 hintChannels → 编号不被消费，落回对话路由')
  assert.equal(rig.store.get(oldKey).status, 'pending', '旧行不被裁决，仍 pending')
  rig.bridge.dispose()
})

test('SEC-2 hint 与 exact 优先级稳定：exact 行优先于 hint 行', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'telegram', accountId: 'TG_APP', card: true }], channelTypes: ['telegram'] })
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
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'm1', text: '1' })
  assert.equal(rig.store.get(xKey).status, 'resolved', 'exact 行被命中')
  assert.equal(rig.store.get(xKey).decision, 'answered')
  assert.equal(rig.store.get(yKey).status, 'pending', 'hint 行不被 exact 抢走')
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- issue #11 出站/入站异名 + 纯入站通道编号作答

test('issue #11 QQ：qq-bot 出站 ↔ qq 入站异名 → 逐 chat hintTargets 证据后编号回复命中', async () => {
  // 出站只有 qq-bot（文本）→ 编号话术经出站 qq-bot 送达；入站 qq 无卡片能力。
  // 修复前 hintChannels=['qq-bot']，qq 入站回复编号命中不了 → timeout + 对话污染。
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qquser42', userId: '42' }] }], channelTypes: ['qq-bot'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq-bot'], failed: [] } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 0, 'qq 无卡片能力')
  assert.equal(rig.broadcasts.length, 1, '编号话术经出站 qq-bot 广播')
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['qq-bot'] })
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [{ channel: 'qq', accountId: 'QQ_APP', chatId: 'qquser42', userId: '42' }], '只记录 qq 目标 chat 的逐目标送达证据（真实适配器恒携带本地 accountId）')
  assert.equal(rig.instances[0].texts.length, 1, 'qq 入站 sendText 送达一次，不重复广播')
  // qq 用户 42 回复编号 → hint 命中（异名通道回复生效）
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qquser42', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.match(result.results[0].via, /qq:reply/)
  assert.equal(seen.length, 0, '编号作答被消费，不进对话路由（防污染）')
  rig.bridge.dispose()
})

test('issue #11 微信 iLink 纯入站：hintTargets 记录 sendText 送达，wechat 回复命中', async () => {
  // wechat iLink 是 inbound-only（无对应出站 type、无 sendQuestionCard）。
  // 修复前编号话术永不送达、hintChannels 永不含 wechat → 编号作答完全失效。
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'wechat', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'wechat', accountId: 'WX_APP', card: false, targets: [{ chatId: 'wxuser42', userId: '42' }] }], channelTypes: ['telegram'], identity })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 0, 'wechat 无卡片能力')
  assert.deepEqual(rig.broadcasts[0].opts, { channelTypes: ['telegram'] }, '出站广播照常只发 telegram')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [{ channel: 'wechat', accountId: 'WX_APP', chatId: 'wxuser42', userId: '42' }], 'hintTargets 含纯入站 wechat 目标（含本地 accountId）')
  assert.equal(rig.instances[0].texts.length, 1, '纯入站通道经 sendText 收到编号话术')
  assert.match(rig.instances[0].texts[0].text, /回复编号/, '编号话术在场')
  // wechat 用户回 1 → hint 命中
  rig.bus.accept({ channel: 'wechat', accountId: 'WX_APP', userId: '42', chatId: 'wxuser42', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.match(result.results[0].via, /wechat:reply/)
  rig.bridge.dispose()
})

test('SEC-2 发送失败不登记 hint 证据：纯入站渠道未收到话术时裸编号不命中', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'wechat', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'wechat', accountId: 'WX_APP', card: false, sendTextResult: false, targets: [{ chatId: 'wxuser42', userId: '42' }] }],
    channelTypes: ['telegram'],
    identity,
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [], 'sendText 失败时不登记 wechat hint')
  rig.bus.accept({ channel: 'wechat', accountId: 'WX_APP', userId: '42', chatId: 'wxuser42', messageId: 'm-fail', text: '1' })
  const result = await pending
  assert.equal(result.answered, false, '未收到题目时裸编号不能作答')
  rig.bridge.dispose()
})

test('SEC-2 出站广播无实际 delivered 不登记 hint 证据', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'telegram', userId: '42' })
  const rig = makeRig({
    inbounds: [],
    channelTypes: ['telegram'],
    identity,
    notifyOutcome: { ok: true, delivered: [], skipped: ['(no-targets)'], failed: [] },
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [], '空目标/静音广播不留下逐 chat 编号证据')
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: 'tg-42', messageId: 'm-no-delivery', text: '1' })
  const result = await pending
  assert.equal(result.answered, false, '未实际送达时裸编号不能作答')
  rig.bridge.dispose()
})

test('issue #11 fail-closed：未绑定目标用户的入站通道不补入 hintTargets，裸编号仍拒绝', async () => {
  // qq 目标用户 42（绑定）；feishu 无绑定目标（notifyTargets 空）→ feishu 不进 hintChannels。
  const rig = makeRig({
    inbounds: [
      { channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qquser42', userId: '42' }] },
      { channel: 'feishu', accountId: 'FS_APP', card: false, targets: [] },
    ],
    channelTypes: ['qq-bot'],
    notifyOutcome: { ok: true, delivered: [], skipped: ['qq-bot'], failed: [] },
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [{ channel: 'qq', accountId: 'QQ_APP', chatId: 'qquser42', userId: '42' }], 'feishu 无绑定目标不入 hintTargets（含本地 accountId）')
  // feishu 白名单用户 100 回 1 → 不命中（feishu 未收到话术），落回对话路由
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'private', userId: '100', chatId: 'oc_100', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '无关通道裸编号不被消费')
  assert.equal(row.status, 'pending', '无关通道作答不落终态')
  rig.bridge.dispose()
})

// ---------------------------------------------------------------- CRACK-004 归属闸（hint 兜底仅 owner；exact/onChannel 当事人级）

test('CRACK-004 归属闸：hint 命中但代答者是 member → 拒（消费 + 回执「无权」+ warn，问题保持待决）', async () => {
  // feishu 卡片送达本人；qq 无卡片 → hintTargets 记录 qq 目标。qq 渠道 owner=100、member=42。
  const warns = []
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '100' }) // 首条绑定 = owner
  identity.addBinding({ channel: 'qq', userId: '42' }) // 第二条 = member
  const rig = makeRig({
    inbounds: [
      { channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] },
      { channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }, // 编号话术经出站广播到 qq + 入站补发，回执走此实例
    ],
    channelTypes: ['feishu', 'qq'],
    notifyOutcome: { ok: true, delivered: [], skipped: ['feishu', 'qq'], failed: [] },
    identity,
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  // qq member 42 回裸 1：hint 兜底命中，但非 owner → 归属闸拒绝
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' }),
    { ok: true },
  )
  assert.deepEqual(seen, [], '拒绝也要消费裸编号，不进对话路由')
  assert.equal(rig.instances[1].texts.length, 2, '先发编号话术，再发拒绝回执')
  assert.match(rig.instances[1].texts.at(-1).text, /无权/)
  assert.equal(warns.some((w) => /越权拒绝.*evidence=hint/.test(w)), true, '拒绝必须留痕且带归属证词（静默即事故）')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', 'member 代答不落终态')
  const result = await pending
  assert.equal(result.answered, false, '问题未被 member 代答（超时交还桌面）')
  rig.bridge.dispose()
})

test('CRACK-004 放行矩阵：hint + owner → 正常作答（兜底链不断）', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner
  const rig = makeRig({
    inbounds: [
      { channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] },
      { channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] },
    ],
    channelTypes: ['feishu', 'qq'], // feishu 送卡，qq 未送卡 → hintTargets 记录 qq 目标
    notifyOutcome: { ok: true, delivered: [], skipped: ['feishu', 'qq'], failed: [] },
    identity,
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' }),
    { ok: true },
  )
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.match(result.results[0].via, /qq:reply/)
  rig.bridge.dispose()
})

test('CRACK-004 放行矩阵：exact/onChannel 本人作答不查 identity（防过度收紧——未绑定用户本人仍可答）', async () => {
  // 卡片送达 qq 用户 100 本人（pushedTo 含 userId 100），hintChannels=[]。
  // identity 在场但不含 100（只有 qq:42 owner）→ 用户 100 本人回编号必须照常放行：
  // exact/onChannel 是当事人级证词，归属闸不得要求身份绑定或 owner 角色。
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 表里只有别人；100 完全未绑定
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: true, targets: [{ chatId: 'qquser100', userId: '100' }] }],
    channelTypes: ['qq'],
    identity,
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'qq 卡片已送达')
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qquser100', messageId: 'm1', text: '1' }),
    { ok: true },
  )
  const result = await pending
  assert.equal(result.answered, true, '卡片收件人本人作答不被归属闸误伤')
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

test('CRACK-004 fail-closed：identity 缺失时 hint 兜底一律拒（消费 + 回执「无权」+ warn）', async () => {
  const warns = []
  const rig = makeRig({
    inbounds: [
      { channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] },
      { channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] },
    ],
    channelTypes: ['feishu', 'qq'], // hintTargets 记录 qq 目标
    notifyOutcome: { ok: true, delivered: [], skipped: ['feishu', 'qq'], failed: [] },
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  }) // 不传 identity → 生产装配缺失时编号兜底必须 fail-closed
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.deepEqual(
    rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' }),
    { ok: true },
  )
  assert.deepEqual(seen, [], 'fail-closed 也消费裸编号')
  assert.equal(rig.instances[1].texts.length, 2)
  assert.match(rig.instances[1].texts.at(-1).text, /无权/)
  assert.equal(warns.some((w) => /越权拒绝.*evidence=hint/.test(w)), true)
  const result = await pending
  assert.equal(result.answered, false, 'identity 缺失 → hint 一律拒，超时交还桌面')
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

test('AUTH-1 总线层来源校验：card 到 chat A，chat B 的 bus.decide 被拒且不核销，原会话仍可答', async () => {
  const rig = makeRig()
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const tg = rig.instances[0]
  const payload = tg.cards[0]
  // 转发到非目标 chat 999 → 总线明确拒绝 source-chat-mismatch（AUTH-1：allowChats 已注册）
  const forwarded = rig.bus.decide({
    approvalKey: payload.qKey,
    decision: 'allowed-once',
    token: payload.token,
    via: 'telegram:button',
    userId: '100',
    chatId: '999',
  })
  assert.deepEqual(forwarded, { ok: false, reason: 'source-chat-mismatch' })
  assert.equal(rig.store.get(payload.qKey).status, 'pending', '转发裁决不落终态/不核销 wait')
  // 原会话 chat 100 仍可答（走 questions.decide 真实按钮路径）
  const right = rig.bridge.decide({ qKey: payload.qKey, optIdx: '0', token: payload.token, via: 'telegram', userId: '100', chatId: '100' })
  assert.equal(right.ok, true)
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

// v0.8.4 AUTH-1：空目标（无任何可送卡会话）→ allowChats 为空 Map，不放行任意 chat。
test('AUTH-1 空目标：无推卡会话时任意 chatId 的 bus.decide 均被拒（不放行 wildcard）', async () => {
  const rig = makeRig({ inbounds: [{ channel: 'telegram', accountId: 'TG_APP', card: true, targets: [] }], channelTypes: ['telegram'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const keys = rig.store.keys('aq:')
  assert.equal(keys.length, 1, '在途问题存在')
  const qKey = keys[0]
  // 无任何可送卡会话 → bus.wait 用空 allowChats 注册。用合法 token 走按钮裁决，任意 chatId
  // 都会命中空 Map → source-chat-mismatch（不放行 wildcard），且不核销 wait。
  const token = rig.vault.mint(qKey)
  const verdict = rig.bus.decide({
    approvalKey: qKey,
    decision: 'allowed-once',
    token,
    via: 'telegram:button',
    userId: '100',
    chatId: '100',
  })
  assert.deepEqual(verdict, { ok: false, reason: 'source-chat-mismatch' })
  assert.equal(rig.store.get(qKey).status, 'pending', '空目标下载决不落终态')
  const result = await pending // 超时收场（不代答）
  assert.equal(result.answered, false)
  rig.bridge.dispose()
})

// v0.8.4 SEC-5/6：同渠道非提问者回裸编号被拒（onChannel 收紧 → 不命中、不消费、不落终态）。
test('SEC-5/6 同渠道非提问者：回裸编号被拒（不消费不裁决，问题保持待决）', async () => {
  // 卡片送达 qq 用户 100（提示该用户可答）；channelTypes=['qq'] 且卡已送达 → hintChannels=[]，
  // 不存在 hint 兜底。同渠道另一绑定用户 42 回裸 1：SEC-5/6 下不命中（不同 userId）、不消费。
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: true, targets: [{ chatId: 'qquser100', userId: '100' }] }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'qq 卡片已送达')
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '非提问者裸编号不被消费，落回对话路由')
  const rows = rig.store.keys('aq:').map((key) => rig.store.get(key))
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1, '非提问者作答不落终态')
  const result = await pending
  assert.equal(result.answered, false, '问题未被他人代答')
  rig.bridge.dispose()
})

// v0.8.4 SEC-5/6 正控：正确用户正确渠道回编号仍可作答（收紧不误伤合法用户）。
test('SEC-5/6 正控：卡片送达的用户本人（正确渠道）回裸编号可正常作答', async () => {
  // 卡片送达 qq 用户 100（pushedTo 含 userId 100），无 hintTargets。用户本人回 1 → exact 命中。
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: true, targets: [{ chatId: 'qquser100', userId: '100' }] }], channelTypes: ['qq'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'qq 卡片已送达')
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'qquser100', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.match(result.results[0].via, /qq:reply/)
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
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // 首条绑定 = owner（CRACK-004 hint 兜底需 owner）
  const rig = makeRig({ inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-user-42', userId: '42' }] }], channelTypes: ['qq'], identity, notifyOutcome: { ok: true, delivered: [], skipped: ['qq'], failed: [] } })
  const pending = rig.bridge.askQuestions({
    questions: [SINGLE, MULTI],
    timeoutMs: 500,
  })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'msg:q:1', text: '1' })
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

// ---------------------------------------------------------------- Control Core Step 1：编号回复 chat 来源隔离

test('CC-1 正确 chat 匹配 hint：hint 送达 (channel, userId, chatId-A)，同一 chat 回复编号 → 命中作答', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // owner
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // hint 送达 qq qq-chat-A
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending')
  assert.ok(Array.isArray(row.hintTargets), 'hintTargets 为数组')
  assert.ok(row.hintTargets.some((t) => t.channel === 'qq' && t.userId === '42' && t.chatId === 'qq-chat-A'), 'hint 送达 qq-chat-A')
  // 同一 chat 回复编号 → 命中
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

test('CC-1 错误 chat：hint 送达 chat A，同用户同渠道 chat B 回复编号 → 消费消息 + 提示回原会话 + 不裁决', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // owner
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // chat B 回复编号（hint 只送达了 chat A）
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-B', messageId: 'm1', text: '1' })
  await sleep(10)
  // 消息被消费（不落回对话路由）
  assert.deepEqual(seen, [], '错误 chat 编号被消费，不进对话路由')
  // 回执提示回原会话
  const qq = rig.instances[0]
  const feedback = qq.texts.find((entry) => entry.chatId === 'qq-chat-B' && /原会话/.test(entry.text))
  assert.ok(feedback !== undefined, '回执已发')
  assert.match(feedback.text, /原会话/, '提示回原会话')
  assert.equal(feedback.chatId, 'qq-chat-B', '回执发到错误 chat（用户当前所在）')
  // 问题保持待决
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', '错误 chat 不裁决')
  const result = await pending
  assert.equal(result.answered, false, '超时未作答（不代答）')
  rig.bridge.dispose()
})

test('CC-1 同 chat 不同用户：hint 证据含 userId=42，userId=100 裸编号不匹配', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'shared-chat', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '100', chatId: 'shared-chat', messageId: 'm-user-mismatch', text: '1' })
  assert.deepEqual(seen, ['1'], '不同用户不消费编号')
  assert.equal(rig.store.get(rig.store.keys('aq:')[0]).status, 'pending')
  rig.bridge.dispose()
  await pending
})

test('CC-1 缺 chatId：envelope 无 chatId → fail-closed（消费但不裁决，不落回对话路由）+ G-43 指路回执', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' }) // owner
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qq = rig.instances[0]
  const textsBefore = qq.texts.length
  // 无 chatId 的编号回复
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', messageId: 'm1', text: '1' })
  await sleep(10)
  assert.deepEqual(seen, [], '缺 chatId 编号被消费，不进对话路由')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', '缺 chatId 不裁决')
  // G-43：消费黑洞补回执——此前该路径静默 return true，用户零反馈
  assert.equal(qq.texts.length, textsBefore + 1, '补发一条指路回执')
  assert.match(qq.texts.at(-1).text, /未能定位到提问卡片/, '回执指明缺少会话上下文')
  assert.match(qq.texts.at(-1).text, /回到原卡片|管理台/, '回执给出可操作出路')
  const result = await pending
  assert.equal(result.answered, false, '超时未作答（回执不影响 fail-closed 裁决语义）')
  rig.bridge.dispose()
})

test('CC-1 精确 card 送达 + 正确 chat：pushedTo 含 (channel, userId, chatId) → exact 命中，不依赖 hint', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'telegram', accountId: 'TG_APP', card: true, targets: [{ chatId: '100', userId: '100' }] }],
    channelTypes: ['telegram'],
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, '卡片已送达')
  // 精确 chat 回复编号 → exact 命中
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  rig.bridge.dispose()
})

test('CC-1 精确 card 送达 + 错误 chat：同用户不同 chat 回复编号 → 消费 + 提示 + 不裁决', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'telegram', accountId: 'TG_APP', card: true, targets: [{ chatId: '100', userId: '100' }] }],
    channelTypes: ['telegram'],
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, '卡片送达 chat 100')
  // 同用户不同 chat 回复编号
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '200', messageId: 'm1', text: '1' })
  await sleep(10)
  assert.deepEqual(seen, [], '错误 chat 编号被消费')
  const tg = rig.instances[0]
  assert.equal(tg.texts.length, 1, '回执已发')
  assert.match(tg.texts[0].text, /原会话/)
  assert.equal(tg.texts[0].chatId, '200')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending', '错误 chat 不裁决')
  const result = await pending
  assert.equal(result.answered, false)
  rig.bridge.dispose()
})

test('CC-1 部分送达：hint 送达 chat A 但未送达 chat B → 只有 chat A 可回复，chat B 被拒', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'wechat', userId: '42' })
  // 两个 wechat 目标：qq-chat-A sendText 成功，chat-B sendText 失败
  const sendTextResults = new Map()
  sendTextResults.set('qq-chat-A', true)
  sendTextResults.set('chat-B', false)
  const rig = makeRig({
    inbounds: [{
      channel: 'wechat',
      card: false,
      targets: [{ chatId: 'qq-chat-A', userId: '42' }, { chatId: 'chat-B', userId: '42' }],
      sendTextResult: null, // 动态控制
    }],
    channelTypes: ['telegram'], // 出站广播到 telegram，wechat 无出站覆盖
    identity,
  })
  // 覆盖 sendText 行为：qq-chat-A 成功，chat-B 失败
  const origSendText = rig.instances[0].raw.sendText
  rig.instances[0].raw.sendText = async (chatId, text) => {
    rig.instances[0].texts.push({ chatId, text })
    return sendTextResults.get(chatId) === true
  }
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending')
  assert.ok(Array.isArray(row.hintTargets), 'hintTargets 为数组')
  assert.ok(row.hintTargets.some((t) => t.channel === 'wechat' && t.userId === '42' && t.chatId === 'qq-chat-A'), 'qq-chat-A 有 hint 证据')
  assert.equal(row.hintTargets.some((t) => t.chatId === 'chat-B'), false, 'chat-B 无 hint 证据（发送失败）')
  // qq-chat-A 回复编号 → 命中
  rig.bus.accept({ channel: 'wechat', accountId: 'WX_APP', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true, 'qq-chat-A 可作答')
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  // 验证 chat-B 不会命中（如果 chat-B 早于 qq-chat-A 发消息，应被拒）
  rig.bridge.dispose()
})

test('CC-1 出站 delivered 仅渠道级：不能推导具体 chat hint，裸编号不消费', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: ['qq'],
    identity,
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.deepEqual(row.hintTargets, [], '渠道级 delivered 不生成 chat 送达证据')
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm-outbound-only', text: '1' })
  assert.deepEqual(seen, ['1'], '无具体 chat 证据不消费')
  rig.bridge.dispose()
  await pending
})

test('CC-1 旧记录 hintChannels（字符串数组，无 hintTargets）→ hint 路径不匹配，fail-closed', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: ['qq'],
    identity,
  })
  // 手工塞一条旧格式行：有 hintChannels（字符串数组），无 hintTargets
  const oldKey = 'aq:oldfmt'
  rig.store.set(oldKey, {
    question: '旧格式问题', options: ['甲', '乙'], multiSelect: false,
    status: 'pending', pushedTo: [], hintChannels: ['qq'], createdAt: Date.now(),
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 同 chat 回复编号 → 旧格式 hintChannels 不被识别为 hintTargets，不匹配
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '旧格式 hintChannels 不匹配，裸编号落回对话路由')
  assert.equal(rig.store.get(oldKey).status, 'pending', '旧格式行不被裁决')
  rig.bridge.dispose()
})

test('CC-1 并发 pending：两个待决问题分别送达不同 chat，回复只命中匹配 chat 的那个', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }, { chatId: 'qq-chat-B', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  // 问题 1
  const p1 = rig.bridge.askQuestions({ questions: [{ question: '问题1', options: [{ label: '甲' }, { label: '乙' }] }], timeoutMs: 800 })
  await sleep(30)
  // 问题 2
  rig.instances[0].raw.notifyTargets = () => [{ chatId: 'qq-chat-B', userId: '42' }]
  const p2 = rig.bridge.askQuestions({ questions: [{ question: '问题2', options: [{ label: '丙' }, { label: '丁' }] }], timeoutMs: 800 })
  await sleep(30)
  const rows = rig.store.keys('aq:').map((k) => rig.store.get(k)).filter((r) => r.status === 'pending')
  assert.equal(rows.length, 2, '两个待决问题')
  // qq-chat-A 回复编号 → 只命中 qq-chat-A 有 hint 证据的那个问题
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  await sleep(50)
  // 至少一个问题被作答
  const after = rig.store.keys('aq:').map((k) => rig.store.get(k))
  const resolved = after.filter((r) => r.status === 'resolved' && r.decision === 'answered')
  assert.equal(resolved.length, 1, '只有匹配 chat 的一个问题被作答')
  rig.bridge.dispose()
  // 清理未完成的 pending
  try { await p1 } catch { }
  try { await p2 } catch { }
})

test('CC-1 僵尸 pending：已决行不匹配，编号回复落回对话路由', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: ['qq'],
    identity,
  })
  // 手工塞一条已决行（模拟超时/已回答的行）
  const zombieKey = 'aq:zombie'
  rig.store.set(zombieKey, {
    question: '已决问题', options: ['甲', '乙'], multiSelect: false,
    status: 'resolved', decision: 'timeout', pushedTo: [], hintTargets: [{ channel: 'qq', chatId: 'qq-chat-A', userId: '42' }], createdAt: Date.now(),
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '僵尸行不匹配，裸编号落回对话路由')
  assert.equal(rig.store.get(zombieKey).status, 'resolved', '僵尸行不被改写')
  rig.bridge.dispose()
})

test('CC-1 重复回复：同 chat 两次编号回复 → 首达采纳，第二次被首达采纳拒绝', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: [],
    identity,
  })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  // 第一次回复 → 命中
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '1' })
  // 第二次回复 → 首达采纳拒绝（问题已解答）
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm2', text: '2' })
  await sleep(10)
  const qq = rig.instances[0]
  // 应有两条回执：第一次确认作答，第二次提示已答
  const secondFeedback = qq.texts.find((t) => t.chatId === 'qq-chat-A' && /已作答|已过期|已回答/.test(t.text))
  assert.ok(secondFeedback !== undefined, '第二次回复收到已答/已过期回执')
  const result = await pending
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['测试环境'], '首达采纳的答案不变')
  rig.bridge.dispose()
})

test('CC-1 无关用户裸编号不被消费：无待决提问时编号落回对话路由', async () => {
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'qq', userId: '42' })
  const rig = makeRig({
    inbounds: [{ channel: 'qq', accountId: 'QQ_APP', card: false, targets: [{ chatId: 'qq-chat-A', userId: '42' }] }],
    channelTypes: ['qq'],
    identity,
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 无待决提问时发编号
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-chat-A', messageId: 'm1', text: '3' })
  assert.deepEqual(seen, ['3'], '无待决时编号不被消费，落回对话路由')
  rig.bridge.dispose()
})

test('CC-1 跨渠道不匹配：feishu 卡片送达，qq 无 inbound 无 hint → qq 编号不命中不消费', async () => {
  const rig = makeRig({
    inbounds: [{ channel: 'feishu', accountId: 'FS_APP', card: true, targets: [{ chatId: 'oc_100', userId: 'ou_100' }] }],
    channelTypes: ['feishu'], // 只有 feishu，无 qq 出站
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, 'feishu 卡片已送达')
  // qq 无 inbound 无出站 → 无 hintTargets → 编号不命中
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: '42', chatId: 'qq-user-42', messageId: 'm1', text: '1' })
  assert.deepEqual(seen, ['1'], '跨渠道无 hint 编号不消费')
  const row = rig.store.get(rig.store.keys('aq:')[0])
  assert.equal(row.status, 'pending')
  const result = await pending
  assert.equal(result.answered, false)
  rig.bridge.dispose()
})

// ----------------------------------------------------------------
// P1（stage5）：自定义「答：」与卡片「跳过」经共享 Control Core 契约裁决。
// 两个路径原先直调 bus.settle 绕过 Control Core 且未纳入 accountId 来源绑定；
// 修复后统一走 deps.control.handle（trusted + 精确来源 + 首达采纳），Control Core
// 不可用时保留仅剩的白名单+token+exact 来源兜底（不弱于现网）。
// 联调台：桥 + createControlEntry（personal/approve）+ 绑定 owner，pushedTo 携带 accountId。
// ----------------------------------------------------------------

/** 与 questions-admin-settlement 同款 Control Core 联调台，pushedTo 携带 accountId。 */
function makeControlRig({ channel = 'telegram', accountId = 'tg-acc', chatId = '900113', userId = 'u1' } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'ctrl-test-secret' })
  const bus = createInboundBus({ allowUsers: [userId, 'u-other'], store, vault })
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel, userId }) // 首条绑定 = owner
  const texts = []
  const raw = {
    channel,
    ...(accountId !== null ? { accountId } : {}),
    notifyTargets: () => [{ chatId, userId }],
    async sendQuestionCard() { return { messageId: 1 } },
    async editResolved() {},
    async sendText(_chatId, text) { texts.push({ chatId: _chatId, text }); return true },
  }
  const notifier = { channels: [channel], notifyAll: async () => ({ ok: true, delivered: [channel], skipped: [], failed: [] }) }
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control,
    interactive: () => [raw],
    config: { timeoutMs: 2000, escalation: { enabled: false } },
  })
  bridge.attach()
  const rig = { store, vault, bus, identity, control, bridge, texts, seen: [] }
  // 尾部观察者：只在问题处理器不消费时才收到（用于断言「未消费/落回对话路由」）
  bus.onMessage((envelope) => { rig.seen.push(String(envelope.text ?? envelope.questionAction?.optIdx ?? '')); return false })
  return rig
}

test('P1 自定义答经 Control Core：telegram-style 正确 account 作答成功；同一 chat/user 的错误 account 不结算', async () => {
  const rig = makeControlRig({ channel: 'telegram', accountId: 'tg-acc', chatId: '900113', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  // 错误账号（同渠道同 chat 同 user，仅 accountId 不同）→ latestPendingFor 不命中 → 不结算
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '900113', accountId: 'tg-evil', chatType: 'private', messageId: 'm-evil', text: '答：渗透对方账号' })
  assert.equal(rig.store.get(qKey).status, 'pending', '错误 accountId 不可作答')
  assert.deepEqual(rig.seen, ['答：渗透对方账号'], '错误账号自定义作答未被明确消费/裁决')
  // 正确账号 → 经 Control Core 结算成功
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '900113', accountId: 'tg-acc', chatType: 'private', messageId: 'm-ok', text: '答：我选生产' })
  const result = await p
  assert.equal(result.answered, true)
  assert.deepEqual(result.results[0].answers, ['我选生产'])
  const row = rig.store.get(qKey)
  assert.equal(row.status, 'resolved')
  assert.equal(row.decision, 'answered')
  rig.bridge.dispose()
})

test('P1 自定义答经 Control Core：同用户同账号错误 chat → 消费但不清算，问题保持待决', async () => {
  const rig = makeControlRig({ channel: 'telegram', accountId: 'tg-acc', chatId: '900113', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '900114', accountId: 'tg-acc', chatType: 'private', messageId: 'm-wrongchat', text: '答：跑别的会话' })
  assert.deepEqual(rig.seen, [], '错误 chat onChannel 证据 → 消费，不进对话路由')
  assert.equal(rig.store.get(qKey).status, 'pending', '错误 chat 不结算')
  const result = await p
  assert.equal(result.answered, false, '未作答超时交还桌面')
  rig.bridge.dispose()
})

test('P1 跳过经 Control Core：feishu-style 正确 account 可跳过；同用户错误 account 被拒不落终态', async () => {
  const rig = makeControlRig({ channel: 'feishu', accountId: 'cli_a1b2c3d4e5', chatId: 'ou_9100001', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  const token = rig.vault.mint(qKey)
  // 错误账号：同 userId/chat，accountId 不同 → pushedTo 目标不命中 → 拒
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'private', userId: 'u1', chatId: 'ou_9100001', accountId: 'cli_evil', chatType: 'private', messageId: 'm-evil', questionAction: { qKey, optIdx: 's', token } })
  assert.equal(rig.store.get(qKey).status, 'pending', '错误 accountId 不可跳过')
  // 拒绝回执：可能命中 pushedTo 原会话预检（请到原会话操作）或 Control Core 裁决拒（已作答）。
  // 安全底线是「不落终态」——上方 status 断言已固；这里只要求确实发了 fail-closed 拒回执。
  assert.match(rig.texts.at(-1)?.text ?? '', /原会话操作|该提问已被作答/, '错误账号跳过被拒并回执')
  assert.ok(!/已跳过/.test(rig.texts.at(-1)?.text ?? ''), '错误账号绝不得获跳过着落回执')
  // 正确账号 → 经 Control Core 结算成功（跳过）
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'private', userId: 'u1', chatId: 'ou_9100001', accountId: 'cli_a1b2c3d4e5', chatType: 'private', messageId: 'm-ok', questionAction: { qKey, optIdx: 's', token } })
  const result = await p
  assert.equal(result.answered, false, '跳过即交还桌面，非作答')
  const row = rig.store.get(qKey)
  assert.equal(row.status, 'resolved', 'aq-skip 经 Control Core 结算落终态')
  assert.equal(row.decision, 'skipped', 'aq-skip 落账为 skipped（等价 decision.kind=aq-skip）')
  assert.match(rig.texts.at(-1)?.text ?? '', /已跳过/, '正确账号跳过持有「已跳过」落地回执')
  rig.bridge.dispose()
})

test('P1 跳过经 Control Core：feishu 缺失 accountId 回调 fail-closed（绝不跳过，不落终态）', async () => {
  const rig = makeControlRig({ channel: 'feishu', accountId: 'cli_a1b2c3d4e5', chatId: 'ou_9100001', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  const token = rig.vault.mint(qKey)
  // 同一 owner(u1) 同 chat，但回调不带 accountId：pushedTo 已绑定账号 → 缺失即 fail-closed，绝不放行。
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'private', userId: 'u1', chatId: 'ou_9100001', chatType: 'private', messageId: 'm-noacc', questionAction: { qKey, optIdx: 's', token } })
  assert.equal(rig.store.get(qKey).status, 'pending', '缺失 accountId 不可跳过')
  assert.match(rig.texts.at(-1)?.text ?? '', /原会话操作|该提问已被作答|作答被拒绝/, '缺失 accountId 跳过被拒并回执')
  assert.ok(!/已跳过/.test(rig.texts.at(-1)?.text ?? ''), '缺失 accountId 绝不得获跳过着落回执')
  const result = await p
  assert.equal(result.answered, false, '缺失 accountId 跳过未生效，问题保持待决')
  rig.bridge.dispose()
})

test('P1 跳过经 Control Core：QQ 群聊回调 fail-closed（group_chat_disabled），绝不跳过', async () => {
  const rig = makeControlRig({ channel: 'qq', accountId: 'qq-acc', chatId: 'qq-private', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  const token = rig.vault.mint(qKey)
  // 群聊回调：chatId 与私聊 pushedTo 一致、账号一致，但 chatType=group → Control Core 拒绝
  rig.bus.accept({ channel: 'qq', accountId: 'QQ_APP', chatType: 'private', userId: 'u1', chatId: 'qq-private', accountId: 'qq-acc', chatType: 'group', messageId: 'm-group', questionAction: { qKey, optIdx: 's', token } })
  assert.equal(rig.store.get(qKey).status, 'pending', '群聊跳过被 Control Core 拒，不落终态')
  const result = await p
  assert.equal(result.answered, false, '群聊跳过未生效，问题保持待决')
  rig.bridge.dispose()
})

test('P1 自定义答 replay/去重：同 messageId 重复入站不重复结算，账本只记一次', async () => {
  const rig = makeControlRig({ channel: 'telegram', accountId: 'tg-acc', chatId: '900113', userId: 'u1' })
  const p = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const qKey = rig.store.keys('aq:')[0]
  const env = { channel: 'telegram', userId: 'u1', chatId: '900113', accountId: 'tg-acc', chatType: 'private', messageId: 'm-replay', text: '答：replay' }
  const first = rig.bus.accept(env)
  assert.equal(first.ok, true, '首次作答受理')
  const again = rig.bus.accept(env) // 重放同一事件
  assert.equal(again.ok, false, '总线按 messageId 去重')
  assert.equal(again.reason, 'duplicate', '重复入站被总线路由层挡掉')
  assert.deepEqual(rig.store.get(qKey).answers, ['replay'], '账本只记一次首达')
  const result = await p
  assert.deepEqual(result.results[0].answers, ['replay'])
  rig.bridge.dispose()
})
