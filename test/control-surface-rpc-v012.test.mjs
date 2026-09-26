import test from 'node:test'
import assert from 'node:assert/strict'

import { registerControlSurfaceRpc, CONTROL_SURFACE_CHANNEL } from '../src/control-surface/rpc.mjs'

// 真机 0.1.7-rc.2 回归：宿主 `connection.rpc.handle` 对第三方抛
// `cannot get property "webServer" without inject`，通道必须仍能挂到 webServer 上并
// 按 Connection 信封收发，否则 Native Control Surface 在真机上是死的（405）。

function fakeReq({ url, method = 'POST', body, contentType = 'application/json' }) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    url,
    method,
    headers: { 'content-type': contentType },
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { value: chunks[index++], done: false }
          : { value: undefined, done: true }),
      }
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; return res },
    end(body) { res.body = body ?? ''; res.writableEnded = true; return res },
    on() { return res },
  }
  return res
}

function mountRoutes(ctx, service) {
  const routes = []
  ctx.webServer = { register(route) { routes.push(route); return () => {} } }
  const dispose = registerControlSurfaceRpc(ctx, service)
  return { routes, dispose }
}

test('falls back to a webServer prefix route when the host rpc.handle is unusable', async () => {
  const ctx = {
    connection: {
      rpc: { handle() { throw new Error('cannot get property "webServer" without inject') } },
      admit: () => ({ peer: {} }),
    },
    effect(fn) { return fn() },
  }
  const service = { call: async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }) }
  const { routes, dispose } = mountRoutes(ctx, service)

  assert.equal(typeof dispose, 'function')
  assert.equal(routes.length, 1)
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: CONTROL_SURFACE_CHANNEL })

  const res = fakeRes()
  await routes[0].handler(fakeReq({
    url: `${CONTROL_SURFACE_CHANNEL}/surface.home`,
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'surface.home', payload: { a: 1 } }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    type: 'server-response',
    rpcId: 'r1',
    result: { ok: true, value: { endpoint: 'surface.home', payload: { a: 1 } } },
  })
})

test('prefers the host rpc.handle seam when it works', () => {
  let handled = null
  const ctx = {
    connection: { rpc: { handle(channel, handler) { handled = { channel, handler }; return () => {} } } },
    webServer: { register() { throw new Error('webServer fallback must not run when rpc.handle works') } },
    effect(fn) { return fn() },
  }
  const service = { call: async () => ({ ok: true, value: 1 }) }
  const dispose = registerControlSurfaceRpc(ctx, service)

  assert.equal(typeof dispose, 'function')
  assert.equal(handled.channel, CONTROL_SURFACE_CHANNEL)
  assert.equal(typeof handled.handler, 'function')
})

test('route enforces admission, path and envelope guards', async () => {
  const ctx = {
    connection: { rpc: {}, admit: () => ({ rejection: 401 }) },
    effect(fn) { return fn() },
  }
  const { routes } = mountRoutes(ctx, { call: async () => ({ ok: true, value: null }) })
  const route = routes[0]

  const denied = fakeRes()
  await route.handler(fakeReq({ url: `${CONTROL_SURFACE_CHANNEL}/surface.home`, body: '{}' }), denied)
  assert.equal(denied.status, 401)

  ctx.connection.admit = () => ({ peer: {} })

  const offChannel = fakeRes()
  await route.handler(fakeReq({ url: '/api/elsewhere', body: '{}' }), offChannel)
  assert.equal(offChannel.status, 404)

  const notJson = fakeRes()
  await route.handler(fakeReq({ url: `${CONTROL_SURFACE_CHANNEL}/surface.home`, body: '{}', contentType: 'text/plain' }), notJson)
  assert.equal(notJson.status, 415)

  const mismatch = fakeRes()
  await route.handler(fakeReq({
    url: `${CONTROL_SURFACE_CHANNEL}/surface.home`,
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'other', payload: {} }),
  }), mismatch)
  assert.equal(mismatch.status, 200)
  assert.equal(JSON.parse(mismatch.body).result.error.code, 'gateway/bad-request')
})

test('route converts handler failures to a stable structured error without leaking internals', async () => {
  const ctx = {
    connection: { rpc: {}, admit: () => ({ peer: {} }) },
    effect(fn) { return fn() },
  }
  const { routes } = mountRoutes(ctx, {
    call: async () => { throw new Error('secret provider token must not cross the RPC boundary') },
  })
  const res = fakeRes()
  await routes[0].handler(fakeReq({
    url: `${CONTROL_SURFACE_CHANNEL}/surface.home`,
    body: JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'surface.home', payload: {} }),
  }), res)

  assert.equal(res.status, 200)
  const response = JSON.parse(res.body)
  assert.deepEqual(response, {
    type: 'server-response',
    rpcId: 'r3',
    result: {
      ok: false,
      error: { code: 'gateway/internal', message: 'control surface unavailable', details: {} },
    },
  })
  assert.doesNotMatch(res.body, /secret provider token/)
})
