// v0.13（C11.5 / R4）测试：投递证据语义收敛。
// 契约：provider 接受请求（accepted）≠ 端到端送达（confirmed）。
// 只有适配器显式回执 { confirmed|receipt: true } 才能称「已确认送达」。
// 覆盖：词汇权威（isConfirmedReceipt / normalizeDeliveryEvidence）、
// health 计数分层、activity 动作分层、notifyAll 结果形状与 legacy 别名。

import test from 'node:test'
import assert from 'node:assert/strict'
import { isConfirmedReceipt, normalizeDeliveryEvidence } from '../src/delivery-evidence.mjs'
import { createSurfaceHealth, healthState } from '../src/control-surface/health.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createNotifier } from '../src/notify.mjs'
import { resolveConfig } from '../src/config.mjs'

// ---------------------------------------------------------------- 词汇权威

test('R4：isConfirmedReceipt 只认显式回执，普通 resolve 一律 accepted', () => {
  assert.equal(isConfirmedReceipt({ confirmed: true }), true)
  assert.equal(isConfirmedReceipt({ receipt: true }), true)
  assert.equal(isConfirmedReceipt(undefined), false, 'adapter resolve undefined = 仅 accepted')
  assert.equal(isConfirmedReceipt(null), false)
  assert.equal(isConfirmedReceipt({}), false)
  assert.equal(isConfirmedReceipt({ ok: true, status: 200 }), false, 'HTTP 2xx 不是送达证据')
  assert.equal(isConfirmedReceipt({ confirmed: 'true' }), false, '只认布尔 true，不认真值字符串')
})

test('R4：normalizeDeliveryEvidence——legacy delivered 归 accepted，绝不升格 confirmed', () => {
  assert.deepEqual(normalizeDeliveryEvidence({ delivered: ['webhook'] }), { accepted: ['webhook'], confirmed: [] })
  assert.deepEqual(
    normalizeDeliveryEvidence({ accepted: ['a'], confirmed: ['b'], delivered: ['a'] }),
    { accepted: ['a'], confirmed: ['b'] },
  )
  assert.deepEqual(normalizeDeliveryEvidence({}), { accepted: [], confirmed: [] })
  assert.deepEqual(normalizeDeliveryEvidence(undefined), { accepted: [], confirmed: [] })
})

// ---------------------------------------------------------------- health 分层

test('R4：health——accepted 只计 accepted，不算 delivered；confirmed 才计 delivered', () => {
  const health = createSurfaceHealth({ window: 20 })
  health.recordSend({ accepted: ['telegram'], confirmed: [], delivered: ['telegram'] })
  const afterAccepted = health.snapshot('telegram')
  assert.equal(afterAccepted.accepted, 1)
  assert.equal(afterAccepted.delivered, 0, '无回执不得计入 delivered')

  health.recordSend({ accepted: [], confirmed: ['telegram'], delivered: [] })
  assert.equal(health.snapshot('telegram').delivered, 1)
  assert.equal(health.snapshot('telegram').accepted, 1)
})

test('R4：health——legacy record（仅 delivered 字段）按 accepted 归类', () => {
  const health = createSurfaceHealth({ window: 20 })
  health.recordSend({ delivered: ['bark'] })
  const snap = health.snapshot('bark')
  assert.equal(snap.accepted, 1)
  assert.equal(snap.delivered, 0, 'legacy delivered 字段不得被当作已确认送达')
})

test('R4：healthState——accepted 已属操作健康，但 UI 标签仍与 confirmed 区分', () => {
  const health = createSurfaceHealth({ window: 20 })
  health.recordSend({ accepted: ['telegram'], confirmed: [] })
  const snap = health.snapshot('telegram')
  assert.equal(healthState({ configured: true, active: true, health: snap }), 'healthy')
  assert.equal(snap.delivered, 0, 'healthy 状态不等于有送达证据')
})

// ---------------------------------------------------------------- activity 分层

test('R4：activity——accepted → 已发送到提供方；confirmed → 已确认送达', () => {
  const activity = createSurfaceActivity({ now: () => Date.parse('2026-09-26T00:00:00Z') })
  const accepted = activity.recordDelivery({ ok: true, accepted: ['telegram'], confirmed: [], delivered: ['telegram'] })
  assert.equal(accepted.action, 'delivery-finished')
  const acceptedTitle = activity.list()[0].title.zh
  assert.match(acceptedTitle, /已发送到提供方/)
  assert.doesNotMatch(acceptedTitle, /已送达/)

  const confirmed = activity.recordDelivery({ ok: true, accepted: [], confirmed: ['telegram'], delivered: [] })
  assert.equal(confirmed.action, 'delivery-confirmed')
  assert.match(activity.list()[0].title.zh, /已确认送达/)
})

test('R4：activity——失败不进 accepted/confirmed，动作归类 delivery-failed', () => {
  const activity = createSurfaceActivity({ now: () => Date.parse('2026-09-26T00:00:00Z') })
  const row = activity.recordDelivery({ ok: false, accepted: [], confirmed: [], delivered: [], failed: [{ channel: 'telegram', error: 'HTTP 500' }] })
  assert.equal(row.action, 'delivery-failed')
  assert.deepEqual(row.detail.accepted, [])
  assert.deepEqual(row.detail.confirmed, [])
})

// ---------------------------------------------------------------- notifyAll 形状

test('R4：notifyAll——无回执成功 accepted=1/confirmed=0，delivered 为 legacy 别名', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  try {
    const resolved = resolveConfig({ channels: [{ type: 'webhook', url: 'http://x/hook' }] })
    assert.equal(resolved.skipped.length, 0)
    const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels)
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.accepted, ['webhook'])
    assert.deepEqual(result.confirmed, [], 'API 2xx 无显式回执 → confirmed 必须为空')
    assert.deepEqual(result.delivered, ['webhook'], 'delivered 保留为 legacy 别名（== accepted）')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('R4：notifyAll——失败渠道不进 accepted/confirmed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  try {
    const resolved = resolveConfig({ channels: [{ type: 'webhook', url: 'http://x/hook' }] })
    const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels)
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.ok, false)
    assert.deepEqual(result.accepted, [])
    assert.deepEqual(result.confirmed, [])
    assert.deepEqual(result.delivered, [])
    assert.equal(result.failed.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})