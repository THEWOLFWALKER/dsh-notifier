#!/usr/bin/env node
// dsh-notifier v0.15（T29）— 性能 / 写放大演练 runner（独立可跑，不属于 `npm test`）。
//
// 用途：把「一个用户动作 → 一次 durable 事务」的写放大不变量，以及 1 / 10 / 100 阶梯下的
// 吞吐，放到**真实 store（临时文件）**上测一遍，输出可复核的数字。
//
// 命令：
//   node scripts/perf-drill.mjs            # 文本报告（默认）
//   node scripts/perf-drill.mjs --json     # 机器可读
//   node scripts/perf-drill.mjs --ladder 1,10,100,500
//
// 退出码：0 = 所有阈值通过；1 = 出现写放大（一次 save 产生 >1 次事务）或悬挂。
// 说明：本 runner 只做本地 CPU/磁盘测量，**零网络**；数字绝对值依赖机器，只用于趋势与回归对比。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createStore } from '../src/inbound/store.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const ladderArg = argv.find((arg) => arg.startsWith('--ladder=')) ?? (argv.includes('--ladder') ? argv[argv.indexOf('--ladder') + 1] : null)
const ladder = (ladderArg ? String(ladderArg).split(',') : ['1', '10', '100'])
  .map((value) => Math.max(1, Math.trunc(Number(value)) || 0))
  .filter((value) => value > 0)

/** 计数包装：只统计 transact 次数与成功落盘次数，其余全权委托真实 store。 */
function countingStore(real) {
  let transacts = 0
  let commits = 0
  return {
    get: (key, fallback) => real.get(key, fallback),
    keys: (prefix) => real.keys(prefix),
    bootStatus: () => (typeof real.bootStatus === 'function' ? real.bootStatus() : { readFailed: false }),
    transact(mutator) {
      transacts += 1
      const result = real.transact(mutator)
      if (result?.committed === true) commits += 1
      return result
    },
    counts: () => ({ transacts, commits }),
  }
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v015-perf-'))
  try {
    const store = countingStore(createStore(join(dir, 'state.json')))
    const outboundConfig = createOutboundConfigService({
      store,
      yamlRows: new Map(),
      source: createOutboundSource([]),
      allowLegacy: false,
    })

    const rows = []
    let amplified = 0
    for (const count of ladder) {
      const start = store.counts()
      const started = performance.now()
      for (let i = 0; i < count; i += 1) {
        outboundConfig.save('telegram', { botToken: 'p'.repeat(24), chatId: String(i) })
      }
      const elapsedMs = performance.now() - started
      const now = store.counts()
      const transacts = now.transacts - start.transacts
      const commits = now.commits - start.commits
      if (transacts !== count || commits !== count) amplified += 1
      rows.push({
        saves: count,
        transacts,
        commits,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        msPerSave: Number((elapsedMs / count).toFixed(3)),
        amplification: Number((transacts / count).toFixed(3)),
      })
    }
    return { ok: amplified === 0, ladder: rows, amplifiedBuckets: amplified }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
  }
}

const report = run()

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write('dsh-notifier perf drill — write amplification + bounded ladder\n')
  process.stdout.write('（真实 store（临时文件），零网络；绝对毫秒依赖机器，只看趋势与放大倍数）\n\n')
  process.stdout.write('  saves   transacts  commits  elapsed(ms)  ms/save  amplification\n')
  for (const row of report.ladder) {
    process.stdout.write(
      `  ${String(row.saves).padStart(5)}  ${String(row.transacts).padStart(9)}  ${String(row.commits).padStart(7)}  `
      + `${String(row.elapsedMs).padStart(11)}  ${String(row.msPerSave).padStart(7)}  ${String(row.amplification).padStart(13)}\n`,
    )
  }
  process.stdout.write(`\n判定：${report.ok ? '通过（每个 bucket 写放大 = 1）' : `失败（${report.amplifiedBuckets} 个 bucket 出现写放大）`}\n`)
}

process.exitCode = report.ok ? 0 : 1