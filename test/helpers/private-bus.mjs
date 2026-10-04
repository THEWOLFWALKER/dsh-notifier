import { createInboundBus } from '../../src/inbound/bus.mjs'

// Adapter tests exercise provider parsing and transport behavior. Their fixture represents
// users already paired to whichever explicit provider account the adapter resolves.
export function createPrivateTestBus({ allowUsers = [], ...options } = {}) {
  const allowed = new Set((Array.isArray(allowUsers) ? allowUsers : []).map(String))
  const identity = {
    isEmpty() { return allowed.size === 0 },
    allows(channel, userId, accountId) {
      return typeof channel === 'string' && String(accountId ?? '').trim() !== '' && allowed.has(String(userId ?? ''))
    },
  }
  return createInboundBus({ ...options, identity })
}
