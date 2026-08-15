// 阶段 4 测试：inbound/wechat-ilink + _ilink-api。
// fetch 全 mock（脚本化 getupdates/sendmessage 序列）+ sleep/时钟注入（零等待）。
// 覆盖：配置解析（凭证回落）、头构造、轮询游标持久化与重启续传、入站解析与去重、
// context_token 学习/回显/剥除重试、-14 会话过期善后、-2 歧义分支、熔断联动、分块延迟、契约。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWechatIlinkInbound,
  resolveWechatInboundConfig,
} from '../src/inbound/wechat-ilink.mjs'
import {
  classifyIlinkResponse,
  extractIlinkText,
  isStaleSessionRet,
  ilinkHeaders,
  randomWechatUin,
  createIlinkClient,
} from '../src/inbound/_ilink-api.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'

const BASE = 'https://ilinkai.weixin.qq.com'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-wxh-')), 'state.json')
}

const instantSleep = async () => {}

/** 脚本化 fetch：按 endpoint 队列依次出队（可注入轮转/失败序列）。 */
function makeFetch(script = {}) {
  const calls = []
  const queues = {
    updates: [...(script.updates ?? [])],
    send: [...(script.send ?? [])],
  }
  const fetchImpl = async (url, init = {}) => {
    const endpoint = String(url).replace(`${BASE}/`, '')
    const body = init.body ? JSON.parse(init.body) : null
    const headers = init.headers ?? {}
    calls.push({ endpoint, body, headers, method: init.method ?? 'GET' })
    if (endpoint.startsWith('ilink/bot/getupdates')) {
      const next = queues.updates.shift()
      if (next === undefined) {
        // 队列耗尽：挂起到 abort（模拟 35s 长轮询静默），测试 stop() 时打断
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        })
      }
      return jsonResponse(typeof next === 'function' ? next(body) : next)
    }
    if (endpoint.startsWith('ilink/bot/sendmessage')) {
      const next = queues.send.shift()
      if (next === undefined) return jsonResponse({ ret: 0 })
      return jsonResponse(typeof next === 'function' ? next(body) : next)
    }
    return jsonResponse({ ret: 0 })
  }
  return { fetchImpl, calls }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function makeRig({ allowUsers = ['WX_USER_1'], config = {}, script = {}, credentials = null } = {}) {
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const store = createStore(tempPath())
  if (credentials !== null) store.set('wechat:account', credentials)
  const bus = createInboundBus({ allowUsers, store, logger })
  const resolved = resolveWechatInboundConfig(
    { notifyUsers: [], chunkSize: 2000, ...config },
    { credentials: credentials ?? { accountId: 'BOT_ACC', token: 'BOT_TOKEN' } },
  )
  if (!resolved.ok) throw new Error(`测试配置不可用：${resolved.reason}`)
  const { fetchImpl, calls } = makeFetch(script)
  const inbound = createWechatIlinkInbound({
    config: resolved.config,
    bus,
    store,
    fallbackTargets: config.fallbackTargets ?? [],
    logger,
    fetchImpl,
    sleep: instantSleep,
  })
  return { bus, store, inbound, calls, lines, fetchImpl }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

const textMsg = (overrides = {}) => ({
  from_user_id: 'WX_USER_1',
  message_id: 'M_1',
  context_token: 'CTX_1',
  item_list: [{ type: 1, text_item: { text: '跑一下测试' } }],
  ...overrides,
})

// ---------------------------------------------------------------- _ilink-api 单元

test('ilinkHeaders：Bearer token + X-WECHAT-UIN 每次重生成（防重放）', () => {
  const first = ilinkHeaders('tok')
  const second = ilinkHeaders('tok')
  assert.equal(first.Authorization, 'Bearer tok')
  assert.equal(first.AuthorizationType, 'ilink_bot_token')
  assert.equal(first['iLink-App-Id'], 'bot')
  assert.equal(first['iLink-App-ClientVersion'], '131584', '0x020200')
  assert.notEqual(first['X-WECHAT-UIN'], second['X-WECHAT-UIN'], 'UIN 必须逐请求重生成')
  assert.equal(ilinkHeaders('').Authorization, undefined, '空 token 不带 Authorization')
  assert.match(randomWechatUin(), /^[A-Za-z0-9+/=]+$/)
})

test('isStaleSessionRet：-2 + errmsg "unknown error" 才算 stale；其余 -2 是真限流', () => {
  assert.equal(isStaleSessionRet(-2, 0, 'unknown error'), true)
  assert.equal(isStaleSessionRet(0, -2, 'Unknown Error'), true, '大小写不敏感')
  assert.equal(isStaleSessionRet(-2, 0, 'rate limited'), false)
  assert.equal(isStaleSessionRet(-14, 0, 'xxx'), false, '-14 走专门分支')
  assert.equal(isStaleSessionRet(0, 0, 'unknown error'), false)
})

test('classifyIlinkResponse：ok/-14/伪装 -2/真 -2/其他错误 全矩阵', () => {
  assert.deepEqual(classifyIlinkResponse({ ret: 0 }), { ok: true })
  assert.deepEqual(classifyIlinkResponse({}), { ok: true })
  assert.equal(classifyIlinkResponse({ ret: -14 }).kind, 'session-expired')
  assert.equal(classifyIlinkResponse({ errcode: -14 }).kind, 'session-expired')
  assert.equal(classifyIlinkResponse({ ret: -2, errmsg: 'unknown error' }).kind, 'session-expired')
  assert.equal(classifyIlinkResponse({ ret: -2, errmsg: 'rate limited' }).kind, 'rate-limited')
  assert.equal(classifyIlinkResponse({ errcode: -2 }).kind, 'rate-limited', '无 errmsg 的 -2 按真限流')
  assert.equal(classifyIlinkResponse({ ret: -1, errmsg: 'boom' }).kind, 'error')
})

test('extractIlinkText：type=1 取 text；引用消息拼前缀；空/非文本返回空串', () => {
  assert.equal(extractIlinkText([{ type: 1, text_item: { text: 'hi' } }]), 'hi')
  assert.equal(extractIlinkText([{ type: 2, image_item: {} }]), '')
  assert.equal(extractIlinkText([]), '')
  assert.equal(extractIlinkText(null), '')
  const quoted = extractIlinkText([{
    type: 1,
    text_item: { text: '回复' },
    ref_msg: { title: '原问题', message_item: { type: 1, text_item: { text: '问题内容' } } },
  }])
  assert.equal(quoted, '[引用: 原问题 | 问题内容]\n回复')
})

test('createIlinkClient：POST 自动附 base_info.channel_version=2.2.0；sendmessage 载荷形状', async () => {
  const { fetchImpl, calls } = makeFetch({ send: [{ ret: 0 }] })
  const client = createIlinkClient({ baseUrl: BASE, token: 'T', fetchImpl })
  await client.sendMessage({ to: 'U1', text: '你好', contextToken: 'CTX', clientId: 'cid-1' })
  const call = calls.find((c) => c.endpoint.includes('sendmessage'))
  assert.equal(call.body.base_info.channel_version, '2.2.0')
  assert.equal(call.body.msg.to_user_id, 'U1')
  assert.equal(call.body.msg.client_id, 'cid-1')
  assert.equal(call.body.msg.message_type, 2)
  assert.equal(call.body.msg.message_state, 2)
  assert.deepEqual(call.body.msg.item_list, [{ type: 1, text_item: { text: '你好' } }])
  assert.equal(call.body.msg.context_token, 'CTX')
  assert.equal(call.headers.Authorization, 'Bearer T')
  // 无 contextToken 省略字段（省略 ≠ 空串：服务端语义不同）
  await client.sendMessage({ to: 'U1', text: 'x', clientId: 'cid-2' })
  assert.equal(calls[1].body.msg.context_token, undefined)
})

// ---------------------------------------------------------------- 配置解析

test('resolveWechatInboundConfig：缺凭证中文指引（指向登录 CLI）；credentials 回落优先级', () => {
  const missing = resolveWechatInboundConfig({}, { credentials: null })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /wechat-login\.mjs/)

  const onlyAccount = resolveWechatInboundConfig({ accountId: 'A' }, { credentials: { token: 'T' } })
  assert.equal(onlyAccount.ok, true, '配置与凭证字段互补也算齐')
  assert.equal(onlyAccount.config.accountId, 'A')
  assert.equal(onlyAccount.config.token, 'T')

  const fromCred = resolveWechatInboundConfig({}, { credentials: { accountId: 'CA', token: 'CT', baseUrl: 'https://redirect.example.com/', userId: 'U' } })
  assert.equal(fromCred.ok, true)
  assert.equal(fromCred.config.accountId, 'CA')
  assert.equal(fromCred.config.baseUrl, 'https://redirect.example.com', 'baseurl 去尾斜杠')
  assert.equal(fromCred.config.userId, 'U')

  const explicit = resolveWechatInboundConfig({ accountId: 'X', token: 'Y' }, { credentials: { accountId: 'CA', token: 'CT' } })
  assert.equal(explicit.config.accountId, 'X', '显式配置优先于登录凭证')
})

test('resolveWechatInboundConfig：数值边界夹取（chunkSize/熔断参数/轮询超时）', () => {
  const resolved = resolveWechatInboundConfig({ accountId: 'A', token: 'T' })
  assert.equal(resolved.config.longPollTimeoutMs, 35000)
  assert.equal(resolved.config.chunkSize, 2000)
  assert.equal(resolved.config.sendChunkDelayMs, 2000)
  assert.equal(resolved.config.breakerThreshold, 3)
  assert.equal(resolved.config.breakerWindowMs, 60000)
  assert.equal(resolved.config.breakerOpenMs, 15000)
  const clamped = resolveWechatInboundConfig({ accountId: 'A', token: 'T', chunkSize: 5, breakerThreshold: 99, breakerOpenMs: 0 })
  assert.equal(clamped.config.chunkSize, 10)
  assert.equal(clamped.config.breakerThreshold, 10)
  assert.equal(clamped.config.breakerOpenMs, 0, '显式 0（永不熔断开路）允许')
})

// ---------------------------------------------------------------- 轮询与游标

test('轮询入站：msgs → bus envelope；游标持久化并随请求回传', async () => {
  const rig = makeRig({ script: { updates: [
    { ret: 0, get_updates_buf: 'BUF_1', msgs: [textMsg()] },
    { ret: 0, get_updates_buf: 'BUF_2', msgs: [] },
  ] } })
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick(10)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'wechat')
  assert.equal(accepted[0].userId, 'WX_USER_1')
  assert.equal(accepted[0].chatId, 'WX_USER_1')
  assert.equal(accepted[0].messageId, 'wx:M_1')
  assert.equal(accepted[0].text, '跑一下测试')
  const polls = rig.calls.filter((c) => c.endpoint.includes('getupdates'))
  assert.equal(polls[0].body.get_updates_buf, '', '首轮空游标')
  assert.equal(polls[1].body.get_updates_buf, 'BUF_1', '游标随响应推进')
  assert.equal(rig.store.get('wechat:sync_buf'), 'BUF_2', '游标落盘')
  await rig.inbound.stop()
})

test('游标跨重启续传：新实例同 store 从 BUF_2 起轮（不从头重收）', async () => {
  const first = makeRig({ script: { updates: [{ ret: 0, get_updates_buf: 'BUF_A', msgs: [] }] } })
  first.inbound.start()
  await tick(10)
  await first.inbound.stop()

  const second = makeRig({ script: { updates: [{ ret: 0, get_updates_buf: 'BUF_B', msgs: [] }] } })
  second.store.set('wechat:sync_buf', 'BUF_A') // 模拟同目录 state.json
  const resumed = createWechatIlinkInbound({
    config: resolveWechatInboundConfig({ accountId: 'A', token: 'T' }).config,
    bus: second.bus,
    store: second.store,
    logger: { warn: () => {} },
    fetchImpl: second.fetchImpl,
    sleep: instantSleep,
  })
  resumed.start()
  await tick(10)
  const poll = second.calls.find((c) => c.endpoint.includes('getupdates'))
  assert.equal(poll.body.get_updates_buf, 'BUF_A', '重启后从持久化游标续传')
  await resumed.stop()
})

test('入站自过滤：空 from / 机器人自身 / 非文本消息一律不投 bus', async () => {
  const rig = makeRig({ script: { updates: [
    { ret: 0, msgs: [
      textMsg({ from_user_id: '', message_id: 'X1' }),
      textMsg({ from_user_id: 'BOT_ACC', message_id: 'X2' }),
      textMsg({ message_id: 'X3', item_list: [{ type: 2, image_item: {} }] }),
      textMsg({ message_id: 'X4', item_list: [] }),
    ] },
  ] } })
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  rig.inbound.start()
  await tick(10)
  assert.equal(seen, 0)
  await rig.inbound.stop()
})

test('入站去重：同 message_id 两次投递只过一次；缺 id 时内容指纹兜底', async () => {
  const rig = makeRig({ script: { updates: [
    { ret: 0, msgs: [textMsg({ message_id: 'DUP' }), textMsg({ message_id: 'DUP' })] },
    { ret: 0, msgs: [
      textMsg({ message_id: '', client_id: '' }), // 双缺 → 内容指纹
      textMsg({ message_id: '', client_id: '' }),
    ] },
  ] } })
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick(10)
  assert.equal(accepted.length, 2, 'message_id 去重 1 + 内容指纹去重 1')
  assert.match(accepted[1].messageId, /^wx:WX_USER_1:[0-9a-f]{6}$/)
  await rig.inbound.stop()
})

test('白名单外用户拒收：bus 层拦截', async () => {
  const rig = makeRig({ allowUsers: ['WX_OWNER'], script: { updates: [
    { ret: 0, msgs: [textMsg({ from_user_id: 'WX_STRANGER', message_id: 'S1' })] },
  ] } })
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  rig.inbound.start()
  await tick(10)
  assert.equal(seen, 0)
  await rig.inbound.stop()
})

test('context_token 学习：入站即缓存 wechat:ctx:<uid>（发送回显最新值）', async () => {
  const rig = makeRig({ script: {
    updates: [{ ret: 0, msgs: [textMsg({ context_token: 'CTX_IN_1' })] }],
    send: [{ ret: 0 }],
  } })
  rig.inbound.start()
  await tick(10)
  assert.equal(rig.store.get('wechat:ctx:WX_USER_1'), 'CTX_IN_1')
  assert.equal(await rig.inbound.sendText('WX_USER_1', '回执'), true)
  const sendCall = rig.calls.find((c) => c.endpoint.includes('sendmessage'))
  assert.equal(sendCall.body.msg.context_token, 'CTX_IN_1', '发送回显最新入站 token')
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 轮询容错

test('getupdates 连续失败：<3 快重试，≥3 退避且计数清零（节奏不炸）', async () => {
  const rig = makeRig({ script: { updates: [
    { ret: -1, errmsg: 'boom' },
    { ret: -1, errmsg: 'boom' },
    { ret: 0, get_updates_buf: 'OK', msgs: [] },
  ] } })
  rig.inbound.start()
  await tick(20)
  assert.ok(rig.lines.some((line) => line.includes('getupdates 失败 ret=-1')))
  assert.equal(rig.store.get('wechat:sync_buf'), 'OK', '失败后恢复正常继续推进')
  await rig.inbound.stop()
})

test('getupdates -14：通道停用 + 清 ctx/游标/凭证 + 中文告警指向登录 CLI', async () => {
  const rig = makeRig({ script: { updates: [{ ret: -14, errmsg: 'session expired' }] } })
  rig.inbound.start()
  await tick(10)
  assert.ok(rig.lines.some((line) => line.includes('会话过期')), '必须有中文告警')
  assert.ok(rig.lines.some((line) => line.includes('wechat-login.mjs')), '告警指向登录 CLI')
  assert.equal(rig.store.get('wechat:sync_buf'), undefined, '游标已清')
  assert.equal(rig.store.get('wechat:account'), undefined, '凭证已清')
  assert.equal(await rig.inbound.sendText('WX_USER_1', 'x'), false, '停用后发送失败')
  await rig.inbound.stop()
})

test('网络异常（fetch reject）计失败并续转；stop 打断挂起长轮询不报错', async () => {
  const rig = makeRig({ script: { updates: [
    () => { throw new Error('ECONNRESET') },
    { ret: 0, get_updates_buf: 'R', msgs: [] },
  ] } })
  rig.inbound.start()
  await tick(10)
  assert.ok(rig.lines.some((line) => line.includes('轮询异常')))
  assert.equal(rig.store.get('wechat:sync_buf'), 'R')
  // 队列已耗尽 → 挂起长轮询；stop() 必须能打断并正常返回
  await rig.inbound.stop()
  assert.ok(true, 'stop() 打断挂起轮询未抛异常')
})

// ---------------------------------------------------------------- 发送分支

test('sendText：无 ctx token 时省略 context_token 字段照发', async () => {
  const rig = makeRig({ script: { send: [{ ret: 0 }] } })
  assert.equal(await rig.inbound.sendText('WX_COLD', '主动通知'), true)
  const sendCall = rig.calls.find((c) => c.endpoint.includes('sendmessage'))
  assert.equal(sendCall.body.msg.context_token, undefined)
  await rig.inbound.stop()
})

test('发送 -14：剥 context_token 重试一次（不计熔断），成功即通过', async () => {
  const rig = makeRig({ script: { send: [
    { ret: -14, errmsg: 'session expired' },
    { ret: 0 },
  ] } })
  rig.store.set('wechat:ctx:WX_USER_1', 'CTX_STALE')
  assert.equal(await rig.inbound.sendText('WX_USER_1', '回执'), true)
  const sends = rig.calls.filter((c) => c.endpoint.includes('sendmessage'))
  assert.equal(sends.length, 2, '剥 token 后重试恰好一次')
  assert.equal(sends[0].body.msg.context_token, 'CTX_STALE')
  assert.equal(sends[1].body.msg.context_token, undefined, '重试剥离 token')
  assert.equal(rig.store.get('wechat:ctx:WX_USER_1'), undefined, 'stale token 已清缓存')
  assert.ok(rig.lines.some((line) => line.includes('剥除后重试一次（不计熔断）')))
  await rig.inbound.stop()
})

test('发送伪装 -2（unknown error）：同 -14 处理路径（剥 token 重试）', async () => {
  const rig = makeRig({ script: { send: [
    { ret: -2, errmsg: 'unknown error' },
    { ret: 0 },
  ] } })
  rig.store.set('wechat:ctx:WX_USER_1', 'CTX_STALE2')
  assert.equal(await rig.inbound.sendText('WX_USER_1', '回执'), true)
  assert.equal(rig.calls.filter((c) => c.endpoint.includes('sendmessage')).length, 2)
  await rig.inbound.stop()
})

test('发送真限流 -2：不剥 token、计熔断；阈值 3 次后开路短路', async () => {
  const rig = makeRig({ config: { breakerThreshold: 2 }, script: { send: [
    { ret: -2, errmsg: 'rate limited' },
    { ret: -2, errmsg: 'rate limited' },
    { ret: 0 }, // 第三次 sendText 应被开路短路，不会发出
  ] } })
  assert.equal(await rig.inbound.sendText('WX_USER_1', 'a'), false, '第 1 次限流失败')
  assert.equal(await rig.inbound.sendText('WX_USER_1', 'b'), false, '第 2 次触发开路')
  const sends = rig.calls.filter((c) => c.endpoint.includes('sendmessage'))
  assert.equal(sends.length, 2, '开路后短路，不再发真实请求')
  assert.equal(await rig.inbound.sendText('WX_USER_1', 'c'), false, '开路期间一律失败')
  assert.ok(rig.lines.some((line) => line.includes('熔断开路中')))
  await rig.inbound.stop()
})

test('入站消息复位熔断：开路后收到新消息即解锁，发送恢复', async () => {
  const rig = makeRig({ config: { breakerThreshold: 1 }, script: {
    send: [
      { ret: -2, errmsg: 'rate limited' }, // 触发开路
      { ret: 0 },                          // 复位后的发送
    ],
    updates: [{ ret: 0, msgs: [textMsg({ context_token: 'CTX_NEW', message_id: 'UNLOCK' })] }],
  } })
  assert.equal(await rig.inbound.sendText('WX_USER_1', '被限流'), false)
  rig.inbound.start()
  await tick(10) // 入站消息 → breaker.reset()
  assert.equal(await rig.inbound.sendText('WX_USER_1', '解锁后重发'), true, '入站即解锁')
  await rig.inbound.stop()
})

test('发送其他错误码：直接失败不计熔断（带 errmsg 诊断）', async () => {
  const rig = makeRig({ script: { send: [{ ret: -99, errmsg: 'weird' }] } })
  assert.equal(await rig.inbound.sendText('WX_USER_1', 'x'), false)
  assert.ok(rig.lines.some((line) => line.includes('ret=-99') && line.includes('weird')))
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 分块

test('长文分块：chunkSize=10 切块逐发，块间走 sleep(sendChunkDelayMs)', async () => {
  const sleeps = []
  const rig = makeRig({ config: { chunkSize: 10 }, script: { send: [{ ret: 0 }, { ret: 0 }, { ret: 0 }] } })
  const inbound = createWechatIlinkInbound({
    config: resolveWechatInboundConfig({ accountId: 'A', token: 'T', chunkSize: 10 }).config,
    bus: rig.bus,
    store: rig.store,
    logger: rig.lines,
    fetchImpl: rig.fetchImpl,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(await inbound.sendText('WX_USER_1', '0123456789ABCDEFGHIJ'), true)
  const sends = rig.calls.filter((c) => c.endpoint.includes('sendmessage'))
  assert.deepEqual(sends.map((c) => c.body.msg.item_list[0].text_item.text), ['0123456789', 'ABCDEFGHIJ'])
  assert.equal(sends.every((c) => c.body.msg.client_id.startsWith('dsh-notifier-')), true, 'client_id 防重放前缀')
  assert.deepEqual(sleeps, [2000], '仅块间延迟一次')
  await inbound.stop()
})

test('分块中断：中间块失败即返回 false（已发块不撤回）', async () => {
  const rig = makeRig({ script: { send: [{ ret: 0 }, { ret: -2, errmsg: 'rate limited' }] } })
  const inbound = createWechatIlinkInbound({
    config: resolveWechatInboundConfig({ accountId: 'A', token: 'T', chunkSize: 10 }).config,
    bus: rig.bus,
    store: rig.store,
    logger: { warn: () => {} },
    fetchImpl: rig.fetchImpl,
    sleep: instantSleep,
  })
  assert.equal(await inbound.sendText('WX_USER_1', 'AAAABBBBCCCC'), false)
  assert.equal(rig.calls.filter((c) => c.endpoint.includes('sendmessage')).length, 2)
  await inbound.stop()
})

// ---------------------------------------------------------------- 契约

test('notifyTargets：notifyUsers 优先回落白名单；capabilities.buttons=false', () => {
  const rig = makeRig({ config: { notifyUsers: ['WX_A', 'WX_B'] } })
  assert.deepEqual(rig.inbound.notifyTargets(), [
    { chatId: 'WX_A', userId: 'WX_A' },
    { chatId: 'WX_B', userId: 'WX_B' },
  ])
  const fallback = makeRig({ config: { fallbackTargets: ['WX_GLOBAL'] } })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'WX_GLOBAL', userId: 'WX_GLOBAL' }])
  assert.deepEqual(rig.inbound.capabilities, { buttons: false })
})

test('sendApprovalCard：编号回复话术 + 失败 null 降级', async () => {
  const okRig = makeRig({ script: { send: [{ ret: 0 }] } })
  const card = await okRig.inbound.sendApprovalCard({ chatId: 'WX_USER_1', title: '需要批准：rm', content: '删除文件', approvalKey: 'k', token: 't' })
  assert.ok(card !== null && typeof card.messageId === 'string')
  const sendCall = okRig.calls.find((c) => c.endpoint.includes('sendmessage'))
  assert.match(sendCall.body.msg.item_list[0].text_item.text, /需要批准：rm/)
  assert.match(sendCall.body.msg.item_list[0].text_item.text, /回复 1 批准 \/ 2 拒绝/)
  await okRig.inbound.stop()

  const failRig = makeRig({ script: { send: [{ ret: -1, errmsg: 'x' }] } })
  assert.equal(await failRig.inbound.sendApprovalCard({ chatId: 'WX_USER_1', title: 't', content: 'c' }), null)
  await failRig.inbound.stop()
})

test('editResolved：补发结果回执；无 chatId 跳过不抛', async () => {
  const rig = makeRig({ script: { send: [{ ret: 0 }] } })
  await rig.inbound.editResolved({ channel: 'wechat', chatId: 'WX_USER_1', userId: 'WX_USER_1' }, '✅ 已远程批准')
  const sendCall = rig.calls.find((c) => c.endpoint.includes('sendmessage'))
  assert.match(sendCall.body.msg.item_list[0].text_item.text, /已远程批准/)
  await rig.inbound.editResolved({}, 'x')
  assert.equal(rig.calls.filter((c) => c.endpoint.includes('sendmessage')).length, 1)
  await rig.inbound.stop()
})

test('start/stop 幂等：重复调用无副作用', async () => {
  const rig = makeRig({ script: { updates: [{ ret: 0, msgs: [] }] } })
  rig.inbound.start()
  rig.inbound.start()
  await tick(5)
  await rig.inbound.stop()
  await rig.inbound.stop()
  assert.ok(true, '幂等 start/stop 未抛异常')
})
