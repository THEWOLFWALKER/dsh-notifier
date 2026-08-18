import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInbound } from '../src/inbound/_contract.mjs'
import { collectContractFactories, normalizeContractChannels } from './_helpers.mjs'

test('契约回归：六通道真实例 normalizeInbound 后 channel 非空且等于预期', () => {
  const entries = normalizeContractChannels()
  assert.equal(entries.length, 6, `应登记 6 通道，实际 ${entries.length}`)
  for (const { name, expectedChannel, channel } of entries) {
    assert.ok(channel !== null && channel !== '', `${name}: normalizeInbound 后 channel 应为非空字符串，实得 ${JSON.stringify(channel)}`)
    assert.equal(channel, expectedChannel, `${name}: channel 应等于 ${expectedChannel}`)
  }
})

test('契约回归：六通道 raw 实例自身声明 channel 字段（杜绝仅靠 legacy 兜底蒙混）', () => {
  const seen = new Set()
  for (const { name, expectedChannel, raw } of collectContractFactories()) {
    const instance = raw()
    assert.ok(!seen.has(name), `重复注册通道: ${name}`)
    seen.add(name)
    assert.equal(instance.channel, expectedChannel, `${name}: raw 实例自显 channel 应等于 ${expectedChannel}`)
    assert.ok(normalizeInbound(instance)?.channel === expectedChannel, `${name}: normalizeInbound 结果 channel 应等于 ${expectedChannel}`)
  }
  assert.deepEqual([...seen].sort(), ['dingtalk', 'feishu', 'qq', 'telegram', 'wechat', 'wxpusher'], '六通道齐全')
})
