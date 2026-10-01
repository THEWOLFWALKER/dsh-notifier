// Runner for the isolated test/dom workspace.
//
//   node test/dom/run.mjs
//
// Runs every *.test.mjs in this directory through node's built-in test runner
// and exits non-zero on any failure. This suite is intentionally separate from
// the repo-root `npm test` glob (which only picks up test/*.test.mjs and
// test/*.spec.mjs) so the shipped package keeps zero runtime dependencies.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join(here, name))
  .sort()

if (files.length === 0) {
  console.error('[dom-tests] no *.test.mjs files found in', here)
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  // --test-force-exit: a leaked controller interval (e.g. a failing UI test that
  // never reached its teardown) must fail the suite, not hang the runner.
  ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=30000', '--test-reporter=spec', ...files],
  { stdio: 'inherit', cwd: here },
)

if (result.error) {
  console.error('[dom-tests] failed to launch the test runner:', result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)