// dsh-notifier v0.15 Stage 2 — acceptance contract (2A / 2B core).
//
// This suite is the executable evidence for the Stage 2 acceptance cases that are *not*
// already owned by a dedicated suite (cloud/portability/UI have their own). Each test is
// tagged with its acceptance id from `acceptance/STAGE2_ACCEPTANCE.json`:
//
//   A01  each durable fact has exactly one writer authority
//   A02  private chat current task is never implicitly selected
//   A03  admin actor and chat principal are distinct trust paths
//   I01  claim survives crash window; external effect is not blindly repeated
//   R01  old runtime generation cannot update current health
//   R02  credential clear closes new admission
//   D01  accepted != confirmed
//   D02  timeout/uncertain is not blindly retried
//   D03  partial segmented send does not replay the whole message
//
// C01–C04 / P01 / K01 / K02 are proven by their own suites
// s13-config-portability, the ui-dom K-suite); this file deliberately does not duplicate them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from '../src/inbound/store.mjs'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createPrivateChatView } from '../src/native/private-chat-view.mjs'
import { createCurrentTaskAuthority, currentTaskKey } from '../src/routing/current-task.mjs'
import { defineStatefulSender } from '../src/adapters/sender.mjs'
import { normalizeDeliveryEvidence, isConfirmedReceipt } from '../src/delivery-evidence.mjs'
import { retryAdviceOf, RETRY_ADVICE, sendWithRetry } from '../src/routing.mjs'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const readSrc = (rel) => readFileSync(join(SRC, rel), 'utf8')
const tempState = () => join(mkdtempSync(join(tmpdir(), 'dsh-s2-acc-')), 'state.json')

// ——————————————————————————— A01 ———————————————————————————

test('A01: the conversation-bindings fact has exactly one writer authority', () => {
  // The former writer (inbound/conversation.mjs) no longer touches the durable write surface...
  const conversation = readSrc('inbound/conversation.mjs')
  assert.doesNotMatch(conversation, /\b(?:setDurable|deleteDurable|mergeDurable|transactDurable|transactOutcome)\s*\(/,
    'conversation must not write the store directly anymore')
  assert.doesNotMatch(conversation, /\bstore\.(?:set|delete|transact|sweepPrefix)\s*\(/,
    'conversation must not reach the raw generic store surface')

  // ...only routing/current-task.mjs may. It is the single writer for `bind:<channel>:<userId>`.
  const currentTask = readSrc('routing/current-task.mjs')
  assert.match(currentTask, /\bsetDurable\s*\(/)
  assert.match(currentTask, /\bdeleteDurable\s*\(/)

  // The key has one constructor, used by both the writer and the readers.
  assert.equal(currentTaskKey('telegram', '42'), 'bind:telegram:default:42')
  assert.equal(currentTaskKey('  TELEGRAM ', ' 42 '), 'bind:telegram:default:42', 'key components are normalized')
  assert.equal(currentTaskKey('', '42'), null, 'a missing component is not a valid principal')
})

test('A01: the current-task authority round-trips through the durable store', () => {
  const store = createStore(tempState())
  const authority = createCurrentTaskAuthority({ store })
  assert.equal(authority.get({ channel: 'telegram', userId: '42' }), null, 'no explicit choice → nothing')
  assert.deepEqual(authority.select({ channel: 'telegram', userId: '42' }, 'task-1'), { ok: true, taskRef: 'task-1' })
  assert.equal(authority.get({ channel: 'telegram', userId: '42' }), 'task-1')
  // A restart reads the same durable fact (no in-memory shadow).
  const restarted = createCurrentTaskAuthority({ store })
  assert.equal(restarted.get({ channel: 'telegram', userId: '42' }), 'task-1')
  assert.deepEqual(restarted.clear({ channel: 'telegram', userId: '42' }), { ok: true, existed: true })
  assert.equal(restarted.get({ channel: 'telegram', userId: '42' }), null)
  assert.deepEqual(restarted.select({ channel: 'telegram', userId: '42' }, '  '), { ok: false, reason: 'invalid' },
    'an empty ref is a rejection, not a silent clear')
})

// ——————————————————————————— A02 ———————————————————————————

test('A02: the router never selects a current task implicitly', () => {
  const router = createAgentRouter({
    store: { get: () => undefined },
    agentsList: () => [{ id: 'a1', status: 'idle' }],
  })
  // One candidate is still no choice.
  assert.deepEqual(router.resolveInbound('telegram', 'u1'), { sessionId: null, source: 'none', ambiguous: false })
})

test('A02: the private-chat view shows no current task without an explicit selection', () => {
  const view = createPrivateChatView({
    members: { list: () => [{ key: 'telegram:o', channel: 'telegram', userId: '1', role: 'owner' }], listPending: () => [] },
    tasks: { list: () => [{ taskRef: 'task-1', workspace: 'dsh-notifier', attention: true }] },
  })
  const summary = view.summary()
  assert.equal(summary.currentTask, undefined, 'an attention/recent task is never the current task')
  assert.equal(summary.setup.step, 'task', 'the wizard still asks the user to choose')
})

// ——————————————————————————— A03 ———————————————————————————

test('A03: the chat principal is derived from the envelope, never self-reported', () => {
  // wxpusher: a payload-supplied appId is the peer self-reporting; the local accountId wins.
  const wxpusher = readSrc('inbound/wxpusher-callback.mjs')
  assert.match(wxpusher, /accountId/, 'the inbound account id must come from local config')

  // Native admin actions take an opaque id and fail closed when it resolves to nothing —
  // there is no payload field that grants admin.
  const actions = readSrc('native/actions.mjs')
  assert.doesNotMatch(actions, /payload\.(?:role|admin|actor)\b/, 'no payload field may self-declare privilege')
})

// ——————————————————————————— I01 ———————————————————————————

test('I01: a claimed interaction is not re-executed after a restart', () => {
  const store = createStore(tempState())
  const ledger = createInteractionLedger({ keyPrefix: 'act:', store, decisionField: 'outcome' })
  ledger.add('act:1', { kind: 'deploy' })

  const first = ledger.claim('act:1', { by: 'owner' })
  assert.deepEqual(first, { ok: true, claimed: true }, 'the first claim wins durably')

  // Crash + restart: a fresh ledger over the same durable store must not re-claim.
  const restarted = createInteractionLedger({ keyPrefix: 'act:', store, decisionField: 'outcome' })
  assert.deepEqual(restarted.claim('act:1', { by: 'owner' }), { ok: false, reason: 'uncertain' },
    'a claimed row is uncertain, never re-executed')
  assert.equal(restarted.resolve('act:1', 'done'), 'already-claimed',
    'a claimed row cannot be settled by a second path without the explicit claimedSettle door')
})

// ——————————————————————————— R01 ———————————————————————————

test('R01: a stale runtime generation cannot update current health', () => {
  const health = createSurfaceHealth({ window: 20, ttlMs: 0 })
  health.markEpoch('telegram', 2)
  // A late observation captured under the retired generation 1 is dropped.
  health.recordSend({ accepted: ['telegram'], channelEpochs: { telegram: 1 } })
  assert.equal(health.snapshot('telegram').accepted, 0, 'old generation must not count')
  // A current-generation observation counts.
  health.recordSend({ accepted: ['telegram'], channelEpochs: { telegram: 2 } })
  assert.equal(health.snapshot('telegram').accepted, 1)
})

// ——————————————————————————— R02 ———————————————————————————

test('R02: clearing the credential (retire) closes new admission', async () => {
  const sender = defineStatefulSender({
    type: 'demo',
    validate: (cfg) => cfg,
    createRuntime: () => ({ send: async () => ({}) }),
  })
  const resolved = {}
  await sender.send(resolved, {}) // admitted while the credential exists
  assert.equal(sender.retire(resolved), true, 'clearing the credential retires the runtime')
  await assert.rejects(
    () => sender.send(resolved, {}),
    (error) => error?.code === 'CHANNEL_RETIRED' && error?.noRetry === true,
    'after the credential is cleared, new sends are refused and never retried',
  )
})

// ——————————————————————————— D01 ———————————————————————————

test('D01: accepted is never reported as confirmed', () => {
  // A legacy `delivered` (old meaning = send resolved) is only accepted, never confirmed.
  assert.deepEqual(normalizeDeliveryEvidence({ delivered: ['telegram'] }), { accepted: ['telegram'], confirmed: [] })
  // Only an explicit receipt is confirmed.
  assert.deepEqual(normalizeDeliveryEvidence({ accepted: ['telegram'], confirmed: ['telegram'] }),
    { accepted: ['telegram'], confirmed: ['telegram'] })
  assert.equal(isConfirmedReceipt({ confirmed: true }), true)
  assert.equal(isConfirmedReceipt({ receipt: true }), true)
  assert.equal(isConfirmedReceipt(undefined), false, 'a plain resolve is accepted, not confirmed')
})

// ——————————————————————————— D02 / D03 ———————————————————————————

test('D02: timeout/uncertain maps to unknown and is never blindly retried', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT', noRetry: true })
  assert.equal(retryAdviceOf(timeout), RETRY_ADVICE.UNKNOWN)
  assert.equal(retryAdviceOf(Object.assign(new Error('x'), { uncertain: true })), RETRY_ADVICE.UNKNOWN)

  let calls = 0
  await assert.rejects(
    () => sendWithRetry(async () => { calls += 1; throw timeout }, { attempts: 3, backoffMs: 0 }),
    /timeout/,
  )
  assert.equal(calls, 1, 'an uncertain outcome must not be retried')
})

test('D02: provider rate limit waits the provider window instead of hammering', async () => {
  assert.equal(retryAdviceOf(Object.assign(new Error('429'), { retryAfterMs: 1000 })), RETRY_ADVICE.PROVIDER_RATE_LIMIT)
  // safe errors still retry; the advice table drives the decision, not `ok === false`.
  let attempts = 0
  const value = await sendWithRetry(async () => {
    attempts += 1
    if (attempts < 2) throw new Error('transient')
    return 'ok'
  }, { attempts: 3, backoffMs: 0 })
  assert.equal(value, 'ok')
  assert.equal(attempts, 2)
})

test('D03: a partial segmented send is not replayed as a whole message', async () => {
  const partial = Object.assign(new Error('partial delivery'), { noRetry: true })
  assert.equal(retryAdviceOf(partial), RETRY_ADVICE.NO_RETRY)
  let calls = 0
  await assert.rejects(
    () => sendWithRetry(async () => { calls += 1; throw partial }, { attempts: 3, backoffMs: 0 }),
    /partial/,
  )
  assert.equal(calls, 1, 'a partial send must never be retried as a whole message')
})
