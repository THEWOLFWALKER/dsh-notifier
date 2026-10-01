// v0.15 Stage S17 (T25) — optional Cloudflare Tunnel extension.
//
// Acceptance R01–R05 (04-ACCEPTANCE-AND-REVIEW.md) + 06-INTEGRATIONS §Remote/Tunnel:
//   R01 single-flight start + deadline cleanup; R02 epoch isolation / no revival / bounded
//   reconnect / stop-during-start no hang; R03 Origin/Host-trust + Access protection + Quick
//   Tunnel reject matrix; R05 not-configured without a CF account / binary, pinned checksum
//   fail-closed.
//
// Drives the real production modules under `extensions/cloudflare-tunnel/` (supervisor, config,
// assets, redact, controller) — no re-implementation. Deterministic fake process + fake timers;
// no real subprocess, no network.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

import { createTunnelSupervisor } from '../extensions/cloudflare-tunnel/src/supervisor.mjs'
import { validateTunnelConfig, describeTunnelTrust, TUNNEL_CONFIG_REASONS } from '../extensions/cloudflare-tunnel/src/config.mjs'
import { resolveAsset, verifyAsset } from '../extensions/cloudflare-tunnel/src/assets.mjs'
import { redactCloudflaredOutput, boundLogLines } from '../extensions/cloudflare-tunnel/src/redact.mjs'
import { createCloudflareTunnelController } from '../extensions/cloudflare-tunnel/index.mjs'

let pidCounter = 1000
function fakeChild() {
  const child = new EventEmitter()
  child.pid = ++pidCounter
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.signals = []
  child.kill = (signal) => { child.signals.push(signal ?? 'SIGTERM') }
  child.emitSpawn = () => child.emit('spawn')
  child.emitExit = (code = 0, signal = null) => child.emit('exit', code, signal)
  child.emitError = (message) => child.emit('error', new Error(message))
  child.out = (text) => child.stdout.emit('data', text)
  child.err = (text) => child.stderr.emit('data', text)
  return child
}

function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + ms, ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    pendingCount: () => pending.size,
    scheduledMs: () => [...pending.values()].map((t) => t.ms),
    advance: (ms) => {
      now += ms
      const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) { if (pending.has(id)) { pending.delete(id); t.fn() } }
    },
  }
}

// ————————————————————————— R03: config reject matrix —————————————————————————

test('R03: host-trust violations and Quick Tunnel are rejected', () => {
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', quick: true }).reason, 'quick-tunnel-stable')
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { clearOrigin: true } }).reason, 'host-trust-violation')
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { rewriteLocalhost: true } }).reason, 'host-trust-violation')
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { disableHostCheck: true } }).reason, 'host-trust-violation')
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { untrustedOrigin: true } }).reason, 'untrusted-origin')
})

test('R03: Access protection cannot be claimed without configuration', () => {
  const r = validateTunnelConfig({ name: 't', credentialsSource: 'x', protected: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'access-as-cleartrust')
  assert.match(TUNNEL_CONFIG_REASONS['access-as-cleartrust'], /Access/)
})

test('R03: a named tunnel with Access protection validates and defaults to disabled', () => {
  const r = validateTunnelConfig({ name: 'mytunnel', credentialsSource: '/secure/cred.json', access: { applicationId: 'app-123' }, protected: true, enabled: false })
  assert.equal(r.ok, true)
  assert.equal(r.value.name, 'mytunnel')
  assert.equal(r.value.enabled, false)
  assert.equal(r.value.quick, false)
  assert.equal(r.value.access.protected, true)
  assert.equal(r.value.hostTrust.originCheck, true)
  assert.equal(r.value.hostTrust.hostCheck, true)
})

test('R03: missing / invalid name / missing credentials source are rejected', () => {
  assert.equal(validateTunnelConfig(null).reason, 'empty')
  assert.equal(validateTunnelConfig('nope').reason, 'not-record')
  assert.equal(validateTunnelConfig({}).reason, 'no-tunnel-name')
  assert.equal(validateTunnelConfig({ name: 'bad name!' }).reason, 'invalid-tunnel-name')
  assert.equal(validateTunnelConfig({ name: 't' }).reason, 'missing-credentials-source')
})

test('R03: describeTunnelTrust reflects running + Access protected, never Quick', () => {
  assert.deepEqual(describeTunnelTrust(null), { available: false, protected: false, quick: false })
  assert.deepEqual(describeTunnelTrust({ status: 'running', quick: true, access: { protected: true } }), { available: false, protected: false, quick: true })
  assert.deepEqual(describeTunnelTrust({ status: 'running', quick: false, access: { protected: true } }), { available: true, protected: true, quick: false })
})

// ————————————————————————— R05: assets + redaction —————————————————————————

test('R05: assets resolve only pinned platforms; empty checksum is fail-closed', () => {
  const linux64 = resolveAsset('linux-x64')
  assert.equal(linux64.ok, false)
  assert.equal(linux64.reason, 'checksum-unpinned')
  assert.equal(resolveAsset('wat-arch').reason, 'unsupported-platform')
  assert.equal(resolveAsset(undefined).reason, 'unsupported-platform')
})

test('R05: verifyAsset compares sha256 case-insensitively and rejects malformed checksums', () => {
  const data = Buffer.from('cloudflared-bytes')
  const expected = createHash('sha256').update(data).digest('hex')
  assert.equal(verifyAsset(expected, data), true)
  assert.equal(verifyAsset(expected.toUpperCase(), data), true)
  assert.equal(verifyAsset('deadbeef', data), false)
  assert.equal(verifyAsset(undefined, data), false)
  assert.equal(verifyAsset('ff'.repeat(32), data), false)
})

test('R05: cloudflared output redaction masks token/JWT forms and is idempotent', () => {
  const line = 'TUNNEL_TOKEN=superSecretTokenValue123 connected with eyJhbGciOiJIUzI1NiJ9.payload.signature'
  const once = redactCloudflaredOutput(line)
  assert.equal(once.includes('superSecretTokenValue123'), false)
  assert.equal(once.includes('eyJhbGciOiJIUzI1NiJ9'), false)
  assert.equal(redactCloudflaredOutput(once), once)
  assert.equal(boundLogLines(['a', 'b', 'c', 'd'], 2).length, 2)
  assert.deepEqual(boundLogLines(['a', 'b', 'c', 'd'], 2), ['c', 'd'])
})

// ————————————————————————— R01: supervisor single-flight + deadline —————————————————————————

test('R01: concurrent start() coalesces into a single spawn (single-flight)', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, startDeadlineMs: 1000 })
  const p1 = sup.start({ name: 'x' })
  const p2 = sup.start({ name: 'x' })
  assert.equal(children.length, 1)
  assert.equal(p1, p2)
  children[0].emitSpawn()
  const r = await p1
  assert.equal(r.ok, true)
  assert.equal(sup.status().status, 'running')
  assert.equal(sup.status().pid, children[0].pid)
})

test('R01: a slow start hits the deadline, kills its own process, and fails', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, startDeadlineMs: 500 })
  const p = sup.start({ name: 'x' })
  assert.equal(sup.status().status, 'starting')
  timers.advance(500)
  await assert.rejects(p, (e) => e.code === 'start-timeout')
  assert.equal(children[0].signals.includes('SIGKILL'), true)
  assert.equal(sup.status().status, 'failed')
})

test('R01/R05: a spawn error rejects start and reports failed', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers })
  const p = sup.start({ name: 'x' })
  children[0].emitError('ENOENT')
  await assert.rejects(p, (e) => e.code === 'spawn-failed')
  assert.equal(sup.status().status, 'failed')
})

test('R05: missing binary reports not-configured and leaves local function intact', async () => {
  const sup = createTunnelSupervisor({ spawn: null })
  await assert.rejects(sup.start({ name: 'x' }), (e) => e.code === 'not-configured')
  assert.equal(sup.status().status, 'failed')
})

test('R05: a throwing spawn is caught and reported spawn-failed', async () => {
  const sup = createTunnelSupervisor({ spawn: () => { throw new Error('no binary') } })
  await assert.rejects(sup.start({}), (e) => e.code === 'spawn-failed')
  assert.equal(sup.status().status, 'failed')
})

// ————————————————————————— R02: epoch isolation / no revival / bounded —————————————————————————

test('R02: stop() while running cleans up and a late exit never revives', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, drainDeadlineMs: 500 })
  const p = sup.start({ name: 'x' })
  children[0].emitSpawn()
  await p
  assert.equal(sup.status().status, 'running')
  const stopP = sup.stop()
  assert.equal(children[0].signals.includes('SIGTERM'), true)
  children[0].emitExit(0)
  const sr = await stopP
  assert.equal(sr.forced, false)
  assert.equal(sup.status().status, 'stopped')
  children[0].emitExit(0) // late exit from old child → no revival
  assert.equal(sup.status().status, 'stopped')
  assert.equal(timers.pendingCount(), 0)
})

test('R02: stopping during a pending start settles the inflight promise (no hang)', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, startDeadlineMs: 1000 })
  const p = sup.start({ name: 'x' }) // no spawn → still starting
  assert.equal(sup.status().status, 'starting')
  const stopP = sup.stop()
  await assert.rejects(p, (e) => e.code === 'stopped')
  children[0].emitExit(0)
  await stopP
  assert.equal(sup.status().status, 'stopped')
})

test('R02: reconnect is bounded (one timer, capped backoff) and crash re-starts', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, maxReconnectMs: 8000, startDeadlineMs: 1000 })
  const p = sup.start({ name: 'x' })
  children[0].emitSpawn()
  await p
  children[0].emitExit(1)
  assert.equal(sup.status().status, 'failed')
  assert.equal(sup.status().restartCount, 1)
  assert.equal(timers.pendingCount(), 1)
  assert.deepEqual(timers.scheduledMs(), [2000]) // 1000 * 2^1
  timers.advance(2000)
  assert.equal(children.length, 2)
  children[1].emitSpawn()
  assert.equal(sup.status().status, 'running')
})

test('R02/R05: stdout/stderr secrets are masked in status().recentLog', () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers })
  sup.start({ name: 'x' })
  children[0].out('TUNNEL_TOKEN=superSecretTokenValue123')
  children[0].err('err eyJhbGciOiJIUzI1NiJ9.payload.signature done')
  const log = sup.status().recentLog.join(' ')
  assert.equal(log.includes('superSecretTokenValue123'), false)
  assert.equal(log.includes('eyJhbGciOiJIUzI1NiJ9'), false)
})

// ————————————————————————— controller (R05) —————————————————————————

test('R05: controller returns not-configured then disabled until valid enabled config', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const ctrl = createCloudflareTunnelController({ spawn })
  const before = await ctrl.start()
  assert.equal(before.ok, false)
  assert.equal(before.code, 'not-configured')
  const cfg = ctrl.configure({ name: 't', credentialsSource: 'x' })
  assert.equal(cfg.ok, true)
  const disabled = await ctrl.start()
  assert.equal(disabled.code, 'disabled')
  assert.equal(children.length, 0, 'disabled config never spawns')
  ctrl.dispose()
  assert.equal(ctrl.status().status, 'stopped')
})