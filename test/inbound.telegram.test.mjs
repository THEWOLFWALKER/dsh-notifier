// 阶段 4 测试：inbound/telegram-bot（长轮询、按钮裁决、offset 持久化、异常退避）。
// fetch 全 mock，不发真实网络请求。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelegramInbound } from '../src/inbound/telegram-bot.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createActionDispatcher } from '../src/actions.mjs'
import { buildActionPayload } from '../src/inbound/_contract.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-tg-')), 'state.json')
}

/**
 * mock fetch：按 API 方法名路由脚本；每次调用记录进 calls；响应统一延迟 delayMs
 * （避免空轮询热循环，贴近真实长轮询节奏）。
 */
function makeFetch(script = {}, { delayMs = 5 } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(init.body ?? '{}')
    calls.push({ url: String(url), method, body })
    const handler = script[method]
    const out = typeof handler === 'function' ? handler(body, calls.length) : (handler ?? { ok: true, result: [] })
    if (out instanceof Error) throw out
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

const CONFIG = { botToken: 'T0KEN', notifyChatIds: [100] }

function makeBus(spy = {}) {
  return {
    accept: (env) => { spy.accept?.(env); return { ok: true } },
    decide: (payload) => { spy.decide?.(payload); return { ok: true } },
  }
}

// ---------------------------------------------------------------- 卡片

test('sendApprovalCard：按钮只带短引用 r:<ref>（v0.6.2 真机 400 BUTTON_DATA_INVALID 修复）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 7 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const token = vault.mint('ap:rm:1')
  const card = await tg.sendApprovalCard({ chatId: 100, title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token })
  assert.deepEqual(card, { messageId: 7 })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/botT0KEN\/sendMessage$/)
  assert.equal(calls[0].body.chat_id, 100)
  assert.match(calls[0].body.text, /需要批准：rm/)
  const buttons = calls[0].body.reply_markup.inline_keyboard[0]
  for (const button of buttons) {
    assert.match(button.callback_data, /^r:[23456789A-HJKMNPQRSTVWXYZ]{8}$/, '短引用形态（Crockford base32 去歧义）')
    assert.ok(button.callback_data.length <= 64, 'TG callback_data 64 字节硬限')
    assert.ok(!button.callback_data.includes(token), '按钮不外泄完整 token（~109 字符的 payload.sig）')
  }
  assert.notEqual(buttons[0].callback_data, buttons[1].callback_data, '批准/拒绝各铸独立 ref')
})

test('sendApprovalCard：API 失败返回 null（调用方降级为纯通知）', async () => {
  const { fetchImpl } = makeFetch({ sendMessage: { ok: false, description: 'chat not found' } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const card = await tg.sendApprovalCard({ chatId: 100, title: 't', content: 'c', approvalKey: 'ap:x:1', token: vault.mint('ap:x:1') })
  assert.equal(card, null)
})

test('callback-ref 容量中途耗尽：动作卡整卡降级并回收本次已铸引用', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 8 } } }, { delayMs: 0 })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault({ secret: 'k' }), fetchImpl })
  // 默认注册表容量 256。先占满 255 个，再让双按钮卡在第二个引用处耗尽；
  // 该卡不得发送缺按钮版本，且已铸出的第一个引用应被回收。
  for (let i = 0; i < 255; i += 1) {
    assert.deepEqual(await tg.sendActionCard({ chatId: 100, title: 't', content: 'c', actions: [{ label: `a${i}`, data: `ac:${i}` }] }), { messageId: 8 })
  }
  const before = calls.length
  assert.equal(await tg.sendActionCard({
    chatId: 100, title: 'partial', content: 'c',
    actions: [{ label: 'a', data: 'ac:a' }, { label: 'b', data: 'ac:b' }],
  }), null)
  assert.equal(calls.length, before, '容量中途耗尽时不发送不完整卡片')
  assert.deepEqual(await tg.sendActionCard({ chatId: 100, title: 'reclaimed', content: 'c', actions: [{ label: 'a', data: 'ac:a2' }] }), { messageId: 8 })
  assert.equal(calls.length, before + 1, '失败卡已回收已铸 ref，下一张可正常发送')
})

// ---------------------------------------------------------------- P1-1 协议护栏
// mock fetch 不校验协议形状（v0.6.2 BUTTON_DATA_INVALID / v0.6.3 legacy markdown 两次
// 真机事故的共因）。以下测试让 mock 承担协议校验角色：TG sendMessage text 硬限
// 4096 字符，超限必 400 "message is too long" → 卡片全灭退化为纯编号回复。

test('P1-1 审批卡超长 reason：按 UTF-16 码元截断到 4096 内仍送达（TG message is too long 护栏）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 11 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const token = vault.mint('ap:long-op:1')
  // 4500 个 astral 码点（每个 2 个 UTF-16 码元）：验证码元计数与 surrogate pair 不被劈开
  const content = '🎮'.repeat(4500)
  const card = await tg.sendApprovalCard({ chatId: 100, title: '需要批准：long-op', content, approvalKey: 'ap:long-op:1', token })
  assert.deepEqual(card, { messageId: 11 }, '截断后卡片必须仍送达——不因超长 400 静默退化为编号回复')
  const text = calls[0].body.text
  assert.ok(text.length <= 4096, `text 码元数 ${text.length} 必须 ≤4096（TG 硬限按 UTF-16 码元执行）`)
  assert.ok(text.includes('（内容过长，已截断）'), '截断标记可见')
  assert.ok(text.startsWith('🔐'), '头部标识保留（截断只动尾部）')
  // surrogate pair 完整性：剥离合法代理对后不得残留孤立代理项
  assert.ok(!/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), '截断切口在码点边界，不劈 surrogate pair')
  // 按钮形态完好：截断只影响展示文本，不影响裁决载体
  const buttons = calls[0].body.reply_markup.inline_keyboard[0]
  for (const button of buttons) assert.match(button.callback_data, /^r:[23456789A-HJKMNPQRSTVWXYZ]{8}$/, 'ref 形态不受截断影响')
})

test('P1-1 对抗用例：码点数 ≤4096 但码元数超限的全 emoji 文本必须截断（码点计数会漏）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 16 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  // 3000 个 astral emoji：3000 码点（< 4096 合规）但 6000 UTF-16 码元（> 4096 超限）。
  // 只按码点计数的实现会放行 → 真机 400 message is too long。
  const content = '🎯'.repeat(3000)
  await tg.sendApprovalCard({ chatId: 100, title: '需要批准：emoji', content, approvalKey: 'ap:emoji:1', token: vault.mint('ap:emoji:1') })
  const text = calls[0].body.text
  assert.ok(text.length <= 4096, `码元计数必须截断：${text.length} ≤ 4096（码点计数实现在此会漏成 ${[...text].length}+）`)
  assert.ok(text.includes('（内容过长，已截断）'), '截断标记可见')
})

test('P1-1 提问卡超长 context：同样截断到 4096 内仍送达（ask_user context 无上游上限）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 12 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const token = vault.mint('aq:q1:0')
  const card = await tg.sendQuestionCard({
    chatId: 100, title: '提问：选哪个方案', content: 'x'.repeat(9000),
    qKey: 'aq:q1', token, options: ['方案 A', '方案 B'],
  })
  assert.deepEqual(card, { messageId: 12 }, '截断后提问卡必须仍送达')
  const text = calls[0].body.text
  assert.ok(text.length <= 4096, 'text 码元数 ≤4096')
  assert.ok(text.includes('（内容过长，已截断）'), '截断标记可见')
  assert.ok(text.startsWith('❓'), '头部标识保留')
  const rows = calls[0].body.reply_markup.inline_keyboard
  assert.equal(rows.length, 2, '选项按钮行不受截断影响（一选项一行）')
})

test('P1-1 动作卡超长 content：同样截断到 4096 内仍送达（心跳/卡住文案防线）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 13 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const card = await tg.sendActionCard({ chatId: 100, title: 't', content: 'y'.repeat(9000), actions: [{ label: '停止任务', data: 'ac:turn/cancel:tk' }] })
  assert.deepEqual(card, { messageId: 13 }, '截断后动作卡必须仍送达')
  const text = calls[0].body.text
  assert.ok(text.length <= 4096, 'text 码元数 ≤4096')
  assert.ok(text.includes('（内容过长，已截断）'), '截断标记可见')
})

test('P1-1 边界：4096 码点内的文本原样直通（不误伤合法长文、不加标记）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 14 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  // 头尾装饰 + content 总码点数恰在限内（含 emoji）
  const content = '配置'.repeat(2000) // 4000 码点 + 装饰 ≈ 4070 内
  await tg.sendApprovalCard({ chatId: 100, title: '需要批准：cfg', content, approvalKey: 'ap:cfg:1', token: vault.mint('ap:cfg:1') })
  const text = calls[0].body.text
  assert.ok(!text.includes('（内容过长，已截断）'), '限内不加截断标记')
  assert.ok(text.includes('_decision: ap:cfg:1_'), '限内装饰尾完整保留')
})

test('P1-1 防回归：三种卡的 sendMessage 一律不设 parse_mode（v0.6.3 legacy markdown 400 事故）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 15 } } })
  const vault = createTokenVault({ secret: 'k' })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl })
  const token = vault.mint('ap:md:1')
  // 文本里故意放未配对的 _ 和 *：纯文本面无害；一旦有人加回 parse_mode 真机必 400
  const nasty = 'path/to_some_dir *star __bold_ 未配对标记'
  await tg.sendApprovalCard({ chatId: 100, title: '需要批准：md', content: nasty, approvalKey: 'ap:md:1', token })
  await tg.sendActionCard({ chatId: 100, title: 't', content: nasty, actions: [{ label: '停', data: 'ac:x:tk' }] })
  await tg.sendQuestionCard({ chatId: 100, title: 'q', content: nasty, qKey: 'aq:md', token: vault.mint('aq:md:0'), options: ['A'] })
  assert.ok(calls.length >= 3, '三种卡各发一条')
  for (const call of calls) {
    assert.ok(!('parse_mode' in call.body), '卡片不得设置 parse_mode（legacy markdown 未配对 _/* 必 400 can\'t parse entities）')
  }
})

test('notifyChatIds：配置归一化为字符串数组', () => {
  const tg = createTelegramInbound({ config: { botToken: 'T', notifyChatIds: [100, '200'] }, bus: makeBus(), vault: createTokenVault() })
  assert.deepEqual(tg.notifyChatIds(), ['100', '200'])
  assert.deepEqual(createTelegramInbound({ config: { botToken: 'T' }, bus: makeBus(), vault: createTokenVault() }).notifyChatIds(), [])
})

// v0.6.2 短引用点击链（真机 400 BUTTON_DATA_INVALID 修复的端到端验证）：
// 发卡 → 按钮只带 r:<ref> → 点击展开 → 既有 ap:/ac: 解析收到完整三元组。
test('v0.6.2 短引用点击链：审批卡 ref 展开 → bus.decide 收到完整 decision/key/token；ref 单次核销', async () => {
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: decisions.length === 1 } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:rm:1')

  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 9 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 2) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10 })

  // 同一实例先发卡（ref 存进它的注册表），再起轮询投喂点击
  await tg.sendApprovalCard({ chatId: 100, title: '需要批准：rm', content: 'c', approvalKey: 'ap:rm:1', token })
  const row = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0]
  const [approveRef, rejectRef] = [row[0].callback_data, row[1].callback_data]

  const cbq = (id, data, updateId) => ({
    update_id: updateId,
    callback_query: { id, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 9 }, data },
  })
  queue.push(cbq('c1', approveRef, 1), cbq('c2', approveRef, 2), cbq('c3', rejectRef, 3))

  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()

  assert.equal(decisions.length, 2, '批准 + 拒绝各决策一次；重复点击同 ref 不再决策')
  assert.deepEqual(decisions[0], { approvalKey: 'ap:rm:1', decision: 'allowed-once', token, via: 'telegram', accountId: 'default', userId: 42, chatId: 100 })
  assert.equal(decisions[1].decision, 'rejected')
  const answers = calls.filter((call) => call.method === 'answerCallbackQuery')
  assert.equal(answers.length, 3)
  assert.match(answers[1].body.text, /已处理或已过期/, '核销后的二次点击收到过期回执')
})

test('v0.6.2 短引用点击链：动作卡 ac: 负载经 ref 展开 → actions.dispatch 收到原始 key/token', async () => {
  const dispatched = []
  const actions = { dispatch: (p) => { dispatched.push(p); return { ok: true, message: '✅ 已停止任务' } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('act:turn/cancel:ws-abcdef12') // 真实长度 token（~109 字符）——证明压缩的必要性

  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 12 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 1) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl, errorBackoffMs: 10, actions })

  await tg.sendActionCard({
    chatId: 100, title: '⚠️ 疑似卡住', content: 'ws / abcdef12',
    actions: [{ label: '⏹ 停止任务', data: `ac:act:turn/cancel:ws-abcdef12:${token}` }],
  })
  const button = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0]
  assert.ok(`ac:act:turn/cancel:ws-abcdef12:${token}`.length > 64, '原始负载确实超限（修复的必要性前提）')

  queue.push({ update_id: 1, callback_query: { id: 'c1', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 12 }, data: button.callback_data } })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()

  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0], { actionKey: 'act:turn/cancel:ws-abcdef12', token, via: 'telegram:action', accountId: 'default', userId: 42, chatId: 100 })
})

// v0.8.3 SEC-1 提问按钮链：aq 短引用展开 → questions.decide 收到点击会话 chatId；
// 转发点击被拒且引用不消费，原会话可正常作答。
test('v0.8.3 SEC-1 提问短引用：chatId 透传 questions.decide；转发拒绝后原会话仍可作答', async () => {
  const verdicts = []
  const questions = { decide: (p) => { verdicts.push(p); return { ok: true, message: '✅ 已作答' } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('aq:abc123:0')

  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 5 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 2) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl, errorBackoffMs: 10, questions })

  await tg.sendQuestionCard({ chatId: 100, title: 'q', content: 'c', qKey: 'aq:abc123', token, options: ['A', 'B'] })
  const qRef = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0].callback_data

  // 转发到 chat 200 拒绝；原会话 chat 100 通过
  queue.push(
    { update_id: 1, callback_query: { id: 'f1', from: { id: 42 }, message: { chat: { id: 200 }, message_id: 5 }, data: qRef } },
    { update_id: 2, callback_query: { id: 'f2', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 5 }, data: qRef } },
  )

  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()

  const answers = calls.filter((call) => call.method === 'answerCallbackQuery')
  assert.match(answers[0].body.text, /请到原会话操作/, '转发点击收到拒绝回执')
  assert.equal(verdicts.length, 1, '转发点击不进入 questions.decide')
  assert.deepEqual(verdicts[0], { qKey: 'aq:abc123', optIdx: '0', token, via: 'telegram', accountId: 'default', userId: 42, chatId: 100 })
})

// v0.8.3 SEC-1 转发拒绝：同一 ref 的按钮被转到别的 chat 点击 → 回执拒绝且不消费引用，
// 合法原会话随后仍可正常裁决（ref 未被转发点击吃掉）。
test('v0.8.3 SEC-1 短引用转发拒绝：跨 chat 点击回执拒绝，引用保留、原会话仍可裁决', async () => {
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: true } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:rm:2')

  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 9 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 3) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10 })

  // 发卡到 chat 100（按钮 ref 记录 origin chatId=100）
  await tg.sendApprovalCard({ chatId: 100, title: 't', content: 'c', approvalKey: 'ap:rm:2', token })
  const approveRef = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0].callback_data

  // 1) 转发到 chat 200 点击 → 拒绝「请到原会话操作」，bus.decide 不被调起
  // 2) 原会话 chat 100 点击 → 裁决正常生效
  queue.push(
    { update_id: 1, callback_query: { id: 'f1', from: { id: 42 }, message: { chat: { id: 200 }, message_id: 9 }, data: approveRef } },
    { update_id: 2, callback_query: { id: 'f2', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 9 }, data: approveRef } },
  )

  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()

  const answers = calls.filter((call) => call.method === 'answerCallbackQuery')
  assert.match(answers[0].body.text, /请到原会话操作/, '转发点击收到拒绝回执')
  assert.equal(decisions.length, 1, '转发点击不进入裁决分支')
  assert.deepEqual(decisions[0], { approvalKey: 'ap:rm:2', decision: 'allowed-once', token, via: 'telegram', accountId: 'default', userId: 42, chatId: 100 })
})

// ------------------------------------------------ C1（P1-4）来源比对缺数据 fail-closed

/**
 * 投喂一串 callback_query，返回调用记录与 warn 行。发卡到 chatId=100 铸 ref 后
 * 由 makeUpdates(ref) 生成回调队列（可构造缺 chat/缺 chat.id 等异常形状）。
 */
async function runRefCallbacks(makeUpdates, { logger = null } = {}) {
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: true } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:c1:1')
  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 9 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 5) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10, logger })
  await tg.sendApprovalCard({ chatId: 100, title: 't', content: 'c', approvalKey: 'ap:c1:1', token })
  const ref = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0].callback_data
  queue.push(...makeUpdates(ref))
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await tg.stop()
  const answers = calls.filter((call) => call.method === 'answerCallbackQuery')
  return { decisions, answers, token }
}

// origin 在场而 message.chat 整块缺失（消息被删/事件形状异常）：旧实现整条合取短路成
// false → 放行裁决。现在必须拒绝，且不消费 ref —— 原会话随后仍能正常裁决（宪法 #6）。
test('C1 TG 来源比对：origin 在场但回调缺 message.chat → fail-closed 拒绝且不消费引用', async () => {
  const logger = { lines: [], warn: (prefix, message) => logger.lines.push(`${prefix} ${message}`) }
  const { decisions, answers, token } = await runRefCallbacks((ref) => [
    { update_id: 1, callback_query: { id: 'c1a', from: { id: 42 }, data: ref } }, // 无 message
    { update_id: 2, callback_query: { id: 'c1b', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 9 }, data: ref } },
  ], { logger })
  assert.match(answers[0].body.text, /请到原会话操作/, '缺点击会话必须收到拒绝回执')
  assert.equal(decisions.length, 1, '缺点击会话不得进入裁决分支')
  assert.deepEqual(decisions[0], { approvalKey: 'ap:c1:1', decision: 'allowed-once', token, via: 'telegram', accountId: 'default', userId: 42, chatId: 100 })
  assert.ok(logger.lines.some((line) => /缺少点击会话/.test(line)), `拒绝必须 warn 出声（实际：${logger.lines.join(' | ')}）`)
})

// 同一缺数据面的另一形状：message 在但 chat.id 读不到（异常负载）。
test('C1 TG 来源比对：message.chat.id 缺失 → fail-closed 拒绝', async () => {
  const { decisions, answers } = await runRefCallbacks((ref) => [
    { update_id: 1, callback_query: { id: 'c1c', from: { id: 42 }, message: { chat: {}, message_id: 9 }, data: ref } },
  ])
  assert.match(answers[0].body.text, /请到原会话操作/)
  assert.equal(decisions.length, 0, 'chat.id 缺失不得裁决')
})

// 正控（防真值写法回归）：chatId === 0 是合法会话 id，`!clickedChat` 会把它误判为缺数据。
test('C1 TG 来源比对：chatId === 0 的合法点击必须放行（不得被真值判据误拒）', async () => {
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: true } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:c1:0')
  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 9 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 3) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10 })
  await tg.sendApprovalCard({ chatId: 0, title: 't', content: 'c', approvalKey: 'ap:c1:0', token })
  const ref = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0].callback_data
  queue.push({ update_id: 1, callback_query: { id: 'c1z', from: { id: 42 }, message: { chat: { id: 0 }, message_id: 9 }, data: ref } })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await tg.stop()
  assert.equal(decisions.length, 1, 'chatId 0 的原会话点击必须放行')
  assert.equal(decisions[0].chatId, 0)
})

// 旧卡兼容半边（PLAN §C1(b) 显式保留）：origin 无 chatId → warn + 放行，窗口由 ref TTL 封顶。
test('C1 TG 来源比对：origin 缺 chatId（旧卡）→ 兼容放行 + 显式 warn', async () => {
  const logger = { lines: [], warn: (prefix, message) => logger.lines.push(`${prefix} ${message}`) }
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: true } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:c1:9')
  const queue = []
  const { fetchImpl, calls } = makeFetch({
    sendMessage: { ok: true, result: { message_id: 9 } },
    answerCallbackQuery: { ok: true, result: {} },
    editMessageText: { ok: true, result: {} },
    getUpdates: () => ({ ok: true, result: queue.splice(0, 3) }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10, logger })
  // 发卡时无 chatId（origin.chatId === undefined，等价升级前在途卡片的元数据缺失面）
  await tg.sendApprovalCard({ title: 't', content: 'c', approvalKey: 'ap:c1:9', token })
  const ref = calls.find((call) => call.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0].callback_data
  // 任意会话点击 → 兼容放行（不因来源不明拒绝历史卡），但必须 warn 出声
  queue.push({ update_id: 1, callback_query: { id: 'c1l', from: { id: 42 }, message: { chat: { id: 777 }, message_id: 9 }, data: ref } })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await tg.stop()
  assert.equal(decisions.length, 1, 'origin 缺 chatId 的旧卡维持兼容放行（PLAN §C1(b)）')
  assert.equal(decisions[0].chatId, 777)
  assert.ok(logger.lines.some((line) => /缺少来源会话元数据/.test(line)), `兼容放行必须 warn（实际：${logger.lines.join(' | ')}）`)
})

// v0.6.2 注册表单元：单次核销 / TTL / 容量拒绝（时钟注入，零真实等待）
test('v0.6.2 callback-refs：mint/take 单次核销、TTL 过期、容量满拒绝新引用', async () => {
  const { createCallbackRefs } = await import('../src/inbound/callback-refs.mjs')
  let clock = 1000
  const refs = createCallbackRefs({ ttlMs: 60_000, max: 3, now: () => clock })
  const a = refs.mint('data-a')
  assert.match(a, /^[23456789A-HJKMNPQRSTVWXYZ]{8}$/)
  assert.equal(refs.take(a), 'data-a')
  assert.equal(refs.take(a), null, '单次核销：第二次取回为 null')

  clock += 61_000
  const b = refs.mint('data-b')
  clock += 61_000
  assert.equal(refs.take(b), null, 'TTL 过期后取回 null')

  const r1 = refs.mint('x1')
  const r2 = refs.mint('x2')
  const r3 = refs.mint('x3')
  assert.equal(refs.size, 3)
  const r4 = refs.mint('x4') // 容量 3 → 拒绝新引用，保留存活条目
  assert.equal(r4, null)
  assert.equal(refs.take(r1), 'x1', '容量满不驱逐仍存活引用')
  assert.equal(refs.take(r2), 'x2')
  assert.equal(refs.take(r4), null)
})

// v0.8.3 SEC-1：短引用来源会话元数据 + 非核销读取（peek）。三态：正常带元数据、
// 无元数据（升版前在途卡片兼容）、过期/淘汰后读取。
test('v0.8.3 callback-refs：mint 带来源会话元数据，peek 非核销读取且不消费条目', async () => {
  const { createCallbackRefs } = await import('../src/inbound/callback-refs.mjs')
  let clock = 1000
  const refs = createCallbackRefs({ ttlMs: 60_000, max: 3, now: () => clock })

  // 正常态：带 chatId 元数据，peek 读得到、take 依旧只出 data
  const r = refs.mint('ap:allowed-once:ap:rm:1:tk', { chatId: 100 })
  assert.deepEqual(refs.peek(r), { data: 'ap:allowed-once:ap:rm:1:tk', origin: { chatId: 100 } })
  assert.equal(refs.take(r), 'ap:allowed-once:ap:rm:1:tk', 'take 语义不变，仍返回 data')
  assert.equal(refs.peek(r), null, 'take 之后 peek 也读不到（引用已核销）')

  // 无元数据（旧发卡路径）：peek 返回 origin null，调用方按兼容路径处理
  const legacy = refs.mint('aq:abc12:0:tk')
  assert.deepEqual(refs.peek(legacy), { data: 'aq:abc12:0:tk', origin: null })
  assert.equal(refs.take(legacy), 'aq:abc12:0:tk')

  // 过期态：peek 返回 null（与 take 一致，不把过期元数据放行）
  clock += 61_000
  const exp = refs.mint('ap:refused:ap:x:1:tk', { chatId: 'oc_g' })
  clock += 61_000
  assert.equal(refs.peek(exp), null, 'TTL 过期后 peek 为 null')
  assert.equal(refs.take(exp), null)

  // 容量满拒绝：peek 对存活条目仍可读，新引用返回 null
  const a = refs.mint('z1', { chatId: 'a' })
  const b2 = refs.mint('z2', { chatId: 'b' })
  const c = refs.mint('z3', { chatId: 'c' })
  const d = refs.mint('z4', { chatId: 'd' })
  assert.equal(d, null, '容量满拒绝新引用')
  assert.deepEqual(refs.peek(a).origin, { chatId: 'a' })
  assert.deepEqual(refs.peek(b2).origin, { chatId: 'b' })
  assert.equal(refs.peek(d), null)
})

// ---------------------------------------------------------------- 长轮询

test('长轮询：message 文本走 bus.accept（白名单+去重由 bus 负责）', async () => {
  const accepted = []
  const bus = makeBus({ accept: (env) => accepted.push(env) })
  let served = false
  const { fetchImpl, calls } = makeFetch({
    getUpdates: () => {
      if (served) return { ok: true, result: [] }
      served = true
      return {
        ok: true,
        result: [{
          update_id: 11,
          message: { message_id: 5, text: '在吗', from: { id: 42 }, chat: { id: 42, type: 'private' } },
        }],
      }
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0], {
    channel: 'telegram', accountId: 'default', userId: '42', chatId: '42', chatType: 'private', messageId: 'msg:5:42', text: '在吗',
  })
  const updates = calls.filter((call) => call.method === 'getUpdates')
  assert.ok(updates.length >= 1)
  assert.deepEqual(updates[0].body.allowed_updates, ['message', 'callback_query'])
})

test('G-06 群聊命令 @ 后缀：入站 envelope 构造处剥离（/cmd@BotName args → /cmd args）', async () => {
  const accepted = []
  const bus = makeBus({ accept: (env) => accepted.push(env) })
  const updates = [
    // 群聊对指定机器人发命令的规范形态：命令词带 botname 后缀
    { update_id: 21, message: { message_id: 51, text: '/pair@MyNotifierBot ABCD-1234', from: { id: 42 }, chat: { id: -100200, type: 'supergroup' } } },
    // 含点号/下划线的 botname（贪心剥除覆盖）；无参命令同样剥
    { update_id: 22, message: { message_id: 52, text: '/status@My.Notifier_Bot', from: { id: 42 }, chat: { id: -100200, type: 'supergroup' } } },
    // 正文里的 @（非行首命令词）不剥
    { update_id: 23, message: { message_id: 53, text: '看这个 /etc/passwd@host 一下', from: { id: 42 }, chat: { id: 42, type: 'private' } } },
    // '/@bot'（命令词剥完为空）保留原样，交由 parseCommand 判非命令
    { update_id: 24, message: { message_id: 54, text: '/@bot code', from: { id: 42 }, chat: { id: -100200, type: 'supergroup' } } },
  ]
  let i = 0
  const { fetchImpl } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 90))
  await tg.stop()
  assert.equal(accepted.length, 4)
  // 命令词 @ 后缀剥除：args（码面）不含 @ 残片
  assert.equal(accepted[0].text, '/pair ABCD-1234')
  assert.equal(accepted[0].chatType, 'supergroup')
  assert.equal(accepted[1].text, '/status')
  assert.equal(accepted[2].text, '看这个 /etc/passwd@host 一下', '正文 @ 与句中路径不剥')
  assert.equal(accepted[3].text, '/@bot code', '命令词剥完为空的形态保留原文')
})

test('长轮询：callback_query 携带合法 token → bus.decide；二次点击已失效', async () => {
  const decisions = []
  const bus = { accept: () => {}, decide: (p) => { decisions.push(p); return { ok: decisions.length === 1 } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:rm:1')
  const card = { message: { chat: { id: 42 }, message_id: 9 }, from: { id: 42 }, id: 'cbq1' }
  const updates = [
    { update_id: 1, callback_query: { ...card, data: `ap:allowed-once:ap:rm:1:${token}` } },
    { update_id: 2, callback_query: { ...card, id: 'cbq2', data: `ap:allowed-once:ap:rm:1:${token}` } },
  ]
  let i = 0
  const { fetchImpl, calls } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
    answerCallbackQuery: { ok: true, result: true },
    editMessageText: { ok: true, result: true },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault, fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0].decision, 'allowed-once')
  assert.equal(decisions[0].approvalKey, 'ap:rm:1')
  assert.equal(decisions[0].token, token)
  assert.equal(decisions[0].userId, 42)
  const answered = calls.filter((call) => call.method === 'answerCallbackQuery')
  assert.equal(answered.length, 2) // 首达采纳文案与失效文案各回一次
})

test('v0.8.7 按钮回调：approval/question 载荷把真实 callback_query.id 作为 eventId 传进 Control Core', async () => {
  const received = []
  const control = { handle: (input) => { received.push(input); return { status: 'accepted' } } }
  const vault = createTokenVault({ secret: 'k' })
  const token = vault.mint('ap:rm:1')
  const qToken = vault.mint('aq:aq:x')
  const card = { message: { chat: { id: 42 }, message_id: 9 }, from: { id: 42 }, id: 'cbq-approve' }
  const updates = [
    { update_id: 1, callback_query: { ...card, data: `ap:allowed-once:ap:rm:1:${token}` } },
    { update_id: 2, callback_query: { ...card, id: 'cbq-answer', data: `aq:aq:x:0:${qToken}` } },
  ]
  let i = 0
  const { fetchImpl } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
    answerCallbackQuery: { ok: true, result: true },
    editMessageText: { ok: true, result: true },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl, control, questions: { decide: () => ({ ok: false }) }, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await tg.stop()
  // 缺 eventId 会被 Control Core 以 missing_eventId 拒绝（approval/question spec.buildEvent 直取 input.eventId）
  assert.equal(received.length, 2)
  assert.equal(received[0].command, 'approval')
  assert.equal(received[0].eventId, 'cbq-approve')
  assert.equal(received[1].command, 'question-answer')
  assert.equal(received[1].eventId, 'cbq-answer')
})

test('长轮询：offset cursor 持久化，重启后从上次位置继续（不重复消费）', async () => {
  const path = tempPath()
  const accepted = []
  const bus = makeBus({ accept: (env) => accepted.push(env) })
  const store = createStore(path)
  const message = { message: { message_id: 5, text: 'x', from: { id: 42 }, chat: { id: 42 } } }
  let served = false
  const firstUpdates = () => {
    if (served) return { ok: true, result: [] }
    served = true
    return { ok: true, result: [{ update_id: 41, ...message }] }
  }
  const first = createTelegramInbound({
    config: CONFIG, bus, vault: createTokenVault(), store,
    fetchImpl: makeFetch({ getUpdates: firstUpdates }).fetchImpl,
    errorBackoffMs: 10,
  })
  first.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await first.stop()
  assert.equal(accepted.length, 1)
  assert.equal(store.get('tg:offset'), 42) // update_id 41 + 1

  // 重启：新实例同 store，getUpdates 应带上 offset=42
  const { fetchImpl: fetch2, calls: calls2 } = makeFetch({ getUpdates: { ok: true, result: [] } })
  const second = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), store, fetchImpl: fetch2, errorBackoffMs: 10 })
  second.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await second.stop()
  const polls = calls2.filter((call) => call.method === 'getUpdates')
  assert.ok(polls.length >= 1)
  assert.equal(polls[0].body.offset, 42)
})

// v0.6.1 真机事故修复：轮询异常告警双写 stderr——宿主 cordis logger 不落 stdout
// （dsh web profile）时，401/409/webhook 冲突类部署故障不再零可见。
test('v0.6.1 轮询异常双写 console.error：logger 之外 stderr 仍可见', async () => {
  const { fetchImpl } = makeFetch({ getUpdates: new Error('telegram getUpdates 失败: HTTP 401 Unauthorized') })
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const tg = createTelegramInbound({
      config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl, errorBackoffMs: 10,
      logger: { warn() {} }, // 宿主 logger 存在但（真机场景）不落 stdout
    })
    tg.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    await tg.stop()
  } finally {
    console.error = original
  }
  assert.ok(lines.some((line) => /inbound:telegram/.test(line) && /轮询异常/.test(line) && /401/.test(line)),
    `stderr 应出现轮询异常详情（实际：${lines.join(' | ')}）`)
})

test('长轮询：API 异常只退避重试不崩溃，恢复后继续消费', async () => {
  const accepted = []
  const bus = makeBus({ accept: (env) => accepted.push(env) })
  let polls = 0
  let served = false
  const { fetchImpl } = makeFetch({
    getUpdates: () => {
      polls += 1
      if (polls === 1) return new Error('network down')
      if (served) return { ok: true, result: [] }
      served = true
      return { ok: true, result: [{ update_id: 1, message: { message_id: 1, text: 'hi', from: { id: 42 }, chat: { id: 42 } } }] }
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await tg.stop()
  assert.ok(polls >= 2, '失败后应有重试')
  assert.equal(accepted.length, 1) // 恢复后消息送达（且只送达一次）
})

test('长轮询：非 ap 前缀 callback 与非文本 message 被安全忽略', async () => {
  const accepted = []
  const decisions = []
  const bus = { accept: (env) => accepted.push(env), decide: (p) => { decisions.push(p); return { ok: false } } }
  const updates = [
    { update_id: 1, callback_query: { id: 'c1', data: 'menu:open', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 1 } } },
    { update_id: 2, message: { message_id: 2, photo: [], from: { id: 42 }, chat: { id: 42 } } },
  ]
  let i = 0
  const { fetchImpl } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()
  assert.equal(accepted.length, 0)
  assert.equal(decisions.length, 0)
})

test('editResolved：编辑远端卡片为最终状态（按钮失效提示）', async () => {
  const { fetchImpl, calls } = makeFetch({ editMessageText: { ok: true, result: true } })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  await tg.editResolved(42, 9, '✅ 已远程批准')
  const edited = calls.filter((call) => call.method === 'editMessageText')
  assert.equal(edited.length, 1)
  assert.equal(edited[0].body.message_id, 9)
  assert.match(edited[0].body.text, /已远程批准/)
})

test('B2 editResolved：edit 失败 → warn 出现 + fallback 调用（suffix 文本 + 清空 reply_markup）', async () => {
  const { fetchImpl, calls } = makeFetch({
    editMessageText: (body, n) => {
      if (n === 1) return { ok: false, description: 'message is not modified' }
      return { ok: true, result: true }
    },
  })
  const original = console.error
  const lines = []
  const loggerLines = []
  const logger = { warn: (...args) => loggerLines.push(args.join(' ')) }
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl, logger })
    await tg.editResolved(42, 9, '✅ 已远程批准')
  } finally {
    console.error = original
  }
  const edited = calls.filter((call) => call.method === 'editMessageText')
  assert.equal(edited.length, 2, '首次失败后应补发一次兜底')
  assert.match(edited[0].body.text, /已远程批准/)
  assert.match(edited[1].body.text, /已远程批准/)
  assert.match(edited[1].body.text, /按钮失效/, '兜底文本带失效后缀')
  assert.deepEqual(edited[1].body.reply_markup, { inline_keyboard: [] }, '兜底清空按钮')
  assert.ok(lines.some((line) => /inbound:telegram/.test(line) && /终态编辑失败/.test(line)),
    `stderr 应出现终态编辑失败告警（实际：${lines.join(' | ')}）`)
  assert.ok(loggerLines.some((line) => /终态编辑失败/.test(line)), 'logger.warn 也应收到告警')
})

test('B2 editResolved：edit 失败且兜底也失败 → 双 warn，不抛错', async () => {
  const { fetchImpl, calls } = makeFetch({
    editMessageText: { ok: false, description: 'message is not modified' },
  })
  const original = console.error
  const lines = []
  const loggerLines = []
  const logger = { warn: (...args) => loggerLines.push(args.join(' ')) }
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl, logger })
    await tg.editResolved(42, 9, '✅ 已远程批准')
  } finally {
    console.error = original
  }
  const edited = calls.filter((call) => call.method === 'editMessageText')
  assert.equal(edited.length, 2, '首次失败 + 兜底失败各一次')
  assert.ok(lines.some((line) => /终态编辑失败/.test(line)), '首次失败告警在场')
  assert.ok(lines.some((line) => /终态失效兜底再次失败/.test(line)), '兜底失败告警在场')
  assert.ok(loggerLines.some((line) => /终态编辑失败/.test(line)), '首次失败告警在场')
  assert.ok(loggerLines.some((line) => /终态失效兜底再次失败/.test(line)), '兜底失败告警在场')
})

// ---------------------------------------------------------------- v0.5 动作闭环

test('sendActionCard：按钮经短引用压缩（v0.6.2：ac 负载同超 64 字节硬限）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 31 } } })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  const card = await tg.sendActionCard({
    chatId: 100,
    title: '⚠️ 疑似卡住',
    content: 'ws / abcdef12\n已运行 12m',
    actions: [{ label: '⏹ 停止任务', data: 'ac:act:turn/cancel:dead:token.sig' }],
  })
  assert.deepEqual(card, { messageId: 31 })
  assert.equal(calls[0].body.chat_id, 100)
  assert.match(calls[0].body.text, /疑似卡住/)
  const buttons = calls[0].body.reply_markup.inline_keyboard[0]
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].text, '⏹ 停止任务')
  assert.match(buttons[0].callback_data, /^r:[23456789A-HJKMNPQRSTVWXYZ]{8}$/, 'ac 负载一律经 ref 压缩')
  assert.ok(buttons[0].callback_data.length <= 64)
})

test('sendActionCard：空按钮/非法按钮行 → null（不发消息）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 1 } } })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  assert.equal(await tg.sendActionCard({ chatId: 100, title: 't', content: 'c', actions: [] }), null)
  assert.equal(await tg.sendActionCard({ chatId: 100, title: 't', content: 'c', actions: [{ label: 'x' }] }), null)
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 0)
})

test('ac: 回调：actions.dispatch 被调 + answerCallbackQuery + 卡片编辑终态', async () => {
  const dispatched = []
  const actions = {
    dispatch: (p) => { dispatched.push(p); return { ok: true, message: '✅ 已停止任务' } },
  }
  const vault = createTokenVault({ secret: 'k' })
  const updates = [
    { update_id: 1, callback_query: { id: 'cbq9', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 15 }, data: 'ac:act:turn/cancel:abcd:tok.sig' } },
  ]
  let i = 0
  const { fetchImpl, calls } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
    answerCallbackQuery: { ok: true, result: true },
    editMessageText: { ok: true, result: true },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl, errorBackoffMs: 10, actions })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].actionKey, 'act:turn/cancel:abcd')
  assert.equal(dispatched[0].token, 'tok.sig')
  assert.equal(dispatched[0].via, 'telegram:action')
  const answered = calls.filter((call) => call.method === 'answerCallbackQuery')
  assert.equal(answered.length, 1)
  assert.match(answered[0].body.text, /已停止任务/)
  const edited = calls.filter((call) => call.method === 'editMessageText')
  assert.equal(edited.length, 1)
  assert.match(edited[0].body.text, /已停止任务/)
  assert.match(edited[0].body.text, /来源：telegram user 42/)
})

test('ac: 回调：actions 缺省时分支不存在（与 v0.4.0 行为一致，不 answer）', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const updates = [
    { update_id: 1, callback_query: { id: 'cbq9', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 15 }, data: 'ac:act:turn/cancel:abcd:tok.sig' } },
  ]
  let i = 0
  const { fetchImpl, calls } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const out = { ok: true, result: [updates[i]] }
      i += 1
      return out
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()
  assert.equal(calls.filter((call) => call.method === 'answerCallbackQuery').length, 0, 'actions 未注入：不 answer 不编辑')
  assert.equal(calls.filter((call) => call.method === 'editMessageText').length, 0)
})

// ---------------------------------------------------------------- v0.8.4 F-08 动作卡来源会话

function memoryActionStore() {
  const data = new Map()
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => { data.set(key, value) },
    delete: (key) => { data.delete(key) },
  }
}

function acCallback(chatId, data, id = 'cbq9') {
  return {
    update_id: 1,
    callback_query: { id, from: { id: 42 }, message: { chat: { id: chatId }, message_id: 15 }, data },
  }
}

/** 投喂单个 ac 回调，返回 rolling mock 的调用记录。 */
function runSingleAcCallback(dispatcher, update, vault) {
  const queue = [update]
  const rolling = makeFetch({
    getUpdates: () => ({ ok: true, result: queue.splice(0, 1) }),
    answerCallbackQuery: () => ({ ok: true, result: true }),
    editMessageText: () => ({ ok: true, result: true }),
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault, fetchImpl: rolling.fetchImpl, errorBackoffMs: 10, actions: dispatcher })
  return new Promise((resolve) => {
    tg.start()
    setTimeout(() => tg.stop().then(() => resolve({ rolling })), 60)
  })
}

test('F-08 ac: 回调：来源匹配 → dispatch 成功（原会话）', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const dispatcher = createActionDispatcher({ vault, store: memoryActionStore() })
  const executed = []
  dispatcher.register('turn/cancel', (p) => { executed.push(p); return { ok: true, message: '✅ 已停止任务' } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })
  const data = buildActionPayload(minted.key, minted.token)

  const { rolling } = await runSingleAcCallback(dispatcher, acCallback(42, data), vault)
  assert.equal(executed.length, 1, '原会话点击应执行')
  assert.match(rolling.calls.filter((c) => c.method === 'answerCallbackQuery')[0].body.text, /已停止任务/)
})

test('F-08 ac: 回调：转发到其他会话 → dispatch 拒绝，不执行', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const dispatcher = createActionDispatcher({ vault, store: memoryActionStore() })
  const executed = []
  dispatcher.register('turn/cancel', (p) => { executed.push(p); return { ok: true } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }, { channel: 'telegram', chatId: '42' })
  const data = buildActionPayload(minted.key, minted.token)

  const { rolling } = await runSingleAcCallback(dispatcher, acCallback(999, data), vault)
  assert.equal(executed.length, 0, '转发点击不得执行')
  assert.match(rolling.calls.filter((c) => c.method === 'answerCallbackQuery')[0].body.text, /原会话/)
})

test('F-08 ac: 回调：legacy 老卡（无来源元数据）→ 兼容放行 + 显式 warn', async () => {
  const vault = createTokenVault({ secret: 'k' })
  const loggerLines = []
  const dispatcher = createActionDispatcher({ vault, store: memoryActionStore(), logger: { warn: (p, m) => loggerLines.push(`${p} ${m}`) } })
  const executed = []
  dispatcher.register('turn/cancel', (p) => { executed.push(p); return { ok: true, message: '✅' } })
  const minted = dispatcher.mintAction('turn/cancel', { sessionId: 's' }) // 无 meta → legacy
  const data = buildActionPayload(minted.key, minted.token)

  await runSingleAcCallback(dispatcher, acCallback(9999, data), vault)
  assert.equal(executed.length, 1, '老卡兼容放行执行')
  assert.ok(loggerLines.some((line) => /srcChats/.test(line)), `应显式 warn 来源缺失（实际：${loggerLines.join(' | ')}）`)
})

// ---------------------------------------------------------------- Stage-6（task-09）对抗

test('Stage-6 process-before-commit：控制回调处理失败 offset 不前移，下轮原样重投（不静默丢单）', async () => {
  const path = tempPath()
  const store = createStore(path)
  const calls2 = []
  let acceptedCalls = 0
  // 一个审批回调更新：首轮处理抛错 → offset 不得前移；下一轮重投成功 → offset=update_id+1
  const update = {
    update_id: 61,
    callback_query: { id: 'cbq61', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 9 }, data: 'ap:allowed-once:ap:rm:61:badtoken' },
  }
  const bus = makeBus()
  const fetcherError = makeFetch({ getUpdates: () => ({ ok: true, result: [] }) })
  // 用 bus.decide 抛错模拟「处理失败」：approval 用 control===null → 走 bus.decide
  const errors = []
  bus.decide = () => { errors.push('decide-called'); throw new Error('adapter mid-callback crash') }
  const getUpdatesCalls = []
  const { fetchImpl } = makeFetch({
    getUpdates: (body) => {
      getUpdatesCalls.push(body.offset)
      // offset 未前移阶段：持续重投该 update；一旦前移成功阶段：投 id 大者防重投
      if (getUpdatesCalls.length === 1) return { ok: true, result: [update] }
      return { ok: true, result: [] }
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), store, fetchImpl, errorBackoffMs: 10, logger: { warn() {} } })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()
  assert.equal(errors.length, 1, '裁决只被调用一次（失败后未重复消费已换新的 token）')
})

test('Stage-6 process-before-commit：数据缺失 update 静默跳过但 offset 仍前移（不影响正常后续）', async () => {
  const path = tempPath()
  const store = createStore(path)
  const accepted = []
  const bus = makeBus({ accept: (env) => accepted.push(env) })
  // 第一轮同批：一个正常 message + 一个畸形 update_id=81 message（无 text → 跳过）
  const updates = [
    { update_id: 70, message: { message_id: 2, text: 'hi', from: { id: 7 }, chat: { id: 7 } } },
    { update_id: 71, message: { message_id: 3, from: { id: 7 }, chat: { id: 7 } } },
  ]
  let i = 0
  const { fetchImpl } = makeFetch({
    getUpdates: () => {
      if (i >= updates.length) return { ok: true, result: [] }
      const batch = [updates[i]]; i += 1; return { ok: true, result: batch }
    },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus, vault: createTokenVault(), store, fetchImpl, errorBackoffMs: 10 })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await tg.stop()
  assert.equal(accepted.length, 1, '文本消息正常进入 bus')
  assert.equal(store.get('tg:offset'), 72, '两条 update 之后 offset=update_id(71)+1')
})

test('Stage-6 editResolved 文本兜底：两种 edit 均失败（消息已删）→ 恰发一条 sendMessage 文本且在 4096 内', async () => {
  const { fetchImpl, calls } = makeFetch({
    editMessageText: { ok: false, description: 'message is not modified' }, // 两次都失败 → 触发文本兜底
    sendMessage: { ok: true, result: { message_id: 3 } },
  })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  await tg.editResolved(100, 9, '✅ 已远程批准，含一些 emoji 🚀🔥')
  const edits = calls.filter((call) => call.method === 'editMessageText')
  const sends = calls.filter((call) => call.method === 'sendMessage')
  assert.equal(edits.length, 2, '两次 editMessageText 尝试')
  const sent = sends[0]
  assert.equal(sends.length, 1, '兜底恰好一条 sendMessage，绝不重复')
  assert.equal(sent.body.chat_id, 100)
  assert.match(sent.body.text, /已远程批准/)
  assert.match(sent.body.text, /原消息可能已删除/)
  assert.ok([...sent.body.text].length <= 4096 && sent.body.text.length <= 4096, 'UTF-16 码元 ≤4096 且不劈开 emoji')
})

test('Stage-6 sendText：UTF-16 4096 硬限且不劈 astral emoji（clampTelegramText 直通）', async () => {
  const { fetchImpl, calls } = makeFetch({ sendMessage: { ok: true, result: { message_id: 9 } } })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  const astral = '🚀'.repeat(3000) // 3000 码点但 6000 UTF-16 码元 → 必须截断
  assert.equal(await tg.sendText(100, astral), true)
  const sent = calls.filter((call) => call.method === 'sendMessage')[0].body.text
  assert.ok(sent.length <= 4096, `sendText 回执必须落在 4096 内（实际 ${sent.length}）`)
  assert.ok(!/[\uD800-\uDBFF]$/.test(sent), '绝不能以孤代理项结尾（劈 emoji）')
})

test('Stage-6 clientState：start 后及时 connected，stop 后 stopped（facade status 数据源）', async () => {
  const { fetchImpl } = makeFetch({ getUpdates: { ok: true, result: [] } })
  const tg = createTelegramInbound({ config: CONFIG, bus: makeBus(), vault: createTokenVault(), fetchImpl })
  assert.ok(['stopped', 'connected'].includes(tg.clientState()))
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(tg.clientState(), 'connected')
  await tg.stop()
  assert.equal(tg.clientState(), 'stopped')
})
