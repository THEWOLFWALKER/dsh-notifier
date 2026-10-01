// v0.15 RC（Gate 1）— 机械核心补丁的验收契约。
//
// 对应 command pack `patches/CORE-PATCH-TESTS.md`：这些测试直接驱动生产模块，逐一固定
// 「一个活 owner 的锁不被 age 回收」「disposer 形状 function/Fiber/PromiseLike」「retired
// runtime 不复活」「Tunnel 信任与生命周期」「notify/notifyAll 同一 unknown 证据语义」。
// 确定性 fake（无真实子进程、无网络、无真实计时等待降级）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createHostLifetime } from '../src/host/seam.mjs'
import { defineStatefulSender } from '../src/adapters/sender.mjs'
import { createTunnelSupervisor } from '../extensions/cloudflare-tunnel/src/supervisor.mjs'
import { validateTunnelConfig } from '../extensions/cloudflare-tunnel/src/config.mjs'
import { createNotifier } from '../src/notify.mjs'
import { resolveConfig } from '../src/config.mjs'

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-s21-'))
  return { file: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const ageLock = (path, seconds) => {
  const t = Date.now() / 1000 - seconds
  utimesSync(path, t, t)
}

// ————————————————————————— Store: owner-aware live lock —————————————————————————

test('RC/store: a live owner PID with an old mtime is never reclaimed by age alone', () => {
  const { file, cleanup } = tempFile()
  try {
    const lock = `${file}.lock`
    writeFileSync(lock, `${process.pid}:live`)
    ageLock(lock, 20) // age alone would previously reclaim this live lock (macOS CI split-brain)
    const store = createStore(file)
    const result = store.transact((draft) => { draft.x = 1; return true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'STATE_BUSY')
    assert.equal(existsSync(lock), true, 'the live lock must be retained, never deleted')
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:live`, 'foreign owner content untouched')
  } finally { cleanup() }
})

test('RC/store: a dead owner PID past the probe floor is reclaimed and committed', () => {
  const { file, cleanup } = tempFile()
  try {
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid
    assert.equal(Number.isInteger(deadPid), true, 'need a real, already-exited PID')
    const lock = `${file}.lock`
    writeFileSync(lock, `${deadPid}:gone`)
    ageLock(lock, 1) // > 500ms probe floor
    const store = createStore(file)
    const result = store.transact((draft) => { draft.x = 1; return true })
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(existsSync(lock), false, 'a recovered lock is released after commit')
  } finally { cleanup() }
})

test('RC/store: a malformed lock only reclaims after the unknown-stale fallback (>10s)', () => {
  const { file, cleanup } = tempFile()
  try {
    const lock = `${file}.lock`
    writeFileSync(lock, 'not-a-pid')
    ageLock(lock, 1) // fresh-ish, but unparseable
    const busy = createStore(file).transact((draft) => { draft.x = 1; return true })
    assert.equal(busy.ok, false, 'malformed lock newer than 10s must not be reclaimed')
    assert.equal(busy.code, 'STATE_BUSY')
    assert.equal(existsSync(lock), true)

    ageLock(lock, 11) // now past the unknown-stale fallback
    const recovered = createStore(file).transact((draft) => { draft.y = 1; return true })
    assert.equal(recovered.ok, true)
  } finally { cleanup() }
})

// ————————————————————————— Host lifetime: disposer shapes —————————————————————————

test('RC/host: an inject disposer returning a function is called exactly once', () => {
  let calls = 0
  const ctx = { inject: (list, cb) => { cb({}); return () => { calls += 1 } } }
  const life = createHostLifetime(ctx, {})
  life.inject(['svc'], () => {}, { label: 'fn' })
  life.dispose()
  life.dispose()
  assert.equal(calls, 1)
})

test('RC/host: an inject disposer returning a Fiber-like { dispose() } is disposed once', () => {
  let calls = 0
  const ctx = { inject: () => ({ dispose: () => { calls += 1 } }) }
  const life = createHostLifetime(ctx, {})
  life.inject(['svc'], () => {}, { label: 'fiber' })
  life.dispose()
  assert.equal(calls, 1)
})

test('RC/host: a PromiseLike<Fiber> disposer is released even when the lifetime disposes first', async () => {
  let calls = 0
  let resolveHandle = null
  const gate = new Promise((resolve) => { resolveHandle = resolve })
  const ctx = { inject: () => gate }
  const life = createHostLifetime(ctx, {})
  life.inject(['svc'], () => {}, { label: 'promise' })
  life.dispose() // released before the handle resolves
  resolveHandle({ dispose: () => { calls += 1 } })
  await gate
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1, 'the late Fiber must still be disposed, exactly once')
})

test('RC/host: a rejected PromiseLike disposer warns without an unhandled rejection', async () => {
  const warnings = []
  const ctx = { inject: () => Promise.reject(new Error('nope')) }
  const life = createHostLifetime(ctx, { warn: (message) => warnings.push(message) })
  life.inject(['svc'], () => {}, { label: 'rejected' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /disposer/)
  life.dispose()
})

// ————————————————————————— Stateful sender: no revival —————————————————————————

function demoStatefulSender(onCreate) {
  return defineStatefulSender({
    type: 'demo',
    validate: (cfg) => ({ ...cfg }),
    createRuntime: () => {
      onCreate()
      return { send: async () => ({ confirmed: true }), start() {}, stop() {}, dispose() {} }
    },
  })
}

test('RC/sender: a retired resolved identity can never recreate a runtime', async () => {
  let created = 0
  const sender = demoStatefulSender(() => { created += 1 })
  const resolved = {}
  sender.createRuntime(resolved)
  assert.equal(created, 1)
  assert.equal(sender.retire(resolved), true)
  assert.throws(() => sender.createRuntime(resolved), (error) => error.code === 'CHANNEL_RETIRED')
  await assert.rejects(sender.send(resolved, {}), (error) => error.code === 'CHANNEL_RETIRED')
  assert.equal(created, 1, 'no runtime is created for a retired resolved object')
})

test('RC/sender: an in-flight send retired mid-flight rejects with CHANNEL_RETIRED', async () => {
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const sender = defineStatefulSender({
    type: 'demo',
    validate: (cfg) => ({ ...cfg }),
    createRuntime: () => ({ send: () => gate }),
  })
  const resolved = {}
  const pending = sender.send(resolved, {})
  sender.retire(resolved)
  release({ confirmed: true })
  await assert.rejects(pending, (error) => error.code === 'CHANNEL_RETIRED' && error.noRetry === true)
})

test('RC/sender: a fresh resolved object may create a brand-new runtime', () => {
  let created = 0
  const sender = demoStatefulSender(() => { created += 1 })
  const first = {}
  const second = {}
  sender.createRuntime(first)
  sender.retire(first)
  sender.createRuntime(second)
  assert.equal(created, 2)
})

// ————————————————————————— Tunnel: trust + lifecycle —————————————————————————

let pidCounter = 2000
function fakeChild() {
  const child = new EventEmitter()
  child.pid = ++pidCounter
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.signals = []
  child.kill = (signal) => { child.signals.push(signal ?? 'SIGTERM') }
  child.emitSpawn = () => child.emit('spawn')
  child.emitExit = (code = 0, signal = null) => child.emit('exit', code, signal)
  return child
}

function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    pendingCount: () => pending.size,
    advance: (ms) => {
      now += ms
      const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) { if (pending.has(id)) { pending.delete(id); t.fn() } }
    },
  }
}

test('RC/tunnel: explicit originCheck:false / hostCheck:false are policy violations', () => {
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { originCheck: false } }).reason, 'host-trust-violation')
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x', hostTrust: { hostCheck: false } }).reason, 'host-trust-violation')
  // 默认（未显式关闭）仍是信任边界全开、可通过
  assert.equal(validateTunnelConfig({ name: 't', credentialsSource: 'x' }).value.hostTrust.originCheck, true)
})

test('RC/tunnel: dispose on a running tunnel terminates the owned child', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, drainDeadlineMs: 200 })
  const started = sup.start({ name: 'x' })
  children[0].emitSpawn()
  await started
  assert.equal(sup.status().status, 'running')

  const disposed = sup.dispose()
  assert.equal(children[0].signals.includes('SIGTERM'), true, 'dispose must signal the owned child')
  children[0].emitExit(0)
  await disposed
  assert.equal(sup.status().status, 'stopped')
})

test('RC/tunnel: dispose while a start is pending settles the start promise (no hang)', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, startDeadlineMs: 1000 })
  const started = sup.start({ name: 'x' }) // no spawn emitted → still starting
  assert.equal(sup.status().status, 'starting')
  const disposed = sup.dispose()
  await assert.rejects(started, (error) => error.code === 'stopped')
  children[0].emitExit(0)
  await disposed
  assert.equal(sup.status().status, 'stopped')
})

test('RC/tunnel: an old child exit cannot flip a newer running tunnel back to stopped', async () => {
  const children = []
  const spawn = () => { const c = fakeChild(); children.push(c); return c }
  const timers = fakeTimers()
  const sup = createTunnelSupervisor({ spawn, ...timers, drainDeadlineMs: 200 })
  const started = sup.start({ name: 'x' })
  children[0].emitSpawn()
  await started

  const stopped = sup.stop() // SIGTERM old child, epoch invalidated
  const restarted = sup.start({ name: 'x' }) // new epoch + new child
  children[1].emitSpawn()
  await restarted
  assert.equal(sup.status().status, 'running')

  children[0].emitExit(0) // late exit from the superseded child
  const stopResult = await stopped
  assert.equal(stopResult.status, 'running', 'stop of an old epoch reports the current truth')
  assert.equal(sup.status().status, 'running', 'the newer running tunnel is not clobbered')
})

// ————————————————————————— notifyAll: same uncertain evidence as notify —————————————————————————

test('RC/notify: notifyAll classifies a timeout as unknown, matching notify()', async () => {
  const resolved = resolveConfig({ channels: [{ type: 'webhook', url: 'http://x/hook' }] })
  assert.equal(resolved.skipped.length, 0)
  const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels)
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    const fail = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error) }
    init?.signal?.addEventListener?.('abort', fail)
    setTimeout(fail, 25)
  })
  try {
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.ok, false)
    assert.deepEqual(result.unknown, ['webhook'], 'a timeout is uncertain, not a plain failure')
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].uncertain, true)
    assert.deepEqual(result.accepted, [])
  } finally {
    globalThis.fetch = original
  }
})