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

test('C10：launch ticket 容量绝不瞬时超过上限，保留最新票据', () => {
  const tickets = createLaunchTickets({ max: 4 })
  const minted = Array.from({ length: 10 }, () => tickets.mint())
  assert.equal(tickets.size(), 4)
  assert.equal(tickets.consume(minted[0].ticket), false)
  assert.equal(tickets.consume(minted.at(-1).ticket), true)
})
