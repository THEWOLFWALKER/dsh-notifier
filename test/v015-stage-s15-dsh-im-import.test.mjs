// v0.15 Stage S15 (T23) — dsh-im known-format migration importer.
//
// Acceptance D06–D09 from 04-ACCEPTANCE-AND-REVIEW.md:
//   D06 feishu-legacy/v2, QQ, DingTalk, Telegram sources → one locked fixture per format;
//       unknown format rejected; the source file is never mutated.
//   D07 secretRef ENV masking / non-writable source → the real source is reported; it never
//       claims a fake "write success". No bulk credential scan.
//   D08 imported owner/approvedSenders/session/offset → no privilege elevation, no live
//       waiter migration, no consumption contention.
//   D09 duplicate import / existing-slot conflict / multiple bots → reviewable match, choose
//       an available slot or skip; never silently invent a multi-account model.
//
// These drive the *real* production module `src/control-plane/dsh-im-import.mjs` (no
// re-implementation) plus the real `src/control-surface/service.mjs` for the wiring.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/inbound/store.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createConfigPortabilityService } from '../src/control-plane/config-portability.mjs'
import { createDshImImportService } from '../src/control-plane/dsh-im-import.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'

const SECRET_MARKER = 'LEAK_DETECTOR_7f3a'

const FORMAT_VERSION = { 'feishu-legacy': 1, 'feishu-v2': 2, qq: 1, dingtalk: 1, telegram: 1 }

const doc = (format, { bots = [], ...extra } = {}) => JSON.stringify({
  sourceType: 'dsh-im-bots',
  format,
  formatVersion: FORMAT_VERSION[format],
  bots,
  ...extra,
})

/** Real store + canonical outbound authority + portability + importer. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-import-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const portability = createConfigPortabilityService({ store, outboundConfig, inboundConfig: null, version: '0.15.0' })
  const importer = createDshImImportService({ portability, outboundConfig })
  return { dir, store, outboundConfig, portability, importer }
}

// ————————————————————————— D06 —————————————————————————

test('D06: each known format maps to its locked target type (and never leaks its secret)', () => {
  const r = rig()
  const fixtures = [
    { format: 'feishu-legacy', bot: { name: 'Lark Bot', webhook: `https://open.feishu.cn/${SECRET_MARKER}`, secret: `SEC_${SECRET_MARKER}` }, targetType: 'feishu' },
    { format: 'qq', bot: { name: 'QQ Bot', appId: `APP_${SECRET_MARKER}`, appSecret: `SEC_${SECRET_MARKER}`, userId: 'openid-1' }, targetType: 'qq-bot' },
    { format: 'dingtalk', bot: { name: 'DT Bot', webhook: `https://oapi.dingtalk.com/${SECRET_MARKER}`, secret: `SEC_${SECRET_MARKER}` }, targetType: 'dingtalk' },
    { format: 'telegram', bot: { name: 'TG Bot', botToken: `123456:${SECRET_MARKER}`, chatId: '42' }, targetType: 'telegram' },
  ]
  for (const { format, bot, targetType } of fixtures) {
    const preview = r.importer.preview({ text: doc(format, { bots: [bot] }) })
    assert.equal(preview.dshIm.format, format, `${format} is detected`)
    const mapped = preview.dshIm.bots.find((b) => b.targetType === targetType)
    assert.ok(mapped, `${format} maps onto ${targetType}`)
    assert.equal(JSON.stringify(preview).includes(SECRET_MARKER), false, `${format} never leaks the secret value`)
  }
})

test('D06: feishu-v2 has no outbound equivalent → skip + bridge hint, and produces no channel', () => {
  const r = rig()
  const preview = r.importer.preview({ text: doc('feishu-v2', { bots: [{ name: 'App Bot', appId: 'x', appSecret: 'y' }] }) })
  const bot = preview.dshIm.bots[0]
  assert.equal(bot.targetType, null)
  assert.equal(bot.decision, 'skip')
  assert.equal(bot.reason, 'no-equivalent')
  assert.equal(bot.bridge, true)
  assert.equal(preview.entries.length, 0, 'no portability entry is fabricated for a no-equivalent bot')
})

test('D06: unknown format / sourceType / version fail closed with zero write', () => {
  const r = rig()
  const before = JSON.stringify(r.store.keys())
  assert.throws(() => r.importer.preview({ text: doc('feishu-v3', { bots: [] }) }), (e) => e.code === 'bad-request')
  assert.throws(() => r.importer.preview({ text: JSON.stringify({ sourceType: 'something-else', format: 'telegram', formatVersion: 1, bots: [] }) }),
    (e) => e.code === 'bad-request')
  assert.throws(() => r.importer.preview({ text: doc('telegram', { formatVersion: 2, bots: [] }) }), (e) => e.code === 'bad-request')
  assert.throws(() => r.importer.preview({ text: 'not json' }), (e) => e.code === 'bad-request')
  assert.equal(JSON.stringify(r.store.keys()), before, 'failed detection writes nothing')
})

test('D06: the source string is read-only (detect/plan never mutate it)', () => {
  const r = rig()
  const text = doc('telegram', { bots: [{ name: 'TG', botToken: 't', chatId: 'c' }] })
  const snapshot = String(text)
  r.importer.preview({ text })
  r.importer.preview({ text })
  assert.equal(text, snapshot, 'the original source text is untouched')
})

// ————————————————————————— D07 —————————————————————————

test('D07: inline secret is classified "supply" and its value never enters any preview', () => {
  const r = rig()
  const preview = r.importer.preview({ text: doc('telegram', { bots: [{ name: 'TG', botToken: `123:${SECRET_MARKER}`, chatId: 'c1' }] }) })
  const secret = preview.dshIm.bots[0].secrets.find((s) => s.field === 'botToken')
  assert.equal(secret.source, 'inline')
  assert.equal(secret.requirement, 'supply')
  assert.equal(secret.writable, false)
  assert.equal(JSON.stringify(preview).includes(SECRET_MARKER), false)
})

test('D07: ENV ref is reported as an external reference (reference, writable), never resolved/inlined', () => {
  const r = rig()
  const preview = r.importer.preview({ text: doc('feishu-legacy', { bots: [{ name: 'L', webhook: '${ENV:FEISHU_HOOK}' }] }) })
  const secret = preview.dshIm.bots[0].secrets.find((s) => s.field === 'webhook')
  assert.equal(secret.source, 'env')
  assert.equal(secret.requirement, 'reference')
  assert.equal(secret.writable, true)
  assert.equal(secret.name, 'FEISHU_HOOK')
  // the env reference becomes an externalReference in the document, never a config value
  const ref = preview.externalReferences?.find((x) => x.kind === 'env' && x.name === 'FEISHU_HOOK')
  assert.ok(ref, 'the document lists the env ref as an external reference')
  assert.equal(JSON.stringify(preview).includes('${ENV:'), false, 'no raw env ref is inlined as a value')
})

test('D07: opaque host ref and masked string are non-writable "supply" — never claimed as written', () => {
  const r = rig()
  const text = doc('feishu-legacy', { bots: [{ name: 'L', webhook: 'hs://credential/app/lark-hook', secret: '••••••••abcd' }] })
  const preview = r.importer.preview({ text })
  const webhook = preview.dshIm.bots[0].secrets.find((s) => s.field === 'webhook')
  const secret = preview.dshIm.bots[0].secrets.find((s) => s.field === 'secret')
  assert.equal(webhook.source, 'opaque')
  assert.equal(webhook.requirement, 'supply')
  assert.equal(webhook.writable, false)
  assert.equal(secret.source, 'masked')
  assert.equal(secret.requirement, 'supply')
  assert.equal(secret.writable, false)
  assert.equal(JSON.stringify(preview).includes('lark-hook'), false, 'opaque value never leaks')
})

// ————————————————————————— D08 —————————————————————————

test('D08: owner/approvedSenders/session/offset are dropped at root — no privilege migration', () => {
  const r = rig()
  const text = doc('telegram', {
    owner: 'alice-the-owner',
    approvedSenders: ['bob-approved'],
    session: { sid: 'SESSION_1' },
    offset: 42,
    bots: [{ name: 'TG', botToken: 't', chatId: 'c' }],
  })
  const preview = r.importer.preview({ text })
  assert.deepEqual([...preview.dshIm.droppedRoot].sort(), ['approvedSenders', 'offset', 'owner', 'session'])
  const blob = JSON.stringify(preview)
  assert.equal(blob.includes('alice-the-owner'), false)
  assert.equal(blob.includes('bob-approved'), false)
  assert.equal(blob.includes('SESSION_1'), false)
})

test('D08: live-waiter keys inside a bot (loginContext/tempWebhook/pendingAction) are dropped on sight', () => {
  const r = rig()
  const text = doc('telegram', {
    bots: [{ name: 'TG', botToken: 't', chatId: 'c', loginContext: { token: 'LOGIN_CTX' }, tempWebhook: 'https://temp/', pendingAction: 'approve' }],
  })
  const preview = r.importer.preview({ text })
  const bot = preview.dshIm.bots[0]
  assert.ok(bot.dropped.includes('loginContext'))
  assert.ok(bot.dropped.includes('tempWebhook'))
  assert.ok(bot.dropped.includes('pendingAction'))
  assert.equal(JSON.stringify(preview).includes('LOGIN_CTX'), false, 'no live waiter context migrates')
})

// ————————————————————————— D09 —————————————————————————

test('D09: multiple bots for one slot → exactly one candidate, the rest are reviewable alternatives', () => {
  const r = rig()
  const text = doc('telegram', { bots: [
    { name: 'TG1', botToken: 't1', chatId: 'c1' },
    { name: 'TG2', botToken: 't2', chatId: 'c2' },
  ] })
  const preview = r.importer.preview({ text })
  const tgEntries = preview.entries.filter((e) => e.direction === 'outbound' && e.type === 'telegram')
  assert.equal(tgEntries.length, 1, 'never silently invents a multi-account model')
  assert.equal(preview.dshIm.alternatives.length, 1)
  assert.equal(preview.dshIm.alternatives[0].reason, 'duplicate-slot')
})

test('D09: an existing slot with a differing public config is a reviewable conflict (deselected by default)', () => {
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: 'existing-token', chatId: 'old-chat' })
  const preview = r.importer.preview({ text: doc('telegram', { bots: [{ name: 'TG', botToken: 'new-token', chatId: 'new-chat' }] }) })
  assert.equal(preview.dshIm.bots[0].decision, 'patch', 'the importer sees a non-skip patch situation')
  const entry = preview.entries.find((e) => e.type === 'telegram')
  assert.equal(entry.decision, 'conflict', 'portability flags a differing existing field as a conflict')
  assert.equal(entry.selectedDefault, false, 'a conflict is never auto-applied')
})

test('D06/D09: commit delegates to portability — staged disabled, secret never written, never activated', () => {
  const r = rig()
  const text = doc('telegram', { bots: [{ name: 'TG', botToken: `123:${SECRET_MARKER}`, chatId: 'c1' }] })
  const preview = r.importer.preview({ text })
  const committed = r.importer.commit({
    token: preview.token,
    selections: preview.entries
      .filter((entry) => entry.decision !== 'unsupported')
      .map((entry) => ({ direction: entry.direction, type: entry.type, action: 'apply' })),
  })
  const staged = committed.staged.find((s) => s.direction === 'outbound' && s.type === 'telegram')
  assert.equal(staged.enabled, false, 'imported channel is staged disabled')
  assert.ok(staged.missingCredentials.includes('botToken'), 'the credential is a missing supply, not an imported value')
  assert.equal(JSON.stringify(staged).includes(SECRET_MARKER), false)
  assert.equal(r.store.get('channel:telegram:outbound'), undefined, 'no live canonical key is written')
  assert.equal(r.outboundConfig.describe('telegram').configured, false, 'import never activates the channel')
})

// ————————————————————————— wiring —————————————————————————

function surfaceRig({ dshImImport }) {
  const revision = { current: () => ({ epoch: 0, revision: 0 }), wait: async () => ({ epoch: 0, revision: 0, changed: false }), touch: () => {} }
  const activity = { record: () => {}, list: () => [] }
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: { describe: () => ({ configured: false }) },
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ ok: true }) },
    members: null,
    health: { recordTest: () => {} },
    activity,
    dshImImport,
  })
  return service
}

test('wiring: dshIm.import.preview via the surface; unassembled importer fails closed', async () => {
  const r = rig()
  const surface = surfaceRig({ dshImImport: r.importer })
  const res = await surface.call('dshIm.import.preview', { text: doc('telegram', { bots: [{ name: 'TG', botToken: 't', chatId: 'c' }] }) })
  assert.equal(res.ok, true)
  assert.equal(res.value.dshIm.format, 'telegram')

  const unassembled = surfaceRig({ dshImImport: null })
  const missing = await unassembled.call('dshIm.import.preview', { text: doc('telegram', { bots: [] }) })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'dsh-notifier/not-supported')
})

test('wiring: a missing importer never breaks the core notifier path', async () => {
  const surface = surfaceRig({ dshImImport: null })
  assert.equal((await surface.call('surface.home')).ok, true)
  assert.equal((await surface.call('channels.list')).ok, true)
})