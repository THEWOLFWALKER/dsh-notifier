// v0.12 任务书 Commit 1 — 浏览器模块构建 / 校验链路的纯静态契约（plan §Commit 1）。
//
// 刻意不依赖 esbuild：CI 的 `test` job 是零安装直跑 `node --test`，若这里 import esbuild
// 就会把整条测试矩阵绑死在一次网络安装上。产物字节级重放比对由 CI 的 client 步骤负责
// （`npm run build:client` + `git diff --exit-code -- lib/client.js`）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const artifact = read('lib/client.js')
const buildScript = read('plugin-src/client/build.mjs')
const entry = read('plugin-src/client/index.js')

test('client build: package.json exports["./client"] resolves to the committed artifact', () => {
  assert.equal(packageJson.exports?.['./client'], './lib/client.js')
  assert.equal(existsSync(resolve(root, 'lib/client.js')), true, 'lib/client.js must be committed (consumers do not build published packages)')
})

test('client build: the artifact ships in the npm payload but its source does not', () => {
  assert.equal(packageJson.files.includes('lib/client.js'), true, 'package.json files must include lib/client.js')
  const coversSource = packageJson.files.some((hit) => {
    const dir = String(hit).replace(/\/$/, '')
    return dir === 'plugin-src' || dir.startsWith('plugin-src/')
  })
  assert.equal(coversSource, false, 'plugin-src/ must stay out of the npm payload')
})

test('client build: build/verify scripts exist and npm test does not rebuild the client', () => {
  assert.equal(packageJson.scripts['build:client'], 'node plugin-src/client/build.mjs')
  assert.equal(packageJson.scripts['verify:client'], 'node scripts/verify-client.mjs')
  assert.doesNotMatch(packageJson.scripts.test, /build:client|verify:client/, 'npm test must not implicitly rebuild the client')
})

test('client build: esbuild is the only devDependency and production dependencies stay empty', () => {
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}), ['esbuild'])
  assert.equal(packageJson.devDependencies.esbuild, '0.25.9', 'esbuild must stay pinned exactly')
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), [], 'zero runtime dependencies is a hard boundary')
  const esbuildInPayload = packageJson.files.some((hit) => String(hit).includes('esbuild'))
  assert.equal(esbuildInPayload, false)
})

test('client build: dsh.client declares package names, the browser module declares service names', () => {
  assert.equal(packageJson.dsh?.client?.platform, 'web')
  const inject = packageJson.dsh?.client?.inject ?? []
  assert.deepEqual(inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  // Trap A：清单里是包名，浏览器模块里是 Cordis 服务名，两者不可混淆。
  assert.match(entry, /export const inject = \['slots', 'connection', 'locale'\]/)
  assert.equal(inject.some((name) => name === 'slots'), false, 'dsh.client.inject must not contain service names')
})

test('client build: build.mjs freezes the browser target and the host externals', () => {
  assert.match(buildScript, /external:\s*\[\s*'react'\s*,\s*'react-dom'\s*\]/)
  assert.match(buildScript, /platform:\s*'browser'/)
  assert.match(buildScript, /format:\s*'cjs'/)
  assert.match(buildScript, /loader:\s*\{\s*'\.css':\s*'text'\s*\}/, 'styles.css is inlined as text, not emitted as a separate CSS file')
  assert.match(buildScript, /resolve\(packageRoot, 'lib\/client\.js'\)/)
  assert.match(buildScript, /id: 'dsh-notifier'/, 'the module registration id is part of the frozen wrapper')
})

test('client build: the artifact registers exactly one dsh-notifier module', () => {
  const registrations = artifact.match(/window\.__ModuleLoader__\.load\(/g) ?? []
  assert.equal(registrations.length, 1)
  assert.match(artifact, /^\s*(?:var [\w$]+ = )?window\.__ModuleLoader__\.load\(/)
  assert.match(artifact, /id: 'dsh-notifier'/)
  assert.match(artifact, /factory: \(require\) => \{/)
  assert.match(artifact, /return module\.exports;/)
})

test('client build: the artifact externalizes React and never bundles a second copy', () => {
  assert.match(artifact, /require\(\s*["']react["']\s*\)/)
  for (const marker of ['ReactCurrentOwner', 'ReactCurrentDispatcher', 'react.development.js', 'react.production.min.js']) {
    assert.equal(artifact.includes(marker), false, `bundled React implementation marker leaked: ${marker}`)
  }
  assert.equal(/react-dom/.test(artifact), false, 'react-dom must not be imported by the entry')
})

test('client build: the artifact stays browser-safe and path-clean', () => {
  assert.doesNotMatch(artifact, /require\(\s*["']node:/)
  assert.doesNotMatch(artifact, /["']node:(fs|path|url|crypto|http|https)["']/)
  assert.doesNotMatch(artifact, /\beval\(/)
  assert.doesNotMatch(artifact, /new\s+Function\(/)
  for (const marker of [root, '/workspace/', '/Users/', '/home/', '/root/']) {
    assert.equal(artifact.includes(marker), false, `artifact leaks an absolute build path: ${marker}`)
  }
})

test('client build: verify:client passes against the committed artifact', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['scripts/verify-client.mjs'], { cwd: root, encoding: 'utf8' })
  assert.match(output, /client guard ok: lib\/client\.js/)
})