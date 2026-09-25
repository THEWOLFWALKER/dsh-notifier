// v0.11 Commit14 — DSH host compatibility contract.
// Locks the three-way agreement between the @deepseek-ai/dsh-session peer range,
// the DSH host matrix in docs/compatibility-matrix.md, and
// dshWorkshop.compatibility.dshVersions. The same helper backs
// scripts/verify-host-compat.mjs and `npm run verify:release`, so a hand-edited
// manifest can no longer drift from the evidence-backed rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostCompatFailures, parseMatrix, parsePeerRange, verifyHostCompat } from '../scripts/verify-host-compat.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const matrix = parseMatrix(readFileSync(resolve(root, 'docs/compatibility-matrix.md'), 'utf8'))

const VERIFIED = ['0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2']

test('host compat: the shipped manifest and matrix verify cleanly', () => {
  assert.notEqual(matrix, null, 'docs/compatibility-matrix.md must carry a dsh-host-matrix block')
  assert.deepEqual(hostCompatFailures(root), [])
  assert.deepEqual(verifyHostCompat(packageJson, matrix), [])
})

test('host compat: the peer marker is a real optional @deepseek-ai/dsh* package', () => {
  const range = packageJson.peerDependencies['@deepseek-ai/dsh-session']
  assert.equal(typeof range, 'string')
  assert.equal(matrix.peerPackage, '@deepseek-ai/dsh-session')
  assert.notEqual(matrix.peerPackage, '@deepseek-ai/dsh', 'the bare @deepseek-ai/dsh package does not exist')
  assert.equal(packageJson.peerDependenciesMeta['@deepseek-ai/dsh-session'].optional, true)
})

test('host compat: the range is exact or OR-exact, never a guessed range', () => {
  const range = packageJson.peerDependencies['@deepseek-ai/dsh-session']
  assert.equal(range, VERIFIED.join(' || '))
  assert.equal(/[\^~><*]/.test(range), false, 'no caret/tilde/inequality/wildcard guessing')
  assert.deepEqual(parsePeerRange(range), VERIFIED)
})

test('host compat: dshWorkshop lists exactly the verified rows', () => {
  assert.deepEqual(packageJson.dshWorkshop.compatibility.dshVersions, VERIFIED)
  const verified = matrix.runtimes.filter((row) => row.status === 'verified').map((row) => row.version)
  assert.deepEqual(verified, VERIFIED)
})

test('host compat: the historical 0.1.0-rc.6 claim is marked unverified and excluded', () => {
  const row = matrix.runtimes.find((entry) => entry.version === '0.1.0-rc.6')
  assert.notEqual(row, undefined)
  assert.notEqual(row.status, 'verified')
  assert.equal(parsePeerRange(packageJson.peerDependencies['@deepseek-ai/dsh-session']).includes('0.1.0-rc.6'), false)
})

test('host compat: drift is caught — a non-verified runtime must not enter the range', () => {
  const drifted = {
    ...packageJson,
    peerDependencies: {
      ...packageJson.peerDependencies,
      '@deepseek-ai/dsh-session': `0.1.0-rc.6 || ${VERIFIED.join(' || ')}`,
    },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /non-verified runtime 0\.1\.0-rc\.6/.test(line)), true)
})

test('host compat: drift is caught — a verified runtime must be covered', () => {
  const drifted = {
    ...packageJson,
    peerDependencies: { ...packageJson.peerDependencies, '@deepseek-ai/dsh-session': '0.1.7-rc.1' },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /verified runtime 0\.1\.7-rc\.2 is not covered/.test(line)), true)
})

test('host compat: drift is caught — a guessed caret range is rejected', () => {
  const drifted = {
    ...packageJson,
    peerDependencies: { ...packageJson.peerDependencies, '@deepseek-ai/dsh-session': '^0.1.7' },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /not an exact version/.test(line)), true)
})

test('host compat: drift is caught — the workshop list must match the verified rows', () => {
  const drifted = {
    ...packageJson,
    dshWorkshop: { ...packageJson.dshWorkshop, compatibility: { dshVersions: ['0.1.7-rc.1'] } },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /dshVersions must equal the verified matrix rows/.test(line)), true)
})

test('host compat: drift is caught — a missing optional-peer marker or range is reported', () => {
  const noMeta = { ...packageJson, peerDependenciesMeta: {} }
  assert.equal(verifyHostCompat(noMeta, matrix).some((line) => /optional must be true/.test(line)), true)
  const noPeer = { ...packageJson, peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }
  assert.equal(verifyHostCompat(noPeer, matrix).some((line) => /is missing/.test(line)), true)
})

test('host compat: the machine block parser fails closed on absent or malformed input', () => {
  assert.equal(parseMatrix('# no block here'), null)
  assert.equal(parseMatrix('```json dsh-host-matrix\n{ not json\n```'), null)
  assert.deepEqual(parsePeerRange(' 0.1.7-rc.1 || 0.1.7-rc.2 '), ['0.1.7-rc.1', '0.1.7-rc.2'])
})