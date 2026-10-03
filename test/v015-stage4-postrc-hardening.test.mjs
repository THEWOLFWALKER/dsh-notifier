// dsh-notifier v0.15 Stage 4 — Post-RC Contract & Surface Hardening acceptance tests.
//
// 任务包：DSH-NOTIFIER-V015-STAGE4-POSTRC-HARDENING-V1
// 这些用例把「能力不存在」而非「UI 不可见」当作验收对象（Release Truth Gaps）。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_METHODS,
  NATIVE_READ_METHODS,
  NATIVE_ACTION_METHODS,
  createNativeSurfaceService,
} from '../src/native/register.mjs'
import {
  DAILY_ALLOWED_METHODS,
  SECONDARY_METHODS,
  isDailyAllowedMethod,
  REMOVED_LEGACY_PREFIXES,
} from '../src/control-surface/surface-allowlist.mjs'

// ————————————————————————— 夹具 —————————————————————————

/** 全量 read model：为本文件提供最小可调用实现。 */
function makeReadModel() {
  return {
    snapshot: () => ({ cursor: 'abc.1', rail: [] }),
    channel: (type) => (type === 'telegram' ? { type } : null),
    privateChat: () => ({ channels: [] }),
    pending: () => [],
    wait: async () => ({ cursor: 'abc.2', changed: true }),
  }
}

/** 全量 actions：每个方法只回显调用，便于断言「handler 存在」。 */
function makeActions() {
  const echo = (payload) => ({ echoed: true, payload })
  return {
    selectTask: echo,
    saveChannel: echo,
    saveInboundChannel: async (payload) => echo(payload),
    removeChannel: echo,
    testChannel: async (payload) => echo(payload),
    settlePending: echo,
    updateUser: echo,
    removeUser: echo,
    approveUser: echo,
    dismissUser: echo,
    mintPairing: echo,
    revokePairing: echo,
  }
}

// ——————————————————————— S401 — Native registry invariant ———————————————————————

test('S401 native.selectTask 已登记进声明方法面且不重复', () => {
  assert.ok(NATIVE_METHODS.includes('native.selectTask'), 'native.selectTask 必须出现在 NATIVE_METHODS')
  assert.equal(new Set(NATIVE_METHODS).size, NATIVE_METHODS.length, 'NATIVE_METHODS 不得有重复项')
  const union = [...NATIVE_READ_METHODS, ...NATIVE_ACTION_METHODS]
  assert.equal(union.length, NATIVE_METHODS.length, 'read ∪ action 必须与 NATIVE_METHODS 等长')
  assert.deepEqual([...union].sort(), [...NATIVE_METHODS].sort(), 'read ∪ action 必须精确等于 NATIVE_METHODS')
})

test('S401 handler table 与声明方法面精确一致：每个声明方法都可调用，未声明方法不可调用', async () => {
  const service = createNativeSurfaceService({ readModel: makeReadModel(), actions: makeActions() })
  assert.deepEqual(service.methods, NATIVE_METHODS)

  const payloadFor = (method) => {
    if (method === 'native.channel') return { type: 'telegram' }
    if (method === 'native.settlePending') return { ref: 'r', action: 'approve', options: [] }
    if (method === 'native.selectTask') return { taskRef: 't' }
    return {}
  }
  for (const method of NATIVE_METHODS) {
    const result = await service.call(method, payloadFor(method))
    // 有 handler 的方法绝不会返回 bad-request（unknown-method）——证明声明面没有「声明了却没实现」。
    assert.notEqual(result?.error?.code, 'dsh-notifier/bad-request', `${method} 应有 handler 实现`)
  }

  // 未声明方法不得偷偷可调用（call() 只认 handler table）。
  const undeclared = await service.call('native.definitely-not-a-method', {})
  assert.equal(undeclared.error.code, 'dsh-notifier/bad-request')
})

// ——————————————————————— 最终 surface allowlist ———————————————————————

test('daily allowlist 精确包含全部 Native 方法，且不含已删除的 legacy 方法族', () => {
  for (const method of NATIVE_METHODS) assert.ok(isDailyAllowedMethod(method), `${method} 应在 allowlist 中`)
  for (const method of SECONDARY_METHODS) assert.ok(isDailyAllowedMethod(method), `${method} 应在 allowlist 中`)
  assert.ok(DAILY_ALLOWED_METHODS.includes('surface.wait'))
  assert.ok(!isDailyAllowedMethod('standalone.createLaunch'), '无 UI 调用者的启动票据 RPC 不保留在日常面')
  assert.ok(!isDailyAllowedMethod('surface.home'))
  for (const prefix of REMOVED_LEGACY_PREFIXES) {
    assert.ok(!DAILY_ALLOWED_METHODS.some((method) => method === prefix || method.startsWith(prefix)),
      `daily allowlist 不得包含 legacy：${prefix}`)
  }
  assert.equal(new Set(DAILY_ALLOWED_METHODS).size, DAILY_ALLOWED_METHODS.length, 'allowlist 不得有重复项')
})
