// 微信 iLink provider slice：纯协议归一层。
// 这里故意不把未知字段映射成控制事件；只有白名单字段才会进入 Control Core。

import { extractIlinkText, classifyIlinkResponse } from '../../inbound/_ilink-api.mjs'
import { normalizeImageAttachment } from '../../inbound/message.mjs'
import { createHash } from 'node:crypto'

export const MAX_CURSOR_LENGTH = 4096
export const MAX_ACCOUNT_ID_LENGTH = 128
export const MAX_CONTEXT_TOKEN_LENGTH = 512

function hash6(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 6)
}

const CONTROL_RE = /[\u0000-\u001f\u007f\s]/

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validBoundedToken(value, max = MAX_CONTEXT_TOKEN_LENGTH) {
  const token = String(value ?? '')
  return token !== '' && token.length <= max && !CONTROL_RE.test(token) ? token : ''
}

export function validAccountId(value) {
  const accountId = String(value ?? '').trim()
  return accountId !== '' && accountId.length <= MAX_ACCOUNT_ID_LENGTH && !CONTROL_RE.test(accountId)
    ? accountId
    : ''
}

export function boundedCursor(value) {
  const cursor = String(value ?? '')
  if (cursor === '') return ''
  return cursor.length <= MAX_CURSOR_LENGTH && !CONTROL_RE.test(cursor) ? cursor : ''
}

/** QR response/status is provider-facing data; normalize unknown states to actionable expiry. */
export function normalizeQrStatus(response) {
  if (!plain(response)) return { state: 'error', message: '微信二维码状态响应格式异常，请重新扫码' }
  const raw = String(response.status ?? '').toLowerCase()
  if (raw === 'wait' || raw === 'scaned') return { state: raw, qrContent: String(response.qrcode_img_content ?? '') }
  if (raw === 'scaned_but_redirect') {
    const host = String(response.ilink_bot_host ?? response.redirect_host ?? '').trim()
    return { state: 'redirect', host, message: host ? `请切换到微信服务节点 ${host} 后继续扫码` : '微信二维码要求切换服务节点，请重新扫码' }
  }
  if (raw === 'confirmed' || raw === 'success') {
    return {
      state: 'confirmed',
      accountId: validAccountId(response.ilink_user_id ?? response.account_id),
      botToken: String(response.bot_token ?? ''),
      baseUrl: String(response.baseurl ?? response.base_url ?? '').replace(/\/+$/, ''),
    }
  }
  if (raw === 'expired' || raw === 'timeout') return { state: 'expired', message: '微信二维码已过期，请重新扫码' }
  return { state: 'error', message: `微信二维码状态未知（${raw || '缺少 status'}），请重新扫码` }
}

/**
 * iLink 图片字段仍未有真实设备证据。只解析有明确 URL/media id 的已知形状，
 * 不把未知字段或任意对象交给控制层。
 */
export function normalizeImageItem(item) {
  if (!plain(item) || item.type !== 2 || !plain(item.image_item)) return null
  const raw = item.image_item
  const attachment = normalizeImageAttachment(raw)
  const mediaId = String(raw.media_id ?? raw.mediaId ?? '').trim()
  const safeMediaId = mediaId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(mediaId) ? mediaId : ''
  if (attachment === null && safeMediaId === '') return null
  const image = {}
  if (attachment !== null) Object.assign(image, attachment)
  if (safeMediaId !== '') image.mediaId = safeMediaId
  return { kind: 'image', image }
}

/**
 * Normalize one provider message. `text` is always present for Control Core compatibility;
 * an image-only message receives a neutral marker while preserving structured image metadata.
 */
export function normalizeInboundMessage(message, { accountId = '' } = {}) {
  if (!plain(message)) return null
  const userId = String(message.from_user_id ?? '').trim()
  const account = validAccountId(accountId)
  if (userId === '' || account === '') return null
  const rawId = String(message.message_id ?? '').trim() || String(message.client_id ?? '').trim()
  const text = extractIlinkText(message.item_list)
  const image = Array.isArray(message.item_list)
    ? (message.item_list.map(normalizeImageItem).find(Boolean) ?? null)
    : null
  if (text === '' && image === null) return null
  const messageId = rawId !== '' ? `wx:${account}:${rawId}` : `wx:${account}:${userId}:${hash6(text)}`
  const rawContextToken = String(message.context_token ?? '').trim()
  const contextToken = validBoundedToken(rawContextToken)
  const envelope = {
    channel: 'wechat', accountId: account, userId, chatId: userId, messageId,
    contextToken,
    contextTokenRejected: rawContextToken !== '' && contextToken === '',
  }
  if (text !== '') return { ...envelope, kind: 'text', text, ...(image ? { image: image.image } : {}) }
  return { ...envelope, kind: 'image', text: '[图片消息]', image: image.image }
}

/**
 * Normalize an update response. Cursor is accepted only when bounded; caller commits it
 * after all returned messages have been handed to the bus.
 */
export function normalizeUpdateBatch(response, options = {}) {
  const accountId = validAccountId(options.accountId)
  const verdict = classifyIlinkResponse(response)
  if (!verdict.ok) return { ok: false, ...verdict, messages: [], cursor: '' }
  if (!plain(response) || accountId === '') return { ok: false, kind: 'malformed', messages: [], cursor: '' }
  const cursorRaw = response.get_updates_buf
  const cursor = cursorRaw === undefined ? '' : boundedCursor(cursorRaw)
  const cursorRejected = cursorRaw !== undefined && String(cursorRaw ?? '') !== cursor
  const messages = Array.isArray(response.msgs)
    ? response.msgs.map((item) => normalizeInboundMessage(item, { accountId })).filter(Boolean)
    : []
  return { ok: true, cursor, cursorRejected, messages }
}
