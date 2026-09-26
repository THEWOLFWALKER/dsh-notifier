import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const pluginsZh = readFileSync(resolve(root, 'PLUGINS.md'), 'utf8')
const pluginsEn = readFileSync(resolve(root, 'PLUGINS.en.md'), 'utf8')

test('public capability wording is evidence-bound', () => {
  const expected = packageJson.dshWorkshop?.capability?.expected ?? ''
  assert.match(expected, /attempts delivery/)
  assert.match(expected, /provider-specific end-to-end receipt evidence/)
  assert.doesNotMatch(expected, /the message is delivered/)
})

test('plugin docs distinguish provider result from client confirmation', () => {
  assert.match(pluginsZh, /提供方结果.*终端已经展示消息/)
  assert.match(pluginsZh, /端到端回执/)
  assert.match(pluginsEn, /provider-level result.*client displayed the message/)
  assert.match(pluginsEn, /end-to-end receipt evidence/)
})
