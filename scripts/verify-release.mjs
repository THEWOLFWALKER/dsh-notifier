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

// R2（Stage 1 review）：测试计数门禁不得自证。package.json 与文档里的数字只是**待核对的主张**，
// 唯一真相是 runner 实际发现的测试数——直接跑 `run-tests.mjs --count`（TAP 汇总）取回。
// 这样手工改一个常量不可能让门禁变绿：数字必须与真实执行的测试集一致。
function discoveredTestCount() {
  try {
    const raw = execFileSync(process.execPath, ['scripts/run-tests.mjs', '--count'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
    })
    const value = Number(String(raw).trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}
const actualTestCount = discoveredTestCount()
check(actualTestCount !== null, 'release guard could not derive the real test count from the runner')
if (actualTestCount !== null) {
  check(qualityCount === actualTestCount, `package.json dshQuality.testCount is ${qualityCount}, but the runner discovered ${actualTestCount} tests`)
}

// Commit14 宿主兼容门：peer range / DSH host matrix / dshWorkshop.dshVersions 三处必须互相一致
// （`scripts/verify-host-compat.mjs` 单一真相，避免任一清单先行漂移）。
for (const failure of hostCompatFailures(root)) failures.push(failure)

const changelog = read('CHANGELOG.md')
const readme = read('README.md')
const readmeZh = read('README.zh-CN.md')
const handoff = read('docs/developer/HANDOFF.md')

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
  one(handoff, /\|\s*测试\s*\|[^\n]*`npm test`[^\n]*\*\*(\d+) tests?/, 'HANDOFF test row'),
]
const expectedCount = String(actualTestCount ?? qualityCount)
for (const [index, count] of documentedCounts.entries()) {
  check(count === expectedCount, `documented test count #${index + 1} is ${count}, expected ${expectedCount}`)
}

// 首页元数据行版本门（2026-09-05 review 复查发现：README:28 曾停在 0.9.3/1478 漏网）：
// 首页元数据版本必须与 package.json 一致，缺一即失败。
const documentedVersions = [
  one(readme, /dsh-notifier@(\d+\.\d+\.\d+)`/, 'README.md metadata version'),
  one(readmeZh, /dsh-notifier@(\d+\.\d+\.\d+)`/, 'README.zh-CN.md metadata version'),
]
for (const [index, v] of documentedVersions.entries()) {
  check(v === version, `README metadata version #${index + 1} is ${v}, expected ${version}`)
}

const requiredPackageFiles = [
  'src', 'types', 'cordis.patch.yml', 'CHANGELOG.md', 'README.md', 'README.zh-CN.md',
  'docs/developer/PLUGINS.md', 'docs/developer/PLUGINS.en.md', 'THIRD_PARTY_NOTICES.md',
  'docs/user/AI_INSTALL.md', 'docs/user/AI_INSTALL.en.md', 'docs/developer/DIAGNOSTICS.md', 'docs/developer/DIAGNOSTICS.en.md',
  'docs/developer/OPERATIONS.md', 'docs/user/SUPPORT.md', 'docs/user/SUPPORT.en.md',
  'docs/user/TROUBLESHOOTING.md', 'docs/user/TROUBLESHOOTING.en.md', 'docs/developer/architecture.md',
  'docs/user/guide.md', 'docs/user/guide.en.md', 'docs/developer/compatibility-matrix.md',
  'docs/user/upgrade-guide.md', 'docs/user/upgrade-guide.en.md',
  'docs/assets/readme-hero.png', 'docs/assets/qq-group.png',
'docs/screenshots/native-v2-desktop.png', 'docs/screenshots/native-v2-mobile.png', 'docs/screenshots/native-v2-channel.png', 'docs/screenshots/native-v2-private.png',
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
for (const file of requiredPackageFiles.filter((entry) => !['src', 'types'].includes(entry) && !entry.endsWith('/'))) {
  check(existsSync(resolve(root, file)), `release documentation is missing from the tree: ${file}`)
}

// Gate 3（T-03）：真实 tar 检查。只读 package.json 抓不到「files 实际组装出什么」——
// 例如 `test/dom/node_modules` 被目录通配吞进包，或某个必需文件其实没被打进去。
// `npm pack --dry-run --json` 按 files 清单真实组装归档，是对发布内容的唯一真相。
const tarballPaths = () => {
  let raw
  try {
    raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 npm 是 .cmd 批处理，execFileSync 既不会按 PATHEXT 解析也不允许
      // 直接 spawn .cmd（CVE-2024-27980），必须显式命名并走 shell。
      shell: process.platform === 'win32',
    })
  } catch (error) {
    failures.push(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    const files = Array.isArray(entry?.files) ? entry.files : []
    return files.map((file) => String(file?.path ?? '')).filter((path) => path !== '')
  } catch {
    failures.push('npm pack --dry-run did not return parseable JSON')
    return null
  }
}
const packedPaths = tarballPaths()
if (packedPaths !== null) {
  const forbidden = packedPaths.filter((path) => (
    /(?:^|\/)node_modules\//.test(path)
    || path.startsWith('test/')
    || path.startsWith('.agents/')
    || path === 'AGENTS.md'
    || path === 'docs/developer/HANDOFF.md'
    || path.startsWith('docs/developer/memory/')
    || path.startsWith('docs/developer/v0.15-execution/')
    || /^docs\/developer\/v015-(?:deletion-ledger|fault-capacity|final-acceptance)\.md$/.test(path)
    || path === 'docs/developer/control-plane-cloud-storage.md'
    || /(?:admin-gate|fresh-wizard|configured-channels)-(?:desktop|mobile)\.png$/.test(path)
    || /(?:^|\/)\.env(?:\.|$)/.test(path)
    || /(?:^|\/)\.wrangler\//.test(path)
    || /(?:^|\/)(?:\.cache|coverage|\.DS_Store)(?:\/|$)/.test(path)
  ))
  check(forbidden.length === 0, `tarball contains forbidden paths: ${forbidden.slice(0, 5).join(', ')}${forbidden.length > 5 ? ` (+${forbidden.length - 5} more)` : ''}`)
  for (const required of ['src/index.mjs', 'src/plugin-entry.mjs', 'client.js', 'types/index.d.ts', 'cordis.patch.yml', 'extensions/cloudflare-tunnel']) {
    const present = packedPaths.some((path) => path === required || path.startsWith(`${required}/`))
    check(present, `tarball is missing required release artifact: ${required}`)
  }
}

// Commit15/16 公共子路径门：exports 子路径必须指向真实存在的目标文件，且该文件被 files 覆盖
// （间接覆盖也算，如 files 含 "src"/"types" 目录）——否则消费方 import 子路径会 404/不进包。
// `./types` 是 type-only 子路径，exports 用 `{ types, default }` 对象形态；两种形态都按同一契约校验。
const publicSubpaths = [
  ['./testing', 'src/testing.mjs'],
  ['./types', 'types/index.d.ts'],
]
for (const [subpath, target] of publicSubpaths) {
  const entry = packageJson.exports?.[subpath]
  const typesTarget = typeof entry === 'string' ? entry : entry?.types
  const runtimeTarget = typeof entry === 'string' ? entry : entry?.default
  check(typesTarget === `./${target}`, `package.json exports["${subpath}"].types must be ./${target}`)
  check(runtimeTarget === `./${target}`, `package.json exports["${subpath}"].default must be ./${target}`)
  check(existsSync(resolve(root, target)), `exports["${subpath}"] target is missing from the tree: ${target}`)
  const covered = packageFiles.some((entry2) => entry2 === target || target.startsWith(`${entry2.replace(/\/$/, '')}/`))
  check(covered, `exports["${subpath}"] target is not covered by package.json files: ${target}`)
}

// Commit17 发布边界：examples/ 是接入参考，**绝不**进 npm 包（消费者拿到的只是插件本体）。
const examplesCovered = packageFiles.some((entry) => {
  const dir = entry.replace(/\/$/, '')
  return dir === 'examples' || dir.startsWith('examples/') || 'examples'.startsWith(dir)
})
check(!examplesCovered, 'package.json files must not cover examples/ (consumer demo stays out of the npm archive)')

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
