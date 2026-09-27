// dsh-notifier control-surface/members.mjs
// v0.14（S06）：Native `members.*` 的 RPC 投影适配器。
//
// 本层只做「传输形态映射」：把共享 `MembersControlService` 的脱敏成员视图映射成 Native RPC
// 契约形状，把服务的 reason 映射成 RPC 错误码。读取 / 校验 / 末位 owner 守卫本身都在共享
// 服务里（S02），本层不再自行触达 identity（消除与 Admin 的重复投影 / 编排入口，I9）。
//
// S06 只覆盖成员绑定（list/update/remove）；待确认身份与配对码在 S07。

/** 服务 reason → RPC 公开错误码（与 admin adapter 的 422/404/501 语义对齐）。 */
function reasonCode(reason) {
  switch (reason) {
    case 'not-supported': return 'not-supported'
    case 'invalid-key': return 'bad-request'
    case 'not-found': return 'not-found'
    case 'owner-last': return 'conflict'
    case 'storage-failed': return 'storage-failed'
    default: return 'internal'
  }
}

function reasonError(reason, message) {
  const error = new Error(String(message ?? reason ?? '成员操作未生效'))
  error.code = reasonCode(reason)
  return error
}

/** 表现层 { label?, role? } 形状校验（与 admin putMember 口径一致）。 */
function normalizeDiff(payload = {}) {
  const diff = {}
  if (payload?.label !== undefined) {
    if (typeof payload.label !== 'string') throw reasonError('invalid-key', 'label 必须是字符串')
    diff.label = payload.label.slice(0, 64)
  }
  if (payload?.role !== undefined) {
    if (payload.role !== 'owner' && payload.role !== 'member') throw reasonError('invalid-key', 'role 只能是 owner 或 member')
    diff.role = payload.role
  }
  if (Object.keys(diff).length === 0) throw reasonError('invalid-key', '至少提供 label 或 role 之一')
  return diff
}

/**
 * 从共享成员控制服务构造 Native RPC 投影。
 * @param {object} [deps]
 * @param {ReturnType<typeof import('../control-plane/members.mjs').createMembersControlService>} [deps.service]
 *   - 共享成员控制服务（Native / Admin 共用同一实例）；缺失时按空表 / 不可用降级
 */
export function createMembersProjection({ service = null } = {}) {
  const canList = service !== null && service !== undefined && typeof service.listMembers === 'function'
  const canUpdate = canList && service.canUpdateMember === true
  const canRemove = canList && service.canRemoveMember === true

  return {
    canList,
    canUpdate,
    canRemove,

    /** 只读全量成员视图；读取失败按空表降级（查询可本地降级，I16）。 */
    list() {
      if (!canList) return []
      try {
        const rows = service.listMembers()
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },

    /** 改成员 label/role；末位 owner 降级 → conflict，键非法 → bad-request。 */
    update(payload = {}) {
      if (!canUpdate) throw reasonError('not-supported', '身份绑定层未装配')
      const diff = normalizeDiff(payload)
      const result = service.updateMember(String(payload?.key ?? ''), diff)
      if (result?.ok !== true) throw reasonError(result?.reason, result?.reason === 'owner-last'
        ? '末位 owner 不可降级（否则实例将无人可管理）'
        : `成员不存在：${String(payload?.key ?? '')}`)
      return { key: result.key, saved: true }
    },

    /** 移除成员；末位 owner 不可删。 */
    remove(payload = {}) {
      if (!canRemove) throw reasonError('not-supported', '身份绑定层未装配')
      const result = service.removeMember(String(payload?.key ?? ''))
      if (result?.ok !== true) throw reasonError(result?.reason, result?.reason === 'owner-last'
        ? '末位 owner 不可移除（否则实例将无人可管理）'
        : `成员不存在：${String(payload?.key ?? '')}`)
      return { key: result.key, deleted: true }
    },
  }
}