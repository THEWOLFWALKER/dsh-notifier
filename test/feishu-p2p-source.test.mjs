// P2P-FIX 测试：飞书**私聊**目标的来源校验（feishu-bot.mjs + questions/router.mjs）。
//
// 真机事故（v0.9.5）：私聊里点击提问/审批卡片按钮一律 toast「请到原会话操作」。
// 根因是「来源标识在两个方向上不是同一个东西」：
//   - 出站：私聊用 open_id 寻址（receive_id_type=open_id），账本 pushedTo[].chatId
//     与卡片 value.srcChat 记的都是这个 `ou_…`；
//   - 入站：平台只回声**会话 ID**——卡片回调 context.open_chat_id（`oc_…`）、
//     消息事件 message.chat_id（`oc_…`）。
// `ou_` 与 `oc_` 永不相等，所以 `clicked !== srcChat` 恒真 → 三个回调分支（ac:/aq:/ap:）
// 全部 fail-closed；编号回复也因 chatId 不匹配只拿到 onChannel 证据（消费但不裁决）。
// 多选提问没有卡片形态、只能靠编号回复，等于完全无法作答。
//
// 本套件钉死修复后的语义：
//   1. 私聊目标：按**当事人**（operator.open_id）判定，而非会话比对；
//   2. 转发/他人点击仍然拒绝（F-08 原意不降级）；
//   3. 群聊目标行为逐字节不变（仍按会话比对）；
//   4. 私聊编号回复命中 exact 并可结算；群聊「错误 chat」语义不被放松。
//
// SDK 全 mock（sdkLoader 注入 fake），不发真实网络请求。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeishuInbound } from '../src/inbound/feishu-bot.mjs'
import { buildApprovalAction, buildQuestionAction } from '../src/inbound/_contract.mjs'
import { createQuestionBridge } from '../src/questions/router.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { isOpenIdTarget } from '../src/inbound/target-guard.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- fake SDK

/** 最小 fake SDK：只捕获 dispatcher，供测试直接投喂 card.action.trigger。 */
function makeFakeSdk() {
  const state = { dispatcher: null, sent: [] }
  class FakeClient {
    constructor() {
      this.im = {
        v1: {
          message: {
            async create({ params, data }) {
              state.sent.push({ receiveIdType: params.receive_id_type, receiveId: data.receive_id, msgType: data.msg_type })
              return { code: 0, msg: 'ok', data: { message_id: `om_${state.sent.length}` } }
            },
            async patch() { return { code: 0, msg: 'ok' } },
          },
        },
      }
    }
  }
  class FakeWSClient {
    async start({ eventDispatcher }) { state.dispatcher = eventDispatcher }
    async close() {}
  }
  class FakeEventDispatcher {
    constructor() { this.handlers = {} }
    register(map) { Object.assign(this.handlers, map); return this }
  }
  const sdk = { Client: FakeClient, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher }
  return { state, loader: async () => sdk }
}

function makeLogger() {
  const lines = []
  return { lines, warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
}

// ------------------------------------------------- 1) 回调分支：私聊 / 群聊

test('P2P-FIX aq:/ap: 私聊目标（srcChat=ou_）按当事人判定：本人通过、他人点击拒绝、群聊回归不变', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const verdicts = []
  const questions = { decide: (p) => { verdicts.push(p); return { ok: true, message: '✅ 已作答' } } }
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' },
    bus,
    logger,
    sdkLoader: fake.loader,
    questions,
  })
  inbound.start()
  await tick()
  const handler = fake.state.dispatcher.handlers['card.action.trigger']
  // 私聊卡：srcChat 是 open_id；平台回声的会话 ID 是 oc_（与 srcChat 必然不同）
  const makeEvent = (value, chatId, operatorId = 'ou_1') => ({
    operator: { open_id: operatorId },
    action: { value },
    context: { open_message_id: 'om_p2p', open_chat_id: chatId },
  })

  // ① 本人在私聊里点击 → 必须通过（修复前这里 100% 被「请到原会话操作」挡下）
  const p2p = { act: buildQuestionAction('aq:p2p01', '0', 'tk'), srcChat: 'ou_1' }
  const accepted = handler(makeEvent(p2p, 'oc_dm_chat', 'ou_1'))
  assert.equal(accepted.toast.type, 'success', `私聊点击应通过（实际 toast：${accepted.toast.content}）`)
  assert.equal(verdicts.length, 1, '应进入 questions.decide')
  assert.equal(
    verdicts[verdicts.length - 1].chatId, 'ou_1',
    '裁决入参应是 srcChat（与 pushedTo[].chatId 同口径）——传 oc_ 会话 ID 会让 router 侧二次比对落空',
  )

  // ② 同一张卡被转发后由**别人**点击 → operator 不匹配 → 仍然拒绝（F-08 原意不降级）
  const forwarded = handler(makeEvent(p2p, 'oc_dm_chat', 'ou_other'))
  assert.match(forwarded.toast.content, /请到原会话操作/, '非被投递人点击必须拒绝')
  assert.equal(verdicts.length, 1, '他人点击不得进入裁决')

  // ③ 群聊目标（srcChat=oc_）行为逐字节不变：仍按会话比对
  const group = { act: buildQuestionAction('aq:grp01', '1', 'tk2'), srcChat: 'oc_group' }
  const groupElsewhere = handler(makeEvent(group, 'oc_elsewhere', 'ou_1'))
  assert.match(groupElsewhere.toast.content, /请到原会话操作/, '群聊转发仍拒绝')
  assert.equal(verdicts.length, 1)
  const groupSame = handler(makeEvent(group, 'oc_group', 'ou_1'))
  assert.equal(groupSame.toast.type, 'success', '群聊原会话仍通过')
  assert.equal(verdicts[verdicts.length - 1].chatId, 'oc_group', '群聊仍透传真实会话 ID')
  await inbound.stop()
})

test('P2P-FIX ap: 审批卡私聊目标：点击会话（oc_）与 srcChat（ou_）不同也应放行并核销 wait', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()

  const key = 'ap:p2p:1'
  const token = vault.mint(key)
  // 投递侧登记的允许会话范围 = 私聊目标（open_id），与 pushApproval 的记账口径一致
  const outcome = bus.wait(key, 3000, { allowChats: new Map([['feishu', new Set(['ou_1'])]]) })
  const value = { act: buildApprovalAction('allowed-once', key, token), srcChat: 'ou_1' }
  const result = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: 'om_ap', open_chat_id: 'oc_dm_chat' },
  })
  assert.equal(result.toast.type, 'success', `私聊审批点击应通过（实际：${result.toast.content}）`)
  assert.equal((await outcome).decision, 'allowed-once', 'wait 应被核销为已批准')
  await inbound.stop()
})

// ------------------------------------------------- 2) 编号回复：私聊 / 群聊

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-p2p-')), 'state.json')
}

/**
 * 提问桥联调台：显式区分「投递目标」（pushChatId）与「回复来源会话」（replyChatId）——
 * 私聊场景下前者是 open_id、后者是平台会话 ID（oc_），这正是本套件要覆盖的错位。
 */
function makeBridgeRig({ pushChatId = 'ou_1', replyChatId = 'oc_dm_chat', userId = 'ou_1' } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'p2p-test-secret' })
  const bus = createInboundBus({ allowUsers: [userId], store, vault })
  const identity = createIdentity({ store, logger: null })
  identity.addBinding({ channel: 'feishu', userId })
  const texts = []
  const warns = []
  const raw = {
    channel: 'feishu',
    accountId: 'cli_p2p',
    notifyTargets: () => [{ chatId: pushChatId, userId }],
    async sendQuestionCard() { return { messageId: 'om_card' } },
    async editResolved() {},
    async sendText(chatId, text) { texts.push({ chatId, text }); return true },
  }
  const notifier = { channels: ['feishu'], notifyAll: async () => ({ ok: true, delivered: ['feishu'], skipped: [], failed: [] }) }
  const control = createControlEntry({ policy: { mode: 'personal', capabilities: { approve: true } }, identity, logger: null })
  const bridge = createQuestionBridge({
    bus, vault, store, notifier, identity, control,
    interactive: () => [raw],
    logger: { warn: (...args) => warns.push(args.join(' ')) },
    config: { timeoutMs: 2000, escalation: { enabled: false } },
  })
  bridge.attach()
  return {
    store, bus, bridge, texts, warns,
    /** 以当事人的身份从 replyChatId 发一条回复。 */
    reply: (text) => bus.accept({
      channel: 'feishu', accountId: 'cli_p2p', userId, chatId: replyChatId,
      chatType: 'private', messageId: `m-${Math.random()}`, text,
    }),
  }
}

const SINGLE = { question: '选一个部署环境', options: [{ label: '测试环境' }, { label: '预发环境' }] }

test('P2P-FIX 私聊编号回复：pushedTo.chatId（ou_）与消息 chat_id（oc_）错位仍命中 exact 并结算', async () => {
  const rig = makeBridgeRig({ pushChatId: 'ou_1', replyChatId: 'oc_dm_chat' })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(20)
  const qKey = rig.store.keys('aq:')[0]
  assert.equal(rig.store.get(qKey).pushedTo[0].chatId, 'ou_1', '私聊目标的账本 chatId 是 open_id')

  rig.reply('2')
  const result = await pending
  assert.equal(result.answered, true, '私聊编号回复必须能作答（修复前降级 onChannel → 只消费不裁决）')
  assert.deepEqual(rig.store.get(qKey).answers, ['预发环境'])
  rig.bridge.dispose()
})

test('P2P-FIX 群聊编号回复：错误 chat 仍是「只消费不裁决」（私聊放宽不得外溢到群聊）', async () => {
  const rig = makeBridgeRig({ pushChatId: 'oc_group', replyChatId: 'oc_elsewhere' })
  const pending = rig.bridge.askQuestions({ questions: [SINGLE] })
  await sleep(20)
  const qKey = rig.store.keys('aq:')[0]

  rig.reply('1')
  await sleep(50)
  assert.equal(rig.store.get(qKey).status, 'pending', '群聊错误 chat 不得裁决')
  assert.ok(rig.texts.some((entry) => /请到原会话操作/.test(entry.text)), '应回执「请到原会话操作」')
  rig.bridge.dispose()
  await pending.catch(() => {})
})

// ------------------------------------------------- 3) 判据本身

test('P2P-FIX isOpenIdTarget：只认 ou_ 前缀（oc_/on_/空值一律 false）', () => {
  assert.equal(isOpenIdTarget('ou_124ccaecb5c53287ff80c14284262a10'), true)
  assert.equal(isOpenIdTarget('oc_d050461702f90155046eb7808389dfd4'), false)
  assert.equal(isOpenIdTarget('on_cad4860e7af114fb4ff6c5d496d'), false)
  assert.equal(isOpenIdTarget(''), false)
  assert.equal(isOpenIdTarget(undefined), false)
})
