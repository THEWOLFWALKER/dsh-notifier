// v0.14 S14 — DSH host seam / compatibility audit.
//
// Audits, target by target, whether the seam dsh-notifier *believes* exists matches the
// official host source/shape, and locks the machine-readable `dsh-host-seam-matrix` block in
// docs/compatibility-matrix.md. The audit is deliberately audit-first: the current carrier is
// kept unless a new carrier is evidenced for every declared host AND migration benefit is clear.
//
// The ruled-out carrier (`connection.fetch.register`) and the seams without a dedicated probe
// elsewhere (attachments capability, agents access) are exercised here against the real modules;
// the slotted client, rpc.handle fallback and user-questions waterfall rows point at their
// existing focused suites and are only cross-checked for existence/structure here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerControlSurfaceRpc, CONTROL_SURFACE_CHANNEL } from '../src/control-surface/rpc.mjs'
import {
  admitInboundFile,
  admitInboundImage,
  IMAGE_MEDIA_TYPES,
  readAttachments,
} from '../src/host/messages.mjs'
import { detectConversationMode } from '../src/host/capability.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const matrixMarkdown = readFileSync(resolve(root, 'docs/developer/compatibility-matrix.md'), 'utf8')

/** Extract the machine-readable host-seam matrix block, or null when absent/malformed. */
function parseSeamMatrix(markdown) {
  const match = /```[^\n]*dsh-host-seam-matrix[^\n]*\n([\s\S]*?)\n```/.exec(String(markdown ?? ''))
  if (match === null) return null
  try {
    const parsed = JSON.parse(match[1])
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

const seamMatrix = parseSeamMatrix(matrixMarkdown)

/** The eight audit targets from the S14 task card, in the declared order. */
const REQUIRED_SEAMS = [
  'connection.rpc.handle',
  'connection.fetch.register',
  'webServer.fallback',
  'client.slots',
  'user-questions.waterfall',
  'agents.sessions',
  'attachments',
  'client.services',
]

// ---------- matrix lock ----------

test('host seam audit: the compatibility doc carries a parseable seam matrix', () => {
  assert.notEqual(seamMatrix, null, 'docs/compatibility-matrix.md must carry a dsh-host-seam-matrix block')
  assert.equal(Array.isArray(seamMatrix.seams), true)
  assert.equal(seamMatrix.seams.length, REQUIRED_SEAMS.length)
})

test('host seam audit: the matrix covers exactly the eight audited targets, in order', () => {
  assert.deepEqual(seamMatrix.seams.map((row) => row.id), REQUIRED_SEAMS)
})

test('host seam audit: every row carries the required evidence fields', () => {
  for (const row of seamMatrix.seams) {
    for (const field of ['official', 'notifierPath', 'probe', 'fallback', 'risk']) {
      assert.equal(typeof row[field], 'string', `${row.id}.${field} must be a string`)
      assert.notEqual(row[field].trim(), '', `${row.id}.${field} must not be empty`)
    }
    assert.equal(typeof row.fixtureCovered, 'boolean', `${row.id}.fixtureCovered must be a boolean`)
  }
})

test('host seam audit: the audited hosts equal the declared supported peer range', () => {
  const range = packageJson.peerDependencies['@deepseek-ai/dsh-session']
  const declared = String(range).split('||').map((part) => part.trim()).filter((part) => part !== '')
  assert.deepEqual(seamMatrix.auditedHosts, declared)
  assert.deepEqual(seamMatrix.auditedHosts, packageJson.dshWorkshop.compatibility.dshVersions)
})

test('host seam audit: fixtureCovered rows point at real notifier/probe files', () => {
  for (const row of seamMatrix.seams.filter((entry) => entry.fixtureCovered === true)) {
    assert.equal(existsSync(resolve(root, row.notifierPath)), true, `${row.id}.notifierPath must exist`)
    assert.equal(existsSync(resolve(root, row.probe)), true, `${row.id}.probe must exist`)
  }
})

// ---------- carrier decision: connection.fetch.register is deliberately not adopted ----------

test('host seam audit: fetch.register alone is not a carrier (no accidental adoption)', () => {
  const ctx = {
    connection: {
      fetch: {
        register() { throw new Error('connection.fetch.register must not be adopted as the carrier') },
      },
    },
    effect(fn) { return fn() },
  }
  assert.equal(registerControlSurfaceRpc(ctx, { call: async () => ({ ok: true, value: null }) }), null)
})

test('host seam audit: a throwing rpc.handle falls back to webServer and never touches fetch.register', () => {
  const routes = []
  let fetchRegisterCalls = 0
  const ctx = {
    connection: {
      rpc: { handle() { throw new Error('cannot get property "webServer" without inject') } },
      fetch: { register() { fetchRegisterCalls += 1; return () => {} } },
      admit: () => ({ peer: {} }),
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { return fn() },
  }
  const dispose = registerControlSurfaceRpc(ctx, { call: async () => ({ ok: true, value: null }) })

  assert.equal(typeof dispose, 'function')
  assert.equal(routes.length, 1)
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: CONTROL_SURFACE_CHANNEL })
  assert.equal(fetchRegisterCalls, 0, 'the ruled-out carrier must not be called on the fallback path')
})

// ---------- attachments capability ----------

test('host seam audit: attachments read is defensive across get / direct / throwing proxy', () => {
  const service = { saveImage: async () => ({ attachmentId: 'a' }) }
  assert.equal(readAttachments({ get: (name, strict) => {
    assert.equal(name, 'attachments')
    assert.equal(strict, false, 'must use the non-throwing optional read')
    return service
  } }), service)
  assert.equal(readAttachments({ attachments: service }), service)
  assert.equal(readAttachments({}), null)
  const proxyCtx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'attachments') throw new Error('cannot get property "attachments" without inject')
      return target[prop]
    },
  })
  assert.equal(readAttachments(proxyCtx), null)
})

test('host seam audit: admitInboundImage fails closed outside the media-type whitelist', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const saved = []
  const service = {
    async saveImage(input) { saved.push(input); return { attachmentId: 'img-1' } },
  }
  const ok = await admitInboundImage(service, bytes, IMAGE_MEDIA_TYPES[0])
  assert.deepEqual(ok, { attachmentId: 'img-1' })
  assert.equal(saved.length, 1)
  assert.equal(await admitInboundImage(service, bytes, 'image/svg+xml'), null)
  assert.equal(saved.length, 1, 'a non-whitelisted media type must not reach the store')
  assert.equal(await admitInboundImage(null, bytes, IMAGE_MEDIA_TYPES[0]), null)
  assert.equal(await admitInboundImage({ saveImage: async () => { throw new Error('boom') } }, bytes, IMAGE_MEDIA_TYPES[0]), null)
  // A ref without attachmentId is not a durable admission.
  assert.equal(await admitInboundImage({ saveImage: async () => ({}) }, bytes, IMAGE_MEDIA_TYPES[0]), null)
})

test('host seam audit: admitInboundFile requires saveFile and fails closed', async () => {
  const bytes = new Uint8Array([4, 5, 6])
  const withFile = { saveFile: async () => ({ attachmentId: 'file-1' }) }
  assert.deepEqual(await admitInboundFile(withFile, bytes, 'report.pdf'), { attachmentId: 'file-1' })
  assert.equal(await admitInboundFile({ saveImage: async () => ({ attachmentId: 'x' }) }, bytes, 'report.pdf'), null,
    'a host with the attachment service but no saveFile is outside the file-inbound boundary')
  assert.equal(await admitInboundFile(null, bytes, 'report.pdf'), null)
  assert.equal(await admitInboundFile({ saveFile: async () => { throw new Error('boom') } }, bytes, 'report.pdf'), null)
})

// ---------- agents / sessions access ----------

test('host seam audit: agents access degrades without throwing and never false-claims availability', () => {
  const throwingRouter = createAgentRouter({
    store: { get: () => undefined },
    agentsList: () => { throw new Error('ctx.agents.list unavailable') },
  })
  let inbound
  assert.doesNotThrow(() => { inbound = throwingRouter.resolveInbound('telegram', 'u1') })
  assert.deepEqual(inbound, { sessionId: null, source: 'latest', ambiguous: false })

  const singleAgentRouter = createAgentRouter({
    store: { get: () => undefined },
    agentsList: () => [{ id: 'a1', status: 'idle' }],
  })
  assert.deepEqual(singleAgentRouter.resolveInbound('telegram', 'u1'), { sessionId: 'a1', source: 'single-agent', ambiguous: false })

  assert.deepEqual(detectConversationMode({}), { followup: 'unknown', inject: 'unknown', steer: 'unknown' })
})

// ---------- client services actually used ----------

test('host seam audit: declared client injects are host-provided, not npm runtime dependencies', () => {
  const injects = packageJson.dsh.client.inject
  assert.deepEqual(injects, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ])
  const runtimeDeps = packageJson.dependencies ?? {}
  for (const pkg of injects) {
    assert.equal(Object.prototype.hasOwnProperty.call(runtimeDeps, pkg), false, `${pkg} must not be a runtime dependency`)
  }
})