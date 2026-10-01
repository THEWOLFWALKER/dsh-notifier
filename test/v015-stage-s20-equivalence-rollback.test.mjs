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

import { CHANNEL_TYPES } from '../src/config.mjs'
import { createStore, setDurable } from '../src/inbound/store.mjs'
import {
  migrateCanonicalChannelConfig,
  STATE_SCHEMA_KEY,
  V013_MIGRATION_KEY,
  STATE_SCHEMA_VERSION,
} from '../src/control-surface/channel-config-migration.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createInteractionLedger } from '../src/interaction/ledger.mjs'

// `<type>:account` is also the inbound credential domain for these two; it is never an
// outbound Admin overlay, so migration must not copy it into the canonical outbound key.
const DUAL_INBOUND_DOMAIN = new Set(['feishu', 'dingtalk'])

const canonicalKey = (type) => `channel:${type}:outbound`
const adminKey = (type) => `admin:channel:${type}:outbound`
const accountKey = (type) => `${type}:account`

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

// ————————————————————————— L02a equivalence matrix —————————————————————————

test('L02a: every outbound channel type migrates with a classified, fully explained difference', () => {
  const store = freshStore()
  const expected = new Map()

  CHANNEL_TYPES.forEach((type, index) => {
    const slot = index % 3
    if (slot === 0) {
      // legacy Admin overlay only → must be copied into the canonical key
      setDurable(store, adminKey(type), legacyValue(type, 'admin'))
      expected.set(type, { kind: 'copied-from-admin', value: legacyValue(type, 'admin') })
    } else if (slot === 1 && !DUAL_INBOUND_DOMAIN.has(type)) {
      // non-dual `<type>:account` historically served as the Admin overlay → copied
      setDurable(store, accountKey(type), legacyValue(type, 'account'))
      expected.set(type, { kind: 'copied-from-account', value: legacyValue(type, 'account') })
    } else if (slot === 1) {
      // dual-domain channel: canonical outbound stays absent — a declared rule, not a diff
      setDurable(store, accountKey(type), legacyValue(type, 'account'))
      expected.set(type, { kind: 'dual-domain-kept', value: null })
    } else {
      // canonical already authoritative → legacy must never overwrite it
      setDurable(store, canonicalKey(type), legacyValue(type, 'canonical'))
      setDurable(store, adminKey(type), legacyValue(type, 'admin'))
      expected.set(type, { kind: 'canonical-wins', value: legacyValue(type, 'canonical') })
    }
  })

  const first = migrateCanonicalChannelConfig({ store, channelTypes: [...CHANNEL_TYPES], adminEnabled: true })
  assert.equal(first.ok, true)
  assert.equal(first.already, false)

  const unexplained = []
  for (const type of CHANNEL_TYPES) {
    const want = expected.get(type)
    const got = store.get(canonicalKey(type))
    if (want.value === null) {
      if (got !== undefined) unexplained.push(`${type}: expected no canonical outbound, got ${JSON.stringify(got)}`)
      continue
    }
    if (JSON.stringify(got) !== JSON.stringify(want.value)) {
      unexplained.push(`${type} (${want.kind}): expected ${JSON.stringify(want.value)}, got ${JSON.stringify(got)}`)
    }
  }
  assert.deepEqual(unexplained, [], 'every difference must match a declared classification')

  // Every retired Admin overlay is gone; the deferred-completion guard can never revive it.
  for (const type of CHANNEL_TYPES) {
    assert.equal(store.get(adminKey(type)), undefined, `${adminKey(type)} must be retired`)
  }
  assert.equal(store.get(STATE_SCHEMA_KEY), STATE_SCHEMA_VERSION)
  assert.equal(store.get(V013_MIGRATION_KEY)?.status, 'complete')
  assert.equal(store.get(V013_MIGRATION_KEY)?.migrated.length, first.migrated.length)
})

test('L02a: a re-run of the migration is a no-op (idempotent, byte-stable)', () => {
  const store = freshStore()
  setDurable(store, adminKey('telegram'), legacyValue('telegram', 'admin'))
  migrateCanonicalChannelConfig({ store, channelTypes: ['telegram'], adminEnabled: true })
  const after = JSON.stringify(snapshotOf(store))

  const second = migrateCanonicalChannelConfig({ store, channelTypes: ['telegram'], adminEnabled: true })
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(JSON.stringify(snapshotOf(store)), after, 'a second migration changes nothing')
})

// ————————————————————————— L02b rollback drill —————————————————————————

test('L02b: configuration and members written during the switch window survive a rollback', () => {
  const store = freshStore()
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const identity = createIdentity({ store })

  // Writes made *during* the switch window (before any rollback).
  outboundConfig.save('telegram', { botToken: 't'.repeat(24), chatId: 'switch-window-chat' })
  identity.addBinding({ channel: 'telegram', userId: 'u-switch', label: 'switch', origin: 'paired' })

  // A rollback re-runs the one-way migration over the same state (this is the dangerous step:
  // a naive migration could drop or overwrite what the newer writer just committed).
  const drill = migrateCanonicalChannelConfig({ store, channelTypes: [...CHANNEL_TYPES], adminEnabled: false })
  assert.equal(drill.ok, true)

  // The canonical key is the shared read path: both the new authority and a re-assembled
  // reader resolve the same effective configuration.
  assert.equal(store.get(canonicalKey('telegram'))?.chatId, 'switch-window-chat')
  const reRead = createOutboundConfigService({ store, yamlRows: new Map(), source: createOutboundSource([]), allowLegacy: false })
  assert.equal(reRead.raw('telegram')?.chatId, 'switch-window-chat', 'rollback keeps the switch-window config')

  const members = createIdentity({ store }).list('telegram')
  assert.equal(members.some((row) => row.userId === 'u-switch'), true, 'rollback keeps the switch-window member')
})

// ————————————————————————— L02c claimed / uncertain are never replayed —————————————————————————

test('L02c: a claimed row is not replayed after a restart/rollback', () => {
  const store = freshStore()
  const ledger = createInteractionLedger({ keyPrefix: 'ap:', store })
  ledger.add('ap:claimed', { channel: 'telegram', userId: 'u1' })
  assert.deepEqual(ledger.claim('ap:claimed'), { ok: true, claimed: true })

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