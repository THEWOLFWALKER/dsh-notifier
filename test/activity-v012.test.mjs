import test from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'

test('activity projection refuses sensitive detail keys and returns frozen ActivityView shape', () => {
  const activity = createSurfaceActivity()
  activity.record('configuration', 'channel-saved', {
    channel: 'telegram',
    token: 'SECRET',
    chatId: '123',
    content: 'private text',
    saved: true,
  })
  const row = activity.list()[0]
  assert.equal(row.category, 'configuration')
  assert.equal(row.level, 'info')
  assert.ok(row.at)
  assert.ok(row.timeText)
  assert.ok(row.title)
  const json = JSON.stringify(row)
  assert.equal(json.includes('SECRET'), false)
  assert.equal(json.includes('private text'), false)
  assert.equal(json.includes('"chatId"'), false)
  assert.equal(json.includes('"token"'), false)
})
