// v0.15 Stage S16 (T24) — remote URL / phone entry validation.
//
// Acceptance R04 (04-ACCEPTANCE-AND-REVIEW.md) + 06-INTEGRATIONS §Remote/Tunnel:
//   * user-supplied URL must be https, free of embedded username/password, and free of
//     obvious ticket/token/password params — otherwise rejected.
//   * local parse only: no background fetch, no reachability probe (no SSRF surface).
//   * the plain link is always present; the QR payload is the *same* canonical string, so
//     QR and plain link are equivalent (never a QR that points somewhere else).
//
// Drives the real production module `src/control-plane/remote-url.mjs` (no re-implementation)
// plus the real `src/control-surface/service.mjs` for the RPC wiring.

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateRemoteUrl, buildRemoteEntry } from '../src/control-plane/remote-url.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'

// ————————————————————————— R04: reject matrix —————————————————————————

test('R04: a protected https URL is accepted and canonicalized', () => {
  const r = validateRemoteUrl('  HTTPS://Example.COM/panel  ')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://example.com/panel')
  assert.equal(r.hostname, 'example.com')
  const hash = validateRemoteUrl('https://example.com/p#section')
  assert.equal(hash.ok, true)
  assert.equal(hash.url, 'https://example.com/p#section')
})

test('R04: plain http (no TLS) is rejected with reason "no-tls"', () => {
  const r = validateRemoteUrl('http://example.com/panel')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-tls')
})

test('R04: dangerous schemes (javascript/ftp/file/data) are rejected', () => {
  for (const input of ['javascript:alert(1)', 'ftp://example.com/x', 'file:///etc/passwd', 'data:text/html,hi', 'vbscript:msgbox(1)']) {
    const r = validateRemoteUrl(input)
    assert.equal(r.ok, false, `${input} should be rejected`)
    assert.equal(r.reason, 'unsafe-scheme')
  }
})

test('R04: embedded username/password (userinfo) is rejected', () => {
  const r = validateRemoteUrl('https://user:secret@example.com/panel')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'embedded-credentials')
  const u = validateRemoteUrl('https://alice@example.com/')
  assert.equal(u.ok, false)
  assert.equal(u.reason, 'embedded-credentials')
})

test('R04: obvious ticket/token/password query params are rejected; ordinary params pass', () => {
  for (const param of ['ticket', 'token', 'password', 'secret', 'access_token', 'api_key', 'signature']) {
    const r = validateRemoteUrl(`https://example.com/panel?${param}=abc`)
    assert.equal(r.ok, false, `${param} should be rejected`)
    assert.equal(r.reason, 'contains-secret')
  }
  const casing = validateRemoteUrl('https://example.com/?Access_Token=abc')
  assert.equal(casing.ok, false, 'secret param detection is case-insensitive')
  const okc = validateRemoteUrl('https://example.com/panel?tab=settings&page=2')
  assert.equal(okc.ok, true, 'ordinary non-secret query params must not be rejected')
})

test('R04: empty / unparseable / over-length inputs are rejected with stable reasons', () => {
  assert.equal(validateRemoteUrl('').reason, 'empty')
  assert.equal(validateRemoteUrl('   ').reason, 'empty')
  assert.equal(validateRemoteUrl('not a url').reason, 'unparseable')
  assert.equal(validateRemoteUrl('https://').reason, 'unparseable')
  const tooLong = `https://example.com/${'a'.repeat(9000)}`
  assert.equal(validateRemoteUrl(tooLong).reason, 'too-long')
})

// ————————————————————————— QR ⇔ plain-link equivalence —————————————————————————

test('R04: the QR payload is byte-for-byte identical to the plain link (never a divergent target)', () => {
  const entry = buildRemoteEntry('https://example.com/panel?tab=settings')
  assert.equal(entry.ok, true)
  assert.equal(entry.qrPayload, entry.url, 'QR and plain link must be the same string')
  assert.equal(entry.qrSupported, false, 'no browser-side QR renderer is claimed by the core')
  const rejected = buildRemoteEntry('https://example.com/?ticket=abc')
  assert.equal(rejected.ok, false, 'a secret-bearing URL never reaches QR generation')
})

test('R04: the QR/plain-link equivalence is independent of input whitespace/casing', () => {
  const a = buildRemoteEntry('HTTPS://Example.COM/')
  const b = buildRemoteEntry('https://example.com/')
  assert.equal(a.ok && b.ok, true)
  assert.equal(a.qrPayload, b.qrPayload, 'canonicalization makes both identical')
  assert.equal(a.url, b.url)
})

// ————————————————————————— no network / no side effect —————————————————————————

test('R04: validation performs no network access (a throwing fetch leaves the check untouched)', () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = () => { called = true; throw new Error('must not fetch') }
  try {
    const r = validateRemoteUrl('https://example.com/panel')
    assert.equal(r.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(called, false, 'validateRemoteUrl must never call fetch')
})

test('R04: validation is synchronous and has no durable/observable side effect', () => {
  const before = validateRemoteUrl('https://example.com/a')
  const after = validateRemoteUrl('https://example.com/a')
  assert.deepEqual(before, after, 'pure function: same input, same result, no hidden state')
})

// ————————————————————————— RPC wiring —————————————————————————

function surfaceRig() {
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
  })
  return { service, revision }
}

test('wiring: remote.validate accepts a clean URL and returns the equivalent QR payload', async () => {
  const { service } = surfaceRig()
  const res = await service.call('remote.validate', { url: 'https://example.com/panel' })
  assert.equal(res.ok, true)
  assert.equal(res.value.qrPayload, res.value.url)
  assert.equal(res.value.qrSupported, false)
})

test('wiring: remote.validate surfaces a stable rejection message for a credential URL', async () => {
  const { service } = surfaceRig()
  const res = await service.call('remote.validate', { url: 'https://example.com/?token=abc' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'dsh-notifier/bad-request')
  assert.match(res.error.message, /token|秘密|ticket/)
})

test('wiring: a missing remote capability never breaks the core notifier path', async () => {
  const { service } = surfaceRig()
  assert.equal((await service.call('surface.home')).ok, true)
  assert.equal((await service.call('channels.list')).ok, true)
  assert.equal((await service.call('remote.validate', { url: 'https://example.com/' })).ok, true)
})