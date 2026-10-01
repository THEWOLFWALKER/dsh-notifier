// v0.15 Stage S13 (T21) — local configuration export / import (portability).
//
// Acceptance E01–E06 from 04-ACCEPTANCE-AND-REVIEW.md:
//   E01 export contains no secret field / URL token; descriptors mark "to supply".
//   E02 normalised export → clean fixture → import: identical except the explicit
//       disable-import rule and the omitted secrets / machine references.
//   E03 wrong version / prototype pollution / illegal types / over-limit → rejected
//       before any preview, with zero write and zero network.
//   E04 cancel → zero mutation; duplicate import is idempotent; overwrite needs an
//       explicit choice.
//   E05 staging failure → the disabled staging is never active and no old/shared
//       credential is deleted.
//   E06 (UI) download / clipboard fallback lives in the client DOM suite.
//
// Oracles are a real store (temp file) + real outbound/inbound authorities.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createConfigPortabilityService } from '../src/control-plane/config-portability.mjs'

const SECRET = 'tg-secret-token-abcdef123456'
const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-portability-'))
  const file = join(dir, 'state.json')
  return { dir, file, initial }
}

/** Real store + canonical authorities + portability service (frozen clock). */
function rig(initial = undefined) {
  const { dir, file } = tempState(initial)
  const store = createStore(file)
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const inboundConfig = createInboundChannelConfigPort({ store })
  const portability = createConfigPortabilityService({
    store,
    outboundConfig,
    inboundConfig,
    version: '0.13.1',
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  })
  return { dir, store, source, outboundConfig, inboundConfig, portability }
}

/** A transaction-failing mock store: the Nth transact call is rejected. */
function failingStore({ initial = {}, failAt = [] } = {}) {
  let memory = { ...initial }
  let calls = 0
  const failing = new Set(failAt)
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      calls += 1
      if (failing.has(calls)) return { ok: false, committed: false, durable: false, code: 'STATE_WRITE_FAILED' }
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

function exportText(rigged) {
  const result = rigged.portability.exportConfig({ scopes: ['channels'] })
  return JSON.stringify(result.document)
}

// ————————————————————————— E01 —————————————————————————

test('E01: export carries no secret field, no URL token, and no masked string', () => {
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: SECRET, chatId: '123456', apiBase: 'https://botuser:botpass@api.telegram.org/base?token=leaked-token&keep=1' })
  const result = r.portability.exportConfig({})
  const text = JSON.stringify(result.document)

  assert.equal(text.includes(SECRET), false, 'the secret value never appears in the document')
  assert.equal(text.includes('botpass'), false, 'the URL userinfo secret part is dropped')
  assert.equal(text.includes('leaked-token'), false, 'a secret-shaped query param is dropped')
  assert.equal(text.includes('******'), false, 'no masked credential is exported as a value')

  const telegram = result.document.channels.find((c) => c.direction === 'outbound' && c.type === 'telegram')
  assert.equal(telegram.config.chatId, '123456', 'public field survives')
  assert.equal(telegram.config.botToken, undefined, 'secret field is omitted from config')
  assert.equal(telegram.config.apiBase, 'https://api.telegram.org/base?keep=1', 'URL keeps only the non-secret part')

  const descriptor = result.document.credentialDescriptors.find((d) => d.type === 'telegram' && d.field === 'botToken')
  assert.equal(descriptor?.requirement, 'supply', 'a plain credential is marked "to supply"')
})

test('E01: an env reference is reported as an external reference, not a config value', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'resolved-at-runtime-not-exported'
  try {
    const r = rig()
    r.outboundConfig.save('telegram', { botToken: '${ENV:TELEGRAM_BOT_TOKEN}', chatId: '9' })
    const result = r.portability.exportConfig({})
    const text = JSON.stringify(result.document)
    assert.equal(text.includes('${ENV:'), false, 'the raw env reference is not inlined as a config value')
    assert.equal(text.includes('resolved-at-runtime-not-exported'), false, 'the resolved env value never leaves the process')
    const ref = result.document.externalReferences.find((x) => x.type === 'telegram' && x.field === 'botToken')
    assert.equal(ref?.kind, 'env')
    assert.equal(ref?.name, 'TELEGRAM_BOT_TOKEN')
    const descriptor = result.document.credentialDescriptors.find((d) => d.type === 'telegram' && d.field === 'botToken')
    assert.equal(descriptor?.requirement, 'reference', 'a referenced credential is marked "reference"')
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN
  }
})

// ————————————————————————— E02 —————————————————————————

test('E02: export → clean store import is identical except secrets / refs / disable rule', () => {
  const source = rig()
  source.outboundConfig.save('telegram', { botToken: SECRET, chatId: '123456' })
  source.inboundConfig.put('wxpusher', { appToken: 'wx-secret-token', accountId: 'acct-1' })
  const text = exportText(source)

  const target = rig()
  const preview = target.portability.previewImport({ text })
  assert.equal(preview.summary.add, 2, 'both configured channels are new (add)')
  assert.equal(preview.entries.every((e) => e.importEnabledEffect === false), true, 'new channels import disabled')

  const committed = target.portability.commitImport({ token: preview.token, selections: [] })
  const staged = committed.staged
  const tg = staged.find((s) => s.direction === 'outbound' && s.type === 'telegram')
  assert.equal(tg.enabled, false, 'a staged channel is disabled (never active)')
  assert.deepEqual(tg.config, { chatId: '123456' }, 'public config matches; the secret is omitted')
  assert.ok(tg.missingCredentials.includes('botToken'))
  const wx = staged.find((s) => s.direction === 'inbound' && s.type === 'wxpusher')
  assert.deepEqual(wx.config, { accountId: 'acct-1' }, 'inbound public config round-trips')

  // Nothing was silently activated: no canonical outbound key for the new channel.
  assert.equal(target.store.get('channel:telegram:outbound'), undefined, 'import never writes the live canonical key for a new channel')
  assert.equal(target.outboundConfig.describe('telegram').configured, false, 'the new channel stays unconfigured/unactive')
})

// ————————————————————————— E03 —————————————————————————

test('E03: wrong documentType / version is rejected before any preview', () => {
  const r = rig()
  assert.throws(() => r.portability.previewImport({ text: JSON.stringify({ documentType: 'other', formatVersion: 1, channels: [] }) }),
    (e) => e.code === 'bad-request')
  assert.throws(() => r.portability.previewImport({ text: JSON.stringify({ documentType: 'dsh-notifier-config', formatVersion: 2, channels: [] }) }),
    (e) => e.code === 'bad-request')
  assert.throws(() => r.portability.previewImport({ text: JSON.stringify({ documentType: 'dsh-notifier-config', formatVersion: '1', channels: [] }) }),
    (e) => e.code === 'bad-request', 'a string version is not the number 1')
})

test('E03: prototype-pollution keys are rejected (zero write)', () => {
  const r = rig()
  const before = JSON.stringify(r.store.keys().map((k) => [k, r.store.get(k)]))
  const text = '{"documentType":"dsh-notifier-config","formatVersion":1,"channels":[{"direction":"outbound","type":"telegram","config":{"__proto__":{"polluted":true}}}]}'
  assert.throws(() => r.portability.previewImport({ text }), (e) => e.code === 'bad-request')
  const after = JSON.stringify(r.store.keys().map((k) => [k, r.store.get(k)]))
  assert.equal(after, before, 'a rejected file writes nothing')
  assert.equal({}.polluted, undefined, 'no prototype pollution leaked into Object.prototype')
})

test('E03: over-limit (200 items) and non-JSON bodies are rejected', () => {
  const r = rig()
  const channels = []
  for (let i = 0; i < 201; i += 1) channels.push({ direction: 'outbound', type: `fake-${i}`, config: {} })
  assert.throws(() => r.portability.previewImport({ text: JSON.stringify({ documentType: 'dsh-notifier-config', formatVersion: 1, channels }) }),
    (e) => e.code === 'bad-request')
  assert.throws(() => r.portability.previewImport({ text: 'not json at all' }), (e) => e.code === 'bad-request')
})

// ————————————————————————— E04 —————————————————————————

test('E04: cancel writes nothing and drops the preview', () => {
  const r = rig()
  const source = rig()
  source.outboundConfig.save('telegram', { botToken: SECRET, chatId: '1' })
  const text = exportText(source)
  const preview = r.portability.previewImport({ text })
  const before = JSON.stringify(r.store.keys())
  const cancelled = r.portability.cancelImport({ token: preview.token })
  assert.equal(cancelled.cancelled, true)
  assert.equal(JSON.stringify(r.store.keys()), before, 'cancel is a zero-mutation operation')
  assert.throws(() => r.portability.commitImport({ token: preview.token, selections: [] }), (e) => e.code === 'not-found')
})

test('E04: importing the same document twice is idempotent (staging keys do not multiply)', () => {
  const source = rig()
  source.outboundConfig.save('telegram', { botToken: SECRET, chatId: '1' })
  const text = exportText(source)
  const r = rig()
  const first = r.portability.previewImport({ text })
  r.portability.commitImport({ token: first.token, selections: [] })
  const second = r.portability.previewImport({ text })
  r.portability.commitImport({ token: second.token, selections: [] })
  assert.equal(r.portability.listStaged().length, 1, 'repeat import overwrites the same staging key')
})

test('E04: an existing channel change needs an explicit selection (conflict is not auto-applied)', () => {
  const target = rig()
  target.outboundConfig.save('telegram', { botToken: 'existing-token', chatId: 'old-chat' })
  const source = rig()
  source.outboundConfig.save('telegram', { botToken: SECRET, chatId: 'new-chat' })
  const text = exportText(source)

  const preview = target.portability.previewImport({ text })
  const entry = preview.entries.find((e) => e.type === 'telegram')
  assert.equal(entry.decision, 'conflict', 'a differing existing field is a conflict')
  assert.equal(entry.selectedDefault, false, 'a conflict is not selected by default')

  target.portability.commitImport({ token: preview.token, selections: [] })
  assert.equal(target.outboundConfig.raw('telegram').chatId, 'old-chat', 'deselecting keeps the current value')

  const again = target.portability.previewImport({ text })
  target.portability.commitImport({
    token: again.token,
    selections: [{ direction: 'outbound', type: 'telegram', action: 'apply', patch: { chatId: 'new-chat' } }],
  })
  assert.equal(target.outboundConfig.raw('telegram').chatId, 'new-chat', 'an explicit selection applies the patch')
  assert.equal(target.outboundConfig.raw('telegram').botToken, 'existing-token', 'existing secret is kept by default')
})

// ————————————————————————— E05 —————————————————————————

test('E05: staging write failure surfaces honestly and never activates anything', () => {
  const source = rig()
  source.outboundConfig.save('telegram', { botToken: SECRET, chatId: '1' })
  const text = exportText(source)

  // First transact is the staging write; make it fail.
  const store = failingStore({ failAt: [1] })
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source: createOutboundSource([]), allowLegacy: false })
  const portability = createConfigPortabilityService({ store, outboundConfig, inboundConfig: null, version: '0.13.1' })
  const preview = portability.previewImport({ text })
  assert.throws(() => portability.commitImport({ token: preview.token, selections: [] }), (e) => e.code === 'storage-failed')
  assert.equal(store.snapshot()['channel:telegram:outbound'], undefined, 'no live canonical key was written')
})

test('E05: staging a new channel preserves existing/shared credentials untouched', () => {
  const target = rig()
  target.outboundConfig.save('telegram', { botToken: 'shared-token', chatId: 'keep' })
  const source = rig()
  source.outboundConfig.save('bark', { key: 'bark-secret', device: 'phone' })
  const text = exportText(source)

  const preview = target.portability.previewImport({ text })
  target.portability.commitImport({ token: preview.token, selections: [] })
  assert.equal(target.outboundConfig.raw('telegram').botToken, 'shared-token', 'an unrelated existing credential is untouched')
  const staged = target.portability.listStaged()
  assert.equal(staged.length, 1)
  assert.equal(staged[0].enabled, false, 'the staged bark row is disabled / not active')
})

// ————————————————————————— read-back —————————————————————————

test('T21: readBack reports the canonical public config and the staged rows', () => {
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: SECRET, chatId: '42' })
  const back = r.portability.readBack()
  const tg = back.channels.find((c) => c.direction === 'outbound' && c.type === 'telegram')
  assert.deepEqual(tg.config, { chatId: '42' }, 'read-back exposes only the public config')
  assert.equal(JSON.stringify(back).includes(SECRET), false, 'read-back never leaks the secret')
})