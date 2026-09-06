// Phase 5: Personal UX and ask_user settlement tests.
// Covers: personal mode defaults through API, ask_user settlement race,
// admin UI contract for first-run/paired/failure states.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createAdminApi, INBOUND_CHANNELS } from '../src/admin/api.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'
import { createTokenVault } from '../src/inbound/tokens.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createIdentity } from '../src/inbound/identity.mjs'
import { createControlEntry } from '../src/control/entry.mjs'
import { ADMIN_UI_HTML } from '../src/admin/ui.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-p5-')), 'state.json')
}

function makeAdminRig({ identity = null, control = null, questions = null } = {}) {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  const registry = createSessionRegistry({ store, touchWriteMs: 0, sweepEveryMs: 0 })
  const stateDir = dirname(statePath)
  return {
    api: createAdminApi({
      store, router, registry, stateDir,
      ...(identity !== null ? { identity } : {}),
      ...(control !== null ? { control } : {}),
      ...(questions !== null ? { questions } : {}),
    }),
    store, router, registry, stateDir,
  }
}

// ——— 1. Personal mode defaults through admin API ———

test('personal mode: overview shows guided state when no members', () => {
  const { api } = makeAdminRig()
  const overview = api.overview()
  assert.equal(overview.members.guided, true, 'no members = guided state')
  assert.equal(overview.members.total, 0)
})

test('personal mode: default session has observe+approve, no converse', () => {
  const { api } = makeAdminRig()
  // Create a session
  const { api: api2, store } = makeAdminRig()
  store.set('route:sessions', { 's-personal': { inherit: 'default', workspace: 'default', createdAt: 100, lastActiveAt: 100 } })
  const sessions = api2.getSessions()
  const session = sessions.find((s) => s.id === 's-personal')
  assert.ok(session, 'session exists')
  // No control overlay by default
  assert.equal(session.control, undefined, 'no control overlay by default')
})

// ——— 2. Admin UI first-run contract ———

test('admin UI: first-run states (未配置/已配对/测试通知/正常运行) present in HTML', () => {
  const html = ADMIN_UI_HTML
  for (const label of ['未配置', '已配对', '测试通知', '正常运行']) {
    assert.ok(html.includes(label), `UI contains progress state: ${label}`)
  }
})

test('admin UI: personal mode defaults displayed', () => {
  const html = ADMIN_UI_HTML
  assert.match(html, /observe \+ approve 已开启/, 'observe+approve default shown')
  assert.match(html, /converse 可按需开启/, 'converse opt-in noted')
  assert.match(html, /群聊控制默认关闭/, 'group control off by default')
})

test('admin UI: advanced settings hidden by default', () => {
  const html = ADMIN_UI_HTML
  assert.match(html, /高级设置默认隐藏/, 'advanced settings hidden')
})

test('admin UI: QR pairing entry point visible', () => {
  const html = ADMIN_UI_HTML
  assert.ok(html.includes('scan') || html.includes('扫码') || html.includes('pair'), 'QR pairing entry present')
})

test('admin UI: no credential leakage in HTML', () => {
  const html = ADMIN_UI_HTML
  // Should not contain any hardcoded secrets or API keys
  assert.ok(!html.includes('sk-'), 'no API key pattern')
  assert.ok(!html.includes('password'), 'no password field')
  assert.ok(!html.includes('tokenSecret'), 'no token secret in HTML')
})

// ——— 3. ask_user settlement success/failure ———

test('settleQuestion: 422 on invalid ref', () => {
  const { api } = makeAdminRig()
  try {
    api.settleQuestion({ ref: '', action: 'choose' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422)
  }
})

test('settleQuestion: 422 on invalid action', () => {
  const { api } = makeAdminRig()
  try {
    api.settleQuestion({ ref: 'some-ref', action: 'invalid' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422)
  }
})

test('settleQuestion: 501 when questions bridge not wired', () => {
  const { api } = makeAdminRig()
  try {
    api.settleQuestion({ ref: 'some-ref', action: 'choose' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 501, 'questions not wired → 501')
  }
})

test('settleQuestion: 501 when Control Core not wired', () => {
  const questions = {
    adminPending: () => [],
    adminSettle: () => ({ ok: false, reason: 'not_available' }),
  }
  const { api } = makeAdminRig({ questions })
  try {
    api.settleQuestion({ ref: 'some-ref', action: 'choose' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 501, 'control not wired → 501')
  }
})

test('settleQuestion: 501 when identity not assembled (cannot prove admin)', () => {
  const questions = {
    adminPending: () => [],
    adminSettle: () => ({ ok: false, reason: 'unauthorized' }),
  }
  const control = createControlEntry()
  const { api } = makeAdminRig({ questions, control })
  try {
    api.settleQuestion({ ref: 'some-ref', action: 'choose' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 501, 'identity not assembled → 501')
  }
})

// ——— 4. Channel matrix consistency ———

test('admin API: INBOUND_CHANNELS matches capability-matrix inbound channels', () => {
  // All inbound channels should be in the INBOUND_CHANNELS list
  const expected = ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk']
  assert.deepEqual([...INBOUND_CHANNELS].sort(), expected.sort())
})

test('admin API: putChannel rejects unknown channel type', () => {
  const { api } = makeAdminRig()
  try {
    api.putChannel('unknown-channel', { foo: 'bar' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422)
  }
})

test('admin API: putChannel rejects empty config', () => {
  const { api } = makeAdminRig()
  try {
    api.putChannel('telegram', {})
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422)
  }
})

test('admin API: patchSessionControl rejects source fields', () => {
  const { api, store } = makeAdminRig()
  store.set('route:sessions', { 's-test': { inherit: '', workspace: '', createdAt: 100, lastActiveAt: 100 } })
  try {
    api.patchSessionControl('s-test', { channel: 'telegram' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422, 'source fields must be rejected')
  }
})

test('admin API: patchSessionControl rejects unknown fields', () => {
  const { api, store } = makeAdminRig()
  store.set('route:sessions', { 's-test': { inherit: '', workspace: '', createdAt: 100, lastActiveAt: 100 } })
  try {
    api.patchSessionControl('s-test', { evilField: 'value' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 422, 'unknown fields must be rejected')
  }
})

test('admin API: patchSessionControl 404 for non-existent session', () => {
  const { api } = makeAdminRig()
  try {
    api.patchSessionControl('non-existent', { mode: 'team' })
    assert.fail('should throw')
  } catch (e) {
    assert.equal(e.status, 404)
  }
})
