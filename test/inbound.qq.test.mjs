// 阶段 2 测试：inbound/qq-gw（WS 网关协议、事件入站、文本审批通知、重连/恢复、心跳）。
// fetch 与 WebSocket 全 mock，不发真实网络请求。

import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createQqInbound, resolveQqInboundConfig } from '../src/inbound/qq-gw.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

const API = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const INTENT_GROUP_AND_C2C = 1 << 25
const INTENT_INTERACTION = 1 << 26 // 按钮化审批：INTERACTION_CREATE 回调（v0.8.4）
const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C | INTENT_INTERACTION

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
  assert.equal(resolveQqInboundConfig({ appId: 'a', appSecret: 's' }).config.intents, DEFAULT_INTENTS)
})

// ---------------------------------------------------------------- 网关握手

test('握手：HELLO 后发 IDENTIFY（QQBot token + 群私聊|按钮互动 intents）；READY 记录 session', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  const identify = ws.sent.find((frame) => frame.op === 2)
  assert.ok(identify, '应发送 IDENTIFY')
  assert.equal(identify.d.token, 'QQBot AT_TOKEN')
  assert.equal(identify.d.intents, DEFAULT_INTENTS)
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

/** 排水所有已入队微任务（mock 定时器下不能等真实超时）。 */
async function flushMacrotask() { await new Promise((resolve) => setImmediate(resolve)) }

test('修复（mnt 批 2）：心跳 ACK 连续丢失计数——单拍只 warn 不断线，连丢 2 拍才判死重连', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws = FakeWebSocket.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } }) // 服务端从此不再 ACK
    await flushMacrotask()
    assert.equal(ws.sent.filter((f) => f.op === 1).length, 1, 'HELLO 后首拍已发且未确认')
    t.mock.timers.tick(50) // 第 2 拍：第 1 拍未确认 → 丢失计数 1
    assert.equal(ws.sent.filter((f) => f.op === 1).length, 1, '单拍丢失不重发（等待确认）')
    assert.ok(rig.lines.some((l) => l.includes('已连续丢失 1/2')), '第一拍丢失必须出声：' + rig.lines.join(' | '))
    const before = FakeWebSocket.instances.length
    t.mock.timers.tick(50) // 第 3 拍：连丢 2 拍 → 判死断开重连
    await flushMacrotask()
    assert.ok(rig.lines.some((l) => l.includes('已连续丢失 2/2') && l.includes('判死')), '判死必须点名丢失计数')
    t.mock.timers.tick(10) // 退避 4ms 重连（reconnectBaseMs=2，首跳 2^1）
    await flushMacrotask()
    assert.ok(FakeWebSocket.instances.length > before, '连续 2 拍未 ACK 应重连（原实现第 2 拍就断）')
  } finally {
    t.mock.timers.reset()
  }
})

test('恢复：单拍丢失后 ACK 及时到达 → 不清零不判死，续发心跳且绝不重连', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws = FakeWebSocket.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    t.mock.timers.tick(50) // 第 2 拍：丢失计数 1
    assert.ok(rig.lines.some((l) => l.includes('已连续丢失 1/2')))
    ws.serverSend({ op: 11 }) // ACK 迟到但到达 → 计数清零
    await flushMacrotask()
    t.mock.timers.tick(50) // 第 3 拍：未在等待 → 正常续发心跳
    await flushMacrotask()
    assert.equal(ws.sent.filter((f) => f.op === 1).length, 2, '恢复后继续正常心跳节奏')
    assert.equal(FakeWebSocket.instances.length, 1, '单拍丢失 + ACK 恢复：绝不重连（抖动不算死）')
  } finally {
    t.mock.timers.reset()
  }
})

test('阈值可配：maxMissedAcks=1 保留「单拍即断」旧语义；0/非法值回落默认 2', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    const inbound = createQqInbound({
      config: { appId: 'a', appSecret: 's', notifyUsers: ['u_open'] },
      bus: rig.bus,
      logger: { warn: (p, m) => rig.lines.push(`${p} ${m}`) },
      fetchImpl: rig.fetchImpl,
      webSocketImpl: FakeWebSocket,
      reconnectBaseMs: 2,
      reconnectCapMs: 8,
      maxMissedAcks: 1, // 显式要求单拍即断
    })
    liveInbounds.push(inbound)
    inbound.start()
    await flushMacrotask()
    const ws = FakeWebSocket.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    const before = FakeWebSocket.instances.length
    t.mock.timers.tick(50) // 第 2 拍：丢失计数 1 == 阈值 → 判死
    await flushMacrotask()
    t.mock.timers.tick(10)
    await flushMacrotask()
    assert.ok(FakeWebSocket.instances.length > before, '阈值 1 时单拍未 ACK 即重连（旧语义可选保留）')

    // 非法值回落默认 2：0 不得被 Number(0)||2 变相改成 1，也不得让阈值越界导致永不断线
    const clamp = createQqInbound({
      config: { appId: 'a', appSecret: 's', notifyUsers: ['u'] },
      bus: rig.bus,
      logger: { warn: (p, m) => rig.lines.push(`${p} ${m}`) },
      fetchImpl: rig.fetchImpl,
      webSocketImpl: FakeWebSocket,
      reconnectBaseMs: 2,
      reconnectCapMs: 8,
      maxMissedAcks: 0,
    })
    liveInbounds.push(clamp)
    clamp.start()
    await flushMacrotask()
    const wsClamp = FakeWebSocket.instances.at(-1)
    wsClamp.serverOpen()
    wsClamp.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    const beforeClamp = FakeWebSocket.instances.length
    t.mock.timers.tick(50) // miss#1：0 回落 2 → 不断线
    await flushMacrotask()
    assert.equal(FakeWebSocket.instances.length, beforeClamp, 'maxMissedAcks=0 回落默认 2：单拍丢失不判死')
    t.mock.timers.tick(50) // miss#2 → 判死重连（非法值不得导致永不断线）
    await flushMacrotask()
    t.mock.timers.tick(10)
    await flushMacrotask()
    assert.ok(FakeWebSocket.instances.length > beforeClamp, '0 回落 2：连丢 2 拍仍判死（阈值钳制只防越界，不压低兜底）')
  } finally {
    t.mock.timers.reset()
  }
})

// --- Issue #15 回归：RESUME 场景下 ACK 连丢、迟到 ACK、stop 清理 ---

test('Issue #15 回归：ACK 连丢后重连走 RESUME（携带原 session_id 与 seq）', async (t) => {
  // 场景：连续 ACK 丢失触发判死重连 → 重连后应发 RESUME 而非 IDENTIFY
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws1 = FakeWebSocket.instances.at(-1)
    ws1.serverOpen()
    ws1.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    ws1.serverSend({ op: 0, t: 'READY', s: 3, d: { session_id: 'sess_issue15' } })
    await flushMacrotask()
    ws1.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 7, d: { id: 'ex', content: 'x', author: { user_openid: 'u_open' } } })
    await flushMacrotask()
    const before = FakeWebSocket.instances.length
    // 连丢 2 拍：第 2 拍 miss 后判死 → 第 3 拍触发
    t.mock.timers.tick(50) // miss=1
    t.mock.timers.tick(50) // miss=2 → 判死 + 调度重连
    await flushMacrotask()
    // 触发重连定时器（reconnectBaseMs=2，首跳 2^1=4ms）
    t.mock.timers.tick(10)
    await flushMacrotask()
    assert.ok(FakeWebSocket.instances.length > before, 'ACK 连丢应触发重连')
    const ws2 = FakeWebSocket.instances.at(-1)
    ws2.serverOpen()
    ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
    await flushMacrotask()
    const resume = ws2.sent.find((f) => f.op === 6)
    assert.ok(resume, 'ACK 连丢重连后应走 RESUME（事件不丢）')
    assert.equal(resume.d.session_id, 'sess_issue15')
    assert.equal(resume.d.seq, 7, 'RESUME 应携带最后事件 seq')
  } finally {
    t.mock.timers.reset()
  }
})

test('Issue #15 回归：迟到 ACK（阈值触发后 ACK 才到）不应阻止重连、也不应污染新会话', async (t) => {
  // 场景：连续丢 ACK 已达到阈值 → 触发重连 → 旧连接的迟到 op11 ACK：
  // 1) 迟到 ACK 不能取消已决策的重连
  // 2) 新连接启动后，心跳计数从零开始（不继承旧会话状态）
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws1 = FakeWebSocket.instances.at(-1)
    ws1.serverOpen()
    ws1.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    ws1.serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess_late' } })
    await flushMacrotask()
    const beforeReconnect = FakeWebSocket.instances.length
    t.mock.timers.tick(50) // miss=1
    t.mock.timers.tick(50) // miss=2 → 判死
    await flushMacrotask()
    // 给旧连接发一个迟到的 ACK
    ws1.serverSend({ op: 11 })
    await flushMacrotask()
    // 触发重连定时器
    t.mock.timers.tick(10)
    await flushMacrotask()
    assert.ok(FakeWebSocket.instances.length > beforeReconnect,
      '迟到 ACK 不应取消已决策的重连')
    // 新连接启动后心跳计数从零开始
    const wsNew = FakeWebSocket.instances.at(-1)
    wsNew.serverOpen()
    wsNew.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    wsNew.serverSend({ op: 0, t: 'RESUMED', s: 7, d: {} })
    await flushMacrotask()
    // 新会话：发 1 拍心跳（无 ACK）→ missedAcks 应为 1，不会判死
    const afterFirstNewBeat = FakeWebSocket.instances.length
    t.mock.timers.tick(50) // 第 1 拍（无 ACK = 1 missed）
    await flushMacrotask()
    assert.equal(FakeWebSocket.instances.length, afterFirstNewBeat,
      '新会话首拍心跳无 ACK 只算 missed=1，不应因旧会话残留直接判死')
  } finally {
    t.mock.timers.reset()
  }
})

test('Issue #15 回归：stop() 清理完整性——重连定时器必须清除、stop 幂等、可重启动', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws1 = FakeWebSocket.instances.at(-1)
    ws1.serverOpen()
    ws1.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
    await flushMacrotask()
    ws1.serverSend({ op: 0, t: 'READY', d: { session_id: 'sess_stop' } })
    await flushMacrotask()
    // 触发一次重连调度（模拟断线后重连定时器已挂上）
    ws1.serverClose()
    await flushMacrotask()
    // 此时 reconnectTimer 已调度（reconnectBaseMs=2）
    const countAtStop = FakeWebSocket.instances.length
    await rig.inbound.stop()
    // stop 后重连定时器应被清除：等远超 base 时间，不应有新连接
    t.mock.timers.tick(1000)
    await flushMacrotask()
    assert.equal(FakeWebSocket.instances.length, countAtStop,
      'stop 后不应有新连接（reconnectTimer 必须被清理）')
    // stop 幂等：再次调用不应抛
    let threw = false
    try { await rig.inbound.stop() } catch { threw = true }
    assert.equal(threw, false, 'stop 应幂等，第二次调用不抛')
    // 重启动能正常工作（stop 彻底清理后 start 不残留状态）
    rig.inbound.start()
    await flushMacrotask()
    const ws2 = FakeWebSocket.instances.at(-1)
    ws2.serverOpen()
    ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
    await flushMacrotask()
    ws2.serverSend({ op: 0, t: 'READY', d: { session_id: 'sess_restart' } })
    await flushMacrotask()
    // restart 后应能完成握手（IDENTIFY 或 RESUME 都可以，取决于是否保留 session）
    const sentOps = ws2.sent.map((f) => f.op)
    assert.ok(sentOps.includes(2) || sentOps.includes(6),
      'stop 后 restart 应能正常发送握手帧（IDENTIFY 或 RESUME），实际: ' + JSON.stringify(sentOps))
    assert.ok(rig.lines.some((l) => l.includes('网关已就绪') && l.includes('sess_restart')),
      'restart 后应能收到 READY 并输出就绪日志')
    await rig.inbound.stop()
  } finally {
    t.mock.timers.reset()
  }
})

test('Issue #15 回归：stop 期间 dispose 顺序——心跳等待 ACK 时 stop 不抛、停后无副作用', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws = FakeWebSocket.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } })
    await flushMacrotask()
    ws.serverSend({ op: 0, t: 'READY', d: { session_id: 'sess_disp' } })
    await flushMacrotask()
    // 发半拍（awaitingAck=true 但还没到下一拍）
    t.mock.timers.tick(25)
    await flushMacrotask()
    // 在心跳等待 ACK 期间 stop —— 应干净完成，不抛
    let threw = false
    try { await rig.inbound.stop() } catch { threw = true }
    assert.equal(threw, false, '心跳等待 ACK 时 stop 不应抛异常')
    // 停止后再推进时间：不应有任何心跳副作用
    const countAfter = FakeWebSocket.instances.length
    t.mock.timers.tick(500)
    await flushMacrotask()
    assert.equal(FakeWebSocket.instances.length, countAfter,
      'stop 后推进时间不应产生新连接（心跳+重连定时器都应清理）')
    await rig.inbound.stop() // 二次 stop 幂等
  } finally {
    t.mock.timers.reset()
  }
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

test('C2C_MESSAGE_CREATE：单聊文本 → bus envelope（chatId=userId，chatType=private）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'evt_1', content: ' 跑一下测试 ', author: { user_openid: 'u_open' } } })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'qq')
  assert.equal(accepted[0].userId, 'u_open')
  assert.equal(accepted[0].chatId, 'u_open')
  assert.equal(accepted[0].chatType, 'private')
  assert.equal(accepted[0].messageId, 'evt_1')
  assert.equal(accepted[0].text, '跑一下测试')
  await rig.inbound.stop()
})

test('Issue #14：QQ C2C extra 图片和混合文本进入 bus；未知字段不进入控制信封', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveReady(rig)
  ws.serverSend({
    op: 0, t: 'C2C_MESSAGE_CREATE', s: 3,
    d: {
      id: 'evt_image', content: '请分析这张图', author: { user_openid: 'u_open' },
      extra: JSON.stringify([{ type: 1, image: {
        url: 'https://media.example.test/qq.png', width: 800, height: 600, injected_control: { approve: true },
      } }]),
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, '请分析这张图')
  assert.deepEqual(accepted[0].image, { url: 'https://media.example.test/qq.png', width: 800, height: 600 })
  assert.equal(accepted[0].injected_control, undefined)
  await rig.inbound.stop()
})

test('Issue #14：QQ malformed/missing URL 静默拒绝，图片重放和非白名单来源不旁路 bus', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  const ws = await driveReady(rig)
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: {
    id: 'evt_bad_image', author: { user_openid: 'u_open' }, extra: '[{"type":1,"image":{"width":1}}]',
  } })
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 4, d: {
    id: 'evt_replay_image', author: { user_openid: 'u_open' }, extra: '[{"type":1,"image":{"url":"https://media.example.test/q.png"}}]',
  } })
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 5, d: {
    id: 'evt_replay_image', author: { user_openid: 'u_open' }, extra: '[{"type":1,"image":{"url":"https://media.example.test/q.png"}}]',
  } })
  ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 6, d: {
    id: 'evt_untrusted_image', author: { user_openid: 'u_untrusted' }, extra: '[{"type":1,"image":{"url":"https://media.example.test/q.png"}}]',
  } })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].messageId, 'evt_replay_image')
  assert.equal(accepted[0].kind, 'image')
  await rig.inbound.stop()
})

test('GROUP_AT_MESSAGE_CREATE：群 @ 消息剥离提及占位；chatId=group_openid，chatType=group', async () => {
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
  assert.equal(accepted[0].chatType, 'group')
  assert.equal(accepted[0].text, '帮我跑测试')
  await rig.inbound.stop()
})

test('INTERACTION_CREATE：QQ 按钮回调保留显式 approvalAction/questionAction 与 accountId/chat 绑定元数据', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => { accepted.push(envelope); return true })
  const ws = await driveReady(rig)
  ws.serverSend({
    op: 0, t: 'INTERACTION_CREATE', s: 5,
    d: {
      id: 'interaction_1', type: 11, user_openid: 'u_open',
      data: { resolved: { button_data: 'ap:allowed-once:ap:demo:1:tok' } },
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].accountId, 'APP_ID')
  assert.equal(accepted[0].chatId, 'u_open')
  assert.equal(accepted[0].chatType, 'private')
  assert.deepEqual(accepted[0].approvalAction, { decision: 'allowed-once', approvalKey: 'ap:demo:1', token: 'tok' })
  await rig.inbound.stop()
})

test('INTERACTION_CREATE：群按钮回调明确标记 group，避免进入控制路径', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => { accepted.push(envelope); return true })
  const ws = await driveReady(rig)
  ws.serverSend({
    op: 0, t: 'INTERACTION_CREATE', s: 6,
    d: {
      id: 'interaction_group', type: 11, group_openid: 'g_open', group_member_openid: 'u_open',
      data: { resolved: { button_data: 'ap:allowed-once:ap:demo:2:tok' } },
    },
  })
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].chatType, 'group')
  assert.equal(accepted[0].chatId, 'g_open')
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

test('sendApprovalCard：按钮卡片优先（msg_type=2 + keyboard 回调按钮）+ msg_seq 递增，返回 messageId', async () => {
  const rig = makeRig()
  await driveReady(rig)
  const card = await rig.inbound.sendApprovalCard({ chatId: 'u_open', title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token: 'tk' })
  assert.equal(typeof card.messageId, 'string')
  const call = rig.calls.find((entry) => entry.url === `${API}/v2/users/u_open/messages`)
  assert.ok(call, '应 POST 单聊消息接口')
  assert.equal(call.headers.authorization, 'QQBot AT_TOKEN')
  // v0.8.4 按钮化：markdown + keyboard 长形式，两颗 type=1 回调按钮携带契约负载
  assert.equal(call.body.msg_type, 2)
  assert.equal(call.body.msg_seq, 1)
  assert.match(call.body.markdown.content, /需要批准：rm/)
  assert.match(call.body.markdown.content, /点击按钮完成裁决/)
  const buttons = call.body.keyboard.content.rows[0].buttons
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].render_data.label, '✅ 批准')
  assert.equal(buttons[1].render_data.label, '❌ 拒绝')
  for (const [index, decision] of ['allowed-once', 'rejected'].entries()) {
    assert.equal(buttons[index].action.type, 1, '必须是回调按钮（type=2 是指令语义）')
    assert.equal(buttons[index].action.click_limit, 1)
    assert.match(buttons[index].action.data, new RegExp(`^ap:${decision}:ap:rm:1:`), '契约协议 ap:<decision>:<key>:<token>')
    assert.deepEqual(buttons[index].action.permission.specify_user_ids, ['u_open'], '单聊锁定接收人')
  }
  const again = await rig.inbound.sendApprovalCard({ chatId: 'u_open', title: 't', content: 'c', approvalKey: 'k', token: 't' })
  assert.ok(again !== null)
  assert.equal(rig.calls.at(-1).body.msg_seq, 2, '同目标 msg_seq 递增（服务端按 seq 去重）')
  await rig.inbound.stop()
})

test('sendQuestionCard：群聊不发可操作按钮，单聊自定义回答也绑定原始用户', async () => {
  const groupRig = makeRig({ config: { notifyGroups: ['g_group'] } })
  assert.equal(await groupRig.inbound.sendQuestionCard({ chatId: 'g_group', title: 'q', content: 'c', qKey: 'aq:q', token: 'tk', options: ['A'] }), null)
  await groupRig.inbound.stop()

  const userRig = makeRig({ config: { notifyUsers: ['u_open'] } })
  const card = await userRig.inbound.sendQuestionCard({ chatId: 'u_open', title: 'q', content: 'c', qKey: 'aq:q', token: 'tk', options: ['A'] })
  assert.ok(card)
  const messageCall = userRig.calls.find((entry) => entry.url === `${API}/v2/users/u_open/messages`)
  assert.ok(messageCall)
  const buttons = messageCall.body.keyboard.content.rows.map((row) => row.buttons[0])
  assert.deepEqual(buttons.at(-1).action.permission.specify_user_ids, ['u_open'])
  await userRig.inbound.stop()
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

test('notifyTargets：notifyUsers + notifyGroups 优先，缺省回落全局白名单；capabilities.buttons=true（v0.8.4 按钮化）', async () => {
  const rig = makeRig({ config: { notifyUsers: ['u1', 'u2'], notifyGroups: ['g1'] } })
  assert.deepEqual(rig.inbound.notifyTargets(), [
    { chatId: 'u1', userId: 'u1' },
    { chatId: 'u2', userId: 'u2' },
    { chatId: 'g1', userId: 'g1' },
  ])
  assert.deepEqual(rig.inbound.capabilities, { buttons: true })
  const fallback = makeRig({ config: { notifyUsers: [], notifyGroups: [], fallbackTargets: ['u_global'] } })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'u_global', userId: 'u_global' }])
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 有界内存表（v0.8.7 P1-7，宪法#4）

const CHAT_STATE_MAX = 1024 // 与 qq-gw.mjs 的常量对齐（改源码上限须同步本值）

/** 灌 n 个群 @ 事件（各自独立 group_openid + messageId，逐个进 targetKinds）。 */
function floodGroupEvents(ws, count, { prefix = 'g_', from = 0 } = {}) {
  for (let i = from; i < from + count; i += 1) {
    ws.serverSend({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      s: 100 + i,
      d: { id: `evt_flood_${prefix}${i}`, group_openid: `${prefix}${i}`, content: '<@!BOT> hi', author: { member_openid: 'u_open' } },
    })
  }
}

test('targetKinds 有界：第 1025 个群挤掉最旧 → 该目标回落配置判定（默认单聊接口），并 warn 出声', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  floodGroupEvents(ws, CHAT_STATE_MAX + 1)
  await tick()
  assert.ok(
    rig.lines.some((line) => line.includes('目标类型学习表达上限')),
    '学习表淘汰必须可见（受影响目标的单聊/群判定降级，不可静默）',
  )
  // 最旧群：学习记录已淘汰 且 不在 notifyGroups ⇒ 回落「未知目标按单聊」既有语义
  assert.equal(await rig.inbound.sendText('g_0', '最旧'), true)
  assert.ok(rig.calls.some((entry) => entry.url === `${API}/v2/users/g_0/messages`), '被淘汰目标回落单聊接口')
  // 最新群：学习记录仍在，照旧走群接口
  assert.equal(await rig.inbound.sendText(`g_${CHAT_STATE_MAX}`, '最新'), true)
  assert.ok(rig.calls.some((entry) => entry.url === `${API}/v2/groups/g_${CHAT_STATE_MAX}/messages`), '未淘汰目标仍走群接口')
  await rig.inbound.stop()
})

test('targetKinds 淘汰后配置判定仍生效：notifyGroups 里的群被淘汰后依然走群接口（回落不是回落成错）', async () => {
  const rig = makeRig({ config: { notifyGroups: ['g_0'] } })
  const ws = await driveReady(rig)
  floodGroupEvents(ws, CHAT_STATE_MAX + 1)
  await tick()
  assert.equal(await rig.inbound.sendText('g_0', '配置群'), true)
  assert.ok(
    rig.calls.some((entry) => entry.url === `${API}/v2/groups/g_0/messages`),
    '配置里声明过的群即使学习记录被淘汰，也必须仍按群投递',
  )
  await rig.inbound.stop()
})

test('targetKinds LRU：活跃群（中途再来消息）不因「首次学习早」被淘汰', async () => {
  const rig = makeRig()
  const ws = await driveReady(rig)
  const learnHot = (seq) => ws.serverSend({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    s: seq,
    d: { id: `evt_hot_${seq}`, group_openid: 'g_hot', content: '<@!BOT> hi', author: { member_openid: 'u_open' } },
  })
  learnHot(1) // 最早学习
  floodGroupEvents(ws, CHAT_STATE_MAX - 1, { prefix: 'g_pad_' }) // 表正好填满 1024
  learnHot(2) // 活跃触摸
  floodGroupEvents(ws, 1, { prefix: 'g_final_' }) // 撑破上限 ⇒ 淘汰最旧
  await tick()
  assert.equal(await rig.inbound.sendText('g_hot', '热键'), true)
  assert.ok(
    rig.calls.some((entry) => entry.url === `${API}/v2/groups/g_hot/messages`),
    '被触摸过的活跃群必须存活（首次学习早不是淘汰理由）',
  )
  assert.equal(await rig.inbound.sendText('g_pad_0', '最旧'), true)
  assert.ok(
    rig.calls.some((entry) => entry.url === `${API}/v2/users/g_pad_0/messages`),
    '淘汰的是未被触摸的最旧目标（回落单聊接口）',
  )
  await rig.inbound.stop()
})

test('msgSeqs 有界：第 1025 个目标挤掉最旧 → 该目标 msg_seq 从 1 重新递增；活跃目标 seq 不被重置', async () => {
  const rig = makeRig()
  await driveReady(rig)
  // rateGate 固定 1050ms 节流：本用例要发 1000+ 条，压掉真实等待（仅本用例内，finally 还原）
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms > 0 ? 0 : ms, ...rest)
  try {
    assert.equal(await rig.inbound.sendText('t_0', 'a'), true)
    assert.equal(rig.calls.at(-1).body.msg_seq, 1)
    assert.equal(await rig.inbound.sendText('t_0', 'b'), true)
    assert.equal(rig.calls.at(-1).body.msg_seq, 2, '同目标 seq 递增（既有语义）')
    for (let i = 1; i < CHAT_STATE_MAX; i += 1) {
      assert.equal(await rig.inbound.sendText(`t_${i}`, 'x'), true)
    }
    // 此刻表正好 1024 条且 t_0 是最旧（第 2 次写 t_0 时 LRU 触摸过，但之后再无触摸）
    assert.equal(await rig.inbound.sendText(`t_${CHAT_STATE_MAX}`, 'y'), true) // 撑破上限
    assert.equal(await rig.inbound.sendText('t_0', 'c'), true)
    assert.equal(rig.calls.at(-1).body.msg_seq, 1, '被淘汰目标 seq 从 1 重起（跨消息重置无害：msg_seq 只需同 msg_id 下不重复）')
    assert.equal(await rig.inbound.sendText(`t_${CHAT_STATE_MAX}`, 'z'), true)
    assert.equal(rig.calls.at(-1).body.msg_seq, 2, '未淘汰目标的 seq 连续递增')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
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

test('stop 清理未决重连定时器：断线已调度重连但未执行时 stop → 不再新建连接（定时器不泄漏）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const rig = makeRig()
    rig.inbound.start()
    await flushMacrotask()
    const ws = FakeWebSocket.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
    await flushMacrotask()
    ws.serverClose() // 服务端断开 → close 监听器调度了退避重连（reconnectTimer 已挂）
    await flushMacrotask()
    const scheduled = FakeWebSocket.instances.length
    await rig.inbound.stop() // stop 应 clearTimeout(reconnectTimer)——定时器未决时撤销
    t.mock.timers.tick(100) // 若定时器泄漏，此刻早已重连
    await flushMacrotask()
    assert.equal(FakeWebSocket.instances.length, scheduled, 'stop 必须清掉未决重连定时器（stopRequested/clearTimeout 双保险）')
  } finally {
    t.mock.timers.reset()
  }
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
