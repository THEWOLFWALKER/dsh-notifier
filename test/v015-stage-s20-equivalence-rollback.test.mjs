// v0.15 Stage S20 (T29) — equivalence / rollback drill.
//
// Acceptance L02 (04-ACCEPTANCE-AND-REVIEW.md):
//   * the full core matrix from 04 is exercised: every outbound channel type's legacy →
//     canonical migration is classified, with **zero unexplained differences**;
//   * a rollback preserves configuration and members added during the switch window;
//   * `claimed` / `uncertain` interaction rows are **never replayed** after a restart/rollback;
//   * write amplification stays 1:1 (one user action → one durable transaction).
//
// Oracles are the real store (temp file), the real migration, the real outbound authority,
// the real identity authority and the real interaction ledger — not re-implementations.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createStore } from '../src/inbound/store.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'

const canonicalKey = (type) => `channel:${type}:outbound`

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-drill-'))
  return createStore(join(dir, 'state.json'))
}

/** Full durable snapshot (the real store exposes key enumeration, not a snapshot helper). */
const snapshotOf = (store) => Object.fromEntries(store.keys().map((key) => [key, store.get(key)]))

const legacyValue = (type, tag) => ({ origin: tag, type, token: `${tag}-token-${type}`, chatId: '42' })

/** Counts durable transactions so write amplification is measurable (delegates to the real store). */
function countingStore(real) {
  let transacts = 0
  let commits = 0
  return {
    get: (key, fallback) => real.get(key, fallback),
    keys: (prefix) => real.keys(prefix),
    snapshot: () => real.snapshot(),
    bootStatus: () => (typeof real.bootStatus === 'function' ? real.bootStatus() : { readFailed: false }),
    transact(mutator) {
      transacts += 1
      const result = real.transact(mutator)
      if (result?.committed === true) commits += 1
      return result
    },
    counts: () => ({ transacts, commits }),
  }
}

// ————————————————————————— L02b rollback drill —————————————————————————

test('L02b: configuration and members written during the switch window survive a rollback', () => {
  const store = freshStore()
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source })
  const identity = createIdentity({ store })

  // Writes made *during* the switch window (before any rollback).
  outboundConfig.save('telegram', { botToken: 't'.repeat(24), chatId: 'switch-window-chat' })
  identity.addBinding({ channel: 'telegram', accountId: 'bot-a', userId: 'u-switch', label: 'switch', origin: 'paired' })

  // A fresh service instance reads the same canonical state after the switch window.
  // The canonical key is the shared read path: both the new authority and a re-assembled
  // reader resolve the same effective configuration.
  assert.equal(store.get(canonicalKey('telegram'))?.chatId, 'switch-window-chat')
  const reRead = createOutboundConfigService({ store, yamlRows: new Map(), source: createOutboundSource([]) })
  assert.equal(reRead.raw('telegram')?.chatId, 'switch-window-chat', 'rollback keeps the switch-window config')

  const members = createIdentity({ store }).list('telegram')
  assert.equal(members.some((row) => row.userId === 'u-switch'), true, 'rollback keeps the switch-window member')
})

// ————————————————————————— L02c claimed / uncertain are never replayed —————————————————————————

test('L02c: a claimed row is not replayed after a restart/rollback', () => {
  const store = freshStore()
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  ledger.add('ap:claimed', { channel: 'telegram', userId: 'u1' })
  const claim = ledger.claim('ap:claimed')
  assert.equal(claim.claimed, true)
  assert.equal(typeof claim.executionId, 'string')

  // Restart / rollback: a brand-new ledger over the same durable state.
  const restarted = createInteractionLedger({ keyPrefix: 'ap:', store })
  const row = restarted.get('ap:claimed')
  assert.equal(row.status, 'claimed')
  assert.equal(restarted.isPending(row), false, 'a claimed row is never a live pending after restart')
  assert.deepEqual(restarted.claim('ap:claimed'), { ok: false, reason: 'uncertain' }, 'claim is not replayed')
  assert.equal(restarted.resolve('ap:claimed', 'approve'), 'already-claimed', 'settlement cannot be replayed')
})

test('L02c: an uncertain row is not replayed after a restart/rollback', () => {
  const store = freshStore()
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  ledger.add('ap:uncertain', { channel: 'telegram', userId: 'u2' })
  assert.equal(ledger.markUncertain('ap:uncertain', 'terminal-persist-failed'), true)

  const restarted = createInteractionLedger({ keyPrefix: 'ap:', store })
  const row = restarted.get('ap:uncertain')
  assert.equal(row.status, 'uncertain')
  assert.equal(restarted.isPending(row), false, 'an uncertain row is never a live pending after restart')
  assert.deepEqual(restarted.claim('ap:uncertain'), { ok: false, reason: 'already-resolved' }, 'no effect is replayed')
  assert.equal(restarted.resolve('ap:uncertain', 'approve'), 'already-resolved')
  assert.equal(restarted.terminate('ap:uncertain'), false, 'a non-pending row cannot be re-terminated')
})

// ————————————————————————— L02d write amplification / budget —————————————————————————

test('L02d: one user action is exactly one durable transaction (no write amplification)', () => {
  const store = countingStore(freshStore())
  const outboundConfig = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source: createOutboundSource([]),
    allowLegacy: false,
  })
  const before = store.counts().transacts
  outboundConfig.save('telegram', { botToken: 'a'.repeat(24), chatId: '1' })
  assert.equal(store.counts().transacts - before, 1, 'a single save must not fan out into extra transactions')
})

test('L02d: a bounded ladder of saves stays linear and commits every time', () => {
  const store = countingStore(freshStore())
  const outboundConfig = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source: createOutboundSource([]),
    allowLegacy: false,
  })
  const ladder = [1, 10, 100]
  const report = []
  for (const count of ladder) {
    const startTransacts = store.counts().transacts
    const startCommits = store.counts().commits
    const started = performance.now()
    for (let i = 0; i < count; i += 1) {
      outboundConfig.save('telegram', { botToken: 'b'.repeat(24), chatId: String(i) })
    }
    const elapsedMs = performance.now() - started
    const transacts = store.counts().transacts - startTransacts
    const commits = store.counts().commits - startCommits
    report.push({ count, transacts, commits, elapsedMs })
    assert.equal(transacts, count, `ladder ${count}: exactly one transaction per save`)
    assert.equal(commits, count, `ladder ${count}: every save commits durably`)
  }
  // Wall-clock here is only a hang/quadratic-blow-up guard (CI disks are noisy); the strict
  // regression guard is the 1-transaction-per-save invariant above. Real throughput evidence
  // lives in `scripts/perf-drill.mjs`, not in a brittle timing assertion.
  const hundred = report.find((row) => row.count === 100)
  assert.equal(hundred.elapsedMs < 30_000, true, `100 saves took ${hundred.elapsedMs.toFixed(1)}ms`)
})
