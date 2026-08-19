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
  assert.deepEqual(decisions[0], { approvalKey: 'ap:rm:1', decision: 'allowed-once', token, via: 'telegram', userId: 42, chatId: 100 })
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
  assert.deepEqual(dispatched[0], { actionKey: 'act:turn/cancel:ws-abcdef12', token, via: 'telegram:action', userId: 42, chatId: 100 })
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
  assert.deepEqual(verdicts[0], { qKey: 'aq:abc123', optIdx: '0', token, via: 'telegram', userId: 42, chatId: 100 })
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
  assert.deepEqual(decisions[0], { approvalKey: 'ap:rm:2', decision: 'allowed-once', token, via: 'telegram', userId: 42, chatId: 100 })
})

// v0.6.2 注册表单元：单次核销 / TTL / 容量 FIFO（时钟注入，零真实等待）
test('v0.6.2 callback-refs：mint/take 单次核销、TTL 过期、容量 FIFO 淘汰', async () => {
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
  const r4 = refs.mint('x4') // 容量 3 → 淘汰最旧
  assert.equal(refs.take(r1), null, '容量满 FIFO 淘汰最旧')
  assert.equal(refs.take(r2), 'x2')
  assert.equal(refs.take(r4), 'x4')
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

  // 容量淘汰：peek 对最旧被淘汰的条目也读不到
  const a = refs.mint('z1', { chatId: 'a' })
  const b2 = refs.mint('z2', { chatId: 'b' })
  const c = refs.mint('z3', { chatId: 'c' })
  const d = refs.mint('z4', { chatId: 'd' }) // 淘汰 a
  assert.equal(refs.peek(a), null, '容量满 FIFO 淘汰后 peek 读不到')
  assert.deepEqual(refs.peek(b2).origin, { chatId: 'b' })
  assert.equal(refs.peek(d).data, 'z4')
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
    channel: 'telegram', userId: '42', chatId: '42', chatType: 'private', messageId: 'msg:5:42', text: '在吗',
  })
  const updates = calls.filter((call) => call.method === 'getUpdates')
  assert.ok(updates.length >= 1)
  assert.deepEqual(updates[0].body.allowed_updates, ['message', 'callback_query'])
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
