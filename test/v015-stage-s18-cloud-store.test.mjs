// v0.15 Stage S18 (T27) — cloud save narrow interface.
//
// Acceptance G01 (04-ACCEPTANCE-AND-REVIEW.md) + 06-INTEGRATIONS §云保存窄接口:
//   * fake cloud storage failure does not affect local export;
//   * the store does not interpret unknown bytes as business data;
//   * the plugin installs / runs with no cloud binding at all.
//
// Oracles are the real production module (`src/control-plane/cloud-store.mjs`) driven directly,
// plus a real export v1 document produced by the canonical portability authority (no re-impl).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryCloudStore,
  createUnavailableCloudStore,
  CLOUD_STORE_LIMITS,
  CLOUD_STORE_SCHEMA,
} from '../src/control-plane/cloud-store.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createInboundChannelConfigPort } from '../src/inbound/channel-config.mjs'
import { createConfigPortabilityService } from '../src/control-plane/config-portability.mjs'

const bytes = (text) => new TextEncoder().encode(text)
const text = (data) => new TextDecoder().decode(data)

/** Real store + canonical authorities + portability service (frozen clock). */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-cloud-store-'))
  const store = createStore(join(dir, 'state.json'))
  const source = createOutboundSource([])
  const outboundConfig = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const inboundConfig = createInboundChannelConfigPort({ store })
  const portability = createConfigPortabilityService({
    store,
    outboundConfig,
    inboundConfig,
    version: '0.13.1',
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  })
  return { store, outboundConfig, portability }
}

/** Deterministic memory store (fixed clock + fixed random salt). */
const memoryStore = (options = {}) => createMemoryCloudStore({
  now: () => new Date('2026-10-01T00:00:00.000Z'),
  random: () => 0.5,
  ...options,
})

// ————————————————————————— round-trip —————————————————————————

test('G01: opaque bytes round-trip byte-identical with metadata preserved', () => {
  const cloud = memoryStore()
  const data = bytes('线 上 存 放 payload\n')
  const put = cloud.put(data, { name: 'config.json', size: data.byteLength, note: 'draft' })
  assert.equal(put.ok, true)
  assert.equal(put.size, data.byteLength)
  assert.equal(put.createdAt, '2026-10-01T00:00:00.000Z')

  const got = cloud.get(put.id)
  assert.equal(got.ok, true)
  assert.deepEqual([...got.bytes], [...data])
  assert.equal(text(got.bytes), text(data))
  assert.deepEqual(got.metadata, { name: 'config.json', size: data.byteLength, note: 'draft' })
  assert.equal(got.size, data.byteLength)
})

test('G01: export v1 document round-trips through the store unchanged', () => {
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: 'x'.repeat(24), chatId: '9', timeoutMs: 5000 })
  const document = r.portability.exportConfig({ scopes: ['channels'] }).document
  const json = JSON.stringify(document)

  const cloud = memoryStore()
  const put = cloud.put(bytes(json), { documentType: document.documentType, formatVersion: document.formatVersion })
  assert.equal(put.ok, true)
  const got = cloud.get(put.id)

  const rehydrated = JSON.parse(text(got.bytes))
  assert.deepEqual(rehydrated, document, 'the store returns exactly what was stored')
  assert.equal(rehydrated.documentType, 'dsh-notifier-config')
  assert.equal(rehydrated.formatVersion, 1)
  assert.equal(got.metadata.documentType, 'dsh-notifier-config')
})

test('G01: unknown / non-JSON bytes are transported verbatim, never interpreted', () => {
  const cloud = memoryStore()
  const blob = Uint8Array.from([0, 255, 1, 254, 2, 253, 0x7b, 0x7d]) // not valid JSON
  const put = cloud.put(blob, {})
  assert.equal(put.ok, true)
  const got = cloud.get(put.id)
  assert.deepEqual([...got.bytes], [...blob])

  // 契约面：store 只暴露搬运动作，没有任何 parse / validate / interpret 方法。
  const surface = Object.keys(cloud)
  for (const forbidden of ['parse', 'validate', 'interpret', 'decode', 'documentType']) {
    assert.equal(surface.includes(forbidden), false, `store must not expose ${forbidden}`)
  }
  assert.equal(cloud.schema, CLOUD_STORE_SCHEMA)
})

// ————————————————————————— copy-on-write —————————————————————————

test('G01: the store copies on write and on read (no shared references)', () => {
  const cloud = memoryStore()
  const data = bytes('original')
  const put = cloud.put(data, { tag: 'a' })
  data[0] = 0x21 // caller mutates its own buffer afterwards

  const first = cloud.get(put.id)
  assert.equal(text(first.bytes), 'original', 'stored bytes are unaffected by later caller mutation')
  first.bytes[0] = 0x3f
  first.metadata.tag = 'mutated'

  const second = cloud.get(put.id)
  assert.equal(text(second.bytes), 'original', 'returned bytes cannot mutate the store')
  assert.equal(second.metadata.tag, 'a', 'returned metadata cannot mutate the store')
})

// ————————————————————————— rejections (zero write) —————————————————————————

test('G01: a string payload is rejected — encoding is the caller\'s decision, not the store\'s', () => {
  const cloud = memoryStore()
  const result = cloud.put('{"documentType":"dsh-notifier-config"}', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-bytes')
  assert.equal(cloud.stats().stored, 0, 'a rejected put writes nothing')
})

test('G01: over-limit payloads and malformed metadata are rejected before storing', () => {
  const cloud = memoryStore({ maxBytes: 8 })
  assert.equal(cloud.put(new Uint8Array(8), {}).ok, true)
  const tooLarge = cloud.put(new Uint8Array(9), {})
  assert.equal(tooLarge.code, 'too-large')

  assert.equal(cloud.put(bytes('ok'), ['not', 'an', 'object']).code, 'bad-metadata')
  assert.equal(cloud.put(bytes('ok'), { nested: { a: 1 } }).code, 'bad-metadata')
  assert.equal(cloud.put(bytes('ok'), { fn: () => {} }).code, 'bad-metadata')
  assert.equal(cloud.put(bytes('ok'), { n: Number.NaN }).code, 'bad-metadata')
  assert.equal(cloud.put(bytes('ok'), { s: 'x'.repeat(CLOUD_STORE_LIMITS.maxMetadataValueBytes + 1) }).code, 'bad-metadata')
  const many = Object.fromEntries(Array.from({ length: CLOUD_STORE_LIMITS.maxMetadataKeys + 1 }, (_, i) => [`k${i}`, i]))
  assert.equal(cloud.put(bytes('ok'), many).code, 'bad-metadata')
  assert.equal(cloud.stats().stored, 1, 'only the single valid put was stored')
})

// ————————————————————————— delete —————————————————————————

test('G01: delete removes the object; a repeat delete is honest about it', () => {
  const cloud = memoryStore()
  const put = cloud.put(bytes('bye'), {})
  assert.equal(cloud.delete(put.id).deleted, true)
  assert.equal(cloud.get(put.id).code, 'not-found')
  assert.equal(cloud.delete(put.id).deleted, false, 'the second delete reports nothing was removed')
  assert.equal(cloud.delete('').code, 'bad-id')
  assert.equal(cloud.get('').code, 'bad-id')
})

// ————————————————————————— cancellation / failure isolation —————————————————————————

test('G01: an aborted signal cancels with zero write', () => {
  const cloud = memoryStore()
  const controller = new AbortController()
  controller.abort()
  const result = cloud.put(bytes('nope'), {}, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'cancelled')
  assert.equal(cloud.stats().stored, 0)
})

test('G01: injected storage failure is a failure, and local export still succeeds', () => {
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: 'y'.repeat(24), chatId: '7' })
  const cloud = memoryStore({ failPut: (call) => (call === 1 ? 'storage-failed' : null) })

  const document = r.portability.exportConfig({ scopes: ['channels'] }).document
  const json = JSON.stringify(document)

  const failed = cloud.put(bytes(json), {})
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'storage-failed')
  assert.equal(cloud.stats().stored, 0, 'a failed cloud put stores nothing')

  // 本地导出与下载完全不依赖云端：同一文档仍可被本地产出。
  const again = r.portability.exportConfig({ scopes: ['channels'] }).document
  assert.deepEqual(again, document, 'cloud failure never affects the local export')
  assert.equal(JSON.stringify(again).includes('y'.repeat(24)), false, 'and it still carries no secret')
})

test('G01: no cloud binding — the plugin runs, and the placeholder is honestly unavailable', () => {
  const cloud = createUnavailableCloudStore('no-provider')
  assert.deepEqual(cloud.capabilities(), { available: false, kind: 'unavailable', reason: 'no-provider' })
  assert.equal(cloud.put(bytes('x'), {}).code, 'not-configured')
  assert.equal(cloud.get('cs_1').code, 'not-configured')
  assert.equal(cloud.delete('cs_1').code, 'not-configured')

  // 「无 cloud binding 也安装运行」：导出权威不依赖任何云 provider。
  const r = rig()
  r.outboundConfig.save('telegram', { botToken: 'z'.repeat(24), chatId: '1' })
  const result = r.portability.exportConfig({ scopes: ['channels'] })
  assert.equal(result.document.documentType, 'dsh-notifier-config')
  assert.equal(result.counts.channels, 1)
})