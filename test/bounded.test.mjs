// v0.8.7 P1-7 测试：inbound/_bounded（有界 Map 写入 + 节流 warn，宪法#4「状态必须有界」）。
// 纯内存 + 时钟注入，零 IO。覆盖：上限触发淘汰 / LRU 触摸保热键 / 淘汰回调 /
// cap 三态（正常·上下边界·越界）/ 存量超量收敛 / 节流窗口累计。

import test from 'node:test'
import assert from 'node:assert/strict'
import { setBounded, createThrottledWarn, DEFAULT_MAP_MAX } from '../src/inbound/_bounded.mjs'

/** 可拨动假时钟（与 breaker.test.mjs 同款）。 */
function makeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

// ---------------------------------------------------------------- setBounded 基本

test('setBounded：未达上限不淘汰，返回 0；写后 size 递增', () => {
  const map = new Map()
  assert.equal(setBounded(map, 'a', 1, 3), 0)
  assert.equal(setBounded(map, 'b', 2, 3), 0)
  assert.equal(setBounded(map, 'c', 3, 3), 0, '正好写满上限仍不淘汰')
  assert.equal(map.size, 3)
  assert.deepEqual([...map.keys()], ['a', 'b', 'c'])
  assert.equal(map.get('b'), 2)
})

test('setBounded：越上限淘汰最旧，写后 size 恒等于 cap（不多不少）', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3]])
  assert.equal(setBounded(map, 'd', 4, 3), 1, '淘汰 1 条')
  assert.equal(map.size, 3, '写后必须收敛到 cap')
  assert.equal(map.has('a'), false, '最旧（迭代首端）被淘汰')
  assert.deepEqual([...map.keys()], ['b', 'c', 'd'])
})

test('setBounded：同键重复写不增长、不淘汰（重排不是新增）', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3]])
  assert.equal(setBounded(map, 'b', 22, 3), 0, '已存在键写入永不淘汰他人')
  assert.equal(map.size, 3)
  assert.equal(map.get('b'), 22, '值被更新')
})

test('setBounded：LRU 触摸——更新过的键移到最新端，后续溢出淘汰的是别人（热键不被误淘汰）', () => {
  const map = new Map([['hot', 1], ['b', 2], ['c', 3]])
  setBounded(map, 'hot', 11, 3) // 触摸：hot 从首端移到末端
  assert.deepEqual([...map.keys()], ['b', 'c', 'hot'], '触摸后迭代序刷新')
  assert.equal(setBounded(map, 'd', 4, 3), 1)
  assert.equal(map.has('hot'), true, '活跃键必须存活（首次学习早不该成为淘汰理由）')
  assert.equal(map.has('b'), false, '淘汰的是未被触摸的最旧键')
  assert.equal(map.get('hot'), 11)
})

test('setBounded：onEvict 收到被淘汰的键与值；不淘汰时绝不调用', () => {
  const map = new Map([['a', { v: 1 }], ['b', { v: 2 }]])
  const evicted = []
  assert.equal(setBounded(map, 'c', { v: 3 }, 2, (k, v) => evicted.push([k, v])), 1)
  assert.deepEqual(evicted, [['a', { v: 1 }]])
  evicted.length = 0
  setBounded(map, 'c', { v: 33 }, 2, (k, v) => evicted.push([k, v]))
  assert.deepEqual(evicted, [], '同键更新不触发淘汰回调')
})

test('setBounded：onEvict 抛错绝不致命，写入照常完成（宪法#7 故障隔离）', () => {
  const map = new Map([['a', 1], ['b', 2]])
  assert.doesNotThrow(() => {
    setBounded(map, 'c', 3, 2, () => { throw new Error('回调炸了') })
  })
  assert.equal(map.size, 2)
  assert.equal(map.get('c'), 3, '回调异常不得吞掉本次写入')
  assert.equal(map.has('a'), false, '淘汰仍已发生')
})

test('setBounded：非函数 onEvict（null/字符串/undefined）不抛，正常淘汰', () => {
  for (const bad of [null, undefined, 'warn', 42, {}]) {
    const map = new Map([['a', 1], ['b', 2]])
    assert.doesNotThrow(() => setBounded(map, 'c', 3, 2, bad))
    assert.equal(map.size, 2)
  }
})

// ---------------------------------------------------------------- cap 三态（正常 / 上下边界 / 越界）

test('setBounded：cap 下边界 max=1 —— 每次新键都淘汰上一条，表恒只留 1 条', () => {
  const map = new Map()
  for (let i = 0; i < 5; i += 1) setBounded(map, `k${i}`, i, 1)
  assert.equal(map.size, 1)
  assert.deepEqual([...map.keys()], ['k4'])
})

test('setBounded：cap 越界 —— 负整数一律钳到 1（绝不出现 size 0 或负容量）', () => {
  for (const bad of [-5, -1, -1024]) {
    const map = new Map()
    for (let i = 0; i < 3; i += 1) setBounded(map, `k${i}`, i, bad)
    assert.equal(map.size, 1, `cap=${bad} 应钳到 1`)
    assert.deepEqual([...map.keys()], ['k2'])
  }
})

test('setBounded：小数 cap 先 trunc 再判——|cap|<1 截断成 ±0 后回落默认 1024（不是钳 1）', () => {
  for (const frac of [0.4, 0.9, -0.5, -0.9]) {
    const map = new Map()
    for (let i = 0; i < 5; i += 1) setBounded(map, `k${i}`, i, frac)
    assert.equal(map.size, 5, `cap=${frac} → trunc ±0 → falsy → 回落 ${DEFAULT_MAP_MAX}`)
  }
})

test('setBounded：cap 畸形（0/NaN/null/字符串/未传）回落 DEFAULT_MAP_MAX——宽容而非钳 1（现状语义钉死）', () => {
  assert.equal(DEFAULT_MAP_MAX, 1024)
  for (const bad of [0, NaN, null, undefined, 'abc', {}]) {
    const map = new Map()
    for (let i = 0; i < 5; i += 1) setBounded(map, `k${i}`, i, bad)
    assert.equal(map.size, 5, `cap=${String(bad)} 应回落默认上限（1024），5 条不该被淘汰`)
  }
  const bare = new Map()
  for (let i = 0; i < 5; i += 1) setBounded(bare, `k${i}`, i) // 完全不传 max
  assert.equal(bare.size, 5)
})

test('setBounded：数字字符串 cap 被采纳；小数 cap 向零截断（2.9 → 2）', () => {
  const strCap = new Map()
  for (let i = 0; i < 5; i += 1) setBounded(strCap, `k${i}`, i, '3')
  assert.deepEqual([...strCap.keys()], ['k2', 'k3', 'k4'], "cap='3' 生效为 3")
  const frac = new Map()
  for (let i = 0; i < 4; i += 1) setBounded(frac, `k${i}`, i, 2.9)
  assert.deepEqual([...frac.keys()], ['k2', 'k3'], 'trunc(2.9)=2')
})

test('setBounded：cap=Infinity 永不淘汰（现状语义：无上限即无界，调用方不得依赖它做保护）', () => {
  const map = new Map()
  for (let i = 0; i < 50; i += 1) setBounded(map, `k${i}`, i, Infinity)
  assert.equal(map.size, 50)
})

test('setBounded：存量超量一次收敛到 cap（while 而非 if——上限调小/历史遗留也能收敛）', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]])
  const evicted = []
  const dropped = setBounded(map, 'f', 6, 2, (k) => evicted.push(k))
  assert.equal(dropped, 4, '一次写入淘汰 4 条历史超量')
  assert.deepEqual(evicted, ['a', 'b', 'c', 'd'], '按最旧优先顺序淘汰')
  assert.deepEqual([...map.keys()], ['e', 'f'])
})

test('setBounded：cap 1024 规模压测——写 3000 条后恒为 1024 且留最新一批', () => {
  const map = new Map()
  let total = 0
  for (let i = 0; i < 3000; i += 1) total += setBounded(map, `k${i}`, i, 1024)
  assert.equal(map.size, 1024)
  assert.equal(total, 3000 - 1024, '淘汰总数 = 写入量 - 容量')
  assert.equal(map.has('k2999'), true)
  assert.equal(map.has('k1976'), true, '边界内最旧存活条目（3000-1024=1976）')
  assert.equal(map.has('k1975'), false, '刚越界的条目已淘汰')
})

test('setBounded：键本身为 undefined 时淘汰仍生效（空转护栏不得把它当空表 break）', () => {
  const map = new Map()
  setBounded(map, undefined, 'first', 2)
  setBounded(map, 'b', 'second', 2)
  assert.equal(map.size, 2)
  const evicted = []
  assert.equal(setBounded(map, 'c', 'third', 2, (k) => evicted.push(k)), 1, 'undefined 键同样按最旧被淘汰')
  assert.equal(map.size, 2, '表不得越过 cap（护栏漏洞会让它涨到 3）')
  assert.equal(map.has(undefined), false)
  assert.deepEqual(evicted, [undefined])
})

test('setBounded：值为 undefined 不影响记账（不因 falsy 值误判为空槽）', () => {
  const map = new Map([['a', undefined], ['b', undefined]])
  assert.equal(setBounded(map, 'c', undefined, 2), 1)
  assert.equal(map.size, 2)
  assert.equal(map.has('a'), false)
})

// ---------------------------------------------------------------- createThrottledWarn

test('createThrottledWarn：首次立即出声（count=1），窗内静默但累计，越窗一次报出累计数', () => {
  const clock = makeClock()
  const lines = []
  const warn = createThrottledWarn((m) => lines.push(m), { intervalMs: 60000, now: clock.now })
  warn((n) => `淘汰 ${n}`)
  assert.deepEqual(lines, ['淘汰 1'], '首次必须出声（宪法#3 静默即事故）')
  warn((n) => `淘汰 ${n}`)
  warn((n) => `淘汰 ${n}`)
  assert.equal(lines.length, 1, '窗内静默（防日志洪水）')
  clock.advance(59999)
  warn((n) => `淘汰 ${n}`)
  assert.equal(lines.length, 1, '差 1ms 仍在窗内')
  clock.advance(1)
  warn((n) => `淘汰 ${n}`)
  assert.deepEqual(lines, ['淘汰 1', '淘汰 4'], '越窗报出窗内累计（2+3+4 次共 4 条被吞后连本次一并报）')
  warn((n) => `淘汰 ${n}`)
  assert.equal(lines.length, 2, '报出后计数清零，重新进入窗口')
})

test('createThrottledWarn：intervalMs=0/负数/NaN → 每次都出声（不静默任何一次）', () => {
  for (const interval of [0, -1000, NaN, null]) {
    const lines = []
    const warn = createThrottledWarn((m) => lines.push(m), { intervalMs: interval, now: makeClock().now })
    warn((n) => `x${n}`)
    warn((n) => `x${n}`)
    warn((n) => `x${n}`)
    assert.deepEqual(lines, ['x1', 'x1', 'x1'], `intervalMs=${String(interval)} 应逐次出声`)
  }
})

test('createThrottledWarn：底层 warn 抛错不致命，且计数已清零（不会因失败无限累计）', () => {
  const clock = makeClock()
  let calls = 0
  const warn = createThrottledWarn(() => { calls += 1; throw new Error('日志失败') }, { intervalMs: 100, now: clock.now })
  assert.doesNotThrow(() => warn((n) => `x${n}`))
  assert.equal(calls, 1)
  clock.advance(200)
  const seen = []
  const warn2 = createThrottledWarn((m) => seen.push(m), { intervalMs: 100, now: clock.now })
  warn2((n) => `y${n}`)
  assert.deepEqual(seen, ['y1'])
})

test('createThrottledWarn：默认 intervalMs=60000 且默认时钟为 Date.now（缺省参数可用）', () => {
  const lines = []
  const warn = createThrottledWarn((m) => lines.push(m))
  warn((n) => `z${n}`)
  warn((n) => `z${n}`)
  assert.deepEqual(lines, ['z1'], '默认 60s 窗口内第二次被吞')
})

test('createThrottledWarn：compose 抛错被吞（日志组装失败不致命），后续仍可出声', () => {
  const clock = makeClock()
  const lines = []
  const warn = createThrottledWarn((m) => lines.push(m), { intervalMs: 100, now: clock.now })
  assert.doesNotThrow(() => warn(() => { throw new Error('组装失败') }))
  assert.deepEqual(lines, [])
  clock.advance(200)
  warn((n) => `ok${n}`)
  assert.deepEqual(lines, ['ok1'])
})
