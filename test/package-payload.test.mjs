import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : []
const covered = (target) => packageFiles.some((entry) => {
  const normalized = entry.replace(/\/$/, '')
  return normalized === target || target.startsWith(`${normalized}/`)
})

const readmeLinks = (file) => {
  const text = readFileSync(resolve(root, file), 'utf8')
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#', 1)[0])
    .filter((target) => target && !/^(?:[a-z]+:|\/)/i.test(target))
}

test('npm allowlist covers public README documents and assets', () => {
  const required = [
    'README.md', 'README.zh-CN.md', 'AGENTS.md', 'PLUGINS.md', 'PLUGINS.en.md',
    'docs/guide.md', 'docs/guide.en.md', 'docs/AI_INSTALL.md', 'docs/AI_INSTALL.en.md',
    'docs/TROUBLESHOOTING.md', 'docs/TROUBLESHOOTING.en.md',
    'docs/DIAGNOSTICS.md', 'docs/DIAGNOSTICS.en.md', 'docs/SUPPORT.md', 'docs/SUPPORT.en.md',
    'docs/compatibility-matrix.md', 'docs/upgrade-guide.md', 'docs/upgrade-guide.en.md',
    'docs/architecture.md', 'docs/OPERATIONS.md', 'CHANGELOG.md',
    'docs/assets/readme-hero.png', 'docs/assets/qq-group.png',
    'docs/screenshots/fresh-wizard-desktop.png', 'docs/screenshots/configured-channels-desktop.png',
  ]
  for (const file of required) {
    assert.equal(existsSync(resolve(root, file)), true, `missing from tree: ${file}`)
    assert.equal(covered(file), true, `not covered by package.json files: ${file}`)
  }
})

test('relative README links resolve and are package-covered', () => {
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    for (const target of readmeLinks(readme)) {
      assert.equal(existsSync(resolve(root, target)), true, `${readme} points to missing ${target}`)
      assert.equal(covered(target), true, `${readme} points to unpackaged ${target}`)
    }
  }
})
