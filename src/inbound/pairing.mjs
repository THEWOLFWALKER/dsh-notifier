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
import { setDurable, transactDurable, transactOutcome } from './store.mjs'

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

  /** 纯修剪（不改盘）：剔除超过保留期的终态条目，防 state.json 无限膨胀。 */
  function pruneCodes(table, now = Date.now()) {
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
    return { table: prunedCount > 0 ? pruned : table, prunedCount }
  }

  /**
   * v0.15（Gate 2F）：码表的**事务内 fresh 读改写**。`mutate(table, now)` 在提交瞬间的
   * fresh 表副本上执行，返回 `{ changed:boolean, ... }`：`changed !== true` → 业务无变更，
   * abort（零写盘）；`true` → 修剪后写回。真实 store 下读取与写回同一事务，杜绝
   * 「锁外读旧表 → 整表写回」覆盖并发 mint/revoke/lock/sweep（TOCTOU）。
   * store=null（内存态）与 legacy 无事务 store 退化为读改写（单进程 best-effort）。
   *
   * v0.15（Gate 2F 收口）：返回形状显式区分「提交成功 / 业务无变更（abort）/ 事务未提交
   * （锁忙、IO 失败）」。旧实现只回 `ok`，把「事务根本没跑到（inner=null）」也叫 `ok:true`，
   * 于是调用方（setCodeTerminal）把 IO 失败误报成 `not-found`——T16 用例正是钉这一点。
   * @returns {{ ok: boolean, committed: boolean, aborted: boolean, changed: boolean, result: object|null }}
   */
  const commitCodes = (mutate, now = Date.now()) => {
    if (store === null || typeof store.transact !== 'function') {
      const table = readCodes()
      const result = mutate(table, now) ?? null
      if (result?.changed !== true) return { ok: true, committed: false, aborted: true, changed: false, result }
      const { table: pruned, prunedCount } = pruneCodes(table, now)
      if (prunedCount > 0) warn(`清扫 ${prunedCount} 条过期配对码终态记录`)
      if (store === null) { memoryCodes = pruned; return { ok: true, committed: true, aborted: false, changed: true, result } }
      if (setDurable(store, KEY_CODES, pruned) !== true) return { ok: false, committed: false, aborted: false, changed: false, result }
      return { ok: true, committed: true, aborted: false, changed: true, result }
    }
    let inner = null
    const tx = transactOutcome(store, (draft, control) => {
      const table = normalizeCodes(draft[KEY_CODES] ?? {})
      inner = mutate(table, now) ?? null
      if (inner?.changed !== true) return control.abort('no-change')
      const { table: pruned, prunedCount } = pruneCodes(table, now)
      if (prunedCount > 0) warn(`清扫 ${prunedCount} 条过期配对码终态记录`)
      draft[KEY_CODES] = pruned
      return true
    })
    if (tx.aborted === true) return { ok: true, committed: false, aborted: true, changed: false, result: inner }
    if (tx.committed === true) return { ok: true, committed: true, aborted: false, changed: true, result: inner }
    // 锁忙 / 读失败 / IO 失败：mutator 可能根本没跑到（inner=null），绝不当「业务无变更」。
    return { ok: false, committed: false, aborted: false, changed: false, result: inner }
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

  /** 纯修剪（不改盘）：剔除完全过期的锁出条目（fails 全滑出窗口且锁出已过）。 */
  function pruneLockout(table, now = Date.now()) {
    const bounded = {}
    let pruned = false
    for (const [key, entry] of Object.entries(table)) {
      const failsLive = entry.fails.filter((ts) => now - ts < ATTEMPT_WINDOW_MS)
      const lockLive = typeof entry.lockedUntil === 'number' && now < entry.lockedUntil
      if (failsLive.length === 0 && !lockLive) { pruned = true; continue }
      bounded[key] = { fails: failsLive, lockedUntil: lockLive ? entry.lockedUntil : 0 }
    }
    return { table: pruned ? bounded : table, pruned }
  }

  /**
   * v0.15（Gate 2F）**跨两键**（codes + lockout）的事务内 fresh 读改写——`redeem` 专用。
   * 失败记账（lockout）与码终态（codes）必须原子：旧实现先 `recordFailure()` 写 lockout、
   * 再单独写 codes，两次写既各自基于锁外旧表（并发 redeem 互相覆盖失败计数/核销终态），
   * 又在中途崩溃时留下「记了失败但没核销」的半提交。真实 store 下两键的读取与写回都在
   * 同一个 `store.transact()` 内；legacy/memory 退化为本地副本上的读改写。
   *
   * `mutate(draft, control)` 直接改 draft 的两键：返回 `true` = 提交；`control.abort(reason)`
   * = 业务拒绝（零写盘）。返回形状与 `transactOutcome` 一致。
   * @param {(draft: object, control: object) => boolean} mutate
   * @returns {{ ok: boolean, committed: boolean, durable: boolean, aborted: boolean, code: string, reason: string|null }}
   */
  const commitPairing = (mutate, now = Date.now()) => {
    const fail = (code) => ({ ok: false, committed: false, durable: false, aborted: false, code, reason: null })
    if (store !== null && typeof store.transact === 'function') {
      return transactOutcome(store, (draft, control) => mutate(draft, control))
    }
    const draft = { [KEY_CODES]: readCodes(), [KEY_LOCKOUT]: readLockout() }
    const control = {
      aborted: false,
      reason: null,
      abort(reason) { this.aborted = true; this.reason = reason === undefined ? null : reason; return false },
    }
    let result
    try {
      result = mutate(draft, control)
    } catch (error) {
      return { ...fail('STATE_WRITE_FAILED'), error }
    }
    if (control.aborted === true) {
      return { ok: false, committed: false, durable: false, aborted: true, code: 'BUSINESS_ABORT', reason: control.reason }
    }
    if (result !== true) return fail('STATE_WRITE_FAILED')
    const pruned = pruneCodes(draft[KEY_CODES] ?? {}, now)
    if (pruned.prunedCount > 0) warn(`清扫 ${pruned.prunedCount} 条过期配对码终态记录`)
    const prunedLockout = pruneLockout(draft[KEY_LOCKOUT] ?? {}, now).table
    if (store === null) {
      memoryCodes = pruned.table
      memoryLockout = prunedLockout
      return { ok: true, committed: true, durable: true, aborted: false, code: 'COMMITTED', reason: null }
    }
    if (setDurable(store, KEY_CODES, pruned.table) !== true) return fail('STATE_WRITE_FAILED')
    if (setDurable(store, KEY_LOCKOUT, prunedLockout) !== true) return fail('STATE_WRITE_FAILED')
    return { ok: true, committed: true, durable: true, aborted: false, code: 'COMMITTED', reason: null }
  }

  /** 纯惰性过期（不改盘）：把超时未核销的 minted/active/minted-active 就地转 expired。
   * G-20（W12）：minted-active（单次原子落盘态）与 minted/active 同等可过期。 */
  function sweepInTable(table, now = Date.now()) {
    const expired = []
    for (const entry of Object.values(table)) {
      if ((entry.state === 'minted' || entry.state === 'active' || entry.state === 'minted-active')
        && entry.expiresAt > 0 && now >= entry.expiresAt) {
        entry.state = 'expired'
        expired.push(entry)
      }
    }
    return expired
  }

  /**
   * v0.15（Gate 2F）：惰性过期的**事务内 fresh 表**版本（listActive / mint / revoke / lock
   * 共用）。翻转在提交瞬间的表上完成并原子落盘，写成功后才发 expire 审计——绝不「读旧表
   * 翻转后整表写回」覆盖并发 mint/revoke。写失败不谎报已过期（返回空）。
   */
  const sweepCodes = (now = Date.now()) => {
    const expired = []
    const outcome = commitCodes((table, at) => {
      const list = sweepInTable(table, at)
      if (list.length === 0) return { changed: false }
      expired.push(...list)
      return { changed: true }
    }, now)
    if (outcome.committed !== true) return []
    for (const entry of expired) audit('expire', { id: entry.id, origin: entry.origin })
    return expired
  }

  /**
   * v0.15（Gate 2F）：在铸码置终态（revoke/lock 共用）的**事务内 fresh 表**判定与翻转。
   * 只在在铸条目中找（R5 审查 R5-1-P3-4：8 位前缀撞车时 find 可能先命中终态条目，返回
   * already-* 让真正要处置的在铸码无法撤销）；G-20（W12）下 minted-active 与 minted/active
   * 同等视为在铸。查找与写入同一事务，并发 mint/revoke 不会互相覆盖。
   * @returns {{ ok: boolean, reason?: string }}
   */
  const setCodeTerminal = (id, state, by, now, event = state === 'revoked' ? 'revoke' : 'lock') => {
    const target = { entry: null }
    const expired = []
    const outcome = commitCodes((table, at) => {
      expired.push(...sweepInTable(table, at))
      const entry = Object.values(table).find((item) => item.id === String(id ?? '')
        && (item.state === 'minted' || item.state === 'active' || item.state === 'minted-active'))
      if (entry === undefined) return { changed: false }
      entry.state = state
      target.entry = entry
      return { changed: true }
    }, now)
    // v0.15（Gate 2F 收口）：区分「事务确已提交」「fresh 表里无此在铸码（业务无变更）」与
    // 「事务未提交（锁忙/IO 失败）」——旧实现把后两者都当 not-found，IO 失败被伪装成 404。
    if (outcome.committed !== true) {
      if (outcome.aborted === true) return { ok: false, reason: 'not-found' }
      return { ok: false, reason: 'storage-failed' }
    }
    for (const item of expired) audit('expire', { id: item.id, origin: item.origin })
    audit(event, { id: target.entry.id, origin: target.entry.origin, by })
    return { ok: true }
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

  return {
    /**
     * 铸造配对码。码面只在本次返回值中出现一次（落盘只有哈希）。
     * origin='bootstrap' 单实例单码：新铸替换旧铸（引导态重铸语义）。
     * @returns {{ ok: boolean, id?: string, code?: string, expiresAt?: number, reason?: string }}
     */
    mint({ origin = 'admin', mintedBy = '', ttlMs: customTtl = undefined, label = '', now = Date.now() } = {}) {
      if (!VALID_ORIGINS.has(origin)) return { ok: false, reason: 'invalid-origin' }
      const code = generateCode()
      const hash = hashPairingCode(code)
      const expiresAt = now + (customTtl ?? ttlMs)
      // G-20（W12）：mint 即下发（管理台响应即展示、bootstrap 即打 stderr）——minted→active
      // 双写合并为单次原子写：状态字面量 'minted-active' 一次落盘（含 issuedAt），崩溃窗口消除。
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
      // v0.15（Gate 2F）：惰性过期 + 「bootstrap 重铸撤销旧码」+ 插入新码，全部在**同一个
      // 事务内**对 fresh 表完成——旧实现锁外 `readCodes` → 整表 `writeCodes`，并发 mint/revoke
      // 之间会互相覆盖（同一把码面上 8 位 id 占位与状态双双漂移）。
      const expired = []
      const revoked = []
      const outcome = commitCodes((table, at) => {
        expired.push(...sweepInTable(table, at))
        if (origin === 'bootstrap') {
          for (const item of Object.values(table)) {
            if (item.origin === 'bootstrap' && (item.state === 'minted' || item.state === 'active' || item.state === 'minted-active')) {
              item.state = 'revoked'
              revoked.push({ id: item.id, origin: 'bootstrap' })
            }
          }
        }
        table[hash] = entry
        return { changed: true }
      }, now)
      if (outcome.committed !== true) return { ok: false, reason: 'storage-failed' }
      for (const item of expired) audit('expire', { id: item.id, origin: item.origin })
      for (const item of revoked) audit('revoke', { ...item, reason: 're-mint' })
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
      const normalized = String(code ?? '').trim().toUpperCase()
      const settled = { ok: false, reason: 'invalid-code' }
      const audits = []
      // v0.15（Gate 2F）：锁出判定、失败记账、码终态、失败清零全部收进**同一个事务**的两键
      // draft（codes + lockout）。旧实现分两次写（先 lockout 再 codes）且都基于锁外旧表——
      // 并发 redeem 会互相覆盖失败计数（5 次阈值形同虚设）与核销终态。
      const tx = commitPairing((draft, control) => {
        const table = normalizeCodes(draft[KEY_CODES] ?? {})
        const lockout = normalizeLockout(draft[KEY_LOCKOUT] ?? {})
        if (isLockedOutFromTable(lockout, userKey, now)) {
          settled.reason = 'locked-out'
          audits.push({ event: 'lockout', detail: { user: userKey, phase: 'rejected' } })
          return control.abort('locked-out')
        }
        // 失效的提交形态 / 查无此码 = 真爆破面：记一次失败（可能翻锁），记账必须落盘。
        const fail = (reason) => {
          const failure = recordFailureInTable(lockout, userKey, now)
          // R5-3-P3-6：写路径顺手有界化——完全过期的旧条目（失败全滑出窗口且无锁出）清除，
          // 防陌生人刷码面把 state.json 撑大；锁出中的条目绝不清除（安全语义优先）。
          draft[KEY_LOCKOUT] = pruneLockout(lockout, now).table
          settled.reason = failure.locked ? 'locked-out' : reason
          if (failure.locked) audits.push({ event: 'lockout', detail: { user: userKey, phase: 'tripped' } })
          return true
        }
        if (normalized === '' || !/^[A-Z2-9]{1,64}$/.test(normalized)) return fail('invalid-code')
        const hash = hashPairingCode(normalized)
        const entry = table[hash]
        if (entry === undefined || !safeEqual(entry.hash, hash)) return fail('invalid-code')
        if (entry.state === 'redeemed') { settled.reason = 'already-redeemed'; return control.abort('already-redeemed') }
        if (entry.state === 'revoked') { settled.reason = 'revoked'; return control.abort('revoked') }
        if (entry.state === 'locked') { settled.reason = 'locked'; return control.abort('locked') }
        if (entry.state === 'expired' || now >= entry.expiresAt) {
          // G-30/G-31：过期码单独分支——不计入 5 次失败锁出，回执统一「码已过期」。
          // 过期码不是爆破信号（能提交过期码说明曾真实持有在铸码，爆破面是非法形态/
          // 查无此码，仍计失败）；防泵码由 commands.mjs ensureBootstrap 的 10min 重铸
          // 节流兜住（v0.8.7 的锁出防泵是多余一层，且会把用过时码的合法用户误锁 10min）。
          entry.state = 'expired'
          table[hash] = entry
          draft[KEY_CODES] = table
          settled.reason = 'expired'
          audits.push({ event: 'expire', detail: { id: entry.id, origin: entry.origin } })
          return true
        }
        // minted/minted-active 未下发也可被核销（下发通道只是展示，不是安全边界）；
        // G-20（W12）后 mint 只落 minted-active 单态，此处兼容存量 minted 行。
        entry.state = 'redeemed'
        entry.redeemedAt = now
        entry.redeemedBy = userKey
        if (label !== '') entry.label = String(label).slice(0, 64)
        table[hash] = entry
        delete lockout[userKey]
        draft[KEY_CODES] = table
        draft[KEY_LOCKOUT] = pruneLockout(lockout, now).table
        settled.ok = true
        settled.entry = { ...entry, code: normalized }
        audits.push({ event: 'redeem', detail: { id: entry.id, origin: entry.origin, user: userKey } })
        return true
      }, now)
      if (tx.committed === true) {
        for (const item of audits) audit(item.event, item.detail)
        return settled
      }
      if (tx.aborted === true) {
        // 业务拒绝（锁出期/终态）：零写盘；锁出期拒绝仍需审计。
        for (const item of audits) audit(item.event, item.detail)
        return { ok: false, reason: settled.reason }
      }
      return { ok: false, reason: 'storage-failed' }
    },

    /** 撤销在铸码（owner/管理台）。 */
    revoke(id, { by = '', now = Date.now() } = {}) {
      return setCodeTerminal(id, 'revoked', by, now)
    },

    /** 锁定在铸码（可疑活动人工处置；终态）。 */
    lock(id, { by = '', now = Date.now() } = {}) {
      return setCodeTerminal(id, 'locked', by, now)
    },

    /** 在铸码列表（管理台；不含码面——只有哈希与状态）。 */
    listActive(now = Date.now()) {
      sweepCodes(now) // 惰性过期：事务内翻转 + 落盘 + 落盘后才发 expire 审计
      const table = readCodes()
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
