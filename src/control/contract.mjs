// Normalized desktop/mobile control envelope and fail-closed compatibility facade.
// This module owns validation/receipts only; session policy and provider transport stay upstream.

const COMMANDS = new Set(['stop', 'question-answer', 'approval', 'steer', 'ordinary-message'])
const RECEIPTS = new Set(['accepted', 'rejected', 'expired', 'already_handled', 'transport_failed', 'desktop_fallback'])
const REQUIRED = ['eventId', 'sessionId', 'source', 'channel', 'accountId', 'userId', 'chatId', 'policyVersion', 'command', 'createdAt', 'expiresAt']

const text = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : null

export function normalizeControlEvent(input, now = Date.now()) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'malformed' }
  for (const key of REQUIRED.filter((key) => key !== 'createdAt' && key !== 'expiresAt')) if (text(input[key]) === null) return { ok: false, reason: `missing_${key}` }
  if (!COMMANDS.has(input.command)) return { ok: false, reason: 'unknown_command' }
  const createdAt = Number(input.createdAt)
  const expiresAt = Number(input.expiresAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || createdAt > now) return { ok: false, reason: 'invalid_timestamps' }
  if (expiresAt <= now) return { ok: false, reason: 'expired' }
  return {
    ok: true,
    event: Object.freeze({
      eventId: text(input.eventId), sessionId: text(input.sessionId), source: text(input.source),
      channel: text(input.channel), accountId: text(input.accountId), userId: text(input.userId),
      chatId: text(input.chatId), policyVersion: text(input.policyVersion), command: input.command,
      ...(typeof input.chatType === 'string' && input.chatType !== '' ? { chatType: input.chatType } : {}),
      createdAt, expiresAt,
    }),
  }
}

export function makeReceipt(status, event = null, reason = undefined) {
  const safeStatus = RECEIPTS.has(status) ? status : 'desktop_fallback'
  const receipt = { status: safeStatus }
  if (event && typeof event === 'object') {
    if (text(event.eventId)) receipt.eventId = text(event.eventId)
    if (text(event.sessionId)) receipt.sessionId = text(event.sessionId)
  }
  if (text(reason)) receipt.reason = text(reason)
  return Object.freeze(receipt)
}

/**
 * Build a compatibility facade around existing pending lookup and settlement callbacks.
 * Callbacks are injected so this layer cannot mutate unrelated state keys or approve on errors.
 */
export function createControlContract({ getPending, settle, now = Date.now, handled = new Set(), onAudit = () => {} } = {}) {
  if (typeof getPending !== 'function' || typeof settle !== 'function') throw new TypeError('getPending and settle are required')
  return {
    handle(input) {
      const normalized = normalizeControlEvent(input, now())
      if (!normalized.ok) return makeReceipt(normalized.reason === 'expired' ? 'expired' : 'rejected', input, normalized.reason)
      const event = normalized.event
      if (handled.has(event.eventId)) return makeReceipt('already_handled', event, 'duplicate_event')
      let pending
      try { pending = getPending(event) } catch (error) {
        onAudit('lookup_failed', event, error)
        return makeReceipt('desktop_fallback', event, 'lookup_failed')
      }
      if (!pending || typeof pending !== 'object' || pending.status === 'resolved' || pending.status === 'terminated') return makeReceipt('rejected', event, 'not_pending')
      for (const key of ['sessionId', 'channel', 'accountId', 'userId', 'chatId', 'policyVersion']) {
        if (text(pending[key]) === null || pending[key] !== event[key]) return makeReceipt('rejected', event, `source_mismatch_${key}`)
      }
      if (Number(pending.expiresAt) <= now() || event.expiresAt <= now()) return makeReceipt('expired', event, 'expired')
      handled.add(event.eventId)
      try {
        const result = settle(event, pending)
        if (result === false) return makeReceipt('desktop_fallback', event, 'settlement_failed')
        onAudit('accepted', event)
        return makeReceipt('accepted', event)
      } catch (error) {
        onAudit('settlement_failed', event, error)
        return makeReceipt('desktop_fallback', event, 'settlement_failed')
      }
    },
    receipts: Object.freeze({ commands: Object.freeze([...COMMANDS]), statuses: Object.freeze([...RECEIPTS]) }),
  }
}
