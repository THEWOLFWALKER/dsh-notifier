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
//
// v0.13（C11.5 / R3）修订：boot 时的「解析失败」与「形状异常」不再只是取证后自愈重建，
// 而是升级为一等状态 corrupt —— 读侧仍 fail-open 供诊断，写侧 fail-closed，绝不把不可信
// 旧 state 当空世界覆盖。仅当磁盘被修复成合法对象后写路径才恢复（见文件末 recovery 用例）。

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

test('R3：形状异常文件在后续 save 时 fail-closed——现场不被覆写，写被拒绝', () => {
  const { dir, path } = tempStorePath()
  writeState(path, '[]')

  let accepted = null
  const warnings = captureWarnings(() => {
    const store = createStore(path)
    accepted = store.set('k', 'v') // v0.13 R3：boot 损坏 → stateful mutation fail-closed
  })

  assert.equal(accepted, false, '不可信旧 state 下写必须被拒绝（旧行为：以 {} + dirty 覆写）')
  const backups = backupsOf(dir)
  assert.ok(backups.length >= 1, `boot 取证副本必须存在（实际 ${backups.length} 份）`)
  assert.ok(
    backups.some((name) => readFileSync(join(dir, name), 'utf8') === '[]'),
    '必须能找回原始 `[]` 现场',
  )
  assert.equal(readFileSync(path, 'utf8'), '[]', '原现场不得被覆写销毁')
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

test('R3：解析失败仍取证 + 告警，且写路径 fail-closed（不再自愈重建覆写现场）', () => {
  const { dir, path } = tempStorePath()
  writeState(path, '{oops not json')

  let store = null
  const warnings = captureWarnings(() => { store = createStore(path) })
  assert.equal(store.size(), 0)
  assert.equal(backupsOf(dir).length, 1)
  assert.equal(corruptionWarnings(warnings).length >= 1, true)
  assert.equal(store.bootStatus().status, 'corrupt', '损坏必须是一等状态')

  let accepted = null
  captureWarnings(() => { accepted = store.set('k', 'v') })
  assert.equal(accepted, false, '损坏状态下写必须 fail-closed')
  assert.equal(readFileSync(path, 'utf8'), '{oops not json', '原现场保留，不被覆写')
  assert.equal(backupsOf(dir).length, 1, '不再触发 save 自愈转存（boot 取证已保留现场）')
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

// ─────────────── R3（C11.5）：boot 不可信 → stateful mutation fail-closed + 修复后恢复 ───────────────

for (const { label, raw } of SHAPE_ANOMALIES) {
  test(`R3：形状异常（${label}）写路径 fail-closed，原现场不被覆写`, () => {
    const { path } = tempStorePath()
    writeState(path, raw)
    const store = createStore(path)

    assert.equal(store.bootStatus().status, 'corrupt', '损坏必须是一等状态')
    assert.equal(store.bootStatus().corrupt, true)
    assert.equal(store.set('k', 'v'), false, '损坏状态下写必须被拒绝')
    assert.equal(store.delete('k'), false, '删除也是 stateful mutation，同样 fail-closed')
    assert.equal(readFileSync(path, 'utf8'), raw, '原现场必须原样保留')
  })
}

test('R3：读失败（unavailable）写路径 fail-closed', () => {
  const { path } = tempStorePath()
  mkdirSync(path, { recursive: true }) // 同名目录：readFileSync 抛 EISDIR
  const store = createStore(path)

  assert.equal(store.bootStatus().status, 'unavailable')
  assert.equal(store.bootStatus().readFailed, true)
  assert.equal(store.set('k', 'v'), false, '读失败下写必须被拒绝')
})

test('R3：修复损坏文件后写路径恢复（recovery），并保留修复后的既有键', () => {
  const { path } = tempStorePath()
  writeState(path, '[]')
  const store = createStore(path)
  assert.equal(store.set('k', 'v'), false, '前置：损坏时写被拒')

  // operator 把损坏文件修复成合法对象（显式 recovery）
  writeState(path, JSON.stringify({ repaired: true }))
  const warnings = captureWarnings(() => { assert.equal(store.set('k', 'v'), true, '修复后写必须恢复') })

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { repaired: true, k: 'v' }, '基于修复后的合法 state 提交')
  assert.equal(store.bootStatus().status, 'ready', '恢复后状态回到 ready')
  assert.equal(corruptionWarnings(warnings).length, 0, '恢复路径不再产生损坏告警')
})

test('R3：bootStatus 三态可区分——ready / corrupt / unavailable', () => {
  const { path: absent } = tempStorePath()
  assert.equal(createStore(absent).bootStatus().status, 'ready', '文件不存在 = 首次安装 ready')

  const { path: corrupt } = tempStorePath()
  writeState(corrupt, '[]')
  assert.equal(createStore(corrupt).bootStatus().status, 'corrupt')

  const { path: unavailable } = tempStorePath()
  mkdirSync(unavailable, { recursive: true })
  assert.equal(createStore(unavailable).bootStatus().status, 'unavailable')
})