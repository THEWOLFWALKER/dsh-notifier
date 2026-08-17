// 阶段 1 测试：inbound/feishu-bot（WS 长连接、事件入站、卡片裁决、回执、SDK 懒加载降级）。
// SDK 全 mock（sdkLoader 注入 fake），不发真实网络请求、不装真实依赖。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuInbound, resolveFeishuInboundConfig } from '../src/inbound/feishu-bot.mjs'
import { buildApprovalAction } from '../src/inbound/_contract.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

// ---------------------------------------------------------------- fake SDK

/**
 * 伪造 @larksuiteoapi/node-sdk：记录 Client/WSClient 全部交互。
 * wsClient.start() 捕获 eventDispatcher，测试用 handlers['im.message.receive_v1'] 直接投喂事件。
 */
function makeFakeSdk({ failStart = false, failCreate = 0, bareWs = false } = {}) {
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
    config: { appId: 'cli_a', appSecret: 's', allowUsers: config.allowUsers, domain: config.domain },
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
  const outcome = bus.wait(key, 2000)
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_card1',
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
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
  const outcome = bus.wait(key, 2000)
  const fire = () => fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildApprovalAction('rejected', key, token) } },
  })
  const first = fire()
  const second = fire()
  assert.equal(first.toast.type, 'success')
  assert.match(second.toast.content, /已处理或已过期/)
  assert.equal((await outcome).decision, 'rejected', '首达采纳')
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
  const outcome = bus.wait(key, 2000)
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    operator: { open_id: 'ou_1' },
    open_message_id: 'om_7',
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
  })
  assert.equal(toast.toast.type, 'success')
  assert.match(toast.toast.content, /已批准/)
  assert.equal((await outcome).decision, 'allowed-once')
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
  bus.wait(key, 2000)
  const toast = fake.state.dispatcher.handlers['card.action.trigger']({
    // 真机实测负载形状：顶层 keys 只有 schema/event_id/…/operator/action/host/context
    operator: { open_id: 'ou_1' },
    action: { value: { act: buildApprovalAction('allowed-once', key, token) } },
    context: { open_message_id: 'om_ctx_1' },
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
