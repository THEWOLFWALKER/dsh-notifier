// dsh-notifier adapters/_urlguard.mjs
// S-02（CWE-918）SSRF 防护：用户可配 URL 的渠道（webhook / 自托管 spec 渠道）发送前
// 校验目标地址，token 被钓后不再直接成为内网探测跳板。
// 三道闸：
//  1. scheme 白名单 http/https（file:/unix: 等一律拒绝）；
//  2. 私网/保留段拦截：IP 字面量直接查表（含 IPv4-mapped IPv6、NAT64 内嵌 v4）；域名
//     经 dns.lookup({all:true}) 解析后逐地址校验——查的是解析结果而非名字，
//     0x7f000001 / 2130706433 这类非常规四进制写法也因此被覆盖；
//  3. 重定向绕过面在 _shared.mjs 关闭（redirect:'manual' + 3xx 抛错），本模块不管重定向。
// allowPrivate 逃生口：onebot（文档默认即 http://127.0.0.1:3000，渠道本质是本机服务）
// 与显式配置 allowPrivateNetwork: true 的自托管内网部署。该口子挡不住「持有 admin
// token 的攻击者同时改 url 与开关」——那是单 token 模型的固有边界（S-09），本模块
// 挡的是默认路径与配置被钓后的低成本内网跳板。
// 已知残留（接受，登记 risks.md）：lookup 与 fetch 建连之间的 DNS rebinding 竞态——
// 完全闭合需自定义 dispatcher 钉死 IP，超出零依赖约束，中危定级下属可接受残留。

import { lookup as defaultLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { NotifyError, ERROR_CODES, channelNameOf } from './_shared.mjs'

/** 解析结果短 TTL 缓存：同一 hostname 反复发送不必反复查 DNS（也压 rebinding 观测窗口）。 */
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 256

/** IPv4 私网/保留/特殊段：[段名, 起始, 结束]（32bit 无符号整数区间）。 */
const BLOCKED_V4 = [
  ['本网络 0.0.0.0/8', 0x00000000, 0x00ffffff],
  ['私网 10.0.0.0/8', 0x0a000000, 0x0affffff],
  ['CGNAT 100.64.0.0/10', 0x64400000, 0x647fffff],
  ['环回 127.0.0.0/8', 0x7f000000, 0x7fffffff],
  ['链路本地 169.254.0.0/16', 0xa9fe0000, 0xa9feffff],
  ['私网 172.16.0.0/12', 0xac100000, 0xac1fffff],
  ['IANA 特殊 192.0.0.0/24', 0xc0000000, 0xc00000ff],
  ['文档 192.0.2.0/24 (TEST-NET-1)', 0xc0000200, 0xc00002ff],
  ['私网 192.168.0.0/16', 0xc0a80000, 0xc0a8ffff],
  ['基准 198.18.0.0/15', 0xc6120000, 0xc613ffff],
  ['文档 198.51.100.0/24 (TEST-NET-2)', 0xc6336400, 0xc63364ff],
  ['文档 203.0.113.0/24 (TEST-NET-3)', 0xcb007100, 0xcb0071ff],
  ['组播 224.0.0.0/4', 0xe0000000, 0xefffffff],
  ['保留 240.0.0.0/4', 0xf0000000, 0xfeffffff],
  ['广播 255.255.255.255/32', 0xffffffff, 0xffffffff],
]

/** IPv6 私网/保留段（前 32bit 窗口比较；v4-mapped 与 NAT64 走内嵌 v4 递归，见下）。 */
const BLOCKED_V6 = [
  ['未指定/环回 ::/128 与 ::1/128（前缀 0）', 0x00000000, 0x00000000],
  ['Discard 100::/64', 0x00000100, 0x00000100],
  ['6to4 2002::/16（已弃用，内嵌 v4）', 0x20020000, 0x2002ffff],
  ['文档 2001:db8::/32', 0x20010db8, 0x20010db8],
  ['ULA fc00::/7', 0xfc000000, 0xfdffffff],
  ['链路本地 fe80::/10', 0xfe800000, 0xfebfffff],
  ['组播 ff00::/8', 0xff000000, 0xff0fffff],
]

const cache = new Map() // hostname(lower) -> { expires, blocked: string | null }（命中段名或 null=放行）

let activeLookup = defaultLookup

/** 测试注入口：替换 DNS 解析实现并清缓存（生产代码绝不调用）。 */
export function __setLookupForTests(fn) {
  activeLookup = typeof fn === 'function' ? fn : defaultLookup
  cache.clear()
}

/** '127.0.0.1' → 0x7f000001；非四段十进制返回 null。 */
function parseIpv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8) | n
  }
  return value >>> 0
}

/**
 * IPv6 文本 → { groups: number[8], v4: number | null }。
 * 接受标准/压缩写法与内嵌 IPv4 尾（::ffff:127.0.0.1）；非法返回 null。
 * v4 非 null 时 groups 末两组即内嵌地址的高低位。
 */
function parseIpv6(host) {
  const text = host.split('%')[0] // 去 zone id（fe80::1%eth0）
  let v4 = null
  let body = text
  const v4Match = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4Match !== null) {
    v4 = parseIpv4(v4Match[2])
    if (v4 === null) return null
    body = `${v4Match[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const parseGroups = (chunk) => (chunk === '' ? [] : chunk.split(':').map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : null)))
  const head = parseGroups(halves[0])
  const tail = halves.length === 2 ? parseGroups(halves[1]) : []
  if (head.includes(null) || tail.includes(null)) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0), ...tail]
  if (groups.length !== 8) return null
  return { groups, v4 }
}

/**
 * 判定单个地址是否命中拦截段。
 * @returns {string | null | undefined} 命中→段名；公网 IP→null；非 IP 字面量→undefined（走 DNS）
 */
function blockedReasonOf(address) {
  const raw = String(address ?? '')
  if (raw === '') return '空地址'
  const family = isIP(raw)
  if (family === 4) {
    const value = parseIpv4(raw)
    if (value === null) return `无法解析的 IPv4 地址 ${raw}`
    for (const [name, start, end] of BLOCKED_V4) {
      if (value >= start && value <= end) return name
    }
    return null
  }
  if (family === 6) {
    const parsed = parseIpv6(raw)
    if (parsed === null) return `无法解析的 IPv6 地址 ${raw}`
    // v4-mapped ::ffff:0:0/96 与 NAT64 64:ff9b::/96：从末两组还原内嵌 IPv4 定论
    // （Node URL/dns 都会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1，不能靠文本匹配）
    const isMapped = parsed.groups.slice(0, 5).every((g) => g === 0) && parsed.groups[5] === 0xffff
    const isNat64 = parsed.groups[0] === 0x64 && parsed.groups[1] === 0xff9b && parsed.groups.slice(2, 5).every((g) => g === 0)
    if (isMapped || isNat64) {
      const embedded = (((parsed.groups[6] & 0xffff) << 16) | (parsed.groups[7] & 0xffff)) >>> 0
      for (const [name, start, end] of BLOCKED_V4) {
        if (embedded >= start && embedded <= end) return `${name}（经 IPv6 映射 ${raw}）`
      }
      return null
    }
    // 前 32bit 窗口比较（登记段前缀均 ≤ 32bit = 前两组 16bit）
    const prefix = (((parsed.groups[0] & 0xffff) << 16) | (parsed.groups[1] & 0xffff)) >>> 0
    for (const [name, start, end] of BLOCKED_V6) {
      if (prefix >= start && prefix <= end) return name
    }
    return null
  }
  return undefined // isIP 判 0：0x7f000001 等写法交给 DNS 路径（lookup 解析出真实地址再查）
}

function blockError(name, reason) {
  return new NotifyError(
    `${name}目标被 SSRF 防护拒绝：${reason}。内网/本机自托管服务请配置 allowPrivateNetwork: true`,
    ERROR_CODES.UNSAFE_TARGET,
  )
}

/**
 * 校验 URL 是公网 http(s) 目标，否则抛 NotifyError（code=UNSAFE_TARGET）。
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=false] - 放行私网/保留段（onebot 渠道或显式 allowPrivateNetwork: true）
 * @param {string} [options.channel='渠道'] - 错误文案前缀（渠道中文名）
 * @returns {Promise<void>}
 */
export async function assertPublicHttpUrl(url, { allowPrivate = false, channel = '渠道' } = {}) {
  const name = channelNameOf(channel)
  let parsed
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    throw new NotifyError(`${name}地址无效，无法校验`, ERROR_CODES.NOT_CONFIGURED)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NotifyError(`${name}仅支持 http/https 地址（当前 ${parsed.protocol.replace(':', '')}）`, ERROR_CODES.UNSAFE_TARGET)
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '') // URL.hostname 对 v6 不带括号，双保险
  if (host === '') {
    throw new NotifyError(`${name}地址缺少主机名`, ERROR_CODES.NOT_CONFIGURED)
  }
  if (allowPrivate) return // 逃生口：scheme 已验，段检查跳过（含 DNS——少一次解析依赖）

  // IP 字面量：直接查表
  const literal = blockedReasonOf(host)
  if (typeof literal === 'string') throw blockError(name, literal)
  if (literal === null) return // 公网 IP 字面量，放行

  // 域名：DNS 解析后逐地址校验（短 TTL 缓存）
  const cached = cache.get(host)
  const now = Date.now()
  if (cached !== undefined && cached.expires > now) {
    if (cached.blocked !== null) throw blockError(name, cached.blocked)
    return
  }
  let records
  try {
    records = await activeLookup(host, { all: true, verbatim: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new NotifyError(`${name}域名解析失败（${host}）`, ERROR_CODES.NETWORK_ERROR, { detail })
  }
  const addresses = Array.isArray(records) ? records.map((r) => String(r?.address ?? '')) : []
  if (addresses.length === 0) {
    throw new NotifyError(`${name}域名无解析结果（${host}）`, ERROR_CODES.NETWORK_ERROR)
  }
  let blocked = null
  for (const address of addresses) {
    const reason = blockedReasonOf(address)
    if (typeof reason === 'string') {
      blocked = `${reason}（${host} → ${address}）`
      break
    }
  }
  cache.set(host, { expires: now + CACHE_TTL_MS, blocked })
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  if (blocked !== null) throw blockError(name, blocked)
}
