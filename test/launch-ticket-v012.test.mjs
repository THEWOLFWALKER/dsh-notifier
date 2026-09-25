import test from 'node:test'
import assert from 'node:assert/strict'
import { createLaunchTickets } from '../src/control-surface/launch-ticket.mjs'

test('launch ticket is one-time and replay fails', () => {
  let now = 1000
  const tickets = createLaunchTickets({ now: () => now, ttlMs: 10_000 })
  const minted = tickets.mint()
  assert.equal(tickets.consume(minted.ticket), true)
  assert.equal(tickets.consume(minted.ticket), false)
})

test('launch ticket expires', () => {
  let now = 1000
  const tickets = createLaunchTickets({ now: () => now, ttlMs: 10_000 })
  const minted = tickets.mint()
  now += 20_000
  assert.equal(tickets.consume(minted.ticket), false)
})
