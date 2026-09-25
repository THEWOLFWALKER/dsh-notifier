import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdentity } from '../src/inbound/identity.mjs'

function memoryStore() {
  const state = new Map()
  return {
    get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
    set: (key, value) => { state.set(key, value); return true },
  }
}

test('P2-01：待确认绑定队列最多保留 512 条', () => {
  const store = memoryStore()
  const identity = createIdentity({ store, logger: { warn: () => {} } })
  for (let index = 0; index < 600; index += 1) {
    assert.equal(identity.addPending({ channel: 'telegram', userId: `user-${index}` }).ok, true)
  }
  assert.ok(Object.keys(store.get('inbound:pending', {})).length <= 512)
})
