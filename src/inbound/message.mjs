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

export const INBOUND_KINDS = Object.freeze({
  text: 'text',
  image: 'image',
  file: 'file',
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const MAX_INBOUND_MEDIA_URL_LENGTH = 2048
export const MAX_INBOUND_IMAGE_DIMENSION = 100000
export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024
export const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 10000

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
 * Optional image download primitive for provider bridges. It never persists a binary and only
 * returns bounded metadata. Callers may omit it entirely; malformed URLs, redirects, oversized
 * responses, and timeouts fail closed as `null`.
 */
export async function downloadInboundImage(url, options = {}) {
  const safeUrl = normalizeImageUrl(url)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const maxBytes = Math.min(MAX_INBOUND_IMAGE_BYTES, Math.max(1, Number(options.maxBytes) || MAX_INBOUND_IMAGE_BYTES))
  const timeoutMs = Math.min(60000, Math.max(1, Number(options.timeoutMs) || DEFAULT_INBOUND_MEDIA_TIMEOUT_MS))
  if (safeUrl === '' || typeof fetchImpl !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(safeUrl, { signal: controller.signal, redirect: 'error' })
    if (!response?.ok) return null
    const declared = Number(response.headers?.get?.('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) return null
    const contentType = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    if (!contentType.startsWith('image/')) return null
    const reader = response.body?.getReader?.()
    if (reader === undefined) return null
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
