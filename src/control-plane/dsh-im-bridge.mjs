// EXPERIMENTAL: simulated service/export contract, not verified against current dsh-im.
// dsh-notifier v0.15 (T22) — optional dsh-im delivery bridge.
//
// The host MAY expose an optional `ctx.dshIm` service (send / listBots / listTargets).
// This bridge is the *only* module that touches it, and it does so defensively. It
// is NOT a provider adapter: it holds no platform credential, makes no HTTP call,
// copies no session/permission, and never guesses a bot prefix. It only delegates a
// user-selected, opaque `(botId, targetId)` reference to the host service.
//
// Availability is dynamic: the service can be missing at boot, arrive late, be
// withdrawn, or be recreated. The bridge therefore re-reads it on every operation
// (never caches a single object across calls) and guards in-flight sends with a
// monotonic epoch — a late result from a service that was withdrawn/replaced while
// a send was airborne is discarded as `unknown`, never reported as accepted.
//
// Delivery evidence is honest (three buckets, matching delivery-evidence.mjs):
//   - `sent === true`            -> accepted  (provider accepted the request; no receipt)
//   - `sent === false`/rejected  -> rejected  (deterministic non-delivery)
//   - timeout / abort / ambiguous -> unknown  (the request may already have been sent)
// Text-only: any media / interactive capability is explicitly rejected (unsupported).
//
// This module owns NO durable state (no store key); the opaque target reference is
// caller/client-held desired. Disabling the bridge leaves dsh-im's own targets and
// the notifier's own channels untouched.

import { readHostService } from '../host/seam.mjs'

const ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'host-unavailable',
  NO_TARGET: 'bad-request',
  UNSUPPORTED: 'not-supported',
})

const str = (value) => (typeof value === 'string' ? value.trim() : '')
const isRecord = (value) => value !== null && typeof value === 'object'

function dshImError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** A send that timed out / was cancelled may already have reached the target → unknown. */
function looksUncertain(error) {
  if (!isRecord(error)) return true
  const hay = `${str(error.code)} ${str(error.name)} ${str(error.message)}`.toLowerCase()
  return /timeout|timed.?out|abort|cancel|econnreset|econnrefused|socket closed|网络|超时|中断/.test(hay)
}

/**
 * @param {object} deps
 * @param {(ctx?: any) => object|null} [deps.readService] - returns the current ctx.dshIm or null.
 * @param {object|null} [deps.ctx] - cordis context (used only when readService is absent).
 * @param {(message: string) => void} [deps.warn]
 */
export function createDshImBridge({ readService = null, ctx = null, warn = null } = {}) {
  const report = (message) => { try { warn?.(message) } catch { /* 诊断绝不致命 */ } }

  // Default reader: defensive host-service read via the centralized seam.
  let reader = readService
  if (typeof reader !== 'function') {
    reader = () => {
      try { return readHostService(ctx, 'dshIm') } catch { return null }
    }
  }

  // ————————————————— live service handle + epoch —————————————————
  let epoch = 0
  let current = null
  /** Re-read the current service; bump epoch whenever its identity changes. */
  const observe = () => {
    let service = null
    try { service = reader() } catch { service = null }
    service = isRecord(service) ? service : null
    if (service !== current) {
      current = service
      epoch += 1
    }
    return service
  }

  const status = () => {
    const service = observe()
    return {
      available: service !== null,
      reason: service === null ? 'no-dsh-im' : 'ok',
      hasSend: service !== null && typeof service.send === 'function',
      hasListBots: service !== null && typeof service.listBots === 'function',
      hasListTargets: service !== null && typeof service.listTargets === 'function',
    }
  }

  // ————————————————— safe projection (never leak platform credentials) —————————————————
  const botOf = (raw) => {
    if (!isRecord(raw)) return null
    const botId = str(raw.botId ?? raw.id)
    if (botId === '') return null
    const label = str(raw.label ?? raw.name ?? raw.title) || botId
    const platform = str(raw.platform)
    return { botId, label, ...(platform !== '' ? { platform } : {}) }
  }

  const targetOf = (raw) => {
    if (!isRecord(raw)) return null
    const targetId = str(raw.targetId ?? raw.id)
    if (targetId === '') return null
    const label = str(raw.label ?? raw.name ?? raw.title) || targetId
    const kind = str(raw.kind ?? raw.channel)
    return { targetId, label, ...(kind !== '' ? { kind } : {}) }
  }

  /**
   * Enumerate the host's public bots (stable, opaque ids + safe labels only).
   * @returns {Promise<Array<{ botId: string, label: string, platform?: string }>>}
   */
  async function listBots() {
    const service = observe()
    if (service === null) throw dshImError('dsh-im 服务不可用', ERROR_CODES.UNAVAILABLE)
    if (typeof service.listBots !== 'function') {
      throw dshImError('当前 dsh-im 服务不支持 listBots', ERROR_CODES.UNSUPPORTED)
    }
    const raw = await service.listBots()
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.bots) ? raw.bots : [])
    return rows.map(botOf).filter((row) => row !== null)
  }

  /**
   * Enumerate the host's public targets for one bot.
   * @returns {Promise<Array<{ targetId: string, label: string, kind?: string }>>}
   */
  async function listTargets(botId) {
    const service = observe()
    if (service === null) throw dshImError('dsh-im 服务不可用', ERROR_CODES.UNAVAILABLE)
    if (typeof service.listTargets !== 'function') {
      throw dshImError('当前 dsh-im 服务不支持 listTargets', ERROR_CODES.UNSUPPORTED)
    }
    const raw = await service.listTargets(str(botId))
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.targets) ? raw.targets : [])
    return rows.map(targetOf).filter((row) => row !== null)
  }

  /**
   * Delegate one plain-text send to the host dsh-im service.
   * @param {{ botId: string, targetId: string, text: string, options?: object }} input
   * @returns {Promise<{ ok: boolean, accepted: boolean, confirmed: false,
   *   unknown: boolean, rejected: boolean, reason?: string }>}
   */
  async function send(input = {}) {
    const botId = str(input?.botId)
    const targetId = str(input?.targetId)
    const text = str(input?.text)
    const options = input?.options ?? null
    if (botId === '' || targetId === '') {
      throw dshImError('未选择 dsh-im 目标（botId/targetId 为空）', ERROR_CODES.NO_TARGET)
    }
    if (text === '') throw dshImError('通知正文为空', ERROR_CODES.NO_TARGET)
    // Text-only: no media / interactive payload may ride along.
    const hasMedia = options != null && options.media != null
    if (isRecord(options) && (hasMedia || options.interactive === true || options.card != null)) {
      throw dshImError('dsh-im 桥接仅支持纯文本投递', ERROR_CODES.UNSUPPORTED)
    }

    const service = observe()
    if (service === null) throw dshImError('dsh-im 服务不可用', ERROR_CODES.UNAVAILABLE)
    if (typeof service.send !== 'function') throw dshImError('当前 dsh-im 服务不支持 send', ERROR_CODES.UNSUPPORTED)
    const startEpoch = epoch

    let result
    try {
      result = await service.send(botId, targetId, text, options ?? {})
    } catch (error) {
      // Timeout/cancel may already have been delivered → unknown; never a blind resend.
      if (looksUncertain(error)) {
        return { ok: false, accepted: false, confirmed: false, unknown: true, rejected: false, reason: 'timeout' }
      }
      return { ok: false, accepted: false, confirmed: false, unknown: false, rejected: true, reason: str(error?.message) || 'rejected' }
    }

    // Service was withdrawn/recreated while the send was airborne → isolate the late result.
    const after = observe()
    if (after !== service || epoch !== startEpoch) {
      report('dsh-im send 迟到结果作废：服务在飞期间被替换，晚到回执按 unknown 隔离（不重发）')
      return { ok: false, accepted: false, confirmed: false, unknown: true, rejected: false, reason: 'epoch' }
    }

    const sent = result === true
      || (isRecord(result) && (result.sent === true || result.ok === true || result.accepted === true))
    const rejected = result === false
      || (isRecord(result) && (result.sent === false || result.rejected === true))

    if (sent) return { ok: true, accepted: true, confirmed: false, unknown: false, rejected: false }
    if (rejected) return { ok: false, accepted: false, confirmed: false, unknown: false, rejected: true, reason: 'rejected' }
    // Anything else is ambiguous (no clear sent/reject signal) → unknown, never accepted.
    return { ok: false, accepted: false, confirmed: false, unknown: true, rejected: false, reason: 'ambiguous' }
  }

  return Object.freeze({
    status,
    listBots,
    listTargets,
    send,
    get epoch() { return epoch },
  })
}