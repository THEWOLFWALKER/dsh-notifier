// dsh-notifier v0.14 — members / pairing control application service.
//
// Single orchestration entry for member identity and pairing-code lifecycle,
// shared by the Native control surface (future S06/S07) and the Advanced
// Console adapter (src/admin/api.mjs). It owns *orchestration only*:
//
//   - member list / add / remove / update (label·role), incl. the last-owner guard
//   - pending identity list / add / remove / approve (pending -> binding)
//   - pairing-code list / mint / revoke / redeem
//
// It deliberately does NOT own:
//   - the member binding table or the pending table (identity is the authority, I1)
//   - the pairing code state machine (pairing is the authority, I1)
//   - HTTP status mapping, ApiError, audit files (adapter-level, I9)
//   - React / client state
//
// Authority stays where I1 puts it: member identity in `src/inbound/identity.mjs`,
// pairing lifecycle in `src/inbound/pairing.mjs`. This module wraps those
// authorities so that no adapter holds a second write path or re-implements the
// domain's validation (I7 fail-closed) and write logic.
//
// Failure semantics (I2 / I3 / I16): every mutation returns the underlying
// domain's canonical result; a durable commit failure is surfaced as
// `storage-failed`, never silently reported as success. The pending -> member
// promotion reuses identity.confirmPending's single-store transaction (I3), so a
// failed transaction publishes neither memory nor disk.

import { INBOUND_CHANNEL_SET } from '../inbound/channels-registry.mjs'

const VALID_CHANNELS = INBOUND_CHANNEL_SET
const isFn = (value) => typeof value === 'function'

/** 成员键形状提示（管理台 adapter 与 CLI 共用同一文案）。 */
export const MEMBER_KEY_HINT = '成员键形状：<channel>:<userId> 或 <channel>:<accountId>:<userId>（channel ∈ telegram/feishu/qq/wxpusher/wechat/dingtalk）'

/**
 * v0.7 成员复合键 "<channel>:<userId>" / v0.13 "<channel>:<accountId>:<userId>" 解析。
 * userId 内含冒号也容忍（只按第一个冒号切）；渠道必须属六入站通道，userId 非空且 ≤128，
 * accountId 非空且 ≤128（缺省 = default 账号，非默认账号走三段键）。
 *
 * 说明（与 admin/api.mjs 原实现逐字等价）：本函数**故意不拒**含冒号的 userId——纵深
 * 防御设在「写入面」（identity.addBinding/addPending fail-closed），此处只服务读改删，
 * 否则 C3 之前落盘的存量冒号绑定行将再也无法经管理台降级/删除（唯一清理入口被堵死）。
 * @returns {{ channel: string, accountId?: string, userId: string, raw: string } | null}
 */
export function parseMemberKey(key) {
  const raw = String(key ?? '').trim()
  const colon = raw.indexOf(':')
  if (colon <= 0) return null
  const channel = raw.slice(0, colon)
  const remainder = raw.slice(colon + 1)
  const parts = remainder.split(':')
  const accountId = parts.length >= 2 ? parts[0] : undefined
  const userId = parts.length >= 2 ? parts.slice(1).join(':') : remainder
  if (!VALID_CHANNELS.has(channel)) return null
  if (userId === '' || userId.length > 128 || (accountId !== undefined && (accountId === '' || accountId.length > 128))) return null
  return { channel, ...(accountId === undefined ? {} : { accountId }), userId, raw }
}

/** 由记录反推复合键（含 accountId 时用三段键）。 */
export function memberKeyOf(record) {
  if (record?.accountId !== undefined && String(record.accountId) !== '') {
    return `${record.channel}:${record.accountId}:${record.userId}`
  }
  return `${record?.channel}:${record?.userId}`
}

/** 成员记录 → 脱敏视图（与 admin getMembers 口径逐字一致；身份记录本身不含凭证）。 */
function memberView(record) {
  return {
    key: memberKeyOf(record),
    channel: record.channel,
    ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
    userId: record.userId,
    label: record.label,
    role: record.role,
    origin: record.origin,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
  }
}

/** 待确认记录 → 脱敏视图。 */
function pendingView(entry) {
  return {
    key: memberKeyOf(entry),
    channel: entry.channel,
    ...(entry.accountId !== undefined ? { accountId: entry.accountId } : {}),
    userId: entry.userId,
    origin: entry.origin,
    at: entry.at,
  }
}

/** 末位 owner 守卫：ownerCount 读取失败按 1（保守，宁可拒绝也不误删/误降）。 */
function ownerCountSafe(identity) {
  try { return identity.ownerCount() } catch { return 1 }
}

/**
 * @param {object} deps
 * @param {object} [deps.identity] - createIdentity() instance (member identity authority)
 * @param {object} [deps.pairing] - createPairing() instance (pairing lifecycle authority)
 */
export function createMembersControlService({ identity = null, pairing = null } = {}) {
  const hasIdentity = identity !== null && identity !== undefined
  const hasPairing = pairing !== null && pairing !== undefined

  const canUpdateMember = hasIdentity && isFn(identity.updateBinding)
  const canRemoveMember = hasIdentity && isFn(identity.removeBinding)
  const canConfirmPending = hasIdentity && isFn(identity.confirmPending)
  const canDismissPending = hasIdentity && isFn(identity.dismissPending)
  const canMintPairing = hasPairing && isFn(pairing.mint)
  const canRevokePairing = hasPairing && isFn(pairing.revoke)

  /** 定位成员记录（读改删路径用；与 admin 原 resolveMemberRecord 等价）。 */
  const resolveMember = (parsed, pending = false) => {
    const records = pending ? identity.listPending() : identity.list(parsed.channel)
    return records.find((record) => memberKeyOf(record) === parsed.raw)
  }

  // ————————————————————————— 成员 —————————————————————————

  /** 全量成员视图（只读；identity 未装配返回空表，读失败由 adapter 兜底降级）。 */
  const listMembers = (channel = '') => {
    if (!hasIdentity) return []
    return identity.list(channel).map(memberView)
  }

  /**
   * 新增成员绑定（首条为 owner，identity 语义）。fail-closed：未知 channel / 非法
   * accountId / 空或超长 userId 一律由 identity 拒绝，不产生任何落盘（I7 / I16）。
   * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
   */
  const addMember = ({ channel, accountId, userId, label = '', origin = 'paired' } = {}) => {
    if (!hasIdentity || !isFn(identity.addBinding)) return { ok: false, reason: 'not-supported' }
    const result = identity.addBinding({ channel, accountId, userId, label, origin })
    if (result.ok !== true) return { ok: false, reason: result.reason }
    return { ok: true, record: result.record }
  }

  /**
   * 改成员 label/role。末位 owner 不可降级（业务守卫在本服务，identity 只做数据操作）。
   * @param {string} key - 复合键
   * @param {{ label?: string, role?: string }} diff - 已由 adapter 归一的表现层形状
   * @returns {{ ok: true, key: string, record: object } | { ok: false, reason: string, key?: string }}
   */
  const updateMember = (key, diff = {}) => {
    if (!canUpdateMember) return { ok: false, reason: 'not-supported' }
    const parsed = parseMemberKey(key)
    if (parsed === null) return { ok: false, reason: 'invalid-key' }
    const current = resolveMember(parsed)
    if (current === undefined) return { ok: false, reason: 'not-found', key: parsed.raw }
    if (diff.role === 'member' && current.role === 'owner' && ownerCountSafe(identity) <= 1) {
      return { ok: false, reason: 'owner-last', key: parsed.raw }
    }
    const result = identity.updateBinding(current.channel, current.userId, diff, current.accountId)
    if (result.ok !== true) return { ok: false, reason: 'not-found', key: parsed.raw }
    return { ok: true, key: parsed.raw, record: result.record }
  }

  /**
   * 移除成员。末位 owner 不可删（守卫在本服务）。返回值携带被删者 role 供 adapter 审计
   * （不透传进 HTTP 响应——adapter 只渲染 { key, deleted: true }）。
   * @returns {{ ok: true, key: string, role: string } | { ok: false, reason: string, key?: string }}
   */
  const removeMember = (key) => {
    if (!canRemoveMember) return { ok: false, reason: 'not-supported' }
    const parsed = parseMemberKey(key)
    if (parsed === null) return { ok: false, reason: 'invalid-key' }
    const current = resolveMember(parsed)
    if (current === undefined) return { ok: false, reason: 'not-found', key: parsed.raw }
    if (current.role === 'owner' && ownerCountSafe(identity) <= 1) {
      return { ok: false, reason: 'owner-last', key: parsed.raw }
    }
    const result = identity.removeBinding(current.channel, current.userId, current.accountId)
    if (result.ok !== true) return { ok: false, reason: 'not-found', key: parsed.raw }
    return { ok: true, key: parsed.raw, role: current.role }
  }

  // ————————————————————————— 待确认身份 —————————————————————————

  /** 待确认身份视图（可选按渠道过滤）。 */
  const listPending = (channel = '') => {
    if (!hasIdentity) return []
    const records = identity.listPending().map(pendingView)
    return channel === '' ? records : records.filter((record) => record.channel === channel)
  }

  /** 记录待确认身份（幂等刷新 at）。fail-closed 由 identity 保证。 */
  const addPending = ({ channel, accountId, userId, origin = 'learned', extra = {} } = {}) => {
    if (!hasIdentity || !isFn(identity.addPending)) return { ok: false, reason: 'not-supported' }
    const result = identity.addPending({ channel, accountId, userId, origin, extra })
    if (result.ok !== true) return { ok: false, reason: result.reason }
    return { ok: true }
  }

  /**
   * 待确认 → 正式成员（越过既有 confirmPending 单事务路径，I3）。事务失败返回
   * storage-failed（I16），绝不半提交。
   * @returns {{ ok: true, key: string, record: object } | { ok: false, reason: string, key?: string }}
   */
  const approvePending = (key) => {
    if (!canConfirmPending) return { ok: false, reason: 'not-supported' }
    const parsed = parseMemberKey(key)
    if (parsed === null) return { ok: false, reason: 'invalid-key' }
    const pending = resolveMember(parsed, true)
    const result = identity.confirmPending(
      pending?.channel ?? parsed.channel,
      pending?.userId ?? parsed.userId,
      pending?.accountId ?? parsed.accountId,
    )
    if (result.ok !== true) return { ok: false, reason: result.reason, key: parsed.raw }
    return { ok: true, key: parsed.raw, record: result.record }
  }

  /** 忽略待确认身份（不转正，条目清除）。 */
  const removePending = (key) => {
    if (!canDismissPending) return { ok: false, reason: 'not-supported' }
    const parsed = parseMemberKey(key)
    if (parsed === null) return { ok: false, reason: 'invalid-key' }
    const pending = resolveMember(parsed, true)
    const result = identity.dismissPending(
      pending?.channel ?? parsed.channel,
      pending?.userId ?? parsed.userId,
      pending?.accountId ?? parsed.accountId,
    )
    if (result.ok !== true) return { ok: false, reason: result.reason, key: parsed.raw }
    return { ok: true, key: parsed.raw }
  }

  // ————————————————————————— 配对码 —————————————————————————

  /** 在铸配对码视图（pairing 已自带脱敏：只有哈希前缀 id 与状态，绝无码面）。 */
  const listPairingCodes = () => (hasPairing && isFn(pairing.listActive) ? pairing.listActive() : [])

  /**
   * 铸造配对码。码面只在本次返回值出现一次（落盘只有哈希）。
   * @returns {{ ok: true, id: string, code: string, expiresAt: number } | { ok: false, reason: string }}
   */
  const mintPairingCode = ({ origin = 'admin', mintedBy = '', ttlMs = undefined, label = '' } = {}) => {
    if (!canMintPairing) return { ok: false, reason: 'not-supported' }
    const result = pairing.mint({ origin, mintedBy, ttlMs, label })
    if (result.ok !== true) return { ok: false, reason: result.reason ?? 'storage-failed' }
    return { ok: true, id: result.id, code: result.code, expiresAt: result.expiresAt }
  }

  /** 撤销在铸配对码。 */
  const revokePairingCode = (id, { by = '' } = {}) => {
    if (!canRevokePairing) return { ok: false, reason: 'not-supported' }
    const result = pairing.revoke(id, { by })
    if (result.ok !== true) return { ok: false, reason: result.reason ?? 'not-found' }
    return { ok: true, id }
  }

  /** 核销配对码（单次；用户级锁出防护由 pairing 保证）。 */
  const redeemPairingCode = (code, who = {}) => {
    if (!hasPairing || !isFn(pairing.redeem)) return { ok: false, reason: 'not-supported' }
    return pairing.redeem(code, who)
  }

  return {
    // capability predicates — adapter keeps its exact pre-existing 501 conditions.
    hasIdentity,
    hasPairing,
    canUpdateMember,
    canRemoveMember,
    canConfirmPending,
    canDismissPending,
    canMintPairing,
    canRevokePairing,
    // members
    listMembers,
    addMember,
    updateMember,
    removeMember,
    // pending identities
    listPending,
    addPending,
    approvePending,
    removePending,
    // pairing
    listPairingCodes,
    mintPairingCode,
    revokePairingCode,
    redeemPairingCode,
  }
}