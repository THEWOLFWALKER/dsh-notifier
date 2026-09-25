import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

test('home projection is compact and questions settle maps through one service', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  let settled = 0
  const service = createControlSurfaceService({
    revision,
    channels: {
      list: () => [{
        type: 'telegram',
        notify: { configured: true },
        control: null,
        health: { state: 'ready' },
      }],
      get: () => null,
    },
    outboundConfig: {},
    channelTest: async () => ({ ok: true }),
    tasks: { list: () => [{ taskRef: 'a', status: 'running', attention: false, boundChannels: [] }] },
    questions: {
      list: () => [{ ref: 'q1', question: 'Continue?', multiple: false, options: [{ value: '0', label: 'Yes' }], status: 'pending' }],
      settle: () => { settled += 1; return { settled: true, alreadyHandled: false } },
    },
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const home = await service.call('surface.home', {})
  assert.equal(home.ok, true)
  assert.equal(home.value.tasks.length, 1)
  assert.equal(home.value.questions.length, 1)
  assert.equal(home.value.channels.length, 1)
  assert.equal(home.value.summary.status, 'attention')

  const result = await service.call('questions.settle', { ref: 'q1', action: 'choose', options: ['0'] })
  assert.equal(result.ok, true)
  assert.equal(result.value.settled, true)
  assert.equal(settled, 1)
})

test('channel test distinguishes provider acceptance from explicit delivery receipt', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  let testResult = { ok: true, detail: 'provider accepted request' }
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: { raw: () => ({ token: 'configured' }) },
    channelTest: async () => testResult,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const accepted = await service.call('channels.test', { type: 'telegram' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.status, 'accepted')
  assert.equal(accepted.value.delivered, false)
  assert.equal(accepted.value.detail, 'provider accepted request')
  assert.equal(accepted.value.providerDetail, 'provider accepted request')
  assert.equal(activity.list()[0].title.zh, '测试消息已发送 · telegram')

  testResult = { ok: true, confirmed: true }
  const delivered = await service.call('channels.test', { type: 'telegram' })
  assert.equal(delivered.value.status, 'delivered')
  assert.equal(delivered.value.delivered, true)
})
