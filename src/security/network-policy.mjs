import { lookup as defaultLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 256

const BLOCKED_V4 = [
  ['本网络 0.0.0.0/8', 0x00000000, 0x00ffffff],
  ['私网 10.0.0.0/8', 0x0a000000, 0x0affffff],
  ['CGNAT 100.64.0.0/10', 0x64400000, 0x647fffff],
  ['环回 127.0.0.0/8', 0x7f000000, 0x7fffffff],
  ['链路本地 169.254.0.0/16', 0xa9fe0000, 0xa9feffff],
  ['私网 172.16.0.0/12', 0xac100000, 0xac1fffff],
  ['IANA 特殊 192.0.0.0/24', 0xc0000000, 0xc00000ff],
  ['文档 192.0.2.0/24', 0xc0000200, 0xc00002ff],
  ['私网 192.168.0.0/16', 0xc0a80000, 0xc0a8ffff],
  ['基准 198.18.0.0/15', 0xc6120000, 0xc613ffff],
  ['文档 198.51.100.0/24', 0xc6336400, 0xc63364ff],
  ['文档 203.0.113.0/24', 0xcb007100, 0xcb0071ff],
  ['组播 224.0.0.0/4', 0xe0000000, 0xefffffff],
  ['保留 240.0.0.0/4', 0xf0000000, 0xfeffffff],
  ['广播 255.255.255.255/32', 0xffffffff, 0xffffffff],
]

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog',
])
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']
const cache = new Map()
let activeLookup = defaultLookup

export class NetworkPolicyError extends Error {
  constructor(message, code = 'UNSAFE_TARGET', detail = '') {
    super(message)
    this.name = 'NetworkPolicyError'
    this.code = code
    this.detail = detail || message
  }
}

export function __setLookupForTests(fn) {
  activeLookup = typeof fn === 'function' ? fn : defaultLookup
  cache.clear()
}

function parseIpv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    value = (value << 8) | Number(part)
  }
  return value >>> 0
}

function parseIpv6Groups(host) {
  const text = String(host).split('%')[0]
  let body = text
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted !== null) {
    const v4 = parseIpv4(dotted[2])
    if (v4 === null) return null
    body = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const parse = (chunk) => chunk === '' ? [] : chunk.split(':').map((group) => {
    return /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : null
  })
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (head.includes(null) || tail.includes(null)) return null
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0), ...tail]
  return groups.length === 8 ? groups : null
}

function ipv6Value(host) {
  const groups = parseIpv6Groups(host)
  if (groups === null) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function ipv6Cidr(name, base, prefix) {
  const value = ipv6Value(base)
  const shift = 128n - BigInt(prefix)
  const start = (value >> shift) << shift
  return [name, start, start | ((1n << shift) - 1n)]
}

const BLOCKED_V6 = [
  ipv6Cidr('未指定 ::/128', '::', 128),
  ipv6Cidr('环回 ::1/128', '::1', 128),
  ipv6Cidr('IPv4-compatible ::/96', '::', 96),
  ipv6Cidr('Discard 100::/64', '100::', 64),
  ipv6Cidr('6to4 2002::/16', '2002::', 16),
  ipv6Cidr('文档 2001:db8::/32', '2001:db8::', 32),
  ipv6Cidr('ULA fc00::/7', 'fc00::', 7),
  ipv6Cidr('链路本地 fe80::/10', 'fe80::', 10),
  ipv6Cidr('组播 ff00::/8', 'ff00::', 8),
]

function blockedReasonOf(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '')
  const family = isIP(raw)
  if (family === 4) {
    const value = parseIpv4(raw)
    if (value === null) return `无法解析的 IPv4 地址 ${raw}`
    return BLOCKED_V4.find(([, start, end]) => value >= start && value <= end)?.[0] ?? null
  }
  if (family === 6) {
    const value = ipv6Value(raw)
    if (value === null) return `无法解析的 IPv6 地址 ${raw}`
    const groups = parseIpv6Groups(raw)
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)
    if (mapped || nat64) {
      const embedded = ((groups[6] << 16) | groups[7]) >>> 0
      const reason = BLOCKED_V4.find(([, start, end]) => embedded >= start && embedded <= end)?.[0]
      return reason === undefined ? null : `${reason}（经 IPv6 映射 ${raw}）`
    }
    return BLOCKED_V6.find(([, start, end]) => value >= start && value <= end)?.[0] ?? null
  }
  return undefined
}

function targetError(channel, reason) {
  return new NetworkPolicyError(
    `${channel}目标被 SSRF 防护拒绝：${reason}。内网/本机自托管服务请配置 allowPrivateNetwork: true`,
  )
}

function remember(host, entry) {
  cache.set(host, { ...entry, expires: Date.now() + CACHE_TTL_MS })
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

export async function resolveNetworkTarget(url, {
  allowPrivate = false,
  channel = '渠道',
  lookupImpl = activeLookup,
} = {}) {
  let parsed
  try { parsed = new URL(String(url ?? '')) } catch {
    throw new NetworkPolicyError(`${channel}地址无效，无法校验`, 'NOT_CONFIGURED')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new NetworkPolicyError(`${channel}仅支持 http/https 地址（当前 ${parsed.protocol.replace(':', '')}）`)
  }
  if (parsed.username !== '' || parsed.password !== '') throw targetError(channel, 'URL 不允许包含凭证段')
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '') throw new NetworkPolicyError(`${channel}地址缺少主机名`, 'NOT_CONFIGURED')
  if (!allowPrivate && (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
    throw targetError(channel, `内部主机名 ${host}`)
  }

  const literal = blockedReasonOf(host)
  if (!allowPrivate && typeof literal === 'string') throw targetError(channel, literal)
  if (literal !== undefined) {
    return Object.freeze({ url: parsed, host, addresses: Object.freeze([{ address: host, family: isIP(host) }]) })
  }

  const cached = cache.get(host)
  if (cached !== undefined && cached.expires > Date.now()) {
    if (!allowPrivate && cached.blocked !== null) throw targetError(channel, cached.blocked)
    return Object.freeze({ url: parsed, host, addresses: cached.addresses })
  }

  let records
  try { records = await lookupImpl(host, { all: true, verbatim: true }) } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NetworkPolicyError(`${channel}域名解析失败（${host}）`, 'NETWORK_ERROR', detail)
  }
  const addresses = Object.freeze((Array.isArray(records) ? records : [])
    .map((record) => ({ address: String(record?.address ?? ''), family: Number(record?.family) || isIP(record?.address) }))
    .filter((record) => record.address !== '' && (record.family === 4 || record.family === 6)))
  if (addresses.length === 0) throw new NetworkPolicyError(`${channel}域名无解析结果（${host}）`, 'NETWORK_ERROR')
  let blocked = null
  if (!allowPrivate) {
    for (const record of addresses) {
      const reason = blockedReasonOf(record.address)
      if (typeof reason === 'string') { blocked = `${reason}（${host} → ${record.address}）`; break }
    }
  }
  remember(host, { addresses, blocked })
  if (blocked !== null) throw targetError(channel, blocked)
  return Object.freeze({ url: parsed, host, addresses })
}

export function pinnedLookupFor(target) {
  const records = target.addresses
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' && options !== null ? options : {}
    const family = Number(opts.family) || 0
    const eligible = family === 0 ? records : records.filter((record) => record.family === family)
    if (eligible.length === 0) {
      callback(Object.assign(new Error('validated address family unavailable'), { code: 'ENOTFOUND' }))
      return
    }
    if (opts.all === true) callback(null, eligible.map((record) => ({ ...record })))
    else callback(null, eligible[0].address, eligible[0].family)
  }
}

function nativeRequest(target, init) {
  return new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? https : http
    const request = client.request(target.url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      lookup: pinnedLookupFor(target),
      // Node 24 的 globalAgent 会自动读取 HTTP(S)_PROXY；那会绕过已验证地址。
      // 用户可控目标必须直连已验证 IP，因此禁用共享/代理 agent。
      agent: false,
    }, (response) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item)
        else if (value !== undefined) headers.set(key, String(value))
      }
      const status = response.statusCode ?? 500
      const bodyAllowed = status !== 101 && status !== 204 && status !== 205 && status !== 304
      if (!bodyAllowed) response.resume()
      resolve(new Response(bodyAllowed ? Readable.toWeb(response) : null, { status, headers }))
    })
    request.once('error', reject)
    const abort = () => request.destroy(Object.assign(new Error('request aborted'), { name: 'AbortError' }))
    if (init.signal?.aborted === true) abort()
    else init.signal?.addEventListener?.('abort', abort, { once: true })
    if (init.body !== undefined && init.body !== null) {
      request.write(init.body instanceof URLSearchParams ? init.body.toString() : init.body)
    }
    request.end()
  })
}

export async function guardedNetworkFetch(url, init = {}, options = {}) {
  const policyOptions = { ...options }
  if (process.env.NODE_TEST_CONTEXT && options.lookupImpl === undefined) {
    policyOptions.lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }]
  }
  const target = await resolveNetworkTarget(url, policyOptions)
  if (typeof options.fetchImpl === 'function') {
    return options.fetchImpl(target.url.href, { ...init, redirect: 'manual' })
  }
  if (process.env.NODE_TEST_CONTEXT && typeof globalThis.fetch === 'function') {
    return globalThis.fetch(target.url.href, { ...init, redirect: 'manual' })
  }
  return nativeRequest(target, init)
}
