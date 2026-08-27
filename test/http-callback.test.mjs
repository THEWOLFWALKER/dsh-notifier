import test from 'node:test'
import assert from 'node:assert/strict'
import { startHttpCallback } from '../src/inbound/http-callback.mjs'

test('http callback：处理器超时返回 408，不让悬挂 promise 占住请求', async () => {
  const callback = await startHttpCallback({
    path: '/hook',
    port: 0,
    requestTimeoutMs: 20,
    onPayload: async () => new Promise(() => {}),
  })
  try {
    const response = await fetch(`http://127.0.0.1:${callback.port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
    assert.equal(response.status, 408)
  } finally {
    await callback.close()
  }
})
