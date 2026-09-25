import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'

test('outbound source swaps snapshots atomically and exposes dynamic getters', () => {
  const source = createOutboundSource([{ type: 'telegram', config: { a: 1 } }])
  const first = source.snapshot()
  assert.equal(first.length, 1)
  source.replace('bark', { b: 2 })
  assert.deepEqual(source.types().sort(), ['bark', 'telegram'])
  assert.equal(first.length, 1, 'previous snapshot stays stable')
  assert.equal(source.get('bark').config.b, 2)
  assert.equal(source.remove('telegram'), true)
  assert.deepEqual(source.types(), ['bark'])
})
