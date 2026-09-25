// v0.12.1 Phase A：state 文件「形状异常」不得再被静默当空态（P2-06 / P2-07）。
//
// 背景（三分法，改动前）：
//   空字符串              → 静默当空态，不取证不告警   【保持】
//   读失败（EISDIR/权限） → 静默 fail-open，不取证     【保持】
//   解析失败（`{oops`）   → 取证 + 告警 + 自愈重建     【保持】
//   形状异常（`[]`/`null`/`"x"`/`1`/`true`）
//                        → 静默当空态，不取证不告警，且 save 时被覆写  【本项要修的】
//
// 为什么形状异常比解析失败更可疑：`[]` 是**合法 JSON**。
// 「半截写入恰好落在合法 JSON 边界」和「外部工具/旧版本写了错形状」都完全可能。
// 现在它连一条日志都不产生，且下一次 save 就用 `{} + dirty` 把它覆盖掉 —— 现场被销毁。
// 对比之下 `{oops` 反而有完整取证。取证保护等级反了。
//
// ⚠️ 本文件在修复前【必须失败】。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'

const tempStorePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0121-shape-'))
  return { dir, path: join(dir, 'state.json') }
}

const backupsOf = (dir) => readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt.'))

/**
 * 捕获本模块的 console.error 告警。
 * 注意：store 在启动时还会做权限自检（mode 过宽 → warn + chmod 收紧），
 * 那条告警与「损坏/形状异常」无关，必须过滤掉，否则断言会被无关噪音干扰。
 * 因此下面统一用 corruptionWarnings() 只看取证相关告警。
 */
function captureWarnings(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => {
    if (String(args[0]).includes('dsh-notifier/store')) lines.push(args.join(' '))
  }
  try {
    fn()
  } finally {
    console.error = original
  }
  return lines
}

/** 只看与「损坏 / 形状异常」有关的告警（排除权限自检等无关噪音）。 */
const corruptionWarnings = (lines) => lines.filter((line) => /损坏|形状异常/.test(line))

/** 写 state 文件时显式 0600，避免触发权限自检告警（与本次断言无关的噪音）。 */
const writeState = (path, raw) => writeFileSync(path, raw, { mode: 0o600 })

// ─────────────────────── 形状异常：必须取证 + 告警（P2-06） ───────────────────────

const SHAPE_ANOMALIES = [
  { label: '空数组', raw: '[]' },
  { label: 'null', raw: 'null' },
  { label: '字符串', raw: '"just-a-string"' },
  { label: '数字', raw: '42' },
  { label: '布尔', raw: 'true' },
  { label: '数组含元素', raw: '[{"k":1}]' },
]

for (const { label, raw } of SHAPE_ANOMALIES) {
  test(`P2-06：形状异常（${label}）启动必须取证 + 告警，不得静默当空态`, () => {
    const { dir, path } = tempStorePath()
    writeState(path, raw)

    let store = null
    const warnings = captureWarnings(() => { store = createStore(path) })

    assert.equal(store.size(), 0, 'fail-open 语义不变：仍以空态起步')
    const backups = backupsOf(dir)
    assert.equal(backups.length, 1, `形状异常必须留一份取证副本（实际 ${backups.length} 份）`)
    assert.equal(
      readFileSync(join(dir, backups[0]), 'utf8'),
      raw,
      '取证副本内容必须等于原现场（证据不得被加工）',
    )
    assert.equal(
      corruptionWarnings(warnings).length >= 1,
      true,
      `形状异常必须出声（实际取证相关告警：${corruptionWarnings(warnings).join(' | ') || '（无）'}）`,
    )
  })
}

test('P2-06：形状异常文件在后续 save 时现场仍被保留（不得被覆写销毁）', () => {
  const { dir, path } = tempStorePath()
  writeState(path, '[]')

  const warnings = captureWarnings(() => {
    const store = createStore(path)
    store.set('k', 'v') // 修复前：直接以 {} + dirty 覆写，[] 的现场从此消失
  })

  const backups = backupsOf(dir)
  assert.ok(backups.length >= 1, `save 后必须仍有取证副本（实际 ${backups.length} 份）`)
  assert.ok(
    backups.some((name) => readFileSync(join(dir, name), 'utf8') === '[]'),
    '必须能找回原始 `[]` 现场',
  )
  assert.equal(readFileSync(path, 'utf8'), '{"k":"v"}', '自愈重建语义与「解析失败」路径一致')
  assert.equal(corruptionWarnings(warnings).length >= 1, true, '整个过程必须出声')
})

// ─────────────────── 既有行为必须保持（防止修 P2-06 时改坏它们） ───────────────────

test('保持：空文件仍是静默空态，不取证不告警（无记忆可丢失）', () => {
  const { dir, path } = tempStorePath()
  writeState(path, '')

  let store = null
  const warnings = captureWarnings(() => { store = createStore(path) })

  assert.equal(store.size(), 0)
  assert.equal(backupsOf(dir).length, 0, '空文件无取证价值，不得因本次改动开始取证')
  assert.equal(corruptionWarnings(warnings).length, 0, '空文件不得产生取证相关告警（避免噪音）')
})

test('保持：解析失败仍取证 + 告警 + save 自愈重建', () => {
  const { dir, path } = tempStorePath()
  writeState(path, '{oops not json')

  let store = null
  const warnings = captureWarnings(() => { store = createStore(path) })
  assert.equal(store.size(), 0)
  assert.equal(backupsOf(dir).length, 1)
  assert.equal(corruptionWarnings(warnings).length >= 1, true)

  captureWarnings(() => store.set('k', 'v'))
  assert.equal(readFileSync(path, 'utf8'), '{"k":"v"}')
  assert.ok(backupsOf(dir).length >= 2, 'boot 取证 + save 自愈转存')
})

test('保持：读失败（非损坏）仍静默 fail-open，不产生取证副本', () => {
  const { dir, path } = tempStorePath()
  mkdirSync(path, { recursive: true }) // 同名目录：readFileSync 抛 EISDIR

  let store = null
  captureWarnings(() => { store = createStore(path) })

  assert.equal(store.size(), 0)
  assert.equal(backupsOf(dir).length, 0, '读失败取不到现场，取证只会制造噪音')
})

test('保持：正常 state 文件读取不受影响，且不误判为形状异常', () => {
  const { dir, path } = tempStorePath()
  writeState(path, JSON.stringify({ 'ap:1': { status: 'pending' } }))

  let store = null
  const warnings = captureWarnings(() => { store = createStore(path) })

  assert.deepEqual(store.get('ap:1'), { status: 'pending' })
  assert.equal(backupsOf(dir).length, 0, '正常文件绝不能触发取证')
  assert.equal(corruptionWarnings(warnings).length, 0, '正常文件不得产生取证相关告警')
})

// ──────────────────── P2-07：读失败与真空白应可区分 ────────────────────

test('P2-07：store 必须能报告「启动读取失败」，与「文件不存在/为空」区分', () => {
  const { path } = tempStorePath()

  // 场景 1：文件不存在（真空白）
  const absent = createStore(path)
  assert.ok(typeof absent.bootStatus === 'function', '需要可查询的启动状态（A8-c）')
  assert.equal(absent.bootStatus().readFailed, false)

  // 场景 2：读失败（同名目录）
  const { path: brokenPath } = tempStorePath()
  mkdirSync(brokenPath, { recursive: true })
  const broken = createStore(brokenPath)
  assert.equal(broken.bootStatus().readFailed, true, '读失败必须可被上层观测到')

  // 两者在 size()/get() 上完全同形 —— 所以必须有独立信号
  assert.equal(absent.size(), broken.size(), '前置：两者 size 相同（这正是不可区分的原因）')
})

test('P2-07：正常读取时 readFailed 恒为 false', () => {
  const { path } = tempStorePath()
  writeState(path, JSON.stringify({ k: 1 }))
  const store = createStore(path)
  assert.equal(store.bootStatus().readFailed, false)
  assert.equal(store.get('k'), 1)
  assert.equal(existsSync(path), true)
})