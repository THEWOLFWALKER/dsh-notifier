// v0.13（C11.5 / B2）：CLI 凭证落盘真实性。
// 契约：授权成功 ≠ 登录成功——凭证必须先 durable 落盘成功，才允许输出成功文案、才允许做身份绑定。
// 落盘失败（磁盘/权限/锁）必须非零退出、如实报告、且绝不泄漏 secret。
//
// 可测入口：scripts/channel-login.mjs 的 applyDingtalkCredentials、
// scripts/wechat-login.mjs 的 applyWechatConfirmation、src/inbound 的 qqScan/feishuRegister。
// store 用选择性事务桩：transact 中若改动落入 failKeys 则 committed=false（模拟落盘失败）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDingtalkCredentials } from '../scripts/channel-login.mjs'
import { applyWechatConfirmation } from '../scripts/wechat-login.mjs'
import { qqScan } from '../src/inbound/_qq-scan.mjs'
import { feishuRegister } from '../src/inbound/_feishu-register.mjs'

/**
 * 选择性事务 store：接口对齐 createStore（get/set/keys/transact）。
 * transact 收集 draft 的键级改动，命中 failKeys 即 committed=false（磁盘/锁失败的等价形态），
 * 未命中则整体提交。这样可在同一 store 上让「凭证成功、绑定失败」等部分失败可复现。
 */
function makeTransactStore({ failKeys = new Set(), throwOnWrite = false } = {}) {
  const data = new Map()
  const changedKeys = (before, draft) => {
    const changed = []
    for (const key of Object.keys(draft)) {
      if (!before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(draft[key])) changed.push(key)
    }
    for (const key of before.keys()) if (!(key in draft)) changed.push(key)
    return changed
  }
  return {
    data,
    get(key, fallback = undefined) { return data.has(key) ? data.get(key) : fallback },
    set(key, value) { data.set(key, value); return true },
    keys(prefix = '') { return [...data.keys()].filter((key) => key.startsWith(prefix)) },
    transact(mutator) {
      if (throwOnWrite) throw new Error('disk locked')
      const before = new Map(data)
      const draft = Object.fromEntries(data)
      let value
      try { value = mutator(draft) } catch (error) { return { committed: false, error } }
      if (changedKeys(before, draft).some((key) => failKeys.has(key))) return { committed: false, value }
      for (const [key, item] of Object.entries(draft)) data.set(key, item)
      for (const key of before.keys()) if (!(key in draft)) data.delete(key)
      return { committed: true, value }
    },
  }
}

/** 收集 log/error sink 与退出码。 */
function makeSinks() {
  const out = []
  const err = []
  return { out, err, log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) }
}

// ---------------------------------------------------------------- DingTalk

test('钉钉：凭证 durable 成功 → 退出码 0，落盘 dingtalk:account，输出连接成功', () => {
  const store = makeTransactStore()
  const sink = makeSinks()
  const code = applyDingtalkCredentials({
    store,
    stateFile: '/tmp/state.json',
    credentials: { appKey: 'dingabc', appSecret: 'ding-secret' },
    log: sink.log,
    error: sink.error,
  })
  assert.equal(code, 0)
  assert.equal(sink.err.length, 0)
  assert.equal(store.get('dingtalk:account').appKey, 'dingabc')
  assert.match(sink.out.join('\n'), /钉钉连接成功：appKey=dingabc/)
})

test('钉钉：凭证落盘失败 → 退出码 1，无成功文案，错误提示写入失败', () => {
  const store = makeTransactStore({ failKeys: new Set(['dingtalk:account']) })
  const sink = makeSinks()
  const code = applyDingtalkCredentials({
    store,
    stateFile: '/tmp/state.json',
    credentials: { appKey: 'dingabc', appSecret: 'ding-secret' },
    log: sink.log,
    error: sink.error,
  })
  assert.equal(code, 1)
  assert.equal(store.get('dingtalk:account'), undefined, '失败不得留下半截凭证')
  assert.doesNotMatch(sink.out.join('\n'), /连接成功/)
  assert.match(sink.err.join('\n'), /凭证写入失败/)
})

test('钉钉：写抛异常同样按失败处理（非零退出、无成功文案）', () => {
  const store = makeTransactStore({ throwOnWrite: true })
  const sink = makeSinks()
  const code = applyDingtalkCredentials({
    store,
    stateFile: '/tmp/state.json',
    credentials: { appKey: 'dingabc', appSecret: 'ding-secret' },
    log: sink.log,
    error: sink.error,
  })
  assert.equal(code, 1)
  assert.doesNotMatch(sink.out.join('\n'), /连接成功/)
})

test('钉钉：凭证不完整 → 退出码 1，不泄漏任何 secret', () => {
  const store = makeTransactStore()
  const sink = makeSinks()
  const code = applyDingtalkCredentials({
    store,
    stateFile: '/tmp/state.json',
    credentials: { appKey: 'dingabc', appSecret: '' },
    log: sink.log,
    error: sink.error,
  })
  assert.equal(code, 1)
  assert.equal(store.get('dingtalk:account'), undefined)
  assert.doesNotMatch([...sink.out, ...sink.err].join('\n'), /ding-secret/)
})

// ---------------------------------------------------------------- WeChat

const WECHAT_OK = {
  ilink_bot_id: 'wx-bot-1',
  bot_token: 'wx-token-secret',
  baseurl: 'https://ilink.example',
  ilink_user_id: 'wx-user-9',
}

test('微信：凭证 durable 成功 → 退出码 0，落盘 wechat:account，扫码即配对为 owner', () => {
  const store = makeTransactStore()
  const sink = makeSinks()
  const code = applyWechatConfirmation({ store, statusResp: WECHAT_OK, stateFile: '/tmp/state.json', log: sink.log, error: sink.error })
  assert.equal(code, 0)
  assert.equal(store.get('wechat:account').accountId, 'wx-bot-1')
  const bindings = store.get('inbound:bindings')
  assert.equal(bindings['wechat:wx-user-9'].role, 'owner')
  assert.match(sink.out.join('\n'), /微信连接成功/)
})

test('微信：凭证落盘失败 → 退出码 1，不做身份绑定，无成功文案', () => {
  const store = makeTransactStore({ failKeys: new Set(['wechat:account']) })
  const sink = makeSinks()
  const code = applyWechatConfirmation({ store, statusResp: WECHAT_OK, stateFile: '/tmp/state.json', log: sink.log, error: sink.error })
  assert.equal(code, 1)
  assert.equal(store.get('wechat:account'), undefined)
  assert.equal(store.get('inbound:bindings'), undefined, '凭证未落盘绝不写绑定')
  assert.doesNotMatch(sink.out.join('\n'), /连接成功/)
  assert.match(sink.err.join('\n'), /凭证写入失败/)
})

test('微信：凭证成功但绑定失败 → 退出码 0，如实报告部分成功并提示补配', () => {
  const store = makeTransactStore({ failKeys: new Set(['inbound:bindings']) })
  const sink = makeSinks()
  const code = applyWechatConfirmation({ store, statusResp: WECHAT_OK, stateFile: '/tmp/state.json', log: sink.log, error: sink.error })
  assert.equal(code, 0)
  assert.equal(store.get('wechat:account').accountId, 'wx-bot-1', '凭证保持已保存')
  assert.equal(store.get('inbound:bindings'), undefined)
  assert.match(sink.out.join('\n'), /自动配对未完成/)
  assert.match(sink.out.join('\n'), /\/pair/)
})

test('微信：token 缺失 → 退出码 1，不泄漏 secret', () => {
  const store = makeTransactStore()
  const sink = makeSinks()
  const code = applyWechatConfirmation({
    store,
    statusResp: { ilink_bot_id: 'wx-bot-1', bot_token: '', baseurl: '', ilink_user_id: 'u1' },
    stateFile: '/tmp/state.json',
    log: sink.log,
    error: sink.error,
  })
  assert.equal(code, 1)
  assert.equal(store.get('wechat:account'), undefined)
  assert.doesNotMatch([...sink.out, ...sink.err].join('\n'), /wx-token-secret/)
})

// ---------------------------------------------------------------- QQ / Feishu

function qqConnector() {
  return async () => ({ startQrConnect: async () => [{ appId: '102048888', appSecret: 'qq-secret-1' }] })
}

test('QQ：凭证落盘失败 → status failed（绝不 ok），store 无 qq:account', async () => {
  const store = makeTransactStore({ failKeys: new Set(['qq:account']) })
  const result = await qqScan({ store, connectorLoader: qqConnector(), timeoutMs: 1000 })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /凭证写入失败/)
  assert.equal(store.get('qq:account'), undefined)
})

test('QQ：凭证落盘成功 → status ok + appId + qq:account', async () => {
  const store = makeTransactStore()
  const result = await qqScan({ store, connectorLoader: qqConnector(), timeoutMs: 1000 })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, '102048888')
  assert.equal(store.get('qq:account').appSecret, 'qq-secret-1')
})

function feishuSdk() {
  return async () => ({
    registerApp: async () => ({ status: 'ok', client_id: 'cli_a1b2c3', client_secret: 'fs-secret', user_info: { open_id: 'ou_x' } }),
  })
}

test('Feishu：凭证落盘失败 → status failed（绝不 ok），store 无 feishu:account', async () => {
  const store = makeTransactStore({ failKeys: new Set(['feishu:account']) })
  const result = await feishuRegister({ store, sdkLoader: feishuSdk(), timeoutMs: 1000 })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /凭证写入失败/)
  assert.equal(store.get('feishu:account'), undefined)
})

test('Feishu：凭证落盘成功 → status ok + appId + openId + feishu:account', async () => {
  const store = makeTransactStore()
  const result = await feishuRegister({ store, sdkLoader: feishuSdk(), timeoutMs: 1000 })
  assert.equal(result.status, 'ok')
  assert.equal(result.appId, 'cli_a1b2c3')
  assert.equal(result.openId, 'ou_x')
  assert.equal(store.get('feishu:account').appSecret, 'fs-secret')
})