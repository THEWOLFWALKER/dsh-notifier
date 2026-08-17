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
    callback_query: { id, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 9 }, data },
  })
  queue.push(cbq('c1', approveRef, 1), cbq('c2', approveRef, 2), cbq('c3', rejectRef, 3))

  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  await tg.stop()

  assert.equal(decisions.length, 2, '批准 + 拒绝各决策一次；重复点击同 ref 不再决策')
  assert.deepEqual(decisions[0], { approvalKey: 'ap:rm:1', decision: 'allowed-once', token, via: 'telegram', userId: 42 })
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

  queue.push({ update_id: 1, callback_query: { id: 'c1', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 12 }, data: button.callback_data } })
  tg.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await tg.stop()

  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0], { actionKey: 'act:turn/cancel:ws-abcdef12', token, via: 'telegram:action', userId: 42 })
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
