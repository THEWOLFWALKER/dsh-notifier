// Provider facade for Feishu/Lark.
// Transport and rendering stay here; approval/session semantics remain in Control Core.

import { createFeishuInbound as createLegacyInbound, resolveFeishuInboundConfig } from '../../inbound/feishu-bot.mjs'

export const FEISHU_CAPABILITIES = Object.freeze({
  websocket: 'contract-tested',
  richCards: 'contract-tested',
  cardUpdate: 'contract-tested',
  buttonCallbacks: 'contract-tested',
  fileSend: 'declared',
  sourceChatBinding: 'contract-tested',
  groupVisibility: 'contract-tested',
  realDeviceVerified: false,
})

/** Normalize only the transport metadata needed by the shared Control Core.
 *  The accountId is intentionally NEVER taken from the event payload — the transport
 *  overlays its own resolved `accountId ?? appId` in `normalizeCallback`, so an adapter
 *  or attacker cannot mint the source a later authorization compares against. */
export function normalizeFeishuCallback(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input.action?.value
  const action = typeof value?.act === 'string' ? value.act : ''
  const chatId = String(input.context?.open_chat_id ?? input.open_chat_id ?? input.chat_id ?? '').trim()
  const userId = String(input.operator?.open_id ?? input.sender?.sender_id?.open_id ?? '').trim()
  if (action === '' || chatId === '' || userId === '') return null
  return Object.freeze({ channel: 'feishu', accountId: '', userId, chatId, action })
}

export function createFeishuTransport(options = {}) {
  // Stable resolver: explicit config.accountId wins, else appId. NEVER event-supplied or
  // derived from a secret. Fed down so the shared inbound injects it into every envelope.
  const accountId = String(options.config?.accountId ?? options.config?.appId ?? '').trim()
  const legacy = createLegacyInbound({ ...options, accountId })
  const fileAdapter = options.fileAdapter
  return {
    ...legacy,
    channel: 'feishu',
    accountId,
    capabilities: Object.freeze({ ...FEISHU_CAPABILITIES, ...(legacy.capabilities ?? {}) }),
    status() {
      return { state: legacy.clientState?.() ?? 'idle', accountId, websocket: legacy.clientState?.() === 'connected' }
    },
    async sendFile(target, file) {
      if (typeof fileAdapter?.sendFile !== 'function') return false
      try {
        const result = await fileAdapter.sendFile({ channel: 'feishu', accountId, chatId: String(target?.chatId ?? target ?? ''), file })
        return result === true || result?.ok === true
      } catch { return false }
    },
    normalizeCallback(input) {
      const callback = normalizeFeishuCallback(input)
      return callback === null ? null : Object.freeze({ ...callback, accountId })
    },
  }
}

export const createFeishuInbound = createFeishuTransport
export { resolveFeishuInboundConfig }
export const capabilityEvidence = FEISHU_CAPABILITIES
