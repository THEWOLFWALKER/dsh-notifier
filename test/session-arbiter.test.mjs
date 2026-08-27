import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSessionPolicy, canAcceptCommand, revokePolicy, chooseCommand, createSessionArbiter, canSettleApproval, normalizeControlOverlay, CONTROL_OVERLAY_MAX_MEMBERS } from '../src/control/session-arbiter.mjs'

const policy = (extra = {}) => normalizeSessionPolicy({ sessionId: 's1', channel: 'telegram', accountId: 'a1', userId: 'u1', chatId: 'c1', owner: 'u1', policyVersion: 'p1', ...extra }, 100)
const event = (extra = {}) => ({ eventId: 'e1', sessionId: 's1', channel: 'telegram', accountId: 'a1', userId: 'u1', chatId: 'c1', policyVersion: 'p1', command: 'stop', createdAt: 10, expiresAt: 200, ...extra })
const teamPolicy = (extra = {}) => policy({ mode: 'team', capabilities: { approve: true }, approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }], ...extra })

test('personal defaults are safe and group/conversation are off', () => {
  const p = normalizeSessionPolicy({}, 100)
  assert.deepEqual(p.capabilities, { observe: true, approve: true, stop: true, converse: false, groupChatControl: false })
  assert.deepEqual(p.approvalMembers, [])
  assert.equal(p.mode, 'personal')
  assert.equal(canAcceptCommand(p, event()).reason, 'stale_policy')
})

test('policy binding and capability gates are exact', () => {
  const p = policy()
  assert.equal(canAcceptCommand(p, event()).ok, true)
  assert.equal(canAcceptCommand(p, event({ command: 'approval' })).ok, true)
  assert.equal(canAcceptCommand(p, event({ command: 'question-answer' })).ok, true)
  assert.equal(canAcceptCommand(p, event({ chatId: '' })).reason, 'source_mismatch_chatId')
  assert.equal(canAcceptCommand(p, event({ command: 'steer' })).reason, 'conversation_disabled')
  assert.equal(canAcceptCommand(p, event({ command: 'steer', chatType: 'group' })).reason, 'group_chat_disabled')
  assert.equal(canAcceptCommand(p, event({ policyVersion: 'old' })).reason, 'stale_policy')
  for (const key of ['sessionId', 'channel', 'accountId', 'userId', 'chatId']) {
    assert.match(canAcceptCommand(p, event({ [key]: 'wrong' })).reason, new RegExp(`source_mismatch_${key}`))
  }
})

test('team mode permits scoped conversation only when explicitly enabled', () => {
  const p = policy({ mode: 'team', capabilities: { converse: true }, chatId: 'c1' })
  assert.equal(canAcceptCommand(p, event({ command: 'steer' })).ok, true)
  assert.equal(canAcceptCommand(p, event({ command: 'ordinary-message' })).ok, true)
  assert.equal(canAcceptCommand(p, event({ command: 'steer', chatType: 'group' })).reason, 'group_chat_disabled')
})

test('owner-only approval and revoke fail closed', () => {
  const p = policy({ approvalOwnerOnly: true })
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u2' })).reason, 'owner_only')
  assert.equal(canAcceptCommand(p, event({ command: 'question-answer', userId: 'u2' })).reason, 'owner_only')
  // ownerOnly is not a userId-only gate: an owner id from the wrong channel or
  // wrong account must never settle (exact source binding)
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u1', channel: 'feishu' })).reason, 'owner_only')
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u1', accountId: 'z1' })).reason, 'owner_only')
  assert.equal(canAcceptCommand(p, event({ command: 'question-answer', userId: 'u1', channel: 'feishu' })).reason, 'owner_only')
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u1', channel: 'feishu' })), false)
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u1', accountId: 'z1' })), false)
  // the true owner source still settles
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u1' })), true)
  assert.equal(canAcceptCommand(revokePolicy(p, 'manual', 120), event(), 120).reason, 'revoked')
})

test('owner authorization fails closed when the policy conversation source is genuinely absent', () => {
  // A policy that names an owner but binds no channel/accountId cannot prove the
  // event is the true owner source: the owner userId alone must not settle, and an
  // arbitrary whatever-account event must be denied, not granted by event-supplied values.
  const p = normalizeSessionPolicy({ policyVersion: 'p1', sessionId: 's1', chatId: 'c1', owner: 'u1', approvalOwnerOnly: true }, 100)
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u1', channel: 'telegram', accountId: 'a1' })).reason, 'owner_only')
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u1', channel: 'telegram', accountId: 'a1' })), false)
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u1', accountId: 'a9' })), false)
})

test('approvalMembers normalize safely: trim, drop malformed/wildcard, dedup, and cap at 64', () => {
  const p = normalizeSessionPolicy({
    mode: 'team', sessionId: 's1', chatId: 'c1', owner: 'u1',
    approvalMembers: [
      { channel: ' telegram ', accountId: ' a1 ', userId: ' u2 ' },   // trimmed to (telegram,a1,u2)
      { channel: 'telegram', accountId: 'a1', userId: 'u2' },           // duplicate of the trimmed triple
      {},                                                                // missing all fields -> dropped
      { channel: 'telegram', accountId: 'a1' },                          // missing userId -> dropped
      { channel: '*', accountId: 'a1', userId: 'u9' },                   // wildcard -> dropped
      { channel: 'all', accountId: 'a1', userId: 'u9' },                 // global pseudo-id -> dropped
      { channel: 'telegram', accountId: 'a1', userId: 'u3' },
      ['not', 'an', 'object'],                                           // nested array -> dropped
      null,                                                              // dropped
    ],
  }, 100)
  assert.deepEqual(p.approvalMembers, [
    { channel: 'telegram', accountId: 'a1', userId: 'u2' },
    { channel: 'telegram', accountId: 'a1', userId: 'u3' },
  ])
  assert.equal(normalizeSessionPolicy({ approvalMembers: 'not-an-array' }, 100).approvalMembers.length, 0)
  assert.equal(canSettleApproval(p, event({ command: 'approval', userId: 'u9' })), false)

  const many = []
  for (let i = 0; i < 70; i++) many.push({ channel: 'telegram', accountId: 'a1', userId: `u${i}` })
  const capped = normalizeSessionPolicy({ mode: 'team', approvalMembers: many }, 100)
  assert.equal(capped.approvalMembers.length, 64)
  assert.equal(capped.approvalMembers[63].userId, 'u63')
})

test('team member exact triple may approve/question-answer; owner overrides; non-members rejected', () => {
  const p = teamPolicy()
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u2' })).ok, true)
  assert.equal(canAcceptCommand(p, event({ command: 'question-answer', userId: 'u2' })).ok, true)
  // owner accepted even when listed members omit the owner
  assert.equal(canAcceptCommand(teamPolicy(), event({ command: 'approval', userId: 'u1' })).ok, true)
  assert.equal(canAcceptCommand(teamPolicy(), event({ command: 'question-answer', userId: 'u1' })).ok, true)
  // wrong channel / account / user rejected
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u2', channel: 'feishu' })).reason, 'member_not_allowed')
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u2', accountId: 'z1' })).reason, 'member_not_allowed')
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u9' })).reason, 'member_not_allowed')
  // team owner override is also exact-source, not a userId-only bypass: an owner id
  // from the wrong channel/account cannot claim the owner exemption
  assert.equal(canAcceptCommand(teamPolicy(), event({ command: 'approval', userId: 'u1', channel: 'feishu' })).reason, 'member_not_allowed')
  assert.equal(canAcceptCommand(teamPolicy(), event({ command: 'approval', userId: 'u1', accountId: 'z1' })).reason, 'member_not_allowed')
  assert.equal(canSettleApproval(teamPolicy(), event({ command: 'approval', userId: 'u1', channel: 'feishu' })), false)
  assert.equal(canSettleApproval(teamPolicy(), event({ command: 'approval', userId: 'u1', accountId: 'z1' })), false)
  // ownership / membership never grant steer or ordinary-message
  const conv = teamPolicy({ capabilities: { approve: true, converse: true } })
  assert.equal(canAcceptCommand(conv, event({ command: 'steer', userId: 'u2' })).reason, 'source_mismatch_userId')
  assert.equal(canAcceptCommand(conv, event({ command: 'ordinary-message', userId: 'u2' })).reason, 'source_mismatch_userId')
})

test('owner-only and team scope stay fail-closed across expiry/revoke/stale', () => {
  const p = teamPolicy({ approvalOwnerOnly: true, expiresAt: 50 })
  assert.equal(canAcceptCommand(p, event({ command: 'approval', userId: 'u2' }), 100).reason, 'expired')
  assert.equal(canAcceptCommand(revokePolicy(teamPolicy(), 'stop', 120), event({ command: 'approval', userId: 'u2' }), 120).reason, 'revoked')
  assert.equal(canAcceptCommand(teamPolicy(), { ...event({ command: 'approval', userId: 'u2' }), policyVersion: 'p0' }).reason, 'stale_policy')
})

test('precedence chooses stop, then question, then approval, steer, ordinary', () => {
  const p = policy({ capabilities: { converse: true, groupChatControl: false } })
  const candidates = ['ordinary-message', 'approval', 'question-answer', 'steer', 'stop'].map((command, i) => ({ event: event({ eventId: `e${i}`, command, createdAt: 10 + i }) }))
  assert.equal(chooseCommand(candidates, { policy: p }).event.command, 'stop')
})

test('arbiter settles once, retries failed settlement, throws fail closed, revokes and disposes safely', () => {
  let calls = 0
  const arbiter = createSessionArbiter({ policy: policy(), now: () => 100, onSettle: () => { calls++; return calls > 1 } })
  assert.equal(arbiter.handle(event()).status, 'desktop_fallback')
  assert.equal(arbiter.handle(event({ eventId: 'e2' })).status, 'accepted')
  assert.equal(arbiter.handle(event({ eventId: 'e2' })).status, 'already_handled')
  assert.equal(arbiter.handle(event({ eventId: 'e6' })).status, 'accepted')
  arbiter.revoke('stop')
  assert.equal(arbiter.handle(event({ eventId: 'e4' })).status, 'rejected')
  arbiter.dispose()
  assert.equal(arbiter.handle(event({ eventId: 'e5' })).status, 'desktop_fallback')
})

test('callback throw on settlement fails closed with no ledger flush', () => {
  const arbiter = createSessionArbiter({ policy: policy(), now: () => 100, onSettle: () => { throw new Error('boom') } })
  assert.equal(arbiter.handle(event({ eventId: 'thrown' })).status, 'desktop_fallback')
})

// ---- normalizeControlOverlay（Stage 4 会话控制覆盖层的唯一规范形状）----

test('normalizeControlOverlay keeps only the four approved fields and drops source fields', () => {
  const overlay = normalizeControlOverlay({
    mode: 'team', owner: 'u1', approvalOwnerOnly: false,
    approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }],
    channel: 'feishu', accountId: 'z1', userId: 'evil', chatId: 'c9', sessionId: 's9',
    policyVersion: 'x', expiresAt: 9, revoked: true, garbage: 123,
  })
  assert.deepEqual(overlay, {
    mode: 'team', owner: 'u1', approvalOwnerOnly: false,
    approvalMembers: [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }],
  })
  for (const key of ['channel', 'accountId', 'userId', 'chatId', 'sessionId', 'policyVersion', 'expiresAt', 'revoked', 'garbage']) {
    assert.equal(Object.prototype.hasOwnProperty.call(overlay, key), false, key)
  }
})

test('normalizeControlOverlay rejects globals/empties, trims, dedups, and caps members', () => {
  const overlay = normalizeControlOverlay({
    owner: '*', approvalOwnerOnly: 'yes', // non-boolean dropped
    approvalMembers: [
      { channel: ' telegram ', accountId: ' a1 ', userId: ' u2 ' },
      { channel: 'telegram', accountId: 'a1', userId: 'u2' }, // duplicate -> dedup
      { channel: '', accountId: 'a1', userId: 'u9' },          // empty -> drop
      { channel: 'all', accountId: 'a1', userId: 'u9' },        // global -> drop
      { channel: 'telegram', accountId: 'a1', userId: '*' },    // wildcard -> drop
    ],
  })
  assert.equal(overlay.owner, undefined)
  assert.equal(overlay.approvalOwnerOnly, undefined)
  assert.deepEqual(overlay.approvalMembers, [{ channel: 'telegram', accountId: 'a1', userId: 'u2' }])
})

test('normalizeControlOverlay caps members at 64, freezing a minimal overlay, and nulls on empty', () => {
  const members = []
  for (let i = 0; i < 70; i++) members.push({ channel: 'telegram', accountId: 'a1', userId: `u${i}` })
  const overlay = normalizeControlOverlay({ mode: 'team', approvalMembers: members })
  assert.equal(overlay.approvalMembers.length, CONTROL_OVERLAY_MAX_MEMBERS)
  assert.equal(overlay.approvalMembers[63].userId, 'u63')
  assert.equal(Object.isFrozen(overlay), true)
  assert.equal(Object.isFrozen(overlay.approvalMembers), true)
  assert.equal(normalizeControlOverlay({}), null)
  assert.equal(normalizeControlOverlay(null), null)
  assert.equal(normalizeControlOverlay([]), null)
  assert.equal(normalizeControlOverlay('team'), null)
  // owner capped by string bound
  assert.equal(normalizeControlOverlay({ owner: 'x'.repeat(129), mode: 'team' }).owner, undefined)
  assert.equal(normalizeControlOverlay({ owner: 'x'.repeat(128), mode: 'team' }).owner.length, 128)
  assert.equal(normalizeControlOverlay({ mode: 'bogus' }), null)
  assert.equal(normalizeControlOverlay({ owner: '' }), null)
})
