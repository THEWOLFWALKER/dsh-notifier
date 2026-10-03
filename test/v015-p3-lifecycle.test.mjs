import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, transactDurable } from '../src/inbound/store.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from '../src/runtime/channel-manager.mjs'

test('P3 disk rename contention retries; exhaustion leaves memory and restart truth unchanged', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'dn-p3-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'state.json'), store = createStore(path)
  store.set('value', 'old')
  const original = fs.renameSync
  let failures = 2, attempts = 0
  fs.renameSync = (...args) => { attempts++; if (failures-- > 0) throw Object.assign(Error('busy'), { code: 'EBUSY' }); return original(...args) }
  syncBuiltinESMExports()
  try {
    assert.equal(transactDurable(store, draft => { draft.value = 'new' }).committed, true)
    assert.equal(attempts, 3)
    failures = 100; attempts = 0
    assert.equal(transactDurable(store, draft => { draft.value = 'lost' }).committed, false)
    assert.equal(store.get('value'), 'new')
  } finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(createStore(path).get('value'), 'new')
})
test('P3 1000 replacements retire exactly once and old completions cannot resurrect stopped instances', () => {
  let retired = 0, observations = 0
  const source = createOutboundSource([], { onRetire: () => retired++ })
  let subscribed = 0
  const original = source.subscribe
  source.subscribe = fn => { subscribed++; const stop = original(fn); return () => { subscribed--; stop() } }
  const manager = createRuntimeChannelManager({ source })
  for (let i = 0; i < 1000; i++) {
    const stop = manager.subscribe(() => observations++)
    manager.replace('telegram', { n: i })
    const generation = manager.epochOf('telegram')
    manager.remove('telegram')
    manager.setState('telegram', 'online', { generation })
    assert.equal(manager.runtimeState('telegram').state, 'stopped')
    stop()
  }
  assert.equal(retired, 1000); assert.equal(subscribed, 0)
  manager.subscribe(() => observations++)
  manager.replace('telegram', {})
  manager.dispose(); manager.dispose()
  assert.equal(subscribed, 0); assert.equal(source.has('telegram'), false)
  const before = observations
  manager.setState('telegram', 'online')
  assert.equal(observations, before)
  assert.throws(() => manager.replace('telegram', {}), /disposed/)
})
test('P3 runtime identities and observers reject capacity overflow without partial mutation', () => {
  const manager = createRuntimeChannelManager({ source: createOutboundSource([]) })
  for (let i = 0; i < 128; i++) manager.replace(`channel-${i}`, {})
  assert.throws(() => manager.replace('overflow', {}), /capacity/)
  assert.equal(manager.types().length, 128)
  const stops = Array.from({ length: 256 }, () => manager.subscribe(() => {}))
  assert.throws(() => manager.subscribe(() => {}), /capacity/)
  stops.forEach(stop => stop()); manager.dispose()
})

test('P3 1000 notification operations and 500 private events leave no pending waiters', async () => {
  const { createNotifier } = await import('../src/notify.mjs')
  const { createInboundBus } = await import('../src/inbound/bus.mjs')
  let audits = 0, messages = 0
  const { resolveConfig } = await import('../src/config.mjs')
  const { createServer } = await import('node:http')
  let requests = 0
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const channels = resolveConfig({ channels: [{ type: 'webhook', url: `http://127.0.0.1:${server.address().port}/hook`, allowPrivateNetwork: true }] }).channels
  const notifier = createNotifier({}, channels, { onSend: () => audits++ })
  try { for (let i = 0; i < 1000; i++) assert.equal((await notifier.notifyAll({ title: 'notice', content: String(i) })).ok, true) }
  finally { await new Promise(resolve => server.close(resolve)) }
  assert.equal(requests, 1000)
  assert.equal(audits, 1000)
  const bus = createInboundBus({ identity: { allows: () => true, isEmpty: () => false } })
  const stop = bus.onMessage(() => messages++)
  for (let i = 0; i < 500; i++) bus.accept({ channel: 'telegram', accountId: 'bot', userId: '42', chatId: '42', chatType: 'private', messageId: String(i), text: 'hello' })
  assert.equal(messages, 500); assert.equal(bus.pendingCount(), 0)
  stop(); bus.dispose()
})
