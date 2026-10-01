// v0.15 Stage S11 (T17) — legacy retirement + dependency/writer fitness guard.
//
// This suite turns the T07 writer inventory (`docs/state-writer-registry.md`) into a
// mechanically enforced contract. It is a *fitness function*, not a behaviour test:
// it fails when the code drifts away from the documented authority map, so a new
// store writer or a reversed dependency edge cannot land unnoticed.
//
//   1. the generic single-key mutation surface (`store.set` / `store.delete`) must stay
//      confined to the store primitive — everyone else goes through the durable helpers;
//   2. every module that touches the durable-store write surface must be registered in
//      the allowlist embedded in the registry doc (the doc *is* the allowlist);
//   3. that allowlist must have no stale entries (a registered module that no longer
//      writes is a dead shim and must be removed with it);
//   4. layer dependencies must point one way (adapters/control-plane/control-surface
//      never reach up into admin or across into each other);
//   5. `index.mjs` is reached only through the plugin entry.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const REGISTRY_DOC = fileURLToPath(new URL('../docs/state-writer-registry.md', import.meta.url))
const ALLOWLIST_OPEN = '<!-- writer-fitness:allowlist -->'
const ALLOWLIST_CLOSE = '<!-- /writer-fitness:allowlist -->'

/** Recursively collect every `.mjs` file under `dir`, as src-relative posix paths. */
function collectSources(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.mjs')) out.push(relative(SRC_DIR, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

// The durable-store write surface: either a store helper call or a direct method hit on
// the literal `store` object. A module that appears here owns a key and must be registered.
const WRITE_SURFACE = /(?:^|[^\w.$])(?:setDurable|mergeDurable|transactDurable|deleteDurable|transactOutcome)\s*\(|\bstore\.(?:transact|set|delete|sweepPrefix)\s*\(/
// The raw generic surface (`set`/`delete`) is stricter: only the store primitive may use it.
const GENERIC_SURFACE = /\bstore\.(?:set|delete)\s*\(/

const SOURCES = collectSources(SRC_DIR)

function detectedWriters(pattern) {
  const hits = []
  for (const rel of SOURCES) {
    const text = readFileSync(join(SRC_DIR, rel), 'utf8')
    if (pattern.test(text)) hits.push(rel)
  }
  return hits.sort()
}

/** Parse the `src/...` paths out of the allowlist block embedded in the registry doc. */
function registeredWriters() {
  const doc = readFileSync(REGISTRY_DOC, 'utf8')
  const start = doc.indexOf(ALLOWLIST_OPEN)
  const end = doc.indexOf(ALLOWLIST_CLOSE)
  assert.notEqual(start, -1, 'registry doc is missing the writer-fitness allowlist block')
  assert.notEqual(end, -1, 'registry doc is missing the allowlist close marker')
  const body = doc.slice(start + ALLOWLIST_OPEN.length, end)
  const paths = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cell = line.split('|')[1]?.trim() ?? ''
    const match = /^`(src\/[^`]+)`$/.exec(cell)
    if (match !== null) paths.push(match[1].slice('src/'.length))
  }
  return paths.sort()
}

/** Collect local (`./` or `../`) import targets of a module, as src-relative posix paths. */
function localImports(rel) {
  const text = readFileSync(join(SRC_DIR, rel), 'utf8')
  const out = []
  const push = (spec) => {
    if (typeof spec !== 'string' || !spec.startsWith('.')) return
    const target = resolve(dirname(join(SRC_DIR, rel)), spec)
    out.push(relative(SRC_DIR, target).split(sep).join('/'))
  }
  for (const match of text.matchAll(/from\s+(['"])([^'"]+)\1/g)) push(match[2])
  for (const match of text.matchAll(/import\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) push(match[2])
  return out
}

test('T17: the generic store.set/store.delete surface stays confined to the store primitive', () => {
  assert.deepEqual(
    detectedWriters(GENERIC_SURFACE),
    ['inbound/store.mjs'],
    'only the store primitive may use the raw generic set/delete; every other writer must use the durable helpers',
  )
})

test('T17: every durable-store writer is registered in the registry allowlist', () => {
  const detected = detectedWriters(WRITE_SURFACE)
  const registered = registeredWriters()
  const unregistered = detected.filter((rel) => !registered.includes(rel))
  assert.deepEqual(
    unregistered,
    [],
    `unregistered durable-store writers: ${unregistered.join(', ')} — register each key/owner in docs/state-writer-registry.md`,
  )
})

test('T17: the writer allowlist has no stale entries (no expired shim stays registered)', () => {
  const detected = new Set(detectedWriters(WRITE_SURFACE))
  const stale = registeredWriters().filter((rel) => !detected.has(rel))
  assert.deepEqual(
    stale,
    [],
    `allowlist entries no longer writing the store: ${stale.join(', ')} — remove the dead writer and its registry row together`,
  )
})

test('T17: layer dependencies point one way (no upward/crossward imports)', () => {
  // Each rule: a source prefix may not import a target prefix. The right-hand layers
  // (admin = outer adapter) may reach down; the left-hand ones may not reach back up.
  const forbidden = [
    { from: 'adapters/', to: ['admin/', 'control-plane/', 'control-surface/'], why: 'provider adapters must not depend on the control/UI layers' },
    { from: 'control-plane/', to: ['admin/', 'control-surface/', 'adapters/'], why: 'application services must not depend on adapters, projections or the outer console' },
    { from: 'control-surface/', to: ['admin/', 'adapters/'], why: 'the control surface projections must not depend on adapters or the outer console' },
    { from: 'inbound/', to: ['admin/'], why: 'inbound transport must not depend on the outer console' },
  ]
  const violations = []
  for (const rel of SOURCES) {
    for (const rule of forbidden) {
      if (!rel.startsWith(rule.from)) continue
      for (const target of localImports(rel)) {
        if (rule.to.some((prefix) => target.startsWith(prefix))) {
          violations.push(`${rel} → ${target} (${rule.why})`)
        }
      }
    }
  }
  assert.deepEqual(violations, [], `dependency-direction violations:\n${violations.join('\n')}`)
})

test('T17: index.mjs is reached only through the plugin entry', () => {
  const importers = SOURCES.filter((rel) => rel !== 'plugin-entry.mjs' && localImports(rel).includes('index.mjs'))
  assert.deepEqual(importers, [], `only plugin-entry.mjs may import index.mjs; found: ${importers.join(', ')}`)
})