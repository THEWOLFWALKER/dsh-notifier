// v0.12.1 Phase C 回归测试（二）：未绑定来源的去重不得写入 state。
//
// 覆盖清单：P1-14（未绑定也 remember → dedup 键无条件落 state → 陌生来源可无限放大 state.json）。
//
// ⚠️ 本文件在修复前【必须失败】——修复前 50 条陌生消息会留下 50 个 dedup 键。
//
// 关键不变量（本文件刻意守住，防止「修 P1-14」顺手削弱正确行为）：
//   - 绑定成员的去重**必须**仍然持久化（bus.mjs 文件头军规：轮询 cursor 不落盘时靠它跨重启防重放）
//   - 未绑定来源的重复消息**仍必须**被内存 FIFO 拦住（去重能力不能被削弱）

import test from 'node:test'
import assert from 'node:assert/strict'
import { createInboundBus } from '../src/inbound/bus.mjs'

/** 记录所有写入键的 mock store（返回 true = 落盘成功，即真 store 的 durable 语义）。 */
function trackingStore() {
  const memory = new Map()
  return {
    get: (key) => memory.get(key),
    set: (key, value) => { memory.set(key, value); return true },
    delete: (key) => memory.delete(key),
    keys: (prefix = '') => [...memory.keys()].filter((key) => key.startsWith(prefix)),
    entries: () => [...memory.entries()],
  }
}

test('P1-14：未绑定来源的消息不得把去重键落进 store（state.json 不因陌生消息增长）', () => {
  const store = trackingStore()
  const bus = createInboundBus({ store })

  for (let index = 0; index < 50; index += 1) {
    const result = bus.accept({ channel: 'telegram', userId: 'stranger', messageId: `m-${index}`, text: 'hi' })
    assert.equal(result.ok, false, '未绑定来源必须被拒绝')
  }

  const dedupKeys = store.keys('dedup:')
  assert.equal(
    dedupKeys.length,
    0,
    `未绑定来源不得持久化去重键（实际 ${dedupKeys.length} 个）—— 否则陌生来源可用不同 messageId 无限放大 state.json`,
  )
  bus.dispose()
})

test('P1-14：未绑定来源的重复消息仍被内存 FIFO 拦住（去重能力未被削弱）', () => {
  const store = trackingStore()
  const bus = createInboundBus({ store })
  const envelope = { channel: 'telegram', userId: 'stranger', messageId: 'dup-1', text: 'hi' }

  assert.equal(bus.accept(envelope).reason, 'whitelist')
  assert.equal(bus.accept(envelope).reason, 'duplicate', '同一 messageId 重投仍必须被内存 FIFO 拦住')
  bus.dispose()
})

test('P1-14：绑定成员的去重仍必须持久化（跨重启防重复消费）', () => {
  const store = trackingStore()
  const bus = createInboundBus({ store, allowUsers: ['42'] })

  const result = bus.accept({ channel: 'telegram', userId: '42', messageId: 'b-1', text: 'hi' })
  assert.notEqual(result.reason, 'whitelist', '绑定成员不应被拒')
  assert.equal(store.keys('dedup:').length, 1, '绑定成员的去重键必须落盘（本项不得削弱这条军规）')
  bus.dispose()
})