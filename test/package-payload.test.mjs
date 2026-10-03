import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
const covered = (target) => packageFiles.some((entry) => {
  const normalized = entry.replace(/\/$/, '')
  return normalized === target || target.startsWith(`${normalized}/`)
})

const relativeLinks = (file) => {
  const source = resolve(root, file)
  const text = readFileSync(source, 'utf8')
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#', 1)[0])
    .filter((target) => target && !/^(?:[a-z]+:|\/)/i.test(target))
    .map((target) => relative(root, resolve(dirname(source), target)).split('\\').join('/'))
}

test('npm allowlist covers public entry documents and assets', () => {
  const required = [
    'README.md', 'README.zh-CN.md', 'docs/developer/PLUGINS.md', 'docs/developer/PLUGINS.en.md',
    'docs/user/guide.md', 'docs/user/guide.en.md', 'docs/user/AI_INSTALL.md', 'docs/user/AI_INSTALL.en.md',
    'docs/user/TROUBLESHOOTING.md', 'docs/user/TROUBLESHOOTING.en.md',
    'docs/developer/DIAGNOSTICS.md', 'docs/developer/DIAGNOSTICS.en.md', 'docs/user/SUPPORT.md', 'docs/user/SUPPORT.en.md',
    'docs/developer/compatibility-matrix.md', 'docs/user/upgrade-guide.md', 'docs/user/upgrade-guide.en.md',
    'docs/developer/architecture.md', 'docs/developer/OPERATIONS.md', 'CHANGELOG.md',
    'docs/assets/readme-hero.png', 'docs/assets/qq-group.png',
  'docs/screenshots/native-v2-desktop.png', 'docs/screenshots/native-v2-mobile.png', 'docs/screenshots/native-v2-channel.png',
  ]
  for (const file of required) {
    assert.equal(existsSync(resolve(root, file)), true, `missing from tree: ${file}`)
    assert.equal(covered(file), true, `not covered by package.json files: ${file}`)
  }
})

test('relative links in packaged entry documents resolve and are package-covered', () => {
  for (const document of ['README.md', 'README.zh-CN.md', 'docs/developer/README.md', 'docs/developer/OPERATIONS.md', 'docs/user/README.md']) {
    for (const target of relativeLinks(document)) {
      assert.equal(existsSync(resolve(root, target)), true, `${document} points to missing ${target}`)
      assert.equal(covered(target), true, `${document} points to unpackaged ${target}`)
    }
  }
})

test('npm package excludes internal execution notes and test guidance', () => {
  for (const file of [
    'AGENTS.md', 'docs/developer/HANDOFF.md', 'docs/developer/control-plane-cloud-storage.md',
    'docs/developer/v015-deletion-ledger.md', 'docs/developer/v015-fault-capacity.md',
    'docs/developer/v015-final-acceptance.md', 'docs/developer/v0.15-execution/ledger/audit-ledger.csv',
    'docs/developer/memory/index.md',
  ]) assert.equal(covered(file), false, `internal artifact is packaged: ${file}`)
})
