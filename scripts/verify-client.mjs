#!/usr/bin/env node
// Browser-artifact guard for the v0.12 Native Client module.
//
// 契约来源：v0.12 任务书 Commit 1 的 10 条断言。这个脚本只读已提交的 `lib/client.js`
// 与 `package.json`，**不需要 esbuild**，因此可以在零安装的 CI 上运行；
// 重新构建并逐字节比对是 CI 的另一个独立步骤（防止产物与源码漂移）。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const ARTIFACT = 'lib/client.js'
const artifactPath = resolve(root, ARTIFACT)
const packageJson = JSON.parse(read('package.json'))

// 1. 产物必须存在（generated + committed；消费方不构建已发布包）
check(existsSync(artifactPath), `${ARTIFACT} does not exist; run \`npm run build:client\``)
const artifact = existsSync(artifactPath) ? read(ARTIFACT) : ''

// 2. 只允许一次模块注册（重复注册会在 Host 里产生第二个模块实例）
const registrations = artifact.match(/window\.__ModuleLoader__\.load\(/g) ?? []
check(registrations.length === 1, `${ARTIFACT} must contain exactly one window.__ModuleLoader__.load registration, found ${registrations.length}`)

// 3. 注册 id 必须与 dsh.client 的插件名一致
check(/\bid:\s*'dsh-notifier'/.test(artifact), `${ARTIFACT} loader id must be exactly 'dsh-notifier'`)
check(!/\bid:\s*'[^']*'/.test(artifact.replace(/id:\s*'dsh-notifier'/, '')), `${ARTIFACT} declares an unexpected second loader id`)

// 4. React 必须是宿主外部模块，不能把第二份 React 打进产物
check(/require\(\s*["']react["']\s*\)/.test(artifact), `${ARTIFACT} must require the host-provided "react" external`)
const bundledReactMarkers = [
  'ReactCurrentOwner',
  'ReactCurrentDispatcher',
  'react.development.js',
  'react.production.min.js',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
]
for (const marker of bundledReactMarkers) {
  check(!artifact.includes(marker), `${ARTIFACT} contains bundled React implementation marker: ${marker}`)
}
// 构建侧的外部化清单同样冻结（源码被改动也要拦住）
const buildScript = read('plugin-src/client/build.mjs')
check(/external:\s*\[\s*'react'\s*,\s*'react-dom'\s*\]/.test(buildScript), 'plugin-src/client/build.mjs must freeze external: [\'react\', \'react-dom\']')

// 5. 浏览器产物不得依赖 Node 内置模块
check(!/require\(\s*["']node:/.test(artifact) && !/["']node:[a-z/]+["']/.test(artifact), `${ARTIFACT} must not reference node: builtins`)

// 6. 产物里不得出现我们源码引入的 eval / new Function
check(!/\beval\(/.test(artifact), `${ARTIFACT} must not contain eval(`)
check(!/new\s+Function\(/.test(artifact), `${ARTIFACT} must not contain new Function(`)

// 7. 不得泄漏构建机的绝对路径
const absolutePathMarkers = [root, '/workspace/', '/Users/', '/home/', '/root/', 'C:\\\\']
for (const marker of absolutePathMarkers) {
  check(!artifact.includes(marker), `${ARTIFACT} leaks an absolute build path: ${marker}`)
}

// 8. 公共子路径必须指向产物
check(packageJson.exports?.['./client'] === `./${ARTIFACT}`, `package.json exports["./client"] must be ./${ARTIFACT}`)

// 9. 产物必须进 npm 载荷
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
check(packageFiles.includes(ARTIFACT), `package.json files is missing ${ARTIFACT}`)

// 10. 零运行时依赖不变
const productionDependencies = Object.keys(packageJson.dependencies ?? {})
check(productionDependencies.length === 0, `package.json must keep zero production dependencies, found: ${productionDependencies.join(', ')}`)

// 附加：客户端构建脚本与 dsh.client 声明必须一起存在，避免只加脚本不加清单
check(typeof packageJson.scripts?.['build:client'] === 'string', 'package.json scripts["build:client"] is missing')
check(typeof packageJson.scripts?.['verify:client'] === 'string', 'package.json scripts["verify:client"] is missing')
check(packageJson.dsh?.client?.platform === 'web', 'package.json dsh.client.platform must be "web"')
const clientInject = packageJson.dsh?.client?.inject ?? []
check(Array.isArray(clientInject) && clientInject.length > 0, 'package.json dsh.client.inject must list package names')
check(clientInject.every((entry) => String(entry).startsWith('@deepseek-ai/')), 'package.json dsh.client.inject must contain package names, not service names')

if (failures.length > 0) {
  console.error('client guard failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`client guard ok: ${ARTIFACT} (${artifact.length} bytes, loader id dsh-notifier)`)
}