// Provider-neutral control ingress.
// Adapters hand this module a small callback envelope; this module is the only
// runtime path that may turn it into a control settlement:
// canonicalize -> normalize -> paired/source/policy check -> settle.

import { normalizeControlEvent, makeReceipt } from './contract.mjs'
import { createSessionArbiter, normalizeControlOverlay, normalizeSessionPolicy } from './session-arbiter.mjs'

const text = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : null
const COMMANDS = new Set(['stop', 'question-answer', 'approval', 'steer', 'ordinary-message'])
const DEFAULT_TTL_MS = 10 * 60 * 1000
const OVERLAY_KEYS = new Set(['mode', 'owner', 'approvalOwnerOnly', 'approvalMembers'])

/**
 * A resolver is a read-side boundary, so unlike the persistence writers it must
 * reject rather than silently clean a malformed value.  A bad/unknown overlay
 * therefore falls back to the immutable base policy; it can never manufacture
 * a source binding or widen authorization.  `normalizeControlOverlay` remains
 * the canonical shape/bounds implementation, while this wrapper verifies that
 * the resolver really returned an already-normalized four-field overlay.
 */
function resolverOverlay(value) {
  if (value === undefined || value === null) return { ok: true, overlay: null }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'malformed' }
  if (typeof value.then === 'function') return { ok: false, reason: 'async_not_supported' }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'non_plain_object' }
  const keys = Object.keys(value)
  if (keys.some((key) => !OVERLAY_KEYS.has(key))) return { ok: false, reason: 'unknown_field' }
  const normalized = normalizeControlOverlay(value)
  try {
    // Resolver output is intentionally strict.  Values that the persistence
    // normalizer would trim/drop are not accepted as a new policy snapshot.
    if (Object.prototype.hasOwnProperty.call(value, 'mode')
      && value.mode !== 'team' && value.mode !== 'personal') return { ok: false, reason: 'invalid_mode' }
    if (Object.prototype.hasOwnProperty.call(value, 'owner')) {
      if (typeof value.owner !== 'string' || value.owner.trim() !== value.owner || normalized?.owner !== value.owner) {
        return { ok: false, reason: 'invalid_owner' }
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, 'approvalOwnerOnly') && typeof value.approvalOwnerOnly !== 'boolean') {
      return { ok: false, reason: 'invalid_approvalOwnerOnly' }
    }
    if (Object.prototype.hasOwnProperty.call(value, 'approvalMembers')) {
      if (!Array.isArray(value.approvalMembers)) return { ok: false, reason: 'invalid_approvalMembers' }
      const members = Array.isArray(normalized?.approvalMembers) ? normalized.approvalMembers : []
      if (JSON.stringify(members) !== JSON.stringify(value.approvalMembers)) return { ok: false, reason: 'unnormalized_approvalMembers' }
    }
  } catch {
    return { ok: false, reason: 'inspection_failed' }
  }
  return { ok: true, overlay: normalized }
}

function eventIdOf(input, command, key, now) {
  const explicit = text(input.eventId)
  if (explicit !== null) return explicit
  return [command, key, input.channel, input.userId, input.chatId, now].map((part) => String(part ?? '')).join(':')
}

function pendingMeta(input, pending, policy, now) {
  const row = pending !== null && typeof pending === 'object' ? pending : {}
  const meta = row.control ?? row.controlMeta ?? {}
  const command = input.command
  const key = text(input.key) ?? text(input.actionKey) ?? text(input.qKey) ?? text(input.approvalKey) ?? 'control'
  const createdAt = Number.isFinite(Number(meta.createdAt)) ? Number(meta.createdAt)
    : (Number.isFinite(Number(row.createdAt)) ? Number(row.createdAt) : now - 1)
  const expiresAt = Number.isFinite(Number(meta.expiresAt)) ? Number(meta.expiresAt)
    : (Number.isFinite(Number(row.expiresAt)) ? Number(row.expiresAt) : createdAt + DEFAULT_TTL_MS)
  const channel = text(input.channel) ?? text(meta.channel) ?? 'unknown'
  const chatId = text(input.chatId) ?? text(meta.chatId)
  const userId = text(input.userId) ?? text(meta.userId)
  const sessionId = text(input.sessionId) ?? text(meta.sessionId) ?? text(row.sessionId) ?? text(row.agentId) ?? key
  // v0.8.7：accountId 绝不回退到 channel 名（硬性规则「不允许把 channel 当 accountId」）。
  // 事件/待决行都没声明真实账号时令其缺失，由 normalizeControlEvent 以 missing_accountId
  // fail-closed 拒绝——适配器/装配必须提供本地配置派生或来源证明的账号标识（如 telegram/
  // feishu/qq/wechat/dingtalk/wxpusher 的 resolved accountId）。
  const accountId = text(input.accountId) ?? text(meta.accountId) ?? text(row.accountId)
  const policyVersion = text(input.policyVersion) ?? text(meta.policyVersion) ?? text(row.policyVersion) ?? text(policy.policyVersion) ?? '1'
  return {
    eventId: eventIdOf(input, command, key, now),
    sessionId,
    source: text(input.source) ?? 'mobile',
    channel,
    accountId,
    userId,
    chatId,
    policyVersion,
    command,
    chatType: text(input.chatType) ?? text(meta.chatType) ?? text(row.chatType) ?? undefined,
    createdAt,
    expiresAt,
  }
}

function paired(identity, event) {
  if (identity === null || identity === undefined) return true
  try {
    return identity.list(event.channel).some((entry) => String(entry.userId) === String(event.userId))
  } catch {
    return false
  }
}

/**
 * Create the single control ingress used by all interactive paths.
 * `register()` is deliberately small so legacy routers can retain their
 * existing ledgers and handlers while routing the final decision through here.
 */
export function createControlEntry({ policy = {}, identity = null, now = Date.now, logger = null, onAudit = null, policyForSession = null, sessionPolicy = null } = {}) {
  const basePolicy = normalizeSessionPolicy(policy, now())
  // `sessionPolicy` is the descriptive alias retained for callers that already
  // use that term.  Two different resolvers are ambiguous and are disabled;
  // static policy remains the safe fallback instead of choosing one silently.
  const resolver = typeof policyForSession === 'function' && (sessionPolicy === null || sessionPolicy === policyForSession)
    ? policyForSession
    : (typeof sessionPolicy === 'function' && (policyForSession === null || policyForSession === sessionPolicy) ? sessionPolicy : null)
  const handlers = new Map()
  const handled = new Set()
  let disposed = false
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/control]', message) } catch { /* diagnostics never alter control flow */ }
  }
  const audit = (entry) => {
    try { onAudit?.(entry) } catch { /* audit is strictly out of band */ }
  }

  const register = (command, spec) => {
    if (!COMMANDS.has(command) || spec === null || typeof spec !== 'object') return false
    if (typeof spec.getPending !== 'function' || typeof spec.settle !== 'function') return false
    handlers.set(command, spec)
    return true
  }

  const handle = (input = {}) => {
    if (disposed) return makeReceipt('desktop_fallback', input, 'disposed')
    const command = text(input.command)
    if (!COMMANDS.has(command)) return makeReceipt('rejected', input, 'unknown_command')
    const spec = handlers.get(command)
    const directSettle = typeof input.settle === 'function' ? input.settle : null
    const directPending = input.pending
    let pending = directPending
    try {
      if (pending === undefined) pending = spec?.getPending(input)
    } catch (error) {
      audit({ status: 'lookup_failed', command, error })
      return makeReceipt('desktop_fallback', input, 'lookup_failed')
    }
    if (pending === null || pending === undefined || typeof pending !== 'object') {
      return makeReceipt('rejected', input, 'not_pending')
    }
    let candidate
    try {
      candidate = typeof spec?.buildEvent === 'function'
        ? spec.buildEvent(input, pending, basePolicy, now())
        : pendingMeta(input, pending, basePolicy, now())
    } catch (error) {
      audit({ status: 'normalize_failed', command, error })
      return makeReceipt('rejected', input, 'malformed')
    }
    const normalized = normalizeControlEvent(candidate, now())
    if (!normalized.ok) return makeReceipt(normalized.reason === 'expired' ? 'expired' : 'rejected', candidate, normalized.reason)
    const event = normalized.event
    if (handled.has(event.eventId)) return makeReceipt('already_handled', event, 'duplicate_event')
    if (!paired(identity, event)) return makeReceipt('rejected', event, 'not_paired')
    try {
      // The conversation source is the original policy/pending binding, never the
      // event envelope. An adapter or attacker may rewrite channel/accountId/userId
      // on the event; trusting it here would let the event manufacture the very
      // owner source the arbiter later compares against. So authorization is bound
      // to the true source (rowMeta -> pending top-level -> basePolicy) instead:
      // the event must match whichever layer declares it, and when owner/member
      // authorization is in play the absence of a genuine conversation source fails
      // closed rather than accepting event-supplied values. Legacy non-authorizing
      // paths (action `stop`, conversation steering) that genuinely carry no source
      // metadata keep their existing adapter-envelope binding.
      const rowMeta = pending.control ?? pending.controlMeta ?? {}
      const metaSources = [pending.control, pending.controlMeta]
        .filter((meta) => meta !== null && typeof meta === 'object' && !Array.isArray(meta))
      const sourceValues = (key) => [
        text(basePolicy[key]),
        ...metaSources.map((meta) => text(meta[key])),
        text(pending[key]),
        key === 'sessionId' ? text(pending.agentId) : null,
      ].filter((value) => value !== null)
      const sourceOf = (key) => sourceValues(key)[0] ?? null
      const authorizationCommand = event.command === 'approval' || event.command === 'question-answer'
      const trueSource = {
        channel: sourceOf('channel'),
        accountId: sourceOf('accountId'),
        chatId: sourceOf('chatId'),
        sessionId: sourceOf('sessionId'),
        userId: sourceOf('userId'),
      }
      if (authorizationCommand) {
        // Authorization cannot choose one metadata layer over another. A stale or
        // tampered rowMeta/controlMeta must not override a bound base policy, and
        // duplicate metadata fields must agree before the arbiter sees the event.
        for (const key of ['channel', 'accountId', 'chatId', 'sessionId']) {
          const declared = sourceValues(key)
          if (declared.some((value) => value !== declared[0])) {
            return makeReceipt('rejected', event, `source_mismatch_${key}`)
          }
        }
        const declaredUsers = sourceValues('userId')
        if (declaredUsers.some((value) => value !== declaredUsers[0]) && input.trusted !== true) {
          return makeReceipt('rejected', event, 'source_mismatch_userId')
        }
      }
      for (const key of ['channel', 'accountId', 'chatId', 'sessionId']) {
        if (trueSource[key] !== null && trueSource[key] !== event[key]) {
          return makeReceipt('rejected', event, `source_mismatch_${key}`)
        }
      }
      if (trueSource.userId !== null && trueSource.userId !== event.userId && input.trusted !== true) {
        return makeReceipt('rejected', event, 'source_mismatch_userId')
      }
      let overlay = null
      if (resolver !== null && event.sessionId !== null) {
        try {
          const resolved = resolverOverlay(resolver(event.sessionId))
          if (!resolved.ok) {
            audit({ status: 'policy_overlay_ignored', sessionId: event.sessionId, reason: resolved.reason })
          } else {
            overlay = resolved.overlay
          }
        } catch (error) {
          audit({ status: 'policy_overlay_ignored', sessionId: event.sessionId, reason: 'resolver_failed', error })
        }
      }
      let specAuthorized = false
      if (typeof spec?.authorize === 'function') {
        specAuthorized = spec.authorize(input, pending, event) === true
        if (!specAuthorized) return makeReceipt('rejected', event, 'source_policy_rejected')
      }
      // Adapter-specific authorization (for example a pushedTo target match) is
      // itself a canonical source proof. Legacy question/approval rows often omit
      // top-level source fields, so only an authorized spec may retain the event's
      // proven source; generic/direct authorization remains fail-closed on null.
      const policySource = (key) => authorizationCommand && !specAuthorized ? sourceOf(key) : event[key]
      const mergedPolicy = normalizeSessionPolicy({
        ...basePolicy,
        ...rowMeta,
        ...(overlay ?? {}),
        capabilities: { ...basePolicy.capabilities, ...(rowMeta.capabilities ?? {}) },
        sessionId: policySource('sessionId'),
        channel: policySource('channel'),
        accountId: policySource('accountId'),
        userId: policySource('userId'),
        chatId: policySource('chatId'),
        policyVersion: event.policyVersion,
        expiresAt: Math.min(
          basePolicy.expiresAt !== null && Number.isFinite(Number(basePolicy.expiresAt)) ? Number(basePolicy.expiresAt) : Infinity,
          event.expiresAt !== null && Number.isFinite(Number(event.expiresAt)) ? Number(event.expiresAt) : Infinity,
        ),
        mode: overlay?.mode ?? rowMeta.mode ?? basePolicy.mode,
        owner: overlay?.owner ?? text(rowMeta.owner) ?? text(basePolicy.owner),
        approvalOwnerOnly: overlay?.approvalOwnerOnly ?? rowMeta.approvalOwnerOnly ?? basePolicy.approvalOwnerOnly,
        approvalMembers: overlay?.approvalMembers ?? rowMeta.approvalMembers ?? basePolicy.approvalMembers,
      }, now())
      // Owner / team-member settlement is the only authorization that derives its
      // conversation source from the policy; when that source genuinely does not
      // exist it must fail closed instead of letting the event mint it.
      const authInPlay = mergedPolicy.approvalOwnerOnly === true
        || (mergedPolicy.mode === 'team' && mergedPolicy.approvalMembers.length > 0)
      if ((event.command === 'approval' || event.command === 'question-answer')
        && authInPlay && trueSource.channel === null && trueSource.accountId === null) {
        return makeReceipt('rejected', event, 'source_mismatch_channel')
      }
      const arbiter = createSessionArbiter({
        policy: mergedPolicy,
        now,
        onAudit: (entry) => audit(entry),
        onSettle: (ev, policy) => (directSettle ?? spec?.settle)(input, pending, ev, policy),
      })
      const verdict = arbiter.handle(event)
      if (verdict.status === 'accepted') {
        handled.add(event.eventId)
        return makeReceipt('accepted', event)
      }
      if (verdict.status === 'already_handled') return makeReceipt('already_handled', event, 'duplicate_event')
      return makeReceipt(verdict.status === 'desktop_fallback' ? 'desktop_fallback' : 'rejected', event, verdict.reason)
    } catch (error) {
      warn(`control settle 异常: ${error instanceof Error ? error.message : String(error)}`)
      audit({ status: 'settlement_failed', event, error })
      return makeReceipt('desktop_fallback', event, 'settlement_failed')
    }
  }

  return {
    register,
    handle,
    dispose() { disposed = true; handlers.clear(); handled.clear() },
    commands: Object.freeze([...COMMANDS]),
  }
}

export { pendingMeta }
