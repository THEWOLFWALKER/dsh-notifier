#!/usr/bin/env node
// Release guard: keep package version, user-facing version markers, test count,
// and npm documentation allowlist in one mechanically checked contract.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { hostCompatFailures } from './verify-host-compat.mjs'

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

// Commit14 宿主兼容门：peer range / DSH host matrix / dshWorkshop.dshVersions 三处必须互相一致
// （`scripts/verify-host-compat.mjs` 单一真相，避免任一清单先行漂移）。
for (const failure of hostCompatFailures(root)) failures.push(failure)

const changelog = read('CHANGELOG.md')
const readme = read('README.md')
const readmeZh = read('README.zh-CN.md')
const handoff = read('HANDOFF.md')

check(changelog.includes(`## [${version}]`), `CHANGELOG.md has no [${version}] heading`)
// 零配置首访起 ui.mjs 只做组合（theme/markup/client 三件套拆分）——版本角标检查
// 必须落在「实际 served 的组合 HTML」上，而不是某个具体源文件（再重构也不会漏检）。
let uiHtml = ''
try {
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(resolve(root, 'src/admin/ui.mjs')).href)
  uiHtml = String(mod.ADMIN_UI_HTML ?? '')
} catch (error) {
  check(false, `src/admin/ui.mjs import failed: ${error instanceof Error ? error.message : String(error)}`)
}
check(uiHtml.includes(`v${version}`), `admin UI composed HTML does not contain v${version}`)

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
  'THIRD_PARTY_NOTICES.md', 'docs/guide.md', 'docs/compatibility-matrix.md',
  'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md',
]
// S-11（W13）：files 从「含整个 scripts 目录」改为显式列举发布脚本（hook-server.mjs
// 开发用不随包分发）——校验每个发布脚本都在 files 清单里，缺一个即失败。
const requiredScripts = [
  'scripts/channel-login.mjs', 'scripts/channel-selfcheck.mjs', 'scripts/gen-channel-matrix.mjs',
  'scripts/route.mjs', 'scripts/verify-release.mjs', 'scripts/verify-host-compat.mjs',
  'scripts/wechat-login.mjs',
]
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
for (const file of requiredPackageFiles) check(packageFiles.includes(file), `package.json files is missing ${file}`)
for (const script of requiredScripts) check(packageFiles.includes(script), `package.json files is missing ${script} (S-11 发布脚本须显式列举)`)
for (const file of ['PLUGINS.md', 'THIRD_PARTY_NOTICES.md', 'docs/guide.md', 'docs/compatibility-matrix.md', 'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md']) {
  check(existsSync(resolve(root, file)), `release documentation is missing from the tree: ${file}`)
}

// Commit15/16 公共子路径门：exports 子路径必须指向真实存在的目标文件，且该文件被 files 覆盖
// （间接覆盖也算，如 files 含 "src"/"types" 目录）——否则消费方 import 子路径会 404/不进包。
const publicSubpaths = [
  ['./testing', 'src/testing.mjs'],
]
for (const [subpath, target] of publicSubpaths) {
  check(packageJson.exports?.[subpath] === `./${target}`, `package.json exports["${subpath}"] must be ./${target}`)
  check(existsSync(resolve(root, target)), `exports["${subpath}"] target is missing from the tree: ${target}`)
  const covered = packageFiles.some((entry) => entry === target || target.startsWith(`${entry.replace(/\/$/, '')}/`))
  check(covered, `exports["${subpath}"] target is not covered by package.json files: ${target}`)
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
