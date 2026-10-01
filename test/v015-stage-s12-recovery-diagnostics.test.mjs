// v0.15 S12（T20）：Recovery 纯恢复与只读诊断。
//
// 锁定 03-TASKS T20 的验收：
//   1. 日常功能在 Native；Recovery 台保留 localhost 认证 + 只读诊断——**无 Native 时诊断仍可用**，
//      并且读的是与 Native 同一个 canonical 快照实例（不存在第二套采集/修复逻辑）；
//   2. 只读：读取诊断绝不写 store、绝不变更运行时、绝不重放任何 interaction；
//   3. 快照未装配 → ApiError(501) fail-closed，绝不回空快照冒充「无异常」；读取失败 → 503（不谎报健康）；
//   4. 报告/快照零 secret：宿主 secret 字段绝不进入 canonical 快照；
//   5. HTTP 级 GET /api/diagnostics 透传同一快照，且仍受 Bearer 鉴权保护。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiagnosticsService } from '../src/control-surface/diagnostics.mjs'
import { createAdminApi, ApiError } from '../src/admin/api.mjs'
import { createAdminServer } from '../src/admin/server.mjs'

const SECRET = 'tok_live_9f8e7d6c5b4a3210'

/** 一个正常的 canonical 诊断服务（含一条最近失败 + 一个绝不应外泄的宿主 secret）。 */
function realDiagnostics() {
  return createDiagnosticsService({
    version: '0.15.0',
    revision: { current: () => ({ epoch: 'epoch-1', revision: 7 }) },
    hostCapabilities: () => ({
      host: { version: '1.2.3', token: SECRET, appSecret: SECRET },
      events: { mode: 'available' },
      questions: { mode: 'available' },
      media: { imageInput: 'unknown' },
    }),
    storage: { readFailed: false },
    channels: {
      list: () => [
        { type: 'bark', notify: { configured: true, active: true, applyMode: 'hot' }, control: null, health: { state: 'healthy', accepted: 1, delivered: 1 } },
        { type: 'webhook', notify: { configured: true, active: true, applyMode: 'hot' }, control: null, health: { state: 'degraded', accepted: 1, delivered: 0, lastError: SECRET } },
      ],
    },
    questions: { list: () => [] },
    sessions: { list: () => [] },
    bindings: { get: () => ({}), canEdit: true },
    members: { list: () => [], canRemove: true },
    activity: { list: () => [{ level: 'error', at: 1, category: 'channel', action: 'send', detail: { en: 'send failed', zh: '发送失败' } }] },
    advancedConsole: 'available',
  })
}

const tempStateDir = () => mkdtempSync(join(tmpdir(), 'dsh-v015-s12-'))

// ————————————————————— 1. 只读 + 同一 canonical 快照 —————————————————————
test('T20: Recovery 读同一 canonical 诊断快照，只读且不碰 store', () => {
  const canonical = realDiagnostics().snapshot()
  let reads = 0
  const diagnostics = { snapshot: () => { reads += 1; return canonical } }

  // store 双向抛错：证明 getDiagnostics 绝不借道 store（读取不 exercised 任何写/读路径）。
  const hostileStore = {
    get() { throw new Error('diagnostics must not read the store') },
    set() { throw new Error('diagnostics must not write the store') },
    transact() { throw new Error('diagnostics must not open a transaction') },
  }
  const api = createAdminApi({ store: hostileStore, stateDir: tempStateDir(), diagnostics })

  const snap = api.getDiagnostics()
  assert.equal(reads, 1, 'exactly one canonical read per request — no second collection path')
  assert.equal(snap, canonical, 'Recovery reads the very same canonical snapshot instance as Native')

  // canonical 语义仍然成立：unknown != failed、attention 有明确答案。
  assert.equal(snap.process.epoch, 'epoch-1')
  assert.equal(snap.process.revision, 7)
  assert.equal(typeof snap.attention.required, 'boolean')
  assert.equal(snap.attention.required, true, 'a degraded channel is surfaced as attention')
  assert.equal(snap.channels.degraded, 1)
})

test('T20: 快照零 secret —— 宿主/渠道 secret 字段绝不进入 canonical 快照', () => {
  const snap = realDiagnostics().snapshot()
  const text = JSON.stringify(snap)
  assert.equal(text.includes(SECRET), false, 'no host secret leaks into the diagnostics snapshot')
  assert.equal(text.includes('tok_live'), false, 'no token-shaped value leaks')
  assert.equal(snap.host.version, '1.2.3')
  assert.equal(snap.host.eventsMode, 'available')
})

// ————————————————————— 2. fail-closed：未装配 501，读取失败 503 —————————————————————
test('T20: 未装配诊断 → 501 fail-closed（绝不回空快照冒充无异常）', () => {
  const api = createAdminApi({ stateDir: tempStateDir() })
  assert.throws(() => api.getDiagnostics(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 501)
    return true
  })
})

test('T20: 快照读取抛错 → 503（不谎报健康）', () => {
  const api = createAdminApi({
    stateDir: tempStateDir(),
    diagnostics: { snapshot() { throw new Error('backend exploded') } },
  })
  assert.throws(() => api.getDiagnostics(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 503)
    return true
  })
})

// ————————————————————— 3. HTTP 级：路由透传同一快照 + 保持鉴权 —————————————————————
test('T20: GET /api/diagnostics 透传 canonical 快照，且仍受 Bearer 鉴权保护', async () => {
  const canonical = realDiagnostics().snapshot()
  const api = createAdminApi({
    stateDir: tempStateDir(),
    diagnostics: { snapshot: () => canonical },
  })
  const server = createAdminServer({
    api,
    verifyToken: (token) => token === 'secret',
    host: '127.0.0.1',
    port: 0,
    ui: '',
    logger: { warn: () => {} },
  })
  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  try {
    const anon = await fetch(`${base}/api/diagnostics`)
    assert.equal(anon.status, 401, 'diagnostics stays behind localhost auth')

    const res = await fetch(`${base}/api/diagnostics`, { headers: { authorization: 'Bearer secret' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, canonical, 'HTTP layer returns the same canonical snapshot verbatim')
    assert.equal(JSON.stringify(body).includes(SECRET), false, 'no secret over the wire')
  } finally {
    await server.stop()
  }
})

test('T20: HTTP 级未装配诊断 → 501（能力语义透传，不伪装成功）', async () => {
  const api = createAdminApi({ stateDir: tempStateDir() })
  const server = createAdminServer({
    api,
    verifyToken: () => true,
    host: '127.0.0.1',
    port: 0,
    ui: '',
    logger: { warn: () => {} },
  })
  const info = await server.start()
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/diagnostics`, { headers: { authorization: 'Bearer x' } })
    assert.equal(res.status, 501)
    const body = await res.json()
    assert.equal(typeof body.error, 'string')
  } finally {
    await server.stop()
  }
})