// turn-tracker.test.mjs — v0.5 状态上报线核心：建档/清档生命周期、stall 判定、
// 心跳节奏、user/* 不算活跃、未知类型按活跃、淘汰与 dispose。全注入零真实定时器。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTracker } from '../src/status/turn-tracker.mjs'

/** 可手动推进的假时钟 + 假定时器（advance 依序触发到期项，回调内可再装新定时器）。 */
function fakeTimers(startMs = 1_000_000) {
  let seq = 0
  let nowMs = startMs
  const timers = new Map()
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    setTimeoutFn(fn, ms) {
      seq += 1
      timers.set(seq, { at: nowMs + ms, fn })
      return seq
    },
    clearTimeoutFn(id) {
      timers.delete(id)
    },
    pendingCount: () => timers.size,
  }
}

const session = (id) => ({ id, header: { cwd: `/ws/${id}` } })
const startEvent = (seq) => ({ type: 'turn/start', seq })
const endEvent = (seq) => ({ type: 'turn/end', seq, data: { reason: { kind: 'completed' } } })

test('turn/start 建档、turn/end 清档（清定时器）', () => {
  const t = fakeTimers()
  const tracker = createTurnTracker({
    heartbeat: { firstAfterMs: 300_000, everyMs: 300_000 },
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onHeartbeat: () => {}, onStall: () => {},
  })
  assert.equal(tracker.trackedCount(), 0)
  tracker.observe(session('s1'), startEvent(1))
  assert.equal(tracker.trackedCount(), 1)
  assert.ok(t.pendingCount() >= 2, '建档即装心跳 + 卡住两个定时器')
  tracker.observe(session('s1'), endEvent(2))
  assert.equal(tracker.trackedCount(), 0)
  assert.equal(t.pendingCount(), 0, '清档清空全部定时器')
})

test('stall：静默 afterMs 触发一次，同一静默期不重复', () => {
  const t = fakeTimers()
  const stalls = []
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onStall: (_session, info) => stalls.push(info),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(600_000)
  assert.equal(stalls.length, 1, '10min 无事件触发一次')
  t.advance(600_000)
  assert.equal(stalls.length, 1, '继续静默不再重复（每静默期一次）')
  assert.equal(stalls[0].idleMs >= 600_000, true, 'idleMs 反映静默时长')
})

test('stall：活跃事件重置静默期，之后可再报', () => {
  const t = fakeTimers()
  const stalls = []
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onStall: () => stalls.push(1),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(300_000)
  tracker.observe(session('s1'), { type: 'assistant/chunk', seq: 2 }) // 刷新活跃
  t.advance(300_000)
  assert.equal(stalls.length, 0, '从刷新点重新计时，未到 10min')
  t.advance(300_000)
  assert.equal(stalls.length, 1, '到 10min 触发；刷新后重装可再报')
})

test('user/* 事件不刷新活跃（用户打字 ≠ agent 进展）', () => {
  const t = fakeTimers()
  const stalls = []
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onStall: () => stalls.push(1),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(540_000) // 9min
  tracker.observe(session('s1'), { type: 'user/message', seq: 2 }) // 若刷新则永不会触发
  t.advance(60_000) // 距建档 10min（距 user 事件仅 1min）
  assert.equal(stalls.length, 1, 'user/* 不算 agent 活跃，卡住照报')
})

test('未知事件类型按活跃处理（宁漏报不误报）', () => {
  const t = fakeTimers()
  const stalls = []
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onStall: () => stalls.push(1),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(540_000)
  tracker.observe(session('s1'), { type: 'future/new-event-kind', seq: 2 })
  t.advance(60_000)
  assert.equal(stalls.length, 0, '未知类型视为活跃，从刷新点重新计时')
  t.advance(540_000)
  assert.equal(stalls.length, 1)
})

test('心跳：firstAfterMs 首跳，此后每 everyMs 一跳，turn/end 停跳', () => {
  const t = fakeTimers()
  const beats = []
  const tracker = createTurnTracker({
    heartbeat: { firstAfterMs: 900_000, everyMs: 900_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onHeartbeat: (_session, info) => beats.push(info),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(899_999)
  assert.equal(beats.length, 0, '首跳前静默')
  t.advance(1)
  assert.equal(beats.length, 1, 'firstAfter 精确触发')
  t.advance(900_000)
  assert.equal(beats.length, 2, '此后按 everyMs 周期跳动')
  assert.equal(beats[1].elapsedMs >= 1_800_000, true, 'elapsedMs 反映 turn 总时长')
  tracker.observe(session('s1'), endEvent(9))
  t.advance(1_800_000)
  assert.equal(beats.length, 2, 'turn/end 清档后心跳停止')
})

test('心跳与 stall 并存互不干扰（两个独立定时器）', () => {
  const t = fakeTimers()
  const beats = []
  const stalls = []
  const tracker = createTurnTracker({
    heartbeat: { firstAfterMs: 900_000, everyMs: 900_000 },
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onHeartbeat: () => beats.push(1),
    onStall: () => stalls.push(1),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(600_000)
  assert.equal(stalls.length, 1, '10min 触发卡住')
  assert.equal(beats.length, 0, '15min 心跳未到')
  t.advance(300_000)
  assert.equal(beats.length, 1, '15min 心跳照跳（卡住已报不抑制心跳）')
})

test('turn/start 重复（upsert）：重置计时与心跳计数', () => {
  const t = fakeTimers()
  const beats = []
  const tracker = createTurnTracker({
    heartbeat: { firstAfterMs: 900_000, everyMs: 900_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onHeartbeat: () => beats.push(1),
  })
  tracker.observe(session('s1'), startEvent(1))
  t.advance(300_000)
  tracker.observe(session('s1'), startEvent(5)) // 同会话新 turn：upsert 重置
  assert.equal(tracker.trackedCount(), 1, '不产生重复档')
  t.advance(600_000)
  assert.equal(beats.length, 0, '从新 turn/start 重新计 firstAfter')
  t.advance(300_000)
  assert.equal(beats.length, 1)
})

test('agent/disposed 清档', () => {
  const t = fakeTimers()
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
  })
  tracker.observe(session('s1'), startEvent(1))
  tracker.observeAgentDisposed({ id: 's1' })
  assert.equal(tracker.trackedCount(), 0)
  assert.equal(t.pendingCount(), 0)
  tracker.observeAgentDisposed(null) // 防御：不抛
  tracker.observeAgentDisposed({}) // 无 id：无害空转
})

test('MAX_TRACKED 淘汰最旧（防泄漏）', () => {
  const t = fakeTimers()
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
  })
  for (let index = 0; index < 32; index += 1) {
    tracker.observe(session(`s${index}`), startEvent(1))
    t.advance(1_000)
  }
  assert.equal(tracker.trackedCount(), 32)
  tracker.observe(session('s-new'), startEvent(1)) // 第 33 个：淘汰 lastEventAt 最旧的 s0
  assert.equal(tracker.trackedCount(), 32)
})

test('全关配置（heartbeat/stall 均 null）：observe 不建任何定时器', () => {
  const t = fakeTimers()
  const tracker = createTurnTracker({
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
  })
  tracker.observe(session('s1'), startEvent(1))
  tracker.observe(session('s1'), { type: 'assistant/chunk', seq: 2 })
  assert.equal(tracker.trackedCount(), 1, '档仍建（清档逻辑可用），但不装定时器')
  assert.equal(t.pendingCount(), 0)
})

test('dispose：清全部档与定时器', () => {
  const t = fakeTimers()
  const tracker = createTurnTracker({
    heartbeat: { firstAfterMs: 900_000, everyMs: 900_000 },
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
  })
  tracker.observe(session('s1'), startEvent(1))
  tracker.observe(session('s2'), startEvent(1))
  assert.ok(t.pendingCount() >= 4)
  tracker.dispose()
  assert.equal(tracker.trackedCount(), 0)
  assert.equal(t.pendingCount(), 0)
})

test('全防御：null session/event、无 id、非字符串 type 均不抛', () => {
  const tracker = createTurnTracker({})
  tracker.observe(null, startEvent(1))
  tracker.observe(session('s1'), null)
  tracker.observe({}, startEvent(1))
  tracker.observe(session('s1'), { type: 42 })
  tracker.dispose()
})

test('未建档会话的事件不追既往（无 turn/start 的存量会话）', () => {
  const t = fakeTimers()
  const stalls = []
  const tracker = createTurnTracker({
    stall: { afterMs: 600_000 },
    now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
    onStall: () => stalls.push(1),
  })
  tracker.observe(session('s1'), { type: 'assistant/chunk', seq: 2 })
  t.advance(3_600_000)
  assert.equal(stalls.length, 0, '无档则无定时器')
})
