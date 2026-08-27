// 阶段 1 测试：inbound/feishu-bot（WS 长连接、事件入站、卡片裁决、回执、SDK 懒加载降级）。
// SDK 全 mock（sdkLoader 注入 fake），不发真实网络请求、不装真实依赖。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuInbound, resolveFeishuInboundConfig } from '../src/inbound/feishu-bot.mjs'
import { buildApprovalAction, buildQuestionAction } from '../src/inbound/_contract.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createActionDispatcher } from '../src/actions.mjs'

// ---------------------------------------------------------------- fake SDK

/**
 * 伪造 @larksuiteoapi/node-sdk：记录 Client/WSClient 全部交互。
 * wsClient.start() 捕获 eventDispatcher，测试用 handlers['im.message.receive_v1'] 直接投喂事件。
 */
function makeFakeSdk({ failStart = false, failCreate = 0, bareWs = false, failPatch = 0 } = {}) {
  const state = {
    loadCount: 0,
    clientOptions: [],
    wsOptions: [],
    wsStarted: 0,
    closed: false,
    terminated: false,
    dispatcher: null,
    sent: [],    // { receiveIdType, receiveId, msgType, content }
    patched: [], // { messageId, content }
  }

  class FakeClient {
    constructor(options) {
      this.options = options
      state.clientOptions.push(options)
      this.im = {
        v1: {
          message: {
            async create({ params, data }) {
              if (state.sent.length < failCreate) throw new Error('mock network down')
              state.sent.push({ receiveIdType: params.receive_id_type, receiveId: data.receive_id, msgType: data.msg_type, content: data.content })
              return { code: 0, msg: 'ok', data: { message_id: `om_${state.sent.length}` } }
            },
            async patch({ path, data }) {
              if (state.patched.length < failPatch) throw new Error('mock patch down')
              state.patched.push({ messageId: path.message_id, content: data.content })
              return { code: 0, msg: 'ok' }
            },
          },
        },
      }
    }
  }

  class FakeWSClient {
    constructor(options) {
      this.options = options
      state.wsOptions.push(options)
    }
    async start({ eventDispatcher }) {
      if (failStart) throw new Error('ws handshake failed')
      state.wsStarted += 1
      state.dispatcher = eventDispatcher
    }
    async close() {
      state.closed = true
    }
  }

  /**
   * 模拟 @larksuiteoapi/node-sdk 真身（1.46/1.61/1.73）：无 close()/stop() 公开方法，
   * 底层 ws 实例藏在 wsConfig.getWSInstance() 后面（issue #4 Bug3 复现形态）。
   */
  class BareWSClient {
    constructor(options) {
      this.options = options
      state.wsOptions.push(options)
      this.wsConfig = { getWSInstance: () => ({ terminate: () => { state.terminated = true } }) }
    }
    async start({ eventDispatcher }) {
      if (failStart) throw new Error('ws handshake failed')
      state.wsStarted += 1
      state.dispatcher = eventDispatcher
    }
  }

  class FakeEventDispatcher {
    constructor() {
      this.handlers = {}
    }
    register(map) {
      Object.assign(this.handlers, map)
      return this
    }
  }

  const sdk = { Client: FakeClient, WSClient: bareWs ? BareWSClient : FakeWSClient, EventDispatcher: FakeEventDispatcher }
  const loader = async () => {
    state.loadCount += 1
    return sdk
  }
  return { state, loader }
}

function makeLogger() {
  const lines = []
  return { lines, warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
}

function makeRig({ allowUsers = ['ou_1'], config = {}, sdkOptions = {}, fallbackTargets = [] } = {}) {
  const logger = makeLogger()
  const bus = createInboundBus({ allowUsers, logger })
  const fake = makeFakeSdk(sdkOptions)
  const inbound = createFeishuInbound({
    config: { appId: 'cli_a', appSecret: 's', allowUsers: config.allowUsers, domain: config.domain, accountId: config.accountId },
    bus,
    fallbackTargets,
    logger,
    sdkLoader: fake.loader,
  })
  return { bus, fake, inbound, logger }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 配置解析

test('resolveFeishuInboundConfig：缺 appId/appSecret 时 ok=false 且中文指引', () => {
  const missing = resolveFeishuInboundConfig({})
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /appId 与 appSecret/)
  assert.equal(resolveFeishuInboundConfig({ appId: 'cli_a' }).ok, false)
  assert.equal(resolveFeishuInboundConfig({ appId: 'cli_a', appSecret: 's' }).ok, true)
})

test('resolveFeishuInboundConfig：默认 domain + allowUsers 归一化 + envRefs 展开', () => {
  const resolved = resolveFeishuInboundConfig(
    { appId: '$FS_ID', appSecret: '$FS_SECRET', allowUsers: [' ou_1 ', '', 'ou_2'] },
    { envRefs: (v) => (typeof v === 'string' && v.startsWith('$') ? v.slice(1) : v) },
  )
  assert.equal(resolved.ok, true)
  assert.equal(resolved.config.appId, 'FS_ID')
  assert.equal(resolved.config.appSecret, 'FS_SECRET')
  assert.equal(resolved.config.domain, 'https://open.feishu.cn')
  assert.deepEqual(resolved.config.allowUsers, ['ou_1', 'ou_2'])
})

// ---------------------------------------------------------------- 启动/降级

test('start：建 WS 连接（appId/appSecret/domain 透传）且幂等（重复 start 只连一次）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  rig.inbound.start()
  await tick()
  assert.equal(rig.fake.state.wsStarted, 1)
  assert.equal(rig.fake.state.loadCount, 1)
  assert.equal(rig.fake.state.clientOptions[0].appId, 'cli_a')
  assert.equal(rig.fake.state.wsOptions[0].domain, 'https://open.feishu.cn')
  assert.ok(rig.fake.state.dispatcher !== null, '应捕获 eventDispatcher')
  await rig.inbound.stop()
})

test('SDK 缺失：start 不抛异常，warn 含安装指引，卡片能力降级为 null/false', async () => {
  const logger = makeLogger()
  const bus = createInboundBus({ allowUsers: ['ou_1'], logger })
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' },
    bus,
    fallbackTargets: ['ou_1'],
    logger,
    sdkLoader: async () => { throw new Error('Cannot find package @larksuiteoapi/node-sdk') },
  })
  assert.doesNotThrow(() => inbound.start())
  await tick()
  assert.ok(logger.lines.some((line) => line.includes('npm i @larksuiteoapi/node-sdk')), '应给出安装指引')
  assert.equal(await inbound.sendApprovalCard({ chatId: 'ou_1', title: 't', content: 'c', approvalKey: 'ap:x:1', token: 'tk' }), null)
  assert.equal(await inbound.sendText('ou_1', 'hi'), false)
  assert.deepEqual(inbound.notifyTargets(), [{ chatId: 'ou_1', userId: 'ou_1' }], '目标解析不依赖 SDK')
  await inbound.stop()
})

test('start 失败可重试：失败后 running 复位，再次 start 重新加载', async () => {
  const rig = makeRig({ sdkOptions: { failStart: true } })
  rig.inbound.start()
  await tick()
  assert.ok(rig.logger.lines.some((line) => line.includes('启动失败')))
  rig.inbound.start()
  await tick()
  assert.equal(rig.fake.state.loadCount, 2, '失败后允许重试')
  await rig.inbound.stop()
})

test('stop：关闭 WS 连接并复位（之后卡片发送降级为 null）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  await rig.inbound.stop()
  assert.equal(rig.fake.state.closed, true)
  assert.equal(await rig.inbound.sendApprovalCard({ chatId: 'ou_1', title: 't', content: 'c', approvalKey: 'ap:x:1', token: 'tk' }), null)
  await rig.inbound.stop() // 幂等
})

// ---------------------------------------------------------------- 入站消息

test('im.message.receive_v1：文本入站 → bus.accept 规范化 envelope（@提及剥离）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  rig.fake.state.dispatcher.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 跑一下测试' }),
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'feishu')
  assert.equal(accepted[0].userId, 'ou_1')
  assert.equal(accepted[0].chatId, 'oc_group')
  assert.equal(accepted[0].messageId, 'om_1')
  assert.equal(accepted[0].text, '跑一下测试')
  await rig.inbound.stop()
})

test('白名单外用户：消息不到达订阅者（白名单在 bus 层拦截）', async () => {
  const rig = makeRig({ allowUsers: ['ou_2'] })
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  rig.inbound.start()
  await tick()
  rig.fake.state.dispatcher.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_9', chat_id: 'oc_g', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  })
  assert.equal(seen, 0, '白名单外消息不应到达订阅者')
  await rig.inbound.stop()
})

test('非文本消息：转成占位文本继续投递（agent 可感知用户发了图/文件）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  rig.fake.state.dispatcher.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_2', chat_id: 'oc_g', message_type: 'image', content: '' },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '[不支持的消息类型：image]')
  await rig.inbound.stop()
})

test('事件处理异常不致命：handler 抛错只 warn，长连接继续', async () => {
  const rig = makeRig()
  const bus = rig.bus
  // 制造异常：onMessage 订阅者抛错由 bus 吸收；本层 handleMessage 的异常源用非法 envelope 触发
  bus.onMessage(() => { throw new Error('subscriber boom') })
  rig.inbound.start()
  await tick()
  assert.doesNotThrow(() => {
    rig.fake.state.dispatcher.handlers['im.message.receive_v1']({
      sender: null, // null sender → handleMessage 内部走 openId 空串提前返回，不抛
      message: { message_id: 'om_3', chat_id: 'oc_g', message_type: 'text', content: JSON.stringify({ text: 'x' }) },
    })
  })
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 卡片裁决

test('card.action.trigger：批准按钮 → bus.decide(token 核销) + toast + 卡片改终态', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()

  const key = 'ap:rm:1'
  const token = vault.mint(key)
  // CRACK-002：fail-closed 后 wait 必须登记 allowChats（对齐生产装配 approval/questions router）
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_1'])]]) })
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_card1',
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
    context: { open_chat_id: 'oc_1' },
  })
  assert.equal(toast.toast.type, 'success')
  assert.equal((await outcome).decision, 'allowed-once')
  assert.equal((await outcome).via, 'feishu:button')
  await tick()
  assert.equal(fake.state.patched.length, 1, '卡片应改为终态')
  assert.equal(fake.state.patched[0].messageId, 'om_card1')
  assert.match(fake.state.patched[0].content, /已批准/)
  await inbound.stop()
})

test('card.action.trigger：重复点击同一审批 → already-resolved toast，不再生效', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()

  const key = 'ap:x:1'
  const token = vault.mint(key)
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_2'])]]) })
  const fire = () => fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    context: { open_chat_id: 'oc_2' },
    action: { value: { act: buildApprovalAction('rejected', key, token) } },
  })
  const first = fire()
  const second = fire()
  assert.equal(first.toast.type, 'success')
  assert.match(second.toast.content, /已处理或已过期/)
  assert.equal((await outcome).decision, 'rejected', '首达采纳')
  await inbound.stop()
})

test('v0.8.7 卡片回调：approval/question 载荷把稳定 eventId 传进 Control Core（缺 eventId 会被 missing_eventId 拒绝）', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const received = []
  const control = { handle: (input) => { received.push(input); return { status: 'accepted' } } }
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader,
    control, questions: { decide: () => ({ ok: false }) },
  })
  inbound.start()
  await tick()

  const key = 'ap:rm:1'
  const token = vault.mint(key)
  const approveAct = buildApprovalAction('allowed-once', key, token)
  fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_card1',
    context: { open_chat_id: 'oc_1' },
    action: { value: { act: approveAct, srcChat: 'oc_1' } },
  })
  const qKey = 'aq:q1'
  const qToken = vault.mint(qKey)
  const aqAct = buildQuestionAction(qKey, '0', qToken)
  fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_card2',
    context: { open_chat_id: 'oc_1' },
    action: { value: { act: aqAct, srcChat: 'oc_1' } },
  })
  assert.equal(received.length, 2)
  assert.equal(received[0].command, 'approval')
  assert.equal(received[0].eventId, `feishu:om_card1:ou_1:${approveAct}`)
  assert.equal(received[1].command, 'question-answer')
  assert.equal(received[1].eventId, `feishu:om_card2:ou_1:${aqAct}`)
  await inbound.stop()
})

test('card.action.trigger：未知 payload / 坏 token → 不裁决，toast 提示', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()

  const unknown = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value: { act: 'not-an-approval' } },
  })
  assert.match(unknown.toast.content, /未知操作/)

  const key = 'ap:y:1'
  const outcome = bus.wait(key, 100)
  fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildApprovalAction('allowed-once', key, 'forged.token') } },
  })
  assert.equal(await outcome, null, '伪造 token 不得生效（静默永不批准）')
  await inbound.stop()
})

// ---------------------------------------------------------------- 出站能力

test('sendApprovalCard：interactive 卡片 + 两按钮 value.act 同构 telegram callback_data', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const token = 'tk.signature'
  const card = await rig.inbound.sendApprovalCard({ chatId: 'ou_1', title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token })
  assert.deepEqual(card, { messageId: 'om_1' })
  const sent = rig.fake.state.sent[0]
  assert.equal(sent.msgType, 'interactive')
  assert.equal(sent.receiveId, 'ou_1')
  assert.equal(sent.receiveIdType, 'open_id')
  const content = JSON.parse(sent.content)
  const buttons = content.elements.find((element) => element.tag === 'action').actions
  assert.equal(buttons[0].value.act, `ap:allowed-once:ap:rm:1:${token}`)
  assert.equal(buttons[1].value.act, `ap:rejected:ap:rm:1:${token}`)
  assert.equal(buttons[0].value.srcChat, 'ou_1', '按钮 value 携带来源会话（SEC-1）')
  assert.equal(buttons[1].value.srcChat, 'ou_1')
  assert.match(content.header.title.content, /需要批准：rm/)
  await rig.inbound.stop()
})

test('sendApprovalCard：发送异常返回 null（caller 降级纯通知）', async () => {
  const rig = makeRig({ sdkOptions: { failCreate: 1 } })
  rig.inbound.start()
  await tick()
  const card = await rig.inbound.sendApprovalCard({ chatId: 'ou_1', title: 't', content: 'c', approvalKey: 'ap:x:1', token: 'tk' })
  assert.equal(card, null)
  assert.ok(rig.logger.lines.some((line) => line.includes('审批卡片发送失败')))
  await rig.inbound.stop()
})

test('sendText：oc_ 前缀走 chat_id 接收类型（群聊回执）；ou_ 走 open_id', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendText('oc_group', '命令回执'), true)
  assert.equal(await rig.inbound.sendText('ou_1', '私聊回执'), true)
  assert.equal(rig.fake.state.sent[0].receiveIdType, 'chat_id')
  assert.equal(rig.fake.state.sent[1].receiveIdType, 'open_id')
  assert.deepEqual(JSON.parse(rig.fake.state.sent[0].content), { text: '命令回执' })
  await rig.inbound.stop()
})

test('sendText：异常吞掉返回 false（回执尽力而为）', async () => {
  const rig = makeRig({ sdkOptions: { failCreate: 1 } })
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendText('ou_1', 'x'), false)
  await rig.inbound.stop()
})

test('editResolved：按账本 target.messageId patch 终态卡片', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  await rig.inbound.editResolved({ channel: 'feishu', chatId: 'ou_1', userId: 'ou_1', messageId: 'om_7' }, '已被桌面端批准')
  assert.equal(rig.fake.state.patched.length, 1)
  assert.equal(rig.fake.state.patched[0].messageId, 'om_7')
  assert.match(rig.fake.state.patched[0].content, /已被桌面端批准/)
  await rig.inbound.stop()
})

test('notifyTargets：通道 allowUsers 优先，缺省回落全局白名单；都空为 []', () => {
  const withOwn = makeRig({ config: { allowUsers: ['ou_a', 'ou_b'] }, fallbackTargets: ['ou_global'] })
  assert.deepEqual(withOwn.inbound.notifyTargets(), [
    { chatId: 'ou_a', userId: 'ou_a' },
    { chatId: 'ou_b', userId: 'ou_b' },
  ])
  const fallback = makeRig({ fallbackTargets: ['ou_global'] })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'ou_global', userId: 'ou_global' }])
  const none = makeRig({})
  assert.deepEqual(none.inbound.notifyTargets(), [])
})

// ---------------------------------------------------------------- 归一契约

test('normalizeInbound：feishu 实例直接走新契约（无需旧形状适配）', async () => {
  const { normalizeInbound } = await import('../src/inbound/_contract.mjs')
  const rig = makeRig({ fallbackTargets: ['ou_1'] })
  const normalized = normalizeInbound(rig.inbound)
  assert.equal(normalized.channel, 'feishu')
  assert.deepEqual(normalized.notifyTargets(), [{ chatId: 'ou_1', userId: 'ou_1' }])
  rig.inbound.start()
  await tick()
  const card = await normalized.sendApprovalCard({ chatId: 'ou_1', title: 't', content: 'c', approvalKey: 'ap:z:1', token: 'tk' })
  assert.deepEqual(card, { messageId: 'om_1' })
  await normalized.editTarget({ messageId: 'om_1' }, 'done')
  assert.equal(rig.fake.state.patched.length, 1)
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- v0.5 动作闭环

test('sendActionCard：interactive 卡片携带按钮行（value.act = ac 负载）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const card = await rig.inbound.sendActionCard({
    chatId: 'ou_1',
    title: '⚠️ 疑似卡住',
    content: 'ws / abcdef12\n已运行 12m',
    actions: [{ label: '⏹ 停止任务', data: 'ac:act:turn/cancel:abcd:tok.sig' }],
  })
  assert.deepEqual(card, { messageId: 'om_1' })
  const sent = rig.fake.state.sent[0]
  assert.equal(sent.msgType, 'interactive')
  const parsed = JSON.parse(sent.content)
  assert.match(parsed.header.title.content, /疑似卡住/)
  const actionElement = parsed.elements.find((element) => element.tag === 'action')
  assert.ok(actionElement !== undefined, '应含 action 按钮块')
  assert.equal(actionElement.actions[0].text.content, '⏹ 停止任务')
  assert.equal(actionElement.actions[0].value.act, 'ac:act:turn/cancel:abcd:tok.sig')
  assert.equal(actionElement.actions[0].value.srcChat, 'ou_1')
  await rig.inbound.stop()
})

test('sendActionCard：空按钮行 → null 不发消息；API 失败 → null', async () => {
  const rig = makeRig({ sdkOptions: { failCreate: 1 } })
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendActionCard({ chatId: 'ou_1', title: 't', content: 'c', actions: [] }), null)
  assert.equal(rig.fake.state.sent.length, 0)
  assert.equal(await rig.inbound.sendActionCard({
    chatId: 'ou_1', title: 't', content: 'c',
    actions: [{ label: '⏹ 停止任务', data: 'ac:act:x:y' }],
  }), null, 'mock 网络失败降级 null')
  await rig.inbound.stop()
})

test('ac: 卡片回调：actions.dispatch 被调 + toast + 卡片 patch 终态', async () => {
  const logger = makeLogger()
  const bus = createInboundBus({ allowUsers: ['ou_1'], logger })
  const fake = makeFakeSdk()
  const dispatched = []
  const actions = { dispatch: (p) => { dispatched.push(p); return { ok: true, message: '✅ 已停止任务' } } }
  const inbound = createFeishuInbound({
    config: { appId: 'cli_a', appSecret: 's', allowUsers: ['ou_1'] },
    bus,
    logger,
    sdkLoader: fake.loader,
    actions,
  })
  inbound.start()
  await tick()
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    action: { value: { act: 'ac:act:turn/cancel:abcd:tok.sig' } },
    operator: { open_id: 'ou_9' },
    message_id: 'om_5',
  })
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].actionKey, 'act:turn/cancel:abcd')
  assert.equal(dispatched[0].token, 'tok.sig')
  assert.equal(dispatched[0].via, 'feishu:action')
  assert.equal(toast.toast.type, 'success')
  assert.match(toast.toast.content, /已停止任务/)
  await tick()
  assert.equal(fake.state.patched.length, 1, '卡片应 patch 为终态')
  const patched = JSON.parse(fake.state.patched[0].content)
  assert.match(patched.elements[0].text.content, /已停止任务/)
  assert.match(patched.elements[0].text.content, /ou_9/)
  await inbound.stop()
})

test('ac: 卡片回调：actions 缺省时不分发（toast 未知操作）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const toast = rig.fake.state.dispatcher.handlers['card.action.trigger']({
    action: { value: { act: 'ac:act:turn/cancel:abcd:tok.sig' } },
    operator: { open_id: 'ou_9' },
    message_id: 'om_5',
  })
  assert.equal(toast.toast.content, '未知操作')
  await tick()
  assert.equal(rig.fake.state.patched.length, 0)
  await rig.inbound.stop()
})

test('ap: 审批回调不受 v0.5 改动影响（回归）', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  const key = 'ap:rm:1'
  const token = vault.mint(key)
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_3'])]]) })
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_7',
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
    context: { open_chat_id: 'oc_3' },
  })
  assert.equal(toast.toast.type, 'success')
  assert.match(toast.toast.content, /已批准/)
  assert.equal((await outcome).decision, 'allowed-once')
  await inbound.stop()
})

// v0.8.3 SEC-1：飞书审批卡来源会话匹配 → 通过；转发到其他会话 → toast 拒绝且不 patch 终态。
test('card.action.trigger：SEC-1 来源会话匹配通过 / 转发到其他会话拒绝（不 patch 终态）', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  const key = 'ap:sec1:1'
  const token = vault.mint(key)
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_orig'])]]) })

  const value = { act: buildApprovalAction('allowed-once', key, token), srcChat: 'oc_orig' }
  const makeEvent = (chatId, messageId) => ({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: messageId, open_chat_id: chatId },
  })

  // 转发到与原会话不同的 chat → 拒绝，不调用 bus.decide，不 patch
  const forwarded = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent('oc_elsewhere', 'om_fwd'))
  assert.equal(forwarded.toast.type, 'info')
  assert.match(forwarded.toast.content, /请到原会话操作/)
  await tick()
  assert.equal(fake.state.patched.length, 0, '转发点击不得 patch 成已完成态')
  assert.equal(bus.pendingCount(), 1, 'wait 未被核销，仍待裁决')

  // 原会话点击 → 通过
  const match = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent('oc_orig', 'om_orig'))
  assert.equal(match.toast.type, 'success')
  assert.equal((await outcome).decision, 'allowed-once')
  await tick()
  assert.equal(fake.state.patched.length, 1, '匹配会话点击应 patch 终态')
  assert.equal(fake.state.patched[0].messageId, 'om_orig')
  await inbound.stop()
})

// v0.8.4 F-08：飞书动作卡来源会话校验——匹配通过；转发拒绝；缺来源元数据兼容放行。
test('ac: 卡片回调：F-08 来源会话匹配通过 / 转发拒绝；缺 srcChats 旧卡兼容', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const storeData = new Map()
  const store = {
    get: (key, fallback) => (storeData.has(key) ? storeData.get(key) : fallback),
    set: (key, value) => { storeData.set(key, value) },
    delete: (key) => { storeData.delete(key) },
  }
  const actions = createActionDispatcher({ vault, store, logger })
  const dispatched = []
  const realDispatch = actions.dispatch.bind(actions)
  actions.dispatch = (p) => { dispatched.push(p); return realDispatch(p) }
  actions.register('turn/cancel', (p) => ({ ok: true, message: '✅ 已停止任务' }))
  const minted = actions.mintAction('turn/cancel', { sessionId: 'sess-1' }, { channel: 'feishu', chatId: 'oc_orig' })
  actions.markSource(minted.key, 'feishu', 'oc_orig')
  // 独立 legacy 卡：账本无来源元数据（旧卡场景）
  const legacyMinted = actions.mintAction('turn/cancel', { sessionId: 'sess-legacy' })

  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus: createInboundBus({ allowUsers: ['ou_1'], logger }), logger, sdkLoader: fake.loader, actions })
  inbound.start()
  await tick()

  const makeEvent = (value, chatId) => ({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: 'om_aq', open_chat_id: chatId },
  })

  const value = { act: `ac:${minted.key}:${minted.token}`, srcChat: 'oc_orig' }
  // 先是转发到其他会话 → 拒绝，不裁决（合法原会话仍能后点）
  const forwarded = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent(value, 'oc_elsewhere'))
  assert.equal(forwarded.toast.type, 'info')
  assert.match(forwarded.toast.content, /原会话/)
  assert.equal(dispatched.length, 0, '转发点击不得执行')

  // 原会话点击 → 成功，chatId 透传 dispatch
  const ok = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent(value, 'oc_orig'))
  assert.equal(ok.toast.type, 'success')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].chatId, 'oc_orig')

  // 独立 legacy 卡（账本无 srcChats、卡片无 srcChat）→ 兼容放行
  const legacy = fake.state.dispatcher.handlers['card.action.trigger'](
    makeEvent({ act: `ac:${legacyMinted.key}:${legacyMinted.token}` }, 'oc_legacy'),
  )
  assert.equal(legacy.toast.type, 'success', '缺来源元数据旧卡兼容放行')
  assert.equal(dispatched.length, 2)
  await inbound.stop()
})

// v0.8.3 SEC-1：飞书提问卡来源会话校验——缺少 srcChat（旧卡）兼容放行，转发拒绝。
test('aq: 卡片回调：SEC-1 来源会话匹配通过 / 转发拒绝；缺 srcChat 旧卡兼容', async () => {
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

  const makeEvent = (value, chatId) => ({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: 'om_q', open_chat_id: chatId },
  })

  // 缺 srcChat（升级前在途卡片）：兼容放行，进入 questions.decide
  const legacy = fake.state.dispatcher.handlers['card.action.trigger'](
    makeEvent({ act: buildQuestionAction('aq:abc12', '0', 'tk') }, 'oc_x'),
  )
  assert.equal(verdicts.length, 1, '旧卡无 srcChat → 放行进入裁决')

  // 带 srcChat 但转发到其他会话 → 拒绝，不进入 questions.decide
  const withSrc = { act: buildQuestionAction('aq:def34', '1', 'tk2'), srcChat: 'oc_orig' }
  const forwarded = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent(withSrc, 'oc_elsewhere'))
  assert.match(forwarded.toast.content, /请到原会话操作/)
  assert.equal(verdicts.length, 1, '转发点击不进入 questions.decide')

  // 原会话点击 → 通过，且 chatId 透传 questions.decide
  const matching = fake.state.dispatcher.handlers['card.action.trigger'](makeEvent(withSrc, 'oc_orig'))
  assert.equal(matching.toast.type, 'success')
  assert.equal(verdicts.length, 2)
  assert.equal(verdicts[verdicts.length - 1].chatId, 'oc_orig', '点击会话应透传给 questions.decide')
  await inbound.stop()
})

// ------------------------------------------------ C1（P1-4）飞书来源比对缺数据 fail-closed

// srcChat 在场而点击会话读不到（负载缺 open_chat_id/顶层兜底也缺）：旧实现 warn 后放行，
// 等于「缺关键信息即绕过来源校验」。现在必须拒绝，且不裁决、不 patch、不核销 wait。
test('C1 飞书来源比对：srcChat 在场但缺点击会话 → fail-closed 拒绝，不 patch 不核销 wait', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  const key = 'ap:c1:1'
  const token = vault.mint(key)
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_orig'])]]) })
  const value = { act: buildApprovalAction('allowed-once', key, token), srcChat: 'oc_orig' }

  // context 整块缺失（顶层 open_chat_id/chat_id 也无）→ clickedChatOf 得空串
  const missing = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value },
  })
  assert.equal(missing.toast.type, 'info')
  assert.match(missing.toast.content, /请到原会话操作/, '缺点击会话必须拒绝')
  await tick()
  assert.equal(fake.state.patched.length, 0, '拒绝不得 patch 终态')
  assert.equal(bus.pendingCount(), 1, 'wait 未被核销，仍待裁决')
  assert.ok(logger.lines.some((line) => /缺少点击会话/.test(line)), `拒绝必须 warn（实际：${logger.lines.join(' | ')}）`)

  // open_chat_id 为空串（形状在但值空）→ 同样拒绝
  const empty = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: 'om_e', open_chat_id: '' },
  })
  assert.match(empty.toast.content, /请到原会话操作/, '空串点击会话必须拒绝')
  assert.equal(bus.pendingCount(), 1)

  // 原会话点击仍可裁决（宪法 #6：拒绝不锁死）
  const ok = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value },
    context: { open_message_id: 'om_ok', open_chat_id: 'oc_orig' },
  })
  assert.equal(ok.toast.type, 'success')
  assert.equal((await outcome).decision, 'allowed-once')
  await inbound.stop()
})

// sourceChatAllowed 由 ac:/aq:/ap: 三个分支共用 —— 平行面也必须 fail-closed（装配回归）。
test('C1 飞书来源比对：ac:/aq: 平行面缺点击会话同样不执行、不作答', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const dispatched = []
  const verdicts = []
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' },
    bus,
    logger,
    sdkLoader: fake.loader,
    actions: { dispatch: (p) => { dispatched.push(p); return { ok: true, message: '✅' } } },
    questions: { decide: (p) => { verdicts.push(p); return { ok: true, message: '✅ 已作答' } } },
  })
  inbound.start()
  await tick()

  const acEvent = { operator: { open_id: 'ou_1' }, action: { value: { act: 'ac:turn/cancel:tk', srcChat: 'oc_orig' } } }
  const acToast = fake.state.dispatcher.handlers['card.action.trigger'](acEvent)
  assert.match(acToast.toast.content, /请到原会话操作/)
  assert.equal(dispatched.length, 0, 'ac: 缺点击会话不得执行动作')

  const aqEvent = { operator: { open_id: 'ou_1' }, action: { value: { act: buildQuestionAction('aq:c1', '0', 'tk'), srcChat: 'oc_orig' } } }
  const aqToast = fake.state.dispatcher.handlers['card.action.trigger'](aqEvent)
  assert.match(aqToast.toast.content, /请到原会话操作/)
  assert.equal(verdicts.length, 0, 'aq: 缺点击会话不得作答')

  await tick()
  assert.equal(fake.state.patched.length, 0, '两条拒绝都不得 patch 终态')
  await inbound.stop()
})

// 旧卡兼容半边（PLAN §C1(b) 显式保留）：srcChat 缺失 → 仍兼容放行，不被本次收紧牵连。
test('C1 飞书来源比对：srcChat 缺失（旧卡）→ 维持兼容放行 + warn', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const verdicts = []
  const inbound = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' },
    bus,
    logger,
    sdkLoader: fake.loader,
    questions: { decide: (p) => { verdicts.push(p); return { ok: true, message: '✅ 已作答' } } },
  })
  inbound.start()
  await tick()
  // 无 srcChat 且无点击会话（最坏形状）：升级前在途卡片仍放行（窗口由卡片自然淘汰封顶）
  const legacy = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildQuestionAction('aq:legacy', '0', 'tk') } },
  })
  assert.equal(legacy.toast.type, 'success', '旧卡无 srcChat → 兼容放行')
  assert.equal(verdicts.length, 1)
  assert.ok(logger.lines.some((line) => /缺少来源会话元数据/.test(line)), `兼容放行必须 warn（实际：${logger.lines.join(' | ')}）`)
  await inbound.stop()
})

// ---------------------------------------------------------------- v0.7.3 GitHub issue 回归

// issue #1/#4/#6：SDK 1.46+ 的 WSClient.start() 内部调 this.logger.info/debug/error，
// logger: null 直接抛 "Cannot read properties of null" → 长连接静默不可用。
test('WSClient 必须收到 noop logger 而非 null（#1/#4/#6）：error 级转发插件 warn', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const wsLogger = rig.fake.state.wsOptions[0].logger
  assert.notEqual(wsLogger, null, '绝不能再传 logger: null')
  assert.equal(typeof wsLogger.info, 'function')
  assert.equal(typeof wsLogger.warn, 'function')
  assert.equal(typeof wsLogger.debug, 'function')
  assert.equal(typeof wsLogger.error, 'function')
  // error 级转发到插件 warn：SDK 内部错误不再不可见（排障要求）
  wsLogger.error('[ws]', new Error('reconnect failed'))
  assert.ok(rig.logger.lines.some((line) => line.includes('飞书 SDK WSClient') && line.includes('reconnect failed')))
  // info/debug 静默：不刷屏宿主日志
  const before = rig.logger.lines.length
  wsLogger.info('[ws]', 'ws client ready')
  wsLogger.debug('[ws]', 'get connect config success')
  assert.equal(rig.logger.lines.length, before)
  await rig.inbound.stop()
})

// issue #6：长连接投递的 card.action.trigger 负载顶层没有 message_id，
// 实际位于 data.context.open_message_id；旧取法恒空 → 卡片永远 patch 不成终态。
test('卡片终态 patch：messageId 读 data.context.open_message_id（#6），顶层字段兜底保留', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk()
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  const key = 'ap:ctx:1'
  const token = vault.mint(key)
  bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_ctx'])]]) })
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    // 真机实测负载形状：顶层 keys 只有 schema/event_id/…/operator/action/host/context
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
    context: { open_message_id: 'om_ctx_1', open_chat_id: 'oc_ctx' },
  })
  assert.equal(toast.toast.type, 'success')
  await tick()
  assert.equal(fake.state.patched.length, 1, 'context.open_message_id 必须被读到，卡片 patch 成终态')
  assert.equal(fake.state.patched[0].messageId, 'om_ctx_1')
  await inbound.stop()
})

// issue #4 Bug3：SDK WSClient 无 close()/stop()，旧 stop() 关不掉连接 →
// 重激活泄漏僵尸 WS + 僵尸实例覆盖 state.json。现走 wsConfig.getWSInstance().terminate()。
test('stop()：SDK 无 close/stop 时 terminate 底层 ws 实例（#4），不再泄漏僵尸连接', async () => {
  const logger = makeLogger()
  const bus = createInboundBus({ allowUsers: ['ou_1'], logger })
  const fake = makeFakeSdk({ bareWs: true })
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  assert.equal(fake.state.wsStarted, 1)
  await inbound.stop()
  assert.equal(fake.state.terminated, true, '应 terminate wsConfig 里的 ws 实例')
  assert.equal(fake.state.closed, false, 'bare WS 原型上根本没有 close（形态校验）')
  await inbound.stop() // 幂等
})

// ---------------------------------------------------------------- Stage-6（task-09）对抗

test('Stage-6 入站 envelope：accountId 注入每条规范化消息（config.accountId，非事件）', async () => {
  const rig = makeRig({ config: { accountId: 'acct_fs' } })
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  rig.fake.state.dispatcher.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_s6', chat_id: 'oc_g', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].accountId, 'acct_fs', '消息 envelope 必须带稳定 accountId')
  assert.equal(accepted[0].channel, 'feishu')
  await rig.inbound.stop()
})

test('Stage-6 生命周期：starting→connected；SDK 缺失→unavailable；WS 握手失败→error；stop→stopped', async () => {
  // 正常启动成功
  const ok = makeRig()
  assert.equal(ok.inbound.clientState(), 'idle')
  ok.inbound.start()
  assert.equal(ok.inbound.clientState(), 'starting')
  await tick()
  assert.equal(ok.inbound.clientState(), 'connected')
  await ok.inbound.stop()
  assert.equal(ok.inbound.clientState(), 'stopped')

  // SDL 缺失 → unavailable（伪造 resolve 错误）
  const del = createFeishuInbound({
    config: { appId: 'a', appSecret: 's' }, bus: createInboundBus({ allowUsers: ['ou_1'] }), logger: makeLogger(),
    sdkLoader: async () => { const e = new Error("Cannot find package '@larksuiteoapi/node-sdk'"); throw e },
  })
  del.start()
  await tick()
  assert.equal(del.clientState(), 'unavailable', 'SDK 缺失必须报告 unavailable 而非 error')

  // WS 握手失败 → error
  const err = makeRig({ sdkOptions: { failStart: true } })
  err.inbound.start()
  await tick()
  assert.equal(err.inbound.clientState(), 'error', '握手失败必须报告 error')
  await err.inbound.stop()
})

test('Stage-6 群聊敏感控制降级：审批不发群消息，动作通知仍可纯文本', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  // 审批卡到群
  const ap = await rig.inbound.sendApprovalCard({ chatId: 'oc_group1', title: '需要批准', content: '敏感审批', approvalKey: 'ap:x:1', token: 'tk' })
  assert.equal(ap.downgraded, true, '群聊审批须标记降级')
  assert.equal(ap.messageId, '', '群聊审批降级不得伪造消息送达证据')
  assert.equal(rig.fake.state.sent.length, 0, '个人模式敏感审批不得泄漏到群聊')
  // 动作卡到群
  const ac = await rig.inbound.sendActionCard({ chatId: 'oc_group2', title: '操作', content: 'c', actions: [{ label: '⏹ 停止', data: 'ac:x:y' }] })
  assert.equal(ac.downgraded, true)
  assert.equal(rig.fake.state.sent[0].msgType, 'text', '普通动作通知仍可降级为文本')
  // 提问卡到群 → 直接拦截（不发任何消息）
  const q = await rig.inbound.sendQuestionCard({ chatId: 'oc_group3', title: '提问', content: 'q', qKey: 'aq:1', token: 'tk', options: ['是', '否'] })
  assert.equal(q, null, '提问按钮绝不放给整群')
  assert.equal(rig.fake.state.sent.length, 1, '提问卡群发不产生任何消息')
  await rig.inbound.stop()
})

test('Stage-6 群聊敏感编号兜底：提问文本在群聊被抑制，普通文本仍可发送', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendText('oc_group-q', '提问：是否继续？\n1. 是\n2. 否\n（回复编号）'), false)
  assert.equal(rig.fake.state.sent.length, 0, '提问编号兜底不得泄漏到群聊')
  assert.equal(await rig.inbound.sendText('oc_group-q', '任务仍在运行'), true, '普通状态文本仍可发群聊')
  assert.equal(rig.fake.state.sent.length, 1)
  await rig.inbound.stop()
})

test('Stage-6 群聊降级不影响私聊：ou_* 仍发完整 interactive 审批卡', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const card = await rig.inbound.sendApprovalCard({ chatId: 'ou_1', title: '需要批准', content: 'c', approvalKey: 'ap:p1', token: 'tk' })
  assert.deepEqual(card, { messageId: 'om_1' })
  assert.equal(rig.fake.state.sent[0].msgType, 'interactive', '私聊必须仍发卡片')
  await rig.inbound.stop()
})

test('Stage-6 patch 失败：卡片回调补发「恰好一条」文本兜底（不静默、不重复、不抛）', async () => {
  const logger = makeLogger()
  const vault = createTokenVault({ secret: 'k' })
  const bus = createInboundBus({ allowUsers: ['ou_1'], vault, logger })
  const fake = makeFakeSdk({ failPatch: 1 })
  const inbound = createFeishuInbound({ config: { appId: 'a', appSecret: 's' }, bus, logger, sdkLoader: fake.loader })
  inbound.start()
  await tick()
  const key = 'ap:pf:1'
  const token = vault.mint(key)
  const outcome = bus.wait(key, 2000, { allowChats: new Map([['feishu', new Set(['oc_pf'])]]) })
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
    context: { open_message_id: 'om_pf', open_chat_id: 'oc_pf' },
  })
  assert.equal(toast.toast.type, 'success')
  assert.equal((await outcome).decision, 'allowed-once', '裁决本身不受 patch 失败影响')
  await tick()
  // patch 失败（failPatch=1，全失败）→ 恰发一条文本兜底到点击会话
  const texts = rigTexts(fake.state.sent)
  assert.equal(texts.length, 1, 'patch 失败必须恰好补发一条文本，绝不重复')
  assert.equal(texts[0].receiveId, 'oc_pf', '兜底发到点击会话')
  assert.match(texts[0].body, /已批准/)
  await inbound.stop()
})

function rigTexts(sent) {
  return sent.filter((s) => s.msgType === 'text').map((s) => ({
    receiveId: s.receiveId,
    body: JSON.parse(s.content).text ?? '',
  }))
}
