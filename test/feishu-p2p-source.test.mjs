// P0-Feishu-P2P（#20）来源标识错配修复 focused suite。
// 根因：私聊投递目标是用户 open_id（ou_*），而点击/回复事件的会话 id 是 P2P 会话
// chat_id（oc_*）——两套 id 空间，硬比恒失败（见 docs/repair-plan-v0.11.md §3F）。
// 修复把「来源身份（ou_） vs 投递寻址（oc_）」分离：
//   - target-guard.isOpenIdTarget / feishuP2pEquivalent：仅 feishu + 同人 + p2p 才等价
//   - feishu-bot.sourceChatAllowed：srcChat 为 ou_ 时改验 operator.open_id === srcChat
//   - feishu-bot.controlChatIdOf：裁决入账用 srcChat（与账本同口径），补发/patch 仍用 oc_
//   - questions/router.latestPendingFor / authorize：P2P 等价会话视为同一私聊
// 覆盖 §3F 测试清单 1-12。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOpenIdTarget, feishuP2pEquivalent } from '../src/inbound/target-guard.mjs'
import { createFeishuInbound } from '../src/inbound/feishu-bot.mjs'
import { buildApprovalAction, buildQuestionAction } from '../src/inbound/_contract.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createControlEntry } from '../src/control/entry.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => sleep(0)

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-p2p-')), 'state.json')
}

// ---------------------------------------------------------------- fake SDK
function makeFakeSdk({ failPatch = 0 } = {}) {
  const state = {
    loadCount: 0,
    wsStarted: 0,
    dispatcher: null,
    sent: [],    // { receiveIdType, receiveId, msgType, content }
    patched: [], // { messageId, content }
  }
  class FakeClient {
    constructor() {
      this.im = { v1: { message: {
        async create({ params, data }) {
          state.sent.push({ receiveIdType: params.receive_id_type, receiveId: data.receive_id, msgType: data.msg_type, content: data.content })
          return { code: 0, msg: 'ok', data: { message_id: `om_${state.sent.length}` } }
        },
        async patch({ path, data }) {
          if (state.patched.length < failPatch) throw new Error('mock patch down')
          state.patched.push({ messageId: path.message_id, content: data.content })
          return { code: 0, msg: 'ok' }
        },
      } } }
    }
  }
  class FakeWSClient {
    async start({ eventDispatcher }) { state.wsStarted += 1; state.dispatcher = eventDispatcher }
    async close() {}
  }
  class FakeEventDispatcher { register(map) { Object.assign(this.handlers = this.handlers ?? {}, map); return this } }
  // Host P0 #31：ensureStarted 现在要求 SDK 导出 defaultHttpInstance（bounded wrapper 的 base）。
  const defaultHttpInstance = {
    defaults: {},
    async request() { return {} },
    async get() { return {} },
    async delete() { return {} },
    async head() { return {} },
    async options() { return {} },
    async post() { return {} },
    async put() { return {} },
    async patch() { return {} },
  }
  const sdk = { Client: FakeClient, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher, defaultHttpInstance }
  return { state, loader: async () => sdk }
}

function makeLogger() {
  const lines = []
  return { lines, warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
}

// ------------------------------------------------------- 单元：target-guard
test('isOpenIdTarget：仅 feishu 的 ou_ 用户 open_id 判定为私聊投递目标', () => {
  assert.equal(isOpenIdTarget('feishu', 'ou_abc123'), true)
  assert.equal(isOpenIdTarget('feishu', 'oc_abc123'), false, 'chat_id 不是用户 open_id')
  assert.equal(isOpenIdTarget('feishu', ''), false)
  assert.equal(isOpenIdTarget('qq', 'ou_abc123'), false, '不泛化到其他渠道')
  assert.equal(isOpenIdTarget('telegram', 'ou_abc123'), false)
})

test('feishuP2pEquivalent：#1 同人 p2p —— ou_ 投递目标 ↔ oc_ 事件会话等价', () => {
  assert.equal(
    feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { userId: 'ou_A', targetUserId: 'ou_A', chatType: 'p2p' }),
    true,
  )
})

test('feishuP2pEquivalent：#2 不同人 —— 事件操作者与投递目标不一致，绝不等价', () => {
  assert.equal(
    feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { userId: 'ou_B', targetUserId: 'ou_A', chatType: 'p2p' }),
    false,
  )
})

test('feishuP2pEquivalent：#3/#4 群聊 —— oc_ 直接字符串相等判定，跨会话恒不等价', () => {
  assert.equal(feishuP2pEquivalent('feishu', 'oc_G', 'oc_G'), true, '同群同串 → 相等')
  assert.equal(feishuP2pEquivalent('feishu', 'oc_G', 'oc_OTHER'), false)
  assert.equal(
    feishuP2pEquivalent('feishu', 'oc_G', 'oc_OTHER', { userId: 'uG', targetUserId: 'uG', chatType: 'group' }),
    false,
    '群聊不适用 P2P 等价——跨会话转发 fail-closed',
  )
})

test('feishuP2pEquivalent：缺 chatType / 缺同人身份 → 一律不等价（fail-closed）', () => {
  assert.equal(feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { userId: 'ou_A', targetUserId: 'ou_A' }), false, '缺 chatType')
  assert.equal(feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { userId: 'ou_A', targetUserId: 'ou_A', chatType: 'group' }), false, '群聊 chatType')
  assert.equal(feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { userId: 'ou_A', chatType: 'p2p' }), false, '缺 targetUserId')
  assert.equal(feishuP2pEquivalent('feishu', 'ou_A', 'oc_p2p', { targetUserId: 'ou_A', chatType: 'p2p' }), false, '缺 userId')
  assert.equal(feishuP2pEquivalent('qq', 'ou_A', 'oc_p2p', { userId: 'ou_A', targetUserId: 'ou_A', chatType: 'p2p' }), false, '非 feishu 不泛化')
  assert.equal(feishuP2pEquivalent('feishu', 'oc_G', 'oc_p2p', { userId: 'uG', targetUserId: 'ou_A', chatType: 'p2p' }), false, '投递目标不是 ou_')
})

// ---------------------------------------------------- 集成：卡片回调裁决
/** 组装 feishu inbound 测试台（card.action.trigger 直接投喂 dispatcher）。 */
function makeCardRig({ allowUsers = ['ou_A', 'ou_B'], sdkOptions = {}, deps = {} } = {}) {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers, vault, logger })
  const fake = makeFakeSdk(sdkOptions)
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's', allowUsers },
    bus,
    logger,
    sdkLoader: fake.loader,
    ...deps,
  })
  inbound.start()
  return { bus, fake, inbound, vault, logger }
}

test('#1/#5 审批卡片：ou_A 私聊投递，P2P 回调（oc_ + 操作者 ou_A）→ 裁决成功', async () => {
  const rig = makeCardRig()
  await tick()
  const key = 'ap:p2p:1'
  const token = rig.vault.mint(key)
  const outcome = rig.bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['ou_A'])]]) })
  const toast = rig.fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_A' },
    open_message_id: 'om_card1',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token), srcChat: 'ou_A' } },
  })
  assert.equal(toast.toast.type, 'success')
  assert.equal((await outcome).decision, 'allowed-once')
  assert.equal((await outcome).via, 'feishu:button')
  await rig.inbound.stop()
})

test('#2 审批卡片：同一私聊卡片被他人点击（操作者 ou_B）→ 来源校验拒绝，不裁决', async () => {
  const rig = makeCardRig()
  await tick()
  const key = 'ap:p2p:2'
  const token = rig.vault.mint(key)
  const outcome = rig.bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['ou_A'])]]) })
  const toast = rig.fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_B' },
    open_message_id: 'om_card2',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token), srcChat: 'ou_A' } },
  })
  assert.equal(toast.toast.type, 'info')
  assert.match(toast.toast.content, /来源|会话/)
  assert.equal(await outcome, null, 'wait 不结算（不核销，原接收人仍可裁决）')
  assert.equal(rig.fake.state.patched.length, 0, '不 patch 终态')
  await rig.inbound.stop()
})

test('#6 提问卡片：P2P 回调裁决入账用投递目标 identity（srcChat=ou_），会话类型透传', async () => {
  const seen = []
  const control = { handle: (input) => { seen.push(input); return { ok: true, status: 'accepted', message: 'ok' } } }
  // aq 分支先验 questions 非空才进 control（既有代码序），补一个哑 questions 防止提前 bail
  const rig = makeCardRig({ deps: { control, questions: { decide: () => ({ ok: false }) } } })
  await tick()
  const qKey = 'aq:p2p:6'
  const qToken = rig.vault.mint(qKey)
  rig.fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_A' },
    open_message_id: 'om_card6',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act: buildQuestionAction(qKey, '0', qToken), srcChat: 'ou_A' } },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].command, 'question-answer')
  assert.equal(seen[0].chatId, 'ou_A', '裁决入账用 srcChat（与账本/pushedTo 同口径）')
  assert.equal(seen[0].chatType, 'p2p')
  assert.equal(seen[0].userId, 'ou_A')
  await rig.inbound.stop()
})

test('#7 动作卡片：P2P 回调 dispatch 入账用 srcChat（ou_），控制面一致', async () => {
  const seen = []
  const actions = { dispatch: (input) => { seen.push(input); return { ok: true, message: 'done' } } }
  const rig = makeCardRig({ deps: { actions } })
  await tick()
  const act = `ac:turn/cancel:tk.signature`
  rig.fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_A' },
    open_message_id: 'om_card7',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act, srcChat: 'ou_A' } },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].via, 'feishu:action')
  assert.equal(seen[0].chatId, 'ou_A', 'dispatch 入账用 srcChat（与账本同口径）')
  assert.equal(seen[0].userId, 'ou_A')
  await rig.inbound.stop()
})

test('#11 P2P 卡片缺操作者 open_id → fail-closed 拒绝，不裁决不 patch', async () => {
  const rig = makeCardRig()
  await tick()
  const key = 'ap:p2p:11'
  const token = rig.vault.mint(key)
  const outcome = rig.bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['ou_A'])]]) })
  const toast = rig.fake.state.dispatcher.handlers['card.action.trigger']({
    open_message_id: 'om_card11',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token), srcChat: 'ou_A' } },
  })
  assert.equal(toast.toast.type, 'info')
  assert.equal(await outcome, null, '缺操作者身份不裁决')
  assert.equal(rig.fake.state.patched.length, 0)
  await rig.inbound.stop()
})

test('#12 patch 失败补发文本仍走点击会话 oc_（真实寻址），不用 ou_', async () => {
  const rig = makeCardRig({ sdkOptions: { failPatch: 1 } })
  await tick()
  const key = 'ap:p2p:12'
  const token = rig.vault.mint(key)
  const outcome = rig.bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['ou_A'])]]) })
  rig.fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_A' },
    open_message_id: 'om_card12',
    context: { open_chat_id: 'oc_p2p', open_chat_type: 'p2p' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token), srcChat: 'ou_A' } },
  })
  assert.equal((await outcome).decision, 'allowed-once')
  await tick()
  assert.equal(rig.fake.state.patched.length, 0, 'patch 失败（mock）')
  const fallback = rig.fake.state.sent.find((entry) => entry.msgType === 'text')
  assert.ok(fallback, 'patch 失败补发恰好一条文本兜底')
  assert.equal(fallback.receiveId, 'oc_p2p', '补发目标是点击会话 oc_（真实会话寻址）')
  assert.equal(fallback.receiveIdType, 'chat_id')
  await rig.inbound.stop()
})

// ---------------------------------------------------- 集成：编号回复路由
/** 组装提问桥测试台（对齐 questions.test.mjs makeRig，feishu 通道为主）。 */
function makeQuestionRig({ targets, allowUsers = ['ou_100', 'ouG'], channelTypes = ['feishu'] } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  const bus = createInboundBus({ allowUsers, store, vault })
  const broadcasts = []
  const notifier = {
    channels: channelTypes,
    notifyAll: async (msg, opts) => { broadcasts.push({ msg, opts }); return { ok: true, delivered: [...(opts?.channelTypes ?? [])], skipped: [], failed: [] } },
  }
  const instances = []
  const cards = []
  const texts = []
  const edits = []
  instances.push({
    cards,
    texts,
    edits,
    raw: {
      channel: 'feishu',
      accountId: 'FS_APP',
      notifyTargets: () => targets ?? [{ chatId: 'ou_100', userId: 'ou_100' }],
      async sendQuestionCard(payload) { cards.push(payload); return { messageId: cards.length } },
      async editResolved(target, text) { edits.push({ target, text }) },
      async sendText(chatId, text) { texts.push({ chatId, text }); return true },
    },
  })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier,
    control: createControlEntry(),
    interactive: () => instances.map((item) => item.raw),
    config: { timeoutMs: 800, escalation: { enabled: false } },
  })
  bridge.attach()
  return { store, vault, bus, broadcasts, instances, bridge }
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '预发环境' }, { label: '生产环境' }] }

test('#8 编号回复：ou_100 用户从 P2P 会话（oc_）作答 → exact 等价命中并裁决', async () => {
  const rig = makeQuestionRig({ targets: [{ chatId: 'ou_100', userId: 'ou_100' }] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  assert.equal(rig.instances[0].cards.length, 1, '卡片已送达 ou_100')
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false }, { priority: 99 })
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'p2p', userId: 'ou_100', chatId: 'oc_p2p', messageId: 'm1', text: '1' })
  const result = await pending
  assert.equal(result.answered, true, 'P2P 私聊编号作答命中（同人等价）')
  assert.deepEqual(result.results[0].answers, ['测试环境'])
  assert.deepEqual(seen, [], '裸编号被消费，不落回对话路由')
  rig.bridge.dispose()
})

test('#9 群聊跨会话编号作答：oc_G 投递、oc_OTHER 回复 → 仍拒（onChannel，不裁决）', async () => {
  const rig = makeQuestionRig({ targets: [{ chatId: 'oc_G', userId: 'ouG' }], allowUsers: ['ouG'] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false }, { priority: 99 })
  rig.bus.accept({ channel: 'feishu', accountId: 'FS_APP', chatType: 'group', userId: 'ouG', chatId: 'oc_OTHER', messageId: 'm2', text: '1' })
  assert.deepEqual(seen, [], '错误 chat 的裸编号被消费（不回对话路由）')
  assert.ok(rig.instances[0].texts.some((entry) => /原会话/.test(entry.text)), '回执指回原会话')
  const result = await pending
  assert.equal(result.answered, false, '群聊跨会话作答不落终态')
  rig.bridge.dispose()
})

test('#10 accountId 不匹配：同渠道同人同 chat，仅账号不同 → 归属拒绝不裁决', async () => {
  const rig = makeQuestionRig({ targets: [{ chatId: 'ou_100', userId: 'ou_100' }] })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(30)
  rig.bus.accept({ channel: 'feishu', accountId: 'OTHER_APP', chatType: 'p2p', userId: 'ou_100', chatId: 'oc_p2p', messageId: 'm3', text: '1' })
  const result = await pending
  assert.equal(result.answered, false, '错误账号作答不命中（fail-closed）')
  const qKey = rig.store.keys('aq:')[0]
  const row = rig.store.get(qKey)
  assert.equal(row.decision, 'timeout', '错误账号作答不落 answered 终态（超时收口）')
  assert.equal(Array.isArray(row.answers) ? row.answers.length : 0, 0, '无答案落账')
  rig.bridge.dispose()
})
