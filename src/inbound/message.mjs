// dsh-notifier inbound/message.mjs
// 入站统一消息模型（维护批 5）：text / image / file 三类内容的归一结构。
//
// 设计原则：
//  - 文字兼容：既有适配器直接产出的 { text: string } 信封原样归一为
//    { kind: 'text', text }，bus.accept / conversation router 现有消费面零改动；
//  - 结构先行、证据后接：image/file 的归一/解析接口在这里定义并钉死测试，
//    但【无协议证据不接生产】——当前唯一实现者 parseQQImageMessage 只对
//    fixture 解析、不被任何适配器 import（真机确认字段形状后翻转启用）；
//  - 归一不丢信息：kind/text 之外保留 input.payload 原样，消费方按需自取；
//  - 军规：未知结构 fail-closed（返回 null），绝不把「非文本」伪装成 text
//    漏进会话路由——宁可消息不达，不作越权/错位处理。
//
// 目标统一形状（未来适配器/网关按此产出，详见 parseQQImageMessage 接口约定）：
//   { kind: 'text'|'image'|'file', text?, image?: { url, width?, height? },
//     file?: { name?, url?, size? }, payload? }

import { guardedNetworkFetch } from '../security/network-policy.mjs'

export const INBOUND_KINDS = Object.freeze({
  text: 'text',
  image: 'image',
  file: 'file',
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const MAX_INBOUND_MEDIA_URL_LENGTH = 2048
export const MAX_INBOUND_IMAGE_DIMENSION = 100000
export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024
/** #36：图片与文件统一 5 MiB 上限（owner 决策——两套上限只会制造「图能过文件不能过」的困惑）。 */
export const MAX_INBOUND_FILE_BYTES = 5 * 1024 * 1024
/** 附件名长度上界（不可信输入；超长名截断，绝不进宿主/审计面无界增长）。 */
export const MAX_INBOUND_FILE_NAME_LENGTH = 128
export const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 10000
/** 单条入站消息附件数量上限。 */
export const MAX_INBOUND_ATTACHMENTS_PER_MESSAGE = 8
/** 单条入站消息附件声明字节总量上限。 */
export const MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES = 16 * 1024 * 1024
/** 全局入站附件下载并发预算（跨消息共享）。 */
export const MAX_INBOUND_DOWNLOAD_CONCURRENCY = 4
export const MAX_INBOUND_DOWNLOAD_QUEUE = 32
export const DEFAULT_INBOUND_DOWNLOAD_ACQUIRE_TIMEOUT_MS = 10_000

const downloadSlots = { active: 0, queue: [] }
async function withDownloadSlot(fn, acquireTimeoutMs = DEFAULT_INBOUND_DOWNLOAD_ACQUIRE_TIMEOUT_MS) {
  if (downloadSlots.active >= MAX_INBOUND_DOWNLOAD_CONCURRENCY) {
    if (downloadSlots.queue.length >= MAX_INBOUND_DOWNLOAD_QUEUE) return null
    const acquired = await new Promise((resolve) => {
      const entry = { done: false, resolve, timer: null }
      entry.timer = setTimeout(() => {
        if (entry.done) return
        entry.done = true
        const index = downloadSlots.queue.indexOf(entry)
        if (index >= 0) downloadSlots.queue.splice(index, 1)
        resolve(false)
      }, Math.max(1, Math.min(10_000, Number(acquireTimeoutMs) || DEFAULT_INBOUND_DOWNLOAD_ACQUIRE_TIMEOUT_MS)))
      entry.timer.unref?.()
      downloadSlots.queue.push(entry)
    })
    if (!acquired) return null
  }
  downloadSlots.active += 1
  try { return await fn() } finally {
    downloadSlots.active -= 1
    for (;;) {
      const next = downloadSlots.queue.shift()
      if (next === undefined) break
      if (next.done) continue
      next.done = true
      clearTimeout(next.timer)
      next.resolve(true)
      break
    }
  }
}

async function cancelResponse(response) {
  try { await response?.body?.cancel?.() } catch { /* 已关闭/非流式响应 */ }
}

function warnAttachmentBudget(message) {
  try { console.warn(`[dsh-notifier/inbound/message] ${message}`) } catch { /* 日志失败不致命 */ }
}

/** url 精确必须是非空字符串（fail-closed：缺 URL 的附件段不构成有效媒体消息）。 */
const urlPresent = (value) => normalizeImageUrl(value) !== ''

/** 永拒主机名（精确匹配，小写归一后）。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog',
])
/** 永拒主机后缀（mDNS/内部 TLD，DNS rebinding 之外的静态面）。 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']

/** IPv4 字面量判定（纯数字点分，含前导 0 形态）；非字面量返回 false。 */
function isLiteralIpv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part))
}

/** 私有/保留 IPv4 段判定（CWE-918：回环、内网、链路本地、元数据、组播、保留段）。 */
function isPrivateIpv4(host) {
  const [a, b, c] = host.split('.').map((part) => Number(part))
  const first = a
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (first === 169 && b === 254) return true // 169.254.0.0/16 链路本地（含云元数据）
  if (first === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (first === 192 && b === 168) return true // 192.168.0.0/16
  if (first === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 基准段
  if (first === 192 && b === 0 && c === 2) return true // 192.0.2.0/24 TEST-NET-1
  if (first === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (first === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (first >= 224) return true // 组播/保留 224.0.0.0/4+
  return false
}

/** IPv6 字面量判定（去方括号与 zone id 后）；非字面量返回 false。 */
function isLiteralIpv6(host) {
  return host.includes(':')
}

/**
 * 从 IPv4-mapped / IPv4-compatible IPv6 字面量抽取内嵌 IPv4 的 4 个八位组；不匹配返回 null。
 * Node URL 对 IPv4-mapped 规范化为 `::ffff:AAAA:BBBB`（每个 16-bit 组去前导 0）、
 * IPv4-compatible 为 `::AAAA:BBBB`。取尾部两个 16-bit 组拼成 32-bit IPv4，再交 IPv4
 * 私有/保留段判定（否则 `::ffff:7f00:1` 这类回环映射 IPv6 会绕过纯 IPv6 前缀判断）。
 */
function ipv4MappedOctets(host) {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (match === null) return null
  const value = Number.parseInt(`${match[1].padStart(4, '0')}${match[2].padStart(4, '0')}`, 16)
  if (!Number.isFinite(value) || value > 0xffffffff) return null
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** 私有/特殊 IPv6 段判定：::(未指定)、::1(回环)、fe80::/10(链路本地)、fc00::/7(ULA)、
 * 以及 IPv4-mapped/compatible（内嵌 IPv4 需经 IPv4 私有判定）。 */
function isPrivateIpv6(host) {
  const lower = host.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  const mapped = ipv4MappedOctets(lower)
  if (mapped !== null) return isPrivateIpv4(mapped.join('.'))
  return false
}

/**
 * 主机名静态 SSRF 判定：私有/回环/链路本地/元数据/内部 TLD 一律拒绝。仅做字面量判定，
 * 不对域名做 DNS 反查（DNS rebinding 是声明性残留风险，不做承诺）。
 */
function isPrivateOrReservedHost(rawHost) {
  const stripped = String(rawHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (stripped === '') return true // fail-closed：空主机名不可投
  const host = stripped.includes('%') ? stripped.slice(0, stripped.indexOf('%')) : stripped // IPv6 zone id
  if (BLOCKED_HOSTNAMES.has(host)) return true
  for (const suffix of BLOCKED_HOST_SUFFIXES) if (host.endsWith(suffix)) return true
  if (isLiteralIpv4(host)) return isPrivateIpv4(host)
  if (isLiteralIpv6(host)) return isPrivateIpv6(host)
  return false
}

/**
 * 仅接受显式 HTTP(S) 媒体地址。URL 不会被当作命令、回调载荷或状态值；禁止凭证段，
 * 避免把对端携带的敏感片段带入 agent/audit 信封；拒绝私有/内网/回环目标（SSRF 硬边界）。
 */
export function normalizeImageUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '' || raw.length > MAX_INBOUND_MEDIA_URL_LENGTH) return ''
  try {
    const parsed = new URL(raw)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.hostname === ''
      || parsed.username !== '' || parsed.password !== '') return ''
    if (isPrivateOrReservedHost(parsed.hostname)) return ''
    return parsed.href
  } catch {
    return ''
  }
}

/** Produce a bounded, known-field image object; unknown provider fields are discarded. */
export function normalizeImageAttachment(raw) {
  if (!isPlainObject(raw)) return null
  const url = normalizeImageUrl(raw.url ?? raw.media_url ?? raw.mediaUrl ?? raw.download_url ?? raw.downloadUrl)
  if (url === '') return null
  const image = { url }
  for (const key of ['width', 'height']) {
    const value = Number(raw[key])
    if (Number.isFinite(value) && value > 0 && value <= MAX_INBOUND_IMAGE_DIMENSION) image[key] = value
  }
  return image
}

/**
 * 附件文件名归一（#36）：附件名是完全不可信的输入。
 *  - 剥离路径分量（`/` 与 Windows `\\`）——`../../etc/passwd` 只留 `passwd`；
 *  - 剥离 C0/C1 控制字符（防日志注入/终端转义）；
 *  - `.` / `..` / 纯空白 / 非字符串 → ''（调用方按无名附件处理，绝不编造名字）；
 *  - 按码点截断到 MAX_INBOUND_FILE_NAME_LENGTH（不产生孤立代理项）。
 * @param {unknown} value
 * @returns {string} 安全文件名，或 ''（无可用名）。
 */
export function sanitizeFileName(value) {
  const raw = typeof value === 'string' ? value : ''
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  const base = cleaned.split(/[\\/]/).pop() ?? ''
  const trimmed = base.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return ''
  return Array.from(trimmed).slice(0, MAX_INBOUND_FILE_NAME_LENGTH).join('')
}

/** 附件 URL 归一（与图片同一套 SSRF 硬边界；禁用凭证段，绝不把远程地址当状态值）。 */
const normalizeAttachmentUrl = (value) => normalizeImageUrl(value)

/**
 * Produce a bounded, known-field file object；未知 provider 字段一律丢弃。
 * 文件不限制媒体类型（宿主 FileAttachmentRef 不设白名单），但仍要求显式 http(s) URL。
 * @param {object} raw
 * @returns {{ url: string, name?: string, size?: number } | null}
 */
export function normalizeFileAttachment(raw) {
  if (!isPlainObject(raw)) return null
  const url = normalizeAttachmentUrl(raw.url ?? raw.media_url ?? raw.mediaUrl
    ?? raw.download_url ?? raw.downloadUrl ?? raw.file_url ?? raw.fileUrl)
  if (url === '') return null
  const file = { url }
  const name = sanitizeFileName(raw.name ?? raw.filename ?? raw.file_name ?? raw.fileName)
  if (name !== '') file.name = name
  const size = Number(raw.size)
  if (Number.isInteger(size) && size >= 0 && size <= MAX_INBOUND_FILE_BYTES) file.size = size
  return file
}

/**
 * 统一附件项归一（信封 `attachments: []` 的单项形状）：
 * `{ kind:'image', image }` / `{ kind:'file', file }`；未知 kind 或畸形一律 null（fail-closed，
 * 绝不把未知类型的附件伪装成文本漏进会话路由）。
 */
export function normalizeAttachmentItem(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.kind === INBOUND_KINDS.image) {
    const image = normalizeImageAttachment(raw.image)
    return image === null ? null : { kind: INBOUND_KINDS.image, image }
  }
  if (raw.kind === INBOUND_KINDS.file) {
    const file = normalizeFileAttachment(raw.file)
    return file === null ? null : { kind: INBOUND_KINDS.file, file }
  }
  return null
}

/**
 * Optional image download primitive for provider bridges. It never persists a binary and only
 * returns bounded metadata. Callers may omit it entirely; malformed URLs, redirects, oversized
 * responses, and timeouts fail closed as `null`.
 */
export async function downloadInboundImage(url, options = {}) {
  return withDownloadSlot(async () => {
    const safeUrl = normalizeImageUrl(url)
    const maxBytes = Math.min(MAX_INBOUND_IMAGE_BYTES, Math.max(1, Number(options.maxBytes) || MAX_INBOUND_IMAGE_BYTES))
    const timeoutMs = Math.min(60000, Math.max(1, Number(options.timeoutMs) || DEFAULT_INBOUND_MEDIA_TIMEOUT_MS))
    if (safeUrl === '') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await guardedNetworkFetch(safeUrl, { signal: controller.signal }, {
        channel: '入站图片', fetchImpl: options.fetchImpl, lookupImpl: options.lookupImpl,
      })
      if (!response?.ok) { await cancelResponse(response); return null }
      const declared = Number(response.headers?.get?.('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) { await cancelResponse(response); return null }
      const contentType = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (!contentType.startsWith('image/')) { await cancelResponse(response); return null }
      const reader = response.body?.getReader?.()
      if (reader === undefined) { await cancelResponse(response); return null }
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value?.byteLength ?? 0
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
      }
      return { url: safeUrl, contentType, size }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }, options.acquireTimeoutMs)
}

/**
 * 有界字节下载原语（图片与文件共用同一套硬边界）：
 *  - URL 经 normalizeImageUrl（SSRF 硬边界 + 禁凭证段）；
 *  - `redirect: 'error'`（不跟随跳转，跳转即失败）；
 *  - 有限超时（AbortController，缺省 10s，硬上界 60s）；
 *  - 上限按**实读字节**计（不信 Content-Length，超限立即 cancel），绝不落盘；
 *  - mediaTypePrefix 非空时要求响应 Content-Type 命中该前缀（图片白名单），空串 = 不限类型（文件）。
 * 任一环节失败返回 null（fail-closed）。
 */
async function downloadBoundedBytes(url, options, mediaTypePrefix) {
  return withDownloadSlot(async () => {
    const safeUrl = normalizeImageUrl(url)
    const limitBytes = options.limitBytes
    const maxBytes = Math.min(limitBytes, Math.max(1, Number(options.maxBytes) || limitBytes))
    const timeoutMs = Math.min(60000, Math.max(1, Number(options.timeoutMs) || DEFAULT_INBOUND_MEDIA_TIMEOUT_MS))
    if (safeUrl === '') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await guardedNetworkFetch(safeUrl, { signal: controller.signal }, {
        channel: '入站附件', fetchImpl: options.fetchImpl, lookupImpl: options.lookupImpl,
      })
      if (!response?.ok) { await cancelResponse(response); return null }
      const declared = Number(response.headers?.get?.('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) { await cancelResponse(response); return null }
      const mediaType = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (mediaTypePrefix !== '' && !mediaType.startsWith(mediaTypePrefix)) { await cancelResponse(response); return null }
      const reader = response.body?.getReader?.()
      if (reader === undefined) { await cancelResponse(response); return null }
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value?.byteLength ?? 0
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
      const data = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { data, mediaType, size }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }, options.acquireTimeoutMs)
}

/**
 * 有界下载图片字节（Host P0-A：作 durable admission 的输入）。
 * 上限按实读字节计，不信 Content-Length，超限立即 cancel（红线 2.4 / 计划 §5.2）。
 * @param {string} url
 * @param {{ fetchImpl?: Function, maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ data: Uint8Array, mediaType: string, size: number } | null>}
 */
export async function downloadInboundImageBytes(url, options = {}) {
  const result = await downloadBoundedBytes(url, { ...options, limitBytes: MAX_INBOUND_IMAGE_BYTES }, 'image/')
  return result === null ? null : { data: result.data, mediaType: result.mediaType, size: result.size }
}

/**
 * 有界下载文件字节（#36：作 durable file admission 的输入）。
 * 与图片同一套 SSRF/redirect/超时/实读字节口径；文件不限 Content-Type
 * （宿主 FileAttachmentRef 无媒体白名单），但仍是「实读字节 + 上限 + 不落盘」。
 * @param {string} url
 * @param {{ fetchImpl?: Function, maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ data: Uint8Array, mediaType: string, size: number } | null>}
 */
export async function downloadInboundFileBytes(url, options = {}) {
  const result = await downloadBoundedBytes(url, { ...options, limitBytes: MAX_INBOUND_FILE_BYTES }, '')
  return result === null ? null : { data: result.data, mediaType: result.mediaType, size: result.size }
}

/**
 * 字符串化 extra（QQ 媒体事件负载）解析：JSON 字符串 → 数组。已解析的数组原样返回。
 * 解析失败/非数组返回 null。
 */
export function parseExtraSegments(extra) {
  if (Array.isArray(extra)) return extra
  if (typeof extra !== 'string' || extra === '') return null
  try {
    const parsed = JSON.parse(extra)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 归一任意入站载荷为统一消息。
 * @param {object} input - 适配器原始信封或结构化消息
 *   - 文字兼容：{ text: '...' }（可带 channel/userId/chatId/messageId 等透传字段）
 *     → { kind:'text', text, ...透传 }
 *   - 结构化：{ kind:'image', image:{ url } } / { kind:'file', file:{ name?,url?,size? } }
 *     → 对应 kind（image/file 均要求附件对象含有效 url，否则 null）
 * @returns {null | { kind: string, text?: string, image?: object, file?: object, [k: string]: unknown }}
 */
export function normalizeInboundMessage(input) {
  if (!isPlainObject(input)) return null
  const passthrough = { ...input }
  const textRaw = passthrough.text
  const hasText = typeof textRaw === 'string' && textRaw !== ''
  const image = normalizeImageAttachment(passthrough.image)
  // v0.10（§3.4）：文本+图片必须保留二者，不能因为 text !== '' 就丢图。既有 text 又带
  // 合法图片附件的信封归一为 text + image 双载；纯文字信封仍只归一为 text（零行为变化）。
  if (hasText && image !== null) {
    delete passthrough.kind
    delete passthrough.image
    delete passthrough.file
    return { kind: INBOUND_KINDS.text, text: textRaw, image, ...passthrough }
  }
  // 文字兼容：既有信封以 text 为主道。非文本载荷若同时带 text 正文，按 text 归一
  // （附件路径待协议证据，绝不旁路）。
  if (hasText) {
    delete passthrough.kind
    delete passthrough.image
    delete passthrough.file
    return { kind: INBOUND_KINDS.text, text: textRaw, ...passthrough }
  }
  if (passthrough.kind === INBOUND_KINDS.image && image !== null) {
    delete passthrough.text
    delete passthrough.kind
    delete passthrough.image
    return { ...passthrough, kind: INBOUND_KINDS.image, image }
  }
  if (passthrough.kind === INBOUND_KINDS.file && isPlainObject(passthrough.file) && urlPresent(passthrough.file.url)) {
    delete passthrough.kind
    return { kind: INBOUND_KINDS.file, file: passthrough.file, ...passthrough }
  }
  return null
}

/**
 * QQ 单聊（C2C）图片消息解析接口。
 *
 * 协议证据状态：QQ 官方机器人 C2C 媒体事件的真实字段形状尚无真机样本核验。本接口按
 * fixture 覆盖的 `extra` 段形状接线，属于 contract-tested，不能标记为 real-device-verified。
 *
 * 解析判据（全部满足才判定为图片，否则 null，fail-closed）：
 *  - eventData.extra：JSON 字符串（或已解析数组），内含媒体段数组；
 *  - 某段的 type 为 'image' 或 1，且 image.url 为非空字符串。
 * @param {object} eventData - C2C_MESSAGE_CREATE 事件的 d 负载
 * @returns {null | { kind: 'image', image: { url: string, width?: number, height?: number } }}
 */
export function parseQQImageMessage(eventData) {
  if (!isPlainObject(eventData)) return null
  const segments = parseExtraSegments(eventData.extra)
  if (segments === null) return null
  for (const segment of segments) {
    if (!isPlainObject(segment)) continue
    const typeOk = segment.type === 'image' || segment.type === 1
    if (!typeOk) continue
    const image = normalizeImageAttachment(segment.image)
    if (image === null) continue
    return { kind: INBOUND_KINDS.image, image }
  }
  return null
}

/**
 * QQ 官方 `attachments` 段解析（#36）。
 *
 * 协议证据状态：`attachments` 是官方 C2C / 群 @ 事件文档列出的已知字段
 * （见 docs/protocol-preflight/qq-bot.md 事件白名单），但真机样本尚未核验 →
 * contract-tested，不得标记 real-device-verified。
 *
 * 判据（每项独立判定，不合格的项直接丢弃——fail-closed，绝不把未知类型伪装成文本）：
 *  - 项为记录且 `content_type` 为非空字符串（缺类型 = 形状未知，整项拒绝）；
 *  - `content_type` 以 `image/` 开头 → image 附件（url + 有界宽高白名单字段）；
 *  - 其余类型 → file 附件（需显式 http(s) url；文件名经 sanitizeFileName 去路径/控制字符）。
 * @param {object} eventData - 消息事件的 d 负载
 * @returns {Array<{ kind: 'image', image: object } | { kind: 'file', file: object }>}
 */
export function parseQqAttachments(eventData) {
  if (!isPlainObject(eventData) || !Array.isArray(eventData.attachments)) return []
  const out = []
  let totalBytes = 0
  let warnedCount = false
  let warnedBytes = false
  for (const raw of eventData.attachments) {
    if (!isPlainObject(raw)) continue
    if (out.length >= MAX_INBOUND_ATTACHMENTS_PER_MESSAGE) {
      if (!warnedCount) {
        warnedCount = true
        warnAttachmentBudget(`单条消息附件超过 ${MAX_INBOUND_ATTACHMENTS_PER_MESSAGE} 个，已截断`)
      }
      break
    }
    const declaredSize = Number(raw.size)
    const nextBytes = Number.isInteger(declaredSize) && declaredSize >= 0 ? declaredSize : 0
    if (totalBytes + nextBytes > MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES) {
      if (!warnedBytes) {
        warnedBytes = true
        warnAttachmentBudget(`单条消息附件声明总量超过 ${MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES} 字节，已截断`)
      }
      break
    }
    const contentType = typeof raw.content_type === 'string' ? raw.content_type.trim().toLowerCase() : ''
    if (contentType === '') continue
    if (contentType.startsWith('image/')) {
      const image = normalizeImageAttachment({ url: raw.url, width: raw.width, height: raw.height })
      if (image !== null) { out.push({ kind: INBOUND_KINDS.image, image }); totalBytes += nextBytes }
      continue
    }
    const file = normalizeFileAttachment({ url: raw.url, name: raw.filename ?? raw.name, size: raw.size })
    if (file !== null) { out.push({ kind: INBOUND_KINDS.file, file }); totalBytes += nextBytes }
  }
  return out
}
