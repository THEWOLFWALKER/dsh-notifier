// dsh-notifier v0.15 Stage 1 — Native 写动作（窄动作表）。
//
// 职责（03_ARCHITECTURE_REWRITE_PLAN）：
//  - 每个动作**只调用一个现有业务 authority**（ChannelControlService / 提问控制服务 /
//    成员控制服务）；
//  - 不自己写 store、不做补偿写、不建第二 authority；
//  - 只做「用户动作 → authority 入参」的形态映射与记账归属。
//
// 记账归属（与既有 control-surface/service.mjs 逐条一致，绝不双记）：
//  - 出站保存/删除：revision 与 activity 的唯一 owner 是 OutboundConfigService 的 domain
//    event（装配层已接线）——本层**不**再 touch/record，否则同一动作会唤醒 wait loop 两次；
//  - 入站保存/删除、测试、提问结算、成员与配对：没有 domain event，由本层记一次。
//
// 写动作不返回任何凭据：测试回执只给用户话术（channel-view.testReceipt）。

import { inboundApplyMode, isHotApplied } from '../control-surface/apply-mode.mjs'
import { redactDiagnosticValue } from '../security/diagnostic.mjs'
import { receiptKind, testReceipt } from './channel-view.mjs'

const SECRET_MODES = new Set(['keep', 'replace', 'clear'])

const badRequest = (message) => Object.assign(new Error(message), { code: 'bad-request' })
const notSupported = (message) => Object.assign(new Error(message), { code: 'not-supported' })

/**
 * 三态密钥补丁：keep（不动）/ replace(value)（覆盖）/ clear（清除）。
 *
 * 这是用户动作的唯一合法词汇——没有第四种隐式语义（空串既不是 keep 也不是 clear）。
 * @param {Record<string, {mode: string, value?: unknown}>} intents
 * @returns {{ patch: object, clearSecrets: string[] }}
 */
export function secretPatch(intents = {}) {
  const patch = {}
  const clearSecrets = []
  for (const [key, intent] of Object.entries(intents ?? {})) {
    const mode = String(intent?.mode ?? '')
    if (!SECRET_MODES.has(mode)) {
      throw badRequest(`密钥字段 "${key}" 的动作只能是保留、替换或清除`)
    }
    if (mode === 'keep') continue
    if (mode === 'clear') { clearSecrets.push(key); continue }
    const value = intent?.value
    if (typeof value !== 'string' || value.trim() === '') {
      // 想清空请用 clear：空串不是「替换」，否则用户意图不可判定。
      throw badRequest(`密钥字段 "${key}" 替换时必须填写新值（想清空请选择清除）`)
    }
    patch[key] = value
  }
  return { patch, clearSecrets }
}

/** provider 原始测试结果 → 用户可读原因（已脱敏；无原因返回 null）。 */
function receiptReason(result) {
  const detail = result?.detail ?? null
  if (detail === null || detail === undefined) return null
  if (typeof detail === 'string') return detail === '' ? null : { en: detail, zh: detail }
  if (typeof detail === 'object') {
    const zh = String(detail.zh ?? detail.en ?? '')
    if (zh === '') return null
    return { en: String(detail.en ?? zh), zh }
  }
  return null
}

function requireFn(target, name, message) {
  if (target === null || target === undefined || typeof target[name] !== 'function') {
    throw notSupported(message)
  }
}

/**
 * @param {object} deps
 * @param {object} deps.channelControl - createChannelControlService() 实例（通道写入编排）
 * @param {object} [deps.health] - createSurfaceHealth() 实例（测试证据记账）
 * @param {object} [deps.revision] - 控制面 revision（无 domain event 的动作在此记账）
 * @param {object} [deps.activity] - 控制面 activity
 * @param {object} [deps.questions] - 提问投影（settle 为唯一结算入口）
 * @param {object} [deps.members] - 成员投影（成员/配对唯一编排入口）
 * @param {(id: string) => string|null} [deps.resolveUserId] - 不透明 id → 真实成员键
 *   （默认取 `members.memberKeyOf`；装配层注入 private-chat-view 的解析器）
 */
export function createNativeActions({
  channelControl = null,
  health = null,
  revision = null,
  activity = null,
  questions = null,
  members = null,
  resolveUserId = null,
  currentTask = null,
  tasks = null,
} = {}) {
  const touch = (topic) => { try { revision?.touch?.(topic) } catch { /* 记账失败不改业务结果 */ } }
  const record = (category, action, detail) => {
    try { activity?.record?.(category, action, detail) } catch { /* 同上 */ }
  }
  const resolveUser = makeUserResolver(members, resolveUserId)

  return {
    selectTask({ taskRef } = {}) {
      requireFn(currentTask, 'select', '当前任务暂时无法保存')
      const owners = (members?.list?.() ?? []).filter(row => row.role === 'owner')
      if (owners.length !== 1) throw badRequest('请先确认使用者')
      if (!(tasks?.list?.() ?? []).some(row => row.taskRef === taskRef)) throw badRequest('任务已结束，请重新选择')
      const result = currentTask.select(owners[0], taskRef)
      if (!result.ok) throw Object.assign(new Error('当前任务未保存，请重试'), { code: result.reason })
      touch('tasks')
      return { saved: true }
    },
    /** 保存通知渠道（出站）。revision/activity 由 OutboundConfigService domain event 记账。 */
    saveChannel({ type, patch, clearSecrets = [] } = {}) {
      requireFn(channelControl, 'saveOutbound', '通知渠道保存当前不可用')
      const input = clearSecrets.length > 0
        ? { ...(patch ?? {}), clearSecrets: [...clearSecrets] }
        : (patch ?? {})
      const result = channelControl.saveOutbound(String(type ?? ''), input)
      return { saved: result?.saved === true, needsRestart: result?.applied === false }
    },

    /** 保存私聊控制渠道（入站）。无 domain event → 本层记一次。 */
    async saveInboundChannel({ type, patch, clearSecrets = [] } = {}) {
      requireFn(channelControl, 'saveInbound', '私聊渠道保存当前不可用')
      const input = clearSecrets.length > 0
        ? { ...(patch ?? {}), clearSecrets: [...clearSecrets] }
        : (patch ?? {})
      const saved = await channelControl.saveInbound(String(type ?? ''), input)
      const hot = isHotApplied('inbound')
      touch('channels')
      record('configuration', 'channel-saved', {
        channel: String(type ?? ''), direction: 'inbound', saved: saved?.saved === true, hotApplied: hot,
      })
      return { saved: saved?.saved === true, needsRestart: !hot, applyMode: inboundApplyMode() }
    },

    /** 删除渠道（出站默认保留回退；revoke 同时清掉可删的旧覆盖源）。 */
    removeChannel({ type, direction = 'outbound', revoke = false } = {}) {
      const key = String(type ?? '')
      if (direction === 'inbound') {
        requireFn(channelControl, 'removeInbound', '私聊渠道删除当前不可用')
        const result = channelControl.removeInbound(key)
        touch('channels')
        record('configuration', 'channel-removed', { channel: key, direction: 'inbound', deleted: result?.deleted === true })
        return { removed: result?.deleted === true }
      }
      requireFn(channelControl, 'removeOutbound', '通知渠道删除当前不可用')
      const result = channelControl.removeOutbound(key, revoke === true ? { mode: 'revoke' } : {})
      return { removed: result?.deleted === true, needsRestart: result?.applied === false }
    },

    /**
     * 发一条测试消息。返回用户话术回执（TestReceipt）——`accepted` 绝不冒充 `confirmed`。
     * @returns {Promise<{kind: string, title: string, message: string}>}
     */
    async testChannel({ type, lang = 'zh' } = {}) {
      requireFn(channelControl, 'testOutbound', '测试消息当前不可用')
      const key = String(type ?? '')
      const raw = channelControl.rawOutbound(key) ?? {}
      const safe = redactDiagnosticValue(await channelControl.testOutbound(key), raw)
      try { health?.recordTest?.(key, safe) } catch { /* 证据记账失败不改测试结果 */ }
      touch('health')
      const kind = receiptKind(safe)
      const receipt = testReceipt(safe, {
        lang,
        reason: kind === 'failed' || kind === 'unknown' ? receiptReason(safe) : null,
      })
      record('notification', `channel-test-${kind === 'failed' ? 'failed' : 'ok'}`, {
        channel: key,
        status: kind === 'failed' ? 'failed' : 'ok',
      })
      return receipt
    },

    /** 结算一条待处理提问（首达胜出；已被手机端处理则返回 alreadyHandled）。 */
    settlePending({ ref, action, options = [] } = {}) {
      requireFn(questions, 'settle', '待处理项当前不可用')
      const value = questions.settle({ ref, action, options })
      touch('questions')
      record('control', 'question-settled', { action: String(action ?? 'unknown'), status: 'ok' })
      return { settled: value?.settled === true, alreadyHandled: value?.alreadyHandled === true }
    },

    /** 改使用者的名字或权限（末位管理者不可降级——守卫在 authority 内）。 */
    updateUser({ id, label, role } = {}) {
      requireFn(members, 'update', '使用者管理当前不可用')
      const key = toMemberKey(resolveUser, id)
      const diff = {}
      if (label !== undefined) diff.label = label
      if (role !== undefined) diff.role = role
      members.update({ key, ...diff })
      touch('members')
      record('control', 'member-updated', { channel: key.split(':')[0], status: 'ok' })
      return { saved: true }
    },

    /** 移除使用者（末位管理者不可移除）。 */
    removeUser({ id } = {}) {
      requireFn(members, 'remove', '使用者管理当前不可用')
      const key = toMemberKey(resolveUser, id)
      members.remove({ key })
      touch('members')
      record('control', 'member-removed', { channel: key.split(':')[0], status: 'ok' })
      return { removed: true }
    },

    /** 确认本人：待确认身份 → 正式使用者。 */
    approveUser({ id } = {}) {
      requireFn(members, 'approve', '待确认身份当前不可用')
      const key = toMemberKey(resolveUser, id)
      members.approve({ key })
      touch('members')
      record('control', 'pending-approved', { status: 'ok' })
      return { approved: true }
    },

    /** 忽略一条待确认身份（不转正）。 */
    dismissUser({ id } = {}) {
      requireFn(members, 'dismiss', '待确认身份当前不可用')
      const key = toMemberKey(resolveUser, id)
      members.dismiss({ key })
      touch('members')
      record('control', 'pending-dismissed', { status: 'ok' })
      return { dismissed: true }
    },

    /** 生成一次性确认码（码面只在本次返回出现，落盘只有哈希）。 */
    mintPairing({ label = '' } = {}) {
      requireFn(members, 'mintCode', '确认码当前不可用')
      const value = members.mintCode({ label })
      touch('members')
      record('control', 'pairing-minted', { source: 'native', status: 'ok' })
      return { id: value?.id, code: value?.code, expiresAt: value?.expiresAt }
    },

    /** 撤销未使用的确认码。 */
    revokePairing({ id } = {}) {
      requireFn(members, 'revokeCode', '确认码当前不可用')
      members.revokeCode({ id })
      touch('members')
      record('control', 'pairing-revoked', { source: 'native', status: 'ok' })
      return { revoked: true }
    },
  }
}

/**
 * 用户动作给的是**不透明 id**（read-model/private-chat-view 产出），不是内部成员键。
 * 本层把不透明 id 解析回成员键——内部键形状永不进入浏览器。
 */
function makeUserResolver(members, resolveUserId) {
  if (typeof resolveUserId === 'function') return resolveUserId
  if (typeof members?.memberKeyOf === 'function') return members.memberKeyOf
  return () => null
}

function toMemberKey(resolve, id) {
  const key = resolve(id)
  if (key === null || key === undefined || String(key) === '') {
    throw badRequest('这条记录已不在，请刷新后重试')
  }
  return String(key)
}
