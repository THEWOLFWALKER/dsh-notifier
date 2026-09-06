// G-59 测试：approval/escalation.mjs（升级链状态机）阶段推进。
// 用 node:test mock 定时器（确定性推进，不等真实时钟），覆盖：
//  - 多阶段按累计延迟依次触发，onStage 收到 (key, stage, index)，stageOf 递增
//  - 相对延迟语义：afterMs 相对上一阶段（不是绝对时间点）
//  - 多 key 链互不干扰；未知 key stageOf = 0
//  - 重启链清旧计时器（不双发）；早停/stop 后剩余阶段不再触发、stageOf 归零
//  - onStage 抛异常被吞（A listener never throws），warn 出声
//  - stages 为空 start 是 no-op；dispose 清一切
//  - afterMs 归一化：负数 / NaN / 字符串按 0（Math.max(0, Number(afterMs) || 0)）

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEscalationChain } from '../src/approval/escalation.mjs'

test('G-59 阶段推进：多阶段按累计延迟依次触发，stageOf 递增，onStage 带 index', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fired = []
    const chain = createEscalationChain({
      stages: [{ afterMs: 10, level: 'loud' }, { afterMs: 20, level: 'critical' }],
    })
    chain.start('k1', (key, stage, index) => fired.push({ key, level: stage.level, index }))
    assert.equal(chain.stageOf('k1'), 0, '未触发前 stageOf=0')
    t.mock.timers.tick(5)
    assert.equal(fired.length, 0, '10ms 前不触发')
    t.mock.timers.tick(6) // 累计 11ms ≥ 10ms：第 1 阶段
    assert.deepEqual(fired, [{ key: 'k1', level: 'loud', index: 0 }])
    assert.equal(chain.stageOf('k1'), 1)
    t.mock.timers.tick(10) // 累计 21ms：仍未到 10+20=30ms
    assert.equal(fired.length, 1, '相对上一阶段累计：第 2 段需再等 20ms（不是绝对 20ms 点）')
    t.mock.timers.tick(10) // 累计 31ms ≥ 30ms：第 2 阶段
    assert.deepEqual(fired, [
      { key: 'k1', level: 'loud', index: 0 },
      { key: 'k1', level: 'critical', index: 1 },
    ])
    assert.equal(chain.stageOf('k1'), 2)
    t.mock.timers.tick(1000)
    assert.equal(fired.length, 2, '全部触发后不再多发')
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 多 key 独立：两条链各自推进互不干扰；未知 key stageOf=0', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fired = []
    const chain = createEscalationChain({ stages: [{ afterMs: 10, note: 'a' }, { afterMs: 10, note: 'b' }] })
    chain.start('x', (_k, stage) => fired.push(`x:${stage.note}`))
    chain.start('y', (_k, stage) => fired.push(`y:${stage.note}`))
    assert.equal(chain.stageOf('nope'), 0, '从未 start 的 key → 0')
    t.mock.timers.tick(10)
    assert.deepEqual(fired, ['x:a', 'y:a'], '两条链第一段同拍触发')
    assert.equal(chain.stageOf('x'), 1)
    assert.equal(chain.stageOf('y'), 1)
    chain.stop('x') // 只停 x
    t.mock.timers.tick(10)
    assert.deepEqual(fired, ['x:a', 'y:a', 'y:b'], 'x 停止后不再推进，y 照常到第二段')
    assert.equal(chain.stageOf('x'), 0, '停止的链 stageOf 归零')
    assert.equal(chain.stageOf('y'), 2)
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 重启链清旧计时器：同 key 二次 start 不双发', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fired = []
    const chain = createEscalationChain({ stages: [{ afterMs: 10 }] })
    chain.start('k', () => fired.push('old'))
    chain.start('k', () => fired.push('new')) // 重启：旧计时器必须清掉
    t.mock.timers.tick(20)
    assert.deepEqual(fired, ['new'])
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 早停：首个阶段触发前 stop → 无一触发，stageOf 归零', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fired = []
    const chain = createEscalationChain({ stages: [{ afterMs: 10 }, { afterMs: 10 }] })
    chain.start('k', (_k, stage) => fired.push(stage.afterMs))
    chain.stop('k')
    t.mock.timers.tick(50)
    assert.deepEqual(fired, [])
    assert.equal(chain.stageOf('k'), 0)
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 onStage 抛异常被吞：链继续推进，warn 出声（A listener never throws）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const warns = []
    const fired = []
    const chain = createEscalationChain({
      stages: [{ afterMs: 10, note: 'boom' }, { afterMs: 10, note: 'ok' }],
      logger: { warn: (...args) => warns.push(args.join(' ')) },
    })
    chain.start('k', (_key, stage) => {
      if (stage.note === 'boom') throw new Error('boom')
      fired.push(stage.note)
    })
    t.mock.timers.tick(10)
    assert.equal(fired.length, 0, '第 1 段抛错被吞')
    assert.ok(warns.some((w) => w.includes('升级阶段 1 执行异常') && w.includes('boom')),
      `warn 必须点名阶段与异常（实际：${warns.join(' | ') || '(无)'}`)
    t.mock.timers.tick(10)
    assert.deepEqual(fired, ['ok'], '抛错不影响后续阶段推进')
    assert.equal(chain.stageOf('k'), 2)
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 stages 为空 start 是 no-op；dispose 清一切', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const chain = createEscalationChain({ stages: [] })
    chain.start('k', () => assert.fail('不应触发'))
    assert.equal(chain.stageOf('k'), 0)
    t.mock.timers.tick(1000)
    chain.dispose()

    const chain2 = createEscalationChain({ stages: [{ afterMs: 10 }] })
    const fired = []
    chain2.start('x', () => fired.push(1))
    chain2.dispose()
    t.mock.timers.tick(1000)
    assert.deepEqual(fired, [], 'dispose 后计时器不再触发')
  } finally {
    t.mock.timers.reset()
  }
})

test('G-59 afterMs 归一化：负数 / NaN / 字符串按 0 处理（同拍顺序触发）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fired = []
    const chain = createEscalationChain({
      stages: [{ afterMs: -5 }, { afterMs: Number.NaN }, { afterMs: 'abc' }],
    })
    chain.start('k', (_k, stage) => fired.push(stage.afterMs))
    t.mock.timers.tick(1) // 三段延迟均归一为 0 → 一拍内按序全触发
    assert.deepEqual(fired, [-5, Number.NaN, 'abc'], '原始 stage 透传（仅延迟被归一，不篡改配置）')
    assert.equal(chain.stageOf('k'), 3)
    chain.dispose()
  } finally {
    t.mock.timers.reset()
  }
})
