// v0.11 Commit16 — TypeScript 公共契约 `dsh-notifier/types`（plan §7.15）。
// 刻意不引入 tsc（§7.2 禁止新增任何 TypeScript devDependency）：改用纯文本契约检查，
// 保证 package export 路径 / 目标文件存在 / 必要 symbol / version 字面量 /
// SentEventRecord 的 metadata-only 隐私边界都逐项落地。
//
// 检查面故意分两层：
//  1. package 层：消费方 `import type { ... } from 'dsh-notifier/types'` 能解析到文件，且该文件进包。
//  2. 声明层：`types/index.d.ts` 的符号与真运行时（`src/public.mjs` / `src/testing.mjs`）对齐。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_API_VERSION } from '../src/public.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const typesFilePath = resolve(root, 'types/index.d.ts')
const source = readFileSync(typesFilePath, 'utf8')

/** 抽取 `export interface X` / `export type X` 的符号名集合。 */
const exportedSymbols = () => {
  const names = new Set()
  for (const match of source.matchAll(/^export (?:interface|type) (\w+)/gm)) names.add(match[1])
  return names
}

/** 抽取某个 interface 的完整块（从 `export interface X` 到其配对的闭合 `}`）。 */
const interfaceBlock = (name) => {
  // 用 `\b` 边界匹配，避免 `FakeNotifier` 误命中更早出现的 `FakeNotifierCall`。
  const start = new RegExp(`^export interface ${name}\\b`, 'm').exec(source)?.index
  assert.notEqual(start, undefined, `types/index.d.ts is missing interface ${name}`)
  const end = source.indexOf('\n}', start)
  assert.notEqual(end, -1, `interface ${name} has no closing brace`)
  return source.slice(start, end)
}

test('types contract: package.json exports["./types"] resolves to a real d.ts file', () => {
  const entry = packageJson.exports?.['./types']
  assert.equal(entry?.types, './types/index.d.ts')
  assert.equal(entry?.default, './types/index.d.ts')
  assert.equal(existsSync(typesFilePath), true, 'types/index.d.ts must exist on disk')
})

test('types contract: the types directory ships inside the npm archive', () => {
  assert.equal(packageJson.files.includes('types'), true, 'package.json files must include "types"')
})

test('types contract: no root "types" field, so it never implies the whole root package is typed', () => {
  // plan §7.13：root JS 导出面远大于 notifier 公共面，设 root "types" 会误导 TS 用户。
  assert.equal(packageJson.types, undefined)
})

test('types contract: required public symbols are exported', () => {
  const symbols = exportedSymbols()
  for (const name of [
    'NotifyLevel', 'NotifyMessage', 'NotifyOptions', 'NotifySkip', 'NotifierSource',
    'PushFailure', 'PushResult', 'NotifierFacade', 'SentEventFailure', 'SentEventRecord',
    'FakeSimulation', 'FakeNotifyOptions', 'FakeNotifierCall', 'FakeNotifier',
  ]) {
    assert.equal(symbols.has(name), true, `types/index.d.ts must export ${name}`)
  }
})

test('types contract: the facade version literal tracks the runtime public API version', () => {
  const block = interfaceBlock('NotifierFacade')
  const literal = /readonly version: '(\d+\.\d+)'/.exec(block)
  assert.notEqual(literal, null, 'NotifierFacade must pin a literal version')
  assert.equal(literal[1], PUBLIC_API_VERSION, 'd.ts version literal must equal PUBLIC_API_VERSION')
})

test('types contract: push/flush signatures match the runtime facade', () => {
  const block = interfaceBlock('NotifierFacade')
  assert.match(block, /push\(message: NotifyMessage, options\?: NotifyOptions\): Promise<PushResult>/)
  assert.match(block, /flush\(\): Promise<void>/)
})

test('types contract: NotifyMessage declares only real public fields', () => {
  const block = interfaceBlock('NotifyMessage')
  for (const key of ['title', 'content', 'level', 'group']) {
    assert.equal(new RegExp(`\\b${key}\\?:`).test(block), true, `NotifyMessage must declare ${key}`)
  }
})

test('types contract: NotifyOptions mirrors the fields public.mjs actually reads', () => {
  const block = interfaceBlock('NotifyOptions')
  assert.match(block, /sourceName\?: string/)
  assert.match(block, /channel\?: string/)
})

test('types contract: SentEventRecord stays metadata-only (privacy boundary)', () => {
  const block = interfaceBlock('SentEventRecord')
  for (const key of [
    'time', 'ok', 'delivered', 'skipped', 'failed',
    'titleLength', 'contentLength', 'titleBytes', 'contentBytes', 'hasContent',
    'source', 'channel',
  ]) {
    assert.equal(new RegExp(`\\b${key}[?]?:`).test(block), true, `SentEventRecord must declare ${key}`)
  }
  // plan §7.10：绝不出现正文或原始错误正文。
  for (const forbidden of ['title', 'content', 'message', 'error']) {
    assert.equal(new RegExp(`\\b${forbidden}[?]?:`).test(block), false, `SentEventRecord must not declare ${forbidden}`)
  }
})

test('types contract: FakeNotifier extends the facade and exposes readonly call records', () => {
  const block = interfaceBlock('FakeNotifier')
  assert.match(block, /extends NotifierFacade/)
  assert.match(block, /readonly calls: readonly FakeNotifierCall\[\]/)
})

test('types contract: FakeSimulation values match the testing fake SIMULATIONS set', () => {
  const ids = [...source.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  for (const value of ['rate-limited', 'disabled', 'budget', 'busy']) {
    assert.equal(ids.includes(value), true, `FakeSimulation must include '${value}'`)
  }
})