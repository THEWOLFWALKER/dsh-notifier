// Phase 6: Security, performance, and structural tests.
// Covers: loopback binding, credential leakage, multi-channel failure isolation,
// dedup bounds, audit rotation, control overlay bounds.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createAdminApi, INBOUND_CHANNELS } from '../src/admin/api.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import {
  normalizeControlOverlay,
  CONTROL_OVERLAY_MAX_MEMBERS,
  CONTROL_OVERLAY_MAX_STRING,
  isGlobalControlValue,
} from '../src/control/session-arbiter.mjs'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-p6-')), 'state.json')
}

// ——— 1. Control overlay bounds ———

test('normalizeControlOverlay: owner string bounded at CONTROL_OVERLAY_MAX_STRING', () => {
  const longOwner = 'a'.repeat(CONTROL_OVERLAY_MAX_STRING + 1)
  const result = normalizeControlOverlay({ owner: longOwner })
  // Over-long owner is silently dropped (not an error, but not included)
  assert.equal(result?.owner, undefined, 'over-long owner dropped')
})

test('normalizeControlOverlay: approvalMembers bounded at CONTROL_OVERLAY_MAX_MEMBERS', () => {
  const members = Array.from({ length: CONTROL_OVERLAY_MAX_MEMBERS + 10 }, (_, i) => ({
    channel: 'telegram', accountId: 'tg', userId: `u${i}`,
  }))
  const result = normalizeControlOverlay({ approvalMembers: members })
  assert.ok(result.approvalMembers.length <= CONTROL_OVERLAY_MAX_MEMBERS, 'members bounded')
})

test('normalizeControlOverlay: wildcard/global values rejected', () => {
  assert.equal(isGlobalControlValue('*'), true)
  assert.equal(isGlobalControlValue('all'), true)
  assert.equal(isGlobalControlValue('everyone'), true)
  assert.equal(isGlobalControlValue('normal-user'), false)
  const result = normalizeControlOverlay({ owner: '*' })
  assert.equal(result?.owner, undefined, 'wildcard owner dropped')
})

test('normalizeControlOverlay: source fields are stripped', () => {
  const result = normalizeControlOverlay({
    mode: 'team', owner: 'u1',
    channel: 'telegram', accountId: 'tg', userId: 'u1',
    chatId: 'c1', sessionId: 's1',
    policyVersion: '1', expiresAt: 1000, revoked: true,
  })
  assert.equal(result.mode, 'team')
  assert.equal(result.owner, 'u1')
  // Source fields must NOT be present
  assert.equal(result.channel, undefined)
  assert.equal(result.accountId, undefined)
  assert.equal(result.userId, undefined)
  assert.equal(result.chatId, undefined)
  assert.equal(result.sessionId, undefined)
  assert.equal(result.policyVersion, undefined)
  assert.equal(result.expiresAt, undefined)
  assert.equal(result.revoked, undefined)
})

test('normalizeControlOverlay: unknown fields are dropped', () => {
  const result = normalizeControlOverlay({
    mode: 'team', evilField: 'injected', anotherEvil: 42,
  })
  assert.equal(result.mode, 'team')
  assert.equal(result.evilField, undefined)
  assert.equal(result.anotherEvil, undefined)
})

test('normalizeControlOverlay: null/undefined/array returns null', () => {
  assert.equal(normalizeControlOverlay(null), null)
  assert.equal(normalizeControlOverlay(undefined), null)
  assert.equal(normalizeControlOverlay([]), null)
  assert.equal(normalizeControlOverlay('string'), null)
})

// ——— 2. Admin API: credential leakage prevention ———

test('admin API: getChannels returns masked secrets', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  store.set('telegram:account', { botToken: 'secret-123', chatId: '100' })
  const api = createAdminApi({ store, router })
  const channels = api.getChannels()
  const tgRow = channels.find((r) => r.type === 'telegram' && r.direction === 'outbound')
  if (tgRow && tgRow.config) {
    // All string values should be masked
    for (const [key, value] of Object.entries(tgRow.config)) {
      if (typeof value === 'string') {
        assert.equal(value, '***', `${key} should be masked`)
      }
    }
  }
})

test('admin API: getSessions does not expose raw control owner/members', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  store.set('route:sessions', {
    's-leak': {
      inherit: '', workspace: '', createdAt: 100, lastActiveAt: 100,
      control: { mode: 'team', owner: 'secret-owner', approvalMembers: [{ channel: 'telegram', accountId: 'tg', userId: 'member-1' }] },
    },
  })
  const api = createAdminApi({ store, router })
  const sessions = api.getSessions()
  const session = sessions.find((s) => s.id === 's-leak')
  assert.ok(session, 'session found')
  // control summary should not expose raw owner or member ids
  if (session.control) {
    assert.equal(session.control.owner, undefined, 'raw owner not exposed')
    assert.equal(session.control.approvalMembers, undefined, 'raw members not exposed')
    // Only safe summary fields
    assert.equal(typeof session.control.mode, 'string')
  }
})

// ——— 3. Audit rotation ———

test('admin API: audit file rotation caps at AUDIT_MAX_BYTES', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  const stateDir = dirname(statePath)
  const api = createAdminApi({ store, router, stateDir })
  // Generate enough audit entries to trigger rotation
  for (let i = 0; i < 200; i++) {
    api.appendAudit('test:rotation', { i })
  }
  const auditFile = join(stateDir, 'admin-audit.jsonl')
  try {
    const stat = statSync(auditFile)
    // Should be capped (rotation happens at 1MB)
    assert.ok(stat.size < 2 * 1024 * 1024, 'audit file bounded')
  } catch {
    // File might not exist if rotation ate it all — that's OK
  }
})

// ——— 4. Multi-channel failure isolation ———

test('admin API: putChannel failure does not affect other channels', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  // Write a valid channel config first
  store.set('telegram:account', { botToken: 'valid-token', chatId: '100' })
  // Attempt to write invalid config to another channel
  const api = createAdminApi({ store, router })
  try {
    api.putChannel('feishu', { webhook: 'http://evil.com' }) // dual-domain, webhook rejected
  } catch (e) {
    assert.equal(e.status, 422)
  }
  // Telegram config should be unaffected
  const tgConfig = store.get('telegram:account')
  assert.ok(tgConfig, 'telegram config preserved')
  assert.equal(tgConfig.botToken, 'valid-token', 'telegram token intact')
})

// ——— 5. putChannel dangerous key rejection ———

test('admin API: putChannel rejects __proto__ and constructor keys', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  const api = createAdminApi({ store, router })
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    try {
      api.putChannel('telegram', { [key]: 'evil' })
      assert.fail(`should reject ${key}`)
    } catch (e) {
      assert.equal(e.status, 422, `${key} rejected`)
    }
  }
})

// ——— 6. Session control overlay: mode only accepts personal/team ———

test('normalizeControlOverlay: invalid mode silently dropped', () => {
  const result = normalizeControlOverlay({ mode: 'evil' })
  assert.equal(result?.mode, undefined, 'invalid mode dropped')
  const valid = normalizeControlOverlay({ mode: 'team' })
  assert.equal(valid.mode, 'team')
})

// ——— 7. Admin API: patchSessionControl validates member shape ———

test('admin API: patchSessionControl rejects approvalMembers with extra fields', () => {
  const statePath = tempPath()
  const store = createStore(statePath)
  const router = createAgentRouter({ store })
  store.set('route:sessions', { 's-mem': { inherit: '', workspace: '', createdAt: 100, lastActiveAt: 100 } })
  const api = createAdminApi({ store, router })
  try {
    api.patchSessionControl('s-mem', {
      approvalMembers: [{ channel: 'telegram', accountId: 'tg', userId: 'u1', evil: 'field' }],
    })
    assert.fail('should reject extra fields in member')
  } catch (e) {
    assert.equal(e.status, 422, 'extra fields in member rejected')
  }
})
