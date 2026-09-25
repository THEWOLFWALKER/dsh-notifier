#!/usr/bin/env node
// Host compatibility guard: keep the declared @deepseek-ai/dsh-session peer range, the
// DSH host matrix in docs/compatibility-matrix.md, and dshWorkshop.compatibility.dshVersions
// in one mechanically checked contract. Zero runtime dependencies: only exact or `||`-joined
// exact versions are accepted, so a hand-written parser replaces the `semver` package.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MATRIX_FILE = 'docs/compatibility-matrix.md'
const MATRIX_FENCE = /```[^\n]*dsh-host-matrix[^\n]*\n([\s\S]*?)\n```/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Extract the machine-readable DSH host matrix block, or null when absent/malformed. */
export function parseMatrix(markdown) {
  const match = MATRIX_FENCE.exec(String(markdown ?? ''))
  if (match === null) return null
  try {
    const parsed = JSON.parse(match[1])
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Split a peer range into trimmed alternatives (exact version or `||`-joined exact versions only). */
export function parsePeerRange(range) {
  return String(range ?? '')
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function matrixRuntimes(matrix) {
  const runtimes = matrix?.runtimes
  if (!Array.isArray(runtimes)) return []
  return runtimes.filter((row) => row !== null && typeof row === 'object' && typeof row.version === 'string')
}

/**
 * Verify that the peer range, matrix statuses, and dshWorkshop versions agree.
 * @returns a list of failure messages; empty means the contract holds.
 */
export function verifyHostCompat(packageJson, matrix) {
  const failures = []
  const check = (condition, message) => { if (!condition) failures.push(message) }

  const peerPackage = typeof matrix?.peerPackage === 'string' ? matrix.peerPackage : ''
  check(peerPackage.startsWith('@deepseek-ai/dsh'), 'matrix peerPackage must be a real @deepseek-ai/dsh* package name')
  check(matrix?.peerPackage !== '@deepseek-ai/dsh', 'matrix peerPackage must not be the non-existent @deepseek-ai/dsh package')

  const peers = packageJson?.peerDependencies
  const range = peers !== null && typeof peers === 'object' ? peers[peerPackage] : undefined
  check(typeof range === 'string' && range.trim() !== '', `peerDependencies.${peerPackage || '<missing>'} is missing`)

  const alternatives = parsePeerRange(range)
  check(alternatives.length > 0, `peerDependencies.${peerPackage} must declare at least one version`)
  for (const alternative of alternatives) {
    check(EXACT_VERSION.test(alternative),
      `peer range segment is not an exact version (no ^/>=/* guessing allowed): ${JSON.stringify(alternative)}`)
  }

  const meta = packageJson?.peerDependenciesMeta
  const optionalPeer = meta !== null && typeof meta === 'object' ? meta[peerPackage] : undefined
  check(optionalPeer?.optional === true,
    `peerDependenciesMeta.${peerPackage}.optional must be true (the marker is not a runtime import)`)

  const runtimes = matrixRuntimes(matrix)
  check(runtimes.length > 0, 'matrix must declare at least one runtime row')
  const verified = runtimes.filter((row) => row.status === 'verified').map((row) => row.version)
  const other = runtimes.filter((row) => row.status !== 'verified').map((row) => row.version)

  for (const version of verified) {
    check(alternatives.includes(version), `verified runtime ${version} is not covered by the peer range`)
  }
  for (const alternative of alternatives) {
    check(verified.includes(alternative), `peer range segment ${alternative} has no verified matrix row`)
  }
  for (const version of other) {
    check(!alternatives.includes(version), `non-verified runtime ${version} must not be covered by the peer range`)
  }

  const declared = packageJson?.dshWorkshop?.compatibility?.dshVersions
  check(Array.isArray(declared), 'dshWorkshop.compatibility.dshVersions must be an array')
  check(JSON.stringify(declared) === JSON.stringify(verified),
    `dshWorkshop.compatibility.dshVersions must equal the verified matrix rows ${JSON.stringify(verified)}, got ${JSON.stringify(declared)}`)

  return failures
}

/** Read package.json + the matrix from a repository root and return failure messages. */
export function hostCompatFailures(root) {
  let packageJson
  try {
    packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch (error) {
    return [`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`]
  }
  let markdown
  try {
    markdown = readFileSync(resolve(root, MATRIX_FILE), 'utf8')
  } catch (error) {
    return [`${MATRIX_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`]
  }
  const matrix = parseMatrix(markdown)
  if (matrix === null) return [`${MATRIX_FILE} has no parseable dsh-host-matrix block`]
  return verifyHostCompat(packageJson, matrix)
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const failures = hostCompatFailures(root)
  if (failures.length > 0) {
    console.error('host compatibility guard failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  console.log(`host compatibility guard ok: ${packageJson.peerDependencies['@deepseek-ai/dsh-session']}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()