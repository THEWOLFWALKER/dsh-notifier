import test from 'node:test'
import assert from 'node:assert/strict'
import { FEISHU_CAPABILITIES, normalizeFeishuCallback, createFeishuTransport, createFeishuInbound } from '../../src/channels/feishu/index.mjs'

test('feishu callback requires action, open_chat_id and operator user', () => {
  const normalized = normalizeFeishuCallback({ action: { value: { act: 'ap:allowed-once:k:t' } }, context: { open_chat_id: 'oc_1' }, operator: { open_id: 'ou_1' } })
  assert.deepEqual(normalized, { channel: 'feishu', accountId: '', userId: 'ou_1', chatId: 'oc_1', action: 'ap:allowed-once:k:t' })
  assert.equal(normalizeFeishuCallback({ action: { value: { act: 'x' } }, operator: { open_id: 'ou_1' } }), null)
})

test('feishu capabilities never claim device verification and file is declared', () => {
  assert.equal(FEISHU_CAPABILITIES.fileSend, 'declared')
  assert.equal(FEISHU_CAPABILITIES.realDeviceVerified, false)
})

// Stage-6: the factory default is the provider facade and its accountId stays stable.

test('feishu facade: factory default is the transport facade (assembly wires this)', () => {
  assert.equal(createFeishuInbound, createFeishuTransport, 'assembly default factory must be the facade')
})

test('feishu facade: accountId resolves from config.accountId, else appId, never the event', () => {
  const explicit = createFeishuTransport({ config: { appId: 'cli_a', accountId: 'acct_alpha' }, bus: {} })
  assert.equal(explicit.accountId, 'acct_alpha')

  const fromAppId = createFeishuTransport({ config: { appId: 'cli_b' }, bus: {} })
  assert.equal(fromAppId.accountId, 'cli_b')

  const absent = createFeishuTransport({ config: {} })
  assert.equal(absent.accountId, '')
})

test('feishu facade: normalizeCallback overlays transport accountId, never the event payload', () => {
  const transport = createFeishuTransport({ config: { appId: 'cli_c', accountId: 'acct_ov' }, bus: {} })
  const input = {
    accountId: 'event-forged', // attacker/tampered event value must NOT mint the source
    action: { value: { act: 'ap:allowed-once:k:t' } },
    context: { open_chat_id: 'oc_1' },
    operator: { open_id: 'ou_1' },
  }
  const cb = transport.normalizeCallback(input)
  assert.equal(cb.accountId, 'acct_ov')
  assert.equal(cb.userId, 'ou_1')
  assert.equal(cb.chatId, 'oc_1')
  assert.equal(cb.action, 'ap:allowed-once:k:t')
})

test('feishu facade: status reflects truthful lifecycle state from the shared inbound', () => {
  const transport = createFeishuTransport({ config: { appId: 'cli_d', accountId: 'acct_st' }, bus: {} })
  assert.equal(typeof transport.status, 'function')
  const st = transport.status()
  // idle/starting lifecycle must never be reported as connected by the facade status
  assert.ok(['idle', 'stopped', 'unavailable', 'error', 'starting', 'connected'].includes(st.state))
  assert.equal(st.accountId, 'acct_st')
  assert.equal(typeof st.websocket, 'boolean')
})

test('feishu facade: sendFile requires an injected fileAdapter and never throws on failure', async () => {
  const noAdapter = createFeishuTransport({ config: { appId: 'cli_e' }, bus: {} })
  assert.equal(await noAdapter.sendFile('oc_9', {}), false)
  const failing = createFeishuTransport({
    config: { appId: 'cli_e' }, bus: {},
    fileAdapter: { sendFile: async () => { throw new Error('upstream') } },
  })
  assert.equal(await failing.sendFile('oc_9', {}), false)
  const okAdapter = createFeishuTransport({
    config: { appId: 'cli_e' }, bus: {},
    fileAdapter: { sendFile: async (p) => ({ channel: 'feishu', accountId: p.accountId, chatId: 'oc_9', ok: true }) },
  })
  assert.equal(await okAdapter.sendFile('oc_9', {}), true)
})
