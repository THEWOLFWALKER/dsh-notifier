import test from 'node:test'
import assert from 'node:assert/strict'
import { TELEGRAM_CAPABILITIES, normalizeTelegramCallback, createTelegramTransport, createTelegramInbound } from '../../src/channels/telegram/index.mjs'

test('telegram callback binds source chat and user', () => {
  const normalized = normalizeTelegramCallback({ data: 'r:abc', message: { chat: { id: 42 } }, from: { id: 7 } })
  assert.deepEqual(normalized, { channel: 'telegram', accountId: '', userId: '7', chatId: '42', action: 'r:abc' })
  assert.equal(normalizeTelegramCallback({ data: 'r:abc', from: { id: 7 } }), null)
})

test('telegram capabilities cover protocol fallbacks without claiming real-device support', () => {
  assert.equal(TELEGRAM_CAPABILITIES.textFallback, 'contract-tested')
  assert.equal(TELEGRAM_CAPABILITIES.fileSend, 'declared')
  assert.equal(TELEGRAM_CAPABILITIES.realDeviceVerified, false)
})

// Stage-6: factory default is the facade; accountId stable and never derived from token.

test('telegram facade: factory default is the transport facade (assembly wires this)', () => {
  assert.equal(createTelegramInbound, createTelegramTransport, 'assembly default factory must be the facade')
})

test('telegram facade: accountId resolves from config.accountId, defaults to a literal, never botToken', () => {
  const explicit = createTelegramTransport({ config: { botToken: 'SECRET', accountId: 'acct_tg' }, bus: {}, vault: {} })
  assert.equal(explicit.accountId, 'acct_tg')

  const defaulted = createTelegramTransport({ config: { botToken: 'SECRET' }, bus: {}, vault: {} })
  assert.equal(defaulted.accountId, 'default')

  const blank = createTelegramTransport({ config: { botToken: 'SECRET', accountId: '  ' }, bus: {}, vault: {} })
  assert.equal(blank.accountId, 'default')
})

test('telegram facade: normalizeCallback overlays transport accountId, never the event botToken/payload', () => {
  const transport = createTelegramTransport({ config: { botToken: 'SECRET', accountId: 'acct_ov' }, bus: {}, vault: {} })
  const input = {
    accountId: 'event-forged',       // tampered event value must NOT mint the source
    botToken: 'secret-in-event',     // a leaked token must never become an account id
    data: 'r:abc',
    message: { chat: { id: 42 } },
    from: { id: 7 },
  }
  const cb = transport.normalizeCallback(input)
  assert.equal(cb.accountId, 'acct_ov')
  assert.equal(cb.userId, '7')
  assert.equal(cb.chatId, '42')
  assert.equal(cb.action, 'r:abc')
})

test('telegram facade: status reflects truthful polling lifecycle via clientState', () => {
  const transport = createTelegramTransport({ config: { botToken: 'SECRET', accountId: 'acct_st' }, bus: {}, vault: {} })
  const st = transport.status()
  assert.ok(['stopped', 'connected'].includes(st.state))
  assert.equal(st.accountId, 'acct_st')
  assert.equal(typeof st.polling, 'boolean')
  assert.equal(st.polling, false, 'not started transport must not report polling connected')
})

test('telegram facade: sendFile requires an injected fileAdapter and never throws on failure', async () => {
  const noAdapter = createTelegramTransport({ config: { botToken: 'SECRET', accountId: 'acct_f' }, bus: {}, vault: {} })
  assert.equal(await noAdapter.sendFile(42, {}), false)
  const failing = createTelegramTransport({
    config: { botToken: 'SECRET', accountId: 'acct_f' }, bus: {}, vault: {},
    fileAdapter: { sendFile: async () => { throw new Error('upstream') } },
  })
  assert.equal(await failing.sendFile(42, {}), false)
  const okAdapter = createTelegramTransport({
    config: { botToken: 'SECRET', accountId: 'acct_f' }, bus: {}, vault: {},
    fileAdapter: { sendFile: async (p) => ({ channel: 'telegram', accountId: p.accountId, chatId: 42, ok: true }) },
  })
  assert.equal(await okAdapter.sendFile(42, {}), true)
})
