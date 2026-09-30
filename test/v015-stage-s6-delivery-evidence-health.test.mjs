// v0.15（T12）投递证据与 health 收口回归。
//
// 锁定任务书 T12 与 U08/U09：
//   1. 证据三桶：accepted（provider 接受）/ delivered（显式回执=confirmed）/ unknown（结果不确定）
//      分开计数——成功无 receipt 只算 accepted，绝不写成 confirmed；
//   2. history 有界：window cap + TTL 淘汰，长跑进程不再无界累积；
//   3. epoch：runtime 实例换世代后旧实例的迟到观察一律丢弃（不污染新实例）；
//   4. 配置存在但无证据 → ready（绝不标 online/healthy）；unsupported 显式；
//   5. observer 失败绝不改业务结果（畸形 record 不抛、不阻断）；
//   6. status 带时间（observedAt/last*At）与世代（epoch）；
//   7. 端到端：超时 → audit 记 unknown 桶 + 健康面 unavailable，不重放。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSurfaceHealth, healthState, healthView, DEFAULT_HEALTH_TTL_MS } from '../src/control-surface/health.mjs'
import { createNotifier } from '../src/notify.mjs'
import * as bark from '../src/adapters/bark.mjs'

// ————————————————— 1. 证据三桶 —————————————————

test('T12 证据：accepted / delivered / unknown 三桶分开，成功无回执只算 accepted', () => {
  const health = createSurfaceHealth()
  // 成功但无显式回执 → 只算 accepted。
  health.recordSend({ accepted: ['bark'], confirmed: [], skipped: [], failed: [] })
  assert.equal(health.snapshot('bark').accepted, 1)
  assert.equal(health.snapshot('bark').delivered, 0, 'accepted 绝不写成 delivered/confirmed')
  // 显式回执 → 才算 delivered（confirmed）。
  health.recordSend({ accepted: ['telegram'], confirmed: ['telegram'], skipped: [], failed: [] })
  assert.equal(health.snapshot('telegram').delivered, 1)
  // legacy 记录：只有 delivered（旧语义=发送 resolve）→ 按 accepted 归类，不冒充 confirmed。
  health.recordSend({ delivered: ['slack'] })
  assert.equal(health.snapshot('slack').accepted, 1)
  assert.equal(health.snapshot('slack').delivered, 0)
})

test('T12 证据：unknown（超时等不确定结果）单独成桶，不计成功也不计失败', () => {
  const health = createSurfaceHealth()
  health.recordSend({ accepted: [], confirmed: [], unknown: ['bark'], skipped: [], failed: [] })
  const snap = health.snapshot('bark')
  assert.equal(snap.unknown, 1)
  assert.equal(snap.accepted, 0)
  assert.equal(snap.failed, 0)
  assert.ok(snap.lastUnknownAt > 0)
  assert.equal(snap.lastSuccessAt, null)
})

// ————————————————— 2. cap + TTL —————————————————

test('T12 有界：window 上限保留最近 N 条（cap）', () => {
  const health = createSurfaceHealth({ window: 5 })
  for (let i = 0; i < 20; i += 1) health.recordSend({ accepted: ['bark'], skipped: [], failed: [] })
  assert.equal(health.snapshot('bark').accepted, 5, 'history 必须有上限，不无界累积')
})

test('T12 有界：TTL 内观察保留，超期观察在 snapshot 时被淘汰', () => {
  let clock = 1_000_000
  const health = createSurfaceHealth({ window: 100, ttlMs: 1000, now: () => clock })
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [], time: new Date(clock).toISOString() })
  assert.equal(health.snapshot('bark').accepted, 1)
  // 推进过 TTL：旧观察淘汰，计数归零（不是永远记住一次成功）。
  clock += 5000
  const snap = health.snapshot('bark')
  assert.equal(snap.accepted, 0, '超过 TTL 的观察必须淘汰')
  assert.equal(snap.observedAt, null)
  assert.ok(DEFAULT_HEALTH_TTL_MS > 0)
})

// ————————————————— 3. epoch —————————————————

test('T12 epoch：换世代后旧实例观察一律丢弃，且 epoch 单调前进', () => {
  const health = createSurfaceHealth()
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [] })
  assert.equal(health.snapshot('bark').accepted, 1)
  const epoch = health.markEpoch('bark')
  assert.equal(epoch, 1)
  const snap = health.snapshot('bark')
  assert.equal(snap.accepted, 0, '断线/重启后旧实例的观察不得污染新实例')
  assert.equal(snap.epoch, 1)
  // 旧世代号不得把 epoch 打回去（单调）。
  health.markEpoch('bark', 0)
  assert.equal(health.snapshot('bark').epoch, 1)
})

test('T12 epoch：healthView 的 status 带 epoch 与观察时间', () => {
  // 用可控时钟：观察时间与 now() 同代，避免被 TTL 判为过期淘汰。
  const clock = Date.parse('2026-01-01T00:00:00.000Z')
  const health = createSurfaceHealth({ now: () => clock })
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [], time: new Date(clock).toISOString() })
  const view = healthView({ configured: true, active: true, health: health.snapshot('bark') })
  assert.equal(view.epoch, 0)
  assert.equal(view.observedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(view.accepted, 1)
  assert.equal(view.unknown, 0)
})

// ————————————————— 4. 状态语义 —————————————————

test('T12 状态：配置存在 + runtime 在跑但无证据 → ready（绝不标 online/healthy）', () => {
  const empty = createSurfaceHealth().snapshot('bark')
  assert.equal(healthState({ configured: true, active: true, health: empty }), 'ready')
  assert.notEqual(healthState({ configured: true, active: true, health: empty }), 'healthy')
})

test('T12 状态：最近一次结果不确定 → unavailable（证据不成立不宣称健康）；unsupported 显式', () => {
  const clock = Date.parse('2026-01-01T00:00:00.000Z')
  const health = createSurfaceHealth({ now: () => clock })
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [], time: new Date(clock).toISOString() })
  health.recordSend({ accepted: [], confirmed: [], unknown: ['bark'], skipped: [], failed: [], time: new Date(clock + 5000).toISOString() })
  assert.equal(healthState({ configured: true, active: true, health: health.snapshot('bark') }), 'unavailable')
  const view = healthView({ configured: true, active: true, health: health.snapshot('bark'), supported: false })
  assert.equal(view.state, 'unsupported', '不支持的渠道必须显式 unsupported，而非静默 healthy')
})

test('T12 状态：restartPending 优先于 evidence 健康度（未收敛不冒充健康）', () => {
  const health = createSurfaceHealth()
  health.recordSend({ accepted: ['bark'], skipped: [], failed: [] })
  assert.equal(healthState({ configured: true, active: true, health: health.snapshot('bark'), restartPending: true }), 'restart-pending')
})

// ————————————————— 5. observer 失败不改业务结果 —————————————————

test('T12 observer：畸形/缺字段 record 不抛错、不阻断后续记账', () => {
  const health = createSurfaceHealth()
  assert.doesNotThrow(() => health.recordSend({}))
  assert.doesNotThrow(() => health.recordSend({ accepted: 'not-array', failed: [{}, null], skipped: [1, 2] }))
  assert.doesNotThrow(() => health.recordTest('', null))
  assert.doesNotThrow(() => health.snapshot(undefined))
})

// ————————————————— 6. 端到端：超时 → unknown —————————————————

test('T12 端到端：超时失败记入 unknown 桶（健康面 unavailable），audit 仍不算 confirmed', async () => {
  const records = []
  const notifier = createNotifier({ logger: { warn() {} } }, [
    { type: 'bark', config: bark.resolve({ key: 'K1', timeoutMs: 1000 }) },
  ], { segment: { enabled: false }, onSend: (record) => records.push(record) })

  const original = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  try {
    const result = await notifier.notify('bark', { title: 't', content: 'c' })
    assert.equal(result.ok, false)
  } finally {
    globalThis.fetch = original
  }

  const record = records.at(-1)
  assert.deepEqual(record.unknown, ['bark'], '超时结果未知必须显式落入 unknown 桶')
  assert.deepEqual(record.confirmed, [])
  assert.equal(record.failed[0].uncertain, true)

  const health = createSurfaceHealth()
  health.recordSend(record)
  const snap = health.snapshot('bark')
  assert.equal(snap.unknown, 1)
  assert.equal(snap.accepted, 0, '超时不是接受证据')
  assert.equal(healthState({ configured: true, active: true, health: snap }), 'unavailable')
})