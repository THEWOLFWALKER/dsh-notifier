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
  one(readme, /· (\d+) automated contract tests/, 'README.md metadata tests'),
  one(readmeZh, /· (\d+) 个自动化契约测试/, 'README.zh-CN.md metadata tests'),
  one(handoff, /\|\s*测试\s*\|[^\n]*`npm test`[^\n]*\*\*(\d+) tests?/, 'HANDOFF test row'),
]
for (const [index, count] of documentedCounts.entries()) {
  check(count === String(qualityCount), `documented test count #${index + 1} is ${count}, expected ${qualityCount}`)
}

// 首页元数据行版本门（2026-09-05 review 复查发现：README:28 曾停在 0.9.3/1478 漏网）：
// 首页元数据版本必须与 package.json 一致，缺一即失败。
const documentedVersions = [
  one(readme, /dsh-notifier@(\d+\.\d+\.\d+)` ·/, 'README.md metadata version'),
  one(readmeZh, /dsh-notifier@(\d+\.\d+\.\d+)` ·/, 'README.zh-CN.md metadata version'),
]
for (const [index, v] of documentedVersions.entries()) {
  check(v === version, `README metadata version #${index + 1} is ${v}, expected ${version}`)
}

const requiredPackageFiles = [
  'src', 'test', 'cordis.patch.yml', 'CHANGELOG.md', 'PLUGINS.md',
  'THIRD_PARTY_NOTICES.md', 'docs/guide.md', 'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md',
]
// S-11（W13）：files 从「含整个 scripts 目录」改为显式列举发布脚本（hook-server.mjs
// 开发用不随包分发）——校验每个发布脚本都在 files 清单里，缺一个即失败。
const requiredScripts = [
  'scripts/channel-login.mjs', 'scripts/channel-selfcheck.mjs', 'scripts/gen-channel-matrix.mjs',
  'scripts/route.mjs', 'scripts/verify-release.mjs', 'scripts/wechat-login.mjs',
]
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
for (const file of requiredPackageFiles) check(packageFiles.includes(file), `package.json files is missing ${file}`)
for (const script of requiredScripts) check(packageFiles.includes(script), `package.json files is missing ${script} (S-11 发布脚本须显式列举)`)
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
