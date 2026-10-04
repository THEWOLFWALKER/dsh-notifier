// v0.14 S10：只读 canonical 诊断快照契约测试。
// 断言：读取永不抛（throwing getters 全降级）；unknown != failed；无 provider 证据 != healthy；
// 快照脱敏（不带 secret/webhook 全文/principal）；storage corrupt/unavailable 归一；
// 宿主能力缺失降级 unknown；control-surface `diagnostics.snapshot` 只读且不改 revision。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDiagnosticsService,
  buildDiagnosticsSnapshot,
  storageSnapshot,
  summarizeChannels,
  capabilitiesSnapshot,
  recentFailures,
} from '../src/control-surface/diagnostics.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const channelRow = (type, { configured = false, active = false, control = null, state = 'unconfigured', accepted = 0, delivered = 0 } = {}) => ({
  type,
  notify: { configured, active, applyMode: 'hot' },
  control,
  health: { state, accepted, delivered },
})

test('S10: storageSnapshot 归一 ready/corrupt/unavailable/unknown（不谎报）', () => {
  assert.equal(storageSnapshot({ readFailed: false }).state, 'ready')
  assert.equal(storageSnapshot({ readFailed: false }).writable, true)
  assert.equal(storageSnapshot({ corrupt: true }).state, 'corrupt')
  assert.equal(storageSnapshot({ status: 'unavailable' }).state, 'unavailable')
  assert.equal(storageSnapshot({ status: 'corrupt' }).writable, false)
  // 未知/非法形态 → unknown，绝不默认成 failed 或 ready 之间的任意谎报。
  assert.equal(storageSnapshot(null).state, 'unknown')
  assert.equal(storageSnapshot({ status: '待定' }).state, 'unknown')
  // 迁移摘要只输出计数/状态，不带路径。
  const withMigration = storageSnapshot({ readFailed: false, migration: { status: 'complete', migratedCount: 2, backupPath: '/secret/path' } })
  assert.equal(withMigration.migration.migratedCount, 2)
  assert.equal(JSON.stringify(withMigration).includes('/secret/path'), false)
})

test('S10: summarizeChannels 区分 healthy / noEvidence / degraded，无证据 != 健康', () => {
  const summary = summarizeChannels([
    channelRow('bark', { configured: true, active: true, state: 'healthy', delivered: 1 }),
    channelRow('webhook', { configured: true, active: true, state: 'ready' }), // 已配置但无证据
    channelRow('telegram', { configured: true, active: false, state: 'degraded', accepted: 1 }),
    channelRow('qq', { configured: false, state: 'unconfigured' }),
  ])
  assert.equal(summary.healthy, 1)
  assert.equal(summary.noEvidence, 1)
  assert.deepEqual(summary.noEvidenceTypes, ['webhook'])
  assert.equal(summary.degraded, 1)
  assert.deepEqual(summary.degradedTypes, ['telegram'])
  assert.deepEqual(summary.inactive, ['telegram'])
  assert.equal(summary.latestEvidence, 'confirmed')
})

test('S10: capabilitiesSnapshot 只回答可用性与计数，缺失即 unavailable', () => {
  const caps = capabilitiesSnapshot({
    questions: { list: () => [{}, {}] },
    sessions: { list: () => [{}] },
    bindings: { get: () => ({}), canEdit: true },
    members: { list: () => [], canRemove: false },
  })
  assert.deepEqual(caps.questions, { available: true, pending: 2 })
  assert.deepEqual(caps.sessions, { available: true, count: 1 })
  assert.deepEqual(caps.bindings, { available: true, editable: true })
  assert.deepEqual(caps.members, { available: true, removable: false })
  // 无注入：available 全 false，计数不出现（unknown != 0）。
  const empty = capabilitiesSnapshot({})
  assert.equal(empty.questions.available, false)
  assert.equal('pending' in empty.questions, false)
})

test('S10: recentFailures 只取 error 级、有界且脱敏', () => {
  const rows = [
    { at: '2026-01-01T00:00:00Z', category: 'notification', action: 'delivery-failed', level: 'error', detail: { en: 'sk-abcdefghijklmnop', zh: '失败' } },
    { at: '2026-01-01T00:00:00Z', category: 'control', action: 'member-updated', level: 'info' },
    ...Array.from({ length: 20 }, (_, i) => ({ at: '2026-01-01T00:00:00Z', category: 'x', action: `failed-${i}`, level: 'error' })),
  ]
  const out = recentFailures(rows)
  assert.equal(out.length, 10)
  assert.equal(out[0].action, 'delivery-failed')
  assert.equal(out[0].detail.en, '***', 'secret 形态被打码')
})

test('S10: throwing getters 全降级，快照永不抛，unknown 不制造 attention', () => {
  const boom = () => { throw new Error('getter exploded') }
  const snapshot = buildDiagnosticsSnapshot({
    version: boom,
    revision: { current: boom },
    hostCapabilities: boom,
    storage: boom,
    channels: { list: boom },
    questions: { list: boom },
    sessions: { list: boom },
    bindings: { get: boom },
    members: { list: boom },
    activity: { list: boom },
  })
  assert.equal(snapshot.version, 'unknown')
  assert.equal(snapshot.process.epoch, 'unknown')
  assert.equal(snapshot.process.revision, 0)
  assert.equal(snapshot.storage.state, 'unknown')
  assert.deepEqual(snapshot.host, { version: 'unknown', eventsMode: 'unknown', questionsMode: 'unknown', mediaImageInput: 'unknown' })
  assert.equal(snapshot.channels.total, 0)
  assert.deepEqual(snapshot.recentFailures, [])
  // unknown != failed：读取全失败不产生 attention（不谎报故障）。
  assert.equal(snapshot.attention.required, false)
})

test('S10: storage corrupt 触发 attention；无证据渠道不触发', () => {
  const corrupt = buildDiagnosticsSnapshot({
    version: '0.13.1',
    revision: { current: () => ({ epoch: 'e1', revision: 4 }) },
    storage: { corrupt: true },
    channels: { list: () => [channelRow('bark', { configured: true, active: true, state: 'ready' })] },
  })
  assert.equal(corrupt.storage.state, 'corrupt')
  assert.equal(corrupt.storage.writable, false)
  assert.equal(corrupt.attention.required, true)
  assert.deepEqual(corrupt.attention.reasons.map((r) => r.code), ['storage-untrusted'])

  // 只有「已配置无证据」的渠道：既非 healthy，也不触发 attention。
  const noEvidence = buildDiagnosticsSnapshot({
    version: '0.13.1',
    revision: { current: () => ({ epoch: 'e1', revision: 1 }) },
    storage: { readFailed: false },
    channels: { list: () => [channelRow('bark', { configured: true, active: true, state: 'ready' })] },
  })
  assert.equal(noEvidence.channels.healthy, 0)
  assert.equal(noEvidence.channels.noEvidence, 1)
  assert.equal(noEvidence.attention.required, false)
})

test('S10: 快照脱敏——secret/webhook 全文/principal 不出现', () => {
  const snapshot = buildDiagnosticsSnapshot({
    version: '0.13.1',
    revision: { current: () => ({ epoch: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', revision: 7 }) },
    hostCapabilities: () => ({ host: { version: 'Bearer abcdefghijklmnopqrstuvwxyz0123' }, events: { mode: 'dual' }, questions: { mode: 'native-event' }, media: { imageInput: 'available' } }),
    storage: { readFailed: false, migration: { status: 'complete', migratedCount: 1, reason: 'sk-abcdefghijklmnop leaked' } },
    channels: { list: () => [channelRow('bark', { configured: true, active: true, state: 'healthy', delivered: 1 })] },
    questions: { list: () => [] },
    sessions: { list: () => [] },
    bindings: { get: () => ({}), canEdit: true },
    members: { list: () => [], canRemove: true },
    now: () => 1_700_000_000_000,
  })
  const text = JSON.stringify(snapshot)
  assert.equal(text.includes('sk-abcdefghijklmnop'), false)
  assert.equal(text.includes('abcdefghijklmnopqrstuvwxyz0123'), false)
  // 非 secret 的进程标识（epoch UUID）保留。
  assert.equal(snapshot.process.epoch, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  // 只含 allowlist 形状，无任何原始配置字段值。
  assert.equal('fields' in (snapshot.channels ?? {}), false)
  assert.equal(snapshot.generatedAt, new Date(1_700_000_000_000).toISOString())
})

test('S10: control-surface diagnostics.snapshot 只读，不 touch revision / 不记 activity', async () => {
  const revision = createSurfaceRevision({ epoch: 'e1' })
  const activity = createSurfaceActivity({ now: () => 0 })
  const before = revision.current().revision
  const diagnostics = createDiagnosticsService({
    version: 'x',
    revision: { current: () => ({ epoch: 'e1', revision: 1 }) },
    storage: { readFailed: false },
    channels: { list: () => [] },
    now: () => 0,
  })
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    saveInbound: async () => ({}),
    channelTest: async () => ({ ok: true }),
    tasks: { list: () => [] },
    questions: { list: () => [] },
    members: null,
    activity,
    health: createSurfaceHealth(),
    storageStatus: {},
    launchTickets: { mint: () => ({ ticket: 't' }) },
    adminLocation: () => null,
    diagnostics,
  })

  const value = await service.call('diagnostics.snapshot')
  assert.equal(value.ok, true)
  assert.equal(value.value.version, 'x')
  assert.equal(value.value.storage.state, 'ready')
  assert.equal(revision.current().revision, before, '只读查询不得碰 revision')
  assert.deepEqual(activity.list({ limit: 5 }), [], '只读查询不得记 activity')

  // 未装配 diagnostics：能力不存在 → not-supported（Stage 4：白名单内方法未装配 = 能力缺失）。
  const bare = createControlSurfaceService({ revision: createSurfaceRevision(), channels: { list: () => [] }, activity: createSurfaceActivity(), health: createSurfaceHealth() })
  const missing = await bare.call('diagnostics.snapshot')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'dsh-notifier/not-supported')
})