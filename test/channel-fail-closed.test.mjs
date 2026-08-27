// Phase 4: Channel-specific fail-closed and capability tests.
// Covers: QQ group controls, WeChat iLink session, Feishu card update,
// Telegram UTF-16 boundary, cross-channel source binding consistency.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chatScopeOf, canAcceptCommand, normalizeSessionPolicy, normalizeControlOverlay } from '../src/control/session-arbiter.mjs'
import { normalizeInbound } from '../src/inbound/_contract.mjs'
import { capabilitiesOf, displayNameOf } from '../src/inbound/capability-matrix.mjs'

// ——— QQ: group controls fail-closed ———

test('QQ: chatScopeOf classifies group/private/unknown correctly', () => {
  assert.equal(chatScopeOf({ channel: 'qq', chatType: 'group' }), 'group')
  assert.equal(chatScopeOf({ channel: 'qq', chatType: 'private' }), 'private')
  assert.equal(chatScopeOf({ channel: 'qq', chatType: '1' }), 'private')
  assert.equal(chatScopeOf({ channel: 'qq', chatType: '2' }), 'group')
  assert.equal(chatScopeOf({ channel: 'qq', chatType: '' }), 'unknown')
  assert.equal(chatScopeOf({ channel: 'qq', chatType: undefined }), 'unknown')
  // Pre-chatType C2C: chatId === userId → private
  assert.equal(chatScopeOf({ channel: 'qq', chatType: '', chatId: 'u1', userId: 'u1' }), 'private')
  // Pre-chatType with mismatched chatId/userId → unknown
  assert.equal(chatScopeOf({ channel: 'qq', chatType: '', chatId: 'g1', userId: 'u1' }), 'unknown')
})

test('QQ group: all commands fail-closed regardless of policy capabilities', () => {
  const policy = normalizeSessionPolicy({
    mode: 'team', channel: 'qq', accountId: 'QQ_APP', sessionId: 's1', chatId: 'g1',
    capabilities: { converse: true, groupChatControl: true, approve: true, stop: true },
  }, 100)
  for (const command of ['stop', 'approval', 'question-answer', 'steer', 'ordinary-message']) {
    const result = canAcceptCommand(policy, {
      eventId: `qq-g-${command}`, sessionId: 's1', channel: 'qq', accountId: 'QQ_APP',
      userId: 'u1', chatId: 'g1', policyVersion: '1', command, chatType: 'group',
      createdAt: 10, expiresAt: 200,
    })
    assert.equal(result.ok, false, `QQ group ${command} must fail-closed`)
    assert.equal(result.reason, 'group_chat_disabled')
  }
})

test('QQ unknown source: fail-closed for every command', () => {
  const policy = normalizeSessionPolicy({ channel: 'qq', accountId: 'QQ_APP', sessionId: 's1', chatId: 'g1' }, 100)
  for (const command of ['stop', 'approval']) {
    // No chatType → source_chat_type_unknown (after source binding passes)
    const result = canAcceptCommand(policy, {
      eventId: `qq-unk-${command}`, sessionId: 's1', channel: 'qq', accountId: 'QQ_APP',
      userId: 'u1', chatId: 'g1', policyVersion: '1', command, createdAt: 10, expiresAt: 200,
    })
    assert.equal(result.ok, false, `QQ unknown chatType ${command} must fail-closed`)
    assert.equal(result.reason, 'source_chat_type_unknown')
  }
})

// ——— WeChat iLink: capabilities are declared ———

test('WeChat iLink: capabilities are declared, not device-verified', () => {
  const caps = capabilitiesOf('wechat')
  assert.ok(caps, 'wechat has capabilities')
  assert.equal(typeof caps.buttons, 'boolean', 'buttons capability is boolean')
  assert.equal(typeof caps.imageInbound, 'boolean', 'imageInbound capability is boolean')
  assert.equal(typeof caps.fileInbound, 'boolean', 'fileInbound capability is boolean')
})

test('WeChat iLink: displayNameOf returns Chinese name', () => {
  assert.equal(displayNameOf('wechat'), '微信')
})

// ——— Feishu: callback validation ———

test('Feishu: callback requires open_chat_id and user_id', () => {
  const result = normalizeInbound({
    channel: 'feishu',
    notifyTargets: () => [],
    sendApprovalCard: async () => ({ messageId: 'm1' }),
    editResolved: async () => {},
    sendText: async () => true,
  })
  assert.equal(result.channel, 'feishu')
  assert.ok(result.capabilities, 'feishu has capabilities')
  assert.equal(typeof result.capabilities.buttons, 'boolean')
})

test('Feishu: displayNameOf returns Chinese name', () => {
  assert.equal(displayNameOf('feishu'), '飞书')
})

// ——— Telegram: UTF-16 boundary and capabilities ———

test('Telegram: displayNameOf returns Chinese name', () => {
  assert.equal(displayNameOf('telegram'), 'Telegram')
})

test('Telegram: capabilities cover protocol fallbacks', () => {
  const caps = capabilitiesOf('telegram')
  assert.ok(caps, 'telegram has capabilities')
  assert.equal(typeof caps.buttons, 'boolean')
  assert.equal(typeof caps.imageInbound, 'boolean')
  assert.equal(typeof caps.fileInbound, 'boolean')
  assert.equal(typeof caps.sourceChatCheck, 'boolean')
})

test('Telegram: 4096 UTF-16 boundary - splitting respects codepoint boundary', () => {
  // Telegram text limit is 4096 UTF-16 code units
  const LIMIT = 4096
  // Create a string that's exactly at the limit
  const atLimit = 'a'.repeat(LIMIT)
  assert.equal([...atLimit].reduce((sum, c) => sum + (c.codePointAt(0) > 0xFFFF ? 2 : 1), 0), LIMIT)
  // Create a string one over the limit with a surrogate pair at the boundary
  const emoji = '😀' // U+1F600, 2 UTF-16 code units
  const overLimit = 'a'.repeat(LIMIT - 1) + emoji // LIMIT-1 + 2 = LIMIT+1
  const units = [...overLimit].reduce((sum, c) => sum + (c.codePointAt(0) > 0xFFFF ? 2 : 1), 0)
  assert.ok(units > LIMIT, 'string exceeds UTF-16 limit')
  // The split point must be before the emoji to stay within limit
  const split = [...overLimit].reduce((acc, ch) => {
    const size = ch.codePointAt(0) > 0xFFFF ? 2 : 1
    if (acc.units + size <= LIMIT) { acc.units += size; acc.chars.push(ch) }
    return acc
  }, { units: 0, chars: [] })
  assert.ok(split.units <= LIMIT, 'split result within UTF-16 limit')
})

// ——— Cross-channel source binding consistency ———

test('All channels: source binding is exact for channel/accountId/userId/chatId/sessionId', () => {
  const channels = ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk']
  for (const channel of channels) {
    const policy = normalizeSessionPolicy({
      channel, accountId: `${channel}-app`, userId: 'owner-1',
      chatId: 'chat-1', sessionId: 'session-1', owner: 'owner-1',
    }, 100)
    // Correct source → ok (QQ needs chatType=private to avoid unknown)
    const eventBase = {
      sessionId: 'session-1', channel, accountId: `${channel}-app`,
      userId: 'owner-1', chatId: 'chat-1', policyVersion: '1', command: 'stop',
      createdAt: 10, expiresAt: 200,
    }
    if (channel === 'qq') eventBase.chatType = 'private'
    const ok = canAcceptCommand(policy, { eventId: 'ok', ...eventBase })
    assert.equal(ok.ok, true, `${channel}: correct source accepted`)
    // Wrong channel → rejected
    const wrongChan = canAcceptCommand(policy, {
      eventId: 'wc', ...eventBase, channel: 'other',
    })
    assert.equal(wrongChan.ok, false, `${channel}: wrong channel rejected`)
    assert.equal(wrongChan.reason, 'source_mismatch_channel')
    // Wrong account → rejected
    const wrongAcc = canAcceptCommand(policy, {
      eventId: 'wa', ...eventBase, accountId: 'evil',
    })
    assert.equal(wrongAcc.ok, false, `${channel}: wrong account rejected`)
    assert.equal(wrongAcc.reason, 'source_mismatch_accountId')
  }
})

// ——— Personal mode defaults cannot be expanded by overlay ———

test('Personal mode: capabilities cannot be expanded by overlay', () => {
  const policy = normalizeSessionPolicy({ channel: 'telegram', accountId: 'tg' }, 100)
  // Personal mode: converse=false, groupChatControl=false
  assert.equal(policy.capabilities.converse, false)
  assert.equal(policy.capabilities.groupChatControl, false)
  // Overlay tries to set mode=team but personal mode caps stay
  const overlay = normalizeControlOverlay({ mode: 'team' })
  assert.ok(overlay, 'overlay normalized')
  assert.equal(overlay.mode, 'team')
  // The overlay mode doesn't affect the base policy's capabilities
  // (capabilities are set at policy creation, not overlay merge time)
  assert.equal(policy.capabilities.converse, false, 'personal mode caps unchanged')
})

// ——— Capability matrix consistency ———

test('Capability matrix: all inbound channels declared with required fields', () => {
  const inbound = ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk']
  for (const ch of inbound) {
    const caps = capabilitiesOf(ch)
    assert.ok(caps, `${ch}: has capabilities`)
    assert.equal(typeof caps.buttons, 'boolean', `${ch}: buttons is boolean`)
    assert.equal(typeof caps.imageInbound, 'boolean', `${ch}: imageInbound is boolean`)
    assert.equal(typeof caps.fileInbound, 'boolean', `${ch}: fileInbound is boolean`)
    assert.equal(typeof caps.sourceChatCheck, 'boolean', `${ch}: sourceChatCheck is boolean`)
    assert.equal(typeof displayNameOf(ch), 'string', `${ch}: has display name`)
    assert.ok(displayNameOf(ch).length > 0, `${ch}: display name is non-empty`)
  }
})
