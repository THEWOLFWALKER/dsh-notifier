// v0.11 Commit17 — 消费方最小示例 `examples/consumer-demo`（plan §8.10）。
// 这个示例是「生态接入的第一份可运行参考」：用真运行时形状（静态 inject / push / sent）
// 验证示例本身没有写错，并锁死「示例绝不进 npm 包」这条发布边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspacePackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const demoDir = resolve(root, 'examples/consumer-demo')
const demoPackage = JSON.parse(readFileSync(resolve(demoDir, 'package.json'), 'utf8'))
const source = readFileSync(resolve(demoDir, 'src/index.mjs'), 'utf8')
const demo = await import(pathToFileURL(resolve(demoDir, 'src/index.mjs')).href)

test('consumer demo: the example package is private, dependency-free and ESM', () => {
  assert.equal(demoPackage.private, true)
  assert.equal(demoPackage.type, 'module')
  assert.equal(demoPackage.dependencies, undefined, '示例不得引入任何依赖')
  assert.equal(demoPackage.publishConfig, undefined)
})

test('consumer demo: examples/ stays out of the npm archive', () => {
  const files = Array.isArray(workspacePackage.files) ? workspacePackage.files : []
  const covered = files.some((entry) => {
    const dir = entry.replace(/\/$/, '')
    return dir === 'examples' || dir.startsWith('examples/') || 'examples'.startsWith(dir)
  })
  assert.equal(covered, false, 'package.json files 不得覆盖 examples/')
})

test('consumer demo: the plugin exports the DSH contract with a static inject', () => {
  assert.deepEqual(demo.inject, ['notifier'])
  assert.equal(typeof demo.apply, 'function')
})

test('consumer demo: apply pushes once with an explicit sourceName and wires dispose', async () => {
  const calls = []
  const events = []
  const ctx = {
    notifier: {
      version: '0.7',
      push: async (message, options) => {
        calls.push({ message, options })
        return { ok: true, delivered: ['fake'], skipped: [], failed: [] }
      },
      flush: async () => {},
    },
    on: (name, handler) => { events.push({ name, handler }) },
    logger: { warn() {}, debug() {} },
  }
  demo.apply(ctx)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].message.title, 'Consumer demo')
  assert.equal(calls[0].options.sourceName, 'consumer-demo')
  assert.equal(events.some((entry) => entry.name === 'dsh-notifier/sent'), true)
  assert.equal(events.some((entry) => entry.name === 'dispose'), true)
})

test('consumer demo: the sent listener never pushes back (no notification loop)', () => {
  const pushAt = source.indexOf('.push(')
  const sentAt = source.indexOf("'dsh-notifier/sent'")
  assert.notEqual(pushAt, -1, '示例必须展示一次 push')
  assert.notEqual(sentAt, -1, '示例必须订阅 sent')
  assert.equal(source.indexOf('.push(', pushAt + 1), -1, '示例只能有一处 push——sent handler 里禁止再 push')
  assert.ok(pushAt < sentAt, '唯一的 push 必须是出向调用，而不是 sent handler 内的回环')
})