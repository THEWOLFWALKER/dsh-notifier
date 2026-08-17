// 阶段 3 测试：inbound/wxpusher-callback（密径、动作分发、幂等键、白名单、绑定学习、定向推送）。
// 回调侧起真实临时端口 server + 本机 fetch POST；推送侧 fetch 全 mock。

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createWxpusherInbound, resolveWxpusherInboundConfig } from '../src/inbound/wxpusher-callback.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'

const SEND_ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-wx-')), 'state.json')
}

/** mock fetch：仅处理 WxPusher 推送接口；可脚本化失败。 */
function makePushFetch({ fail = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body ?? '{}'), signal: init.signal ?? null })
    if (fail) return jsonResponse({ code: 1001, msg: 'no auth' })
    return jsonResponse({ code: 1000, msg: 'ok', data: null })
  }
  return { fetchImpl, calls }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const liveInbounds = []

function makeRig({ allowUsers = ['UID_1'], config = {}, pushOptions = {} } = {}) {
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers, store, logger })
  const { fetchImpl, calls } = makePushFetch(pushOptions)
  const inbound = createWxpusherInbound({
    config: {
      appToken: 'AT_appToken',
      webhookPath: config.webhookPath ?? '/hook/secret123',
      host: '127.0.0.1',
      port: 0, // 随机端口（真实 server）
      notifyUids: config.notifyUids ?? [],
      allowedIps: config.allowedIps ?? [],
    },
    bus,
    store,
    fallbackTargets: config.fallbackTargets ?? [],
    logger,
    fetchImpl,
  })
  liveInbounds.push(inbound)
  return { bus, inbound, calls, lines, store }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等回调 server 起来后 POST 一个载荷。 */
async function post(rig, payload, { path } = {}) {
  const port = rig.inbound.port
  if (port === null) throw new Error('server 未启动')
  return fetch(`http://127.0.0.1:${port}${path ?? '/hook/secret123'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

afterEach(async () => {
  await Promise.allSettled(liveInbounds.splice(0).map((inbound) => inbound.stop()))
})

// ---------------------------------------------------------------- 配置解析

test('resolveWxpusherInboundConfig：缺 appToken 中文指引；路径归一化 + 随机密径生成', () => {
  const missing = resolveWxpusherInboundConfig({})
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /appToken/)

  const explicit = resolveWxpusherInboundConfig({ appToken: ' t ', webhookPath: 'hook/abc', port: 9000, notifyUids: [' u1 ', ''], allowedIps: ['1.2.3.4'] })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.config.appToken, 't')
  assert.equal(explicit.config.webhookPath, '/hook/abc')
  assert.equal(explicit.config.port, 9000)
  assert.deepEqual(explicit.config.notifyUids, ['u1'])
  assert.deepEqual(explicit.config.allowedIps, ['1.2.3.4'])

  const auto = resolveWxpusherInboundConfig({ appToken: 't' })
  assert.match(auto.config.webhookPath, /^\/hook\/[0-9a-f]{32}$/)
  assert.equal(auto.config.port, 8103, '默认端口 8103')
  assert.equal(auto.config.host, '127.0.0.1')

  // 显式 port: 0（随机端口）不得被 || 兜底吞掉；非法端口回落默认
  assert.equal(resolveWxpusherInboundConfig({ appToken: 't', port: 0 }).config.port, 0)
  assert.equal(resolveWxpusherInboundConfig({ appToken: 't', port: 'abc' }).config.port, 8103)
  assert.equal(resolveWxpusherInboundConfig({ appToken: 't', timeoutMs: 250 }).config.timeoutMs, 1000, 'timeoutMs 下限 1000')
})

// ---------------------------------------------------------------- HTTP 层

test('密径鉴权：命中密径 200；错路径 404；GET 405；非法 JSON 400；超限 413；带查询串仍命中', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()

  assert.equal((await post(rig, { action: 'none', data: {} })).status, 200)
  assert.equal((await post(rig, { action: 'none' }, { path: '/hook/wrong' })).status, 404)
  assert.equal((await post(rig, { action: 'none' }, { path: '/hook/secret123?utm=1' })).status, 200, '查询串不影响密径匹配')
  assert.equal((await fetch(`http://127.0.0.1:${rig.inbound.port}/hook/secret123`, { method: 'GET' })).status, 405)
  assert.equal((await post(rig, 'not-json{')).status, 400)
  assert.equal((await post(rig, 'x'.repeat(70 * 1024))).status, 413)
  await rig.inbound.stop()
})

test('stop：server 关闭后端口不再响应；重复 stop 幂等', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const port = rig.inbound.port
  await rig.inbound.stop()
  assert.equal(rig.inbound.port, null)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/hook/secret123`, { method: 'POST' }))
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 动作分发

test('send_up_cmd：剥 #{appId} 前缀 → bus envelope；白名单外 uid 拒收', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()

  assert.equal((await post(rig, {
    action: 'send_up_cmd',
    data: { uid: 'UID_1', appId: 'AT_app', time: '1770000000', content: '#AT_app 跑一下测试' },
  })).status, 200)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].channel, 'wxpusher')
  assert.equal(accepted[0].userId, 'UID_1')
  assert.equal(accepted[0].chatId, 'UID_1')
  assert.equal(accepted[0].text, '跑一下测试')
  assert.match(accepted[0].messageId, /^cmd:UID_1:1770000000:[0-9a-f]{6}$/)

  // 白名单外
  await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_EVIL', appId: 'AT_app', time: '1', content: 'hi' } })
  assert.equal(accepted.length, 1)
  await rig.inbound.stop()
})

test('send_up_cmd：无前缀纯文本直通；不一致 appId 也按 #xxx 形态剥', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_1', time: '2', content: '  直接文本  ' } })
  assert.equal(accepted[0].text, '直接文本')
  await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_1', appId: 'AT_OTHER', time: '3', content: '#AT_other 换号前缀' } })
  assert.equal(accepted[1].text, '换号前缀')
  await rig.inbound.stop()
})

test('前缀词边界：appId AT_app 不得部分匹配 #AT_application（回归）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  // 旧实现会剥出 'ication 别剥'（部分前缀匹配）；词边界后整段剥
  await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_1', appId: 'AT_app', time: '5', content: '#AT_application 别剥' } })
  assert.equal(accepted[0].text, '别剥')
  // 前缀即全文（无正文）→ 空文本拒收
  await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_1', appId: 'AT_app', time: '6', content: '#AT_app' } })
  assert.equal(accepted.length, 1)
  await rig.inbound.stop()
})

test('幂等：同 uid+time+content 重复回调只入站一次（合成 messageId 去重）', async () => {
  const rig = makeRig()
  const accepted = []
  rig.bus.onMessage((envelope) => accepted.push(envelope))
  rig.inbound.start()
  await tick()
  const payload = { action: 'send_up_cmd', data: { uid: 'UID_1', appId: 'a', time: '42', content: '#a 重复消息' } }
  await post(rig, payload)
  await post(rig, payload)
  await post(rig, { ...payload, data: { ...payload.data, time: '43' } }) // time 不同 → 新消息
  assert.equal(accepted.length, 2)
  await rig.inbound.stop()
})

test('app_subscribe：学习 uid 绑定落 store；extra 透传记录', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  await post(rig, { action: 'app_subscribe', data: { uid: 'UID_1', extra: 'bind-code-9' } })
  const row = rig.store.get('wxpusher:bind:UID_1')
  assert.ok(row !== undefined)
  assert.equal(row.extra, 'bind-code-9')
  assert.ok(rig.lines.some((line) => line.includes('UID_1 已订阅')))
  await rig.inbound.stop()
})

test('v0.7 学习键汇流：identity 装配时 app_subscribe uid 进待确认绑定（管理台收口）', async () => {
  const rig = makeRig()
  const identity = createIdentity({ store: rig.store })
  rig.inbound = createWxpusherInbound({
    config: { appToken: 'AT', webhookPath: '/hook/secret123', host: '127.0.0.1', port: 0, notifyUids: [], allowedIps: [] },
    bus: rig.bus, store: rig.store, identity, logger: { warn: () => {} }, fetchImpl: () => Promise.resolve(jsonResponse({ code: 1000 })),
  })
  liveInbounds.push(rig.inbound)
  rig.inbound.start()
  await tick()
  await post(rig, { action: 'app_subscribe', data: { uid: '990011', extra: 'scan-qr' } })
  const pending = identity.listPending()
  assert.equal(pending.length, 1, '订阅 uid 进待确认绑定')
  assert.equal(pending[0].key ?? `${pending[0].channel}:${pending[0].userId}`, 'wxpusher:990011')
  assert.equal(pending[0].origin, 'learned')
  // 幂等：重复订阅事件不产生重复条目
  await post(rig, { action: 'app_subscribe', data: { uid: '990011' } })
  assert.equal(identity.listPending().length, 1)
  // 已是成员：不进待确认（addPending 查绑定表拒绝 already-bound；allowUsers 不是绑定）
  identity.addBinding({ channel: 'wxpusher', userId: 'UID_1' })
  await post(rig, { action: 'app_subscribe', data: { uid: 'UID_1' } })
  assert.equal(identity.listPending().some((entry) => entry.userId === 'UID_1'), false)
  await rig.inbound.stop()
})

test('v0.7 学习键汇流：identity 未装配时保持旧行为（只落 wxpusher:bind 不入待确认）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  await post(rig, { action: 'app_subscribe', data: { uid: '990011' } })
  assert.ok(rig.store.get('wxpusher:bind:990011') !== undefined)
  assert.equal(rig.store.get('inbound:pending'), undefined, '未装配 identity 不写待确认表')
  await rig.inbound.stop()
})

test('未知动作：记日志回 200 不抛异常', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  assert.equal((await post(rig, { action: 'future_action', data: { uid: 'UID_1' } })).status, 200)
  assert.equal((await post(rig, {})).status, 200)
  assert.equal(seen, 0)
  assert.ok(rig.lines.some((line) => line.includes('未知回调动作')))
  await rig.inbound.stop()
})

test('allowedIps：来源 IP 不在名单 → 丢弃（密径之外的第二道闸）', async () => {
  const rig = makeRig({ config: { allowedIps: ['203.0.113.9'] } })
  let seen = 0
  rig.bus.onMessage(() => { seen += 1 })
  rig.inbound.start()
  await tick()
  const response = await post(rig, { action: 'send_up_cmd', data: { uid: 'UID_1', time: '1', content: 'hi' } })
  assert.equal(response.status, 200, '静默丢弃：不让探测者从响应码判断密径有效性')
  assert.equal(seen, 0)
  assert.ok(rig.lines.some((line) => line.includes('拒绝回调来源 IP')))
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 定向推送

test('sendApprovalCard：单 uid 定向推送 + 编号回复话术；msg 合成 id；带超时 signal', async () => {
  const rig = makeRig({ config: { notifyUids: ['UID_1'] } })
  rig.inbound.start()
  await tick()
  const card = await rig.inbound.sendApprovalCard({ chatId: 'UID_1', title: '需要批准：rm', content: '删除文件', approvalKey: 'ap:rm:1', token: 'tk' })
  assert.ok(card !== null && typeof card.messageId === 'string')
  assert.equal(rig.calls.length, 1)
  assert.equal(rig.calls[0].url, SEND_ENDPOINT)
  assert.equal(rig.calls[0].body.appToken, 'AT_appToken')
  assert.deepEqual(rig.calls[0].body.uids, ['UID_1'])
  assert.equal(rig.calls[0].body.contentType, 1)
  assert.match(rig.calls[0].body.content, /需要批准：rm/)
  assert.match(rig.calls[0].body.content, /回复 1 批准 \/ 2 拒绝/)
  assert.ok(rig.calls[0].signal instanceof AbortSignal, '推送必须带超时 signal（timeoutMs 已接线）')
  await rig.inbound.stop()
})

test('sendApprovalCard：code!==1000 返回 null 降级；sendText 同理 false', async () => {
  const rig = makeRig({ pushOptions: { fail: true } })
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendApprovalCard({ chatId: 'UID_1', title: 't', content: 'c', approvalKey: 'k', token: 'tk' }), null)
  assert.equal(await rig.inbound.sendText('UID_1', 'x'), false)
  assert.ok(rig.lines.some((line) => line.includes('审批通知发送失败')))
  await rig.inbound.stop()
})

test('sendText / editResolved：定向 uid 推送；editResolved 无 chatId 跳过', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  assert.equal(await rig.inbound.sendText('UID_9', '命令回执'), true)
  assert.deepEqual(rig.calls[0].body.uids, ['UID_9'])
  await rig.inbound.editResolved({ channel: 'wxpusher', chatId: 'UID_9', userId: 'UID_9', messageId: 'm' }, '✅ 已远程批准（本次）')
  assert.match(rig.calls[1].body.content, /已远程批准/)
  await rig.inbound.editResolved({}, 'x')
  assert.equal(rig.calls.length, 2)
  await rig.inbound.stop()
})

test('限速门：连续两次推送间隔 ≥500ms（官方 ~2QPS）', async () => {
  const rig = makeRig()
  rig.inbound.start()
  await tick()
  const startedAt = Date.now()
  await rig.inbound.sendText('UID_1', 'a')
  await rig.inbound.sendText('UID_1', 'b')
  assert.ok(Date.now() - startedAt >= 480, `两次推送应被限速门隔开，实际 ${Date.now() - startedAt}ms`)
  await rig.inbound.stop()
})

// ---------------------------------------------------------------- 契约

test('notifyTargets：notifyUids 优先回落白名单；capabilities.buttons=false', () => {
  const rig = makeRig({ config: { notifyUids: ['UID_1', 'UID_2'] } })
  assert.deepEqual(rig.inbound.notifyTargets(), [
    { chatId: 'UID_1', userId: 'UID_1' },
    { chatId: 'UID_2', userId: 'UID_2' },
  ])
  const fallback = makeRig({ config: { fallbackTargets: ['UID_GLOBAL'] } })
  assert.deepEqual(fallback.inbound.notifyTargets(), [{ chatId: 'UID_GLOBAL', userId: 'UID_GLOBAL' }])
  assert.deepEqual(rig.inbound.capabilities, { buttons: false })
})

test('start 幂等：重复 start 只监听一个端口', async () => {
  const rig = makeRig()
  rig.inbound.start()
  rig.inbound.start()
  await tick()
  const port = rig.inbound.port
  assert.equal((await post(rig, { action: 'x' })).status, 200)
  assert.equal(rig.inbound.port, port)
  await rig.inbound.stop()
})

test('端口占用：启动失败中文 warn，不影响重试', async () => {
  const blocker = makeRig()
  blocker.inbound.start()
  await tick()
  const port = blocker.inbound.port

  const lines = []
  const bus = createInboundBus({ allowUsers: ['UID_1'], store: createStore(tempPath()), logger: { warn: (p, m) => lines.push(`${p} ${m}`) } })
  const inbound = createWxpusherInbound({
    config: { appToken: 't', webhookPath: '/hook/x', host: '127.0.0.1', port },
    bus,
    logger: { warn: (p, m) => lines.push(`${p} ${m}`) },
    fetchImpl: makePushFetch().fetchImpl,
  })
  liveInbounds.push(inbound)
  inbound.start()
  await tick(20)
  assert.ok(lines.some((line) => line.includes('启动失败')))
  await inbound.stop()
  await blocker.inbound.stop()
})
