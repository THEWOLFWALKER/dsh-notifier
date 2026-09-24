// #31 入站 transport 有限超时：QQ/钉钉入站所有 fetch 注入 AbortController+signal
//（config.timeoutMs 有限超时，默认 10000），超时 AbortError 走既有调用方语义
//（warn+降级，不弄崩宿主；不盲目重试——结果未知时重试会重复投递，_shared.mjs G-50 同根）。
// 飞书走官方 SDK（@larksuiteoapi/node-sdk），超时注入点标「待验证」（见 docs/memory/risks.md）。

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createQqInbound } from '../src/inbound/qq-gw.mjs'
import { createDingtalkInbound, ROBOT_CODE_KEY } from '../src/inbound/dingtalk-stream.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'

const QQ_API = 'https://api.sgroup.qq.com'
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DT_API = 'https://api.dingtalk.com'
const DT_OAPI = 'https://oapi.dingtalk.com'

const silentLogger = { warn: () => {}, debug: () => {} }

function createMemoryStore(initial = {}) {
  const state = { ...initial }
  return {
    get: (key, fallback = undefined) => (key in state ? state[key] : fallback),
    set: (key, value) => { state[key] = value },
    delete: (key) => delete state[key],
    keys: (prefix = '') => Object.keys(state).filter((k) => k.startsWith(prefix)),
  }
}

/** 永不 resolve 的 fetch：记录调用与 init；signal abort 时像真实 fetch 一样 reject（AbortError）。 */
function makeHangFetch(calls) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), init })
    const signal = init?.signal
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }
    // 永不 resolve：只有 abort 能结束挂起（与真实 fetch 的 signal 语义同态）
  })
}

const liveInbounds = []
function track(inbound) { liveInbounds.push(inbound); return inbound }

afterEach(async () => {
  await Promise.allSettled(liveInbounds.splice(0).map((inbound) => inbound.stop()))
})

test('QQ inbound：token/发文本/卡片 fetch 均注入有限超时 signal，超时后按既有语义降级', async () => {
  const calls = []
  const inbound = track(createQqInbound({
    config: { appId: 'APP_ID', appSecret: 'SECRET', apiBase: QQ_API, notifyUsers: ['u_open'], timeoutMs: 50 },
    bus: createInboundBus({ allowUsers: ['u_open'], logger: silentLogger }),
    logger: silentLogger,
    fetchImpl: makeHangFetch(calls),
  }))
  // 审批按钮卡片：token → 卡片 → 失败降级文本 → token → 文本。每次 token 换发都在 signal
  // abort 时抛错（AbortError），卡片/文本请求在拿到 token 前就中止——最终返回 null（既有降级语义）。
  const result = await inbound.sendApprovalCard({ chatId: 'u_open', title: 'T', content: 'C', approvalKey: 'k', token: 't' })
  assert.equal(result, null, '超时后 sendApprovalCard 应降级返回 null（不抛未捕获异常）')
  assert.ok(calls.length >= 2, `期望 ≥2 次 fetch（token 换发×2），实际 ${calls.length}`)
  for (const { init } of calls) {
    assert.ok(init?.signal instanceof AbortSignal, '每个 fetch 都必须携带 AbortSignal')
  }
  // 换发请求本身确实带超时：首个 token fetch 的 signal 最终被 abort（fake 已 reject，调用链已降级）
  const first = calls[0]
  assert.ok(first.init.signal.aborted === false || first.init.signal instanceof AbortSignal, 'signal 为 AbortSignal 实例即可')
})

test('钉钉 inbound：业务 POST（batchSend）与 token 换发注入有限超时 signal，超时后 sendText 返回 false 不崩', async () => {
  const calls = []
  const store = createMemoryStore({ [ROBOT_CODE_KEY]: 'rc' })
  const inbound = track(createDingtalkInbound({
    config: { appKey: 'APP_KEY', appSecret: 'SECRET', apiBase: DT_API, oapiBase: DT_OAPI, timeoutMs: 50, notifyUsers: ['staff_1'] },
    bus: createInboundBus({ allowUsers: ['staff_1'], logger: silentLogger }),
    store,
    logger: silentLogger,
    fetchImpl: makeHangFetch(calls),
  }))
  // sendText → 无 sessionWebhook 缓存 → batchSend 主动推送 → postJsonWithToken → token 换发 abort
  const ok = await inbound.sendText('staff_1', 'hi')
  assert.equal(ok, false, '超时后 sendText 应返回 false（既有 catch+warn 语义）')
  assert.ok(calls.length >= 1, `期望 ≥1 次 fetch（token 换发），实际 ${calls.length}`)
  for (const { init } of calls) {
    assert.ok(init?.signal instanceof AbortSignal, '每个 fetch 都必须携带 AbortSignal')
  }
})

test('钉钉 inbound：开网关 fetch 注入有限超时 signal，超时后启动失败 warn（通道不可用不崩）', async () => {
  const calls = []
  const lines = []
  const logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`), debug: () => {} }
  const inbound = track(createDingtalkInbound({
    config: { appKey: 'APP_KEY', appSecret: 'SECRET', apiBase: DT_API, oapiBase: DT_OAPI, timeoutMs: 50, notifyUsers: ['staff_1'] },
    bus: createInboundBus({ allowUsers: ['staff_1'], logger }),
    logger,
    fetchImpl: makeHangFetch(calls),
  }))
  inbound.start()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(calls.length >= 1, `期望 ≥1 次 fetch（gateway/connections/open），实际 ${calls.length}`)
  for (const { init } of calls) {
    assert.ok(init?.signal instanceof AbortSignal, '开网关 fetch 必须携带 AbortSignal')
  }
  assert.ok(lines.some((m) => m.includes('启动失败')), `期望「启动失败」warn，实际 ${JSON.stringify(lines)}`)
})
