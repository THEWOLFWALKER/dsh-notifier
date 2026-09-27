// dsh-notifier control-surface/members.mjs
// v0.14（S06/S07）：Native `members.*` / `pairing.*` 的 RPC 投影适配器。
//
// 本层只做「传输形态映射」：把共享 `MembersControlService` 的脱敏成员 / 待确认 / 配对码视图
// 映射成 Native RPC 契约形状，把服务的 reason 映射成 RPC 错误码。读取 / 校验 / 末位 owner 守卫
// / pending→member 单事务提升 / 配对码生命周期本身都在共享服务与 identity/pairing 权威里
// （S02），本层不再自行触达它们（消除与 Admin 的重复投影 / 编排入口，I9）。
//
// S06 覆盖成员绑定（list/update/remove）；S07 覆盖待确认身份与配对码（pending/approve/dismiss、
// pairing list/mint/revoke）。

/** 服务 reason → RPC 公开错误码（与 admin adapter 的 422/404/501 语义对齐）。 */
function reasonCode(reason) {
  switch (reason) {
    case 'not-supported': return 'not-supported'
    case 'invalid-key': return 'bad-request'
    case 'not-found': return 'not-found'
    case 'owner-last': return 'conflict'
    case 'already-bound': return 'conflict'
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
  const canApprove = canList && service.canConfirmPending === true
  const canDismiss = canList && service.canDismissPending === true
  const canMint = service !== null && service !== undefined && service.canMintPairing === true
  const canRevoke = service !== null && service !== undefined && service.canRevokePairing === true

  return {
    canList,
    canUpdate,
    canRemove,
    canApprove,
    canDismiss,
    canMint,
    canRevoke,

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

    /** 待确认身份视图；读取失败按空表降级（查询可本地降级，I16）。 */
    listPending() {
      if (!canList) return []
      try {
        const rows = service.listPending()
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },

    /** 待确认 → 正式成员（复用 identity 单事务提升，I3）。 */
    approve(payload = {}) {
      if (!canApprove) throw reasonError('not-supported', '身份绑定层未装配')
      const result = service.approvePending(String(payload?.key ?? ''))
      if (result?.ok !== true) throw reasonError(result?.reason, `待确认身份不存在：${String(payload?.key ?? '')}`)
      return { key: result.key, saved: true }
    },

    /** 忽略待确认身份（不转正，条目清除）。 */
    dismiss(payload = {}) {
      if (!canDismiss) throw reasonError('not-supported', '身份绑定层未装配')
      const result = service.removePending(String(payload?.key ?? ''))
      if (result?.ok !== true) throw reasonError(result?.reason, `待确认身份不存在：${String(payload?.key ?? '')}`)
      return { key: result.key, dismissed: true }
    },

    /** 在铸配对码视图（pairing 已自带脱敏：只有哈希前缀 id 与状态，绝无码面）。 */
    listCodes() {
      if (service === null || service === undefined || typeof service.listPairingCodes !== 'function') return []
      try {
        const rows = service.listPairingCodes()
        return Array.isArray(rows) ? rows : []
      } catch {
        return []
      }
    },

    /** 铸造配对码；码面只在本次返回值出现一次（落盘只有哈希）。 */
    mintCode(payload = {}) {
      if (!canMint) throw reasonError('not-supported', '配对层未装配')
      const label = payload?.label === undefined ? '' : String(payload.label).slice(0, 64)
      const ttlMs = payload?.ttlMs === undefined ? undefined : Number(payload.ttlMs)
      if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw reasonError('invalid-key', 'ttlMs 必须是正数')
      const result = service.mintPairingCode({ origin: 'owner', mintedBy: 'native', ttlMs, label })
      if (result?.ok !== true) throw reasonError(result?.reason, '配对码铸造失败')
      return { id: result.id, code: result.code, expiresAt: result.expiresAt }
    },

    /** 撤销在铸配对码。 */
    revokeCode(payload = {}) {
      if (!canRevoke) throw reasonError('not-supported', '配对层未装配')
      const id = String(payload?.id ?? '')
      if (id === '') throw reasonError('invalid-key', 'id 不能为空')
      const result = service.revokePairingCode(id, { by: 'native' })
      if (result?.ok !== true) throw reasonError(result?.reason, `配对码不存在：${id}`)
      return { id, revoked: true }
    },
  }
}