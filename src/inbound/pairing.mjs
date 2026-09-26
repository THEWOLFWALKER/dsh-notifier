// dsh-notifier v0.7 inbound/pairing.mjs
// 配对码状态机（v0.7 计划书 §3.3）：minted-active → redeemed / expired / revoked / locked。
// G-20（W12）：mint 原「先落 minted 再落 active」双写之间有崩溃窗口——第一次写已上盘、
// 第二次写丢失时，盘上残留一枚「从未下发却被视为在铸可核销」的孤儿码（管理台响应未达，
// 用户拿不到码面，但 8 位前缀 id 已占位、可被核销）。两写合并为单次原子写：铸造即下发
// 的语义用状态字面量 'minted-active' 一次落盘表达，孤儿码窗口消除。审计行随后独立写
// （丢了只影响审计，不影响状态一致性）。
// 安全纪律沿用审批 token 已验证先例：单次核销、短 TTL、SHA-256 落盘、常量时间比较、
// 铸造/核销/撤销/锁定全进审计回调。零强制运行时依赖（仅 node:crypto）。
//
// 规格重解释（计划书评审决议）：「连续错 5 次 → locked」无法按码计数——错误尝试
// 的哈希命不中任何条目，无从归属到某枚码。暴力防护的正确单位是「用户」：
// 滑动窗口内同一 channel:userId 连续 5 次核销失败 → 该用户锁出 10 分钟。
// 码级 locked 态保留，由管理台显式锁定（可疑活动人工处置）触达。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { bindingKey, principalKey } from './identity.mjs'
import { setDurable, transactDurable } from './store.mjs'

const KEY_CODES = 'inbound:pairing'
const KEY_LOCKOUT = 'inbound:pairing:lockout'
/**
 * v0.13（C11.5 / R2）：配对 principal 是 `(channel, accountId, userId)`，与 identity 的
 * binding/principal 键规则同源——默认账号沿用旧复合键 `<channel>:<userId>`（存量锁出记录
 * 因此天然只作用于 default，不会被误扩散到其它账号），非默认账号用 `<channel>:<accountId>:<userId>`。
 */
const DEFAULT_ACCOUNT_ID = 'default'
function principalUserKey(channel, accountId, userId) {
  const account = String(accountId ?? '').trim() || DEFAULT_ACCOUNT_ID
  if (account === DEFAULT_ACCOUNT_ID) return bindingKey(channel, userId)
  return principalKey(channel, account, userId)
}
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
// G-20（W12）：'minted-active' 是「铸造即下发」的单次原子落盘态——mint 不再有
// minted→active 双写崩溃窗口；读取/过期/核销/撤销/锁定/列表全路径与 minted/active 同等对待。
const VALID_STATES = new Set(['minted', 'active', 'minted-active', 'redeemed', 'expired', 'revoked', 'locked'])
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
    return normalizeCodes(raw)
  }

  function normalizeCodes(raw) {
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
    if (store !== null) return setDurable(store, KEY_CODES, pruned)
    memoryCodes = pruned
    return true
  }

  function readLockout() {
    const raw = store !== null ? store.get(KEY_LOCKOUT, {}) : memoryLockout
    return normalizeLockout(raw)
  }

  function normalizeLockout(raw) {
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
    if (store !== null) return setDurable(store, KEY_LOCKOUT, next)
    memoryLockout = next
    return true
  }

  /** 惰性过期：读取路径顺手把超时未核销的 minted/active/minted-active 转终态（免定时器）。
   * 翻转即落盘 + 落盘后才发审计（R5 审查 R5-1-P3-1：原实现部分调用路径改内存不落盘，
   * 同批超时条目每次读取重复 audit 刷屏、盘上长期停留 active）。
   * G-20（W12）：minted-active（单次原子落盘态）与 minted/active 同等可过期。 */
  function sweep(table, now = Date.now()) {
    const expired = []
    for (const entry of Object.values(table)) {
      if ((entry.state === 'minted' || entry.state === 'active' || entry.state === 'minted-active')
        && entry.expiresAt > 0 && now >= entry.expiresAt) {
        entry.state = 'expired'
        expired.push(entry)
      }
    }
    if (expired.length > 0) {
      if (writeCodes(table, now) === true) {
        for (const entry of expired) audit('expire', { id: entry.id, origin: entry.origin })
      }
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
    const durable = writeLockout(table, now)
    return { locked: now < entry.lockedUntil, durable }
  }

  function isLockedOutFromTable(table, userKey, now) {
    const entry = table[userKey]
    if (entry === undefined) return false
    if (typeof entry.lockedUntil === 'number' && now < entry.lockedUntil) return true
    const fails = entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS)
    return fails.length >= MAX_ATTEMPTS && now < fails[fails.length - 1] + LOCKOUT_MS
  }

  function recordFailureInTable(table, userKey, now) {
    const entry = table[userKey] ?? { fails: [], lockedUntil: 0 }
    entry.fails = [...entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS), now]
    if (entry.fails.length >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS
    table[userKey] = entry
    return { locked: now < entry.lockedUntil }
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
          if (entry.origin === 'bootstrap' && (entry.state === 'minted' || entry.state === 'active' || entry.state === 'minted-active')) {
            entry.state = 'revoked'
            audit('revoke', { id: entry.id, origin: 'bootstrap', reason: 're-mint' })
          }
        }
      }
      const code = generateCode()
      const hash = hashPairingCode(code)
      const expiresAt = now + (customTtl ?? ttlMs)
      // G-20（W12）：mint 即下发（管理台响应即展示、bootstrap 即打 stderr）——minted→active
      // 双写合并为单次原子写：状态字面量 'minted-active' 一次落盘（含 issuedAt），崩溃窗口消除。
      // 审计行随后独立写：丢了只影响审计，不影响状态一致性。
      const entry = {
        id: hash.slice(0, 8),
        hash,
        state: 'minted-active',
        origin,
        mintedBy: String(mintedBy).slice(0, 64),
        mintedAt: now,
        issuedAt: now,
        expiresAt,
        attempts: 0,
        label: String(label ?? '').slice(0, 64),
        redeemedAt: 0,
        redeemedBy: '',
      }
      table[hash] = entry
      if (writeCodes(table, now) !== true) return { ok: false, reason: 'storage-failed' }
      audit('mint', { id: entry.id, origin, mintedBy, expiresAt })
      return { ok: true, id: entry.id, code, expiresAt }
    },

    /**
     * C4 application transaction：配对成功路径把 code、binding、lockout 清理放进
     * 同一个 detached state draft。bindInDraft 只能改 draft，不能自行写盘。
     */
    redeemAndBind(code, { channel, accountId = DEFAULT_ACCOUNT_ID, userId, label = '', now = Date.now() } = {}, bindInDraft) {
      if (store === null || typeof bindInDraft !== 'function') {
        return { ok: false, reason: 'transaction-unavailable' }
      }
      const userKey = principalUserKey(channel, accountId, userId)
      const normalized = String(code ?? '').trim().toUpperCase()
      const outcome = { ok: false, reason: 'invalid-code' }
      const audits = []
      const tx = transactDurable(store, (draft) => {
        const codes = normalizeCodes(draft[KEY_CODES] ?? {})
        const lockout = normalizeLockout(draft[KEY_LOCKOUT] ?? {})
        if (isLockedOutFromTable(lockout, userKey, now)) {
          outcome.reason = 'locked-out'
          audits.push({ event: 'lockout', detail: { user: userKey, phase: 'rejected' } })
          return false
        }
        if (normalized === '' || !/^[A-Z2-9]{1,64}$/.test(normalized)) {
          const failure = recordFailureInTable(lockout, userKey, now)
          draft[KEY_LOCKOUT] = lockout
          outcome.reason = failure.locked ? 'locked-out' : 'invalid-code'
          if (failure.locked) audits.push({ event: 'lockout', detail: { user: userKey, phase: 'tripped' } })
          return true
        }
        const hash = hashPairingCode(normalized)
        const entry = codes[hash]
        if (entry === undefined || !safeEqual(entry.hash, hash)) {
          const failure = recordFailureInTable(lockout, userKey, now)
          draft[KEY_LOCKOUT] = lockout
          outcome.reason = failure.locked ? 'locked-out' : 'invalid-code'
          if (failure.locked) audits.push({ event: 'lockout', detail: { user: userKey, phase: 'tripped' } })
          return true
        }
        if (entry.state === 'redeemed') { outcome.reason = 'already-redeemed'; return false }
        if (entry.state === 'revoked') { outcome.reason = 'revoked'; return false }
        if (entry.state === 'locked') { outcome.reason = 'locked'; return false }
        if (entry.state === 'expired' || now >= entry.expiresAt) {
          entry.state = 'expired'
          codes[hash] = entry
          draft[KEY_CODES] = codes
          outcome.reason = 'expired'
          audits.push({ event: 'expire', detail: { id: entry.id, origin: entry.origin } })
          return true
        }
        const added = bindInDraft(draft, { channel, accountId, userId, label, origin: 'paired' })
        if (added?.ok !== true) {
          outcome.reason = added?.reason ?? 'storage-failed'
          return false
        }
        entry.state = 'redeemed'
        entry.redeemedAt = now
        entry.redeemedBy = userKey
        if (label !== '') entry.label = String(label).slice(0, 64)
        codes[hash] = entry
        delete lockout[userKey]
        draft[KEY_CODES] = codes
        draft[KEY_LOCKOUT] = lockout
        outcome.ok = true
        outcome.record = added.record
        outcome.entry = { ...entry, code: normalized }
        audits.push({ event: 'redeem', detail: { id: entry.id, origin: entry.origin, user: userKey } })
        return true
      })
      if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
      for (const item of audits) audit(item.event, item.detail)
      return outcome
    },

    /**
     * 核销配对码（单次）：命中 active 且未过期 → redeemed 终态。
     * 用户级暴力防护：滑窗内连续 5 次失败锁出 10 分钟。
     * @param {string} code - 用户提交的码面（自动 trim + 大写归一）
     * @param {{ channel: string, accountId?: string, userId: string, label?: string, now?: number }} who
     * @returns {{ ok: boolean, reason?: string, entry?: object }}
     */
    redeem(code, { channel, accountId = DEFAULT_ACCOUNT_ID, userId, label = '', now = Date.now() } = {}) {
      const userKey = principalUserKey(channel, accountId, userId)
      if (isLockedOut(userKey, now)) {
        audit('lockout', { user: userKey, phase: 'rejected' })
        return { ok: false, reason: 'locked-out' }
      }
      const normalized = String(code ?? '').trim().toUpperCase()
      if (normalized === '' || !/^[A-Z2-9]{1,64}$/.test(normalized)) {
        const failure = recordFailure(userKey, now)
        if (failure.durable !== true) return { ok: false, reason: 'storage-failed' }
        if (failure.locked) audit('lockout', { user: userKey, phase: 'tripped' })
        return { ok: false, reason: failure.locked ? 'locked-out' : 'invalid-code' }
      }
      const table = readCodes()
      sweep(table, now)
      const hash = hashPairingCode(normalized)
      const entry = table[hash]
      if (entry === undefined || !safeEqual(entry.hash, hash)) {
        const failure = recordFailure(userKey, now)
        if (failure.durable !== true) return { ok: false, reason: 'storage-failed' }
        if (failure.locked) audit('lockout', { user: userKey, phase: 'tripped' })
        return { ok: false, reason: failure.locked ? 'locked-out' : 'invalid-code' }
      }
      if (entry.state === 'redeemed') return { ok: false, reason: 'already-redeemed' }
      if (entry.state === 'revoked') return { ok: false, reason: 'revoked' }
      if (entry.state === 'locked') return { ok: false, reason: 'locked' }
      if (entry.state === 'expired' || now >= entry.expiresAt) {
        if (entry.state !== 'expired') {
          entry.state = 'expired'
          if (writeCodes(table, now) !== true) return { ok: false, reason: 'storage-failed' }
          audit('expire', { id: entry.id, origin: entry.origin })
        }
        // G-30/G-31：过期码单独分支——不计入 5 次失败锁出，回执统一「码已过期」。
        // 过期码不是爆破信号（能提交过期码说明曾真实持有在铸码，爆破面是非法形态/
        // 查无此码，仍计失败）；防泵码由 commands.mjs ensureBootstrap 的 10min 重铸
        // 节流兜住（v0.8.7 的锁出防泵是多余一层，且会把用过时码的合法用户误锁 10min）。
        return { ok: false, reason: 'expired' }
      }
      // minted/minted-active 未下发也可被核销（下发通道只是展示，不是安全边界）；
      // G-20（W12）后 mint 只落 minted-active 单态，此处兼容存量 minted 行。
      entry.state = 'redeemed'
      entry.redeemedAt = now
      entry.redeemedBy = userKey
      if (label !== '') entry.label = String(label).slice(0, 64)
      table[hash] = entry
      if (writeCodes(table, now) !== true) return { ok: false, reason: 'storage-failed' }
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
      // G-20（W12）：minted-active（单次原子落盘态）与 minted/active 同等视为在铸。
      const entry = Object.values(table).find((item) => item.id === String(id ?? '')
        && (item.state === 'minted' || item.state === 'active' || item.state === 'minted-active'))
      if (entry === undefined) return { ok: false, reason: 'not-found' }
      entry.state = 'revoked'
      if (writeCodes(table, now) !== true) return { ok: false, reason: 'storage-failed' }
      audit('revoke', { id: entry.id, origin: entry.origin, by })
      return { ok: true }
    },

    /** 锁定在铸码（可疑活动人工处置；终态）。 */
    lock(id, { by = '', now = Date.now() } = {}) {
      const table = readCodes()
      sweep(table, now)
      const entry = Object.values(table).find((item) => item.id === String(id ?? '')
        && (item.state === 'minted' || item.state === 'active' || item.state === 'minted-active'))
      if (entry === undefined) return { ok: false, reason: 'not-found' }
      entry.state = 'locked'
      if (writeCodes(table, now) !== true) return { ok: false, reason: 'storage-failed' }
      audit('lock', { id: entry.id, origin: entry.origin, by })
      return { ok: true }
    },

    /** 在铸码列表（管理台；不含码面——只有哈希与状态）。 */
    listActive(now = Date.now()) {
      const table = readCodes()
      sweep(table, now) // 翻转即落盘（sweep 内部已持久化）
      // G-20（W12）：minted-active（单次原子落盘态）与 minted/active 同等视为在铸在列。
      return Object.values(table)
        .filter((entry) => entry.state === 'minted' || entry.state === 'active' || entry.state === 'minted-active')
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

    /** 诊断用：用户是否处于锁出期（accountId 缺省 = default 账号，与旧调用兼容）。 */
    isLockedOut(channel, userId, now = Date.now(), accountId = DEFAULT_ACCOUNT_ID) {
      return isLockedOut(principalUserKey(channel, accountId, userId), now)
    },
  }
}
