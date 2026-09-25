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
