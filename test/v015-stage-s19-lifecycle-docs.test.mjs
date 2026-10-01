// User instructions stay separate from executable developer maintenance commands.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const user = join(root, 'docs/user')
const documents = readdirSync(user).filter(name => name.endsWith('.md')).map(name => ({ name, text: readFileSync(join(user, name), 'utf8') }))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const operations = readFileSync(join(root, 'docs/developer/OPERATIONS.md'), 'utf8')
test('L01: referenced maintenance scripts exist and parse', () => {
  for (const [, rel] of operations.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
    assert.ok(existsSync(join(root, rel)), rel)
    execFileSync(process.execPath, ['--check', join(root, rel)], { stdio: 'pipe' })
  }
})
test('L01: documented npm commands exist', () => {
  for (const { text } of [...documents, { text: operations }]) for (const [, name] of text.matchAll(/npm run ([\w:]+)/g)) assert.equal(typeof pkg.scripts?.[name], 'string', name)
})
test('L01: every user guide local link resolves from its own directory', () => {
  for (const { name, text } of documents) for (const [, rel] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) assert.ok(existsSync(resolve(user, rel.split('#')[0])), `${name}: ${rel}`)
})
test('L01: installation, use, troubleshooting, upgrade and removal have separate reachable instructions', () => {
  for (const name of ['guide.md', 'guide.en.md', 'cloudflare.md', 'TROUBLESHOOTING.md', 'upgrade-guide.md', 'user-lifecycle.md']) assert.ok(existsSync(join(user, name)), name)
  assert.match(readFileSync(join(user, 'user-lifecycle.md'), 'utf8'), /机器人凭证不会写入|不包含密码/)
})
test('L01: developer implementation vocabulary stays out of the user instructions', () => {
  for (const { name, text } of documents) {
    assert.doesNotMatch(text, /canonical|epoch|durable|Hot Apply|single-flight|fitnes[s]|^>\s*(目标|读者|受众|Audience):/m, name)
  }
})
