// 阶段 4 测试：inbound/_breaker（阈值/窗口/开路/复位/半开，时钟全注入零等待）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createBreaker } from '../src/inbound/_breaker.mjs'

/** 可拨动假时钟。 */
function makeClock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => { now += ms },
  }
}

test('默认合闸：isOpen=false，remainingMs=0', () => {
  const breaker = createBreaker({ threshold: 2, openMs: 5000 })
  assert.equal(breaker.isOpen(), false)
  assert.equal(breaker.remainingMs(), 0)
  assert.equal(breaker.failures(), 0)
})

test('阈值内不炸：threshold=3 时第 1/2 次 trip 返回 false', () => {
  const breaker = createBreaker({ threshold: 3, windowMs: 60000, openMs: 15000 })
  assert.equal(breaker.trip(), false)
  assert.equal(breaker.failures(), 1)
  assert.equal(breaker.trip(), false)
  assert.equal(breaker.isOpen(), false)
})

test('达到阈值开路：第 3 次 trip 返回 true，isOpen=true 且 remainingMs≈openMs', () => {
  const clock = makeClock()
  const breaker = createBreaker({ threshold: 3, windowMs: 60000, openMs: 15000, now: clock.now })
  breaker.trip()
  breaker.trip()
  assert.equal(breaker.trip(), true, '第 3 次触发开路')
  assert.equal(breaker.isOpen(), true)
  assert.equal(breaker.remainingMs(), 15000)
})

test('开路期满自动半开（isOpen 回落 false 放行试探）', () => {
  const clock = makeClock()
  const breaker = createBreaker({ threshold: 1, windowMs: 60000, openMs: 15000, now: clock.now })
  breaker.trip()
  assert.equal(breaker.isOpen(), true)
  clock.advance(14999)
  assert.equal(breaker.isOpen(), true, '差 1ms 仍开路')
  clock.advance(1)
  assert.equal(breaker.isOpen(), false, '到点半开')
})

test('窗口滑动：旧失败滚出窗口后不再累计（新失败凑不满阈值）', () => {
  const clock = makeClock()
  const breaker = createBreaker({ threshold: 3, windowMs: 60000, openMs: 15000, now: clock.now })
  breaker.trip()
  breaker.trip()
  clock.advance(61000) // 前两次滚出窗口
  assert.equal(breaker.failures(), 0, '窗口外失败不计数')
  assert.equal(breaker.trip(), false, '单次新失败不开路')
  assert.equal(breaker.isOpen(), false)
})

test('reset 清零并合闸（发送成功 / 收到入站消息即解锁）', () => {
  const clock = makeClock()
  const breaker = createBreaker({ threshold: 2, windowMs: 60000, openMs: 15000, now: clock.now })
  breaker.trip()
  breaker.trip()
  assert.equal(breaker.isOpen(), true)
  breaker.reset()
  assert.equal(breaker.isOpen(), false, '开路中 reset 立即合闸')
  assert.equal(breaker.failures(), 0)
  assert.equal(breaker.remainingMs(), 0)
})

test('重复开路续期：已开路再 trip 用 max 保持最长到期点', () => {
  const clock = makeClock()
  const breaker = createBreaker({ threshold: 1, windowMs: 60000, openMs: 15000, now: clock.now })
  breaker.trip()
  clock.advance(10000) // 剩 5s
  breaker.trip() // 事件仍在窗口内 → 再开 15s（从现在起）
  assert.equal(breaker.remainingMs(), 15000, '续期到最新 trip + openMs')
})

test('参数防御：非法配置回落默认（threshold≥1 / window≥1000）', () => {
  const breaker = createBreaker({ threshold: 0, windowMs: 10, openMs: -5 })
  assert.equal(breaker.trip(), true, 'threshold 回落 1：单次即开')
  const safe = createBreaker({ threshold: 'abc', windowMs: 'x' })
  assert.equal(safe.trip(), false, 'threshold 回落 3')
})
