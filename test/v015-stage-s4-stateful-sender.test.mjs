// v0.15（T10）复杂 runtime 试点：stateful sender 契约 + QQ/WeCom 资源型渠道迁移。
//
// 锁定任务书 T10 与验收矩阵：
//   P01  token 换取 single-flight + 代际守卫（并发 send 共享一次换取；retire 作废缓存）。
//   P02  QQ 长文分段 / msg_seq 幂等（协议代码零改动，golden 不变）。
//   C03  epoch 栅栏：停用后旧 runtime 的迟到结果不得落地（停用后旧 callback 不写 audit）。
//   C04/C05 状态机切换：start/stop/dispose 幂等、有界释放。
//   边界  单 consumer（同 resolved 单 runtime）、freeze config 实际装配、不泄密。

import test from 'node:test'
import assert from 'node:assert/strict'

import { SENDER_LIFECYCLE, defineStatefulSender } from '../src/adapters/sender.mjs'
import { senderOf, senderTypes, retireSenderRuntime } from '../src/adapters/senders.mjs'
import { createNotifier } from '../src/notify.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { composeOutboundChannels } from '../src/assembly/outbound.mjs'
import { createQqInbound } from '../src/inbound/qq-gw.mjs'

const MSG = { title: '标题', content: '正文 markdown **bold**', level: 'active' }
const TOKEN_MARK = 'getAppAccessToken'

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
})

async function withFetch(stub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { return await fn() } finally { globalThis.fetch = original }
}

function memoryStore(initial = {}) {
  let memory = JSON.parse(JSON.stringify(initial))
  return {
    get: (key, fallback = undefined) => (key in memory ? JSON.parse(JSON.stringify(memory[key])) : fallback),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

// ————————————————— 契约形状 —————————————————

test('T10 契约：qq-bot/wecom-app 声明 stateful，只含 validate/createRuntime/send/retire', () => {
  for (const type of ['qq-bot', 'wecom-app']) {
    const sender = senderOf(type)
    assert.ok(sender !== null, `${type} 必须在 sender 注册表内`)
    assert.equal(sender.lifecycle, SENDER_LIFECYCLE.STATEFUL)
    assert.deepEqual(Object.keys(sender).sort(), ['createRuntime', 'lifecycle', 'retire', 'send', 'type', 'validate'],
      'stateful sender 只暴露这四个动作 + 类型/生命周期')
    for (const verb of ['createRuntime', 'validate', 'send', 'retire']) {
      assert.equal(typeof sender[verb], 'function', `stateful sender 必须有 ${verb}()`)
    }
  }
  // T11 起全部 provider 已登记，这里只断言两个 stateful 试点在位（全量与分类见 s5 套件）。
  assert.ok(senderTypes().includes('qq-bot') && senderTypes().includes('wecom-app'))
})

test('T10 契约：stateless 渠道（bark/webhook）绝不伪造 createRuntime/retire', () => {
  for (const type of ['bark', 'webhook']) {
    const sender = senderOf(type)
    assert.equal(sender.lifecycle, SENDER_LIFECYCLE.STATELESS)
    assert.equal('createRuntime' in sender, false)
    assert.equal('retire' in sender, false)
    assert.deepEqual(Object.keys(sender).sort(), ['lifecycle', 'send', 'type', 'validate'])
  }
})

// ————————————————— P01 单 owner + token single-flight —————————————————

test('T10 单 consumer：同一 resolved 只建一个 runtime；并发 send 共享一次 token 换取（P01）', async () => {
  const sender = senderOf('qq-bot')
  const resolved = sender.validate({ appId: 'A1', appSecret: 'S1', groupId: 'G1' })

  let tokenCalls = 0
  let msgCalls = 0
  let releaseToken
  const tokenGate = new Promise((resolve) => { releaseToken = resolve })
  await withFetch(async (url) => {
    if (String(url).includes(TOKEN_MARK)) {
      tokenCalls += 1
      await tokenGate // 首个换取挂起：验证并发 get() 共享同一在飞换取
      return jsonResponse({ access_token: 'T1', expires_in: 7200 })
    }
    msgCalls += 1
    return jsonResponse({ id: `m${msgCalls}` })
  }, async () => {
    // 单 owner：并发取 runtime 得到同一实例，start 只跑一次。
    assert.equal(sender.createRuntime(resolved), sender.createRuntime(resolved))
    const pending = [sender.send(resolved, MSG), sender.send(resolved, MSG)]
    await tick()
    releaseToken()
    await Promise.all(pending)
    // 缓存命中：第三次串行 send 仍不重换。
    await sender.send(resolved, MSG)
  })

  assert.equal(tokenCalls, 1, '并发 send 必须共享一次 token 换取（single-flight + 缓存）')
  assert.equal(msgCalls, 3)
  assert.ok(resolved._msgSeq >= 1, 'P02 保留：成功推送推进 msg_seq（并发下 seq 语义由 adapter 持有）')
})

test('T10 P01：retire 作废 token 缓存；旧 resolved 被墓碑化不得复活，新 resolved 重新换取', async () => {
  const sender = senderOf('qq-bot')
  const resolved = sender.validate({ appId: 'A2', appSecret: 'S2', groupId: 'G2' })

  let tokenCalls = 0
  await withFetch(async (url) => {
    if (String(url).includes(TOKEN_MARK)) { tokenCalls += 1; return jsonResponse({ access_token: `T${tokenCalls}`, expires_in: 7200 }) }
    return jsonResponse({ id: 'm' })
  }, async () => {
    const first = sender.createRuntime(resolved)
    await sender.send(resolved, MSG)
    assert.equal(tokenCalls, 1)
    assert.equal(sender.retire(resolved), true)
    assert.equal(resolved._tokenManager, undefined, 'dispose 必须断开 token 缓存引用')
    // v0.15 RC：retire 后同一 resolved 被永久墓碑化——绝不悄悄重建 runtime（不复活）。
    assert.throws(() => sender.createRuntime(resolved), (error) => error.code === 'CHANNEL_RETIRED')
    // 只有「全新 resolved」才允许建立新 epoch 的 runtime，并重新换取 token（旧缓存不得复活）。
    const fresh = sender.validate({ appId: 'A2', appSecret: 'S2', groupId: 'G2' })
    const second = sender.createRuntime(fresh)
    assert.notEqual(second, first, 'retire 后新 resolved 得到全新 epoch 的 runtime')
    await sender.send(fresh, MSG)
  })
  assert.equal(tokenCalls, 2, '作废的缓存不得复活')
})

// ————————————————— C03 epoch：停用后旧 callback 不落地 —————————————————

test('T10-C03 epoch：send 在飞期间 retire → 迟到结果作废（CHANNEL_RETIRED，noRetry，不重发）', async () => {
  const sender = senderOf('qq-bot')
  const resolved = sender.validate({ appId: 'A3', appSecret: 'S3', groupId: 'G3' })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  await withFetch(async (url) => {
    if (String(url).includes(TOKEN_MARK)) return jsonResponse({ access_token: 'T', expires_in: 7200 })
    await gate
    return jsonResponse({ id: 'm' })
  }, async () => {
    const pending = sender.send(resolved, MSG)
    await tick() // 让 send 推进到消息请求（已取到 token）
    assert.equal(sender.retire(resolved), true)
    release()
    await assert.rejects(() => pending, (error) => {
      assert.equal(error.code, 'CHANNEL_RETIRED')
      assert.equal(error.noRetry, true, '结果作废 → 不重发（avoid 重复投递）')
      return true
    })
  })
})

test('T10-C03/C04：retire 幂等——stop/dispose 各一次、引用释放、未知 config 不误报', () => {
  const calls = { start: 0, stop: 0, dispose: 0 }
  const sender = defineStatefulSender({
    type: 'synthetic-stateful',
    validate: (cfg) => ({ ...cfg }),
    createRuntime: () => ({
      send: async () => undefined,
      start() { calls.start += 1 },
      stop() { calls.stop += 1 },
      dispose() { calls.dispose += 1 },
    }),
  })
  const resolved = sender.validate({ a: 1 })
  sender.createRuntime(resolved)
  assert.deepEqual(calls, { start: 1, stop: 0, dispose: 0 }, 'createRuntime 触发一次 start')

  assert.equal(sender.retire(resolved), true)
  assert.deepEqual(calls, { start: 1, stop: 1, dispose: 1 }, 'retire 有界：stop/dispose 各一次')
  assert.equal(sender.retire(resolved), false, '重复 retire 幂等（不再触发释放）')
  assert.equal(sender.retire({ other: true }), false, '未登记的 resolved 不误报')
  assert.equal(sender.activeCount, 0)
})

test('T10-C04：生命周期动词抛错不得把 retire 卡死（释放失败不致命）', () => {
  const sender = defineStatefulSender({
    type: 'synthetic-throwing',
    validate: (cfg) => ({ ...cfg }),
    createRuntime: () => ({
      send: async () => undefined,
      start() { throw new Error('start exploded') },
      stop() { throw new Error('stop exploded') },
      dispose() { throw new Error('dispose exploded') },
    }),
  })
  const resolved = sender.validate({})
  assert.doesNotThrow(() => sender.createRuntime(resolved), 'start 抛错不致命（首次 send 才可见）')
  assert.equal(sender.retire(resolved), true)
  assert.equal(sender.activeCount, 0)
})

// ————————————————— 不泄密 —————————————————

test('T10 不泄密：投递证据不含 token/secret；sender 不暴露凭证', async () => {
  const sender = senderOf('qq-bot')
  const resolved = sender.validate({ appId: 'APP', appSecret: 'SUPER_SECRET', groupId: 'G' })

  let evidence
  await withFetch(async (url) => {
    if (String(url).includes(TOKEN_MARK)) return jsonResponse({ access_token: 'SECRET_TOKEN_VALUE', expires_in: 7200 })
    return jsonResponse({ id: 'm' })
  }, async () => { evidence = await sender.send(resolved, MSG) })

  assert.deepEqual(Object.keys(evidence).sort(), ['accepted', 'confirmed'], '证据只有两级词汇')
  const serialized = JSON.stringify(evidence)
  assert.equal(serialized.includes('SUPER_SECRET'), false)
  assert.equal(serialized.includes('SECRET_TOKEN_VALUE'), false)
  assert.equal(Object.keys(sender).join(',').includes('secret'), false)
})

// ————————————————— 超时 —————————————————

test('T10 超时：消息端点挂起 → TIMEOUT + noRetry（结果未知不盲目重发）', async () => {
  const sender = senderOf('qq-bot')
  const resolved = sender.validate({ appId: 'A4', appSecret: 'S4', groupId: 'G4', timeoutMs: 1000 })

  await withFetch(async (url, init = {}) => {
    if (String(url).includes(TOKEN_MARK)) return jsonResponse({ access_token: 'T', expires_in: 7200 })
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }, async () => {
    await assert.rejects(() => sender.send(resolved, MSG), (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.equal(error.noRetry, true)
      return true
    })
  })
})

// ————————————————— freeze config 经真实装配 —————————————————

test('T10 真实装配：qq-bot（stateful）经 notifier 发送成功；投影冻结、live 可变', async () => {
  const store = memoryStore({ 'channel:qq-bot:outbound': { appId: '1', appSecret: 's', groupId: 'g1' } })
  const overlay = composeOutboundChannels({
    channels: [], yamlRows: new Map(), store, adminEnabled: false, warn() {}, allowLegacy: false,
  })
  const manager = createRuntimeChannelManager({
    source: createOutboundSource(overlay.channels, { onRetire: (type, config) => { retireSenderRuntime(type, config) } }),
    initial: overlay.channels,
  })
  const notifier = createNotifier({ logger: { warn() {} } }, manager, { segment: { enabled: false } })

  await withFetch(async (url) => {
    if (String(url).includes(TOKEN_MARK)) return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    return jsonResponse({ id: 'm1', timestamp: 1 })
  }, async () => {
    const result = await notifier.notify('qq-bot', { title: '', content: 'hi' })
    assert.equal(result.ok, true, 'stateful sender 接入后装配路径必须仍可发送')
  })

  const live = manager.live('qq-bot').config
  assert.equal(Object.isFrozen(live), false, '传输路径必须拿 live（非冻结）对象')
  assert.doesNotThrow(() => { live._msgSeq = 7 })
  assert.throws(() => { manager.get('qq-bot').config.appId = 'x' }, TypeError, '外部投影仍冻结')
})

// ————————————————— outbound-source 生命周期 owner —————————————————

test('T10 生命周期 owner：remove/replace 经 outbound-source 释放被丢弃的 runtime', () => {
  const retired = []
  const source = createOutboundSource([], { onRetire: (type, config) => retired.push([type, config]) })

  const first = { appId: '1' }
  source.replace('qq-bot', first)
  assert.equal(retired.length, 0, '新增不释放')

  const second = { appId: '2' }
  source.replace('qq-bot', second)
  assert.deepEqual(retired, [['qq-bot', first]], '热替换释放旧 config')

  source.remove('qq-bot')
  assert.equal(retired.length, 2)
  assert.equal(retired[1][0], 'qq-bot')
  assert.equal(retired[1][1], second)

  source.remove('qq-bot')
  assert.equal(retired.length, 2, '重复移除不再释放')
})

test('T10 retireSenderRuntime：未登记/stateless 渠道返回 false（回退未登记渠道原状）', () => {
  assert.equal(retireSenderRuntime('bark', {}), false, 'stateless 无 runtime')
  assert.equal(retireSenderRuntime('unknown-channel', {}), false, '未登记渠道 no-op')
  const resolved = senderOf('wecom-app').validate({ corpid: 'c', secret: 's', agentId: 1 })
  assert.equal(retireSenderRuntime('wecom-app', resolved), false, '未创建的 runtime 不误报')
})

// ————————————————— wecom-app —————————————————

test('T10 wecom-app：stateful 发送成功、token 单次换取、dispose 清缓存', async () => {
  const sender = senderOf('wecom-app')
  const resolved = sender.validate({ corpid: 'c', secret: 's', agentId: 1 })

  let tokenCalls = 0
  await withFetch(async (url) => {
    if (String(url).includes('gettoken')) { tokenCalls += 1; return jsonResponse({ access_token: 'T', expires_in: 7200 }) }
    return jsonResponse({ errcode: 0, errmsg: 'ok' })
  }, async () => {
    await Promise.all([sender.send(resolved, MSG), sender.send(resolved, MSG)])
  })
  assert.equal(tokenCalls, 1, '并发发送共享一次 token 换取')
  assert.ok(resolved._tokenManager, 'token 管理器由 runtime 持有于 live 对象')
  assert.equal(sender.retire(resolved), true)
  assert.equal(resolved._tokenManager, undefined, 'dispose 释放 token 缓存（有限 dispose）')
})

// ————————————————— QQ 入站实例（单 owner / 停用后旧帧不落地） —————————————————

class FakeWs {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
    FakeWs.instances.push(this)
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  removeAllListeners() { this.listeners.clear() }
  emit(type, extra = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ type, target: this, ...extra }) }
  serverOpen() { this.readyState = 1; this.emit('open') }
  serverSend(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.emit('close', {}) }
}

test('T10 QQ 入站实例：start 幂等单 owner；stop 后旧连接迟到帧不落地（epoch）', async () => {
  FakeWs.instances.length = 0
  const accepted = []
  let gatewayCalls = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes(TOKEN_MARK)) return jsonResponse({ access_token: 'T', expires_in: 7200 })
    if (target.endsWith('/gateway')) { gatewayCalls += 1; return jsonResponse({ url: 'wss://qq-gw.fake' }) }
    return jsonResponse({ id: 'm' })
  }
  const inbound = createQqInbound({
    config: { appId: 'A', appSecret: 'S', notifyUsers: ['u1'], intents: (1 << 25) | (1 << 26) },
    bus: { accept: (envelope) => { accepted.push(envelope); return {} } },
    logger: { warn() {}, debug() {} },
    fetchImpl,
    webSocketImpl: FakeWs,
    reconnectBaseMs: 2,
    reconnectCapMs: 8,
  })

  try {
    inbound.start()
    inbound.start() // 幂等：第二次 start 不得新建连接
    await tick()
    assert.equal(gatewayCalls, 1, 'start 幂等 → 单 consumer，只取一次网关地址')

    const ws = FakeWs.instances.at(-1)
    ws.serverOpen()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 60000 } })
    await tick()
    ws.serverSend({ op: 0, t: 'READY', s: 2, d: { session_id: 'sess' } })
    await tick()

    await inbound.stop()
    // 旧连接（已被 retire）迟到事件帧：不得进入 bus（停用后旧 callback 不落地）。
    ws.serverSend({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'm-late', author: { user_openid: 'u1' }, content: 'late' } })
    await tick()
    assert.equal(accepted.length, 0, '停用后旧连接帧不得落地')
  } finally {
    await inbound.stop()
  }
})