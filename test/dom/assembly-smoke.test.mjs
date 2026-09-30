// Assembly smoke test for the real dsh-notifier plugin entry (T03 test bottom).
//
// Boots the ACTUAL plugin `apply()` against the fake-Cordis stand-in in
// ./assembly-harness.mjs: no network, an isolated temporary DSH_HOME, and a fake
// host webServer/connection. It proves three lifecycle facts the pack asks for:
//   (a) the assembly starts,
//   (b) a host service that appears AFTER apply (late injection) is adopted, and
//   (c) dispose tears the host listeners + mounted route back down.
//
// No jsdom/react here — this file exercises the server-side assembly only.
// Run with:  node test/dom/run.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootPlugin, createFakeConnection, createFakeRequest, createFakeResponse,
  createFakeWebServer, createTempDshHome,
} from './assembly-harness.mjs'

// Cordis would route these to the host logger; keep the test output clean.
const silentLogger = { warn() {}, info() {}, debug() {} }

test('assembly smoke — boots, adopts a late-injected host service, and disposes', async () => {
  const home = createTempDshHome()
  const webServer = createFakeWebServer()
  const connection = createFakeConnection()
  let ctx
  try {
    // webServer/connection are intentionally ABSENT at apply time: the plugin
    // must declare them through ctx.inject and wait.
    const boot = await bootPlugin({ config: { inbound: { stateDir: home.dir } }, logger: silentLogger })
    ctx = boot.ctx

    // (a) the assembly started: apply resolved config synchronously, a lifecycle
    // effect and host event listeners exist.
    assert.equal(boot.resolved?.enabled, true, 'apply() resolved the (enabled) config synchronously')
    assert.ok(ctx.__lifecycle.effects.length >= 1, 'assembly registered a lifecycle effect')
    assert.ok(ctx.__lifecycle.listenerCount() > 0, 'assembly subscribed to host events')
    assert.ok(
      ctx.__lifecycle.hasInjection(['connection', 'webServer']),
      'assembly awaits the host Web seam via ctx.inject',
    )
    assert.equal(webServer.routes.length, 0, 'nothing is mounted before the host service exists')

    // (b) late injection: the host service appears after apply; the pending inject fires.
    const matched = ctx.__inject(['connection', 'webServer'], { connection, webServer })
    assert.equal(matched, 1, 'the pending connection/webServer injection ran exactly once')
    const route = webServer.routes[0]
    assert.ok(route, 'the Native control surface mounted on the late host webServer')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/dsh-notifier')

    // The mounted route is live: a synthetic RPC request yields a server-response envelope.
    const req = createFakeRequest({
      method: 'POST',
      url: '/dsh-notifier/surface.home',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'surface.home', payload: {} }),
    })
    const res = createFakeResponse()
    const handled = await webServer.dispatch(req, res)
    assert.equal(handled, true, 'the host router dispatched to the plugin route')
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).type, 'server-response', 'an RPC envelope comes back over the fake host carrier')

    assert.ok(ctx.__lifecycle.listenerCount() > 0, 'host listeners are still registered while running')

    // (c) dispose tears everything back down.
    await ctx.__lifecycle.dispose()
    assert.equal(ctx.__lifecycle.listenerCount(), 0, 'every host listener was deregistered on dispose')
    assert.equal(webServer.routes.length, 0, 'the host route was unmounted on dispose')
    assert.equal(ctx.__lifecycle.provided.size, 0, 'the provided notifier service was withdrawn on dispose')
  } finally {
    try { await ctx?.__lifecycle.dispose() } catch { /* best-effort */ }
    home.cleanup()
  }
})

test('assembly smoke — re-assembling in the same DSH_HOME starts cleanly again', async () => {
  const home = createTempDshHome()
  const webServer = createFakeWebServer()
  const connection = createFakeConnection()
  try {
    const first = await bootPlugin({ config: { inbound: { stateDir: home.dir } }, logger: silentLogger })
    assert.ok(first.ctx.__lifecycle.effects.length >= 1, 'first assembly started')
    await first.ctx.__lifecycle.dispose()
    assert.equal(first.ctx.__lifecycle.listenerCount(), 0, 'first assembly left no listeners behind')

    // Rebuild against the same persisted home (state.json already exists).
    const second = await bootPlugin({ config: { inbound: { stateDir: home.dir } }, logger: silentLogger })
    assert.ok(second.ctx.__lifecycle.effects.length >= 1, 'second assembly started on the existing home')
    const matched = second.ctx.__inject(['connection', 'webServer'], { connection, webServer })
    assert.equal(matched, 1, 'the rebuilt assembly adopts the host Web seam')
    assert.equal(webServer.routes.length, 1, 'the rebuilt assembly mounts a fresh route')

    await second.ctx.__lifecycle.dispose()
    assert.equal(second.ctx.__lifecycle.listenerCount(), 0, 'rebuilt assembly tears down cleanly')
    assert.equal(webServer.routes.length, 0, 'rebuilt assembly unmounts its route')
  } finally {
    home.cleanup()
  }
})