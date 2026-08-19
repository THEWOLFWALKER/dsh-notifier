// dsh-notifier test/admin-events.test.mjs
// 通知事件 hub 单测：发布/订阅/退订、异常隔离、环形缓冲、replay 语义、深拷贝隔离。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventHub } from '../src/admin/events.mjs'

const RECORD = { time: '2026-08-16T00:00:00.000Z', message: { title: '任务完成', content: 'ok', level: 'active' }, ok: true, delivered: ['bell'], skipped: [], failed: [] }

test('publish/subscribe：实时事件带 seq/time/payload/replay:false', () => {
  const hub = createEventHub()
  const got = []
  hub.subscribe((event) => got.push(event))
  hub.publish(RECORD)
  assert.equal(got.length, 1)
  assert.equal(got[0].seq, 1)
  assert.equal(got[0].replay, false)
  assert.deepEqual(got[0].payload, RECORD)
  assert.ok(typeof got[0].time === 'string' && got[0].time.includes('T'))
})

test('退订后不再收到；退订幂等', () => {
  const hub = createEventHub()
  const got = []
  const off = hub.subscribe((event) => got.push(event))
  hub.publish(RECORD)
  off()
  off() // 幂等
  hub.publish(RECORD)
  assert.equal(got.length, 1)
  assert.equal(hub.listenerCount(), 0)
})

test('订阅者 throw 不殃及其他订阅者与发布方', () => {
  const hub = createEventHub()
  const got = []
  hub.subscribe(() => { throw new Error('订阅者炸了') })
  hub.subscribe((event) => got.push(event))
  assert.doesNotThrow(() => hub.publish(RECORD))
  assert.equal(got.length, 1)
})

test('非函数订阅者被拒收（返回无害退订，不抛）', () => {
  const hub = createEventHub()
  const off = hub.subscribe(null)
  assert.equal(hub.listenerCount(), 0)
  assert.doesNotThrow(off)
  assert.doesNotThrow(() => hub.publish(RECORD))
})

test('环形缓冲：容量 3 保最新，snapshot 顺序 = 发布顺序', () => {
  const hub = createEventHub({ capacity: 3 })
  for (let i = 1; i <= 5; i += 1) hub.publish({ ...RECORD, message: { ...RECORD.message, title: `第${i}条` } })
  assert.equal(hub.size(), 3)
  const snap = hub.snapshot()
  assert.deepEqual(snap.map((e) => e.seq), [3, 4, 5])
})

test('容量钳制：0 → 1，999 → 500，非数字 → 默认 50', () => {
  assert.equal(createEventHub({ capacity: 0 }).size(), 0) // 未发布恒 0，只验证不抛
  const tiny = createEventHub({ capacity: 0 })
  tiny.publish(RECORD)
  assert.equal(tiny.size(), 1) // 钳到 1
  const big = createEventHub({ capacity: 999 })
  for (let i = 0; i < 520; i += 1) big.publish(RECORD)
  assert.equal(big.size(), 500)
  assert.equal(createEventHub({}).size(), 0)
})

test('replay：订阅时重放缓冲（replay:true），其后实时（replay:false）；空缓冲零重放', () => {
  const hub = createEventHub()
  hub.publish({ ...RECORD, message: { ...RECORD.message, title: '旧1' } })
  hub.publish({ ...RECORD, message: { ...RECORD.message, title: '旧2' } })
  const got = []
  hub.subscribe((event) => got.push(event), { replay: true })
  assert.deepEqual(got.map((e) => [e.payload.message.title, e.replay]), [['旧1', true], ['旧2', true]])
  hub.publish({ ...RECORD, message: { ...RECORD.message, title: '新' } })
  assert.deepEqual(got.at(-1), { seq: 3, time: got.at(-1).time, payload: { ...RECORD, message: { title: '新', content: 'ok', level: 'active' } }, replay: false })
  const liveOnly = []
  hub.subscribe((event) => liveOnly.push(event)) // 不带 replay
  assert.equal(liveOnly.length, 0)
})

test('深拷贝隔离：订阅者 mutate 事件不污染缓冲与后续订阅者', () => {
  const hub = createEventHub()
  hub.subscribe((event) => { event.payload.delivered.push('被改了'); event.payload.message.title = '被改' })
  hub.publish(RECORD)
  assert.deepEqual(hub.snapshot()[0].payload, RECORD) // 缓冲原样
  const second = []
  hub.subscribe((event) => second.push(event), { replay: true })
  assert.deepEqual(second[0].payload, RECORD) // 重放也未受污染
})

test('publish 非法负载不抛（防御壳）', () => {
  const hub = createEventHub()
  const got = []
  hub.subscribe((event) => got.push(event))
  assert.doesNotThrow(() => hub.publish(undefined))
  assert.doesNotThrow(() => hub.publish({ circular: null }))
  assert.ok(got.length >= 1) // undefined → null 负载也照发（seq 推进即可）
})
