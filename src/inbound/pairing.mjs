// dsh-notifier v0.7 inbound/pairing.mjs
// 配对码状态机（v0.7 计划书 §3.3）：minted → active → redeemed / expired / revoked / locked。
// 安全纪律沿用审批 token 已验证先例：单次核销、短 TTL、SHA-256 落盘、常量时间比较、
// 铸造/核销/撤销/锁定全进审计回调。零运行时依赖（仅 node:crypto）。
//
// 规格重解释（计划书评审决议）：「连续错 5 次 → locked」无法按码计数——错误尝试
// 的哈希命不中任何条目，无从归属到某枚码。暴力防护的正确单位是「用户」：
// 滑动窗口内同一 channel:userId 连续 5 次核销失败 → 该用户锁出 10 分钟。
// 码级 locked 态保留，由管理台显式锁定（可疑活动人工处置）触达。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY_CODES = 'inbound:pairing'
const KEY_LOCKOUT = 'inbound:pairing:lockout'
/** 31 字符字母表：剔除 I/L/O/0/1 手机手输易混字符；8 位 ≈ 39.6 bit 熵。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const DEFAULT_TTL_MS = 10 * 60 * 1000
/** 用户级锁出：滑动窗内连续 5 次失败 → 锁 10 分钟（与 TTL 同量级）。 */
const MAX_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const LOCKOUT_MS = 10 * 60 * 1000
/** 终态条目保留 24h 供管理台/审计回看，之后写路径顺手清扫。 */
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000
const VALID_STATES = new Set(['minted', 'active', 'redeemed', 'expired', 'revoked', 'locked'])
const VALID_ORIGINS = new Set(['bootstrap', 'admin', 'owner'])

/** 常量时间比较（与审批 token vault 同款纪律）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** 生成一枚配对码（拒绝采样保证字母表均匀）。 */
function generateCode() {
  let code = ''
  while (code.length < CODE_LENGTH) {
    const byte = randomBytes(1)[0]
    if (byte < 248) { // 248 = 31*8：模偏差剔除（8 字节可编码 256，31*8=248，余 8 个偏置值）
      code += CODE_ALPHABET[byte % 31]
    }
  }
  return code
}

export const hashPairingCode = (code) =>
  createHash('sha256').update(String(code ?? '').trim().toUpperCase()).digest('hex')

/**
 * 创建配对码状态机。
 * @param {object} options
 * @param {import('./store.mjs').store} [options.store] - 持久化（跨重启保在铸码；null = 内存态，仅测试用）
 * @param {object} [options.logger]
 * @param {number} [options.ttlMs] - 码有效期，缺省 10 分钟
 * @param {(event: string, detail: object) => void} [options.onAudit] - mint/redeem/revoke/lock/lockout 审计回调
 */
export function createPairing(options = {}) {
  const store = options.store ?? null
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const audit = typeof options.onAudit === 'function' ? options.onAudit : () => {}
  // 内存态（store=null 时唯一真相；有 store 时用于无盘测试与降级）
  let memoryCodes = {}
  let memoryLockout = {}
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/pairing]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/pairing]', message) } catch { /* 控制台不可用不致命 */ }
  }

  /** 读全部码条目（读盘防御：坏形状整条丢弃）。 */
  function readCodes() {
    const raw = store !== null ? store.get(KEY_CODES, {}) : memoryCodes
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [hash, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object') continue
      if (!/^[0-9a-f]{64}$/.test(hash)) continue
      const state = VALID_STATES.has(value.state) ? value.state : 'expired'
      out[hash] = {
        id: typeof value.id === 'string' && value.id !== '' ? value.id : hash.slice(0, 8),
        hash,
        state,
        origin: VALID_ORIGINS.has(value.origin) ? value.origin : 'admin',
        mintedBy: typeof value.mintedBy === 'string' ? value.mintedBy : '',
        mintedAt: typeof value.mintedAt === 'number' ? value.mintedAt : 0,
        issuedAt: typeof value.issuedAt === 'number' ? value.issuedAt : 0,
        expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : 0,
        attempts: typeof value.attempts === 'number' ? value.attempts : 0,
        label: typeof value.label === 'string' ? value.label.slice(0, 64) : '',
        redeemedAt: typeof value.redeemedAt === 'number' ? value.redeemedAt : 0,
        redeemedBy: typeof value.redeemedBy === 'string' ? value.redeemedBy : '',
      }
    }
    return out
  }

  /** 写回（顺手清扫超过保留期的终态条目，防 state.json 无限膨胀）。 */
  function writeCodes(table, now = Date.now()) {
    const pruned = {}
    let prunedCount = 0
    for (const [hash, entry] of Object.entries(table)) {
      const terminal = entry.state === 'redeemed' || entry.state === 'expired' || entry.state === 'revoked' || entry.state === 'locked'
      const settledAt = entry.redeemedAt > 0 ? entry.redeemedAt : entry.expiresAt
      if (terminal && settledAt > 0 && now - settledAt > TERMINAL_RETENTION_MS) {
        prunedCount += 1
        continue
      }
      pruned[hash] = entry
    }
    if (prunedCount > 0) warn(`清扫 ${prunedCount} 条过期配对码终态记录`)
    if (store !== null) store.set(KEY_CODES, pruned)
    else memoryCodes = pruned
  }

  function readLockout() {
    const raw = store !== null ? store.get(KEY_LOCKOUT, {}) : memoryLockout
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object') continue
      const fails = Array.isArray(value.fails) ? value.fails.filter((ts) => typeof ts === 'number') : []
      // lockedUntil 持久化（R5 审查 R5-1-P2-1：只按滑窗计数判锁，最早一次失败滑出窗口的
      // 瞬间计数跌破阈值即解锁——「锁 10 分钟」承诺不成立；锁定时刻落盘后只看此刻）
      const lockedUntil = typeof value.lockedUntil === 'number' ? value.lockedUntil : 0
      if (fails.length > 0 || lockedUntil > 0) out[key] = { fails, lockedUntil }
    }
    return out
  }

  function writeLockout(table, now = Date.now()) {
    // 顺手剔除完全过期的条目（R5 审查 R5-3-P3-6：fails 全部滑出窗口且锁出已过——
    // 陌生人刷码面只增不减，长期运行 state.json 无限膨胀；有变更才写回，零写放大）
    const bounded = {}
    let pruned = false
    for (const [key, entry] of Object.entries(table)) {
      const failsLive = entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS)
      const lockLive = typeof entry.lockedUntil === 'number' && now < entry.lockedUntil
      if (failsLive.length === 0 && !lockLive) { pruned = true; continue }
      bounded[key] = { fails: failsLive, lockedUntil: lockLive ? entry.lockedUntil : 0 }
    }
    const next = pruned ? bounded : table
    if (store !== null) store.set(KEY_LOCKOUT, next)
    else memoryLockout = next
  }

  /** 惰性过期：读取路径顺手把超时未核销的 minted/active 转终态（免定时器）。
   * 翻转即落盘 + 落盘后才发审计（R5 审查 R5-1-P3-1：原实现部分调用路径改内存不落盘，
   * 同批超时条目每次读取重复 audit 刷屏、盘上长期停留 active）。 */
  function sweep(table, now = Date.now()) {
    const expired = []
    for (const entry of Object.values(table)) {
      if ((entry.state === 'minted' || entry.state === 'active') && entry.expiresAt > 0 && now >= entry.expiresAt) {
        entry.state = 'expired'
        expired.push(entry)
      }
    }
    if (expired.length > 0) {
      writeCodes(table, now)
      for (const entry of expired) audit('expire', { id: entry.id, origin: entry.origin })
    }
    return expired.length > 0
  }

  /** 用户锁出判定与失败记账。 */
  function isLockedOut(userKey, now = Date.now()) {
    const table = readLockout()
    const entry = table[userKey]
    if (entry === undefined) return false
    if (typeof entry.lockedUntil === 'number' && now < entry.lockedUntil) return true
    // 兼容旧形状（无 lockedUntil 字段的存量数据）：回落滑窗判定
    const fails = entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS)
    if (fails.length >= MAX_ATTEMPTS) {
      return now < fails[fails.length - 1] + LOCKOUT_MS
    }
    return false
  }

  function recordFailure(userKey, now = Date.now()) {
    const table = readLockout()
    const entry = table[userKey] ?? { fails: [], lockedUntil: 0 }
    // 已在锁出期：不刷新计数（锁出判定在 redeem 前置短路，这里只兜底）
    entry.fails = [...entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS), now]
    if (entry.fails.length >= MAX_ATTEMPTS) {
      // 触发/刷新锁出：锁定时刻持久化，滑窗过期不再提前解锁
      entry.lockedUntil = now + LOCKOUT_MS
    }
    table[userKey] = entry
    writeLockout(table, now)
    return now < entry.lockedUntil
  }

  function clearFailures(userKey) {
    const table = readLockout()
    if (table[userKey] === undefined) return
    delete table[userKey]
    writeLockout(table)
  }

  return {
    /**
     * 铸造配对码。码面只在本次返回值中出现一次（落盘只有哈希）。
     * origin='bootstrap' 单实例单码：新铸替换旧铸（引导态重铸语义）。
     * @returns {{ ok: boolean, id?: string, code?: string, expiresAt?: number, reason?: string }}
     */
    mint({ origin = 'admin', mintedBy = '', ttlMs: customTtl = undefined, label = '', now = Date.now() } = {}) {
      if (!VALID_ORIGINS.has(origin)) return { ok: false, reason: 'invalid-origin' }
      const table = readCodes()
      sweep(table, now)
      if (origin === 'bootstrap') {
        for (const entry of Object.values(table)) {
          if (entry.origin === 'bootstrap' && (entry.state === 'minted' || entry.state === 'active')) {
            entry.state = 'revoked'
            audit('revoke', { id: entry.id, origin: 'bootstrap', reason: 're-mint' })
          }
        }
      }
      const code = generateCode()
      const hash = hashPairingCode(code)
      const expiresAt = now + (customTtl ?? ttlMs)
      const entry = {
        id: hash.slice(0, 8),
        hash,
        state: 'minted',
        origin,
        mintedBy: String(mintedBy).slice(0, 64),
        mintedAt: now,
        issuedAt: 0,
        expiresAt,
        attempts: 0,
        label: String(label ?? '').slice(0, 64),
        redeemedAt: 0,
        redeemedBy: '',
      }
      table[hash] = entry
      writeCodes(table, now)
      audit('mint', { id: entry.id, origin, mintedBy, expiresAt })
      // mint 即下发（管理台响应即展示、bootstrap 即打 stderr）：minted→active 原子完成
      entry.state = 'active'
      entry.issuedAt = now
      writeCodes(table, now)
      return { ok: true, id: entry.id, code, expiresAt }
    },

    /**
     * 核销配对码（单次）：命中 active 且未过期 → redeemed 终态。
     * 用户级暴力防护：滑窗内连续 5 次失败锁出 10 分钟。
     * @param {string} code - 用户提交的码面（自动 trim + 大写归一）
     * @param {{ channel: string, userId: string, label?: string, now?: number }} who
     * @returns {{ ok: boolean, reason?: string, entry?: object }}
     */
    redeem(code, { channel, userId, label = '', now = Date.now() } = {}) {
      const userKey = `${String(channel ?? '')}:${String(userId ?? '')}`
      if (isLockedOut(userKey, now)) {
        audit('lockout', { user: userKey, phase: 'rejected' })
        return { ok: false, reason: 'locked-out' }
      }
      const normalized = String(code ?? '').trim().toUpperCase()
      if (normalized === '' || !/^[A-Z2-9]{1,64}$/.test(normalized)) {
        const tripped = recordFailure(userKey, now)
        if (tripped) audit('lockout', { user: userKey, phase: 'tripped' })
        return { ok: false, reason: tripped ? 'locked-out' : 'invalid-code' }
      }
      const table = readCodes()
      sweep(table, now)
      const hash = hashPairingCode(normalized)
      const entry = table[hash]
      if (entry === undefined || !safeEqual(entry.hash, hash)) {
        const tripped = recordFailure(userKey, now)
        if (tripped) audit('lockout', { user: userKey, phase: 'tripped' })
        return { ok: false, reason: tripped ? 'locked-out' : 'invalid-code' }
      }
      if (entry.state === 'redeemed') return { ok: false, reason: 'already-redeemed' }
      if (entry.state === 'revoked') return { ok: false, reason: 'revoked' }
      if (entry.state === 'locked') return { ok: false, reason: 'locked' }
      if (entry.state === 'expired' || now >= entry.expiresAt) {
        if (entry.state !== 'expired') {
          entry.state = 'expired'
          writeCodes(table, now)
          audit('expire', { id: entry.id, origin: entry.origin })
        }
        return { ok: false, reason: 'expired' }
      }
      // minted 未下发也可被核销（下发通道只是展示，不是安全边界）
      entry.state = 'redeemed'
      entry.redeemedAt = now
      entry.redeemedBy = userKey
      if (label !== '') entry.label = String(label).slice(0, 64)
      table[hash] = entry
      writeCodes(table, now)
      clearFailures(userKey)
      audit('redeem', { id: entry.id, origin: entry.origin, user: userKey })
      return { ok: true, entry: { ...entry, code: normalized } }
    },

    /** 撤销在铸码（owner/管理台）。 */
    revoke(id, { by = '', now = Date.now() } = {}) {
      const table = readCodes()
      sweep(table, now)
      // 只在在铸条目中找（R5 审查 R5-1-P3-4：8 位前缀撞车时 find 可能先命中终态条目，
      // 返回 already-* 让真正要处置的在铸码无法撤销）
      const entry = Object.values(table).find((item) => item.id === String(id ?? '') && (item.state === 'minted' || item.state === 'active'))
      if (entry === undefined) return { ok: false, reason: 'not-found' }
      entry.state = 'revoked'
      writeCodes(table, now)
      audit('revoke', { id: entry.id, origin: entry.origin, by })
      return { ok: true }
    },

    /** 锁定在铸码（可疑活动人工处置；终态）。 */
    lock(id, { by = '', now = Date.now() } = {}) {
      const table = readCodes()
      sweep(table, now)
      const entry = Object.values(table).find((item) => item.id === String(id ?? '') && (item.state === 'minted' || item.state === 'active'))
      if (entry === undefined) return { ok: false, reason: 'not-found' }
      entry.state = 'locked'
      writeCodes(table, now)
      audit('lock', { id: entry.id, origin: entry.origin, by })
      return { ok: true }
    },

    /** 在铸码列表（管理台；不含码面——只有哈希与状态）。 */
    listActive(now = Date.now()) {
      const table = readCodes()
      sweep(table, now) // 翻转即落盘（sweep 内部已持久化）
      return Object.values(table)
        .filter((entry) => entry.state === 'minted' || entry.state === 'active')
        .map((entry) => ({
          id: entry.id,
          state: entry.state,
          origin: entry.origin,
          mintedBy: entry.mintedBy,
          mintedAt: entry.mintedAt,
          expiresAt: entry.expiresAt,
          label: entry.label,
        }))
    },

    /** 是否存在任一在铸引导码（bootstrap 重铸判定用）。 */
    hasActiveBootstrap(now = Date.now()) {
      return this.listActive(now).some((entry) => entry.origin === 'bootstrap')
    },

    /** 诊断用：用户是否处于锁出期。 */
    isLockedOut(channel, userId, now = Date.now()) {
      return isLockedOut(`${String(channel ?? '')}:${String(userId ?? '')}`, now)
    },
  }
}
