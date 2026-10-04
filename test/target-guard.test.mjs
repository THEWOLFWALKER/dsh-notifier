import test from 'node:test'
import assert from 'node:assert/strict'
import { guardTargets, isValidTargetId, resolveNotifyTargets } from '../src/inbound/target-guard.mjs'

test('target ID shapes reject unknown channels and malformed provider IDs', () => {
  assert.equal(isValidTargetId('telegram', '10086'), true)
  assert.equal(isValidTargetId('telegram', '-100123'), true, 'shape check allows provider IDs; private filter rejects group IDs')
  assert.equal(isValidTargetId('feishu', 'ou_user123'), true)
  assert.equal(isValidTargetId('feishu', 'oc_chat123'), true)
  assert.equal(isValidTargetId('feishu', '10086'), false)
  assert.equal(isValidTargetId('qq', 'openid_123'), true)
  assert.equal(isValidTargetId('qq', 'short'), false)
  assert.equal(isValidTargetId('unknown', 'anything'), false)
})

test('guardTargets reports invalid and unknown targets without throwing', () => {
  const warnings = []
  const result = guardTargets('feishu', [{ chatId: 'ou_user123' }, { chatId: '10086' }, null], (line) => warnings.push(line))
  assert.deepEqual(result.kept.map((row) => row.chatId), ['ou_user123'])
  assert.equal(result.skipped.length, 2)
  assert.equal(warnings.length, 1)
  assert.deepEqual(guardTargets('unknown', [{ chatId: 'x' }]).kept, [])
})

test('configured targets are private-shaped and Telegram group IDs are rejected', () => {
  assert.deepEqual(resolveNotifyTargets({ channel: 'telegram', configTargets: ['10086', '-100123', 'x'] }), [
    { chatId: '10086', userId: '10086' },
  ])
  assert.deepEqual(resolveNotifyTargets({ channel: 'feishu', configTargets: ['ou_user123', 'oc_chat123'] }), [
    { chatId: 'ou_user123', userId: 'ou_user123' },
  ])
  assert.deepEqual(resolveNotifyTargets({ channel: 'qq', configTargets: ['openid_123'] }), [
    { chatId: 'openid_123', userId: 'openid_123' },
  ])
})

test('paired identities take precedence only within their explicit account', () => {
  const identity = { list: () => [
    { channel: 'telegram', accountId: 'bot-a', userId: '42' },
    { channel: 'telegram', accountId: 'bot-b', userId: '99' },
  ] }
  assert.deepEqual(resolveNotifyTargets({ identity, channel: 'telegram', accountId: 'bot-a', configTargets: ['100'] }), [
    { chatId: '42', userId: '42' },
  ])
  assert.deepEqual(resolveNotifyTargets({ identity, channel: 'telegram', configTargets: ['100'] }), [
    { chatId: '100', userId: '100' },
  ])
})

test('global fallback and extra targets never create recipients', () => {
  assert.deepEqual(resolveNotifyTargets({ channel: 'telegram', fallbackTargets: ['100'], extraTargets: ['200'] }), [])
  assert.deepEqual(resolveNotifyTargets({ channel: 'qq', configTargets: ['openid_123'], extraTargets: ['groupid_123'] }), [
    { chatId: 'openid_123', userId: 'openid_123' },
  ])
})
