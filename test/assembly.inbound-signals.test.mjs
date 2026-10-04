import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInboundSignals } from '../src/assembly/inbound-signals.mjs'

const RESOLVED = { channels: [] }
const storeOf = (values = {}) => ({ get: (key) => values[key] })

test('private admission disabled: saved credentials and legacy allowUsers do not assemble transports', () => {
  const result = resolveInboundSignals({
    inboundRaw: { allowUsers: ['ou_legacy'], feishu: {} },
    approvalRaw: { mode: 'answer' },
    resolved: RESOLVED,
    store: storeOf({ 'feishu:account': { appId: 'cli_a', appSecret: 'secret' } }),
    privateChatEnabled: () => false,
    warn() {},
  })
  assert.equal(result.feishuOk, false)
  assert.equal(result.inboundBotToken, '')
  assert.equal(result.approvalWanted, true)
})

test('explicit private-chat enablement allows the canonical saved account credentials', () => {
  const result = resolveInboundSignals({
    inboundRaw: {},
    approvalRaw: {},
    resolved: RESOLVED,
    store: storeOf({ 'feishu:account': { appId: 'cli_a', appSecret: 'secret' } }),
    privateChatEnabled: (type) => type === 'feishu',
    warn() {},
  })
  assert.equal(result.feishuOk, true)
  assert.equal(result.feishuResolved.config.accountId, 'cli_a')
})

test('a saved Telegram token is not active unless explicit private-chat authorization exists', () => {
  const result = resolveInboundSignals({
    inboundRaw: {},
    approvalRaw: {},
    resolved: { channels: [{ type: 'telegram', config: { botToken: 'outbound-token', chatId: '123' } }] },
    store: storeOf({ 'telegram:account': { botToken: 'saved-token', accountId: 'tg-account' } }),
    privateChatEnabled: () => false,
    warn() {},
  })
  assert.equal(result.inboundBotToken, '')
  assert.deepEqual(result.notifyChatIds, ['123'], '出站通知目标独立保留；显式关闭的私聊入站仍无 token')
})
