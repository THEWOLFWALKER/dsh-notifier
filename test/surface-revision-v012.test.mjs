import test from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'

test('surface revision wakes one wait on touch and times out without spinning', async () => {
  const rev = createSurfaceRevision()
  const cursor = rev.current().revision
  const pending = rev.wait({ after: cursor, timeoutMs: 1_000 })
  rev.touch('channels')
  const next = await pending
  assert.equal(next.topic, 'channels')
  assert.ok(next.revision > cursor)
  rev.dispose()
})

test('surface revision carries an epoch and restarts reset cursor identity', () => {
  const first = createSurfaceRevision({ epoch: 'boot-a' })
  const second = createSurfaceRevision({ epoch: 'boot-b' })
  assert.equal(first.current().epoch, 'boot-a')
  assert.equal(second.current().epoch, 'boot-b')
  assert.equal(first.current().revision, 1)
  assert.equal(second.current().revision, 1)
  assert.notEqual(first.current().epoch, second.current().epoch)
})
