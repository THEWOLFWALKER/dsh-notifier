import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAdminApi } from '../src/admin/api.mjs'
import { migrateCanonicalChannelConfig } from '../src/control-surface/channel-config-migration.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { redactDiagnostic, redactDiagnosticValue } from '../src/security/diagnostic.mjs'
import { createStore } from '../src/inbound/store.mjs'

const tempState = (initial) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v013-channel-config-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial))
  return { dir, file }
}

test('v0.13 migration: backup once, copy legacy outbound, retire old Admin key, keep inbound account key', () => {
  const { dir, file } = tempState({
    'admin:channel:bark:outbound': { key: 'admin-key' },
    'bark:account': { key: 'inbound-compatible' },
    'feishu:account': { appId: 'app', appSecret: 'secret' },
  })
  const store = createStore(file)
  const first = migrateCanonicalChannelConfig({
    store,
    channelTypes: ['bark', 'feishu'],
    adminEnabled: true,
    now: () => '2026-09-26T00:00:00.000Z',
  })

  assert.equal(first.ok, true)
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'admin-key' })
  assert.equal(store.get('admin:channel:bark:outbound'), undefined)
  assert.deepEqual(store.get('bark:account'), { key: 'inbound-compatible' })
  assert.equal(store.get('channel:feishu:outbound'), undefined, 'dual-domain inbound account is never outbound-migrated')
  assert.equal(store.get('state:schema-version'), 13)
  assert.equal(store.get('state:migration:v0.13').status, 'complete')
  const backups = readdirSync(dir).filter((name) => name.includes('.pre-v0.13.'))
  assert.equal(backups.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8'))['admin:channel:bark:outbound'], { key: 'admin-key' })

  const second = migrateCanonicalChannelConfig({ store, channelTypes: ['bark', 'feishu'], adminEnabled: true })
  assert.equal(second.already, true)
  assert.equal(readdirSync(dir).filter((name) => name.includes('.pre-v0.13.')).length, 1, 'restart does not create another migration backup')
})
test('v0.13 canonical service: revoke ignores malformed legacy and removes all durable outbound keys atomically', () => {
  const { file } = tempState({
    'channel:bark:outbound': { key: 'canonical' },
    'admin:channel:bark:outbound': 'broken',
    'bark:account': ['broken'],
  })
  const store = createStore(file)
  const source = createOutboundSource([{ type: 'bark', config: { key: 'canonical' } }])
  const service = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source,
    adminEnabled: true,
    allowLegacy: false,
  })

  const result = service.remove('bark', { mode: 'revoke' })
  assert.equal(result.deleted, true)
  assert.equal(store.get('channel:bark:outbound'), undefined)
  assert.equal(store.get('admin:channel:bark:outbound'), undefined)
  assert.equal(store.get('bark:account'), undefined)
  assert.equal(source.has('bark'), false)
})

test('v0.13 shared service: Admin write/read and Native runtime observe the same canonical desired state', () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const service = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source,
    allowLegacy: false,
  })
  const api = createAdminApi({
    store,
    outboundConfig: service,
    channelsEnabled: () => source.types(),
    outboundConfigs: () => ({}),
  })

  const saved = api.putOutboundChannel('bark', { key: 'same-key' })
  assert.equal(saved.saved, true)
  assert.deepEqual(service.raw('bark'), { key: 'same-key' })
  assert.equal(source.has('bark'), true)
  assert.equal(api.getChannels().find((row) => row.type === 'bark' && row.direction === 'outbound').configured, true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['channel:bark:outbound'], { key: 'same-key' })
  assert.equal(existsSync(file), true)
})

test('v0.13 control-surface facade: Admin test and revoke stay on the canonical service', async () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const service = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    source,
    allowLegacy: false,
  })
  const tested = []
  const api = createAdminApi({
    store,
    outboundConfig: service,
    channelTest: async (type, raw) => {
      tested.push({ type, raw })
      return { ok: true, confirmed: true }
    },
  })

  api.putOutboundChannel('bark', { key: 'canonical-only' })
  const result = await api.testOutboundChannel('bark')
  assert.equal(result.confirmed, true)
  assert.deepEqual(tested, [{ type: 'bark', raw: { key: 'canonical-only' } }])
  const removed = api.deleteOutboundChannel('bark', { mode: 'revoke' })
  assert.equal(removed.type, 'bark')
  assert.equal(removed.deleted, true)
  assert.equal(removed.direction, 'outbound')
  assert.equal(removed.applied, true)
  assert.equal(removed.applyMode, 'hot')
  assert.equal(typeof removed.configRevision, 'number')
  assert.equal(store.get('channel:bark:outbound'), undefined)
  assert.equal(store.get('admin:channel:bark:outbound'), undefined)
  assert.equal(source.has('bark'), false)
})

test('v0.13 apply failure: durable desired config is saved while runtime is marked restart-pending', () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = {
    version: 0,
    has: () => false,
    replace() { throw new Error('runtime unavailable') },
    remove() {},
  }
  const service = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const result = service.save('bark', { key: 'durable-key' })
  assert.equal(result.saved, true)
  assert.equal(result.applied, false)
  assert.equal(result.applyMode, 'restart-pending')
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'durable-key' })
  assert.equal(service.describe('bark').runtime.state, 'failed')
})

test('v0.13 secret patch contract: blank keeps, non-empty replaces, explicit clear deletes', () => {
  const { file } = tempState()
  const store = createStore(file)
  const source = createOutboundSource([])
  const service = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })

  service.save('bark', { key: 'first-secret' })
  const kept = service.save('bark', { key: '   ' })
  assert.equal(kept.unchanged, true)
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'first-secret' })
  service.save('bark', { key: 'second-secret' })
  assert.deepEqual(store.get('channel:bark:outbound'), { key: 'second-secret' })
  const cleared = service.save('bark', { clearSecrets: ['key'] })
  assert.deepEqual(cleared.cleared, ['key'])
  assert.deepEqual(store.get('channel:bark:outbound'), {})
  assert.equal(source.has('bark'), true, 'invalid desired state does not tear down the live runtime')
})

test('v0.13 inbound secret patch contract: blank keeps, null and clearSecrets delete', () => {
  const { file } = tempState({ 'telegram:account': { botToken: 'first-secret' } })
  const store = createStore(file)
  const port = createInboundChannelConfigPort({ store })

  assert.equal(port.put('telegram', { botToken: ' ' }).unchanged, true)
  assert.deepEqual(store.get('telegram:account'), { botToken: 'first-secret' })
  port.put('telegram', { botToken: 'second-secret' })
  assert.deepEqual(store.get('telegram:account'), { botToken: 'second-secret' })
  port.put('telegram', { botToken: null })
  assert.deepEqual(store.get('telegram:account'), {})
  port.put('telegram', { botToken: 'third-secret' })
  port.put('telegram', { clearSecrets: ['botToken'] })
  assert.deepEqual(store.get('telegram:account'), {})
})

test('v0.13 diagnostics: configured values are absent from errors and audit-shaped details', () => {
  const secret = 'plain-secret-value'
  assert.equal(redactDiagnostic(`provider rejected ${secret}`, { key: secret }).includes(secret), false)
  assert.deepEqual(redactDiagnosticValue({ type: 'bark', secret, nested: { token: secret } }), {
    type: 'bark', secret: '***', nested: { token: '***' },
  })
})

test('R3 migration: 损坏 boot state 跳过迁移并 fail-closed（绝不把不可信旧 state 当空实例迁移）', () => {
  const { dir, file } = tempState(undefined)
  writeFileSync(file, '[]') // 合法 JSON 但形状异常 → corrupt
  const store = createStore(file)
  const reasons = []

  const result = migrateCanonicalChannelConfig({
    store,
    channelTypes: ['bark'],
    adminEnabled: true,
    warn: (message) => reasons.push(message),
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'state-untrusted')
  assert.equal(store.get('state:migration:v0.13'), undefined, '不得写入迁移完成标记')
  assert.equal(store.get('state:schema-version'), undefined, '不得写入 schema 版本')
  assert.equal(readdirSync(dir).filter((name) => name.includes('.pre-v0.13.')).length, 0, '不得创建迁移备份')
  assert.ok(reasons.length >= 1, '必须出声（warn 可见）')
})
