// v0.3.1 测试：inbound/dingtalk-stream（gettoken 编码、Stream 网关握手、帧 ack 与二次
// parse、msgId 去重、sessionWebhook 被动回复、batchSend 主动推送、熔断联动、token 生命
// 周期、重连退避、stop 幂等、凭证安全）。fetch 与 WebSocket 全 mock，不发真实网络请求。

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
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
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
  return { bus, inbound, calls, lines, store }
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

/** 服务端推一条业务帧：data 为 JSON 字符串（协议要求二次 parse）。 */
let frameSeq = 0
function pushMessage(overrides = {}) {
  frameSeq += 1
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverSend({
    headers: { contentType: 'application/json' },
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
    path: BOT_TOPIC,
    messageId: `srv_${frameSeq}`,
  })
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

test('网关：POST body 精确形状（subscriptions + uesrAgent 拼写勿改）与双 JSON 头', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const gwCall = rig.calls.find((entry) => entry.url === GW_URL)
  assert.ok(gwCall, '应打开 Stream 网关')
  assert.equal(gwCall.method, 'POST')
  assert.equal(gwCall.headers['Content-Type'], 'application/json')
  assert.equal(gwCall.headers['Accept'], 'application/json')
  assert.deepEqual(gwCall.body, {
    clientId: 'APP_KEY',
    clientSecret: APP_SECRET,
    subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
    uesrAgent: 'dsh-notifier',
  })
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
    userId: 'staff_1',
    chatId: 'cid_1',
    chatType: '1',
    messageId: 'dt:msg_e1',
    text: '跑一下测试',
  })
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
  assert.equal(ws.sent.filter((frame) => frame.data === 'ack').length, 3, '每条服务端帧都应回执')
})

test('ack 回帧：{ code:200, headers:{contentType,requestId}, messageId, data:"ack" }', async () => {
  const rig = makeRig()
  await driveConnected(rig)
  const ws = pushMessage({ msgId: 'msg_ack' })
  assert.deepEqual(ws.sent[0], {
    code: 200,
    headers: { contentType: 'application/json', requestId: 'srv_1' },
    messageId: 'srv_1',
    data: 'ack',
  })
})

test('非 text msgtype（如 picture）：静默忽略不入 bus，ack 照回', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  await driveConnected(rig)
  const ws = pushMessage({ msgId: 'msg_pic', msgtype: 'picture', text: undefined })
  assert.equal(accepted.length, 0)
  assert.ok(ws.sent.some((frame) => frame.data === 'ack'))
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

test('token 到期前 60s 余量：缓存落入刷新窗口即重取（两次回复两次 gettoken）', async () => {
  const rig = makeRig({ fetchOptions: { tokenResponse: { errcode: 0, access_token: 'AT_TOKEN', expires_in: 1 } } })
  await driveConnected(rig)
  pushMessage({ msgId: 'msg_tk1' })
  assert.equal(await rig.inbound.sendText('cid_1', '一'), true)
  assert.equal(await rig.inbound.sendText('cid_1', '二'), true)
  assert.equal(rig.calls.filter((entry) => entry.url.startsWith(`${OAPI}/gettoken?`)).length, 2)
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
