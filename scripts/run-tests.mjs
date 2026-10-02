import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const fullPath = (...parts) => resolve(...parts)

/** 测试发现：与运行路径共用同一份 walk，避免「门禁读到的文件集」和「真正跑的文件集」漂移。 */
export function discoverTests(rootDir = root) {
  const tests = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory() && fullPath(full) === fullPath(rootDir, 'test/dom')) continue
      if (entry.isDirectory()) walk(full)
      else if (/\.(?:test|spec)\.mjs$/.test(entry.name)) tests.push(relative(rootDir, full).split('\\').join('/'))
    }
  }
  walk(join(rootDir, 'test'))
  tests.sort()
  return tests
}

const tests = discoverTests()
if (tests.length === 0) throw new Error('no tests discovered')

// R2（Stage 1 review）：release guard 必须能读到 runner 的**真实**测试发现数，而不是一个
// 可被手工改绿的字面常量。`--count` 用极简 reporter 跑一遍、只把计数打到 stdout——个别用例
// 失败不影响计数（reporter 照常累计），因此这个数字与 flaky 无关，只反映「runner 实际发现并
// 执行了多少个测试点」。
//
// 注意：`--test-reporter` 必须排在位置参数（测试文件）**之前**——放到文件列表之后会被 Node
// 当作位置参数忽略，静默退回默认 TAP reporter，计数标记就不会出现。
if (process.argv.includes('--count')) {
  const countArgs = ['--import', './test/_hermetic-network-guard.mjs', '--test', '--test-reporter=./scripts/test-count-reporter.mjs', ...tests]
  const result = spawnSync(process.execPath, countArgs, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 4 * 1024 * 1024,
  })
  const match = /DSH_TEST_COUNT (\d+)/.exec(String(result.stdout ?? ''))
  if (match === null) {
    console.error('test count unavailable: reporter produced no count')
    process.exit(1)
  }
  process.stdout.write(`${match[1]}\n`)
  process.exit(0)
}

const args = ['--import', './test/_hermetic-network-guard.mjs', '--test', ...tests]

const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)