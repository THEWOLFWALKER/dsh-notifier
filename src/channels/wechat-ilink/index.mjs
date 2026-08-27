// 微信 iLink provider slice。
// Channel Registry -> Transport Adapter -> Control Core -> Native Renderer：
// 本模块只负责 iLink 身份、轮询、重连、协议归一和微信文本渲染；权限/审批语义仍在 bus/Control Core。

import {
  createWechatIlinkInbound as createLegacyInbound,
  resolveWechatInboundConfig,
  ACCOUNT_KEY,
} from './legacy-core.mjs'
import {
  boundedCursor,
  normalizeInboundMessage,
  normalizeQrStatus,
  normalizeUpdateBatch,
  normalizeImageItem,
  validAccountId,
  validBoundedToken,
  MAX_CURSOR_LENGTH,
  MAX_CONTEXT_TOKEN_LENGTH,
} from './protocol.mjs'

/** 只有协议/契约测试证据；没有把 mock 当真实设备支持。 */
export const WECHAT_ILINK_CAPABILITIES = Object.freeze({
  qrLogin: 'contract-tested',
  boundedPolling: 'contract-tested',
  cursorRecovery: 'contract-tested',
  sessionExpiryRescan: 'contract-tested',
  text: 'contract-tested',
  imageReceive: 'contract-tested',
  imageSend: 'declared',
  controlTextFallback: 'contract-tested',
  connectionStatus: 'contract-tested',
  realDeviceVerified: false,
})

/**
 * New provider entry. State keys are account-scoped; the old inbound entry remains a
 * compatibility facade for existing callers/tests and historical state files.
 */
export function createWechatIlinkInbound(options = {}) {
  const config = options.config ?? {}
  const store = options.store ?? null
  const legacy = createLegacyInbound({
    ...options,
    accountScoped: true,
    onSessionExpired: (detail) => {
      // Login CLI historically writes wechat:account. Remove only that provider credential;
      // unrelated channels and identity bindings are untouched.
      try { store?.delete(ACCOUNT_KEY) } catch { /* state cleanup is best effort */ }
      try { options.onSessionExpired?.(detail) } catch { /* callback isolation */ }
    },
  })

  const media = options.mediaAdapter
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/channel:wechat-ilink]', message) } catch { /* no-op */ }
    try { console.error('[dsh-notifier/channel:wechat-ilink]', message) } catch { /* no-op */ }
  }

  return {
    ...legacy,
    channel: 'wechat',
    accountId: String(config.accountId ?? ''),
    capabilities: Object.freeze({
      ...legacy.capabilities,
      imageInbound: true,
      imageOutbound: false,
      evidence: WECHAT_ILINK_CAPABILITIES,
    }),
    status() {
      try { return legacy.status() } catch { return { state: 'disconnected', accountId: String(config.accountId ?? ''), qrRequired: false } }
    },
    /** Optional media bridge. No guessed HTTP shape is sent without protocol evidence. */
    async sendImage(chatId, image) {
      if (typeof media?.sendImage !== 'function') {
        warn('iLink 图片发送尚无协议/设备证据，已保留文本兜底；能力状态 declared')
        return false
      }
      try {
        const result = await media.sendImage({ accountId: String(config.accountId ?? ''), chatId: String(chatId ?? ''), image })
        return result === true || result?.ok === true
      } catch (error) {
        warn(`图片发送失败（文字路径不受影响）：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    async downloadImage(message) {
      if (typeof media?.downloadImage !== 'function') return null
      try { return await media.downloadImage(message) } catch (error) {
        warn(`图片下载失败（文字路径不受影响）：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },
  }
}

/** Naming used by the channel registry in newer integrations. */
export const createWechatIlinkTransport = createWechatIlinkInbound

export {
  ACCOUNT_KEY,
  resolveWechatInboundConfig,
  normalizeInboundMessage,
  normalizeQrStatus,
  normalizeUpdateBatch,
  normalizeImageItem,
  boundedCursor,
  validAccountId,
  validBoundedToken,
  MAX_CURSOR_LENGTH,
  MAX_CONTEXT_TOKEN_LENGTH,
}

export const capabilityEvidence = WECHAT_ILINK_CAPABILITIES
