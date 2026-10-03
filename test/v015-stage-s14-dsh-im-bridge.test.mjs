// v0.15 Stage S14 (T22) — optional dsh-im delivery bridge.
//
// Acceptance D01–D05 from 04-ACCEPTANCE-AND-REVIEW.md:
//   D01 no dsh-im → core still fine; bridge reports unavailable (with a reason).
//   D02 service appears late / disappears / is recreated → the current reference is
//       replaced/cleaned; the old object never keeps sending.
//   D03 real delivery-service + fake channel → botId/targetId/text/options are passed
//       through correctly; a stable opaque id is never prefix-guessed.
//   D04 sent=true / timeout / cancel / error → accepted / unknown mapped accurately,
//       with no blind cross-provider retry.
//   D05 target removed/changed / no target / unsupported format → never auto-switch
//       targets; never fabricate media/card capability.
//
// These drive the **real** production module `src/control-plane/dsh-im-bridge.mjs`
// (no re-implementation) and, for the wiring, the real `src/control-surface/service.mjs`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshImBridge } from '../src/control-plane/dsh-im-bridge.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deliveryService(overrides = {}) {
  let calls = { send: [], listBots: [], listTargets: [] }
  const service = {
    send: async (...args) => { calls.send.push(args); return overrides.sendResult ?? true },
    listBots: async () => { calls.listBots.push([]); return overrides.bots ?? [] },
    listTargets: async (botId) => { calls.listTargets.push(botId); return overrides.targets ?? [] },
  }
  return { service, calls, ...overrides }
}

test('D01: no dsh-im service → bridge reports unavailable with a reason, never throws on status', () => {
  const bridge = createDshImBridge({ readService: () => null })
  const status = bridge.status()
  assert.equal(status.available, false)
  assert.equal(status.reason, 'no-dsh-im')
  assert.equal(status.hasSend, false)
  assert.equal(status.hasListBots, false)
  assert.equal(status.hasListTargets, false)

  assert.rejects(bridge.listBots(), (error) => error.code === 'host-unavailable')
  assert.rejects(bridge.send({ botId: 'b', targetId: 't', text: 'hi' }), (error) => error.code === 'host-unavailable')
})

test('D02: late appearance — re-read on every call, unavailable then available', () => {
  let handle = null
  const bridge = createDshImBridge({ readService: () => handle })
  assert.equal(bridge.status().available, false)

  handle = deliveryService().service
  const status = bridge.status()
  assert.equal(status.available, true)
  assert.equal(status.hasSend, true)

  handle = null // withdrawn
  assert.equal(bridge.status().available, false)
})

test('D02: recreate during an in-flight send → late result isolated as unknown (epoch)', async () => {
  let resolveSend
  const sent = new Promise((res) => { resolveSend = res })
  const serviceA = {
    send: async () => { await sent; return true },
    listBots: async () => [],
    listTargets: async () => [],
  }
  const serviceB = deliveryService().service

  let handle = serviceA
  const sendCallsB = []
  const bridge = createDshImBridge({ readService: () => handle })

  const inflight = bridge.send({ botId: 'b', targetId: 't', text: 'hi' })
  handle = serviceB // withdrawn + recreated while airborne
  resolveSend(true)
  const result = await inflight

  assert.equal(result.unknown, true)
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'epoch')

  // The recreated service is now the live reference; the old object is not used again.
  const b = serviceB
  b.send = async () => { sendCallsB.push('b'); return true }
  const next = await bridge.send({ botId: 'b', targetId: 't', text: 'again' })
  assert.equal(next.accepted, true)
  assert.deepEqual(sendCallsB, ['b'])
})

test('D03: real delivery-service + fake channel → args pass through unmodified (stable id, no prefix guess)', async () => {
  const { service, calls } = deliveryService({ sendResult: true })
  const bridge = createDshImBridge({ readService: () => service })

  const bots = [{ botId: 'q_lark_bot_7f3a', label: 'Lark bot', platform: 'feishu' }]
  const targets = [{ targetId: 'oc_target_abcDEF123', label: 'Owner', kind: 'im' }]
  service.listBots = async () => bots
  service.listTargets = async () => targets

  const listedBots = await bridge.listBots()
  assert.equal(listedBots[0].botId, 'q_lark_bot_7f3a') // opaque id kept verbatim
  assert.equal(listedBots[0].label, 'Lark bot')
  assert.equal(listedBots[0].platform, 'feishu')
  assert.equal(listedBots[0].credential, undefined) // no credential leaks

  const listedTargets = await bridge.listTargets('q_lark_bot_7f3a')
  assert.equal(listedTargets[0].targetId, 'oc_target_abcDEF123')
  assert.equal(listedTargets[0].kind, 'im')

  const options = { silent: true }
  const result = await bridge.send({ botId: 'q_lark_bot_7f3a', targetId: 'oc_target_abcDEF123', text: 'hello', options })
  assert.equal(result.accepted, true)
  assert.equal(result.confirmed, false)
  assert.equal(result.unknown, false)
  assert.deepEqual(calls.send[0], ['q_lark_bot_7f3a', 'oc_target_abcDEF123', 'hello', options])
})

test('D03: listBots/listTargets accept both array and wrapped shapes; never prefix-guess ids', async () => {
  const bridge = createDshImBridge({ readService: () => ({
    send: async () => true,
    listBots: async () => ({ bots: [{ id: 'bot-1', name: 'B1' }] }),
    listTargets: async () => ({ targets: [{ id: 'tgt-1', title: 'T1', channel: 'im' }] }),
  }) })
  assert.deepEqual(await bridge.listBots(), [{ botId: 'bot-1', label: 'B1' }])
  assert.deepEqual(await bridge.listTargets('bot-1'), [{ targetId: 'tgt-1', label: 'T1', kind: 'im' }])
})

test('D04: sent=true → accepted (not confirmed); false → rejected; timeout → unknown', async () => {
  const cases = [
    { sendResult: true, expect: { accepted: true, confirmed: false, unknown: false, rejected: false } },
    { sendResult: { sent: true, ok: true }, expect: { accepted: true, rejected: false, unknown: false } },
    { sendResult: false, expect: { rejected: true, accepted: false, unknown: false } },
    { sendResult: { rejected: true, sent: false }, expect: { rejected: true, accepted: false, unknown: false } },
    { sendResult: { whatever: 'ambiguous' }, expect: { unknown: true, accepted: false, rejected: false } },
  ]
  for (const { sendResult, expect } of cases) {
    const { service } = deliveryService({ sendResult })
    const bridge = createDshImBridge({ readService: () => service })
    const result = await bridge.send({ botId: 'b', targetId: 't', text: 'hi' })
    for (const [key, val] of Object.entries(expect)) assert.equal(result[key], val, `${key} for ${JSON.stringify(sendResult)}`)
  }
})

test('D04: a thrown timeout/cancel is unknown (never a blind retry); a deterministic error is rejected', async () => {
  const timeoutBridge = createDshImBridge({ readService: () => ({
    send: async () => { const e = new Error('request timed out'); e.code = 'TIMEOUT'; throw e },
    listBots: async () => [], listTargets: async () => [],
  }) })
  const t = await timeoutBridge.send({ botId: 'b', targetId: 't', text: 'hi' })
  assert.equal(t.unknown, true)
  assert.equal(t.rejected, false)
  assert.equal(t.reason, 'timeout')

  const cancelBridge = createDshImBridge({ readService: () => ({
    send: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e },
    listBots: async () => [], listTargets: async () => [],
  }) })
  const c = await cancelBridge.send({ botId: 'b', targetId: 't', text: 'hi' })
  assert.equal(c.unknown, true)

  const rejectBridge = createDshImBridge({ readService: () => ({
    send: async () => { const e = new Error('no such bot'); e.code = 'BOT_NOT_FOUND'; throw e },
    listBots: async () => [], listTargets: async () => [],
  }) })
  const r = await rejectBridge.send({ botId: 'b', targetId: 't', text: 'hi' })
  assert.equal(r.rejected, true)
  assert.equal(r.unknown, false)
})

test('D05: no target → bad-request; unsupported media/card → not-supported; no auto target switch', async () => {
  const { service } = deliveryService({ sendResult: true })
  const bridge = createDshImBridge({ readService: () => service })

  assert.rejects(bridge.send({ botId: '', targetId: 't', text: 'hi' }), (e) => e.code === 'bad-request')
  assert.rejects(bridge.send({ botId: 'b', targetId: '', text: 'hi' }), (e) => e.code === 'bad-request')
  assert.rejects(bridge.send({ botId: 'b', targetId: 't', text: '   ' }), (e) => e.code === 'bad-request')
  assert.rejects(bridge.send({ botId: 'b', targetId: 't', text: 'hi', options: { media: { url: 'x' } } }), (e) => e.code === 'not-supported')
  assert.rejects(bridge.send({ botId: 'b', targetId: 't', text: 'hi', options: { interactive: true } }), (e) => e.code === 'not-supported')
  assert.rejects(bridge.send({ botId: 'b', targetId: 't', text: 'hi', options: { card: {} } }), (e) => e.code === 'not-supported')

  // invalid list rows are dropped, never fabricated → no bogus target to auto-switch onto.
  service.listBots = async () => [{ id: '' }, null, { botId: 'ok', label: 'OK' }]
  assert.deepEqual(await bridge.listBots(), [{ botId: 'ok', label: 'OK' }])
})

test('D05: a removed/changed target is never silently re-substituted on send', async () => {
  // The bridge only delegates the exact (botId,targetId) the caller holds; it has no
  // fallback target table. A missing target surfaces as the service's deterministic reject.
  const bridge = createDshImBridge({ readService: () => ({
    send: async () => { const e = new Error('target no longer exists'); e.code = 'TARGET_GONE'; throw e },
    listBots: async () => [], listTargets: async () => [],
  }) })
  const r = await bridge.send({ botId: 'b', targetId: 'stale-target', text: 'hi' })
  assert.equal(r.rejected, true)
  assert.equal(r.accepted, false)
})

// --- wiring: the real control-surface exposes the bridge and fails closed when unassembled ---

function surfaceRig({ dshIm }) {
  const revision = { current: () => ({ epoch: 0, revision: 0 }), wait: async () => ({ epoch: 0, revision: 0, changed: false }), touch: () => {} }
  const activity = { record: () => {}, list: () => [] }
  const service = createControlSurfaceService({
    revision,
    // Stage 4：daily 应用入口 = Native 面；此处只需一个存根证明「桥缺失不影响核心路径」。
    native: { call: async (method) => ({ ok: true, value: { method } }) },
    activity,
    dshIm,
  })
  return service
}

test('wiring: dshIm.status/listBots/send via the surface; unassembled bridge fails closed', async () => {
  const { service } = deliveryService({ sendResult: true })
  const bridge = createDshImBridge({ readService: () => service })
  const surface = surfaceRig({ dshIm: bridge })

  const status = await surface.call('dshIm.status')
  assert.equal(status.ok, true)
  assert.equal(status.value.available, true)

  const send = await surface.call('dshIm.send', { botId: 'b', targetId: 't', text: 'hi' })
  assert.equal(send.ok, true)
  assert.equal(send.value.accepted, true)

  const unassembled = surfaceRig({ dshIm: null })
  const missing = await unassembled.call('dshIm.status')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'dsh-notifier/not-supported')
})

test('wiring: no dsh-im host service → status reports unavailable, not an empty list', async () => {
  const bridge = createDshImBridge({ readService: () => null })
  const surface = surfaceRig({ dshIm: bridge })
  const status = await surface.call('dshIm.status')
  assert.equal(status.value.available, false)
  assert.equal(status.value.reason, 'no-dsh-im')
  const bots = await surface.call('dshIm.listBots')
  assert.equal(bots.ok, false)
  assert.equal(bots.error.code, 'dsh-notifier/host-unavailable')
})

test('D01: a missing bridge/service never breaks the core notifier path (bridge lives beside the native surface)', async () => {
  // The bridge is a sibling of the existing surfaces; its absence only degrades the
  // dsh-im endpoints, not the native daily surface or the local remote-URL validation.
  const surface = surfaceRig({ dshIm: null })
  const native = await surface.call('native.snapshot', {})
  assert.equal(native.ok, true)
  assert.equal(native.value.method, 'native.snapshot')
  const remote = await surface.call('remote.validate', { url: 'https://example.com/' })
  assert.equal(remote.ok, true)
})