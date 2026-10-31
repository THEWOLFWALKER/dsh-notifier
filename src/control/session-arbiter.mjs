// Provider-neutral session policy and command precedence.
// Transport adapters provide normalized events; this module never knows their payloads.

const MODES = new Set(['personal', 'team'])
const COMMANDS = ['stop', 'question-answer', 'approval', 'steer', 'ordinary-message']
const RANK = new Map(COMMANDS.map((command, index) => [command, index]))

const text = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : null

// Bounded optional team-approval member list: never wildcard/global/empty,
// never an unbounded array, never arbitrary nested shapes.
const MAX_APPROVAL_MEMBERS = 64
/** Per-session control overlay string bound (owner / member ids): far above any real id, bounds garbage. */
const MAX_OVERLAY_STRING = 128
const GLOBAL_IDS = new Set(['*', 'all', 'everyone', 'anyone'])
const looksGlobal = (value) => value.includes('*') || GLOBAL_IDS.has(String(value).toLowerCase())

function normalizeApprovalMembers(input) {
  if (!Array.isArray(input)) return Object.freeze([])
  const seen = new Set()
  const members = []
  for (const raw of input) {
    if (members.length >= MAX_APPROVAL_MEMBERS) break
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const channel = text(raw.channel)
    const accountId = text(raw.accountId)
    const userId = text(raw.userId)
    if (channel === null || accountId === null || userId === null) continue
    if (looksGlobal(channel) || looksGlobal(accountId) || looksGlobal(userId)) continue
    const key = `${channel}\u0000${accountId}\u0000${userId}`
    if (seen.has(key)) continue
    seen.add(key)
    members.push(Object.freeze({ channel, accountId, userId }))
  }
  return Object.freeze(members)
}

/** Shared limits for the persisted per-session control overlay (admin + registry + router all import). */
export const CONTROL_OVERLAY_MAX_MEMBERS = MAX_APPROVAL_MEMBERS
export const CONTROL_OVERLAY_MAX_STRING = MAX_OVERLAY_STRING

/** Whether a string is a wildcard/global placeholder (never a usable owner/member id). */
export function isGlobalControlValue(value) {
  return looksGlobal(value)
}

/**
 * Canonical, minimal per-session control overlay. This is the SINGLE definition of what a valid
 * overlay is — the session registry, the router setter, and the admin layer all funnel through it so
 * shape/bounds/rejections never drift. It intentionally carries ONLY the four approved fields, never
 * a source binding: `channel/accountId/userId/chatId/sessionId/policyVersion/expiresAt/revoked` are
 * dropped even if supplied (an admin or a corrupted store edit must never manufacture the channel/
 * account/user a later authorization compares against). Never throws; malformed input yields a smaller
 * (or null) overlay, exactly like `normalizeApprovalMembers` drops bad members.
 *
 * @param {unknown} input - raw overlay candidate (e.g. router diff, registry write, corrupted store).
 * @returns {object|null} frozen { mode?, owner?, approvalOwnerOnly?, approvalMembers? } with only the
 *   fields that carried a real value, or null when nothing valid remains.
 */
export function normalizeControlOverlay(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const out = {}
  if (input.mode === 'team' || input.mode === 'personal') out.mode = input.mode
  const owner = text(input.owner)
  if (owner !== null && owner.length <= MAX_OVERLAY_STRING && !looksGlobal(owner)) out.owner = owner
  if (typeof input.approvalOwnerOnly === 'boolean') out.approvalOwnerOnly = input.approvalOwnerOnly
  const members = normalizeApprovalMembers(input.approvalMembers)
  if (members.length > 0) out.approvalMembers = members
  return Object.keys(out).length > 0 ? Object.freeze(out) : null
}

export function normalizeSessionPolicy(input = {}, now = Date.now()) {
  const mode = MODES.has(input.mode) ? input.mode : 'personal'
  const capabilities = {
    observe: input.capabilities?.observe !== false,
    approve: input.capabilities?.approve !== false,
    stop: input.capabilities?.stop !== false,
    // T04：resource access (bind/use task selection) and outbound-quiet manage
    // scope are their own opt-in capabilities (CONTRACTS §命令政策最小表 lists
    // them separately from converse). Off by default — a policy that has not
    // granted them denies the corresponding command.
    assets: input.capabilities?.assets === true,
    quiet: input.capabilities?.quiet === true,
    converse: input.capabilities?.converse === true,
    groupChatControl: input.capabilities?.groupChatControl === true,
  }
  if (mode === 'personal') capabilities.groupChatControl = false
  const policyVersion = text(input.policyVersion) ?? '1'
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : Number(input.expiresAt)
  return Object.freeze({
    mode,
    capabilities: Object.freeze(capabilities),
    policyVersion,
    owner: text(input.owner),
    sessionId: text(input.sessionId),
    channel: text(input.channel),
    accountId: text(input.accountId),
    userId: text(input.userId),
    chatId: text(input.chatId),
    approvalOwnerOnly: input.approvalOwnerOnly === true,
    approvalMembers: normalizeApprovalMembers(input.approvalMembers),
    revoked: input.revoked === true,
    revokedAt: Number.isFinite(Number(input.revokedAt)) ? Number(input.revokedAt) : null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
  })
}

export function isPolicyExpired(policy, now = Date.now()) {
  return policy?.revoked === true || (Number.isFinite(policy?.expiresAt) && policy.expiresAt <= now)
}

export function revokePolicy(policy, reason = 'revoked', now = Date.now()) {
  const current = normalizeSessionPolicy(policy, now)
  return Object.freeze({ ...current, revoked: true, revokedAt: now, revokeReason: text(reason) ?? 'revoked' })
}

function bound(value) {
  return text(value)
}

/** Classify provider-neutral chat scope, keeping QQ legacy compatibility narrow. */
export function chatScopeOf(event) {
  const type = String(event?.chatType ?? '').trim().toLowerCase()
  if (String(event?.channel ?? '').trim().toLowerCase() === 'qq') {
    if (type === 'group' || type === 'supergroup' || type === '2' || type === 'chat') return 'group'
    if (type === 'private' || type === 'p2p' || type === '1') return 'private'
    // Pre-chatType C2C envelopes are safe to retain only when the provider
    // shape itself proves a one-to-one user/chat binding. A group_openid
    // cannot pass this compatibility path because it differs from userId.
    if (type === '' && bound(event?.chatId) !== null && bound(event?.userId) !== null && bound(event.chatId) === bound(event.userId)) return 'private'
    return 'unknown'
  }
  if (type === 'group' || type === 'supergroup' || type === '2' || type === 'chat') return 'group'
  return 'private'
}

function isGroupChat(event) {
  const scope = chatScopeOf(event)
  if (scope === 'group') return true
  if (scope === 'private') return false
  // chatScopeOf returned neither 'group' nor 'private' (e.g. QQ unknown chatType).
  // Only apply the deny-side chatId shape hint when chatType is truly absent.
  const chatId = String(event?.chatId ?? '')
  return chatId.startsWith('oc_') || chatId.startsWith('group_') || chatId.startsWith('grp_')
}

/**
 * Decide whether a normalized event may settle approval/question-answer under the
 * policy object (which must already be a normalized snapshot). Pure; exported for
 * tests. Only exact `(channel, accountId, userId)` sources settle here.
 *
 * - `approvalOwnerOnly=true`: only the owner, bound to the policy's own
 *   channel/accountId, may settle. An owner userId arriving from a different
 *   channel or account is rejected (exact source binding).
 * - `mode='team'` with a non-empty list: the event's exact normalized
 *   `(channel, accountId, userId)` triple must be listed, unless it is the owner
 *   bound to the policy's conversation channel/accountId.
 * - personal / team-without-list: returns true so the caller's exact per-person
 *   source binding decides; membership is never granted for steer/ordinary-message.
 */
export function canSettleApproval(policy, event) {
  if (policy == null || event == null) return false
  const members = Array.isArray(policy.approvalMembers) ? policy.approvalMembers : []
  const ownerSource =
    policy.owner != null &&
    String(event.userId) === String(policy.owner) &&
    bound(event.channel) === bound(policy.channel) &&
    bound(event.accountId) === bound(policy.accountId)
  if (policy.approvalOwnerOnly === true) {
    return ownerSource
  }
  if (policy.mode === 'team' && members.length > 0) {
    if (ownerSource) return true
    return members.some((m) => m.channel === event.channel && m.accountId === event.accountId && m.userId === event.userId)
  }
  return true
}

export function canAcceptCommand(policy, event, now = Date.now()) {
  if (policy === null || typeof policy !== 'object' || event === null || typeof event !== 'object') return { ok: false, reason: 'malformed' }
  if (isPolicyExpired(policy, now)) return { ok: false, reason: policy.revoked ? 'revoked' : 'expired' }
  if (bound(event.policyVersion) !== policy.policyVersion) return { ok: false, reason: 'stale_policy' }
  // Conversation-level binding (session/chat) is always exact for every command.
  // Person binding is separated below so only explicit team approval membership can
  // relax the exact-user rule, and only for approve/question-answer.
  for (const key of ['sessionId', 'chatId']) {
    if (bound(event[key]) === null || bound(policy[key]) === null) return { ok: false, reason: `source_mismatch_${key}` }
    if (bound(policy[key]) !== event[key]) return { ok: false, reason: `source_mismatch_${key}` }
  }
  if (!COMMANDS.includes(event.command)) return { ok: false, reason: 'unknown_command' }
  const chatScope = chatScopeOf(event)
  if (String(event.channel ?? '').toLowerCase() === 'qq' && chatScope === 'unknown') {
    return { ok: false, reason: 'source_chat_type_unknown' }
  }
  const caps = policy.capabilities ?? {}
  // QQ group control is intentionally never enabled by policy. Group
  // notifications remain valid, while callbacks/text are receipt-only.
  if (String(event.channel ?? '').toLowerCase() === 'qq' && chatScope === 'group') {
    return { ok: false, reason: 'group_chat_disabled' }
  }
  if (isGroupChat(event) && caps.groupChatControl !== true) return { ok: false, reason: 'group_chat_disabled' }
  if (event.command === 'stop' && caps.stop !== true) return { ok: false, reason: 'stop_disabled' }
  if (event.command === 'approval' && caps.approve !== true) return { ok: false, reason: 'approval_disabled' }
  if (event.command === 'question-answer' && caps.approve !== true) return { ok: false, reason: 'approval_disabled' }
  if ((event.command === 'steer' || event.command === 'ordinary-message') && caps.converse !== true) return { ok: false, reason: 'conversation_disabled' }
  // Person binding. Approve/question-answer may authorize an explicit team member
  // (or the owner); every other command keeps the exact per-person source binding.
  const authorizing = event.command === 'approval' || event.command === 'question-answer'
  const members = Array.isArray(policy.approvalMembers) ? policy.approvalMembers : []
  const memberScope = authorizing && policy.mode === 'team' && members.length > 0
  if (authorizing && (policy.approvalOwnerOnly === true || memberScope)) {
    if (bound(event.channel) === null || bound(event.accountId) === null) return { ok: false, reason: 'source_mismatch_channel' }
    if (!canSettleApproval(policy, event)) {
      return { ok: false, reason: policy.approvalOwnerOnly === true ? 'owner_only' : 'member_not_allowed' }
    }
  } else {
    for (const key of ['channel', 'accountId', 'userId']) {
      if (bound(event[key]) === null || bound(policy[key]) === null) return { ok: false, reason: `source_mismatch_${key}` }
      if (bound(policy[key]) !== event[key]) return { ok: false, reason: `source_mismatch_${key}` }
    }
  }
  return { ok: true }
}

/**
 * Command admission table — the SINGLE minimal condition for every inbound
 * action that is not one of the five session-affecting control commands
 * (`canAcceptCommand` still owns those). One row per registry/conversation
 * command; `capability` names a policy capability that must be true, `ownerOnly`
 * requires the sender to be the bound owner. This is a description of the
 * existing minimal table in CONTRACTS.md §命令政策最小表, not a second policy
 * engine: it is read by `admitCommand`, which is called from the one control
 * ingress. New command → new row here, never a parallel authority.
 *
 * help/whoami minimal (neutral: only an allowed transport/chat/rate-limit, no
 * capability) | pair/unpair neutral (the pairing code is itself the authority)
 * | status/tasks/sessions read (neutral; scope-filtered) | ordinary/steer
 * converse (strict-equality path also covers these) | stop stop-capability
 * (strict-equality path covers) | quiet/unquiet manage-scope
 * (conversation-scope quiet capability) | bind/use resource access (assets
 * capability) | log owner.
 */
export const COMMAND_POLICY = Object.freeze({
  help: Object.freeze({ capability: null, ownerOnly: false }),
  whoami: Object.freeze({ capability: null, ownerOnly: false }),
  pair: Object.freeze({ capability: null, ownerOnly: false }),
  unpair: Object.freeze({ capability: null, ownerOnly: false }),
  status: Object.freeze({ capability: null, ownerOnly: false }),
  tasks: Object.freeze({ capability: null, ownerOnly: false }),
  sessions: Object.freeze({ capability: null, ownerOnly: false }),
  stop: Object.freeze({ capability: 'stop', ownerOnly: false }),
  'steer': Object.freeze({ capability: 'converse', ownerOnly: false }),
  'ordinary-message': Object.freeze({ capability: 'converse', ownerOnly: false }),
  quiet: Object.freeze({ capability: 'quiet', ownerOnly: false }),
  unquiet: Object.freeze({ capability: 'quiet', ownerOnly: false }),
  bind: Object.freeze({ capability: 'assets', ownerOnly: false }),
  use: Object.freeze({ capability: 'assets', ownerOnly: false }),
  log: Object.freeze({ capability: null, ownerOnly: true }),
})

/**
 * Authorize a non-session-affecting inbound command (registry/conversation).
 * `event` carries the minimal shape the caller already binds: `command`, and
 * the source fields `channel`/`accountId`/`userId`/`sessionId`/`chatId`.
 * Returns `{ ok, reason }`, fail-closed on an unknown command, a denied source,
 * a missing capability, or an owner check that cannot be satisfied.
 *
 * Strict-equality authorization (the same rule as `canAcceptCommand`) applies
 * to every row: the event source must equal the bound policy source when the
 * policy declares one, and must be present when the policy does. This keeps a
 * single authorization path — an unknown/no-slash command cannot skip it.
 *
 * @param {object} policy - normalized session policy snapshot
 * @param {object} event - `{ command, channel?, accountId?, userId?, sessionId?, chatId? }`
 * @param {number} now
 * @param {{ ownerProof?: boolean }} [options] - `ownerProof: true` means the
 *   caller independently established that `event.userId` is the bound owner for
 *   `event.channel` (via the identity registry, the same proof the conversation
 *   router used before this gate). It satisfies an `ownerOnly` row; the
 *   `policy.owner` equality is kept as an alternative proof.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function admitCommand(policy, event, now = Date.now(), options = {}) {
  if (policy === null || typeof policy !== 'object' || event === null || typeof event !== 'object') return { ok: false, reason: 'malformed' }
  if (isPolicyExpired(policy, now)) return { ok: false, reason: policy.revoked ? 'revoked' : 'expired' }
  const entry = COMMAND_POLICY[event.command]
  if (entry === undefined) return { ok: false, reason: 'unknown_command' }
  const caps = policy.capabilities ?? {}
  const chatScope = chatScopeOf(event)
  if (String(event.channel ?? '').toLowerCase() === 'qq' && chatScope === 'unknown') {
    return { ok: false, reason: 'source_chat_type_unknown' }
  }
  // Sensitive group entry points are denied by default for every command
  // shape. QQ group control is never enabled by policy; a generic group chat
  // needs the explicit `groupChatControl` capability. Group outbound
  // notifications are unaffected (they never pass this ingress).
  if (String(event.channel ?? '').toLowerCase() === 'qq' && chatScope === 'group') {
    return { ok: false, reason: 'group_chat_disabled' }
  }
  if (isGroupChat(event) && caps.groupChatControl !== true) return { ok: false, reason: 'group_chat_disabled' }
  if (entry.capability !== null && caps[entry.capability] !== true) {
    return { ok: false, reason: `capability_required:${entry.capability}` }
  }
  // Per-person source binding: exact when the policy declares the source. An
  // owner-only command additionally requires `policy.owner` to match.
  for (const key of ['channel', 'accountId', 'userId']) {
    if (bound(policy[key]) !== null && bound(policy[key]) !== event[key]) return { ok: false, reason: `source_mismatch_${key}` }
    if (bound(policy[key]) === null && bound(event[key]) === null) return { ok: false, reason: `source_mismatch_${key}` }
  }
  if (entry.ownerOnly) {
    const ownerProof = options.ownerProof === true
    const policyOwner = bound(policy.owner)
    const matchesPolicyOwner = policyOwner !== null && bound(event.userId) !== null && String(event.userId) === policyOwner
    if (!ownerProof && !matchesPolicyOwner) return { ok: false, reason: 'owner_only' }
  }
  return { ok: true }
}

export function chooseCommand(candidates, context = {}) {
  if (!Array.isArray(candidates)) return { status: 'rejected', reason: 'malformed' }
  const clock = typeof context.now === 'function' ? context.now : Date.now
  const valid = candidates.filter((candidate) => canAcceptCommand(context.policy, candidate.event, clock()).ok)
  if (valid.length === 0) return { status: 'rejected', reason: 'no_valid_command' }
  valid.sort((a, b) => (RANK.get(a.event.command) ?? 99) - (RANK.get(b.event.command) ?? 99) || Number(a.event.createdAt) - Number(b.event.createdAt))
  const winner = valid[0]
  if (context.settled?.has?.(winner.event.eventId)) return { status: 'already_handled', event: winner.event }
  context.settled?.add?.(winner.event.eventId)
  return { status: 'accepted', event: winner.event, candidate: winner }
}

export function createSessionArbiter({ policy = {}, now = Date.now, onSettle = null, onAudit = null } = {}) {
  let current = normalizeSessionPolicy(policy, now())
  const settled = new Set()
  let disposed = false
  const audit = (entry) => {
    try { onAudit?.({ eventId: text(entry.event?.eventId), sessionId: text(entry.event?.sessionId), command: text(entry.event?.command), status: entry.status, reason: text(entry.reason), at: now() }) } catch { /* audit never changes control flow */ }
  }
  return {
    policy() { return current },
    revoke(reason) { current = revokePolicy(current, reason, now()); return current },
    dispose() { disposed = true; settled.clear() },
    handle(event) {
      if (disposed) return { status: 'desktop_fallback', reason: 'disposed' }
      const check = canAcceptCommand(current, event, now())
      if (!check.ok) { audit({ event, status: 'rejected', reason: check.reason }); return { status: 'rejected', reason: check.reason } }
      if (settled.has(event.eventId)) return { status: 'already_handled', event }
      settled.add(event.eventId)
      try {
        const result = onSettle?.(event, current)
        if (result === false || result?.ok === false) {
          settled.delete(event.eventId)
          audit({ event, status: 'desktop_fallback', reason: result?.reason ?? 'settlement_failed' })
          return { status: 'desktop_fallback', reason: result?.reason ?? 'settlement_failed' }
        }
        audit({ event, status: 'accepted' })
        return { status: 'accepted', event }
      } catch {
        settled.delete(event.eventId)
        audit({ event, status: 'desktop_fallback', reason: 'settlement_failed' })
        return { status: 'desktop_fallback', reason: 'settlement_failed' }
      }
    },
  }
}
