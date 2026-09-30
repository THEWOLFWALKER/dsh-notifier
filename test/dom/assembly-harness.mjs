// Isolated "real assembly" harness for booting the dsh-notifier plugin against a
// fake host, with no real network.
//
// HONESTY NOTE — Cordis availability:
//   @deepseek-ai/cordis is a *peer* dependency (`package.json.peerDependencies`)
//   and is NOT installed in this sandbox; dsh-notifier also has no runtime import
//   of it (verified: no `from '@deepseek-ai/...'` in src/). We therefore provide a
//   minimal, faithful STAND-IN for the Cordis context/lifecycle surface this
//   plugin actually consumes: `effect`, `on`, `inject`, `provide`, `emit` and a
//   `logger`. It is NOT the official Cordis runtime — it is only as faithful as
//   the seams exercised below. If the real `@deepseek-ai/cordis` becomes
//   installable, swap `createFakeCordis` for it; the fake HTTP/WS/SDK endpoints
//   and the smoke test stay valid.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Isolated temporary DSH_HOME. */
export function createTempDshHome(prefix = 'dsh-notifier-home-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

// ---------------------------------------------------------------------------
// Fake host endpoints (in-process, no sockets)
// ---------------------------------------------------------------------------

/** In-memory prefix router standing in for the host webServer. */
export function createFakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    /** Dispatch a synthetic request to the first matching prefix route. */
    async dispatch(req, res) {
      const pathname = new URL(String(req?.url ?? '/'), 'http://dsh.internal').pathname
      const route = routes.find((entry) => entry.kind === 'prefix' && pathname.startsWith(entry.path))
      if (!route) { res.writeHead(404, {}); res.end('no route'); return false }
      await route.handler(req, res)
      return true
    },
  }
}

/** Fake connection service. No `rpc.handle` by default → exercises the webServer mount. */
export function createFakeConnection({ admit, rpcHandle } = {}) {
  const connection = { admit: admit ?? (() => null) }
  if (typeof rpcHandle === 'function') {
    const handles = new Map()
    connection.rpc = {
      handle(channel, handler) {
        handles.set(channel, handler)
        return () => handles.delete(channel)
      },
      __handles: handles,
    }
  }
  return connection
}

/** Fake WebSocket endpoint stub (for later tasks; inert here). */
export function createFakeWsEndpoint() {
  const listeners = new Set()
  const sent = []
  return {
    sent,
    send(message) { sent.push(message) },
    close() {},
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    __emit(message) { for (const listener of listeners) listener(message) },
  }
}

/** Fake DSH SDK stub (for later tasks; inert here). */
export function createFakeSdk() {
  const calls = []
  return {
    calls,
    async call(method, params) { calls.push({ method, params }); return { ok: true } },
  }
}

/** Synthetic server request that the surface handler can read as an async iterable body. */
export function createFakeRequest({ method = 'POST', url = '/', body, contentType = 'application/json' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const headers = { 'content-type': contentType }
  if (chunks.length > 0) headers['content-length'] = String(chunks[0].length)
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]() {
      let index = 0
      return { next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }) }
    },
  }
}

/** Synthetic server response capturing status/headers/body. */
export function createFakeResponse() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers },
    end(payload = '') { res.body += payload; res.writableEnded = true },
    on() {},
  }
  return res
}

// ---------------------------------------------------------------------------
// Minimal Cordis stand-in
// ---------------------------------------------------------------------------

/**
 * Minimal lifecycle + context stand-in. `effect`/`on`/`inject`/`provide`/`emit`
 * behave like the subset of Cordis this plugin consumes.
 */
export function createFakeCordis({ logger, services } = {}) {
  const effects = []
  const listeners = new Map()
  const injections = []
  const provided = new Map()
  let disposed = false

  const base = {
    logger: logger ?? { warn() {}, info() {}, debug() {} },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        try { listener(payload) } catch { /* listener failures are not fatal in cordis */ }
      }
      return true
    },
    effect(callback) {
      const result = callback()
      effects.push(result)
      return result
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
    inject(names, callback) {
      const entry = { names: [...names], callback }
      injections.push(entry)
      return () => {
        const index = injections.indexOf(entry)
        if (index >= 0) injections.splice(index, 1)
      }
    },
  }

  const ctx = { ...base, ...(services ?? {}) }

  // Real cordis runs the inject callback as soon as the named services exist.
  // Tests drive that here to prove a LATE-injected service is picked up.
  ctx.__inject = (names, injected = {}) => {
    const key = [...names].join(',')
    let matched = 0
    for (const entry of [...injections]) {
      if (entry.names.join(',') !== key) continue
      matched += 1
      entry.callback({ ...base, ...injected })
    }
    return matched
  }

  ctx.__lifecycle = {
    effects,
    injections,
    provided,
    hasInjection(names) { return injections.some((entry) => entry.names.join(',') === [...names].join(',')) },
    // Counts only listeners the plugin left registered. Teardown is *not*
    // faked here: each `on()` disposer must remove its own listener, so a
    // non-zero count after dispose is a real leak the smoke test can catch.
    listenerCount() { let total = 0; for (const set of listeners.values()) total += set.size; return total },
    listenerEvents() { return [...listeners.entries()].filter(([, set]) => set.size > 0).map(([event]) => event) },
    async dispose() {
      if (disposed) return
      disposed = true
      const pending = []
      for (const dispose of [...effects].reverse()) {
        try {
          const result = typeof dispose === 'function' ? dispose() : undefined
          if (result && typeof result.then === 'function') pending.push(result)
        } catch { /* dispose failures must not abort the rest */ }
      }
      await Promise.allSettled(pending)
      injections.length = 0
      provided.clear()
    },
  }

  return ctx
}

/** Boot the real plugin entry against the fake host. `apply` is synchronous. */
export async function bootPlugin({ config = {}, services, logger } = {}) {
  const entry = await import('../../src/plugin-entry.mjs')
  const ctx = createFakeCordis({ logger, services })
  const resolved = entry.apply(ctx, config)
  return { ctx, resolved, entry }
}