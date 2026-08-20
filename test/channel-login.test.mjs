// 阶段测试：channel-login 底层封装 _qq-scan / _feishu-register（官方扫码建应用 SDK 封装）。
// connector / node-sdk 全 mock（loader 注入 fake），不联网、不装真实 optionalDependencies
// （与 inbound.feishu.test.mjs 的 sdkLoader 注入模式一致）。
// CLI 契约对照 scripts/channel-login.mjs loginQq/loginFeishu：传 { store, timeoutMs, onQr, log }，
// 消费 { status, appId?, openId?, message? }——本测试按同一形态断言。

import test from 'node:test'
import assert from 'node:assert/strict'
import { qqScan } from '../src/inbound/_qq-scan.mjs'
import { feishuRegister } from '../src/inbound/_feishu-register.mjs'

// ---------------------------------------------------------------- fakes

/** 内存 store：接口与 src/inbound/store.mjs createStore 的 set/get/keys 对齐。 */
function makeStore() {
  const data = new Map()
  return {
    data,
    set(key, value) { data.set(key, value) },
    get(key, fallback = undefined) { return data.has(key) ? data.get(key) : fallback },
    keys(prefix = '') { return [...data.keys()].filter((key) => key.startsWith(prefix)) },
  }
}

/** 伪造「包未装」错误（Node ESM resolver 的真实形态：code=ERR_MODULE_NOT_FOUND）。 */
function moduleMissingError(packageName) {
  const error = new Error(`Cannot find package '${packageName}' imported from /dsh-notifier/src/inbound/x.mjs`)
  error.code = 'ERR_MODULE_NOT_FOUND'
  return error
}

/**
 * 伪造 @tencent-connect/qqbot-connector 1.2.0 导出形态。
 * shape：named = { startQrConnect }；default = { default: { startQrConnect } }；none = 没有该导出。
 * hang = true 时会话永不 resolve（超时测试）；error 非 null 时 SDK 抛错。
 */
function makeFakeConnector({
  credentials = [{ appId: '102048888', appSecret: 'qq-secret-1' }],
  shape = 'named',
  error = null,
  hang = false,
} = {}) {
  const state = { started: 0, configs: [], callbacks: [] }
  const startQrConnect = async (config, callbacks) => {
    state.started += 1
    state.configs.push(config)
    state.callbacks.push(callbacks)
    if (hang) return new Promise(() => {}) // 永不 resolve（模拟用户一直不扫码）
    if (typeof callbacks?.onQrCode === 'function') callbacks.onQrCode('https://q.qq.com/qr/abc123')
    if (error !== null) throw error
    return credentials
  }
  const mod = shape === 'named'
    ? { startQrConnect }
    : shape === 'default'
      ? { default: { startQrConnect } }
      : { somethingElse: () => {} } // 包装产物形态变了：没有 startQrConnect
  return { state, mod, loader: async () => mod }
}

/**
 * 伪造 @larksuiteoapi/node-sdk ≥1.61.1 的 registerApp。
 * shape：named = { registerApp }；default = { default: { registerApp } }；none = 旧版（只有 Client）。
 */
function makeFakeSdk({
  outcome = { status: 'ok', client_id: 'cli_a1b2c3', client_secret: 'fs-secret', user_info: { open_id: 'ou_scanner' } },
  shape = 'named',
  hang = false,
} = {}) {
  const state = { called: 0, options: [] }
  const registerApp = async (options) => {
    state.called += 1
    state.options.push(options)
    if (hang) return new Promise(() => {})
    // 真实 SDK 回调名 onQRCodeReady（接收 { url, expireIn }），旧 onQrCode 已被弃用
    if (typeof options?.onQRCodeReady === 'function') {
      options.onQRCodeReady({ url: 'https://open.feishu.cn/qr/xyz', expireIn: 600 })
    }
    return outcome
  }
  const mod = shape === 'named'
    ? { registerApp }
    : shape === 'default'
      ? { default: { registerApp } }
      : { Client: class FakeClient {} } // <1.61.1 旧版：有 Client 但没有 registerApp
  return { state, mod, loader: async () => mod }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- qqScan（7）

test('qqScan：成功路径 → status ok + appId + qq:account 落盘形状含 at', async () => {
  const store = makeStore()
  const fake = makeFakeConnector()
  const result = await qqScan({ store, connectorLoader: fake.loader, onQr: () => {} })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, '102048888')
  // 落盘形状：appId + appSecret + at（时间戳），与 wechat:account/dingtalk:account 同构
  const account = store.get('qq:account')
  assert.equal(account.appId, '102048888')
  assert.equal(account.appSecret, 'qq-secret-1')
  assert.equal(typeof account.at, 'number')
  assert.ok(account.at > 0)
  // 官方调用骨架：占位凭证（扫码创建阶段无需预置）+ onQrCode 回调
  assert.deepEqual(fake.state.configs[0], { appId: '', appSecret: '' })
  assert.equal(typeof fake.state.callbacks[0].onQrCode, 'function')
})

test('qqScan：缺包（loader reject ERR_MODULE_NOT_FOUND）→ missing-sdk，绝不 throw', async () => {
  const store = makeStore()
  const loader = async () => { throw moduleMissingError('@tencent-connect/qqbot-connector') }
  // 绝不 throw：直接 await 即隐含 doesNotReject（若 reject 本测试会以失败告终）
  const result = await qqScan({ store, connectorLoader: loader })
  assert.equal(result.status, 'missing-sdk')
  assert.match(result.message, /未安装 @tencent-connect\/qqbot-connector/)
  assert.match(result.message, /npm i/)
  assert.equal(store.keys().includes('qq:account'), false, '缺包不落盘')
})

test('qqScan：default 导出兼容（default.startQrConnect）→ ok', async () => {
  const fake = makeFakeConnector({ shape: 'default' })
  const result = await qqScan({ store: makeStore(), connectorLoader: fake.loader })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, '102048888')
})

test('qqScan：无 startQrConnect 导出 → failed + 版本不兼容提示', async () => {
  const fake = makeFakeConnector({ shape: 'none' })
  const result = await qqScan({ store: makeStore(), connectorLoader: fake.loader })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /startQrConnect/)
  assert.match(result.message, /不兼容/)
})

test('qqScan：SDK 抛错 → failed + error.message 原样透传', async () => {
  const fake = makeFakeConnector({ error: new Error('二维码会话创建失败：服务端 500') })
  const result = await qqScan({ store: makeStore(), connectorLoader: fake.loader })
  assert.equal(result.status, 'failed')
  assert.equal(result.message, '二维码会话创建失败：服务端 500')
})

test('qqScan：超时（timeoutMs 极短 + 会话永不 resolve）→ failed 扫码超时', async () => {
  const fake = makeFakeConnector({ hang: true })
  const result = await qqScan({ store: makeStore(), connectorLoader: fake.loader, timeoutMs: 20 })
  assert.equal(result.status, 'failed')
  assert.equal(result.message, '扫码超时')
})

test('qqScan：onQr 收到二维码 URL（onQrCode → onQr 透传），onQr 抛错不致命', async () => {
  const urls = []
  const okResult = await qqScan({
    store: makeStore(),
    onQr: (url) => urls.push(url),
    connectorLoader: makeFakeConnector().loader,
  })
  assert.equal(okResult.status, 'ok')
  assert.deepEqual(urls, ['https://q.qq.com/qr/abc123'])
  // onQr 抛错（如终端二维码渲染失败）：吞掉，扫码结果不受影响
  const boomResult = await qqScan({
    store: makeStore(),
    onQr: () => { throw new Error('qr render boom') },
    connectorLoader: makeFakeConnector().loader,
  })
  assert.equal(boomResult.status, 'ok')
})

// ---------------------------------------------------------------- feishuRegister（7）

test('feishuRegister：成功 → ok + appId + openId + feishu:account 落盘含 at + addons 最小权限集', async () => {
  const store = makeStore()
  const fake = makeFakeSdk()
  const gotQr = []
  const result = await feishuRegister({ store, sdkLoader: fake.loader, onQr: (url) => gotQr.push(url) })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, 'cli_a1b2c3')
  assert.equal(result.openId, 'ou_scanner')
  assert.deepEqual(gotQr, ['https://open.feishu.cn/qr/xyz'], 'onQRCodeReady({url}) → onQr(url) 透传')
  const account = store.get('feishu:account')
  assert.equal(account.appId, 'cli_a1b2c3')
  assert.equal(account.appSecret, 'fs-secret')
  assert.equal(typeof account.at, 'number')
  // 调用形态：onQRCodeReady 回调 + 最小权限 addons（preset:false 不装全家桶）+ createOnly
  const options = fake.state.options[0]
  assert.equal(typeof options.onQRCodeReady, 'function')
  assert.equal(options.createOnly, true)
  assert.equal(options.addons.preset, false)
  // 新版 SDK normalizeAddons 白名单 preset/scopes/events/callbacks，已弃用旧 resources 名值映射。
  assert.deepEqual(options.addons.scopes, {
    tenant: [
      'im:message',
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg.include_bot:read',
      'im:message.group_at_msg.include_bot:readonly',
      'im:message.group_msg',
      'im:chat',
      'im:message:send_as_bot',
    ],
    user: [],
  })
  assert.deepEqual(options.addons.events, { items: { tenant: ['im.message.receive_v1'] } })
  assert.deepEqual(options.addons.callbacks, { items: ['card.action.trigger'] })
})

test('feishuRegister：缺包（loader reject Cannot find package）→ missing-sdk + 安装指引', async () => {
  const store = makeStore()
  const loader = async () => { throw moduleMissingError('@larksuiteoapi/node-sdk') }
  // 绝不 throw：直接 await 即隐含 doesNotReject（若 reject 本测试会以失败告终）
  const result = await feishuRegister({ store, sdkLoader: loader })
  assert.equal(result.status, 'missing-sdk')
  assert.match(result.message, /未安装 @larksuiteoapi\/node-sdk/)
  assert.match(result.message, /1\.61\.1/)
  assert.equal(store.keys().includes('feishu:account'), false, '缺包不落盘')
})

test('feishuRegister：default 导出兼容（default.registerApp）→ ok', async () => {
  const fake = makeFakeSdk({ shape: 'default' })
  const result = await feishuRegister({ store: makeStore(), sdkLoader: fake.loader })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, 'cli_a1b2c3')
})

test('feishuRegister：模块无 registerApp（<1.61.1 旧版）→ missing-sdk + 版本提示', async () => {
  const fake = makeFakeSdk({ shape: 'none' })
  const result = await feishuRegister({ store: makeStore(), sdkLoader: fake.loader })
  assert.equal(result.status, 'missing-sdk')
  assert.match(result.message, /registerApp/)
  assert.match(result.message, /1\.61\.1/)
})

test('feishuRegister：user_denied → denied + 中文提示', async () => {
  const store = makeStore()
  const fake = makeFakeSdk({ outcome: { status: 'user_denied' } })
  const result = await feishuRegister({ store, sdkLoader: fake.loader })
  assert.equal(result.status, 'denied')
  assert.match(result.message, /授权被拒绝/)
  assert.equal(store.keys().includes('feishu:account'), false, '拒绝授权不落盘')
})

test('feishuRegister：expired → expired + 二维码过期提示', async () => {
  const fake = makeFakeSdk({ outcome: { status: 'expired' } })
  const result = await feishuRegister({ store: makeStore(), sdkLoader: fake.loader })
  assert.equal(result.status, 'expired')
  assert.match(result.message, /过期/)
})

test('feishuRegister：超时（timeoutMs 极短 + registerApp 永不 resolve）→ failed 扫码超时', async () => {
  const fake = makeFakeSdk({ hang: true })
  const result = await feishuRegister({ store: makeStore(), sdkLoader: fake.loader, timeoutMs: 20 })
  assert.equal(result.status, 'failed')
  assert.equal(result.message, '扫码超时')
})

// ---------------------------------------------------------------- 落盘安全（2）

test('落盘安全：两模块成功后 store 凭证键存在且值为对象', async () => {
  const store = makeStore()
  const logs = []
  // log 为 CLI 契约函数形态（channel-login.mjs loginQq/loginFeishu 传 log: console.log）
  const qqResult = await qqScan({ store, connectorLoader: makeFakeConnector().loader, log: (m) => logs.push(m) })
  const fsResult = await feishuRegister({ store, sdkLoader: makeFakeSdk().loader, log: (m) => logs.push(m) })
  assert.equal(qqResult.status, 'ok')
  assert.equal(fsResult.status, 'ok')
  assert.equal(typeof store.get('qq:account'), 'object')
  assert.equal(store.get('qq:account') !== null, true)
  assert.equal(typeof store.get('feishu:account'), 'object')
  assert.equal(store.get('feishu:account') !== null, true)
  await tick(1)
  assert.ok(logs.length >= 2, 'log(message) 函数形态应被调用（CLI 契约）')
})

test('落盘安全：失败路径不写半截凭证（凭证数组无有效项 / client_secret 缺失 / denied）', async () => {
  // qq：resolve 出的凭证数组里没有任何 appId+appSecret 均非空的项
  const qqStore = makeStore()
  const qqResult = await qqScan({
    store: qqStore,
    connectorLoader: makeFakeConnector({ credentials: [{ appId: 'x' }, {}, null] }).loader,
  })
  assert.equal(qqResult.status, 'failed')
  assert.equal(qqStore.keys().includes('qq:account'), false)
  // feishu：client_id 有但 client_secret 缺 → 不落盘
  const halfStore = makeStore()
  const halfResult = await feishuRegister({
    store: halfStore,
    sdkLoader: makeFakeSdk({ outcome: { status: 'ok', client_id: 'cli_only' } }).loader,
  })
  assert.equal(halfResult.status, 'failed')
  assert.equal(halfStore.keys().includes('feishu:account'), false)
  // feishu：user_denied → 不落盘
  const deniedStore = makeStore()
  const deniedResult = await feishuRegister({
    store: deniedStore,
    sdkLoader: makeFakeSdk({ outcome: { status: 'user_denied' } }).loader,
  })
  assert.equal(deniedResult.status, 'denied')
  assert.equal(deniedStore.keys().includes('feishu:account'), false)
})
