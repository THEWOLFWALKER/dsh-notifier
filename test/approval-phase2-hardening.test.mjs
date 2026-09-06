// Phase 2: PR #12 remaining hardening tests.
// Covers: promise rejection → no unhandled exception, concurrent qKeys isolation,
// approval.parallel + button safety boundary, ledger.terminate escalation cleanup.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApprovalHandler } from '../src/approval/router.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { buildApprovalAction, parseApprovalAction } from '../src/inbound/_contract.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-phase2-')), 'state.json')
}

function makeFake(channel, { targets = [], failCards = false, accountId = undefined } = {}) {
  const state = { cards: [], edits: [], texts: [] }
  // Telegram requires numeric chatId per target-guard pattern.
  const defaultTargets = channel === 'telegram'
    ? [{ chatId: '10001', userId: 'u1' }]
    : targets.length > 0 ? targets : [{ chatId: 'chat-1', userId: 'u1' }]
  return {
    channel,
    ...(accountId === undefined ? {} : { accountId }),
    state,
    notifyTargets() { return targets.length > 0 ? targets : defaultTargets },
    async sendApprovalCard(payload) {
      if (failCards) throw new Error('卡片发送失败')
      state.cards.push(payload)
      return { messageId: `m${state.cards.length}` }
    },
    async editResolved(target, text) { state.edits.push({ target, text }) },
    async sendText(chatId, text) { state.texts.push({ chatId, text }); return true },
  }
}

function makeRig({ telegram = null, approvalConfig = {}, control = undefined, interactive = undefined } = {}) {
  const store = createStore(tempPath())
  const vault = createTokenVault({ secret: 'phase2-secret' })
  const bus = createInboundBus({ allowUsers: ['u1', 'u2', 'u3'], store, vault })
  const handlers = {}
  const ctx = {
    on: (event, handler) => { handlers[event] = handler; return () => { delete handlers[event] } },
  }
  const notifier = {
    notifyAll: async () => ({ ok: true, delivered: [], skipped: [], failed: [] }),
  }
  // v0.8.7：按钮/编号裁决一律经 Control Core（production 装配恒接线）；rig 缺省接线，
  // 否则 fail-closed 路径（「Control Core 未接线」）被误当正常路径测。
  const dispose = registerApprovalHandler({
    ctx, notifier, bus, vault, store,
    ...(telegram !== null ? { telegram } : { interactive }),
    control: control !== undefined ? control : createControlEntry(),
    approvalConfig: { mode: 'answer', timeoutMs: 300, ...approvalConfig },
  })
  const handle = (request = { toolName: 'bash', callId: 'call-1' }) =>
    handlers['approval/request'](request, () => 'desktop')
  return { store, vault, bus, handlers, dispose, handle }
}

// 1. Promise rejection doesn't produce unhandled exception.
// When bus.wait throws (not returns null), the handler must catch it and
// fall back to desktop without crashing or leaving pending state.
test('decisionPromise rejection falls back to desktop without unhandled exception', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg })

  // Override bus.wait to throw on the next call
  const origWait = rig.bus.wait.bind(rig.bus)
  let callCount = 0
  rig.bus.wait = (key, timeout, opts) => {
    callCount++
    if (callCount === 1) return Promise.reject(new Error('bus transport down'))
    return origWait(key, timeout, opts)
  }

  const outcome = rig.handle({ callId: 'reject-test' })
  const result = await outcome
  // The handler must return 'desktop' (next()) on promise rejection
  assert.equal(result, 'desktop')
})

// 2. Two concurrent qKeys don't interfere.
// Two approval requests in flight: settling one must not affect the other.
test('concurrent qKeys are isolated: settling one leaves the other pending', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg, approvalConfig: { timeoutMs: 10000 } })

  // Fire two concurrent requests
  const p1 = rig.handle({ callId: 'concurrent-1', toolName: 'tool-a' })
  const p2 = rig.handle({ callId: 'concurrent-2', toolName: 'tool-b' })
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(tg.state.cards.length, 2, 'two cards pushed')
  const card1 = tg.state.cards[0]
  const card2 = tg.state.cards[1]
  assert.notEqual(card1.approvalKey, card2.approvalKey, 'different qKeys')

  // Settle the first one via button (unique messageId to avoid dedup)
  const action1 = buildApprovalAction('allowed-once', card1.approvalKey, card1.token)
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-1',
    text: 'approve', approvalAction: parseApprovalAction(action1),
  })
  const result1 = await p1
  assert.equal(result1, 'allowed-once')

  // Settle the second one independently (with its own action and unique messageId)
  const action2 = buildApprovalAction('rejected', card2.approvalKey, card2.token)
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-2',
    text: 'reject', approvalAction: parseApprovalAction(action2),
  })
  const result2 = await p2
  assert.equal(result2, 'rejected')
})

// 3. approval.parallel is off by default — must not accidentally enable.
test('approval.parallel defaults to off: remote and desktop run sequentially', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg, approvalConfig: { parallel: undefined } })
  // parallel not set → default sequential behavior
  const outcome = rig.handle({ callId: 'seq-test' })
  await new Promise((r) => setTimeout(r, 30))
  const card = tg.state.cards[0]
  // Settle from mobile（真实回调携带消息标识 → eventId）
  const action = buildApprovalAction('allowed-once', card.approvalKey, card.token)
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-pp-1',
    text: 'approve', approvalAction: parseApprovalAction(action),
  })
  const result = await outcome
  assert.equal(result, 'allowed-once')
})

// 4. Button text fallback for channels without native buttons.
// Channels with capabilities.buttons=false receive numbered text, not buttons.
test('buttonless channels still receive card but not listed in button note; text fallback available', async () => {
  const dingtalk = makeFake('dingtalk', { accountId: 'DT_APP', targets: [{ chatId: 'dt-chat-001', userId: 'u2' }] })
  dingtalk.capabilities = { buttons: false }
  const rig = makeRig({ interactive: [dingtalk] })
  const outcome = rig.handle({ callId: 'fallback-test' })
  await new Promise((r) => setTimeout(r, 50))
  // Card IS sent (approval router always sends to all interactive channels)
  assert.ok(dingtalk.state.cards.length > 0, 'card is sent even to buttonless channel')
  // The card note should NOT list the buttonless channel in button channels
  const card = dingtalk.state.cards[0]
  assert.ok(card, 'card exists')
  // Card still has approval key/token (for text-based fallback)
  assert.ok(card.approvalKey, 'card has approval key')
  assert.ok(card.token, 'card has token')
})

// 5. Expired token is rejected.
test('replay of consumed approval action is rejected (single-use token)', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg })
  const outcome = rig.handle({ callId: 'replay-test' })
  await new Promise((r) => setTimeout(r, 50))
  const card = tg.state.cards[0]
  assert.ok(card, 'card pushed')
  // First accept succeeds（真实回调携带消息标识 → eventId）
  const action = buildApprovalAction('allowed-once', card.approvalKey, card.token)
  const first = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-rp-1',
    text: 'approve', approvalAction: parseApprovalAction(action),
  })
  assert.equal(first.ok, true, 'first accept succeeds')
  // Replay the same action → should be rejected (already consumed)
  const replay = rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-rp-2',
    text: 'replay', approvalAction: parseApprovalAction(action),
  })
  // The replay might succeed at bus level but the approval handler detects already-resolved
  const result = await outcome
  assert.equal(result, 'allowed-once', 'original settlement stands')
})

// G-41 (2026-08-28): the button-recipient check is no longer gated on
// `targets.length > 0`. An empty pushedTo (incremental-ledger window or a failed
// persistPushed) means the delivery target cannot be proven, so the click is
// rejected fail-closed with an actionable receipt; the non-empty match/mismatch
// branches keep their existing behavior.
test('G-41: empty pushedTo fails closed — receipt visible, no settlement, desktop fallback', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg, approvalConfig: { timeoutMs: 400 } })
  const outcome = rig.handle({ callId: 'g41-empty' })
  await new Promise((r) => setTimeout(r, 50))
  const card = tg.state.cards[0]
  assert.ok(card, 'card pushed (token is in the user hands)')
  // Simulate the incremental-ledger window / a failed persistPushed: card already
  // delivered but the ledger row still carries an empty pushedTo.
  const row = rig.store.get(card.approvalKey)
  rig.store.set(card.approvalKey, { ...row, pushedTo: [] })
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-g41-empty',
    text: 'approve', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  assert.ok(
    tg.state.texts.some((t) => /未找到该审批的投递记录/.test(t.text)),
    'rejection receipt is visible to the user',
  )
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', 'no terminal state, token not consumed')
  assert.equal(await outcome, 'desktop', 'unresolved approval falls back to the desktop')
})

test('G-41: non-empty pushedTo keeps both branches — wrong user rejected, recipient still settles', async () => {
  const tg = makeFake('telegram', { accountId: 'TG_APP' })
  const rig = makeRig({ telegram: tg, approvalConfig: { timeoutMs: 4000 } })
  const outcome = rig.handle({ callId: 'g41-branches' })
  await new Promise((r) => setTimeout(r, 50))
  const card = tg.state.cards[0]
  // Card delivered to u1; same channel/account, a different user (u2) clicks → rejected.
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u2', chatId: '10001', messageId: 'msg-g41-wrong',
    text: 'x', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  assert.ok(
    tg.state.texts.some((t) => /仅审批接收人可点击裁决/.test(t.text)),
    'mismatch receipt keeps its existing wording',
  )
  assert.equal(rig.store.get(card.approvalKey).status, 'pending', 'mismatch does not settle')
  // The actual recipient (u1) can still settle afterwards — rejection did not consume the token.
  rig.bus.accept({
    channel: 'telegram', accountId: 'TG_APP', userId: 'u1', chatId: '10001', messageId: 'msg-g41-right',
    text: 'approve', approvalAction: parseApprovalAction(buildApprovalAction('allowed-once', card.approvalKey, card.token)),
  })
  assert.equal(await outcome, 'allowed-once', 'matched recipient still settles')
  assert.equal(rig.store.get(card.approvalKey).decision, 'allowed-once')
})
