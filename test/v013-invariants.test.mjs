// v0.13 C0 skeleton: keep the test boundary and dev gate executable while
// later commits add the state/config/runtime invariants behind this file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { REAL_PROVIDER_TESTS } from './_hermetic-network-guard.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const guard = readFileSync(new URL('./_hermetic-network-guard.mjs', import.meta.url), 'utf8')

test('v0.13 invariant skeleton: default test command installs the hermetic boundary', () => {
  assert.match(packageJson.scripts.test, /--import\s+\.\/test\/_hermetic-network-guard\.mjs/)
  assert.match(guard, /DSH_REAL_PROVIDER_TESTS === '1'/)
  assert.match(guard, /blocked external network/)
  assert.equal(REAL_PROVIDER_TESTS, process.env.DSH_REAL_PROVIDER_TESTS === '1')
})

test('v0.13 invariant: default mode blocks provider destinations before fetch', { skip: REAL_PROVIDER_TESTS }, async () => {
  await assert.rejects(
    () => fetch('https://oapi.dingtalk.com/app/registration/init'),
    /default test suite blocked external network/,
  )
})

test('v0.13 invariant skeleton: CI runs dev and cancels stale runs', () => {
  assert.match(workflow, /branches:\s*\[main, master, dev\]/)
  assert.match(workflow, /concurrency:/)
  assert.match(workflow, /cancel-in-progress:\s*true/)
})
