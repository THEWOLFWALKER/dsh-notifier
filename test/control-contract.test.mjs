import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeControlEvent, makeReceipt, createControlContract } from '../src/control/contract.mjs'

const base = (extra = {}) => ({ eventId: 'e1', sessionId: 's1', source: 'mobile', channel: 'telegram', accountId: 'a1', userId: 'u1', chatId: 'c1', policyVersion: 'p1', command: 'stop', createdAt: 100, expiresAt: 200, ...extra })
const pending = () => ({ sessionId: 's1', channel: 'telegram', accountId: 'a1', userId: 'u1', chatId: 'c1', policyVersion: 'p1', expiresAt: 200 })

test('normalize rejects malformed, unknown and invalid timestamps; chat is required', () => {
  assert.equal(normalizeControlEvent(null, 0).ok, false)
  assert.equal(normalizeControlEvent(base({ chatId: '' }), 0).reason, 'missing_chatId')
  assert.equal(normalizeControlEvent(base({ command: 'delete' }), 0).reason, 'unknown_command')
  assert.equal(normalizeControlEvent(base({ createdAt: 'x' }), 0).reason, 'invalid_timestamps')
  assert.equal(normalizeControlEvent(base({ createdAt: 300 }), 150).reason, 'invalid_timestamps')
  assert.equal(normalizeControlEvent(base({ expiresAt: 120 }), 150).reason, 'expired')
})

test('normalize returns stable event and receipts never leak secrets/content', () => {
  const result = normalizeControlEvent(base(), 150)
  assert.equal(result.ok, true)
  assert.equal(Object.isFrozen(result.event), true)
  const receipt = makeReceipt('accepted', { eventId: 'e1', sessionId: 's1', token: 'secret', content: 'private' })
  assert.deepEqual(receipt, { status: 'accepted', eventId: 'e1', sessionId: 's1' })
})

test('facade enforces source binding, expiry, duplicate and first-valid-wins', () => {
  let calls = 0
  const facade = createControlContract({ getPending: () => pending(), settle: () => { calls++; return true }, now: () => 150 })
  assert.equal(facade.handle(base()).status, 'accepted')
  assert.equal(facade.handle(base()).status, 'already_handled')
  assert.equal(facade.handle(base({ eventId: 'e2', chatId: 'wrong' })).status, 'rejected')
  assert.equal(calls, 1)
})

test('facade rejects stale policy and expired pending before settlement', () => {
  let calls = 0
  const stale = createControlContract({ getPending: () => ({ ...pending(), policyVersion: 'p0' }), settle: () => { calls++ }, now: () => 150 })
  assert.equal(stale.handle(base()).status, 'rejected')
  const expired = createControlContract({ getPending: () => ({ ...pending(), expiresAt: 120 }), settle: () => { calls++ }, now: () => 150 })
  assert.equal(expired.handle(base({ eventId: 'e2' })).status, 'expired')
  assert.equal(calls, 0)
})

test('facade catches lookup and handler/store failures as desktop_fallback', () => {
  const lookup = createControlContract({ getPending: () => { throw new Error('store down') }, settle: () => true, now: () => 150 })
  assert.equal(lookup.handle(base()).status, 'desktop_fallback')
  const handler = createControlContract({ getPending: pending, settle: () => { throw new Error('boom') }, now: () => 150 })
  assert.equal(handler.handle(base()).status, 'desktop_fallback')
})

test('facade remains fail-closed after restart and ignores already-resolved pending rows', () => {
  const saved = pending()
  saved.status = 'resolved'
  const facade = createControlContract({ getPending: () => saved, settle: () => { throw new Error('must not settle') }, now: () => 150 })
  assert.equal(facade.handle(base()).status, 'rejected')
})

test('all supported commands normalize', () => {
  for (const command of ['stop', 'question-answer', 'approval', 'steer', 'ordinary-message']) assert.equal(normalizeControlEvent(base({ command }), 150).ok, true)
})
