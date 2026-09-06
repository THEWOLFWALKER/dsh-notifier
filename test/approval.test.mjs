// 阶段 4 测试：approval/escalation + approval/router（端到端）。
// 核心安全断言：静默永不批准、token 单次核销、首达采纳、observe 只旁观、异常退回桌面。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEscalationChain } from '../src/approval/escalation.mjs'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { buildApprovalAction, parseApprovalAction } from '../src/inbound/_contract.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-ap-')), 'state.json')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- escalation

test('escalation：stages 按累计延迟依次触发，stageOf 递增', async () => {
  const fired = []
  const chain = createEscalationChain({
    stages: [{ afterMs: 20, note: '一' }, { afterMs: 30, note: '二' }],
  })
  chain.start('k1', (key, stage) => fired.push([key, stage.note]))
  assert.equal(chain.stageOf('k1'), 0)
  await sleep(70)
  assert.deepEqual(fired, [['k1', '一'], ['k1', '二']])
  assert.equal(chain.stageOf('k1'), 2)
  chain.dispose()
})

test('escalation：stop 后剩余阶段不再触发；链清除后 stageOf 归零', async () => {
  const fired = []
  const chain = createEscalationChain({ stages: [{ afterMs: 20 }, { afterMs: 30 }] })
  chain.start('k2', (_key, stage) => fired.push(stage.afterMs))
  await sleep(30)
  assert.equal(chain.stageOf('k2'), 1) // 停止前已到第 1 阶段
  chain.stop('k2')
  await sleep(40)
  assert.deepEqual(fired, [20]) // 第二阶段被 stop 拦下
  assert.equal(chain.stageOf('k2'), 0) // 链已清除
  chain.dispose()
})

test('escalation：同 key 重启链会清掉旧计时器（不双发）', async () => {
  const fired = []
  const chain = createEscalationChain({ stages: [{ afterMs: 25 }] })
  chain.start('k3', () => fired.push('old'))
  chain.start('k3', () => fired.push('new')) // 重启
  await sleep(50)
  assert.deepEqual(fired, ['new'])
  chain.dispose()
})

test('escalation：onStage 抛异常被吞（A listener never throws）', async () => {
  const fired = []
  // afterMs 相对上一阶段累计：两段各 10ms → 10ms / 20ms 各触发一次
  const chain = createEscalationChain({ stages: [{ afterMs: 10 }, { afterMs: 10 }] })
  chain.start('bad', () => { throw new Error('boom') })
  chain.start('good', (_k, stage) => fired.push(stage.afterMs))
  await sleep(50)
  assert.deepEqual(fired, [10, 10]) // bad 链两次都抛但不影响 good 链两次触发
  chain.dispose()
})

test('escalation：stages 为空时 start 是 no-op；dispose 清一切', async () => {
  const chain = createEscalationChain({ stages: [] })
  chain.start('k', () => assert.fail('不应触发'))
  assert.equal(chain.stageOf('k'), 0)
  chain.dispose()

  const chain2 = createEscalationChain({ stages: [{ afterMs: 500 }] })
  const fired = []
  chain2.start('x', () => fired.push(1))
  chain2.dispose()
  await sleep(550)
  assert.deepEqual(fired, [])
})

// ---------------------------------------------------------------- router 端到端

/**
 * 组装一套最小依赖（真实 bus/vault/store + 假 ctx/notifier/telegram）。
 * @param {object} [options]
 * @param {object} [options.approvalConfig]
 * @param {string[]} [options.chatIds]
 * @param {'answer'|'observe'} [options.mode]
 * @param {((chatId: string, text: string) => boolean|Promise<boolean>) | null} [options.sendText]
 *   给 telegram 补 sendText 桩（norm 化后回执可用）。缺省不实现 → norm 化 sendText
 *   对缺方法返回 false（回执静默失败，不升级抛错）。
 */
function makeRig({ approvalConfig = {}, chatIds = ['100'], mode = 'answer', sendText = null, identity = null, logger = null } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'test-secret' })
  // 白名单含 42（个人号）与 100（= 推送 chatId 对应的用户），供编号回复匹配测试
  const bus = createInboundBus({ allowUsers: ['42', '100'], store, vault })
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
  }
  const cards = []
  const edits = []
  const telegram = {
    channel: 'telegram',
    accountId: 'TG_APP',
    notifyChatIds: () => chatIds,
    sendApprovalCard: async ({ chatId, title, approvalKey, token }) => {
      const card = { chatId, title, approvalKey, token, messageId: cards.length + 1 }
      cards.push(card)
      return { messageId: card.messageId }
    },
    editResolved: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }) },
  }
  if (typeof sendText === 'function') telegram.sendText = sendText
  // v0.8.7：编号回复/按钮裁决一律经 Control Core（production 装配恒接线）；rig 必须同步
  // 接线，否则 fail-closed 路径（「Control Core 未接线」）会被误当正常路径测。
  const control = createControlEntry()
  const dispose = registerApprovalHandler({
    ctx, notifier, bus, vault, store, telegram, control,
    ...(identity !== null ? { identity } : {}),
    ...(logger !== null ? { logger } : {}),
    counterStart: 0, // v0.6.4 生产随机化 counter 起点；测试固定 0 保住 ap:<callId>:<n> 确定性断言
    approvalConfig: { mode, ...approvalConfig },
  })
  const handle = (request) => handlers['approval/request'](request, () => 'desktop')
  return { store, vault, bus, handlers, broadcasts, cards, edits, dispose, handle }
}

test('router：observe 模式只旁观——推完卡片立即交还桌面', async () => {
  const rig = makeRig({ mode: 'observe' })
  const result = await rig.handle({ toolName: 'rm', callId: 'c1', reason: '删除 /tmp/x' })
  assert.equal(result, 'desktop') // next() 的返回值原样透传
  assert.equal(rig.cards.length, 1)
  assert.equal(rig.cards[0].approvalKey, 'ap:c1:1')
  assert.equal(rig.broadcasts.length, 1)
  assert.match(rig.broadcasts[0].content, /回复 1 批准/)
  assert.equal(rig.broadcasts[0].level, 'timeSensitive')
  const row = rig.store.get('ap:c1:1')
  assert.equal(row.status, 'pending') // observe 不落决议
  assert.equal(row.mode, 'observe')
  rig.dispose()
})

test('router：answer 模式远程批准——token 首达采纳，账本落 allowed-once', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: '删除文件' })
  await sleep(20) // 等卡片推送与账本写入
  const card = rig.cards[0]
  assert.equal(card.approvalKey, 'ap:c1:1')
  const verdict = rig.bus.decide({
    approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram', userId: '42', chatId: '100',
  })
  assert.deepEqual(verdict, { ok: true })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').status, 'resolved')
  assert.equal(rig.store.get('ap:c1:1').decision, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').mode, 'answer')
  assert.equal(rig.edits.length, 1)
  assert.match(rig.edits[0].text, /已远程批准/)
  rig.dispose()
})

test('router：answer 模式远程拒绝——返回 rejected，卡片编辑为已拒绝', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: '删除文件' })
  await sleep(20)
  const card = rig.cards[0]
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'rejected', token: card.token, via: 'telegram', userId: '42', chatId: '100' })
  assert.equal(await pending, 'rejected')
  assert.equal(rig.store.get('ap:c1:1').decision, 'rejected')
  assert.match(rig.edits[0].text, /已远程拒绝/)
  rig.dispose()
})

test('router：超时无人应答 → resolve(null) 静默回退桌面（永不批准），卡片失效', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 1000, escalation: { enabled: false } } })
  const started = Date.now()
  const result = await rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  assert.ok(Date.now() - started >= 900, '应等待满 timeout')
  assert.equal(result, 'desktop')
  assert.equal(rig.store.get('ap:c1:1').decision, 'timeout')
  assert.equal(rig.edits.length, 1)
  assert.match(rig.edits[0].text, /超时/)
  // 按钮事后补点也无效（token 已随等待者一起失效）
  const card = rig.cards[0]
  assert.deepEqual(
    rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token }),
    { ok: false, reason: 'already-resolved' },
  )
  rig.dispose()
})

test('router：token 单次核销——同 token 二次裁决被拒（按钮双击）', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  assert.equal(rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram', userId: '42', chatId: '100' }).ok, true)
  assert.deepEqual(
    rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token }),
    { ok: false, reason: 'already-resolved' },
  )
  assert.equal(await pending, 'allowed-once')
  rig.dispose()
})

// v0.8.3 SEC-1：按钮裁决来源会话校验——转发点击（chat 不在可接受范围）被拒，
// 不核销 wait 状态；原会话点击仍可生效。
test('router：SEC-1 按钮来源会话不匹配 → 拒绝且不核销，原会话仍可裁决', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000 } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  // 转发到非目标 chat（999）点击 → 明确拒绝，账本保持 pending（不落终态）
  const forwarded = rig.bus.decide({
    approvalKey: card.approvalKey,
    decision: 'allowed-once',
    token: card.token,
    via: 'telegram:button',
    userId: '42',
    chatId: '999',
  })
  assert.deepEqual(forwarded, { ok: false, reason: 'source-chat-mismatch' })
  assert.equal(rig.store.get('ap:c1:1').status, 'pending', '转发点击不得落终态/核销 wait')
  // 原会话（卡片实际送达的 chat 100）点击 → 正常批准
  const original = rig.bus.decide({
    approvalKey: card.approvalKey,
    decision: 'allowed-once',
    token: card.token,
    via: 'telegram:button',
    userId: '42',
    chatId: '100',
  })
  assert.deepEqual(original, { ok: true })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').status, 'resolved')
  rig.dispose()
})

test('router：伪造/篡改 token 被拒（bad-signature / key-mismatch），审批继续等到超时', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 800, escalation: { enabled: false } } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  const forged = rig.vault.mint('ap:other:9')
  assert.equal(rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: 'garbage.sig' }).reason, 'bad-signature')
  assert.equal(rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: forged }).reason, 'key-mismatch')
  assert.equal(await pending, 'desktop') // 全被拒 → 超时回退
  rig.dispose()
})

// G-41（2026-08-28）：按钮裁决接收人校验不再被 `targets.length > 0` 门控。pushedTo
// 空表（增量落账窗口/写盘失败的临时形态）= 无法证明投递对象 → fail-closed 回拒并给
// 可行动回执；非空表的 userId 匹配/不匹配两分支维持既有行为。
test('router：G-41 pushedTo 空表按钮裁决 → fail-closed 回拒（回执可见 + warn 留痕），不落终态', async () => {
  const texts = []
  const warns = []
  const rig = makeRig({
    approvalConfig: { timeoutMs: 800, escalation: { enabled: false } },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  // 模拟增量落账窗口/写盘失败：卡已送达（token 在用户手里），账本 pushedTo 仍为空表
  const row = rig.store.get(card.approvalKey)
  rig.store.set(card.approvalKey, { ...row, pushedTo: [] })
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: '100', messageId: 'msg:g41:1',
    text: 'approve', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  await sleep(10)
  assert.equal(texts.length, 1)
  assert.match(texts[0].text, /未找到该审批的投递记录/)
  assert.equal(warns.some((w) => /无法核验/.test(w)), true, '回拒必须留痕（静默即事故）')
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', '回拒不落终态、不核销 token')
  assert.equal(await pending, 'desktop', '审批未被裁决，超时交还桌面')
  rig.dispose()
})

test('router：G-41 非空表 userId 不匹配 → 「仅审批接收人可点击裁决」回拒不裁决（既有行为维持）', async () => {
  const texts = []
  const rig = makeRig({
    approvalConfig: { timeoutMs: 800, escalation: { enabled: false } },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  // 卡片实际送达 chat 100（legacy 形状下 userId = chatId = 100）；同渠道其他用户 42 点击
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: '100', messageId: 'msg:g41:2',
    text: 'approve', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  await sleep(10)
  assert.equal(texts.length, 1)
  assert.match(texts[0].text, /仅审批接收人可点击裁决/)
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', '不匹配不落终态')
  assert.equal(await pending, 'desktop', '审批未被裁决，超时交还桌面')
  rig.dispose()
})

test('router：G-41 非空表 userId 匹配 → 正常裁决放行（既有行为维持）', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:g41:3',
    text: 'approve', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get(card.approvalKey).decision, 'allowed-once')
  rig.dispose()
})

test('router：编号回复降级——卡片送达渠道的白名单用户回复 1 批准最近待决', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // v0.6.3 收紧：编号回复只认卡片实际送达过的渠道（真实装配里能回话到 bus 的
  // 通道必然在 interactive、推送时已进 pushedTo）——telegram 用户 100 精确命中
  assert.deepEqual(
    rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' }),
    { ok: true },
  )
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').decision, 'allowed-once')
  rig.dispose()
})

test('router：编号回复收紧——卡片未送达的渠道（如微信类通道恰逢推送失败）裸 1/2 不再全局兜底', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 800, escalation: { enabled: false } } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 审批是全局广播的：用户在没收到卡片的渠道日常对话里发裸 1，不得误裁决别处的审批
  assert.deepEqual(
    rig.bus.accept({ channel: 'wechat', accountId: 'WX_APP', userId: '42', chatId: 'w1', messageId: 'msg:w:1', text: '1' }),
    { ok: true },
  )
  assert.equal(await pending, 'desktop') // 未被消费 → 超时静默回落桌面
  assert.equal(rig.store.get('ap:c1:1').decision, 'timeout')
  rig.dispose()
})

test('router：编号回复优先精确匹配（pushedTo 的 channel+user），再同渠道回退', async () => {
  // CRACK-003：同渠道回退命中他人卡片——42 需 telegram owner 绑定才可代决（放行矩阵）
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'telegram', userId: '42' }) // 首条绑定 = owner
  const rig = makeRig({ identity })
  const first = rig.handle({ toolName: 'a', callId: 'c1', reason: 'x' })
  await sleep(20)
  const second = rig.handle({ toolName: 'b', callId: 'c2', reason: 'x' })
  await sleep(20)
  assert.equal(rig.cards.length, 2)
  // telegram 用户 100（= chatId）回复 2 → 精确命中最新一条 ap:c2:2
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '2' })
  assert.equal(await second, 'rejected')
  // 同渠道其他白名单用户（卡片送达过 telegram，但非本人目标）回复 1 → 同渠道回退命中最新 pending
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: '100', messageId: 'msg:t:2', text: '1' })
  assert.equal(await first, 'allowed-once')
  rig.dispose()
})

// CRACK-003 编号回复归属闸：exact 放行；onChannel/intended 仅 owner 可代决；identity 缺失 fail-closed。
test('router：CRACK-003 归属闸——member 代决他人卡片被拒（消费 + 回执「无权」+ warn，审批不裁决）', async () => {
  const texts = []
  const warns = []
  const identity = createIdentity({ store: createStore(tempPath()) })
  identity.addBinding({ channel: 'telegram', userId: '100' }) // owner = 卡发本人
  identity.addBinding({ channel: 'telegram', userId: '42' }) // 第二条 = member
  const rig = makeRig({
    approvalConfig: { timeoutMs: 800, escalation: { enabled: false } },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
    identity,
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 卡片送达 chatId 100（user 100）；同渠道 member 42 裸 1 → 归属闸拒绝
  assert.deepEqual(
    rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: '100', messageId: 'msg:t:3', text: '1' }),
    { ok: true },
  )
  assert.equal(texts.length, 1)
  assert.match(texts[0].text, /无权/)
  assert.equal(warns.some((w) => /归属拒绝/.test(w)), true, '拒绝必须留痕（静默即事故）')
  assert.equal(await pending, 'desktop', 'member 的裸 1 未裁决，审批超时交还桌面')
  assert.equal(rig.store.get('ap:c1:1').decision, 'timeout')
  rig.dispose()
})

test('router：CRACK-003 fail-closed——identity 缺失时非 exact 编号回复一律拒绝', async () => {
  const texts = []
  const rig = makeRig({
    approvalConfig: { timeoutMs: 800, escalation: { enabled: false } },
    sendText: async (chatId, text) => { texts.push({ chatId, text }); return true },
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  assert.deepEqual(
    rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '42', chatId: '100', messageId: 'msg:t:3', text: '2' }),
    { ok: true },
  )
  assert.equal(texts.length, 1)
  assert.match(texts[0].text, /无权/)
  assert.equal(await pending, 'desktop', 'identity 缺失 → 非 exact 一律 fail-closed 拒绝')
  assert.equal(rig.store.get('ap:c1:1').decision, 'timeout')
  rig.dispose()
})

test('router：numberedReply: false 关闭编号回复降级', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 800, numberedReply: false, escalation: { enabled: false } } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 用「卡片送达过的渠道 + 本人」回复——确保拦下裁决的是 numberedReply 开关本身，
  // 而不是 v0.6.3 收紧的未送达兜底移除
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' })
  assert.equal(await pending, 'desktop') // 未被编号回复裁决 → 超时
  rig.dispose()
})

// v0.8.3 E-2：审批编号回复对已决竞态（首达采纳/超时已 settle、账本暂未翻终态）消费 + 回执，
// 对齐 questions/router.mjs:316-318 既有姿态——不把裸 '1'/'2' 漏进对话路由。
test('router：E-2 已决竞态编号回复 → 消费且不重结（Control Core 接线下竞态只输在时序，账本只结一次）', async () => {
  const rig = makeRig({
    approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } },
  })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  // 首达采纳：按钮路径 settle waiter（账本仍 pending，handler 尚在 await decisionPromise）
  assert.deepEqual(
    rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram:button', userId: '42', chatId: '100' }),
    { ok: true },
  )
  // 窄竞态窗内第二条编号回复 '1'：latestPendingFor 仍命中 pending，decideTrusted 返回 already-resolved
  assert.deepEqual(
    rig.bus.decideTrusted({ approvalKey: card.approvalKey, decision: 'allowed-once', via: 'telegram:reply', userId: '100' }),
    { ok: false, reason: 'already-resolved' },
  )
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:2', text: '1' })
  // 已决竞态 → 消费：后注册观察者看不到该消息（不进对话路由）
  assert.equal(seen.length, 0, '已决竞态的裸编号被消费，不落回对话路由')
  // Control Core 接线下：该编号回复是 valid（来源/证据通过），但 settle 回调如实报
  // already-resolved——绝不产生第二次结算。用户早先从按钮已获确认，这里不再追加回执。
  assert.equal(await pending, 'allowed-once')
  const row = rig.store.get(card.approvalKey)
  assert.equal(row.decision, 'allowed-once', '账本只结一次（按钮首达）')
  rig.dispose()
})

test('router：E-2 已决竞态即使回执失败仍消费（B8，不因回执缺失漏进会话）', async () => {
  // 默认 rig 的 telegram 无 sendText → norm 化 sendText 返回 false（回执静默失败）
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  const card = rig.cards[0]
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram:button', userId: '42', chatId: '100' })
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:2', text: '1' })
  assert.equal(seen.length, 0, '回执失败也不影响消费，裸编号不落回对话路由')
  assert.equal(await pending, 'allowed-once')
  rig.dispose()
})

test('router：E-2 无匹配待决审批的裸编号不被消费（B3/B9，钉死不过度收紧）', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 无任何待决审批：裸 '1' 是正常会话消息，必须落回对话路由（不裁决不回执）
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' })
  assert.deepEqual(seen, ['1'], '无匹配审批时裸编号不被消费，落回对话路由')
  rig.dispose()
})

test('router：E-2 未 settle 的正常 pending 编号回复仍走裁决（B1，不被误消费）', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 正常 pending（未 settle）：编号回复 '1' 应裁决批准，而非被「已决竞态」分支吞掉
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').decision, 'allowed-once')
  assert.equal(seen.length, 0, '正常裁决路径消费该消息')
  rig.dispose()
})

test('router：升级链在等待期触发再提醒，裁决后停止', async () => {
  const rig = makeRig({
    approvalConfig: {
      timeoutMs: 5000,
      // 窗口拉宽（50→400ms）：原 50/80ms 双阶段夹 70ms 检查点，CI 负载下 sleep 越窗
      // 会把「未触发」误报成已触发（flaky 根因）；语义不变——第一阶段已过、第二阶段未到
      escalation: { enabled: true, stages: [{ afterMs: 50, note: '催一催' }, { afterMs: 400, note: '再催' }] },
    },
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(150) // 宽窗中点：第一阶段必触发，第二阶段必未触发
  const card = rig.cards[0]
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram', userId: '42', chatId: '100' })
  await pending
  const escalationBroadcasts = rig.broadcasts.filter((msg) => /仍在等待批准/.test(msg.title))
  assert.equal(escalationBroadcasts.length, 1) // 只触发了第一阶段就被裁决叫停
  assert.match(escalationBroadcasts[0].content, /催一催/)
  rig.dispose()
})

test('router：notifier.notifyAll 抛异常 → 照常等待远程裁决，超时交还桌面（A listener never throws）', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => {} } }
  const notifier = { notifyAll: async () => { throw new Error('all channels down') } }
  const telegram = { notifyChatIds: () => [], sendApprovalCard: async () => null, editResolved: async () => {} }
  registerApprovalHandler({
    ctx, notifier, bus, vault, store, telegram,
    counterStart: 0,
    approvalConfig: { mode: 'answer', timeoutMs: 50, escalation: { enabled: false } },
  })
  const result = await handlers['approval/request']({ toolName: 'rm', callId: 'c1' }, () => 'desktop')
  assert.equal(result, 'desktop')
})

test('router：多 chat 推送全部入账 pushedTo；卡片失败降级纯通知', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => {} } }
  const broadcasts = []
  const notifier = { notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true } } }
  const results = [{ messageId: 1 }, null] // 第一个 chat 成功、第二个失败
  const telegram = {
    notifyChatIds: () => ['100', '200'],
    sendApprovalCard: async () => results.shift(),
    editResolved: async () => {},
  }
  registerApprovalHandler({ ctx, notifier, bus, vault, store, telegram, counterStart: 0, approvalConfig: { mode: 'answer', timeoutMs: 800, escalation: { enabled: false } } })
  const pending = handlers['approval/request']({ toolName: 'rm', callId: 'c1' }, () => 'desktop')
  await sleep(20)
  const row = store.get('ap:c1:1')
  assert.deepEqual(row.pushedTo, [{ channel: 'telegram', chatId: '100', userId: '100', messageId: 1 }])
  assert.match(broadcasts[0].content, /Telegram 已发可点按钮/)
  assert.equal(await pending, 'desktop')
})

test('router：dispose 级联终止在途审批，pending 记录落 terminated', async () => {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['42'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => {} } }
  const broadcasts = []
  const edits = []
  const notifier = { notifyAll: async (msg) => { broadcasts.push(msg); return { ok: true } } }
  const telegram = {
    notifyChatIds: () => ['100'],
    sendApprovalCard: async ({ chatId, approvalKey, token }) => { edits.push({ chatId, approvalKey, token }); return { messageId: 1 } },
    editResolved: async (...args) => { edits.push({ args }) }
  }
  registerApprovalHandler({ ctx, notifier, bus, vault, store, telegram, counterStart: 0, approvalConfig: { mode: 'answer', timeoutMs: 800, escalation: { enabled: false } } })
  const pending = handlers['approval/request']({ toolName: 'rm', callId: 'c1', agent: { id: 'agent-1' } }, () => 'desktop')
  await sleep(20)
  assert.equal(bus.abandonByAgent('agent-1'), 1)
  assert.equal(await pending, 'desktop')
  const row = store.get('ap:c1:1')
  assert.equal(row.decision, 'terminated')
  assert.equal(row.status, 'resolved')
  assert.ok(edits.some((item) => /已终止/.test(String(item.args?.at(-1) ?? ''))))
})

test('router：callId 缺失回退 toolName；请求字段异常不崩（key 仍可铸出）', async () => {
  const rig = makeRig({ approvalConfig: { escalation: { enabled: false }, timeoutMs: 800 } })
  const pending = rig.handle({ toolName: 'bash' }) // 无 callId
  await sleep(20)
  assert.equal(rig.cards[0].approvalKey, 'ap:bash:1')
  await pending
  rig.dispose()
})

// C2：审批桥僵尸行修复——无存活 waiter 的 pending 行不得参与编号回复匹配。
test('router：C2 僵尸 pending 行不参与编号回复匹配，消息落回对话路由', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  const seen = []
  rig.bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  // 直接写入一条无 waiter 的僵尸 pending 行（模拟崩溃/写盘失败残留）
  rig.store.set('ap:zombie:1', {
    status: 'pending',
    mode: 'answer',
    toolName: 'zombie-tool',
    agentId: null,
    pushedTo: [{ channel: 'telegram', chatId: '100', userId: '100', messageId: 1 }],
    intendedChannels: null,
    createdAt: Date.now(),
  })
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:z:1', text: '1' })
  assert.deepEqual(seen, ['1'], '僵尸行不得消费编号回复')
  rig.dispose()
})

test('router：C2 编号回复优先命中存活 waiter，忽略更晚的僵尸行', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 5000, escalation: { enabled: false } } })
  // 注入一个创建时间更晚的僵尸行（模拟崩溃残留覆盖了时间戳）
  rig.store.set('ap:zombie:2', {
    status: 'pending',
    mode: 'answer',
    toolName: 'zombie-tool',
    agentId: null,
    pushedTo: [{ channel: 'telegram', chatId: '100', userId: '100', messageId: 99 }],
    intendedChannels: null,
    createdAt: Date.now() + 999_000,
  })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 僵尸行更晚，但无存活 waiter，应被跳过；编号回复命中 ap:c1:1 并批准
  rig.bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').decision, 'allowed-once')
  rig.dispose()
})

test('router：C2 崩溃恢复后，持久化僵尸 pending 行不吞编号回复', async () => {
  const store = createStore(tempPath())
  // 模拟旧进程崩溃残留：store 里有 pending 行，但新 bus 无 waiter
  store.set('ap:crash:1', {
    status: 'pending',
    mode: 'answer',
    toolName: 'crash-tool',
    agentId: null,
    pushedTo: [{ channel: 'telegram', chatId: '100', userId: '100', messageId: 1 }],
    intendedChannels: null,
    createdAt: Date.now(),
  })
  const vault = createTokenVault({ secret: 's' })
  const bus = createInboundBus({ allowUsers: ['100'], store, vault })
  const handlers = {}
  const ctx = { on: (event, handler) => { handlers[event] = handler; return () => {} } }
  const notifier = { notifyAll: async () => ({ ok: true }) }
  const telegram = { notifyChatIds: () => [], sendApprovalCard: async () => null, editResolved: async () => {}, sendText: async () => true }
  registerApprovalHandler({
    ctx, notifier, bus, vault, store, telegram,
    counterStart: 0,
    approvalConfig: { mode: 'answer', timeoutMs: 5000, escalation: { enabled: false } },
  })
  const seen = []
  bus.onMessage((envelope) => { seen.push(envelope.text); return false })
  bus.accept({ channel: 'telegram', accountId: 'TG_APP', userId: '100', chatId: '100', messageId: 'msg:crash:1', text: '1' })
  assert.deepEqual(seen, ['1'], '崩溃残留 pending 行不得误导回执')
})
