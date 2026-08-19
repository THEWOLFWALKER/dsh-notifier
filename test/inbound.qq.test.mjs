// 阶段 2 测试：inbound/qq-gw（WS 网关协议、事件入站、文本审批通知、重连/恢复、心跳）。
// fetch 与 WebSocket 全 mock，不发真实网络请求。

import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createQqInbound, resolveQqInboundConfig } from '../src/inbound/qq-gw.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

const API = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const INTENT_GROUP_AND_C2C = 1 << 25

// ---------------------------------------------------------------- fakes

/** mock fetch：token / gateway / 消息发送三路由；发送可脚本化失败。 */
function makeFetch({ sendFail = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} })
    if (target === TOKEN_URL) {
      return jsonResponse({ access_token: 'AT_TOKEN', expires_in: 7200 })
    }
    if (target === `${API}/gateway`) {
      return jsonResponse({ url: 'wss://qq-gw.fake' })
    }
    if (/^\/v2\/(users|groups)\/[^/]+\/messages$/.test(new URL(target).pathname)) {
      if (sendFail) return jsonResponse({ code: '11253', message: 'no permission' }, 403)
      return jsonResponse({ id: `msg_${calls.length}` })
    }
    return jsonResponse({}, 404)
  }
  return { fetchImpl, calls }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** mock WebSocket：EventTarget 子集 + serverSend 驱动协议帧。 */
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

/** 全部 inbound 实例登记：afterEach 统一 stop，防断言失败遗留心跳定时器挂住进程。 */
const liveInbounds = []

function makeRig({ allowUsers = ['u_open'], config = {}, fetchOptions = {} } = {}) {
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const bus = createInboundBus({ allowUsers, logger })
  const { fetchImpl, calls } = makeFetch(fetchOptions)
  const inbound = createQqInbound({
    config: {
      appId: 'APP_ID',
      appSecret: 'SECRET',
      notifyUsers: config.notifyUsers ?? ['u_open'],
      notifyGroups: config.notifyGroups ?? [],
      intents: config.intents,
    },
    bus,
    fallbackTargets: config.fallbackTargets ?? [],
    logger,
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    reconnectBaseMs: 2,
    reconnectCapMs: 8,
  })
  liveInbounds.push(inbound)
  return { bus, inbound, calls, lines, fetchImpl }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** 驱动到网关就绪：open → HELLO → IDENTIFY → READY。返回活跃 ws。 */
async function driveReady(rig, { sessionId = 'sess_1' } = {}) {
  rig.inbound.start()
  await tick()
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  ws.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
  await tick()
  ws.serverSend({ op: 0, t: 'READY', s: 2, d: { session_id: sessionId, user: { id: 'BOT' } } })
  await tick()
  return ws
}

beforeEach(() => { FakeWebSocket.instances.length = 0 })

afterEach(async () => {
  await Promise.allSettled(liveInbounds.splice(0).map((inbound) => inbound.stop()))
})

// ---------------------------------------------------------------- 配置解析

test('resolveQqInboundConfig：缺凭证 ok=false 中文指引；归一化 notifyUsers/Groups 与默认 intents', () => {
  const missing = resolveQqInboundConfig({})
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /appId 与 appSecret/)
  assert.equal(resolveQqInboundConfig({ appId: 'a' }).ok, false)

  const ok = resolveQqInboundConfig({
    appId: ' a ', appSecret: ' s ',
    notifyUsers: [' u1 ', ''],
    notifyGroups: ['g1'],
    apiBase: 'https://api.example.com/',
    intents: 1,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.config.appId, 'a')
  assert.equal(ok.config.apiBase, 'https://api.example.com')
  assert.deepEqual(ok.config.notifyUsers, ['u1'])
  assert.deepEqual(ok.config.notifyGroups, ['g1'])
  assert.equal(ok.config.intents, 1)
  assert.equal(resolveQqInboundConfig({ appId: 'a', appSecret: 's' }).config.intents, INTENT_GROUP_AND_C2C)
})

// ---------------------------------------------------------------- 网关握手

test('握手：HELLO 后发 IDENTIFY（QQBot token + intents 1<<25）；READY 记录 session', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  const identify = ws.sent.find((frame) => frame.op === 2)
  assert.ok(identify, '应发送 IDENTIFY')
  assert.equal(identify.d.token, 'QQBot AT_TOKEN')
  assert.equal(identify.d.intents, INTENT_GROUP_AND_C2C)
  assert.deepEqual(identify.d.shard, [0, 1])
  assert.ok(rig.lines.some((line) => line.includes('网关已就绪') && line.includes('sess_1')))
  await rig.inbound.stop()
})

test('心跳：首拍在 READY 前无序号（d=null 合法）；READY 后下一拍携带最后序号', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
  await tick()
  const firstBeat = ws.sent.find((frame) => frame.op === 1)
  assert.ok(firstBeat, 'HELLO 后应立即心跳一次')
  assert.equal(firstBeat.d, null, '首拍在首个事件前，d 为 null（协议允许）')
  ws.serverSend({ op: 11 }) // 正常服务端：每拍必 ACK
  ws.serverSend({ op: 0, t: 'READY', s: 2, d: { session_id: 'sess_1' } })
  await tick(80) // 等下一拍（50ms 间隔）
  const laterBeat = ws.sent.filter((frame) => frame.op === 1).at(-1)
  assert.equal(laterBeat.d, 2, 'READY 后心跳携带最后事件序号')
  await rig.inbound.stop()
})

test('心跳 ACK 超时：上一拍未确认，下一拍判死主动断开重连', async () => {
  const rig = makeRig()
  const inbound = createQqInbound({
    config: { appId: 'a', appSecret: 's', notifyUsers: ['u_open'] },
    bus: rig.bus,
    logger: { warn: () => {} },
    fetchImpl: rig.fetchImpl,
    webSocketImpl: FakeWebSocket,
    reconnectBaseMs: 2,
    reconnectCapMs: 8,
  })
  liveInbounds.push(inbound)
  inbound.start()
  await tick()
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } }) // 从不发 ACK
  await tick()
  ws.serverSend({ op: 0, t: 'READY', s: 2, d: { session_id: 'sess_hb' } })
  await tick()
  const before = FakeWebSocket.instances.length
  await tick(200) // 50ms 间隔：第 2 拍发现第 1 拍未 ACK → 断开 → 退避 2ms 重连
  assert.ok(FakeWebSocket.instances.length > before, 'watchdog 超时应重连')
  await inbound.stop()
})

test('断线重连：close 后带 session RESUME（session_id + seq）', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 7, d: { id: 'e1', content: 'hi', author: { user_openid: 'u_open' } } })
  await tick()
  ws.serverClose() // 服务端断开
  await tick(10)
  const ws2 = FakeWebSocket.instances.at(-1)
  assert.notEqual(ws2, ws, '应建立新连接')
  ws2.serverOpen()
  ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
  await tick()
  const resume = ws2.sent.find((frame) => frame.op === 6)
  assert.ok(resume, '重连后应发 RESUME')
  assert.equal(resume.d.session_id, 'sess_1')
  assert.equal(resume.d.seq, 7)
  assert.equal(resume.d.token, 'QQBot AT_TOKEN')
  await rig.inbound.stop()
})

test('INVALID_SESSION（op9）：丢弃 session，重连走全新 IDENTIFY', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  ws.serverSend({ op: 9, d: false })
  await tick(10)
  const ws2 = FakeWebSocket.instances.at(-1)
  ws2.serverOpen()
  ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
  await tick()
  assert.ok(ws2.sent.some((frame) => frame.op === 2), '应重新 IDENTIFY')
  assert.ok(!ws2.sent.some((frame) => frame.op === 6), '不应 RESUME 已失效会话')
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 事件入站

test('C2C_MESSAGE_CREATE：单聊文本 → bus envelope（chatId=userId）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'evt_1', content: ' 跑一下测试 ', author: { user_openid: 'u_open' } } })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'qq')
  assert.equal(accepted[0].userId, 'u_open')
  assert.equal(accepted[0].chatId, 'u_open')
  assert.equal(accepted[0].messageId, 'evt_1')
  assert.equal(accepted[0].text, '跑一下测试')
  await rig.inbound.stop()
})

test('GROUP_AT_MESSAGE_CREATE：群 @ 消息剥离提及占位；chatId=group_openid', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveReady(rig)
  ws.serverSend({
    op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 4,
    d: { id: 'evt_2', group_openid: 'g_open', content: '<@!BOT123> 帮我跑测试', author: { member_openid: 'u_open' } },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'qq')
  assert.equal(accepted[0].userId, 'u_open')
  assert.equal(accepted[0].chatId, 'g_open')
  assert.equal(accepted[0].text, '帮我跑测试')
  await rig.inbound.stop()
})

test('白名单外/空文本：不入站不抛异常', async () => {
  const rig = makeRig({ allowUsers: ['u_other'] })
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'evt_3', content: 'hi', author: { user_openid: 'u_open' } } })
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 4, d: { id: 'evt_4', content: '   ', author: { user_openid: 'u_other' } } })
  assert.equal(seen, 0)
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 出站能力

test('sendApprovalCard：文本审批通知（无按钮话术）+ msg_seq 递增，返回 messageId', async () => {
  const rig = makeRig()
  await driveReady(rig)
  const card = await rig.inbound.sendApprovalCard({ chatId: 'u_open', title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token: 'tk' })
  assert.equal(typeof card.messageId, 'string')
  const call = rig.calls.find((entry) => entry.url === `${API}/v2/users/u_open/messages`)
  assert.ok(call, '应 POST 单聊消息接口')
  assert.equal(call.headers.authorization, 'QQBot AT_TOKEN')
  assert.equal(call.body.msg_type, 0)
  assert.equal(call.body.msg_seq, 1)
  assert.match(call.body.content, /需要批准：rm/)
  assert.match(call.body.content, /回复 1 批准 \/ 2 拒绝/)
  const again = await rig.inbound.sendApprovalCard({ chatId: 'u_open', title: 't', content: 'c', approvalKey: 'k', token: 't' })
  assert.ok(again !== null)
  assert.equal(rig.calls.at(-1).body.msg_seq, 2, '同目标 msg_seq 递增（服务端按 seq 去重）')
  await rig.inbound.stop()
})

test('目标类型学习：群事件后回执走 /v2/groups/；配置项 notifyGroups 也走群接口', async () => {
  const rig = makeRig({ config: { notifyGroups: ['g_cfg'] } })
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: { id: 'e', group_openid: 'g_learned', content: '<@!1> hi', author: { member_openid: 'u_open' } } })
  await tick()
  assert.equal(await rig.inbound.sendText('g_learned', '群回执'), true)
  assert.ok(rig.calls.some((entry) => entry.url === `${API}/v2/groups/g_learned/messages`), '学习到的群目标应走群接口')
  assert.equal(await rig.inbound.sendText('g_cfg', '配置群'), true)
  assert.ok(rig.calls.some((entry) => entry.url === `${API}/v2/groups/g_cfg/messages`), '配置的群目标应走群接口')
  assert.equal(await rig.inbound.sendText('u_open', '默认用户'), true)
  assert.ok(rig.calls.some((entry) => entry.url === `${API}/v2/users/u_open/messages`), '未知目标默认按单聊')
  await rig.inbound.stop()
})

test('发送失败：sendApprovalCard 返回 null 降级；sendText 返回 false；绝不抛异常', async () => {
  const rig = makeRig({ fetchOptions: { sendFail: true } })
  await driveReady(rig)
  const card = await rig.inbound.sendApprovalCard({ chatId: 'u_open', title: 't', content: 'c', approvalKey: 'k', token: 'tk' })
  assert.equal(card, null)
  assert.equal(await rig.inbound.sendText('u_open', 'x'), false)
  await rig.inbound.stop()
})

test('editResolved：补发审批结果文本（消息不可编辑）；无 chatId 直接跳过', async () => {
  const rig = makeRig()
  await driveReady(rig)
  await rig.inbound.editResolved({ channel: 'qq', chatId: 'u_open', userId: 'u_open', messageId: 'm1' }, '✅ 已远程批准（本次）')
  const call = rig.calls.find((entry) => entry.url === `${API}/v2/users/u_open/messages`)
  assert.ok(call)
  assert.match(call.body.content, /已远程批准/)
  await rig.inbound.editResolved({}, 'x') // 无 chatId：不发送不抛错
  assert.equal(rig.calls.filter((entry) => entry.url.includes('/messages')).length, 1)
  await rig.inbound.stop()
})

test('notifyTargets：notifyUsers + notifyGroups 优先，缺省回落全局白名单；capabilities.buttons=false', async () => {
  const rig = makeRig({ config: { notifyUsers: ['u1', 'u2'], notifyGroups: ['g1'] } })
  assert.deepEqual(rig.inbound.notifyTargets(), [
    { chatId: 'u1', userId: 'u1' },
    { chatId: 'u2', userId: 'u2' },
    { chatId: 'g1', userId: 'g1' },
  ])
  assert.deepEqual(rig.inbound.capabilities, { buttons: false })
  const fallback = makeRig({ config: { notifyUsers: [], notifyGroups: [], fallbackTargets: ['u_global'] } })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'u_global', userId: 'u_global' }])
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 生命周期

test('stop：关闭连接、清定时器，close 不再触发重连；start 幂等', async () => {
  const rig = makeRig()
  rig.inbound.start()
  rig.inbound.start()
  await tick()
  assert.equal(FakeWebSocket.instances.length, 1, '重复 start 只连一次')
  const ws = FakeWebSocket.instances.at(-1)
  ws.serverOpen()
  ws.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
  await tick()
  await rig.inbound.stop()
  assert.equal(ws.readyState, 3)
  const count = FakeWebSocket.instances.length
  await tick(20)
  assert.equal(FakeWebSocket.instances.length, count, 'stop 后 close 不得触发重连')
  await rig.inbound.stop() // 幂等
})

test('启动失败（换 token 失败）：warn 后允许重试', async () => {
  const lines = []
  const bus = createInboundBus({ allowUsers: ['u'], logger: { warn: (p, m) => lines.push(`${p} ${m}`) } })
  const badFetch = async () => jsonResponse({}, 500)
  const inbound = createQqInbound({
    config: { appId: 'a', appSecret: 's', notifyUsers: ['u'] },
    bus,
    logger: { warn: (p, m) => lines.push(`${p} ${m}`) },
    fetchImpl: badFetch,
    webSocketImpl: FakeWebSocket,
    reconnectBaseMs: 2,
  })
  inbound.start()
  await tick()
  assert.ok(lines.some((line) => line.includes('启动失败')))
  await inbound.stop()
})
