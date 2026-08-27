// Provider facade for Telegram.
// The existing inbound implementation owns transport mechanics; Control Core owns policy.

import { createTelegramInbound as createLegacyInbound } from '../../inbound/telegram-bot.mjs'

export const TELEGRAM_CAPABILITIES = Object.freeze({
  commands: 'contract-tested',
  inlineButtons: 'contract-tested',
  messageEdit: 'contract-tested',
  fileSend: 'declared',
  textFallback: 'contract-tested',
  callbackChatBinding: 'contract-tested',
  reconnect: 'contract-tested',
  realDeviceVerified: false,
})

/** Normalize Telegram callback metadata before handing the action to Control Core.
 *  The accountId is intentionally NEVER taken from the event payload — an adapter or
 *  attacker must not mint the source a later authorization compares against. The
 *  transport overlays its own resolved accountId in `normalizeCallback`. */
export function normalizeTelegramCallback(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const action = String(input.data ?? '').trim()
  const chatId = String(input.message?.chat?.id ?? '').trim()
  const userId = String(input.from?.id ?? '').trim()
  if (action === '' || chatId === '' || userId === '') return null
  return Object.freeze({ channel: 'telegram', accountId: '', userId, chatId, action })
}

export function createTelegramTransport(options = {}) {
  // Never use botToken as an account identifier: account ids may appear in receipts/audit.
  const accountId = String(options.config?.accountId ?? 'default').trim() || 'default'
  // Feed the resolved accountId through to the shared inbound so it is injected into every
  // normalized envelope (message, callback, action, approval, question).
  const legacy = createLegacyInbound({ ...options, accountId })
  const fileAdapter = options.fileAdapter
  return {
    ...legacy,
    channel: 'telegram',
    accountId,
    capabilities: Object.freeze({ ...TELEGRAM_CAPABILITIES, ...(legacy.capabilities ?? {}) }),
    status() { return { state: legacy.clientState?.() ?? 'stopped', accountId, polling: legacy.clientState?.() === 'connected' } },
    async sendFile(target, file) {
      if (typeof fileAdapter?.sendFile !== 'function') return false
      try {
        const result = await fileAdapter.sendFile({ channel: 'telegram', accountId, chatId: String(target?.chatId ?? target ?? ''), file })
        return result === true || result?.ok === true
      } catch { return false }
    },
    normalizeCallback(input) {
      const callback = normalizeTelegramCallback(input)
      return callback === null ? null : Object.freeze({ ...callback, accountId })
    },
  }
}

export const createTelegramInbound = createTelegramTransport
export const capabilityEvidence = TELEGRAM_CAPABILITIES
