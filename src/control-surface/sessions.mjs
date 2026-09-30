// dsh-notifier control-surface/sessions.mjs
// v0.14（S08）：Native `sessions.*` 的 RPC 投影适配器。
//
// 本层只做「传输形态映射」：把共享 `RoutingControlService`（S03）的会话列表投影与
// 会话出站覆盖写入映射成 Native RPC 契约形状，把服务的 reason 映射成 RPC 错误码。
// 会话生命周期 / 路由覆盖 / 覆盖层归一的权威仍在 registry / agent-router / session-arbiter
// （S03），本层不自行触达它们（消除与 Admin 的重复投影 / 编排入口，I9）。
//
// S08 覆盖会话只读列表与出站覆盖（channels/quiet）；绑定整表替换与更高级的覆盖层写入
// 归 S09（Native Advanced Bindings）。

import { CHANNEL_TYPES } from '../config.mjs'
import {
  CONTROL_OVERLAY_MAX_MEMBERS,
  CONTROL_OVERLAY_MAX_STRING,
  isGlobalControlValue,
} from '../control/session-arbiter.mjs'

const OUTBOUND_SET = new Set(CHANNEL_TYPES)
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SOURCE_FIELDS = ['channel', 'accountId', 'userId', 'chatId', 'sessionId', 'policyVersion', 'expiresAt', 'revoked']
const OVERLAY_FIELDS = ['mode', 'owner', 'approvalOwnerOnly', 'approvalMembers']

/** 取「普通对象」：null / 数组 / 标量一律视为非对象。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 服务 reason → RPC 公开错误码（与 members/answers 投影口径对齐）。 */
function reasonCode(reason) {
  switch (reason) {
    case 'not-supported': return 'not-supported'
    case 'invalid-key': return 'bad-request'
    case 'invalid': return 'bad-request'
    case 'not-found': return 'not-found'
    case 'storage-failed': return 'storage-failed'
    default: return 'internal'
  }
}

function reasonError(reason, message) {
  const error = new Error(String(message ?? reason ?? '会话操作未生效'))
  error.code = reasonCode(reason)
  return error
}

/**
 * 出站覆盖 diff 的表现层形状校验（与 admin patchSession 口径一致，adapter 侧，I9）。
 * 只允许 channels（string[] ⊆ 出站全集 或 null）与 quiet（boolean 或 null）；
 * 至少出现一个键；channels 含未知出站渠道一律拒绝。
 * @returns {{ channels?: string[]|null, quiet?: boolean|null }}
 */
function normalizeOutboundDiff(diff) {
  const obj = plainObjectOf(diff)
  if (obj === null) throw reasonError('invalid-key', 'diff 必须是对象（{ channels?: string[]|null, quiet?: boolean|null }）')
  const normalized = {}
  if (Object.prototype.hasOwnProperty.call(obj, 'channels')) {
    if (obj.channels === null) {
      normalized.channels = null
    } else {
      if (!Array.isArray(obj.channels)) throw reasonError('invalid-key', 'channels 必须是字符串数组或 null')
      for (const type of obj.channels) {
        if (typeof type !== 'string' || !OUTBOUND_SET.has(type)) {
          throw reasonError('invalid-key', `channels 含未知出站渠道 "${String(type)}"`)
        }
      }
      normalized.channels = [...obj.channels]
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'quiet')) {
    if (obj.quiet === null) normalized.quiet = null
    else if (typeof obj.quiet !== 'boolean') throw reasonError('invalid-key', 'quiet 必须是布尔值或 null')
    else normalized.quiet = obj.quiet
  }
  if (Object.keys(normalized).length === 0) throw reasonError('invalid-key', '至少提供 channels 或 quiet 之一')
  return normalized
}

/**
 * 会话控制覆盖层 diff 的表现层形状校验（与 admin patchSessionControl 口径一致，adapter 侧，I9）。
 * 只允许 mode/owner/approvalOwnerOnly/approvalMembers 四个覆盖字段；任何来源字段
 * （channel/accountId/userId/chatId/sessionId/policyVersion/expiresAt/revoked）或保留键一律拒绝——
 * 授权来源只能来自会话真实来源（fail-closed），RPC 载荷绝不能铸造 channel/account/user/chat。
 * @returns {object}
 */
function normalizeControlDiff(diff) {
  const obj = plainObjectOf(diff)
  if (obj === null) throw reasonError('invalid-key', 'diff 必须是对象（{ mode?, owner?, approvalOwnerOnly?, approvalMembers? }）')
  const normalized = {}
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (key === 'mode') {
      if (value !== null && value !== 'team' && value !== 'personal') {
        throw reasonError('invalid-key', 'mode 只能是 "team" 或 "personal"（或 null 清除）')
      }
      normalized.mode = value === null ? null : value
    } else if (key === 'owner') {
      if (value === null) {
        normalized.owner = null
      } else {
        if (typeof value !== 'string' || value.trim() === '') throw reasonError('invalid-key', 'owner 必须是非空字符串或 null')
        const owner = value.trim()
        if (owner.length > CONTROL_OVERLAY_MAX_STRING) throw reasonError('invalid-key', `owner 超过 ${CONTROL_OVERLAY_MAX_STRING} 字符上限`)
        if (isGlobalControlValue(owner)) throw reasonError('invalid-key', 'owner 不可为通配/全局占位')
        normalized.owner = owner
      }
    } else if (key === 'approvalOwnerOnly') {
      if (value !== null && typeof value !== 'boolean') throw reasonError('invalid-key', 'approvalOwnerOnly 必须是布尔值或 null')
      normalized.approvalOwnerOnly = value === null ? null : value
    } else if (key === 'approvalMembers') {
      if (value === null) {
        normalized.approvalMembers = null
      } else {
        if (!Array.isArray(value)) throw reasonError('invalid-key', 'approvalMembers 必须是数组或 null')
        if (value.length > CONTROL_OVERLAY_MAX_MEMBERS) throw reasonError('invalid-key', `approvalMembers 超过 ${CONTROL_OVERLAY_MAX_MEMBERS} 项上限`)
        const members = []
        for (const entry of value) {
          const record = plainObjectOf(entry)
          if (record === null) throw reasonError('invalid-key', 'approvalMembers 每项必须是对象 { channel, accountId, userId }')
          for (const k of Object.keys(record)) {
            if (k !== 'channel' && k !== 'accountId' && k !== 'userId') {
              throw reasonError('invalid-key', `approvalMembers 每项只允许 channel/accountId/userId，收到 "${k}"`)
            }
          }
          const triple = {}
          for (const k of ['channel', 'accountId', 'userId']) {
            const v = typeof record[k] === 'string' ? record[k].trim() : ''
            if (v === '') throw reasonError('invalid-key', `approvalMembers 每项的 "${k}" 必须是非空字符串`)
            if (v.length > CONTROL_OVERLAY_MAX_STRING) throw reasonError('invalid-key', `approvalMembers 每项 "${k}" 超过 ${CONTROL_OVERLAY_MAX_STRING} 字符上限`)
            if (isGlobalControlValue(v)) throw reasonError('invalid-key', `approvalMembers 每项 "${k}" 不可为通配/全局占位`)
            triple[k] = v
          }
          members.push(triple)
        }
        normalized.approvalMembers = members
      }
    } else if (DANGEROUS_KEYS.has(key)) {
      throw reasonError('invalid-key', `保留键 "${key}" 不可写入`)
    } else if (SOURCE_FIELDS.includes(key)) {
      throw reasonError('invalid-key', `"${key}" 是会话来源字段，不可经控制面设置——授权来源只能来自会话真实来源（fail-closed）`)
    } else {
      throw reasonError('invalid-key', `未知字段 "${key}"（可用：${OVERLAY_FIELDS.join('/')}）`)
    }
  }
  if (Object.keys(normalized).length === 0) throw reasonError('invalid-key', '至少提供 mode/owner/approvalOwnerOnly/approvalMembers 之一')
  return normalized
}

/**
 * 从共享路由控制服务构造 Native RPC 投影。
 * @param {object} [deps]
 * @param {ReturnType<typeof import('../control-plane/sessions.mjs').createRoutingControlService>} [deps.service]
 *   - 共享路由控制服务（Native / Admin 共用同一实例）；缺失时按空表 / 不可用降级
 * @param {() => string[]} [deps.enabledTypes] - 已启用出站渠道类型（实时解析用）
 */
export function createSessionsProjection({ service = null, enabledTypes = () => [] } = {}) {
  const canList = service !== null && service !== undefined && typeof service.sessionsView === 'function'
  const canPatch = canList
    && typeof service.hasSession === 'function'
    && typeof service.patchSessionOutbound === 'function'
  // v0.14（Stage E / P1-10）：Session Detail 读取走共享服务单行投影；控制写入
  // 经 router.setSessionControl（内部 session-arbiter 归一），本层只做形状校验与 RPC 映射。
  const canDetail = canList && typeof service.sessionView === 'function'
  const canControl = canList
    && typeof service.hasSession === 'function'
    && typeof service.patchSessionControl === 'function'

  const safeEnabled = () => {
    try {
      const list = typeof enabledTypes === 'function' ? enabledTypes() : []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  return {
    canList,
    canPatch,
    canDetail,
    canControl,

    /** 会话列表投影；读取失败按空表降级（查询可本地降级，I16）。 */
    list() {
      if (!canList) return []
      try {
        const rows = service.sessionsView({ enabledTypes: safeEnabled() })
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },

    /** 单会话详情投影（Native Session Detail）；未建档 → not-found。 */
    detail(payload = {}) {
      if (!canDetail) throw reasonError('not-supported', '路由层未装配')
      const id = String(payload?.id ?? '')
      if (id.trim() === '') throw reasonError('invalid-key', '会话 id 必须是非空字符串')
      let row = null
      try {
        row = service.sessionView(id, { enabledTypes: safeEnabled() })
      } catch {
        row = null
      }
      if (plainObjectOf(row) === null) throw reasonError('not-found', `会话 "${id}" 不存在`)
      return { session: row }
    },

    /** 编辑会话出站覆盖（字段级 diff，经共享服务再读合并落盘）。 */
    patch(payload = {}) {
      if (!canPatch) throw reasonError('not-supported', '路由层未装配')
      const id = String(payload?.id ?? '')
      if (id.trim() === '') throw reasonError('invalid-key', '会话 id 必须是非空字符串')
      const diff = normalizeOutboundDiff(payload?.diff)
      if (service.hasSession(id) !== true) throw reasonError('not-found', `会话 "${id}" 不存在`)
      const result = service.patchSessionOutbound(id, diff)
      if (result?.ok !== true) throw reasonError(result?.reason, '会话覆盖写入存储失败')
      return { id, outbound: result.outbound }
    },

    /** 写会话控制覆盖层（经共享服务再读合并 + session-arbiter 归一落盘）；返回脱敏摘要。 */
    patchControl(payload = {}) {
      if (!canControl) throw reasonError('not-supported', '会话控制层未装配')
      const id = String(payload?.id ?? '')
      if (id.trim() === '') throw reasonError('invalid-key', '会话 id 必须是非空字符串')
      const diff = normalizeControlDiff(payload?.diff)
      if (service.hasSession(id) !== true) throw reasonError('not-found', `会话 "${id}" 不存在`)
      const result = service.patchSessionControl(id, diff)
      if (result?.ok !== true) throw reasonError(result?.reason, '会话控制覆盖写入存储失败')
      return { id, control: result.control }
    },
  }
}