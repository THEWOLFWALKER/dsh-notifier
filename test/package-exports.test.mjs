import test from 'node:test'
import assert from 'node:assert/strict'

test('package root exposes only the stable DSH plugin contract', async () => {
  const entry = await import('dsh-notifier')
  assert.deepEqual(Object.keys(entry).sort(), ['apply', 'inject', 'name'])
  assert.equal('createStore' in entry, false)
  assert.equal('createTokenVault' in entry, false)
  assert.equal('createPublicFacade' in entry, false)
})

test('internal constructors require the explicit internal export', async () => {
  const internal = await import('dsh-notifier/internal')
  assert.equal(typeof internal.createStore, 'function')
  assert.equal(typeof internal.createPublicFacade, 'function')
})
