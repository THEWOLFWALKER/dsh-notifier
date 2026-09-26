// v0.12.1 Phase A：ledger 上限数值归一（P1-22）+ prune 触发语义不变（P1-20 的可观测面）。
//
// bug 机制（src/ledger.mjs:66）：
//   const maxEntries = Math.max(50, Math.trunc(options.maxEntries ?? 500))
//
// `options.maxEntries ?? 500` 只在 null/undefined 时回退。传入非数字字符串时：
//   Math.trunc('abc') === NaN  →  Math.max(50, NaN) === NaN
// 于是 maybePrune 的判据变成两种坏形态：
//
//   ① NaN → `lines.length <= NaN * 2` 恒为 false → 每次都进重写分支，
//      而 `lines.slice(-NaN)` === `slice(0)` 保留【全量】。
//      ⇒ 每发一条通知，就把整个 ledger 读一遍 + 全量写一遍。
//        （注释 :98 写的是「摊销 O(n)，日常零开销」——意图是摊销，实现却是每次全量。）
//
//   ② Infinity / 极大值 → `lines.length <= Infinity * 2` 恒为 true → 永不 prune
//      ⇒ 文件无界增长。
//
// 两种形态都必须在归一后消失：非法值退回默认 500，合法值行为完全不变。
//
// ⚠️ 本文件在修复前【必须失败】（① 与 ② 的断言都会失败）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger } from '../src/ledger.mjs'

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-v0121-ledger-'))

const record = (index = 0) => ({
  time: new Date(Date.parse('2026-08-14T00:00:00Z') + index * 1000).toISOString(),
  message: { title: '✅ 任务完成', content: `c${index}`, level: 'active' },
  ok: true,
  delivered: ['telegram'],
  failed: [],
})

/** 追加 N 条并返回账本文件的行数。 */
function fill(ledger, dir, count) {
  for (let index = 0; index < count; index += 1) ledger.append(record(index))
  return readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').length
}

const withLedger = (options, fn) => {
  const dir = tempDir()
  try {
    return fn(createLedger({ dir, ...options }), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─────────────────── ① 非法值不得退化成「每次全量重写」（NaN） ───────────────────

const NON_NUMERIC_STRINGS = ['abc', '100abc', 'Infinityx', '', '  ']

for (const raw of NON_NUMERIC_STRINGS) {
  test(`P1-22①：maxEntries=${JSON.stringify(raw)} 归一后必须有界，不得每次全量重写`, () => {
    const lines = withLedger({ maxEntries: raw }, (ledger, dir) => fill(ledger, dir, 1100))
    assert.ok(
      lines <= 1000,
      `maxEntries 非法时必须归一（默认 500 → 触发线 1000），实际 ${lines} 条 —— ` +
      '说明 maxEntries 仍是 NaN，每次 append 都在全量读 + 全量重写',
    )
  })
}

test('P1-22①：maxEntries=NaN（数字型）同样必须归一', () => {
  const lines = withLedger({ maxEntries: NaN }, (ledger, dir) => fill(ledger, dir, 1100))
  assert.ok(lines <= 1000, `实际 ${lines} 条`)
})

test('P1-22①：maxEntries 为非数字对象同样必须归一', () => {
  const lines = withLedger({ maxEntries: {} }, (ledger, dir) => fill(ledger, dir, 1100))
  assert.ok(lines <= 1000, `实际 ${lines} 条`)
})

// ─────────────────── ② 无界值不得关闭 prune（Infinity / 极大值） ───────────────────

test('P1-22②：maxEntries=Infinity 必须有界，不得永不 prune', () => {
  const lines = withLedger({ maxEntries: Infinity }, (ledger, dir) => fill(ledger, dir, 1100))
  assert.ok(lines <= 1000, `Infinity 会让判据恒真 → 永不重写 → 无界增长，实际 ${lines} 条`)
})

test('P1-22②：maxEntries=-Infinity 必须归一到下界而非破坏判据', () => {
  const lines = withLedger({ maxEntries: -Infinity }, (ledger, dir) => fill(ledger, dir, 1100))
  assert.ok(lines <= 1000, `实际 ${lines} 条`)
})

// ─────────────────── 合法值行为必须完全不变（回归红线） ───────────────────

test('保持：maxEntries=50 的触发线与保留条数与既有测试一致（镜像 ledger.test.mjs:88）', () => {
  const lines = withLedger({ maxEntries: 50 }, (ledger, dir) => fill(ledger, dir, 120))
  assert.ok(lines < 120, `确实发生了重写（实际 ${lines} 条）`)
  assert.ok(lines <= 100, `不超过下一触发线 2×maxEntries（实际 ${lines} 条）`)
})

test('保持：maxEntries=0 / 负数 归一到 50 下界（合法区的下界不变）', () => {
  for (const raw of [0, -1, -100]) {
    const lines = withLedger({ maxEntries: raw }, (ledger, dir) => fill(ledger, dir, 200))
    assert.ok(lines <= 100, `maxEntries=${raw} 应归一到 50（触发线 100），实际 ${lines} 条`)
  }
})

test('保持：maxEntries 为数字字符串时沿用既有数值语义（不误判为非法）', () => {
  const lines = withLedger({ maxEntries: '50' }, (ledger, dir) => fill(ledger, dir, 120))
  assert.ok(lines <= 100, `数字字符串沿用旧语义，实际 ${lines} 条`)
})

test('保持：合法的大 maxEntries 不被粗暴钳到很小（1e9 仍允许后续增长）', () => {
  const lines = withLedger({ maxEntries: 1e9 }, (ledger, dir) => fill(ledger, dir, 200))
  assert.equal(lines, 200, '合法大值不应在 200 条时就被 prune（否则是把用户配置当非法处理）')
})

// ─────────────────── 归一后其余 API 必须仍然可用 ───────────────────

test('P1-22：归一生效时 append/read/recent 仍正常工作', () => {
  withLedger({ maxEntries: 'abc' }, (ledger, dir) => {
    for (let index = 0; index < 1100; index += 1) ledger.append(record(index))

    const from = Date.parse('2026-08-14T00:00:00Z')
    const to = Date.parse('2026-08-15T00:00:00Z')
    const rows = ledger.read(from, to)
    assert.ok(rows.length > 0, '读时间窗必须仍可用')
    assert.ok(rows.length <= 1000, `读到的条数必须有界（实际 ${rows.length}）`)

    // 注意：recent 的签名是 recent(limit: number)，不是 recent({ limit })
    const recent = ledger.recent(5)
    assert.equal(recent.length, 5, 'recent 必须仍可用')
    assert.ok(recent[4].at >= recent[0].at, 'recent 仍返回正序（旧→新）')
  })
})

test('P1-22：非法 maxEntries 下 append 仍绝不抛错（容错优先不变）', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir: join(dir, 'not-writable-as-dir', 'x'), maxEntries: 'abc' })
    assert.doesNotThrow(() => {
      for (let index = 0; index < 20; index += 1) ledger.append(record(index))
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.13 A09：重启后已有 ledger 行参与 prune 计数', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'ledger.jsonl')
    writeFileSync(file, `${Array.from({ length: 101 }, (_, index) => `${JSON.stringify({ at: new Date(Date.parse('2026-08-14T00:00:00Z') + index * 1000).toISOString(), kind: 'completed' })}\n`).join('')}`)
    const ledger = createLedger({ dir, maxEntries: 50 })
    ledger.append(record(102))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
