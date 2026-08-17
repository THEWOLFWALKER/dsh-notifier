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

/** 组装一套最小依赖（真实 bus/vault/store + 假 ctx/notifier/telegram）。 */
function makeRig({ approvalConfig = {}, chatIds = ['100'], mode = 'answer' } = {}) {
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
    notifyChatIds: () => chatIds,
    sendApprovalCard: async ({ chatId, title, approvalKey, token }) => {
      const card = { chatId, title, approvalKey, token, messageId: cards.length + 1 }
      cards.push(card)
      return { messageId: card.messageId }
    },
    editResolved: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }) },
  }
  const dispose = registerApprovalHandler({
    ctx, notifier, bus, vault, store, telegram,
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
  rig.dispose()
})

test('router：answer 模式远程批准——token 首达采纳，账本落 allowed-once', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: '删除文件' })
  await sleep(20) // 等卡片推送与账本写入
  const card = rig.cards[0]
  assert.equal(card.approvalKey, 'ap:c1:1')
  const verdict = rig.bus.decide({
    approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token, via: 'telegram', userId: '42',
  })
  assert.deepEqual(verdict, { ok: true })
  assert.equal(await pending, 'allowed-once')
  assert.equal(rig.store.get('ap:c1:1').status, 'resolved')
  assert.equal(rig.store.get('ap:c1:1').decision, 'allowed-once')
  assert.equal(rig.edits.length, 1)
  assert.match(rig.edits[0].text, /已远程批准/)
  rig.dispose()
})

test('router：answer 模式远程拒绝——返回 rejected，卡片编辑为已拒绝', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: '删除文件' })
  await sleep(20)
  const card = rig.cards[0]
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'rejected', token: card.token, via: 'telegram', userId: '42' })
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
  assert.equal(rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token }).ok, true)
  assert.deepEqual(
    rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token }),
    { ok: false, reason: 'already-resolved' },
  )
  assert.equal(await pending, 'allowed-once')
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

test('router：编号回复降级——卡片送达渠道的白名单用户回复 1 批准最近待决', async () => {
  const rig = makeRig()
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // v0.6.3 收紧：编号回复只认卡片实际送达过的渠道（真实装配里能回话到 bus 的
  // 通道必然在 interactive、推送时已进 pushedTo）——telegram 用户 100 精确命中
  assert.deepEqual(
    rig.bus.accept({ channel: 'telegram', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' }),
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
    rig.bus.accept({ channel: 'wechat', userId: '42', chatId: 'w1', messageId: 'msg:w:1', text: '1' }),
    { ok: true },
  )
  assert.equal(await pending, 'desktop') // 未被消费 → 超时静默回落桌面
  assert.equal(rig.store.get('ap:c1:1').decision, 'timeout')
  rig.dispose()
})

test('router：编号回复优先精确匹配（pushedTo 的 channel+user），再同渠道回退', async () => {
  const rig = makeRig()
  const first = rig.handle({ toolName: 'a', callId: 'c1', reason: 'x' })
  await sleep(20)
  const second = rig.handle({ toolName: 'b', callId: 'c2', reason: 'x' })
  await sleep(20)
  assert.equal(rig.cards.length, 2)
  // telegram 用户 100（= chatId）回复 2 → 精确命中最新一条 ap:c2:2
  rig.bus.accept({ channel: 'telegram', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '2' })
  assert.equal(await second, 'rejected')
  // 同渠道其他白名单用户（卡片送达过 telegram，但非本人目标）回复 1 → 同渠道回退命中最新 pending
  rig.bus.accept({ channel: 'telegram', userId: '42', chatId: '100', messageId: 'msg:t:2', text: '1' })
  assert.equal(await first, 'allowed-once')
  rig.dispose()
})

test('router：numberedReply: false 关闭编号回复降级', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 800, numberedReply: false, escalation: { enabled: false } } })
  const pending = rig.handle({ toolName: 'rm', callId: 'c1', reason: 'x' })
  await sleep(20)
  // 用「卡片送达过的渠道 + 本人」回复——确保拦下裁决的是 numberedReply 开关本身，
  // 而不是 v0.6.3 收紧的未送达兜底移除
  rig.bus.accept({ channel: 'telegram', userId: '100', chatId: '100', messageId: 'msg:t:1', text: '1' })
  assert.equal(await pending, 'desktop') // 未被编号回复裁决 → 超时
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
  rig.bus.decide({ approvalKey: card.approvalKey, decision: 'allowed-once', token: card.token })
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

test('router：dispose 反注册事件与消息订阅，后续 accept 不再触发裁决', async () => {
  const rig = makeRig({ approvalConfig: { timeoutMs: 800, escalation: { enabled: false } } })
  rig.dispose()
  assert.equal(rig.handlers['approval/request'], undefined) // 事件已反注册
  // 消息订阅也已退订：accept 文本不影响任何东西（不再裁决、不抛错）
  assert.deepEqual(
    rig.bus.accept({ channel: 'wechat', userId: '42', chatId: 'w', messageId: 'm1', text: '1' }),
    { ok: true },
  )
  assert.equal(rig.bus.pendingCount(), 0)
})

test('router：callId 缺失回退 toolName；请求字段异常不崩（key 仍可铸出）', async () => {
  const rig = makeRig({ approvalConfig: { escalation: { enabled: false }, timeoutMs: 800 } })
  const pending = rig.handle({ toolName: 'bash' }) // 无 callId
  await sleep(20)
  assert.equal(rig.cards[0].approvalKey, 'ap:bash:1')
  await pending
  rig.dispose()
})
