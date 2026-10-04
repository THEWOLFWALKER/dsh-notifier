// Paired private principals and bounded pending identity records.
// Identity keys are `(channel, accountId, userId)` tuples; conversation task bindings are a
// separate domain. YAML allowlists and transport credentials never create an authorized member.
// Store failures remain visible to the caller; damaged state is never silently overwritten.

import { INBOUND_CHANNEL_SET } from './channels-registry.mjs'
import { setDurable, transactDurable, transactOutcome } from './store.mjs'

const KEY_BINDINGS = 'inbound:bindings'
const KEY_PENDING = 'inbound:pending'
/** lastSeenAt 更新节流：每用户每小时最多一次落盘（避免每条入站消息都全量重写 state.json）。 */
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000
const VALID_CHANNELS = INBOUND_CHANNEL_SET // G-13：单一事实来源（原内联六通道字面量）
const VALID_ROLES = new Set(['owner', 'member'])
const VALID_ORIGINS = new Set(['migrated', 'paired', 'learned', 'confirmed'])

/** Legacy conversation-binding key helper; it does not identify an authorized principal. */
export function bindingKey(channel, userId) {
  const normalizedChannel = String(channel ?? '').trim().toLowerCase()
  const normalizedUserId = String(userId ?? '').trim()
  return `${normalizedChannel}:${normalizedUserId}`
}

/** Stable principal key: account is required so same-channel bots cannot share authorization. */
export function principalKey(channel, accountId, userId) {
  const normalizedChannel = String(channel ?? '').trim().toLowerCase()
  const normalizedAccountId = String(accountId ?? '').trim()
  const normalizedUserId = String(userId ?? '').trim()
  if (normalizedChannel === '' || normalizedAccountId === '' || normalizedAccountId === 'default' || normalizedUserId === '') return ''
  return `${normalizedChannel}:${normalizedAccountId}:${normalizedUserId}`
}

function normalizeAccountId(accountId) {
  const value = String(accountId ?? '').trim()
  if (value === '' || value === 'default' || value.length > 128 || value.includes(':')) return null
  return value
}

function keyFor(channel, userId, accountId) {
  const account = normalizeAccountId(accountId)
  if (account === null) return null
  return principalKey(channel, account, userId)
}

/** 归一化单条绑定记录（读盘防御：坏字段回退默认，坏形状整条丢弃）。 */
function normalizeBinding(raw, fallbackKey) {
  if (raw === null || typeof raw !== 'object') return null
  const keyRaw = String(fallbackKey ?? '')
  const colon = keyRaw.indexOf(':')
  const channel = colon > 0 ? keyRaw.slice(0, colon) : ''
  const fallbackUserId = colon > 0 ? keyRaw.slice(colon + 1) : ''
  const rawAccountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : ''
  const accountId = normalizeAccountId(rawAccountId)
  if (accountId === null) return null
  const record = {
    channel: typeof raw.channel === 'string' && raw.channel !== '' ? raw.channel : (VALID_CHANNELS.has(channel) ? channel : ''),
    userId: typeof raw.userId === 'string' && raw.userId !== '' ? raw.userId : fallbackUserId,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 64) : '',
    role: VALID_ROLES.has(raw.role) ? raw.role : 'member',
    pairedAt: typeof raw.pairedAt === 'number' ? raw.pairedAt : 0,
    lastSeenAt: typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : 0,
    origin: VALID_ORIGINS.has(raw.origin) ? raw.origin : 'paired',
  }
  record.accountId = accountId
  if (!VALID_CHANNELS.has(record.channel) || record.userId === '') return null
  return record
}

/** 待确认绑定保留 7 天（R5 审查 R5-3-P3-7：陌生人扫码/订阅写入后无人确认，
 * 待确认表只增不减——读路径顺手清扫，有变更才写回）。 */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 待确认队列容量上限（与入站去重 FIFO 同量级，防自报 uid 无限膨胀 state）。 */
const PENDING_MAX = 512

/**
 * 创建身份绑定层。
 * @param {object} options
 * @param {import('./store.mjs').store} [options.store] - 持久化 store（跨进程读收敛由 store 自带）
 * @param {object} [options.logger] - cordis logger
 */
export function createIdentity(options = {}) {
  const store = options.store ?? null
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/identity]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/identity]', message) } catch { /* 控制台不可用不致命 */ }
  }

  /** Read paired principals from the shared durable store. */
  function readBindings() {
    if (store === null) return {}
    const raw = store.get(KEY_BINDINGS, {})
    return normalizeBindings(raw)
  }

  function normalizeBindings(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeBinding(value, key)
      if (record !== null) {
        const canonical = keyFor(record.channel, record.userId, record.accountId)
        if (canonical !== null) out[canonical] = record
      }
    }
    return out
  }

  function writeBindings(table) {
    if (store === null) return true
    return setDurable(store, KEY_BINDINGS, table)
  }

  /** 纯规划器：坏绑定键清洗（不改盘，供事务内 fresh draft 与 legacy 回退共用）。 */
  const planCleanup = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const badKeys = []
    const cleaned = {}
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeBinding(value, key)
      if (record === null) { badKeys.push(key); continue }
      const canonical = keyFor(record.channel, record.userId, record.accountId)
      if (canonical !== key) { badKeys.push(key); continue }
      cleaned[key] = record
    }
    return { cleaned, badKeys }
  }

  const reportBadKeys = (badKeys) => {
    const preview = badKeys.slice(0, 3).map((k) => String(k).slice(0, 32)).join('、')
    warn(`坏绑定键启动清洗：${badKeys.length} 条移除（${preview}${badKeys.length > 3 ? '…' : ''}），绑定表与业务视图对齐`)
  }

  // G-44（W12）：启动时一次性清洗坏绑定键 + 写回 + warn 计数。
  // 坏键 = 存储键与业务视图无法往返的键：normalizeBinding 判坏形状（整条丢弃），或
  // 键与归一复合键不一致——bindingKey 收敛空白/大小写后对不上（如 ' telegram:42'、
  // 'Telegram:42'、'telegram: 42' 这类读路径永远命中不了的幽灵键）。allows() 用
  // bindingKey 归一查询，这些键只占存储不见天日，是「存储与业务视图长期不一致」的来源，
  // 读时清洗不写回会让盘上死键无限累积，故本批次改为启动一次性清洗 + 写回。
  // 只动 inbound:bindings；不会从 YAML 重播授权。
  // 连带清掉，「启动损坏白纸重置」（绑定表全坏读到空白）场景下管理台已删成员会被
  // YAML 静默复活（删减权收归管理台的契约被推翻），这是本条的放大面，测试必含。
  const startupCleanup = () => {
    if (store === null) return
    // v0.15（Gate 2D）：清洗进事务——启动时读到的表可能已被并发写者更新（host 与 CLI
    // 共享同一 state 文件），锁外读再整表写回会覆盖这些更新（清理是「读-改-写」，同样是
    // TOCTOU）。无事务能力的 legacy/mock store 保留原读改写路径。
    if (typeof store.transact !== 'function') {
      let raw
      try {
        raw = store.get(KEY_BINDINGS, {})
      } catch (error) {
        warn(`坏绑定键启动清洗读表失败（跳过，不阻塞）: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const plan = planCleanup(raw)
      if (plan === null || plan.badKeys.length === 0) return // 无死键：零写放大
      try {
        if (setDurable(store, KEY_BINDINGS, plan.cleaned) !== true) {
          warn('坏绑定键清洗写回未落盘（不致命）')
          return
        }
        reportBadKeys(plan.badKeys)
      } catch (error) {
        warn(`坏绑定键清洗写回失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const outcome = { badKeys: [] }
    const tx = transactOutcome(store, (draft, control) => {
      const plan = planCleanup(draft[KEY_BINDINGS] ?? {})
      if (plan === null || plan.badKeys.length === 0) return control.abort('clean')
      draft[KEY_BINDINGS] = plan.cleaned
      outcome.badKeys = plan.badKeys
      return true
    })
    if (tx.committed === true) reportBadKeys(outcome.badKeys)
  }
  startupCleanup()

  function readPending() {
    if (store === null) return {}
    const raw = store.get(KEY_PENDING, {})
    const normalized = normalizePending(raw)
    const out = normalized.out
    const expired = normalized.expired
    if (expired > 0 || Object.keys(out).length !== normalized.rawCount) {
      try {
        if (setDurable(store, KEY_PENDING, out) !== true) {
          warn('待确认绑定清扫写回未落盘（不致命）')
          return out
        }
        warn(`待确认绑定清扫：${expired} 条过期、${normalized.rawCount - Object.keys(out).length - expired} 条坏形状被移除`)
      } catch (error) {
        warn(`待确认绑定清扫写回失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out
  }

  function normalizePending(raw, now = Date.now()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { out: {}, expired: 0, rawCount: 0 }
    }
    const out = {}
    let expired = 0
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object') continue
      // TTL 清扫：超期条目跳过（下面统一写回）
      if (typeof value.at === 'number' && now - value.at > PENDING_TTL_MS) { expired += 1; continue }
      // C3：复合键按第一个冒号切分，含冒号的 userId 不得被截断（与 normalizeBinding/parseMemberKey 对齐）
      const colon = key.indexOf(':')
      const channel = colon > 0 ? key.slice(0, colon) : ''
      const fallbackUserId = colon > 0 ? key.slice(colon + 1) : ''
      const userId = typeof value.userId === 'string' && value.userId !== '' ? value.userId : fallbackUserId
      const accountId = normalizeAccountId(value.accountId)
      if (!VALID_CHANNELS.has(channel) || accountId === null || userId === '' || userId.includes(':')) continue
      const canonical = keyFor(channel, userId, accountId)
      if (canonical === null) continue
      out[canonical] = {
        channel,
        userId,
        origin: VALID_ORIGINS.has(value.origin) ? value.origin : 'learned',
        at: typeof value.at === 'number' ? value.at : 0,
        extra: value.extra !== null && typeof value.extra === 'object' ? value.extra : {},
      }
      out[canonical].accountId = accountId
    }
    return { out, expired, rawCount: Object.keys(raw).length }
  }

  function addBindingToTable(table, { channel, accountId, userId, label = '', origin = 'paired' } = {}) {
    if (!VALID_CHANNELS.has(channel)) return { ok: false, reason: 'invalid-channel' }
    const normalizedAccountId = normalizeAccountId(accountId)
    if (normalizedAccountId === null) return { ok: false, reason: 'invalid-account' }
    const uid = String(userId ?? '').trim()
    if (uid === '' || uid.length > 128) return { ok: false, reason: 'invalid-user' }
    if (uid.includes(':')) {
      warn(`拒绝含冒号的 userId 绑定（复合键截断风险）：${channel}:${uid.slice(0, 32)}`)
      return { ok: false, reason: 'invalid-user' }
    }
    const key = keyFor(channel, uid, normalizedAccountId)
    if (table[key] !== undefined) return { ok: false, reason: 'already-bound' }
    const record = {
      channel,
      userId: uid,
      label: String(label ?? '').slice(0, 64),
      role: Object.keys(table).length === 0 ? 'owner' : 'member',
      pairedAt: Date.now(),
      lastSeenAt: 0,
      origin: VALID_ORIGINS.has(origin) ? origin : 'paired',
    }
    record.accountId = normalizedAccountId
    table[key] = record
    return { ok: true, record }
  }

  /** owner 计数（锁内守卫用；基于传入的 draft 表，而非盘上快照）。 */
  const countOwners = (table) => Object.values(table).filter((record) => record?.role === 'owner').length

  /**
   * v0.15（T05 / K03）：绑定表的**锁内**变更。last-owner 守卫必须与写入落在同一个 fresh
   * 事务里判定——旧实现把守卫放在 members service 的锁外 `ownerCount()` 预检，两个并发
   * 降级各自看到「还有 2 个 owner」而双双通过，末位 owner 被 TOCTOU 击穿。守卫现已收归
   * authority（identity）锁内，service 预检只做快速失败，不再是唯一守卫。
   *
   * `apply(table, record)` 返回 `{ ok:true, ... } | { ok:false, reason }`；拒绝 = 事务 abort
   * （真实 store 零写盘、零发布）。无事务能力的 legacy/mock store 退化为读改写，判断仍先于变更。
   */
  const mutateBinding = (key, apply) => {
    if (typeof store?.transact !== 'function') {
      const table = readBindings()
      const record = table[key]
      if (record === undefined) return { ok: false, reason: 'not-found' }
      const outcome = apply(table, record)
      if (outcome.ok !== true) return outcome
      if (writeBindings(table) !== true) return { ok: false, reason: 'storage-failed' }
      return outcome
    }
    let settled = { ok: false, reason: 'not-found' }
    const tx = transactOutcome(store, (draft, control) => {
      const table = normalizeBindings(draft[KEY_BINDINGS] ?? {})
      const record = table[key]
      if (record === undefined) { settled = { ok: false, reason: 'not-found' }; return control.abort('not-found') }
      const outcome = apply(table, record)
      if (outcome.ok !== true) { settled = outcome; return control.abort(outcome.reason) }
      draft[KEY_BINDINGS] = table
      settled = outcome
      return true
    })
    if (tx.aborted === true) return settled
    if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
    return settled
  }

  /**
   * v0.15（Gate 2D）：lastSeenAt 的**锁内 fresh 行 patch**。旧实现把整张读到的表
   * `{ ...table, [key]: record }` 写回——标称「只 patch timestamp」实际是整表覆写，
   * 并发 addBinding/updateBinding 在读到之后、写回之前落地的变更会被这张旧表吃掉。
   * 现在事务内只改这一行的 lastSeenAt，其余键取提交瞬间的 fresh draft。
   * 无事务能力的 legacy/mock store 保留单键读改写（不伪造原子性）。
   * @returns {boolean} 是否落盘（真 store 下节流内 / 行缺失 abort，零写放大）
   */
  const touchLastSeen = (key) => {
    const now = Date.now()
    if (typeof store?.transact !== 'function') {
      const table = readBindings()
      const record = table[key]
      if (record === undefined || now - record.lastSeenAt <= LAST_SEEN_THROTTLE_MS) return false
      record.lastSeenAt = now
      return writeBindings({ ...table, [key]: record }) === true
    }
    const tx = transactOutcome(store, (draft, control) => {
      const table = normalizeBindings(draft[KEY_BINDINGS] ?? {})
      const record = table[key]
      if (record === undefined) return control.abort('not-found')
      if (now - record.lastSeenAt <= LAST_SEEN_THROTTLE_MS) return control.abort('throttled')
      record.lastSeenAt = now
      draft[KEY_BINDINGS] = table
      return true
    })
    return tx.committed === true
  }

  /**
   * v0.15（T06）：待确认新增的纯规划器——往 draft 的 pending 表写入（含容量裁剪）。
   * 抽出来是为了让真 store 的锁内路径与 legacy 无事务回退路径共用同一份判定，避免两处漂移。
   */
  const planPendingAdd = (draft, key, entry) => {
    const table = normalizeBindings(draft[KEY_BINDINGS] ?? {})
    if (table[key] !== undefined) return { ok: false, reason: 'already-bound' }
    const pending = normalizePending(draft[KEY_PENDING] ?? {}).out
    pending[key] = entry
    const keys = Object.keys(pending)
    if (keys.length > PENDING_MAX) {
      keys.sort((a, b) => (pending[a]?.at ?? 0) - (pending[b]?.at ?? 0))
      for (const stale of keys.slice(0, keys.length - PENDING_MAX)) delete pending[stale]
    }
    draft[KEY_PENDING] = pending
    return { ok: true }
  }

  return {
    /** 复合键准入（v0.7 计划书 §3.1：准入带渠道维度，修跨渠道串扰）。 */
    allows(channel, userId, accountId) {
      if (typeof channel !== 'string' || typeof userId !== 'string') return false
      // G-49：读键与写回键同走 bindingKey 归一（' user ' 与 'user' 同键），单一构造点
      // 防读写两侧漂移——若写回用裸 channel 拼键，未来分量归一放宽时会落出
      // ' telegram :user' 这类永不被读键命中的幽灵重复键。现网适配器输出恰好归一，
      // 此修是休眠边界封口，不改变现网行为。
      const key = keyFor(channel, userId, accountId)
      if (key === null) return false
      const table = readBindings()
      const record = table[key]
      if (record === undefined) return false
      // lastSeenAt 节流更新（外层快速短路 + 锁内只 patch 该行 timestamp，绝不整表覆写）
      if (Date.now() - record.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
        try {
          touchLastSeen(key)
        } catch (error) {
          warn(`lastSeenAt 更新失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return true
    },

    /** 绑定表是否为空（空 = 引导态判定输入之一，v0.7 计划书 §3.2）。 */
    isEmpty() {
      return Object.keys(readBindings()).length === 0
    },

    /** 绑定数（启动日志/管理台总览用）。 */
    size() {
      return Object.keys(readBindings()).length
    },

    /** 全量绑定列表（可选按渠道过滤；管理台成员页/目标解析用）。 */
    list(channel = '') {
      const table = readBindings()
      const records = Object.values(table)
      return channel === '' ? records : records.filter((record) => record.channel === channel)
    },

    /** owner 数量（末位 owner 守卫用）。 */
    ownerCount() {
      return this.list().filter((record) => record.role === 'owner').length
    },

    /**
     * 新增绑定（配对核销/待确认转正）。首条绑定为 owner（配对语义：bootstrap 单胜也走这里）。
     * @returns {{ ok: boolean, record?: object, reason?: string }}
     */
    addBinding({ channel, accountId, userId, label = '', origin = 'paired' }) {
      // v0.15（Gate 2D）：真 store 锁内 fresh 读改写——首 owner 判定（`Object.keys(table).length === 0`）
      // 与写入同一事务，两个并发「首绑」不再各自看到空表而双双被铸成 owner。
      // 无事务能力的 legacy/mock store 保留读改写兼容路径。
      if (typeof store?.transact !== 'function') {
        const table = readBindings()
        const result = addBindingToTable(table, { channel, accountId, userId, label, origin })
        if (result.ok !== true) return result
        if (writeBindings(table) !== true) return { ok: false, reason: 'storage-failed' }
        return result
      }
      const settled = { ok: false, reason: 'invalid-channel' }
      const tx = transactOutcome(store, (draft, control) => {
        const table = normalizeBindings(draft[KEY_BINDINGS] ?? {})
        const result = addBindingToTable(table, { channel, accountId, userId, label, origin })
        if (result.ok !== true) {
          settled.reason = result.reason
          return control.abort(result.reason)
        }
        draft[KEY_BINDINGS] = table
        settled.ok = true
        settled.record = result.record
        return true
      })
      if (tx.aborted === true) return settled
      if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
      return settled
    },

    /**
     * C4 application transaction hook：只在 detached state draft 上准备绑定，
     * 供 pairing 将「码核销 + 绑定 + 锁出清理」一次提交。不会自行写盘。
     */
    addBindingToDraft(draft, { channel, accountId, userId, label = '', origin = 'paired' } = {}) {
      if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
        return { ok: false, reason: 'storage-failed' }
      }
      const table = normalizeBindings(draft[KEY_BINDINGS] ?? {})
      const result = addBindingToTable(table, { channel, accountId, userId, label, origin })
      if (result.ok !== true) return result
      draft[KEY_BINDINGS] = table
      return result
    },

    /**
     * 移除绑定。末位 owner 不可删——守卫在**锁内**（mutateBinding 的同一事务），
     * 与删除动作原子，杜绝并发双删清零（K03）。
     */
    removeBinding(channel, userId, accountId) {
      const key = keyFor(channel, String(userId ?? ''), accountId)
      if (key === null) return { ok: false, reason: 'invalid-account' }
      return mutateBinding(key, (table, record) => {
        if (record.role === 'owner' && countOwners(table) <= 1) return { ok: false, reason: 'owner-last' }
        delete table[key]
        return { ok: true }
      })
    },

    /**
     * 改 label/role。末位 owner 不可降级——同样在锁内判定（K03）；label 变更不受影响。
     */
    updateBinding(channel, userId, diff = {}, accountId) {
      const key = keyFor(channel, String(userId ?? ''), accountId)
      if (key === null) return { ok: false, reason: 'invalid-account' }
      return mutateBinding(key, (table, record) => {
        const next = { ...record }
        if (typeof diff.label === 'string') next.label = diff.label.slice(0, 64)
        if (VALID_ROLES.has(diff.role)) {
          if (diff.role === 'member' && record.role === 'owner' && countOwners(table) <= 1) {
            return { ok: false, reason: 'owner-last' }
          }
          next.role = diff.role
        }
        table[key] = next
        return { ok: true, record: next }
      })
    },

    // ———————— 待确认绑定（学习键汇流，v0.7 计划书 §3.6） ————————

    /** 记录待确认身份（飞书扫码 openId / wxpusher 订阅 uid）。幂等：已存在刷新 at。 */
    addPending({ channel, accountId, userId, origin = 'learned', extra = {} }) {
      if (!VALID_CHANNELS.has(channel)) return { ok: false, reason: 'invalid-channel' }
      const normalizedAccountId = normalizeAccountId(accountId)
      if (normalizedAccountId === null) return { ok: false, reason: 'invalid-account' }
      const uid = String(userId ?? '').trim()
      if (uid === '' || uid.length > 128) return { ok: false, reason: 'invalid-user' }
      if (uid.includes(':')) {
        warn(`拒绝含冒号的 userId 待确认绑定（复合键截断风险）：${channel}:${uid.slice(0, 32)}`)
        return { ok: false, reason: 'invalid-user' }
      }
      const key = keyFor(channel, uid, normalizedAccountId)
      if (key === null) return { ok: false, reason: 'invalid-account' }
      const entry = { channel, userId: uid, origin, at: Date.now(), extra }
      entry.accountId = normalizedAccountId
      // v0.15（T06）：真 store 走锁内读改写——旧实现锁外 readBindings+readPending 再整表
      // setDurable，并发两次 addPending 会互相覆盖（同键整表丢失更新）。
      if (typeof store?.transact === 'function') {
        const outcome = { ok: false, reason: 'not-found' }
        const tx = transactOutcome(store, (draft, control) => {
          const applied = planPendingAdd(draft, key, entry)
          if (applied.ok !== true) { outcome.reason = applied.reason; return control.abort(applied.reason) }
          outcome.ok = true
          return true
        })
        if (tx.aborted === true) return outcome
        if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
        return { ok: true }
      }
      const legacyDraft = { [KEY_BINDINGS]: readBindings(), [KEY_PENDING]: readPending() }
      const applied = planPendingAdd(legacyDraft, key, entry)
      if (applied.ok !== true) return applied
      if (store !== null && setDurable(store, KEY_PENDING, legacyDraft[KEY_PENDING]) !== true) {
        return { ok: false, reason: 'storage-failed' }
      }
      return { ok: true }
    },

    listPending() {
      return Object.values(readPending())
    },

    /** 确认待确认绑定 → 转正为正式成员。 */
    confirmPending(channel, userId, accountId) {
      if (store === null) return { ok: false, reason: 'not-found' }
      // 遗留第三方/mock store 没有跨键 transact：保留兼容路径；正式 createStore
      // 始终走下面的单事务路径，避免真实状态出现 pending/binding 半提交。
      if (typeof store.transact !== 'function') {
        const pending = readPending()
        const key = keyFor(channel, String(userId ?? ''), accountId)
        if (key === null) return { ok: false, reason: 'invalid-account' }
        const entry = pending[key]
        if (entry === undefined) return { ok: false, reason: 'not-found' }
        const bindings = readBindings()
        if (bindings[key] !== undefined) return { ok: false, reason: 'already-bound' }
        const added = addBindingToTable(bindings, { channel, accountId: entry.accountId, userId: entry.userId, origin: 'confirmed' })
        if (added.ok !== true) return added
        delete pending[key]
        if (setDurable(store, KEY_PENDING, pending) !== true) return { ok: false, reason: 'storage-failed' }
        if (setDurable(store, KEY_BINDINGS, bindings) !== true) return { ok: false, reason: 'storage-failed' }
        return added
      }
      const outcome = { ok: false, reason: 'not-found' }
      const tx = transactOutcome(store, (draft, control) => {
        const pending = normalizePending(draft[KEY_PENDING] ?? {}).out
        const bindings = normalizeBindings(draft[KEY_BINDINGS] ?? {})
        const key = keyFor(channel, String(userId ?? ''), accountId)
        if (key === null) { outcome.reason = 'invalid-account'; return control.abort('invalid-account') }
        const entry = pending[key]
        if (entry === undefined) { outcome.reason = 'not-found'; return control.abort('not-found') }
        if (bindings[key] !== undefined) {
          outcome.reason = 'already-bound'
          return control.abort('already-bound')
        }
        delete pending[key]
        const added = addBindingToTable(bindings, {
          channel,
          accountId: entry.accountId,
          userId: entry.userId,
          origin: 'confirmed',
        })
        if (added.ok !== true) {
          outcome.reason = added.reason
          return control.abort(added.reason)
        }
        draft[KEY_PENDING] = pending
        draft[KEY_BINDINGS] = bindings
        outcome.ok = true
        outcome.record = added.record
        return true
      })
      // v0.15（T04/T05）：业务拒绝（not-found / already-bound / invalid-account）走 abort——
      // 真实 store 零写盘零发布，且与 IO 失败区分：只有真正未提交才是 storage-failed。
      if (tx.aborted === true) return outcome
      if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
      return outcome
    },

    dismissPending(channel, userId, accountId) {
      const key = keyFor(channel, String(userId ?? ''), accountId)
      if (key === null) return { ok: false, reason: 'invalid-account' }
      // v0.15（T06）：同 addPending——真 store 锁内读改写，业务拒绝 abort（零写盘）。
      if (typeof store?.transact === 'function') {
        const outcome = { ok: false, reason: 'not-found' }
        const tx = transactOutcome(store, (draft, control) => {
          const pending = normalizePending(draft[KEY_PENDING] ?? {}).out
          if (pending[key] === undefined) { outcome.reason = 'not-found'; return control.abort('not-found') }
          delete pending[key]
          draft[KEY_PENDING] = pending
          outcome.ok = true
          return true
        })
        if (tx.aborted === true) return outcome
        if (tx.committed !== true) return { ok: false, reason: 'storage-failed' }
        return { ok: true }
      }
      const pending = readPending()
      if (pending[key] === undefined) return { ok: false, reason: 'not-found' }
      delete pending[key]
      if (store !== null && setDurable(store, KEY_PENDING, pending) !== true) {
        return { ok: false, reason: 'storage-failed' }
      }
      return { ok: true }
    },
  }
}

/** 渠道合法性集合（commands/admin 层复用）。 */
export const IDENTITY_CHANNELS = VALID_CHANNELS
