import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlEntry } from '../src/control/entry.mjs'
import { createActionDispatcher } from '../src/actions.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

const pending = (channel, chatId, extra = {}) => ({
  status: 'pending', sessionId: 'session-1', agentId: 'session-1', channel, chatId,
  userId: 'user-1', accountId: channel, policyVersion: '1', createdAt: 100,
  expiresAt: 1000, pushedTo: [{ channel, chatId, userId: 'user-1' }], ...extra,
})

function makeControl(rows, settled, options = {}) {
  const control = createControlEntry({ now: () => 150, ...options })
  control.register('approval', {
    getPending: (input) => rows.get(input.approvalKey),
    buildEvent: (input, row) => ({
      eventId: input.eventId,
      sessionId: row.sessionId,
      source: 'mobile',
      channel: row.channel,
      accountId: row.accountId,
      userId: row.userId,
      chatId: input.chatId,
      policyVersion: row.policyVersion,
      command: 'approval',
      chatType: input.chatType,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }),
    settle: (input) => { settled.push({ channel: input.channel, key: input.approvalKey }); return true },
  })
  return control
}

test('Control Core runtime entry is shared by Telegram and Feishu callback envelopes', () => {
  const rows = new Map([
    ['ap:tg', pending('telegram', 'tg-chat')],
    ['ap:fs', pending('feishu', 'fs-chat')],
  ])
  const settled = []
  const control = makeControl(rows, settled)
  assert.equal(control.handle({ eventId: 'tg-1', command: 'approval', approvalKey: 'ap:tg', channel: 'telegram', chatId: 'tg-chat', userId: 'user-1' }).status, 'accepted')
  assert.equal(control.handle({ eventId: 'fs-1', command: 'approval', approvalKey: 'ap:fs', channel: 'feishu', chatId: 'fs-chat', userId: 'user-1' }).status, 'accepted')
  assert.deepEqual(settled, [{ channel: 'telegram', key: 'ap:tg' }, { channel: 'feishu', key: 'ap:fs' }])
})

test('Control Core rejects old/replayed callback, wrong chat, expired policy, and groups', () => {
  const rows = new Map([['ap:tg', pending('telegram', 'tg-chat')]])
  const settled = []
  const control = makeControl(rows, settled, { policy: { expiresAt: 500 } })
  const base = { eventId: 'same', command: 'approval', approvalKey: 'ap:tg', channel: 'telegram', chatId: 'tg-chat', userId: 'user-1' }
  assert.equal(control.handle(base).status, 'accepted')
  assert.equal(control.handle(base).status, 'already_handled')
  const wrongChat = makeControl(rows, settled)
  assert.equal(wrongChat.handle({ ...base, eventId: 'wrong-chat', chatId: 'other' }).status, 'rejected')
  const expired = makeControl(rows, settled, { policy: { expiresAt: 120 } })
  assert.equal(expired.handle({ ...base, eventId: 'expired' }).reason, 'expired')
  const group = makeControl(rows, settled)
  assert.equal(group.handle({ ...base, eventId: 'group', chatType: 'group' }).reason, 'group_chat_disabled')
})

test('personal default keeps converse disabled while private stop remains available', () => {
  const control = createControlEntry({ now: () => 150 })
  const pendingRow = pending('telegram', 'tg-chat')
  let calls = 0
  const ordinary = control.handle({
    eventId: 'ordinary', command: 'ordinary-message', channel: 'telegram', accountId: 'telegram',
    userId: 'user-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1',
    pending: pendingRow, settle: () => { calls++; return true },
  })
  assert.equal(ordinary.reason, 'conversation_disabled')
  assert.equal(calls, 0)
  const stop = control.handle({
    eventId: 'stop', command: 'stop', channel: 'telegram', accountId: 'telegram',
    userId: 'user-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1',
    pending: pendingRow, settle: () => { calls++; return true },
  })
  assert.equal(stop.status, 'accepted')
  assert.equal(calls, 1)
})

test('Control Core：stop/action 载荷缺 accountId → missing_accountId fail-closed（channel 名绝不回退为账号）', () => {
  const control = createControlEntry({ now: () => 150 })
  // pending 行不带任何来源字段（channel/accountId 都不声明）——事件必须自证来源。
  const barePending = {
    status: 'pending', sessionId: 'session-1', agentId: 'session-1',
    chatId: 'tg-chat', userId: 'user-1', policyVersion: '1', createdAt: 100, expiresAt: 1000,
  }
  const stop = control.handle({
    eventId: 'stop-no-account', command: 'stop', channel: 'telegram',
    userId: 'user-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1',
    pending: barePending, settle: () => { throw new Error('缺账号来源不得结算') },
  })
  assert.equal(stop.status, 'rejected')
  assert.equal(stop.reason, 'missing_accountId')
  // 携带本地账号标识的正常 stop 仍可裁决（正控）
  const okStop = control.handle({
    eventId: 'stop-with-account', command: 'stop', channel: 'telegram', accountId: 'tg-app',
    userId: 'user-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1',
    pending: barePending, settle: () => true,
  })
  assert.equal(okStop.status, 'accepted')
})

test('QQ group and unknown-source controls fail closed for every command, while legacy C2C remains private', () => {
  const control = createControlEntry({
    policy: { mode: 'team', capabilities: { converse: true, groupChatControl: true } },
    now: () => 150,
  })
  const pendingRow = pending('qq', 'g-open', { accountId: 'QQ_APP', userId: 'u1' })
  const calls = []
  const base = {
    channel: 'qq', accountId: 'QQ_APP', userId: 'u1', chatId: 'g-open', sessionId: 'session-1', policyVersion: '1',
    pending: pendingRow, settle: () => { calls.push('settled'); return true },
  }
  for (const command of ['stop', 'approval', 'question-answer', 'steer', 'ordinary-message']) {
    const result = control.handle({ ...base, command, eventId: `group-${command}`, chatType: 'group' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'group_chat_disabled')
  }
  const unknown = control.handle({ ...base, command: 'stop', eventId: 'unknown', chatType: undefined })
  assert.equal(unknown.status, 'rejected')
  assert.equal(unknown.reason, 'source_chat_type_unknown')
  assert.equal(calls.length, 0)

  const legacyC2c = control.handle({
    ...base, command: 'stop', eventId: 'legacy-c2c', userId: 'u1', chatId: 'u1', chatType: undefined,
    pending: pending('qq', 'u1', { accountId: 'QQ_APP', userId: 'u1' }),
  })
  assert.equal(legacyC2c.status, 'accepted')
  assert.equal(calls.length, 1)
})

test('action callbacks from Telegram and Feishu settle through the shared entry', () => {
  const rows = new Map()
  const store = {
    get: (key) => rows.get(key),
    set: (key, value) => { rows.set(key, value) },
  }
  const dispatcher = createActionDispatcher({
    store,
    vault: createTokenVault({ secret: 'control-entry-actions' }),
    control: createControlEntry(),
  })
  const calls = []
  dispatcher.register('turn/cancel', ({ via }) => {
    calls.push(via)
    return { ok: true, message: '✅ 已停止任务' }
  })
  const telegram = dispatcher.mintAction('turn/cancel', {}, { channel: 'telegram', chatId: 'tg-chat' })
  const feishu = dispatcher.mintAction('turn/cancel', {}, { channel: 'feishu', chatId: 'fs-chat' })
  // 生产传输层（telegram/feishu inbound）总是把本地 resolved accountId 随 action 回调传入；
  // Control Core 的 'stop' 载荷必须携带该账号标识（缺失 = missing_accountId fail-closed）。
  assert.equal(dispatcher.dispatch({ actionKey: telegram.key, token: telegram.token, via: 'telegram:action', userId: 7, chatId: 'tg-chat', accountId: 'tg-app' }).message, '✅ 已停止任务')
  assert.equal(dispatcher.dispatch({ actionKey: feishu.key, token: feishu.token, via: 'feishu:action', userId: 7, chatId: 'fs-chat', accountId: 'fs-app' }).message, '✅ 已停止任务')
  assert.deepEqual(calls, ['telegram:action', 'feishu:action'])
})

function makeTeamControl(approvalMembers, owner, settled) {
  const control = createControlEntry({
    policy: { mode: 'team', owner, approvalMembers, capabilities: { approve: true } },
    now: () => 150,
  })
  control.register('approval', {
    getPending: (input) => ({
      status: 'pending', sessionId: 'session-1', agentId: 'session-1', channel: 'telegram', chatId: 'tg-chat',
      userId: input.userId, accountId: 'telegram', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: input.userId }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile', channel: row.channel,
      accountId: input.accountId, userId: input.userId, chatId: input.chatId ?? row.chatId, policyVersion: row.policyVersion,
      command: 'approval', chatType: input.chatType, createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: (input, pending, event, policy) => { settled.push({ userId: input.userId, policyOwner: policy.owner }); return true },
  })
  return control
}

test('team approvalMembers authorize only listed members and the owner through the shared Core entry', () => {
  const settled = []
  const control = makeTeamControl([{ channel: 'telegram', accountId: 'telegram', userId: 'member-2' }], 'owner-1', settled)
  const base = { command: 'approval', approvalKey: 'ap:team', channel: 'telegram', accountId: 'telegram', chatId: 'tg-chat', userId: 'member-2' }
  // listed member settles; the settle callback receives the normalized policy snapshot (owner is set)
  assert.equal(control.handle({ ...base, eventId: 'm' }).status, 'accepted')
  assert.equal(settled[0].userId, 'member-2')
  assert.equal(settled[0].policyOwner, 'owner-1')
  // owner settles even though not listed, and membership never gets orphaned from a duplicate id
  const ownerHandle = control.handle({ ...base, eventId: 'o', userId: 'owner-1' })
  assert.equal(ownerHandle.status, 'accepted')
  assert.equal(settled.length, 2)
  // non-member and wrong account are rejected with zero settlement (wrong account is
  // caught by the pending-row binding layer first; both fail closed)
  assert.equal(control.handle({ ...base, eventId: 'x', userId: 'intruder' }).reason, 'member_not_allowed')
  assert.equal(control.handle({ ...base, eventId: 'y', accountId: 'other' }).status, 'rejected')
  // the owner id from the wrong account is not the true source: fails closed, no settlement
  assert.equal(control.handle({ ...base, eventId: 'oa', accountId: 'other', userId: 'owner-1' }).status, 'rejected')
  assert.equal(settled.length, 2)
})

// The 2026 team-policy repaired source binding: even when a pending row omits
// account/channel metadata (legacy rows), an owner-only / team owner event must
// never manufacture the policy conversation source from the event envelope.
function runOwnerControl(policy, row, event, command = 'approval') {
  let settled = 0
  let seenPolicy = null
  const control = createControlEntry({ policy, now: () => 150 })
  const result = control.handle({
    command, pending: row, eventId: event.eventId, ...event,
    settle: (input, pendingRow, ev, policySnapshot) => { settled++; seenPolicy = policySnapshot; return true },
  })
  return { result, settled, seenPolicy }
}

test('owner source binding fails closed when pending omits accountId (wrong account can never manufacture the source)', () => {
  const policy = { mode: 'team', owner: 'owner-1', channel: 'telegram', accountId: 'tg-app', approvalOwnerOnly: true, capabilities: { approve: true } }
  // Legacy pending row carries no explicit accountId; the owner callback then claims a different account.
  const row = { sessionId: 'session-1', channel: 'telegram', chatId: 'tg-chat', userId: 'owner-1', createdAt: 100, expiresAt: 1000 }
  const hit = runOwnerControl(policy, row, { channel: 'telegram', accountId: 'other', userId: 'owner-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1', chatType: 'private' })
  assert.equal(hit.result.status, 'rejected')
  assert.equal(hit.result.reason, 'source_mismatch_accountId')
  assert.equal(hit.settled, 0, 'a wrong-account owner callback must never settle')
  // correctness guard: the snapshot the arbiter would authorize against carries the true original account source
  const legit = runOwnerControl(policy, { ...row, accountId: 'tg-app' }, { channel: 'telegram', accountId: 'tg-app', userId: 'owner-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1', chatType: 'private' })
  assert.equal(legit.result.status, 'accepted')
  assert.equal(legit.settled, 1)
  assert.equal(legit.seenPolicy.accountId, 'tg-app')
  assert.equal(legit.seenPolicy.owner, 'owner-1')
})

test('owner from wrong QQ channel (private chatType) fails closed when pending omits channel/accountId', () => {
  const policy = { mode: 'team', owner: 'u1', channel: 'qq', accountId: 'QQ_APP', approvalOwnerOnly: true, capabilities: { approve: true } }
  // Pending row omits both channel and accountId (only session/chat/user), so only the QQ-bot source id is authoritative.
  const row = { sessionId: 'session-1', chatId: 'u1', userId: 'u1', createdAt: 100, expiresAt: 1000 }
  const wrongSource = runOwnerControl(policy, row, { channel: 'qq', accountId: 'OTHER_APP', userId: 'u1', chatId: 'u1', sessionId: 'session-1', policyVersion: '1', chatType: 'private' })
  assert.equal(wrongSource.result.status, 'rejected')
  assert.equal(wrongSource.result.reason, 'source_mismatch_accountId')
  assert.equal(wrongSource.settled, 0)
  // the authoritative QQ-bot account still settles
  const correct = runOwnerControl(policy, row, { channel: 'qq', accountId: 'QQ_APP', userId: 'u1', chatId: 'u1', sessionId: 'session-1', policyVersion: '1', chatType: 'private' })
  assert.equal(correct.result.status, 'accepted')
  assert.equal(correct.settled, 1)
})

test('owner-only authorization fails closed when no source metadata exists at all (legacy with no bindable source)', () => {
  // No channel/accountId anywhere (neither policy nor pending row): owner-only cannot
  // prove the event is the true owner source, so it must deny rather than trust the event.
  const policy = { mode: 'team', owner: 'owner-1', approvalOwnerOnly: true, capabilities: { approve: true } }
  const row = { sessionId: 'session-1', chatId: 'tg-chat', userId: 'owner-1', createdAt: 100, expiresAt: 1000 }
  const hit = runOwnerControl(policy, row, { channel: 'telegram', accountId: 'tg-app', userId: 'owner-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1', chatType: 'private' })
  assert.equal(hit.result.status, 'rejected')
  assert.equal(hit.result.reason, 'source_mismatch_channel')
  assert.equal(hit.settled, 0)
})

test('owner authorization rejects conflicting base, pending, and nested control metadata sources', () => {
  const policy = { mode: 'team', owner: 'owner-1', channel: 'telegram', accountId: 'tg-app', approvalOwnerOnly: true, capabilities: { approve: true } }
  const baseRow = { sessionId: 'session-1', chatId: 'tg-chat', userId: 'owner-1', createdAt: 100, expiresAt: 1000 }
  const event = { channel: 'feishu', accountId: 'fs-app', userId: 'owner-1', chatId: 'tg-chat', sessionId: 'session-1', policyVersion: '1', chatType: 'private' }
  for (const row of [
    { ...baseRow, channel: 'feishu', accountId: 'fs-app' },
    { ...baseRow, control: { channel: 'feishu', accountId: 'fs-app' } },
    { ...baseRow, controlMeta: { channel: 'feishu', accountId: 'fs-app' } },
    { ...baseRow, control: { channel: 'telegram', accountId: 'tg-app' }, controlMeta: { channel: 'feishu', accountId: 'fs-app' } },
  ]) {
    const hit = runOwnerControl(policy, row, event)
    assert.equal(hit.result.status, 'rejected')
    assert.match(hit.result.reason, /^source_mismatch_(channel|accountId)$/)
    assert.equal(hit.settled, 0)
  }
  const aligned = runOwnerControl(policy, { ...baseRow, controlMeta: { channel: 'telegram', accountId: 'tg-app' } }, {
    ...event, channel: 'telegram', accountId: 'tg-app',
  })
  assert.equal(aligned.result.status, 'accepted')
  assert.equal(aligned.settled, 1)
  const question = runOwnerControl(policy, { ...baseRow, controlMeta: { channel: 'telegram', accountId: 'tg-app' } }, {
    ...event, eventId: 'question-answer', channel: 'feishu', accountId: 'fs-app',
  }, 'question-answer')
  assert.equal(question.result.status, 'rejected')
  assert.equal(question.result.reason, 'source_mismatch_channel')
  assert.equal(question.settled, 0)
})

test('team member authorization stays fail-closed on wrong chat and group chat, zero settlement', () => {
  const settled = []
  const control = makeTeamControl([{ channel: 'telegram', accountId: 'telegram', userId: 'member-2' }], 'owner-1', settled)
  const base = { command: 'approval', approvalKey: 'ap:team', channel: 'telegram', accountId: 'telegram', userId: 'member-2' }
  // conversation binding is exact even for approved team members
  assert.equal(control.handle({ ...base, eventId: 'wc', chatId: 'other' }).reason, 'source_mismatch_chatId')
  // QQ-style group control stays fail-closed
  assert.equal(control.handle({ ...base, eventId: 'gr', chatType: 'group' }).reason, 'group_chat_disabled')
  assert.equal(settled.length, 0)
})

function overlayPending(userId = 'member-1', extra = {}) {
  return {
    status: 'pending', sessionId: 'session-overlay', agentId: 'session-overlay',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat', userId,
    policyVersion: '1', createdAt: 100, expiresAt: 1000, ...extra,
  }
}

function runOverlayApproval({ overlay, pendingRow = overlayPending(), policy = {}, input = {}, resolver = null } = {}) {
  const settled = []
  const options = { now: () => 150, policy: { capabilities: { approve: true }, ...policy } }
  if (resolver !== null) options.policyForSession = resolver
  else if (overlay !== undefined) options.sessionPolicy = () => overlay
  const control = createControlEntry(options)
  const result = control.handle({
    eventId: 'overlay-event', command: 'approval', approvalKey: 'overlay-key',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat', userId: pendingRow.userId,
    sessionId: pendingRow.sessionId, policyVersion: '1', chatType: 'private',
    pending: pendingRow,
    ...input,
    settle: (inputEnvelope, row, event, normalizedPolicy) => { settled.push({ event, row, normalizedPolicy }); return true },
  })
  return { result, settled, control }
}

test('persisted session overlay authorizes a listed team member without replacing source binding', () => {
  const hit = runOverlayApproval({
    overlay: {
      mode: 'team', owner: 'owner-1',
      approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }],
    },
  })
  assert.equal(hit.result.status, 'accepted')
  assert.equal(hit.settled[0].normalizedPolicy.owner, 'owner-1')
  assert.equal(hit.settled[0].normalizedPolicy.approvalMembers.length, 1)
})

test('session overlay team member cannot cross channel/account/chat/user bindings', () => {
  const overlay = {
    mode: 'team', owner: 'owner-1',
    approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }],
  }
  for (const input of [
    { channel: 'feishu' },
    { accountId: 'other-app' },
    { chatId: 'other-chat' },
    { userId: 'intruder' },
  ]) {
    const pendingRow = overlayPending(input.userId ?? 'member-1')
    const hit = runOverlayApproval({ overlay, pendingRow, input })
    assert.equal(hit.result.status, 'rejected', JSON.stringify(input))
    assert.equal(hit.settled.length, 0, JSON.stringify(input))
  }
})

test('session overlay approvalOwnerOnly allows only the source-bound owner', () => {
  const overlay = { mode: 'team', owner: 'owner-1', approvalOwnerOnly: true }
  const member = runOverlayApproval({ overlay })
  assert.equal(member.result.reason, 'owner_only')
  const owner = runOverlayApproval({ overlay, pendingRow: overlayPending('owner-1'), input: { userId: 'owner-1' } })
  assert.equal(owner.result.status, 'accepted')
  const wrongChannelOwner = runOverlayApproval({
    overlay, pendingRow: overlayPending('owner-1'), input: { userId: 'owner-1', channel: 'feishu', accountId: 'fs-app' },
  })
  assert.equal(wrongChannelOwner.result.status, 'rejected')
  assert.equal(wrongChannelOwner.settled.length, 0)
})

test('session overlay keeps personal defaults and approvalMembers never widen conversation commands', () => {
  const personal = runOverlayApproval({ overlay: { mode: 'personal' } })
  assert.equal(personal.result.status, 'accepted', 'overlay must not change the personal approval default')

  const control = createControlEntry({
    now: () => 150,
    policy: { mode: 'personal', owner: 'owner-1', channel: 'telegram', accountId: 'tg-app', userId: 'owner-1', capabilities: { converse: true } },
    policyForSession: () => ({ mode: 'team', approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }] }),
  })
  const pendingRow = overlayPending('owner-1')
  const result = control.handle({
    eventId: 'ordinary-overlay', command: 'ordinary-message', channel: 'telegram', accountId: 'tg-app',
    userId: 'member-1', chatId: 'tg-chat', sessionId: 'session-overlay', policyVersion: '1',
    pending: pendingRow, settle: () => true,
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'source_mismatch_userId')
})

test('resolver throws, returns unknown/source/unnormalized fields, or is async: static base policy remains fail-closed', () => {
  const base = { mode: 'team', owner: 'owner-1', approvalOwnerOnly: true, channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } }
  for (const resolver of [
    () => { throw new Error('store unavailable') },
    () => ({ mode: 'team', approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }], evil: true }),
    () => ({ channel: 'feishu', owner: 'owner-1' }),
    () => Promise.resolve({ mode: 'team', approvalMembers: [] }),
  ]) {
    const hit = runOverlayApproval({ policy: base, resolver, input: { trusted: true } })
    assert.equal(hit.result.status, 'rejected')
    assert.equal(hit.result.reason, 'owner_only')
    assert.equal(hit.settled.length, 0)
  }
})

test('resolver is keyed by the exact session id and is not consulted when normalization has no session id', () => {
  const seen = []
  const hit = runOverlayApproval({
    policy: { mode: 'team', owner: 'owner-1', approvalOwnerOnly: true, channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } },
    resolver: (sessionId) => { seen.push(sessionId); return sessionId === 'other-session' ? { mode: 'team', approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }] } : null },
    input: { trusted: true },
  })
  assert.deepEqual(seen, ['session-overlay'])
  assert.equal(hit.result.reason, 'owner_only')

  let calls = 0
  const control = createControlEntry({ now: () => 150, policyForSession: () => { calls++; return { mode: 'team' } } })
  control.register('approval', {
    getPending: () => overlayPending('member-1'),
    buildEvent: () => ({ eventId: 'missing-session', source: 'mobile', channel: 'telegram', accountId: 'tg-app', userId: 'member-1', chatId: 'tg-chat', policyVersion: '1', command: 'approval', createdAt: 100, expiresAt: 1000 }),
    settle: () => true,
  })
  const result = control.handle({ eventId: 'missing-session', command: 'approval', approvalKey: 'overlay-key', channel: 'telegram', accountId: 'tg-app', userId: 'member-1', chatId: 'tg-chat' })
  assert.equal(result.reason, 'missing_sessionId')
  assert.equal(calls, 0)
})

// ——— Phase 1: 持久化 session control overlay 集成测试 ———

// Admin writes overlay to registry → Control Core resolver reads it → authorization affected.
test('admin writes overlay through registry → Control Core uses new policy (end-to-end)', () => {
  // Simulate a store (in-memory) and registry + router
  const state = {}
  const store = {
    get: (key) => state[key] ?? undefined,
    set: (key, val) => { state[key] = val; return true },
    keys: () => Object.keys(state),
  }
  const registry = createSessionRegistry({ store, touchWriteMs: 0, sweepEveryMs: 0 })
  const router = createAgentRouter({ store })

  // Ensure session exists
  registry.ensureSession({ id: 'session-e2e', session: { id: 'session-e2e' } })

  // Admin writes control overlay via router
  router.setSessionControl('session-e2e', {
    mode: 'team',
    owner: 'admin-owner',
    approvalOwnerOnly: true,
  })

  // Control Core with resolver reads from registry
  const settled = []
  const control = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg-app', userId: 'admin-owner', capabilities: { approve: true } },
    policyForSession: (sessionId) => {
      const ctrl = registry.getControl(sessionId)
      return ctrl ?? null
    },
  })
  control.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 'session-e2e', agentId: 'session-e2e',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'admin-owner', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'admin-owner' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: input.channel ?? row.channel, accountId: input.accountId ?? row.accountId,
      userId: row.userId, chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: (_, __, ___, policy) => { settled.push({ owner: policy.owner, ownerOnly: policy.approvalOwnerOnly }); return true },
  })

  // Admin-owner succeeds
  const adminResult = control.handle({
    eventId: 'admin-ok', command: 'approval', approvalKey: 'ap:e2e',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'admin-owner', sessionId: 'session-e2e', policyVersion: '1',
  })
  assert.equal(adminResult.status, 'accepted')
  assert.equal(settled[0].owner, 'admin-owner')
  assert.equal(settled[0].ownerOnly, true)

  // Non-owner from wrong channel rejected (source binding catches before overlay auth)
  const nonOwner = control.handle({
    eventId: 'non-owner', command: 'approval', approvalKey: 'ap:e2e',
    channel: 'feishu', accountId: 'fs-app', chatId: 'fs-chat',
    userId: 'admin-owner', sessionId: 'session-e2e', policyVersion: '1',
  })
  assert.equal(nonOwner.status, 'rejected', 'wrong channel rejected by source binding')
  assert.match(nonOwner.reason, /^source_mismatch_/)
  assert.equal(settled.length, 1, 'only admin settled')
})

// Overlay persists across "restart" — new registry instance reads same store.
test('overlay persists across restart (new registry instance reads overlay from store)', () => {
  const state = {}
  const store = {
    get: (key) => state[key] ?? undefined,
    set: (key, val) => { state[key] = val; return true },
    keys: () => Object.keys(state),
  }

  // Phase 1: first "instance" writes overlay
  const registry1 = createSessionRegistry({ store, touchWriteMs: 0, sweepEveryMs: 0 })
  const router1 = createAgentRouter({ store })
  registry1.ensureSession({ id: 's-persist', session: { id: 's-persist' } })
  router1.setSessionControl('s-persist', {
    mode: 'team', owner: 'persist-owner',
    approvalMembers: [{ channel: 'telegram', accountId: 'tg', userId: 'team-member' }],
  })

  // Phase 2: "restart" — new registry/router read from same store
  const registry2 = createSessionRegistry({ store, touchWriteMs: 0, sweepEveryMs: 0 })
  const control = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg', userId: 'team-member', capabilities: { approve: true } },
    policyForSession: (sid) => registry2.getControl(sid) ?? null,
  })
  control.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 's-persist', agentId: 's-persist',
      channel: 'telegram', accountId: 'tg', chatId: 'tg-chat',
      userId: 'team-member', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'team-member' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: input.userId ?? row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: () => true,
  })

  // Team member authorized after "restart"
  const memberResult = control.handle({
    eventId: 'persist-member', command: 'approval', approvalKey: 'ap:persist',
    channel: 'telegram', accountId: 'tg', chatId: 'tg-chat',
    userId: 'team-member', sessionId: 's-persist', policyVersion: '1',
  })
  assert.equal(memberResult.status, 'accepted', 'overlay persisted across restart')

  // Stranger still rejected
  const strangerResult = control.handle({
    eventId: 'persist-stranger', command: 'approval', approvalKey: 'ap:persist',
    channel: 'telegram', accountId: 'tg', chatId: 'tg-chat',
    userId: 'stranger', sessionId: 's-persist', policyVersion: '1',
  })
  assert.equal(strangerResult.status, 'rejected')
})

// Fail-closed: wrong account/channel/user/session through overlay path.
test('overlay path fails closed for wrong account, channel, user, and session', () => {
  const overlay = {
    mode: 'team', owner: 'owner-1',
    approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'member-1' }],
  }
  const base = {
    sessionId: 'session-fc', channel: 'telegram', accountId: 'tg-app',
    chatId: 'tg-chat', policyVersion: '1',
  }
  const pendingRow = {
    status: 'pending', sessionId: 'session-fc', agentId: 'session-fc',
    ...base, userId: 'member-1', createdAt: 100, expiresAt: 1000,
    pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'member-1' }],
  }

  const make = (extra) => {
    const control = createControlEntry({
      now: () => 150,
      policy: { ...base, userId: 'member-1', capabilities: { approve: true } },
      policyForSession: () => overlay,
    })
    control.register('approval', {
      getPending: () => pendingRow,
      buildEvent: (input) => ({
        eventId: input.eventId ?? 'fc', sessionId: input.sessionId ?? 'session-fc',
        source: 'mobile', channel: input.channel ?? 'telegram',
        accountId: input.accountId ?? 'tg-app', userId: input.userId ?? 'member-1',
        chatId: input.chatId ?? 'tg-chat', policyVersion: '1',
        command: 'approval', createdAt: 100, expiresAt: 1000,
      }),
      settle: () => true,
    })
    return control.handle({ command: 'approval', ...base, userId: 'member-1', ...extra })
  }

  // Wrong account — source binding catches before overlay auth
  assert.equal(make({ eventId: 'fc-acc', accountId: 'evil-app' }).status, 'rejected')
  // Wrong channel — source binding catches
  assert.equal(make({ eventId: 'fc-chan', channel: 'feishu' }).status, 'rejected')
  // Wrong user (not in members, not owner) — overlay owner_only rejects
  assert.equal(make({ eventId: 'fc-user', userId: 'intruder' }).status, 'rejected')
  // Wrong session — source binding catches
  assert.equal(make({ eventId: 'fc-sess', sessionId: 'wrong-session' }).status, 'rejected')
})

// Malicious overlay cannot forge source fields or widen capabilities.
test('malicious overlay cannot forge channel/account/user/session or add capabilities', () => {
  const settled = []
  const maliciousOverlay = {
    mode: 'team', owner: 'attacker',
    approvalOwnerOnly: true,
    // These source fields should be stripped by normalizeControlOverlay
    channel: 'feishu',
    accountId: 'evil-app',
    userId: 'attacker',
    chatId: 'evil-chat',
    sessionId: 'evil-session',
  }
  const control = createControlEntry({
    now: () => 150,
    policy: {
      channel: 'telegram', accountId: 'tg-app', userId: 'legit',
      chatId: 'tg-chat', sessionId: 'session-mal',
      capabilities: { approve: true },
    },
    policyForSession: () => maliciousOverlay,
  })
  control.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 'session-mal', agentId: 'session-mal',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'legit', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'legit' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: input.userId ?? row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: (input, row, event, policy) => { settled.push({ owner: policy.owner, channel: policy.channel, accountId: policy.accountId }); return true },
  })

  // Attacker tries to settle as "attacker" owner from feishu channel
  const result = control.handle({
    eventId: 'mal-1', command: 'approval', approvalKey: 'ap:mal',
    channel: 'feishu', accountId: 'evil-app', chatId: 'evil-chat',
    userId: 'attacker', sessionId: 'session-mal', policyVersion: '1',
  })
  // Should be rejected: overlay source fields were stripped; policy uses base source
  assert.equal(result.status, 'rejected', 'malicious overlay source fields must not authorize')
  assert.equal(settled.length, 0)

  // Even "legit" user from wrong channel with overlay owner id rejected
  const result2 = control.handle({
    eventId: 'mal-2', command: 'approval', approvalKey: 'ap:mal',
    channel: 'feishu', accountId: 'evil-app', chatId: 'evil-chat',
    userId: 'attacker', sessionId: 'session-mal', policyVersion: '1',
  })
  assert.equal(result2.status, 'rejected')
})

// approvalOwnerOnly and approvalMembers positive/negative cases.
test('overlay approvalOwnerOnly positive: owner from correct source settles', () => {
  const settled = []
  const control = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } },
    policyForSession: () => ({ mode: 'team', owner: 'the-owner', approvalOwnerOnly: true }),
  })
  control.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 's-own', agentId: 's-own',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'the-owner', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'the-owner' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: () => { settled.push('settled'); return true },
  })

  // Owner from correct source settles
  const ownerOk = control.handle({
    eventId: 'own-ok', command: 'approval', approvalKey: 'ap:own',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'the-owner', sessionId: 's-own', policyVersion: '1',
  })
  assert.equal(ownerOk.status, 'accepted')
  assert.equal(settled.length, 1)

  // Non-owner rejected — use a different pending row with non-owner userId
  const control2 = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } },
    policyForSession: () => ({ mode: 'team', owner: 'the-owner', approvalOwnerOnly: true }),
  })
  control2.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 's-own2', agentId: 's-own2',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'not-owner', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'not-owner' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: () => { settled.push('settled'); return true },
  })
  const nonOwner = control2.handle({
    eventId: 'own-no', command: 'approval', approvalKey: 'ap:own',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'not-owner', sessionId: 's-own2', policyVersion: '1',
  })
  assert.equal(nonOwner.status, 'rejected')
  assert.equal(nonOwner.reason, 'owner_only')
  assert.equal(settled.length, 1)
})

test('overlay approvalMembers positive: listed member settles; negative: unlisted rejected', () => {
  const settled = []
  const control = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } },
    policyForSession: () => ({
      mode: 'team', owner: 'owner-x',
      approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'listed-1' }],
    }),
  })
  control.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 's-mem', agentId: 's-mem',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'listed-1', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'listed-1' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: () => { settled.push('settled'); return true },
  })

  // Listed member settles
  const listed = control.handle({
    eventId: 'mem-ok', command: 'approval', approvalKey: 'ap:mem',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'listed-1', sessionId: 's-mem', policyVersion: '1',
  })
  assert.equal(listed.status, 'accepted')
  assert.equal(settled.length, 1)

  // Unlisted member — use a pending row with unlisted userId to test overlay auth
  const control2 = createControlEntry({
    now: () => 150,
    policy: { channel: 'telegram', accountId: 'tg-app', capabilities: { approve: true } },
    policyForSession: () => ({
      mode: 'team', owner: 'owner-x',
      approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'listed-1' }],
    }),
  })
  control2.register('approval', {
    getPending: () => ({
      status: 'pending', sessionId: 's-mem2', agentId: 's-mem2',
      channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
      userId: 'unlisted-99', policyVersion: '1', createdAt: 100, expiresAt: 1000,
      pushedTo: [{ channel: 'telegram', chatId: 'tg-chat', userId: 'unlisted-99' }],
    }),
    buildEvent: (input, row) => ({
      eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
      channel: row.channel, accountId: row.accountId, userId: row.userId,
      chatId: row.chatId, policyVersion: row.policyVersion,
      command: 'approval', createdAt: row.createdAt, expiresAt: row.expiresAt,
    }),
    settle: () => { settled.push('settled'); return true },
  })
  const unlisted = control2.handle({
    eventId: 'mem-no', command: 'approval', approvalKey: 'ap:mem',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'unlisted-99', sessionId: 's-mem2', policyVersion: '1',
  })
  assert.equal(unlisted.status, 'rejected')
  assert.equal(unlisted.reason, 'member_not_allowed')
  assert.equal(settled.length, 1)
})

// Overlay never grants steer or ordinary-message.
test('overlay does not grant steer or ordinary-message to team members', () => {
  const settled = []
  const pendingRow = {
    status: 'pending', sessionId: 's-cmd', agentId: 's-cmd',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'listed-1', policyVersion: '1', createdAt: 100, expiresAt: 1000,
  }
  const control = createControlEntry({
    now: () => 150,
    policy: {
      channel: 'telegram', accountId: 'tg-app', userId: 'listed-1',
      capabilities: { converse: false, approve: true },
    },
    policyForSession: () => ({
      mode: 'team', owner: 'owner-x',
      approvalMembers: [{ channel: 'telegram', accountId: 'tg-app', userId: 'listed-1' }],
    }),
  })
  // Register handlers for all commands that need pending rows
  for (const command of ['approval', 'steer', 'ordinary-message']) {
    control.register(command, {
      getPending: () => pendingRow,
      buildEvent: (input, row) => ({
        eventId: input.eventId, sessionId: row.sessionId, source: 'mobile',
        channel: row.channel, accountId: row.accountId, userId: input.userId ?? row.userId,
        chatId: row.chatId, policyVersion: row.policyVersion,
        command: input.command, createdAt: row.createdAt, expiresAt: row.expiresAt,
      }),
      settle: () => { settled.push(command); return true },
    })
  }

  // steer is rejected even with overlay team member
  const steer = control.handle({
    eventId: 'cmd-steer', command: 'steer',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'listed-1', sessionId: 's-cmd', policyVersion: '1',
  })
  assert.equal(steer.status, 'rejected')
  assert.equal(steer.reason, 'conversation_disabled')

  // ordinary-message rejected
  const ordinary = control.handle({
    eventId: 'cmd-ord', command: 'ordinary-message',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'listed-1', sessionId: 's-cmd', policyVersion: '1',
  })
  assert.equal(ordinary.status, 'rejected')
  assert.equal(ordinary.reason, 'conversation_disabled')

  // approval still works
  const approval = control.handle({
    eventId: 'cmd-approval', command: 'approval',
    channel: 'telegram', accountId: 'tg-app', chatId: 'tg-chat',
    userId: 'listed-1', sessionId: 's-cmd', policyVersion: '1',
  })
  assert.equal(approval.status, 'accepted')
  assert.deepEqual(settled, ['approval'])
})
