import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const tests = []
const fullPath = (...parts) => resolve(...parts)
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory() && fullPath(full) === fullPath(root, 'test/dom')) continue
    if (entry.isDirectory()) walk(full)
    else if (/\.(?:test|spec)\.mjs$/.test(entry.name)) tests.push(relative(root, full).split('\\').join('/'))
  }
}
walk(join(root, 'test'))
tests.sort()
if (tests.length === 0) throw new Error('no tests discovered')
const args = ['--import', './test/_hermetic-network-guard.mjs', '--test', ...tests]
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
