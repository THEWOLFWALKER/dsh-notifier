// v0.15（T11）全部 provider 保留迁移回归。
//
// 锁定任务书 T11：
//   1. 完整性：**全部**出站 provider（CHANNEL_TYPES）都已登记 sender（28 个）；
//   2. 分类矩阵：provider-registry 的 lifecycle/interaction 与 sender 注册表、capability-matrix 一致；
//   3. 契约形状：stateless 只含 validate/send；stateful 只含四个动作——绝不互相伪造；
//   4. 协议 golden：sender.send 与旧 adapter.send 逐字节一致（url/body/headers），迁移**不改协议**；
//   5. 错误语义：同一失败现场两侧抛同一 NotifyError.code；
//   6. 依赖方向 fitness：出站接缝不 import 入站/传输模块——结构上不可能改掉入站 negative；
//   7. 回退：未知渠道 senderOf→null（回落旧 adapter.send）；真实装配经 sender 契约发送证据正确。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ADAPTERS, CHANNEL_TYPES } from '../src/config.mjs'
import { SENDERS, senderOf, senderTypes } from '../src/adapters/senders.mjs'
import { SENDER_LIFECYCLE } from '../src/adapters/sender.mjs'
import { providerProfile, providerRegistryDrift, providerTypes, INTERACTIVE_PROVIDERS } from '../src/adapters/provider-registry.mjs'
import { capabilitiesOf, toInboundChannelName, OUTBOUND_TO_INBOUND_ALIAS } from '../src/inbound/capability-matrix.mjs'
import { composeOutboundChannels } from '../src/assembly/outbound.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'
import { createNotifier } from '../src/notify.mjs'
import { qqScan } from '../src/inbound/_qq-scan.mjs'

const MSG = { title: '标题', content: '正文`code`', level: 'active', silent: false }

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: null,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  json: async () => body,
})

/** 捕获一次发送的 { url, body, headers }；fetch 桩返回该渠道的合法成功响应。 */
async function capture(fn, response) {
  const original = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: init?.body, headers: init?.headers }
    return response
  }
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
  return seen
}

// 每个渠道：合法 raw 配置 + 让 ok() 判成功的响应体。
const SAMPLES = {
  // —— 声明表渠道（spec engine）——
  qmsg: { cfg: { key: 'KEY1' }, res: { success: true } },
  ntfy: { cfg: { topic: 'topic1' }, res: {} },
  pushover: { cfg: { token: 'tok', user: 'usr' }, res: { status: 1 } },
  onebot: { cfg: { baseUrl: 'http://127.0.0.1:3000', userId: 10001 }, res: { retcode: 0, status: 'ok' } },
  gotify: { cfg: { server: 'https://gotify.example.com', appToken: 'app' }, res: {} },
  slack: { cfg: { webhook: 'https://hooks.slack.com/services/T000/B000/XXXX' }, res: undefined },
  // —— 手写 HTTP 渠道 ——
  telegram: { cfg: { botToken: '123:ABC', chatId: '-100' }, res: { ok: true, result: { message_id: 1 } } },
  dingtalk: { cfg: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=tok' }, res: { errcode: 0 } },
  feishu: { cfg: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' }, res: { code: 0 } },
  wxpusher: { cfg: { appToken: 'a', uids: ['u1'] }, res: { code: 1000 } },
  pushplus: { cfg: { token: 'tok' }, res: { code: 200 } },
  serverchan: { cfg: { sct: 'SCT123abc' }, res: { code: 0 } },
  bark: { cfg: { key: 'K1' }, res: { code: 200 } },
  webhook: { cfg: { url: 'https://example.com/hook' }, res: {} },
}

/** 请求指纹比较：webhook 的 body 带动态 timestamp，比较时剔除。 */
function fingerprint(seen, type) {
  const body = typeof seen.body === 'string' ? JSON.parse(seen.body) : seen.body
  if (type === 'webhook' && body !== null && typeof body === 'object') delete body.timestamp
  return { url: seen.url, body, headers: seen.headers }
}

// ————————————————— 1. 完整性 —————————————————

test('T11 完整性：全部出站 provider（CHANNEL_TYPES）均已登记 sender', () => {
  assert.deepEqual(senderTypes().sort(), [...CHANNEL_TYPES].sort(),
    '每个现 registry 项都必须有 sender——不允许漏迁')
  assert.deepEqual(providerTypes().sort(), [...CHANNEL_TYPES].sort(),
    '分类矩阵必须覆盖全部出站 provider')
  assert.equal(CHANNEL_TYPES.length, 28, '出站 provider 全集为 28（研究计数）')
  assert.equal(Object.keys(SENDERS).length, CHANNEL_TYPES.length)
})

test('T11 完整性：ADAPTERS 与 sender 注册表的键集合逐一致（无孤儿/无缺失）', () => {
  for (const type of CHANNEL_TYPES) {
    assert.ok(senderOf(type) !== null, `${type} 未登记 sender`)
    assert.equal(senderOf(type).type, ADAPTERS[type].type, `${type} sender.type 必须等于 adapter.type`)
  }
})

// ————————————————— 2. 分类矩阵 —————————————————

test('T11 分类：provider-registry 与 sender 注册表零漂移（单一事实来源）', () => {
  assert.deepEqual(providerRegistryDrift(), [])
})

test('T11 分类：交互轴与 capability-matrix 的 buttons 事实一致', () => {
  for (const type of INTERACTIVE_PROVIDERS) {
    assert.equal(capabilitiesOf(toInboundChannelName(type)).buttons, true,
      `${type} 标为交互渠道，其入站通道必须 buttons=true`)
  }
  // 反向：入了别名表且入站 buttons=true 的出站渠道必须全部在交互列表内。
  for (const type of Object.keys(OUTBOUND_TO_INBOUND_ALIAS)) {
    if (!CHANNEL_TYPES.includes(type)) continue
    if (capabilitiesOf(toInboundChannelName(type)).buttons === true) {
      assert.ok(INTERACTIVE_PROVIDERS.includes(type), `${type} 入站可交互，出站交互轴必须标记`)
    }
  }
})

test('T11 分类：未知 provider fail-closed（null，不猜生命周期）', () => {
  assert.equal(providerProfile('no-such-channel'), null)
  assert.equal(providerProfile(''), null)
  assert.equal(providerProfile(undefined), null)
})

// ————————————————— 3. 契约形状 —————————————————

test('T11 形状：stateless sender 只含 validate/send；stateful 只含四个动作（互不伪造）', () => {
  const statelessKeys = ['lifecycle', 'send', 'type', 'validate']
  const statefulKeys = ['createRuntime', 'lifecycle', 'retire', 'send', 'type', 'validate']
  for (const type of CHANNEL_TYPES) {
    const sender = senderOf(type)
    const profile = providerProfile(type)
    if (profile.lifecycle === SENDER_LIFECYCLE.STATEFUL) {
      assert.deepEqual(Object.keys(sender).sort(), statefulKeys, `${type} stateful 形状`)
    } else {
      assert.deepEqual(Object.keys(sender).sort(), statelessKeys, `${type} stateless 形状`)
      for (const verb of ['createRuntime', 'start', 'stop', 'candidate', 'dispose', 'retire']) {
        assert.equal(verb in sender, false, `${type} stateless 不得伪造 ${verb}`)
      }
    }
  }
})

test('T11 形状：有界 memo 的 stateless 渠道（serverchan/desktop）仍无生命周期动词', () => {
  for (const type of ['serverchan', 'desktop']) {
    const profile = providerProfile(type)
    assert.equal(profile.lifecycle, SENDER_LIFECYCLE.STATELESS)
    assert.ok(profile.resources.length > 0, '有界 memo 必须显式登记（不是外部句柄）')
    assert.equal('createRuntime' in senderOf(type), false)
    assert.equal('retire' in senderOf(type), false)
  }
})

// ————————————————— 4. 协议 golden 一致 —————————————————

test('T11 golden：sender.send 与旧 adapter.send 的 url/body/headers 逐字段一致', async () => {
  for (const [type, sample] of Object.entries(SAMPLES)) {
    const adapter = ADAPTERS[type]
    const response = okResponse(sample.res)
    const viaAdapter = await capture(() => adapter.send(adapter.resolve({ ...sample.cfg }), MSG), response)
    const viaSender = await capture(() => senderOf(type).send(senderOf(type).validate({ ...sample.cfg }), MSG), response)
    assert.deepEqual(fingerprint(viaSender, type), fingerprint(viaAdapter, type),
      `${type} 经 sender 契约后请求必须逐字段一致（迁移不改协议）`)
  }
})

test('T11 golden：本地渠道 bell 的 sender 语义与 adapter 一致（silent 不响）', async () => {
  const written = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true }
  try {
    const adapter = ADAPTERS.bell
    await adapter.send(adapter.resolve({ count: 2 }), { ...MSG, silent: false })
    const viaAdapter = written.join('')
    written.length = 0
    await senderOf('bell').send(senderOf('bell').validate({ count: 2 }), { ...MSG, silent: false })
    assert.equal(written.join(''), viaAdapter)
    written.length = 0
    await senderOf('bell').send(senderOf('bell').validate({ count: 2 }), { ...MSG, silent: true })
    assert.equal(written.join(''), '', 'silent 推送不响——语义不得因接缝迁移改变')
  } finally {
    process.stdout.write = original
  }
})

// ————————————————— 5. 错误语义不变 —————————————————

test('T11 错误语义：同一失败现场两侧抛出同一 NotifyError.code', async () => {
  const adapter = ADAPTERS.telegram
  const cfg = { botToken: '1:A', chatId: '-1' }
  const failure = okResponse({ ok: false, description: 'bad' }, 403)
  let viaAdapter
  let viaSender
  await capture(async () => { try { await adapter.send(adapter.resolve(cfg), MSG) } catch (e) { viaAdapter = e } }, failure)
  const sender = senderOf('telegram')
  await capture(async () => { try { await sender.send(sender.validate(cfg), MSG) } catch (e) { viaSender = e } }, failure)
  assert.equal(viaAdapter.code, viaSender.code)
  assert.equal(viaAdapter.publicMessage, viaSender.publicMessage)
})

// ————————————————— 6. 依赖方向 fitness —————————————————

test('T11 fitness：出站接缝不 import 入站/传输模块（结构上不可能改入站 negative）', () => {
  const files = ['../src/adapters/senders.mjs', '../src/adapters/provider-registry.mjs', '../src/adapters/sender.mjs']
  for (const rel of files) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    const imports = [...source.matchAll(/^\s*import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
    for (const spec of imports) {
      assert.equal(/inbound\//.test(spec), false, `${rel} 不得 import 入站模块（${spec}）`)
      assert.equal(/channels\//.test(spec), false, `${rel} 不得 import 传输模块（${spec}）`)
    }
  }
})

test('T11 fitness：入站六通道的 negative 回归套件仍在位（未被本次迁移删除）', () => {
  // 迁移只碰出站；这些入站 negative（offset 暂停/ACK/卡片 patch/重连/登录态）由各自套件继续守。
  const inboundSuites = [
    'inbound.telegram.test.mjs', 'inbound.feishu.test.mjs', 'inbound.dingtalk.test.mjs',
    'inbound.wechat.test.mjs', 'inbound.qq.test.mjs', 'inbound.wxpusher.test.mjs',
  ]
  for (const name of inboundSuites) {
    assert.doesNotThrow(() => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8'),
      `${name} 必须存在（入站 negative 不得因出站迁移丢失）`)
  }
})

// ————————————————— 7. 回退 + 真实装配 —————————————————

test('T11 回退：未知渠道 senderOf→null，notifier 回落旧 adapter.send（未登记渠道原状）', async () => {
  assert.equal(senderOf('legacy-unknown'), null)
  const adapter = ADAPTERS.telegram
  const notifier = createNotifier({ logger: { warn() {} } }, [
    { type: 'telegram', config: adapter.resolve({ botToken: '1:A', chatId: '-1' }) },
  ], { segment: { enabled: false } })
  const seen = await capture(() => notifier.notify('telegram', MSG), okResponse({ ok: true, result: {} }))
  assert.equal(seen.url, 'https://api.telegram.org/bot1:A/sendMessage')
})

test('T11 真实装配：notifier 经 sender 契约发送，证据只到 accepted（无 provider 回执）', async () => {
  const store = {
    get: (key, fallback = undefined) => (key === 'channel:bark:outbound' ? { key: 'K9' } : fallback),
    keys: () => [],
    transact: () => ({ ok: true, committed: true, durable: true }),
  }
  const overlay = composeOutboundChannels({
    channels: [], yamlRows: new Map(), store, adminEnabled: false, warn() {}, allowLegacy: false,
  })
  const manager = createRuntimeChannelManager({ source: createOutboundSource(overlay.channels), initial: overlay.channels })
  const records = []
  const notifier = createNotifier({ logger: { warn() {} } }, manager, {
    segment: { enabled: false }, onSend: (record) => records.push(record),
  })
  const seen = await capture(() => notifier.notify('bark', { title: 't', content: 'c' }), okResponse({ code: 200 }))
  assert.equal(seen.url, 'https://api.day.app/K9')
  const record = records.at(-1)
  assert.deepEqual(record.accepted, ['bark'])
  assert.deepEqual(record.confirmed, [], '无显式回执绝不写成确认送达')
})

// ————————————————— 8. writer 收口 —————————————————

test('T11 writer 收口：扫码 onboarding 走事务内字段级合并（并发写兄弟字段不丢）', async () => {
  // 带 transact 的内存 store，预置手工写入的兄弟字段；扫码写凭证必须**合并**而非整对象覆盖，
  // 否则并发手工 put / 另一次扫码写同一 `<type>:account` 的不同字段时会丢兄弟字段。
  const data = new Map([['qq:account', { accountId: 'manual-sibling' }]])
  const store = {
    get: (key, fallback = undefined) => (data.has(key) ? data.get(key) : fallback),
    keys: () => [...data.keys()],
    set: (key, value) => { data.set(key, value); return true },
    transact(mutator) {
      const draft = Object.fromEntries(data)
      mutator(draft)
      for (const [key, value] of Object.entries(draft)) data.set(key, value)
      return { committed: true }
    },
  }
  const connectorLoader = async () => ({ startQrConnect: async () => [{ appId: '102048888', appSecret: 'qq-secret' }] })
  const result = await qqScan({ store, connectorLoader, timeoutMs: 1000 })
  assert.equal(result.status, 'ok')
  const account = store.get('qq:account')
  assert.equal(account.appSecret, 'qq-secret')
  assert.equal(account.accountId, 'manual-sibling', '事务内合并必须保留并发写入的兄弟字段')
})