import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'
import { createIdentity, principalKey } from '../src/inbound/identity.mjs'

const quiet = { warn: () => {}, info: () => {} }
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-identity-'))
  const store = createStore(join(dir, 'state.json'))
  return { store, identity: createIdentity({ store, logger: quiet }) }
}

test('principal keys require a complete non-default account tuple', () => {
  assert.equal(principalKey('telegram', 'bot-a', '42'), 'telegram:bot-a:42')
  assert.equal(principalKey('telegram', '', '42'), '')
  assert.equal(principalKey('telegram', 'default', '42'), '')
  assert.equal(principalKey('', 'bot-a', '42'), '')
  assert.equal(principalKey('telegram', 'bot-a', ''), '')
})

test('bindings are isolated by channel and stable account ID', () => {
  const { identity } = rig()
  assert.equal(identity.addBinding({ channel: 'telegram', accountId: 'bot-a', userId: '42' }).ok, true)
  assert.equal(identity.allows('telegram', '42', 'bot-a'), true)
  assert.equal(identity.allows('telegram', '42', 'bot-b'), false)
  assert.equal(identity.allows('telegram', '42'), false)
  assert.equal(identity.allows('feishu', '42', 'bot-a'), false)
  assert.equal(identity.addBinding({ channel: 'telegram', accountId: 'bot-b', userId: '42' }).ok, true)
  assert.equal(identity.size(), 2)
})

test('missing, default, malformed account IDs fail closed for binding mutations', () => {
  const { identity } = rig()
  for (const accountId of [undefined, '', 'default', 'bad:account']) {
    const result = identity.addBinding({ channel: 'telegram', accountId, userId: '42' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-account')
  }
  assert.equal(identity.size(), 0)
  assert.equal(identity.addPending({ channel: 'telegram', userId: '42' }).reason, 'invalid-account')
})

test('legacy two-part rows are ignored instead of receiving an inferred account', () => {
  const { store } = rig()
  store.set('inbound:bindings', {
    'telegram:42': { channel: 'telegram', userId: '42', role: 'owner', origin: 'paired' },
  })
  const identity = createIdentity({ store, logger: quiet })
  assert.equal(identity.size(), 0)
  assert.equal(identity.allows('telegram', '42', 'bot-a'), false)
})

test('pending identities are account scoped and confirmation preserves that account', () => {
  const { identity } = rig()
  assert.equal(identity.addPending({ channel: 'telegram', accountId: 'bot-a', userId: '42' }).ok, true)
  assert.equal(identity.listPending().length, 1)
  assert.equal(identity.confirmPending('telegram', '42', 'bot-b').ok, false)
  const confirmed = identity.confirmPending('telegram', '42', 'bot-a')
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.record.accountId, 'bot-a')
  assert.equal(identity.allows('telegram', '42', 'bot-a'), true)
  assert.equal(identity.listPending().length, 0)
})

test('labels, owner protection, and member operations use the full principal', () => {
  const { identity } = rig()
  const owner = identity.addBinding({ channel: 'telegram', accountId: 'bot-a', userId: '42', label: 'x'.repeat(100) })
  assert.equal(owner.record.role, 'owner')
  assert.equal(owner.record.label.length, 64)
  assert.equal(identity.addBinding({ channel: 'telegram', accountId: 'bot-a', userId: '99' }).record.role, 'member')
  assert.equal(identity.updateBinding('telegram', '42', { role: 'member' }, 'bot-a').reason, 'owner-last')
  assert.equal(identity.updateBinding('telegram', '42', { label: 'owner' }, 'bot-b').reason, 'not-found')
  assert.equal(identity.removeBinding('telegram', '42', 'bot-a').reason, 'owner-last')
  assert.equal(identity.updateBinding('telegram', '99', { label: 'member' }, 'bot-a').record.label, 'member')
  assert.equal(identity.removeBinding('telegram', '99', 'bot-a').ok, true)
})
