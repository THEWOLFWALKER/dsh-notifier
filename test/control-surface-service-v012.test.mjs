import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { healthState } from '../src/control-surface/health.mjs'

// v0.15 Stage 4（S402/S405）：daily control-surface 收敛为显式白名单。
// 旧 surface.home / questions.settle / channels.test / channels.save 等已删除——
// 即便注入了它们的依赖，白名单外一律 not-supported（能力不存在，而不是 UI 不可见）。
// 仍保留的 secondary（surface.wait / diagnostics.snapshot / portability.* / cloudflare.* …）
// 由 secondary-service 覆盖其行为。

test('Stage 4（S402）：legacy surface.home / questions.settle / channels.test / channels.save 已删除', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  let settled = 0
  // 故意注入全部旧依赖：证明「注入存在」不等于「能力存在」。
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    channelTest: async () => ({ ok: true }),
    saveInbound: async () => ({ saved: true }),
    tasks: { list: () => [] },
    questions: {
      list: () => [],
      settle: () => { settled += 1; return { settled: true, alreadyHandled: false } },
    },
    activity,
    health,
    storageStatus: () => ({ readFailed: false }),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const legacyCalls = [
    ['surface.home', {}],
    ['questions.list', {}],
    ['questions.settle', { ref: 'q1', action: 'choose', options: ['0'] }],
    ['channels.list', {}],
    ['channels.test', { type: 'telegram' }],
    ['channels.save', { type: 'telegram', direction: 'inbound', patch: { botToken: 'x' } }],
    ['tasks.list', {}],
    ['members.list', {}],
    ['pairing.list', {}],
  ]
  const before = revision.current().revision
  for (const [method, payload] of legacyCalls) {
    const result = await service.call(method, payload)
    assert.equal(result.ok, false, `${method} 必须被拒`)
    assert.equal(result.error.code, 'dsh-notifier/not-supported', `${method} 是能力不存在`)
  }
  assert.equal(settled, 0, '被拒的 questions.settle 绝不触达旧结算实现')
  assert.equal(revision.current().revision, before, '被拒的调用绝不推进 revision')
  assert.deepEqual(activity.list(), [], '被拒的调用绝不记 activity')
})

test('v0.13：surface.wait capacity 保留退避信息；被拒的 legacy 写入不推进 revision/activity', async () => {
  const revision = createSurfaceRevision({ maxWaiters: 1 })
  const activity = createSurfaceActivity()
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    saveInbound: async () => ({ saved: false }),
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health: createSurfaceHealth(),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
  const first = service.call('surface.wait', { after: revision.current().revision, timeoutMs: 30_000 })
  const capacity = await service.call('surface.wait', { after: revision.current().revision, timeoutMs: 30_000 })
  assert.equal(capacity.ok, true)
  assert.equal(capacity.value.capacity, true)
  assert.ok(capacity.value.retryAfterMs >= 500)

  const before = revision.current().revision
  const rejected = await service.call('channels.save', { type: 'telegram', direction: 'inbound', patch: { botToken: 'x' } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'dsh-notifier/not-supported')
  assert.equal(revision.current().revision, before, '被拒的写入不推进 revision')
  assert.deepEqual(activity.list(), [], '被拒的写入不记 activity')
  revision.dispose()
  await first
})

test('health 投影：accepted 只记 accepted，configured 但 inactive 进入 degraded/attention', () => {
  const health = createSurfaceHealth()
  health.recordTest('telegram', { ok: true })
  assert.equal(health.snapshot('telegram').accepted, 1)
  assert.equal(health.snapshot('telegram').delivered, 0)
  assert.equal(healthState({ configured: true, active: false, health: health.snapshot('telegram') }), 'degraded')
})

test('v0.13：Native projection 默认不返回未声明字段或入站 secret', () => {
  const projection = createChannelProjection({
    outboundConfig: {
      raw: () => ({ token: 'outbound-secret', accountId: 'acct' }),
      describe: () => ({
        configured: true,
        active: true,
        fields: { token: { required: true }, accountId: { secret: false } },
        configRevision: 1,
      }),
    },
    inboundConfig: { version: 7 },
    adminApi: {
      getChannels: () => [{
        type: 'telegram', direction: 'inbound', configured: true, enabled: true,
        fields: { botToken: { required: true } }, config: { botToken: 'inbound-secret' },
      }],
    },
    health: createSurfaceHealth(),
  })
  const row = projection.get('telegram')
  assert.equal(row.notify.fields.token.secret, true)
  assert.equal(row.notify.editableValues.token, undefined)
  assert.equal(row.notify.editableValues.accountId, 'acct')
  assert.equal(row.control.fields.botToken.secret, true)
  assert.equal(row.control.configRevision, 7)
  assert.deepEqual(row.control.editableValues, {})
  assert.doesNotMatch(JSON.stringify(row), /outbound-secret|inbound-secret/)
})