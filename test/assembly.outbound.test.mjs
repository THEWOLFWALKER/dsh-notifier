import test from 'node:test'
import assert from 'node:assert/strict'
import { accountOf, composeOutboundChannels } from '../src/assembly/outbound.mjs'

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return { get: (key) => data.get(key) }
}

const YAML_BARK = { type: 'bark', key: 'yaml-key', timeoutMs: 7000 }
const CH_BARK = { type: 'bark', config: { endpoint: 'https://api.day.app/yaml-key', timeoutMs: 7000 } }

test('accountOf accepts only plain stored objects and contains read failures', () => {
  assert.deepEqual(accountOf(fakeStore({ key: { token: 'x' } }), 'key'), { token: 'x' })
  for (const value of [undefined, null, [], 'scalar']) assert.equal(accountOf(fakeStore({ key: value }), 'key'), null)
  assert.equal(accountOf({ get() { throw new Error('unavailable') } }, 'key'), null)
})

test('canonical channel state overlays YAML and remains the only persistent source', () => {
  const { channels, testRawConfigOf } = composeOutboundChannels({
    channels: [CH_BARK],
    yamlRows: new Map([['bark', YAML_BARK]]),
    store: fakeStore({
      'channel:bark:outbound': { key: 'state-key' },
      'admin:channel:bark:outbound': { key: 'retired-key' },
      'bark:account': { key: 'inbound-domain' },
    }),
    warn() {},
  })
  assert.equal(channels[0].config.endpoint, 'https://api.day.app/state-key')
  assert.equal(channels[0].config.timeoutMs, 7000)
  assert.deepEqual(testRawConfigOf('bark'), { key: 'state-key', timeoutMs: 7000 })
})

test('legacy overlay keys never activate outbound channels', () => {
  const input = [CH_BARK]
  const { channels, testRawConfigOf } = composeOutboundChannels({
    channels: input,
    yamlRows: new Map([['bark', YAML_BARK]]),
    store: fakeStore({ 'admin:channel:bark:outbound': { key: 'old' } }),
    warn() {},
  })
  assert.equal(channels, input)
  assert.deepEqual(testRawConfigOf('bark'), { key: 'yaml-key', timeoutMs: 7000 })
})

test('invalid canonical overlay preserves the YAML channel and emits a warning', () => {
  const warnings = []
  const { channels } = composeOutboundChannels({
    channels: [CH_BARK],
    yamlRows: new Map([['bark', YAML_BARK]]),
    store: fakeStore({ 'channel:bark:outbound': { key: '' } }),
    warn: (message) => warnings.push(message),
  })
  assert.equal(channels[0].config.endpoint, CH_BARK.config.endpoint)
  assert.equal(warnings.length, 1)
})
