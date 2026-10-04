// v0.14（Stage F）— 可观测性收口：revision / activity 唯一 owner + Support Report secret audit。
//
// 目标（任务书 Stage F / 01-findings P2-01）：
//   1. single revision owner —— 一次用户动作只推进一代 revision；
//   2. single activity owner —— 一次用户动作只记一条 activity；
//   3. Support Report（= diagnostics.snapshot 的确定性序列化）绝不含 secret 原文。
//
// 出站保存的 domain event 唯一 owner 是 OutboundConfigService 的 onChange/onAudit（Native 与
// Admin 共用同一实例）；入站没有 domain event，故由 surface 自持一次记账。测试同时覆盖两条路径。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createChannelControlService } from '../src/control-plane/channels.mjs'
import { createNativeActions } from '../src/native/actions.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { buildDiagnosticsSnapshot } from '../src/control-surface/diagnostics.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v014-stage-f-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

/** 与装配层（src/index.mjs）逐字节同形的 domain event 接线。 */
function wireDomainEvents({ outboundConfig, revision, activity }) {
  return {
    onChange: (topic) => revision.touch(topic),
    onAudit: (topic, detail) => activity.record('configuration', topic, {
      channel: detail?.type,
      saved: detail?.saved === true,
      deleted: detail?.deleted === true,
      hotApplied: detail?.applied === true,
    }),
  }
}

function makeSurface({ revision, activity, channelControl, diagnostics = null }) {
  return createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    channelControl,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    diagnostics,
    activity,
    health: createSurfaceHealth(),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
}

test('F1 outbound save advances revision and records activity exactly once (single domain owner)', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const outboundConfig = createOutboundConfigService({
    store, yamlRows: new Map(), source, allowLegacy: false,
    ...wireDomainEvents({ revision, activity }),
  })
  const channelControl = createChannelControlService({ outboundConfig })
  const actions = createNativeActions({ channelControl, revision, activity })

  // Stage 4（S402）：daily 通话面已无 channels.save——出站保存唯一入口是 native.saveChannel。
  const surface = makeSurface({ revision, activity, channelControl })
  const rejected = await surface.call('channels.save', { type: 'bark', direction: 'outbound', patch: { key: 'k' } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'dsh-notifier/not-supported', '旧 channels.save 已删除')

  const revisionBefore = revision.current().revision
  const activityBefore = activity.list().length
  const saved = actions.saveChannel({ type: 'bark', patch: { key: 'k' } })
  assert.equal(saved.saved, true)

  assert.equal(revision.current().revision, revisionBefore + 1, '一次出站保存只推进一代 revision')
  assert.equal(activity.list().length, activityBefore + 1, '一次出站保存只记一条 activity')
  assert.equal(activity.list()[0].category, 'configuration')
  assert.match(activity.list()[0].title.zh, /bark/, 'activity 记录携带渠道类型')

  // 重复保存（含 unchanged 早退分支）仍各只记一次，不叠加。
  const revisionAgain = revision.current().revision
  const activityAgain = activity.list().length
  actions.saveChannel({ type: 'bark', patch: { key: 'k' } })
  assert.equal(revision.current().revision, revisionAgain + 1, '重复保存同样只推进一代')
  assert.equal(activity.list().length, activityAgain + 1, '重复保存同样只记一条')
  revision.dispose()
})

test('F2 inbound save is recorded once by the native action (no domain event owner)', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  let putCount = 0
  const outboundConfig = createOutboundConfigService({
    store, yamlRows: new Map(), source, allowLegacy: false,
    ...wireDomainEvents({ revision, activity }),
  })
  // 入站没有 domain event：native action 自持记账，但仍经共享 ChannelControlService 落盘。
  const channelControl = createChannelControlService({
    outboundConfig,
    saveInbound: async (type) => { putCount += 1; return { saved: true, type, direction: 'inbound', configRevision: putCount } },
  })
  const actions = createNativeActions({ channelControl, revision, activity })

  const revisionBefore = revision.current().revision
  const activityBefore = activity.list().length
  const saved = await actions.saveInboundChannel({ type: 'telegram', patch: { botToken: 'x' } })
  assert.equal(saved.saved, true)
  assert.equal(putCount, 1)
  assert.equal(revision.current().revision, revisionBefore + 1, '入站保存由 native action 唯一记账一次 revision')
  assert.equal(activity.list().length, activityBefore + 1, '入站保存由 native action 唯一记账一次 activity')
  assert.equal(activity.list()[0].category, 'configuration')
  assert.match(activity.list()[0].title.zh, /telegram/)
  revision.dispose()
})

test('F3 support report (diagnostics snapshot) never carries secret material', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const snapshot = buildDiagnosticsSnapshot({
    version: '0.14.0',
    revision: { current: () => ({ epoch: 'epoch-1', revision: 7 }) },
    hostCapabilities: () => ({
      host: { version: '1.2.3' },
      events: { mode: 'current' },
      questions: { mode: 'current' },
      media: { imageInput: 'available' },
    }),
    storage: () => ({ readFailed: false, migration: { status: 'complete', migratedCount: 2, backupCreated: true } }),
    channels: {
      // 渠道行故意夹带 secret 原文：summarizeChannels 只读 type/notify/control/health，绝不回显。
      list: () => [{
        type: 'telegram',
        notify: { configured: true, active: true, restartPending: false, diverged: false },
        control: null,
        health: { state: 'ready', accepted: 1, delivered: 0 },
        fields: { botToken: JWT, secret: HEX },
        config: { botToken: JWT },
      }],
    },
    questions: { list: () => [] },
    sessions: { list: () => [] },
    bindings: { get: () => ({}), canEdit: true },
    members: { list: () => [], canRemove: true },
    activity: {
      list: () => [{
        level: 'error',
        at: '2026-09-30T00:00:00.000Z',
        category: 'notification',
        action: 'channel-test-failed',
        // 既含 key 形 secret（会被 key 脱敏），也含仅靠形态识别的 token。
        detail: { en: `auth failed, botToken=${JWT}`, zh: `Bearer ${HEX}` },
        token: JWT,
      }],
    },
    now: () => Date.parse('2026-09-30T00:00:00.000Z'),
  })

  const text = JSON.stringify(snapshot)
  for (const secret of [JWT, HEX]) {
    assert.equal(text.includes(secret), false, `Support Report 不得含 secret 原文: ${secret}`)
  }
  // 渠道原始配置对象本身绝不进快照（summarizeChannels 只输出类型与状态计数）。
  assert.equal('fields' in snapshot.channels, false)
  assert.equal('config' in snapshot.channels, false)
})

test('F4 diagnostics.snapshot RPC re-applies redaction on the support-report payload', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({
    store, yamlRows: new Map(), source, allowLegacy: false,
    ...wireDomainEvents({ revision, activity }),
  })
  const channelControl = createChannelControlService({ outboundConfig })
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const diagnostics = {
    snapshot: () => buildDiagnosticsSnapshot({
      version: '0.14.0',
      revision,
      hostCapabilities: () => ({ host: { version: '1.2.3' }, events: { mode: 'current' }, questions: { mode: 'current' }, media: { imageInput: 'available' } }),
      storage: () => ({ readFailed: false }),
      channels: { list: () => [{ type: 'telegram', notify: { configured: true, active: true }, control: null, health: { state: 'ready' }, fields: { botToken: JWT } }] },
      questions: { list: () => [] },
      sessions: { list: () => [] },
      bindings: { get: () => ({}), canEdit: true },
      members: { list: () => [], canRemove: true },
      activity: { list: () => [{ level: 'error', at: '2026-09-30T00:00:00.000Z', category: 'notification', action: 'channel-test-failed', detail: { en: `token=${JWT}` } }] },
        now: () => Date.parse('2026-09-30T00:00:00.000Z'),
    }),
  }
  const surface = makeSurface({ revision, activity, channelControl, diagnostics })
  const result = await surface.call('diagnostics.snapshot')
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result.value).includes(JWT), false, 'RPC 快照不得含 JWT 原文')
  revision.dispose()
})