// dsh-notifier v0.14（S10）— 只读 canonical diagnostics snapshot。
//
// Diagnostics 不是 authority，也绝不自动修复：本模块只做观察与降级，
// 不写任何 store/配置，也不改变运行时状态。
//
// 真相规则（任务书 S10）：
//   - unknown != failed：读取失败/宿主缺服务 → unknown，绝不谎报 degraded/corrupt；
//   - 没有 provider evidence != healthy：无证据的渠道只能是 ready，不能算 healthy；
//   - 快照永不携带 token/secret/webhook 全文/Authorization/principal 原值/内部堆栈。

import { redactDiagnosticValue } from '../security/diagnostic.mjs'
import { healthView } from './health.mjs'

const MAX_FAILURES = 10

/** 任何注入读取都不得让快照抛错：抛错/缺失一律降级为 fallback。 */
function safeCall(source, fallback) {
  try {
    const value = typeof source === 'function' ? source() : source
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** 只保留有界、非敏感的字符串（渠道类型是固定枚举，可用于摘要）。 */
function safeText(value, max = 80) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 存储状态：只输出状态枚举与迁移摘要，绝不回显路径或原始内容。
 * readFailed/corrupt/status 三种输入形态都归一；未知形态按 unknown（不是 failed）。
 */
export function storageSnapshot(raw) {
  const status = raw !== null && typeof raw === 'object' ? raw : {}
  const readFailed = status.readFailed === true
  const corrupt = status.corrupt === true
  const labelled = typeof status.status === 'string' ? status.status : null
  // 显式给出 readFailed/corrupt 的旧形状 = 已表态的可信状态；完全无信息才回落 unknown。
  const explicitTrust = Object.prototype.hasOwnProperty.call(status, 'readFailed')
    || Object.prototype.hasOwnProperty.call(status, 'corrupt')
  const state = corrupt
    ? 'corrupt'
    : readFailed
      ? 'unavailable'
      : labelled === 'ready'
        ? 'ready'
        : labelled === 'corrupt' || labelled === 'unavailable'
          ? labelled
          : explicitTrust
            ? 'ready'
            : 'unknown'
  const migration = status.migration !== null && typeof status.migration === 'object' ? status.migration : null
  return {
    state,
    readFailed,
    corrupt,
    writable: state === 'ready',
    ...(migration ? {
      migration: {
        status: safeText(migration.status, 40) || 'unknown',
        migratedCount: Number.isFinite(Number(migration.migratedCount)) ? Number(migration.migratedCount) : 0,
        backupCreated: migration.backupCreated === true,
        ...(migration.reason ? { reason: { en: safeText(migration.reason), zh: safeText(migration.reason) } } : {}),
      },
    } : {}),
  }
}

/**
 * 渠道 desired/applied/observed 摘要：从渠道投影行聚合为计数与类型列表。
 * 只输出渠道类型（固定枚举）与状态计数，绝不带 fields/editableValues 等原始配置值。
 * 无健康证据的已配置渠道计入 noEvidence（ready），不计入 healthy —— 没有证据 != 健康。
 */
export function summarizeChannels(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []
  const summary = {
    total: list.length,
    notifyConfigured: 0,
    notifyActive: 0,
    controlConfigured: 0,
    controlActive: 0,
    healthy: 0,
    ready: 0,
    degraded: 0,
    noEvidence: 0,
    unconfigured: 0,
    inactive: [],
    degradedTypes: [],
    restartPending: [],
    diverged: [],
    noEvidenceTypes: [],
    latestEvidence: 'none',
  }
  const restartPending = new Set()
  const diverged = new Set()
  for (const row of list) {
    const type = safeText(row.type, 40)
    const notify = row.notify !== null && typeof row.notify === 'object' ? row.notify : {}
    const control = row.control !== null && typeof row.control === 'object' ? row.control : {}
    const state = safeText(row.health?.state, 20) || 'unknown'
    if (notify.configured === true) {
      summary.notifyConfigured += 1
      if (notify.active === true) summary.notifyActive += 1
      else if (type) summary.inactive.push(type)
      // v0.14（Stage C）：出站 divergence 与入站 restartPending 同构，必须都进重启待办。
      if (notify.restartPending === true && type) restartPending.add(type)
      if (notify.diverged === true && type) diverged.add(type)
    }
    if (control.configured === true) {
      summary.controlConfigured += 1
      if (control.active === true) summary.controlActive += 1
      if (control.restartPending === true && type) restartPending.add(type)
    }
    if (state === 'healthy') summary.healthy += 1
    else if (state === 'degraded') {
      summary.degraded += 1
      if (type) summary.degradedTypes.push(type)
    } else if (state === 'ready') {
      // 已配置但尚无 provider 证据：既非 healthy 也非 failed。
      summary.noEvidence += 1
      if (type) summary.noEvidenceTypes.push(type)
    } else if (state === 'unconfigured') summary.unconfigured += 1
    const evidence = row.health ?? {}
    if ((evidence.delivered ?? 0) > 0) summary.latestEvidence = 'confirmed'
    else if (summary.latestEvidence !== 'confirmed' && (evidence.accepted ?? 0) > 0) summary.latestEvidence = 'accepted'
  }
  summary.restartPending = [...restartPending]
  summary.diverged = [...diverged]
  return summary
}

/** 能力摘要：只回答可用性与计数，缺失/抛错一律 unavailable/unknown，绝不谎报可用。 */
export function capabilitiesSnapshot({ questions, sessions, bindings, members } = {}) {
  const pending = safeCall(questions?.list, null)
  const sessionRows = safeCall(sessions?.list, null)
  return {
    questions: {
      available: typeof questions?.list === 'function',
      ...(Array.isArray(pending) ? { pending: pending.length } : {}),
    },
    sessions: {
      available: typeof sessions?.list === 'function',
      ...(Array.isArray(sessionRows) ? { count: sessionRows.length } : {}),
    },
    bindings: {
      available: typeof bindings?.get === 'function',
      editable: bindings?.canEdit === true,
    },
    members: {
      available: typeof members?.list === 'function',
      removable: members?.canRemove === true,
    },
  }
}

/** 最近失败：只取活动流里 level=error 的有界条目，且已由活动层脱敏。 */
export function recentFailures(items) {
  const list = Array.isArray(items) ? items : []
  const out = []
  for (const row of list) {
    if (out.length >= MAX_FAILURES) break
    if (row?.level !== 'error') continue
    out.push(redactDiagnosticValue({
      at: safeText(row.at, 40),
      category: safeText(row.category, 20) || 'system',
      action: safeText(row.action, 64) || 'unknown',
      ...(row.detail ? { detail: { en: safeText(row.detail.en, 240), zh: safeText(row.detail.zh, 240) } } : {}),
    }))
  }
  return out
}

/**
 * 组合只读诊断快照（纯函数，除注入读取外无副作用）。
 * 任一项读取抛错都只降级该项，绝不让整个快照失败。
 */
export function buildDiagnosticsSnapshot(deps = {}) {
  const { version, revision, hostCapabilities, storage, channels, questions, sessions, bindings, members, activity, now = Date.now } = deps
  const current = safeCall(revision?.current, { epoch: 'unknown', revision: 0, at: null })
  const storageView = storageSnapshot(safeCall(storage, {}))
  const channelSummary = summarizeChannels(safeCall(channels?.list, []))
  const capabilities = capabilitiesSnapshot({ questions, sessions, bindings, members })
  const activityRows = safeCall(() => activity?.list?.({ limit: 50 }), [])
  const failures = recentFailures(activityRows)
  const host = safeCall(hostCapabilities, null)
  const hostView = host !== null && typeof host === 'object'
    ? redactDiagnosticValue({
      version: safeText(host.host?.version, 40) || 'unknown',
      eventsMode: safeText(host.events?.mode, 24) || 'unknown',
      questionsMode: safeText(host.questions?.mode, 24) || 'unknown',
      mediaImageInput: safeText(host.media?.imageInput, 24) || 'unknown',
    })
    : { version: 'unknown', eventsMode: 'unknown', questionsMode: 'unknown', mediaImageInput: 'unknown' }

  const reasons = []
  if (storageView.state === 'corrupt' || storageView.state === 'unavailable') {
    reasons.push({ code: 'storage-untrusted', detail: { en: 'Persistent state is not writable', zh: '持久化状态不可写' } })
  }
  if (channelSummary.degraded > 0) {
    reasons.push({ code: 'channel-degraded', detail: { en: `${channelSummary.degraded} channel(s) recently failed`, zh: `${channelSummary.degraded} 个渠道最近失败` } })
  }
  if (channelSummary.inactive.length > 0) {
    reasons.push({ code: 'channel-inactive', detail: { en: `${channelSummary.inactive.length} configured channel(s) inactive`, zh: `${channelSummary.inactive.length} 个已配置渠道未激活` } })
  }
  if (channelSummary.restartPending.length > 0) {
    reasons.push({ code: 'restart-pending', detail: { en: `${channelSummary.restartPending.length} change(s) need a restart`, zh: `${channelSummary.restartPending.length} 项变更需重启生效` } })
  }
  if (Number.isFinite(capabilities.questions.pending) && capabilities.questions.pending > 0) {
    reasons.push({ code: 'questions-pending', detail: { en: `${capabilities.questions.pending} question(s) pending`, zh: `${capabilities.questions.pending} 个问题待处理` } })
  }

  return redactDiagnosticValue({
    generatedAt: new Date(safeCall(now, Date.now())).toISOString(),
    version: safeText(version, 40) || 'unknown',
    process: {
      epoch: safeText(current?.epoch, 64) || 'unknown',
      revision: Number.isFinite(Number(current?.revision)) ? Number(current.revision) : 0,
    },
    host: hostView,
    storage: storageView,
    channels: channelSummary,
    capabilities,
    recentFailures: failures,
    attention: {
      required: reasons.length > 0,
      reasons,
    },
  })
}

/**
 * 只读诊断服务：`snapshot()` 返回一次 canonical 快照。
 * 不持有 authority，不自动修复，永远只读。
 */
export function createDiagnosticsService(deps = {}) {
  return {
    snapshot: () => buildDiagnosticsSnapshot(deps),
  }
}
