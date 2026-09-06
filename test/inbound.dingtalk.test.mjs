// 测试：inbound/dingtalk-stream（gettoken 编码、Stream 网关握手（G-10 ua 字段名）、帧 ack
// （G-01：messageId 仅在 headers、头字段名 messageId、data 为 JSON 字符串 "OK"）、SYSTEM/ping
// 回显与非 ping 子类隔离（G-02）、data 二次 parse 失败可观测（G-42）、richText 归一（G-23）、
// 被动回复 messageId 唯一化（G-24）、msgId 去重、sessionWebhook 被动回复、batchSend 主动推送、
// 熔断联动、token 生命周期、重连退避、stop 幂等、凭证安全）。fetch 与 WebSocket 全 mock，
// 不发真实网络请求。
//
// mock 帧形态对齐 dingtalk-stream 官方 SDK（2.1.4 / 2.1.6-beta.1 / 2.1.7-beta.1）
// dist/client.d.ts 的 DWClientDownStream：{ specVersion, type, headers:{…, messageId, topic},
// data }，顶层无 messageId/path——旧 mock 顶层带 messageId，把错误契约钉成基线，是 G-01
// 三重偏差漏检的直接原因，勿再回退。richText 消息体形态对齐官方《机器人接收消息》文档
// （content.richText 数组：text 段 + downloadCode/type:'picture' 段）；图片段可解析 URL 字段
// 沿用既有 normalizeImageAttachment 白名单（Issue #14 契约）。协议形态均未经真机验证，
// 证据登记 docs/protocol-preflight/dingtalk.md。

import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createDingtalkInbound, resolveDingtalkInboundConfig } from '../src/inbound/dingtalk-stream.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

const API = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'
const GW_URL = `${API}/v1.0/gateway/connections/open`
const WEBHOOK_URL = 'https://oapi.dingtalk.com/robot/sendBySession'
const BATCH_URL = `${API}/v1.0/robot/oToMessages/batchSend`
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
const APP_SECRET = 'SECRET_VALUE'

// ---------------------------------------------------------------- fakes

/** mock fetch：gettoken / 网关 / sessionWebhook / batchSend 四路由；后两者可脚本化队列。 */
function makeFetch(options = {}) {
  const {
    tokenResponse = { errcode: 0, access_token: 'AT_TOKEN', expires_in: 7200 },
    gatewayResponse = { endpoint: 'wss://dt-gw.fake', ticket: 'ticket_1' },
    sessionWebhookResponses = [],
    batchSendResponses = [],
  } = options
  const calls = []
  const shiftFrom = (list) => (list.length > 0 ? list.shift() : null)
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    let body = null
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    calls.push({ url: target, method: init.method ?? 'GET', body, headers: init.headers ?? {} })
    if (target.startsWith(`${OAPI}/gettoken?`)) return jsonResponse(tokenResponse)
    if (target === GW_URL) return jsonResponse(gatewayResponse)
    if (target.startsWith(WEBHOOK_URL)) return jsonResponse(shiftFrom(sessionWebhookResponses) ?? { errcode: 0 })
    if (target.startsWith(BATCH_URL)) {
      return jsonResponse(shiftFrom(batchSendResponses) ?? { processQueryKey: 'pq_ok' })
    }
    return jsonResponse({}, 404)
  }
  return { fetchImpl, calls }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** mock WebSocket：EventTarget 子集 + serverSend 驱动协议帧（帧本身是 JSON 字符串）。 */
class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  removeAllListeners() { this.listeners.clear() }
  emit(type, extra = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, target: this, ...extra })
  }
  serverOpen() { this.readyState = 1; this.emit('open') }
  serverSend(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  serverClose() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.serverClose() }
}

/** 内存 store（store.mjs 同款接口子集；robotCode 学习断言用）。 */
function createMemoryStore(initial = {}) {
  const state = { ...initial }
  return {
    get: (key, fallback = undefined) => (key in state ? state[key] : fallback),
    set: (key, value) => { state[key] = value },
    delete: (key) => delete state[key],
    keys: (prefix = '') => Object.keys(state).filter((k) => k.startsWith(prefix)),
  }
}

/** 全部 inbound 实例登记：afterEach 统一 stop，防断言失败遗留重连定时器挂住进程。 */
const liveInbounds = []

function makeRig({ allowUsers = ['staff_1'], config = {}, fetchOptions = {} } = {}) {
  const lines = []
  const debugLines = []
  const logger = {
    warn: (prefix, message) => lines.push(`${prefix} ${message}`),
    debug: (prefix, message) => debugLines.push(`${prefix} ${message}`),
  }
  const bus = createInboundBus({ allowUsers, logger })
  const store = createMemoryStore()
  const { fetchImpl, calls } = makeFetch(fetchOptions)
  const inbound = createDingtalkInbound({
    config: {
      appKey: config.appKey ?? 'APP_KEY',
      appSecret: config.appSecret ?? APP_SECRET,
      apiBase: API,
      oapiBase: OAPI,
      timeoutMs: 5000,
      notifyUsers: config.notifyUsers ?? ['staff_1'],
    },
    bus,
    store,
    fallbackTargets: config.fallbackTargets ?? [],
    logger,
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    reconnectBaseMs: 2,
    reconnectCapMs: 8,
  })
  liveInbounds.push(inbound)
  return { bus, inbound, calls, lines, debugLines, store }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** 驱动到长连接建立：start → 网关 → new WebSocket → open。返回活跃 ws。 */
async function driveConnected(rig) {
  rig.inbound.start()
  await tick()
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  await tick()
  return ws
}

/**
 * 服务端推一条业务帧（SDK DWClientDownStream 形态）：type:'CALLBACK'，messageId 与 topic
 * 都在 headers，顶层无 messageId。data 为 JSON 字符串（协议要求二次 parse）。
 */
let frameSeq = 0
function pushMessage(overrides = {}) {
  frameSeq += 1
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverSend({
    type: 'CALLBACK',
    specVersion: '1.0',
    headers: {
      appId: 'APP_KEY',
      connectionId: `conn_${frameSeq}`,
      contentType: 'application/json',
      messageId: `srv_${frameSeq}`,
      time: String(Date.now()),
      topic: BOT_TOPIC,
    },
    data: JSON.stringify({
      conversationId: 'cid_1',
      msgId: `msg_${frameSeq}`,
      senderStaffId: 'staff_1',
      senderNick: '张三',
      sessionWebhook: `${WEBHOOK_URL}?session=abc`,
      sessionWebhookExpiredTime: Date.now() + 3600_000,
      robotCode: 'RC_1',
      msgtype: 'text',
      text: { content: ' 帮我跑测试 ' },
      ...overrides,
    }),
  })
  return ws
}

/** 服务端推任意原始帧（SYSTEM/ping、非法 data 等 G-02/G-42 用例）。 */
function pushFrame(frame) {
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverSend(frame)
  return ws
}

beforeEach(() => { FakeWebSocket.instances.length = 0; frameSeq = 0 })

afterEach(async () => {
  await Promise.allSettled(liveInbounds.splice(0).map((inbound) => inbound.stop()))
})

// ---------------------------------------------------------------- 配置解析

test('resolve：手填成功（trim、apiBase/oapiBase 默认与尾斜杠剥离、timeoutMs 夹取）', () => {
  const ok = resolveDingtalkInboundConfig({
    appKey: ' ak ', appSecret: ' sk ',
    apiBase: 'https://api.example.com/',
    oapiBase: 'https://oapi.example.com//',
    timeoutMs: 99999,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.config.appKey, 'ak')
  assert.equal(ok.config.appSecret, 'sk')
  assert.equal(ok.config.apiBase, 'https://api.example.com')
  assert.equal(ok.config.oapiBase, 'https://oapi.example.com')
  assert.equal(ok.config.timeoutMs, 60000)
  const defaults = resolveDingtalkInboundConfig({ appKey: 'k', appSecret: 's' })
  assert.equal(defaults.config.apiBase, 'https://api.dingtalk.com')
  assert.equal(defaults.config.oapiBase, 'https://oapi.dingtalk.com')
  assert.equal(defaults.config.timeoutMs, 10000)
  assert.equal(resolveDingtalkInboundConfig({ appKey: 'k', appSecret: 's', timeoutMs: 1 }).config.timeoutMs, 1000)
})

test('resolve：扫码凭证回退（raw 为空对象时取 credentials 的 appKey/appSecret）', () => {
  const ok = resolveDingtalkInboundConfig({}, { credentials: { appKey: 'CK', appSecret: 'CS', at: 1 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.config.appKey, 'CK')
  assert.equal(ok.config.appSecret, 'CS')
})

test('resolve：config 显式优先（raw appKey 覆盖扫码凭证；缺失字段仍回落凭证）', () => {
  const ok = resolveDingtalkInboundConfig(
    { appKey: 'RAW_KEY' },
    { credentials: { appKey: 'CRED_KEY', appSecret: 'CRED_SECRET' } },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.config.appKey, 'RAW_KEY', 'config 显式配置优先')
  assert.equal(ok.config.appSecret, 'CRED_SECRET', 'raw 缺失的字段回落扫码凭证')
})

test('resolve：双缺 → ok=false 中文 reason（含 channel-login.mjs dingtalk 扫码提示）', () => {
  const missing = resolveDingtalkInboundConfig({})
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /appKey 与 appSecret/)
  assert.match(missing.reason, /缺失/)
  assert.match(missing.reason, /node scripts\/channel-login\.mjs dingtalk/)
  assert.match(missing.reason, /扫码/)
  assert.equal(resolveDingtalkInboundConfig({ appKey: 'k' }).ok, false)
  assert.equal(resolveDingtalkInboundConfig({ appSecret: 's' }).ok, false)
  assert.equal(resolveDingtalkInboundConfig(null, { credentials: { appKey: 'k' } }).ok, false)
})

test('resolve：notifyUsers 归一（trim、滤空、非数组容忍为空）', () => {
  const ok = resolveDingtalkInboundConfig({ appKey: 'k', appSecret: 's', notifyUsers: [' a ', '', 'b', 3] })
  assert.deepEqual(ok.config.notifyUsers, ['a', 'b', '3'])
  assert.deepEqual(resolveDingtalkInboundConfig({ appKey: 'k', appSecret: 's', notifyUsers: 'x' }).config.notifyUsers, [])
  assert.deepEqual(resolveDingtalkInboundConfig({ appKey: 'k', appSecret: 's' }).config.notifyUsers, [])
})

// ---------------------------------------------------------------- 网关与 WS

test('gettoken：GET 查询串按 URLSearchParams 编码（appkey/appsecret 特殊字符可无损回读）', async () => {
  const rig = makeRig({ config: { appKey: 'ak&1 k', appSecret: 'sc#2?' } })
  await driveConnected(rig)
  // token 懒取：网关打开不走 access_token，首次业务 POST 才换 token
  pushMessage({ msgId: 'msg_enc' })
  assert.equal(await rig.inbound.sendText('cid_1', 'hi'), true)
  const tokenCall = rig.calls.find((entry) => entry.url.startsWith(`${OAPI}/gettoken?`))
  assert.ok(tokenCall, '应调用 gettoken')
  assert.equal(tokenCall.method, 'GET')
  const parsed = new URL(tokenCall.url)
  assert.equal(parsed.origin + parsed.pathname, `${OAPI}/gettoken`)
  assert.equal(parsed.searchParams.get('appkey'), 'ak&1 k', '含 & 和空格的 appKey 必须编码传输')
  assert.equal(parsed.searchParams.get('appsecret'), 'sc#2?')
})

test('网关（G-10）：POST body 精确形状（subscriptions + ua 字段名）与双 JSON 头', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const gwCall = rig.calls.find((entry) => entry.url === GW_URL)
  assert.ok(gwCall, '应打开 Stream 网关')
  assert.equal(gwCall.method, 'POST')
  assert.equal(gwCall.headers['Content-Type'], 'application/json')
  assert.equal(gwCall.headers['Accept'], 'application/json')
  // G-10：字段名是 ua（三版 SDK getEndpoint 全系 `ua: this.config.ua`）；
  // 旧 uesrAgent「官方拼写错误照抄」一说经三版源码核对查无实据
  assert.deepEqual(gwCall.body, {
    clientId: 'APP_KEY',
    clientSecret: APP_SECRET,
    subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
    ua: 'dsh-notifier',
  })
  assert.equal(gwCall.body.uesrAgent, undefined, '不得再发送 uesrAgent 拼写错误字段')
})

test('WS URL：endpoint + encodeURIComponent(ticket)（ticket 含 /、&、空格）', async () => {
  const ticket = 'tk/1&a b'
  const rig = makeRig({ fetchOptions: { gatewayResponse: { endpoint: 'wss://dt-gw.fake', ticket } } })
  const ws = await driveConnected(rig)
  assert.equal(ws.url, `wss://dt-gw.fake?ticket=${encodeURIComponent(ticket)}`)
})

test('入站消息：data 二次 parse → bus.accept 形状（channel/userId/chatId/chatType/dt:msgId/trim 文本）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  // v0.7：conversationType 透传为 chatType（'1' 单聊/'2' 群聊，/pair 私聊判定依赖）
  pushMessage({ msgId: 'msg_e1', conversationType: '1', text: { content: ' 跑一下测试 ' } })
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0], {
    channel: 'dingtalk',
    accountId: 'APP_KEY',
    userId: 'staff_1',
    chatId: 'cid_1',
    chatType: '1',
    messageId: 'dt:msg_e1',
    text: '跑一下测试',
  })
})

test('G-06 @ 机器人剥离：行首 @提及 与 命令词 @ 后缀在入站剥净（args 无 @ 残片）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  // 钉钉群消息行首带 '@机器人名 ' 字面提及 → 剥离后命令与正文干净
  pushMessage({ msgId: 'msg_at1', conversationType: '2', text: { content: '@我的机器人 /status 跑一下' } })
  // 行首 @提及 + 命令词 @ 后缀叠加形态
  pushMessage({ msgId: 'msg_at2', conversationType: '2', text: { content: '@机器人 /pair@bot ABCD-1234' } })
  // 正文中间的 @（提及他人）不剥
  pushMessage({ msgId: 'msg_at3', conversationType: '2', text: { content: '帮我看下 @同事 的排期' } })
  // 纯 @提及（无正文）→ 剥完为空，按空消息不投递
  pushMessage({ msgId: 'msg_at4', conversationType: '2', text: { content: '@我的机器人 ' } })
  await tick()
  assert.deepEqual(accepted.map((e) => e.text), [
    '/status 跑一下',
    '/pair ABCD-1234',
    '帮我看下 @同事 的排期',
  ], '行首机器人提及与命令词 @ 后缀剥净，正文 @ 保留，纯提及不投递')
})

test('msgId 去重：服务端重推同 msgId 不二次投递（60s 重推吸收），但每帧仍回 ack', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveConnected(rig)
  pushMessage({ msgId: 'msg_dup', text: { content: 'hi' } })
  pushMessage({ msgId: 'msg_dup', text: { content: 'hi' } })
  pushMessage({ msgId: 'msg_other', text: { content: 'yo' } })
  assert.deepEqual(accepted.map((e) => e.messageId), ['dt:msg_dup', 'dt:msg_other'])
  assert.equal(ws.sent.filter((frame) => frame.data === '"OK"').length, 3, '每条服务端帧都应回执')
})

// ---------------------------------------------------------------- ack 契约（G-01）

test('ack 回帧（G-01）：messageId 仅在 headers 也回执；头字段名 messageId、data 为 JSON 字符串 "OK"', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const ws = pushMessage({ msgId: 'msg_ack' })
  assert.equal(ws.sent.length, 1, '业务帧必须回执（旧实现读顶层 messageId 恒为空 → 从不回执）')
  assert.deepEqual(ws.sent[0], {
    code: 200,
    headers: { contentType: 'application/json', messageId: 'srv_1' },
    data: '"OK"',
  })
  assert.equal(ws.sent[0].headers.requestId, undefined, '回执头字段名是 messageId，不是 requestId')
  assert.equal(ws.sent[0].messageId, undefined, '回执不携带顶层 messageId')
})

test('ack（G-01）：顶层 messageId 是陷阱字段——回执只认 headers.messageId', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const ws = pushFrame({
    type: 'CALLBACK',
    headers: { contentType: 'application/json', messageId: 'srv_real', topic: BOT_TOPIC },
    messageId: 'top_level_trap',
    data: JSON.stringify({ msgId: 'msg_trap', conversationId: 'cid_1', senderStaffId: 'staff_1', text: { content: 'hi' } }),
  })
  assert.deepEqual(ws.sent[0].headers, { contentType: 'application/json', messageId: 'srv_real' })
})

test('ack：headers 无 messageId 的帧不回执（空 messageId 短路，不产半截帧），业务照常处理', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const ws = pushFrame({
    type: 'CALLBACK',
    headers: { contentType: 'application/json', topic: BOT_TOPIC },
    data: JSON.stringify({ msgId: 'msg_nomid', conversationId: 'cid_1', senderStaffId: 'staff_1', text: { content: 'hi' } }),
  })
  assert.equal(ws.sent.length, 0, '无 messageId 不回执')
  assert.equal(accepted.length, 1, 'ack 缺席不影响业务投递')
})

// ---------------------------------------------------------------- SYSTEM 帧（G-02）

test('SYSTEM/ping（G-02，method 形态）：原样回显 headers+data（含 opaque），不进业务分发、不发业务 ack', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const headers = {
    appId: 'APP_KEY',
    connectionId: 'conn_sys',
    contentType: 'application/json',
    messageId: 'sys_ping_1',
    method: 'ping',
  }
  const ws = pushFrame({ type: 'SYSTEM', headers, data: 'opaque-ping-payload' })
  assert.equal(accepted.length, 0, 'SYSTEM ping 不得进业务分发')
  assert.deepEqual(ws.sent, [{ code: 200, headers, data: 'opaque-ping-payload' }], '原样回显 headers 与 data')
})

test('SYSTEM/ping（G-02）：SDK 源码形态 headers.topic 与 event_type 形态同样回显', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  // SDK 三版（2.1.4/2.1.6-beta.1/2.1.7-beta.1）onSystem 均按 headers.topic 分派 SYSTEM 子类
  const topicHeaders = { contentType: 'application/json', messageId: 'sys_ping_topic', topic: 'ping' }
  pushFrame({ type: 'SYSTEM', headers: topicHeaders, data: { opaque: 'topic-form' } })
  const eventHeaders = { contentType: 'application/json', messageId: 'sys_ping_event', event_type: 'ping' }
  const ws = pushFrame({ type: 'SYSTEM', headers: eventHeaders, data: 'event-form' })
  assert.equal(accepted.length, 0)
  assert.deepEqual(ws.sent[0], { code: 200, headers: topicHeaders, data: { opaque: 'topic-form' } })
  assert.deepEqual(ws.sent[1], { code: 200, headers: eventHeaders, data: 'event-form' })
})

test('SYSTEM 非 ping 子类（G-02）：disconnect/KEEPALIVE/REGISTERED 记 debug 后返回，不进业务分发、不回显', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveConnected(rig)
  for (const topic of ['disconnect', 'KEEPALIVE', 'REGISTERED', 'CONNECTED']) {
    pushFrame({
      type: 'SYSTEM',
      headers: { contentType: 'application/json', messageId: `sys_${topic}`, topic },
      data: JSON.stringify({ note: topic }),
    })
  }
  assert.equal(accepted.length, 0, 'SYSTEM 子类不得进业务分发')
  assert.equal(ws.sent.length, 0, '非 ping 的 SYSTEM 子类不回显、不发业务 ack')
  for (const marker of ['disconnect', 'keepalive', 'registered', 'connected']) {
    assert.ok(rig.debugLines.some((line) => line.includes(marker)), `SYSTEM ${marker} 应记 debug 日志`)
  }
})

// ---------------------------------------------------------------- data 二次 parse（G-42）

test('data 非法 JSON（G-42）：warn 可观测（messageId/type/前 64 字符）且不投递；ack 照回', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const ws = pushFrame({
    type: 'CALLBACK',
    headers: { contentType: 'application/json', messageId: 'srv_bad', topic: BOT_TOPIC },
    data: '{not-json',
  })
  assert.equal(accepted.length, 0, '解析失败不得投递')
  assert.deepEqual(ws.sent.map((frame) => frame.data), ['"OK"'], 'ack 已回执——服务端不会重推，丢弃必须可观测')
  const line = rig.lines.find((l) => l.includes('二次 parse 失败') && l.includes('srv_bad'))
  assert.ok(line, 'parse 失败必须 warn（旧实现静默 return 是 G-42）')
  assert.ok(line.includes('srv_bad'), 'warn 含 messageId')
  assert.ok(line.includes('CALLBACK'), 'warn 含 frame.type')
  assert.ok(line.includes('{not-json'), 'warn 含内容前 64 字符')
})

test('data 非法 JSON（G-42）：超长内容预览截断到 64 字符，尾部不进日志', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const payload = `${'A'.repeat(70)}END_MARKER`
  pushFrame({
    type: 'CALLBACK',
    headers: { contentType: 'application/json', messageId: 'srv_long', topic: BOT_TOPIC },
    data: payload,
  })
  assert.equal(accepted.length, 0)
  const line = rig.lines.find((l) => l.includes('二次 parse 失败') && l.includes('srv_long'))
  assert.ok(line, '超长非法 data 同样必须 warn')
  assert.ok(line.includes('A'.repeat(32)), '预览保留前段内容')
  assert.ok(!line.includes('END_MARKER'), '预览截断到 64 字符')
})

// ---------------------------------------------------------------- 图片与 richText（G-23）

test('Issue #14：钉钉 picture 缺 URL 仍静默拒绝，ack 照回', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const ws = pushMessage({ msgId: 'msg_pic', msgtype: 'picture', text: undefined })
  assert.equal(accepted.length, 0)
  assert.ok(ws.sent.some((frame) => frame.data === '"OK"'))
})

test('Issue #14：钉钉混合 text + picture 保留文本和安全图片附件', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  pushMessage({
    msgId: 'msg_mixed_image',
    text: { content: '请看附件' },
    picture: { downloadUrl: 'https://media.example.test/dingtalk.png', width: 1280, height: 720, ignored: 'x' },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '请看附件')
  assert.deepEqual(accepted[0].image, { url: 'https://media.example.test/dingtalk.png', width: 1280, height: 720 })
  assert.equal(accepted[0].ignored, undefined)
})

test('Issue #14：钉钉图片重放和不受信任 sender 仍走原有去重/白名单', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_picture_replay', msgtype: 'picture', text: undefined, picture: { url: 'https://media.example.test/dt.png' } })
  pushMessage({ msgId: 'msg_picture_replay', msgtype: 'picture', text: undefined, picture: { url: 'https://media.example.test/dt.png' } })
  pushMessage({
    msgId: 'msg_picture_untrusted', msgtype: 'picture', text: undefined, senderStaffId: 'staff_untrusted',
    picture: { url: 'https://media.example.test/dt.png' },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].kind, 'image')
  assert.equal(accepted[0].messageId, 'dt:msg_picture_replay')
})

test('richText 混排（G-23）：text 段拼接进 envelope.text，图片段走既有管线入 envelope.image', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  pushMessage({
    msgId: 'msg_rich_mixed',
    msgtype: 'richText',
    text: undefined,
    content: {
      richText: [
        { text: '请看这张图' },
        // 官方《机器人接收消息》文档形态：图片段只有 downloadCode（无直链 URL）→ 既有管线
        // 解析不出安全 URL，fail-closed 丢弃该段（见下一测试）
        { downloadCode: 'mIofN681YE3fxxxxxxxxxxxxJkVBG2vhj4Q9TsmsNCHy0Phdd2tn', type: 'picture' },
        // 可解析 URL 字段（downloadUrl）沿用既有 normalizeImageAttachment 白名单（Issue #14 契约）
        { type: 'picture', downloadUrl: 'https://media.example.test/rich.png', width: 640, height: 480 },
      ],
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '请看这张图')
  assert.deepEqual(accepted[0].image, { url: 'https://media.example.test/rich.png', width: 640, height: 480 })
  assert.equal(accepted[0].kind, undefined, '文本非空时不标 kind:image')
})

test('richText（G-23）：官方 downloadCode-only 图片段 fail-closed 丢弃，文本段照常投递', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  pushMessage({
    msgId: 'msg_rich_dc',
    msgtype: 'richText',
    text: undefined,
    content: {
      richText: [
        { text: '收到一张图 ' },
        { downloadCode: 'mIofN681YE3f/+m+NnxxxxgeqPd7xpJF/9NbOAORDnadz0WbSwWTiYvByBeYDjbg2ecUdno', type: 'picture' },
      ],
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '收到一张图')
  assert.equal(accepted[0].image, undefined, 'downloadCode 换不到安全 URL，不得伪造图片附件')
})

test('richText（G-23）：纯文本多段拼接；纯图降级 [图片消息]（纯文本/纯图行为不变）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  pushMessage({
    msgId: 'msg_rich_text',
    msgtype: 'richText',
    text: undefined,
    content: { richText: [{ text: '订单 ' }, { text: '12345 已创建' }] },
  })
  pushMessage({
    msgId: 'msg_rich_img',
    msgtype: 'richText',
    text: undefined,
    content: { richText: [{ type: 'picture', downloadUrl: 'https://media.example.test/only.png' }] },
  })
  assert.equal(accepted.length, 2)
  assert.equal(accepted[0].text, '订单 12345 已创建')
  assert.equal(accepted[0].image, undefined)
  assert.equal(accepted[1].text, '[图片消息]')
  assert.equal(accepted[1].kind, 'image')
  assert.deepEqual(accepted[1].image, { url: 'https://media.example.test/only.png' })
})

test('robotCode 学习：首条入站消息落 store（dingtalk:robot-code），后续推送携带', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_rc', robotCode: 'RC_9' })
  assert.equal(rig.store.get('dingtalk:robot-code'), 'RC_9')
  assert.equal(await rig.inbound.sendText('staff_7', 'hi'), true)
  const batch = rig.calls.find((entry) => entry.url.startsWith(BATCH_URL))
  assert.ok(batch, '应走 batchSend')
  assert.match(batch.url, /robot_code=RC_9/)
  assert.equal(batch.body[0].chatbotId, 'RC_9')
})

// ---------------------------------------------------------------- 有界内存表（v0.8.7 P1-7，宪法#4）

const MSG_DEDUP_MAX = 1024 // 与 dingtalk-stream.mjs 的常量对齐（改源码上限须同步本值）
const CHAT_STATE_MAX = 1024

test('去重表有界：60s 窗口内涌入 1025 个全新 msgId → 淘汰最旧且 warn 出声，窗口内去重仍生效', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  // 全部落在 60s 重推窗口内：无一条过窗 ⇒ 惰性清扫一条都清不掉，只能靠硬上限收敛
  for (let i = 0; i < MSG_DEDUP_MAX + 1; i += 1) pushMessage({ msgId: `flood_${i}` })
  assert.equal(accepted.length, MSG_DEDUP_MAX + 1, '1025 条新消息全部投递')
  assert.ok(
    rig.lines.some((line) => line.includes('去重表达上限')),
    '淘汰必须可见（宪法#3 静默即事故）',
  )
  // 最旧 msgId 已被淘汰：重推被当成新消息（bus 侧 fifo 上限 512 也早已忘记它）
  pushMessage({ msgId: 'flood_0' })
  assert.equal(accepted.length, MSG_DEDUP_MAX + 2, '被淘汰的 msgId 重推不再被吸收（证明淘汰真发生）')
  // 最新 msgId 仍在表内：60s 重推吸收语义没被上限砍掉
  pushMessage({ msgId: `flood_${MSG_DEDUP_MAX}` })
  assert.equal(accepted.length, MSG_DEDUP_MAX + 2, '窗口内最新 msgId 重推仍被吸收')
})

test('去重表有界：过窗条目优先由惰性清扫回收（不动用淘汰，去重语义零损耗）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const realNow = Date.now
  try {
    let base = realNow()
    Date.now = () => base
    for (let i = 0; i < MSG_DEDUP_MAX; i += 1) pushMessage({ msgId: `old_${i}` })
    base += 60000 // 全表越过 MSG_DEDUP_WINDOW_MS
    pushMessage({ msgId: 'fresh_1' }) // size>1024 未触达，先不清扫
    for (let i = 0; i < 2; i += 1) pushMessage({ msgId: `fresh_pad_${i}` })
  } finally {
    Date.now = realNow
  }
  assert.ok(
    !rig.lines.some((line) => line.includes('去重表达上限')),
    '过窗条目走惰性清扫即可容纳新条目，不该触发淘汰告警',
  )
  assert.equal(accepted.length, MSG_DEDUP_MAX + 3)
})

test('sessionWebhooks 有界：第 1025 个会话挤掉最旧 → 该会话回复回落 batchSend 主动推送', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  for (let i = 0; i < CHAT_STATE_MAX + 1; i += 1) {
    pushMessage({
      msgId: `wh_${i}`,
      conversationId: `chat_${i}`,
      senderStaffId: 'staff_1',
      sessionWebhook: `${WEBHOOK_URL}?session=chat_${i}`,
    })
  }
  assert.ok(
    rig.lines.some((line) => line.includes('会话状态表达上限')),
    'sessionWebhook 淘汰必须 warn（受影响会话回复语义降级，不可静默）',
  )
  // 最旧会话：webhook 已被淘汰 ⇒ 走主动推送兜底（功能不丢，仅路径降级）
  assert.equal(await rig.inbound.sendText('chat_0', '最旧'), true)
  assert.ok(
    !rig.calls.some((entry) => entry.url.includes('session=chat_0')),
    '被淘汰会话不得再命中 sessionWebhook',
  )
  assert.ok(rig.calls.some((entry) => entry.url.startsWith(BATCH_URL)), '应回落 batchSend')
  // 最新会话：webhook 仍在，被动回复照旧
  assert.equal(await rig.inbound.sendText(`chat_${CHAT_STATE_MAX}`, '最新'), true)
  assert.ok(
    rig.calls.some((entry) => entry.url.includes(`session=chat_${CHAT_STATE_MAX}`)),
    '未被淘汰的会话仍走被动回复',
  )
})

test('chatSenders 有界：被淘汰会话的主动推送 staffId 回落 chatId；未淘汰仍用学到的发言人', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  for (let i = 0; i < CHAT_STATE_MAX + 1; i += 1) {
    pushMessage({
      msgId: `cs_${i}`,
      conversationId: `chat_${i}`,
      senderStaffId: 'staff_1',
      sessionWebhookExpiredTime: Date.now() - 1000, // 全部过期 ⇒ 一律走 batchSend，直接观测 staffId
    })
  }
  assert.equal(await rig.inbound.sendText('chat_0', '最旧'), true)
  const oldest = rig.calls.filter((entry) => entry.url.startsWith(BATCH_URL)).at(-1)
  assert.equal(oldest.body[0].staffId, 'chat_0', '发言人被淘汰后回落「chatId 当 staffId」既有路径')
  assert.equal(await rig.inbound.sendText(`chat_${CHAT_STATE_MAX}`, '最新'), true)
  const newest = rig.calls.filter((entry) => entry.url.startsWith(BATCH_URL)).at(-1)
  assert.equal(newest.body[0].staffId, 'staff_1', '未淘汰会话仍用学到的最近发言人')
})

test('sessionWebhooks LRU：活跃会话（中途再发消息）不因「首次学习早」被淘汰', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const learn = (chatId, seq) => pushMessage({
    msgId: `lru_${seq}`,
    conversationId: chatId,
    sessionWebhook: `${WEBHOOK_URL}?session=${chatId}`,
  })
  learn('chat_hot', 'hot1') // 最早学习
  for (let i = 1; i < CHAT_STATE_MAX; i += 1) learn(`chat_${i}`, i) // 表正好填满 1024
  learn('chat_hot', 'hot2') // 活跃触摸：刷新新鲜度，移到最新端
  learn('chat_last', 'last') // 撑破上限 ⇒ 淘汰最旧
  assert.equal(await rig.inbound.sendText('chat_hot', '热键'), true)
  assert.ok(
    rig.calls.some((entry) => entry.url.includes('session=chat_hot')),
    '被触摸过的活跃会话必须存活（首次学习早不是淘汰理由）',
  )
  assert.equal(await rig.inbound.sendText('chat_1', '最旧'), true)
  assert.ok(
    !rig.calls.some((entry) => entry.url.includes('session=chat_1')),
    '淘汰的是未被触摸的最旧会话',
  )
})

// ---------------------------------------------------------------- 回复与推送

test('被动回复：POST sessionWebhook，头带 x-acs-dingtalk-access-token，body msgparam+msgKey', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_wh' })
  assert.equal(await rig.inbound.sendText('cid_1', '收到'), true)
  const call = rig.calls.find((entry) => entry.url.startsWith(WEBHOOK_URL))
  assert.ok(call, '应回 sessionWebhook')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers['content-type'], 'application/json')
  assert.equal(call.headers['x-acs-dingtalk-access-token'], 'AT_TOKEN')
  assert.deepEqual(call.body, { msgparam: JSON.stringify({ content: '收到' }), msgKey: 'sampleText' })
  assert.ok(!rig.calls.some((entry) => entry.url.startsWith(BATCH_URL)), '未过期不应走主动推送')
})

test('被动回复 messageId（G-24）：同会话同内容两次回复 ID 不同（旧 hash6 必碰撞）', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_reply_1' })
  const card = { chatId: 'cid_1', title: '需要批准：部署', content: '同一份内容' }
  const first = await rig.inbound.sendApprovalCard(card)
  const second = await rig.inbound.sendApprovalCard({ ...card })
  assert.ok(first !== null && second !== null, '两次回复都应成功')
  assert.notEqual(first.messageId, second.messageId, '同会话同内容两次回复不得同 ID（G-24）')
  assert.match(first.messageId, /^dt:reply-[0-9a-z]+-[0-9a-z]+$/, 'dt:reply-<ts36>-<seq36> 形态')
  assert.match(second.messageId, /^dt:reply-[0-9a-z]+-[0-9a-z]+$/, 'dt:reply-<ts36>-<seq36> 形态')
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(WEBHOOK_URL)).length, 2, '两次都走 sessionWebhook 被动回复')
})

test('sessionWebhook 过期：不回复、告警，改走 batchSend 兜底（staffId 取最近发言人）', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_exp', sessionWebhookExpiredTime: Date.now() - 1000 })
  assert.equal(await rig.inbound.sendText('cid_1', '兜底'), true)
  assert.ok(!rig.calls.some((entry) => entry.url.startsWith(WEBHOOK_URL)), '过期 webhook 不得被调用')
  const batch = rig.calls.find((entry) => entry.url.startsWith(BATCH_URL))
  assert.ok(batch)
  assert.equal(batch.body[0].staffId, 'staff_1', '会话内最近发言人作为主动推送目标')
  assert.ok(rig.lines.some((line) => line.includes('sessionWebhook 已过期')))
})

test('主动推送：batchSend body 为单元素数组（chatbotId/msgKey/msgParam/staffId）+ robot_code 查询', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_bs', robotCode: 'RC_1' })
  assert.equal(await rig.inbound.sendText('staff_2', '主动推送'), true)
  const batch = rig.calls.find((entry) => entry.url.startsWith(BATCH_URL))
  assert.ok(batch)
  assert.equal(new URL(batch.url).searchParams.get('robot_code'), 'RC_1')
  assert.ok(Array.isArray(batch.body))
  assert.equal(batch.body.length, 1)
  assert.deepEqual(batch.body[0], {
    chatbotId: 'RC_1',
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: '主动推送' }),
    staffId: 'staff_2',
  })
  assert.equal(batch.headers['x-acs-dingtalk-access-token'], 'AT_TOKEN')
})

test('无 robotCode：主动推送失败不抛（card null / sendText false），不发 batchSend 请求', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const card = await rig.inbound.sendApprovalCard({ chatId: 'staff_1', title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token: 'tk' })
  assert.equal(card, null)
  assert.equal(await rig.inbound.sendText('staff_1', 'x'), false)
  assert.ok(!rig.calls.some((entry) => entry.url.startsWith(BATCH_URL)), '未学到 robotCode 前不应请求 batchSend')
  assert.ok(rig.lines.some((line) => line.includes('robotCode')))
})

test('熔断：连续推送失败达阈值后开路，后续推送被短路（不再发 HTTP）', async () => {
  const rig = makeRig({ fetchOptions: { batchSendResponses: Array.from({ length: 12 }, () => ({ errcode: 300001, errmsg: 'send too fast' })) } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_brk', robotCode: 'RC_1' })
  assert.equal(await rig.inbound.sendText('staff_9', '一'), false)
  assert.equal(await rig.inbound.sendText('staff_9', '二'), false)
  assert.equal(await rig.inbound.sendText('staff_9', '三'), false)
  const countAfterTrips = rig.calls.filter((entry) => entry.url.startsWith(BATCH_URL)).length
  assert.equal(countAfterTrips, 6, '3 次失败 ×（首试+token 重试）= 6 次请求')
  assert.equal(await rig.inbound.sendText('staff_9', '四'), false)
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(BATCH_URL)).length, countAfterTrips, '开路期间应短路不再请求')
  assert.ok(rig.lines.some((line) => line.includes('熔断开路')))
})

test('熔断复位：任一入站消息 breaker.reset()，随后推送恢复放行', async () => {
  // 队列精确 6 条：3 次失败尝试 ×（首试 + token 重试）恰好耗尽，复位后走默认成功
  const rig = makeRig({ fetchOptions: { batchSendResponses: Array.from({ length: 6 }, () => ({ errcode: 300001, errmsg: 'send too fast' })) } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_brk2', robotCode: 'RC_1' })
  for (const text of ['一', '二', '三']) assert.equal(await rig.inbound.sendText('staff_9', text), false)
  assert.equal(await rig.inbound.sendText('staff_9', '开路中'), false)
  pushMessage({ msgId: 'msg_reset', conversationId: 'cid_r', robotCode: 'RC_1' }) // 入站复位熔断
  assert.equal(await rig.inbound.sendText('staff_9', '复位后'), true, '复位后应恢复放行（队列耗尽走默认成功）')
})

test('notifyTargets：notifyUsers 优先，缺省回落 fallbackTargets；capabilities.buttons=false', async () => {
  const rig = makeRig({ config: { notifyUsers: ['s1', 's2'], fallbackTargets: ['u_global'] } })
  assert.deepEqual(rig.inbound.notifyTargets(), [{ chatId: 's1', userId: 's1' }, { chatId: 's2', userId: 's2' }])
  assert.deepEqual(rig.inbound.capabilities, { buttons: false })
  const fallback = makeRig({ config: { notifyUsers: [], fallbackTargets: ['u_global'] } })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'u_global', userId: 'u_global' }])
})

// ---------------------------------------------------------------- token 与重连

test('G-29 动态刷新余量：短 TTL 不再「每发必取」，TTL 到点后重取', async () => {
  const rig = makeRig({ fetchOptions: { tokenResponse: { errcode: 0, access_token: 'AT_TOKEN', expires_in: 1 } } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_tk1' })
  assert.equal(await rig.inbound.sendText('cid_1', '一'), true)
  assert.equal(await rig.inbound.sendText('cid_1', '二'), true)
  // TTL=1s 远小于 60s 余量：旧固定余量下缓存永判不新鲜（第二次发送即重取，短 TTL 渠道
  // 每发必打 gettoken）；G-29 动态余量 min(60s, 剩余寿命 20%) 下缓存可用到自然到期。
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(`${OAPI}/gettoken?`)).length, 1,
    '两次发送应共用同一 token（1 次 gettoken）')
  await new Promise((resolve) => setTimeout(resolve, 1100)) // TTL(1s) 到点
  assert.equal(await rig.inbound.sendText('cid_1', '三'), true)
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(`${OAPI}/gettoken?`)).length, 2,
    '过期后的下一次发送应重取 token')
})

test('G-55：gettoken 返回 expires_in=0 → TTL 归一 fail-closed，发送失败且告警可见（不再 || 7200）', async () => {
  const rig = makeRig({ fetchOptions: { tokenResponse: { errcode: 0, access_token: 'AT_TOKEN', expires_in: 0 } } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_tk0' })
  assert.equal(await rig.inbound.sendText('cid_1', '一'), false, '上游损坏不再被默认值掩盖成「活 7200s」')
  assert.ok(rig.lines.some((line) => line.includes('TTL 非法')), '告警必须含 TTL 非法语义')
})

test('errcode!==0：token 作废重取后重试一次成功（不误报失败）', async () => {
  const rig = makeRig({ fetchOptions: { sessionWebhookResponses: [{ errcode: 601, errmsg: 'access token invalid' }, { errcode: 0 }] } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_ec' })
  assert.equal(await rig.inbound.sendText('cid_1', '重试'), true)
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(WEBHOOK_URL)).length, 2, '首次失败 + 重试一次')
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(`${OAPI}/gettoken?`)).length, 2, '作废后重取一次')
  assert.ok(rig.lines.some((line) => line.includes('作废 access_token')))
})

test('onclose 重连：注入短退避后快速重建连接并恢复投递（网关二次打开）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveConnected(rig)
  assert.equal(rig.calls.filter((entry) => entry.url === GW_URL).length, 1)
  ws.serverClose() // 服务端断开（reconnectBaseMs=2 / cap=8，抖动同步收缩）
  await tick(40)
  assert.equal(FakeWebSocket.instances.length, 2, '应建立新连接')
  assert.equal(rig.calls.filter((entry) => entry.url === GW_URL).length, 2, '重连需重开网关换新 ticket')
  const ws2 = FakeWebSocket.instances.at(-1)
  ws2.serverOpen()
  pushMessage({ msgId: 'msg_after', text: { content: '重连后' } })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '重连后')
})

test('stop：幂等、关闭连接、清定时器，close 不再触发重连；start 幂等只连一次', async () => {
  const rig = makeRig()
  rig.inbound.start()
  rig.inbound.start()
  await tick()
  assert.equal(FakeWebSocket.instances.length, 1, '重复 start 只连一次')
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  await tick()
  await rig.inbound.stop()
  await rig.inbound.stop() // 幂等：二次 stop 不抛
  assert.equal(ws.readyState, 3)
  const count = FakeWebSocket.instances.length
  await tick(30)
  assert.equal(FakeWebSocket.instances.length, count, 'stop 后 close 不得触发重连')
})

// ---------------------------------------------------------------- 凭证安全

test('凭证安全：所有错误路径的 reason/warn/异常文案均不含 appSecret 明文', async () => {
  const texts = []
  // resolve 双缺 reason
  texts.push(resolveDingtalkInboundConfig({ appKey: 'k', appSecret: '' }).reason)
  texts.push(resolveDingtalkInboundConfig({ appKey: 'k' }).reason)
  // 网关打开失败 → 启动失败 warn
  const gwRig = makeRig({ fetchOptions: { gatewayResponse: {} } })
  gwRig.inbound.start()
  await tick()
  texts.push(...gwRig.lines)
  // gettoken 失败 + 推送接口 errcode 失败 → warn 链路
  const tkRig = makeRig({
    fetchOptions: {
      tokenResponse: { errcode: 60, errmsg: 'app secret wrong' },
      batchSendResponses: [{ errcode: 300001, errmsg: 'denied' }, { errcode: 300001, errmsg: 'denied' }],
    },
  })
  await driveConnected(tkRig)
  pushMessage({ msgId: 'msg_sec', robotCode: 'RC_1' })
  assert.equal(await tkRig.inbound.sendText('staff_9', 'x'), false)
  const card = await tkRig.inbound.sendApprovalCard({ chatId: 'staff_9', title: 't', content: 'c', approvalKey: 'k', token: 'tk' })
  assert.equal(card, null)
  texts.push(...tkRig.lines)
  for (const text of texts) {
    assert.ok(typeof text === 'string' && text !== '', '错误文案不应为空')
    assert.ok(!text.includes(APP_SECRET), `错误文案泄漏 appSecret: ${text}`)
  }
})
