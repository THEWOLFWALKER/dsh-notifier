// Stage 4 dsh-im checked contract v1 attack tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createDshImBridge, expectedTargetDigest } from '../src/control-plane/dsh-im-bridge.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'

const FP = 'a'.repeat(64)
const target = (route = { chatId: 'private-1' }) => ({ targetId: 't1', kind: 'private', route, label: 'Private chat' })
function makeService(overrides = {}) {
  const calls = { listBots: 0, describeBot: [], listTargets: [], checked: [], ordinary: 0 }
  const service = {
    contractVersion: 1,
    listBots: async () => { calls.listBots++; return [{ botId: 'b1', label: 'Listed label', credential: 'secret' }] },
    describeBot: async id => { calls.describeBot.push(id); return { botId: id, channel: 'telegram', label: 'Safe bot', accountFingerprint: FP, connected: true, capabilities: ['proactive-text-checked'], credentials: { token: 'secret' } } },
    listTargets: async id => { calls.listTargets.push(id); return [target()] },
    send: async () => { calls.ordinary++; return { sent: true } },
    sendChecked: async (...args) => { calls.checked.push(args); return { sent: true } },
    ...overrides,
  }
  return { service, calls }
}

test('contract gate: absent and non-v1 services fail closed', async () => {
  const absent = createDshImBridge({ readService: () => null })
  assert.deepEqual(absent.status(), { available: false, reason: 'no-dsh-im', contractVersion: null, hasListBots: false, hasDescribeBot: false, hasListTargets: false, hasSendChecked: false })
  await assert.rejects(absent.listBots(), e => e.code === 'host-unavailable')
  const old = createDshImBridge({ readService: () => ({ ...makeService().service, contractVersion: 0 }) })
  assert.equal(old.status().reason, 'unsupported-contract')
  await assert.rejects(old.listBots(), e => e.code === 'not-supported')
})

test('discovery requires describeBot and projects only safe v1 fields', async () => {
  const { service, calls } = makeService()
  const bridge = createDshImBridge({ readService: () => service })
  const bots = await bridge.listBots()
  assert.deepEqual(bots, [{ botId: 'b1', channel: 'telegram', label: 'Safe bot', accountFingerprint: FP, connected: true, checked: true }])
  assert.deepEqual(calls.describeBot, ['b1'])
  assert.doesNotMatch(JSON.stringify(bots), /secret|credentials/)

  service.describeBot = async id => ({ botId: id, channel: 'telegram', accountFingerprint: FP, connected: true, capabilities: ['plain-text'] })
  assert.equal((await bridge.listBots())[0].checked, false)
})

test('missing describeBot capability cannot be treated as a checked bot', async () => {
  const { service } = makeService({ describeBot: undefined })
  const bridge = createDshImBridge({ readService: () => service })
  assert.equal(bridge.status().hasDescribeBot, false)
  await assert.rejects(bridge.listBots(), e => e.code === 'not-supported')
})

test('target discovery returns opaque digest and never returns route data', async () => {
  const { service } = makeService()
  const bridge = createDshImBridge({ readService: () => service })
  const targets = await bridge.listTargets('b1')
  const expected = createHash('sha256').update(JSON.stringify({ kind: 'private', route: { chatId: 'private-1' } }), 'utf8').digest('hex')
  assert.deepEqual(targets, [{ targetId: 't1', label: 'Private chat', kind: 'private', expectedTargetDigest: expected }])
  assert.doesNotMatch(JSON.stringify(targets), /private-1|route/)
  assert.equal(expectedTargetDigest(target({ z: 2, a: 1 })), expectedTargetDigest(target({ a: 1, z: 2 })))
})

test('send revalidates fingerprint and route, then calls sendChecked only', async () => {
  const { service, calls } = makeService()
  const bridge = createDshImBridge({ readService: () => service })
  const digest = (await bridge.listTargets('b1'))[0].expectedTargetDigest
  const result = await bridge.send({ botId: 'b1', targetId: 't1', text: 'hello', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.equal(result.accepted, true)
  assert.equal(result.confirmed, false)
  assert.equal(calls.ordinary, 0)
  const [botId, targetId, text, options] = calls.checked[0]
  assert.deepEqual([botId, targetId, text], ['b1', 't1', 'hello'])
  assert.deepEqual({ expectedFingerprint: options.expectedFingerprint, expectedTargetDigest: options.expectedTargetDigest, format: options.format }, { expectedFingerprint: FP, expectedTargetDigest: digest, format: 'plain' })
  assert.ok(options.signal instanceof AbortSignal)
})

test('fingerprint change after discovery is rejected before SDK start', async () => {
  const { service, calls } = makeService()
  const bridge = createDshImBridge({ readService: () => service })
  const digest = (await bridge.listTargets('b1'))[0].expectedTargetDigest
  service.describeBot = async id => ({ botId: id, channel: 'telegram', accountFingerprint: 'b'.repeat(64), connected: true, capabilities: ['proactive-text-checked'] })
  const result = await bridge.send({ botId: 'b1', targetId: 't1', text: 'hello', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.deepEqual({ rejected: result.rejected, reason: result.reason }, { rejected: true, reason: 'account-changed' })
  assert.equal(calls.checked.length, 0)
  assert.equal(calls.ordinary, 0)
})

test('target route change after discovery is rejected before SDK start', async () => {
  const { service, calls } = makeService()
  const bridge = createDshImBridge({ readService: () => service })
  const digest = (await bridge.listTargets('b1'))[0].expectedTargetDigest
  service.listTargets = async () => [target({ chatId: 'different-private-chat' })]
  const result = await bridge.send({ botId: 'b1', targetId: 't1', text: 'hello', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.deepEqual({ rejected: result.rejected, reason: result.reason }, { rejected: true, reason: 'target-changed' })
  assert.equal(calls.checked.length, 0)
  assert.equal(calls.ordinary, 0)
})

test('missing sendChecked and missing checked capability never fall back to send', async () => {
  const a = makeService({ sendChecked: undefined })
  const bridgeA = createDshImBridge({ readService: () => a.service })
  assert.equal(bridgeA.status().available, false)
  assert.equal(bridgeA.status().reason, 'incomplete-contract')
  assert.equal(bridgeA.status().hasSendChecked, false)
  const digestA = expectedTargetDigest(target())
  await assert.rejects(bridgeA.send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digestA }), e => e.code === 'not-supported')
  assert.equal(a.calls.ordinary, 0)

  const b = makeService({ describeBot: async id => ({ botId: id, accountFingerprint: FP, connected: true, capabilities: [] }) })
  const bridgeB = createDshImBridge({ readService: () => b.service })
  const result = await bridgeB.send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digestA })
  assert.equal(result.rejected, true)
  assert.equal(b.calls.ordinary, 0)
  assert.equal(b.calls.checked.length, 0)
})

test('deterministic checked rejection maps to rejected; SDK ambiguity maps to unknown', async () => {
  const digest = expectedTargetDigest(target())
  const denied = makeService({ sendChecked: async () => { const e = new Error('account changed'); e.code = 'account-changed'; throw e } })
  const deniedResult = await createDshImBridge({ readService: () => denied.service }).send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.deepEqual({ rejected: deniedResult.rejected, reason: deniedResult.reason }, { rejected: true, reason: 'account-changed' })
  assert.equal(denied.calls.ordinary, 0)

  const ambiguous = makeService({ sendChecked: async () => { throw new Error('SDK exploded after request start') } })
  const unknown = await createDshImBridge({ readService: () => ambiguous.service }).send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.rejected, false)
  assert.equal(ambiguous.calls.ordinary, 0)
})

test('timeout after SDK starts aborts its signal and returns unknown', async () => {
  let startedSignal
  const { service, calls } = makeService({ sendChecked: async (...args) => { startedSignal = args[3].signal; calls.checked.push(args); return new Promise(() => {}) } })
  const digest = expectedTargetDigest(target())
  const result = await createDshImBridge({ readService: () => service, sendTimeoutMs: 10 }).send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digest })
  assert.deepEqual({ unknown: result.unknown, reason: result.reason }, { unknown: true, reason: 'timeout' })
  assert.equal(startedSignal.aborted, true)
  assert.equal(calls.ordinary, 0)
})

test('service replacement during checked send isolates its late result', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { service } = makeService({ sendChecked: async () => pending })
  let live = service
  const bridge = createDshImBridge({ readService: () => live })
  const digest = expectedTargetDigest(target())
  const sending = bridge.send({ botId: 'b1', targetId: 't1', text: 'x', expectedFingerprint: FP, expectedTargetDigest: digest })
  await new Promise(resolve => setImmediate(resolve))
  live = makeService().service
  release({ sent: true })
  const result = await sending
  assert.deepEqual({ unknown: result.unknown, reason: result.reason }, { unknown: true, reason: 'service-replaced' })
})

test('secondary service forwards cancellation and records unknown as unknown, not failed/ok', async () => {
  const calls = []
  const revision = { current: () => ({ epoch: 'e', revision: 1 }), wait: async () => ({}), touch() {} }
  const activity = { record: (...args) => calls.push(args), list: () => [] }
  const signal = new AbortController().signal
  const service = createControlSurfaceService({ revision, activity, dshIm: {
    status: () => ({ available: true }), listBots: async options => { calls.push(['bots', options.signal]); return [] },
    listTargets: async (_botId, options) => { calls.push(['targets', options.signal]); return [] },
    send: async (_payload, options) => { calls.push(['send', options.signal]); return { unknown: true, rejected: false, accepted: false, confirmed: false } },
  } })
  await service.call('dshIm.listBots', {}, signal)
  await service.call('dshIm.listTargets', { botId: 'b1' }, signal)
  await service.call('dshIm.send', {}, signal)
  assert.deepEqual(calls.slice(0, 3).map(row => row[1]), [signal, signal, signal])
  assert.deepEqual(calls[3][2], { channel: 'dsh-im', accepted: false, confirmed: false, failed: false, status: 'unknown' })
})

test('guessed importer module and test are deleted, with no production importer wiring', () => {
  assert.equal(existsSync(new URL('../src/control-plane/dsh-im-import.mjs', import.meta.url)), false)
  assert.equal(existsSync(new URL('./v015-stage-s15-dsh-im-import.test.mjs', import.meta.url)), false)
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /dsh-im-import|dshImImport/)
})
