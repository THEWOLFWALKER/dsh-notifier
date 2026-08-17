// 阶段 0 测试：多通道交互契约（inbound/_contract + approval/router 多通道化）。
// 核心断言：双通道卡片分发、单通道失败降级、编号回复跨通道裁决、首达采纳、
// v0.2.0 旧形状 telegram（deps.telegram 入口）兼容、editResolved 按通道路由。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import {
  normalizeInbound,
  buildApprovalAction,
  parseApprovalAction,
} from '../src/inbound/_contract.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-multi-')), 'state.json')
}

// ---------------------------------------------------------------- _contract 单元

test('_contract：buildApprovalAction / parseApprovalAction 互逆（approvalKey 含冒号）', () => {
  const key = 'ap:call-7:3' // approvalKey 自身含冒号，解析必须重组而非定长切
  const data = buildApprovalAction('allowed-once', key, 'tok123')
  assert.equal(data, 'ap:allowed-once:ap:call-7:3:tok123')
  assert.deepEqual(parseApprovalAction(data), { decision: 'allowed-once', approvalKey: key, token: 'tok123' })
  assert.equal(parseApprovalAction('reject:allowed-once:k:t'), null)
  assert.equal(parseApprovalAction('ap:rejected:k'), null) // 缺 token 段
  assert.equal(parseApprovalAction(null), null)
})

test('_contract：新契约实例透传（notifyTargets 字符串化、异常归一）', async () => {
  const raw = {
    channel: 'feishu',
    notifyTargets: () => [{ chatId: 'oc_chat001', userId: 'ou1' }, { chatId: 42 }],
    sendApprovalCard: async () => { throw new Error('boom') },
    editResolved: async () => { throw new Error('boom') },
    sendText: async () => { throw new Error('boom') },
  }
  const entry = normalizeInbound(raw)
  assert.equal(entry.channel, 'feishu')
  assert.deepEqual(entry.notifyTargets(), [
    { chatId: 'oc_chat001', userId: 'ou1' },
    { chatId: '42', userId: '42' }, // userId 缺省回落 chatId
  ])
  assert.equal(await entry.sendApprovalCard({}), null) // 抛错 → null（caller 降级）
  await entry.editTarget({ chatId: 'c', messageId: 'm' }, 'text') // 不抛
  assert.equal(await entry.sendText('c', 't'), false)
})

test('_contract：旧 telegram 形状适配（notifyChatIds → notifyTargets；editResolved 3 参 → editTarget）', async () => {
  const calls = []
  const raw = {
    notifyChatIds: () => [100, '200'],
    sendApprovalCard: async () => ({ messageId: 9 }),
    editResolved: async (chatId, messageId, text) => { calls.push([chatId, messageId, text]) },
    sendText: async () => true,
  }
  const entry = normalizeInbound(raw)
  assert.equal(entry.channel, 'telegram') // 旧形状兜底通道名
  assert.deepEqual(entry.notifyTargets(), [
    { chatId: '100', userId: '100' },
    { chatId: '200', userId: '200' },
  ])
  await entry.editTarget({ channel: 'telegram', chatId: '100', userId: '100', messageId: 9 }, '已批准')
  assert.deepEqual(calls, [['100', 9, '已批准']])
  assert.equal(await entry.sendText('100', 'hi'), true)
})

test('_contract：normalizeInbound(null) 返回 null', () => {
  assert.equal(normalizeInbound(null), null)
  assert.equal(normalizeInbound(undefined), null)
})

// ---------------------------------------------------------------- router 多通道

/** 新契约假通道（记录 cards/edits/texts；可注入失败）。 */
function makeFake(channel, { targets = [], failCards = false, failEdit = false } = {}) {
  const state = { cards: [], edits: [], texts: [] }
  return {
    channel,
    state,
    notifyTargets() { return targets },
    async sendApprovalCard(payload) {
      if (failCards) throw new Error('卡片发送失败')
      state.cards.push(payload)
      return { messageId: `m${state.cards.length}` }
    },
    async editResolved(target, text) {
      if (failEdit) throw new Error('编辑失败')
      state.edits.push({ target, text })
    },
    async sendText(chatId, text) { state.texts.push({ chatId, text }); return true },
  }
}

/** 组装 rig：真实 bus/vault/store + 假 ctx/notifier + 传入的交互通道列表。 */
function makeRig({ interactive = [], telegram = null, approvalConfig = {}, router = null, channels = undefined } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'multi-secret' })
  const bus = createInboundBus({ allowUsers: ['u1', 'u2', 'u3', '10001'], store, vault })
  const handlers = {}
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler
      return () => { delete handlers[event] }
    },
  }
  const broadcasts = []
  const notifier = {
    notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true, delivered: [], skipped: [], failed: [] } },
    ...(channels !== undefined ? { channels } : {}),
  }
  const dispose = registerApprovalHandler({
    ctx, notifier, bus, vault, store, router,
    ...(telegram !== null ? { telegram } : { interactive }),
    approvalConfig: { mode: 'answer', timeoutMs: 400, ...approvalConfig },
  })
  const handle = (request = { toolName: 'bash', callId: 'call-1' }) =>
    handlers['approval/request'](request, () => 'desktop')
  return { store, vault, bus, handlers, broadcasts, dispose, handle }
}

test('router 多通道：飞书+QQ 各收到卡片；广播文案含两渠道显示名', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }] })
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }] })
  const rig = makeRig({ interactive: [feishu, qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(feishu.state.cards.length, 1)
  assert.equal(qq.state.cards.length, 1)
  assert.equal(feishu.state.cards[0].approvalKey, qq.state.cards[0].approvalKey) // 同一审批 key
  assert.match(rig.broadcasts[0].content, /飞书、QQ 已发可点按钮/)
  rig.bus.decide({
    approvalKey: feishu.state.cards[0].approvalKey,
    decision: 'rejected',
    token: feishu.state.cards[0].token,
    via: 'feishu:button',
    userId: 'u1',
  })
  assert.equal(await outcome, 'rejected')
  rig.dispose()
})

test('router 多通道：编号回复跨通道裁决；editResolved 按通道路由到各自实例', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }] })
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }] })
  const rig = makeRig({ interactive: [feishu, qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  // QQ 渠道用户回复 1（编号回复降级：无 token，走 decideTrusted）
  const accepted = rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'opengrp01', messageId: 'msg:1:opengrp01', text: '1' })
  assert.equal(accepted.ok, true)
  assert.equal(await outcome, 'allowed-once')
  // 两渠道的卡片都要被改成已批准态，且 target 带各自 messageId
  assert.equal(feishu.state.edits.length, 1)
  assert.equal(feishu.state.edits[0].target.channel, 'feishu')
  assert.match(feishu.state.edits[0].text, /已远程批准/)
  assert.equal(qq.state.edits.length, 1)
  assert.equal(qq.state.edits[0].target.channel, 'qq')
  assert.equal(qq.state.edits[0].target.messageId, 'm1')
  rig.dispose()
})

test('router 多通道：首达采纳——编号回复后按钮再点返回 already-resolved', async () => {
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }] })
  const rig = makeRig({ interactive: [qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'opengrp01', messageId: 'msg:1:opengrp01', text: '2' })
  assert.equal(await outcome, 'rejected')
  const card = qq.state.cards[0]
  const verdict = rig.bus.decide({
    approvalKey: card.approvalKey,
    decision: 'allowed-once',
    token: card.token,
    via: 'qq:button',
    userId: 'u2',
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'already-resolved')
  rig.dispose()
})

test('router 多通道：单渠道卡片失败降级——pushedTo 只剩成功渠道，广播只提成功渠道', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }], failCards: true })
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }] })
  const rig = makeRig({ interactive: [feishu, qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(feishu.state.cards.length, 0)
  assert.equal(qq.state.cards.length, 1)
  assert.doesNotMatch(rig.broadcasts[0].content, /飞书/)
  assert.match(rig.broadcasts[0].content, /QQ 已发可点按钮/)
  rig.bus.decide({
    approvalKey: qq.state.cards[0].approvalKey,
    decision: 'rejected',
    token: qq.state.cards[0].token,
    via: 'qq:button',
    userId: 'u2',
  })
  assert.equal(await outcome, 'rejected')
  assert.equal(feishu.state.edits.length, 0) // 失败渠道没有卡片可编辑
  rig.dispose()
})

test('router 多通道：editResolved 抛错被吞（回执尽力而为）', async () => {
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }], failEdit: true })
  const rig = makeRig({ interactive: [qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'opengrp01', messageId: 'msg:1:opengrp01', text: '1' })
  assert.equal(await outcome, 'allowed-once') // 编辑失败不影响裁决结果
  rig.dispose()
})

test('router 兼容：deps.telegram 旧入口（v0.2.0 形状）仍走单通道路径', async () => {
  const edits = []
  const telegram = {
    // userId 落白名单（10001，TG chat id 数字形态——v0.7 形状守卫后假 id 必须用真形态）：
    // v0.6.3 编号回复只认卡片送达过的渠道+用户
    notifyChatIds: () => ['10001'],
    sendApprovalCard: async (payload) => ({ messageId: 7, payload }),
    editResolved: async (chatId, messageId, text) => { edits.push([chatId, messageId, text]) },
    sendText: async () => true,
  }
  const rig = makeRig({ telegram })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(rig.broadcasts[0].content, /Telegram 已发可点按钮/)
  // 用编号回复路径裁决（legacy 假实例未记录卡片 payload，无法走按钮 token）。
  // 卡片送达过 telegram（pushedTo）→ telegram 白名单用户的 1 可裁决
  rig.bus.accept({ channel: 'telegram', userId: '10001', chatId: '10001', messageId: 'm1', text: '1' })
  assert.equal(await outcome, 'allowed-once')
  assert.equal(edits.length, 1) // legacy editResolved(chatId, messageId, text) 3 参签名被正确调用
  assert.equal(edits[0][1], 7)
  rig.dispose()
})

test('router 多通道：无按钮通道（capabilities.buttons=false，如 QQ 官方机器人）文案分流', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }] })
  const qq = makeFake('qq', { targets: [{ chatId: 'opengrp01', userId: 'u2' }] })
  qq.capabilities = { buttons: false } // QQ 官方机器人：无通用交互按钮卡片
  const rig = makeRig({ interactive: [feishu, qq] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(rig.broadcasts[0].content, /飞书 已发可点按钮/)
  assert.match(rig.broadcasts[0].content, /QQ 已发审批通知/)
  assert.match(rig.broadcasts[0].content, /无按钮渠道可回复 1 批准 \/ 2 拒绝/)
  // 无按钮通道照常收到审批推送（文本通知形态，sendApprovalCard 契约不变）
  assert.equal(qq.state.cards.length, 1)
  // QQ 用户用编号回复裁决
  rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'opengrp01', messageId: 'msg:1:opengrp01', text: '1' })
  assert.equal(await outcome, 'allowed-once')
  rig.dispose()
})

test('router 多通道：无交互渠道时广播退化为纯编号回复话术', async () => {
  const rig = makeRig({ interactive: [] })
  const outcome = rig.handle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(rig.broadcasts[0].content, /本渠道无按钮：回复 1 批准 \/ 2 拒绝/)
  // v0.6.3 收紧：卡片没送达任何渠道（pushedTo 空），裸 1/2 不再全局兜底——
  // 超时静默回落桌面（真实装配里无 inbound 通道时本就无人能回话到 bus，
  // 此断言固化「未送达渠道的裸数字不得误裁决」的安全语义）
  rig.bus.accept({ channel: 'qq', userId: 'u2', chatId: 'x', messageId: 'm1', text: '2' })
  assert.equal(await outcome, 'desktop')
  rig.dispose()
})

test('router 多通道：intended 兜底正路径——分流渠道卡片发送失败，广播教过的编号回复仍可裁决（v0.6.4 R1-P2-1）', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }], failCards: true })
  const telegram = makeFake('telegram', { targets: [{ chatId: '42', userId: 'u3' }] })
  const router = { resolveOutbound: () => ({ channelTypes: ['feishu'], quiet: false, source: 'agent-exact' }) }
  const rig = makeRig({ interactive: [feishu, telegram], router })
  const outcome = rig.handle({ toolName: 'bash', callId: 'call-i', agent: { id: 'agent-1' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 分流只到 feishu：意图渠道卡片发送失败，非意图渠道（telegram）不发卡
  assert.equal(feishu.state.cards.length, 0)
  assert.equal(telegram.state.cards.length, 0)
  // 广播照发（全失败话术），教了「回复 1 批准 / 2 拒绝」
  assert.match(rig.broadcasts[0].content, /回复 1 批准 \/ 2 拒绝/)
  // 意图渠道上白名单用户回复 1 → intended 兜底命中（堵住「卡片失败 + 广播教回复」死路）
  const accepted = rig.bus.accept({ channel: 'feishu', userId: 'u1', chatId: 'oc_chat001', messageId: 'msg:i:1', text: '1' })
  assert.equal(accepted.ok, true)
  assert.equal(await outcome, 'allowed-once')
  rig.dispose()
})

test('router 多通道：intended 收紧对照——非意图渠道的裸 1 仍拒绝（跨渠道不兜底）', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }], failCards: true })
  const telegram = makeFake('telegram', { targets: [{ chatId: '42', userId: 'u3' }] })
  const router = { resolveOutbound: () => ({ channelTypes: ['feishu'], quiet: false, source: 'agent-exact' }) }
  const rig = makeRig({ interactive: [feishu, telegram], router })
  const outcome = rig.handle({ toolName: 'bash', callId: 'call-t', agent: { id: 'agent-1' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // telegram 不在本审批意图渠道内：裸 1 不消费、不裁决，消息照常扇出（false = 未被审批消费）
  const accepted = rig.bus.accept({ channel: 'telegram', userId: 'u3', chatId: '42', messageId: 'msg:t:1', text: '1' })
  assert.equal(accepted.ok, true)
  // 超时静默回落桌面（静默永不批准）
  assert.equal(await outcome, 'desktop')
  rig.dispose()
})

test('router 多通道：空集回落全局广播——agent 绑定解析为空集时不再零卡零广播（v0.6.5 R4-1-P3-5）', async () => {
  const feishu = makeFake('feishu', { targets: [{ chatId: 'oc_chat001', userId: 'u1' }] })
  const router = { resolveOutbound: () => ({ channelTypes: [], quiet: false, source: 'agent-exact' }) }
  const rig = makeRig({ interactive: [feishu], router })
  const outcome = rig.handle({ toolName: 'bash', callId: 'call-e', agent: { id: 'agent-1' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 空集 = 回落全局广播：卡片照发、广播照发，审批不再 120s 无感知超时
  assert.equal(feishu.state.cards.length, 1)
  assert.equal(rig.broadcasts.length, 1)
  // intendedChannels=null（全局语义）：卡片已送达 feishu，编号回复照常可裁决
  rig.bus.accept({ channel: 'feishu', userId: 'u1', chatId: 'oc_chat001', messageId: 'msg:e:1', text: '2' })
  assert.equal(await outcome, 'rejected')
  rig.dispose()
})
