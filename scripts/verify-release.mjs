#!/usr/bin/env node
// Release guard: keep package version, user-facing version markers, test count,
// and npm documentation allowlist in one mechanically checked contract.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const one = (text, pattern, label) => {
  const match = pattern.exec(text)
  check(match !== null, `${label}: marker not found`)
  return match?.[1] ?? null
}

const packageJson = JSON.parse(read('package.json'))
const version = String(packageJson.version ?? '')
const qualityCount = Number(packageJson.dshQuality?.testCount)
check(/^\d+\.\d+\.\d+$/.test(version), `package.json version is invalid: ${version}`)
check(Number.isInteger(qualityCount) && qualityCount > 0, 'dshQuality.testCount must be a positive integer')

const changelog = read('CHANGELOG.md')
const ui = read('src/admin/ui.mjs')
const readme = read('README.md')
const readmeZh = read('README.zh-CN.md')
const handoff = read('HANDOFF.md')

check(changelog.includes(`## [${version}]`), `CHANGELOG.md has no [${version}] heading`)
check(ui.includes(`v${version}`), `src/admin/ui.mjs does not contain v${version}`)

const documentedCounts = [
  one(readme, /tests-(\d+)-brightgreen/, 'README.md badge'),
  one(readmeZh, /tests-(\d+)-brightgreen/, 'README.zh-CN.md badge'),
  one(readme, /test\/\s+(\d+) tests/, 'README.md test text'),
  one(readmeZh, /test\/\s+(\d+) 个测试/, 'README.zh-CN.md test text'),
  one(handoff, /\|\s*测试\s*\|[^\n]*`npm test`[^\n]*\*\*(\d+) tests?/, 'HANDOFF test row'),
]
for (const [index, count] of documentedCounts.entries()) {
  check(count === String(qualityCount), `documented test count #${index + 1} is ${count}, expected ${qualityCount}`)
}

const requiredPackageFiles = [
  'src', 'test', 'scripts', 'cordis.patch.yml', 'CHANGELOG.md', 'PLUGINS.md',
  'THIRD_PARTY_NOTICES.md', 'docs/guide.md', 'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md',
]
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
for (const file of requiredPackageFiles) check(packageFiles.includes(file), `package.json files is missing ${file}`)
for (const file of ['PLUGINS.md', 'THIRD_PARTY_NOTICES.md', 'docs/guide.md', 'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md']) {
  check(existsSync(resolve(root, file)), `release documentation is missing from the tree: ${file}`)
}

if (existsSync(resolve(root, '.git'))) {
  try {
    const trackedForbidden = execFileSync('git', ['ls-files', 'node_modules', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim()
    check(trackedForbidden === '', `forbidden tracked release files: ${trackedForbidden}`)
  } catch (error) {
    check(false, `git ls-files check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('release guard failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`release guard ok: dsh-notifier v${version}, documented tests=${qualityCount}`)
}
