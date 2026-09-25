// v0.12.1 Phase C 回归测试（一）：Native RPC 与 long-poll 的准入上限。
//
// 覆盖清单：P1-15（RPC body 无上限）、P1-16（surface.wait waiter 无上限）。
//
// ⚠️ 本文件在修复前【必须失败】——那些失败就是 bug 的复现证据（AGENT-RUNBOOK 第 2 步）。
// 修复前的实际表现：
//   - 1.5MB body 会被全量读进内存再 JSON.parse（本用例拿到 400 而不是 413）
//   - waiters 是无上限 Set，第 N+1 个 wait 会一直挂到 timeout（本用例拿到 still-pending）
//   - 没有任何观测口能问「现在挂了多少 waiter」（waiterCount 缺失）
//
// 【本文件刻意只 import 修复前就已存在的导出】：这样在基线上它以**断言失败**报错，
// 如实展示 bug 行为，而不是以「模块加载失败」掩盖问题。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerControlSurfaceRpc, CONTROL_SURFACE_CHANNEL } from '../src/control-surface/rpc.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用 fake 宿主接缝装配 Native RPC，拿到 webServer 直挂的 route（真机上走的就是这条）。 */
function rig(service) {
  const routes = []
  const ctx = {
    connection: { admit: () => null },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const dispose = registerControlSurfaceRpc(ctx, service ?? { call: async () => ({ ok: true, value: {} }) })
  return { routes, dispose }
}

function fakeReq({ method = 'POST', url, headers = {}, chunks = [] }) {
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json', ...headers }
  return stream
}

function fakeRes() {
  const res = { statusCode: 0, headers: null, payload: '', writableEnded: false }
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers }
  res.end = (payload) => {
    if (payload !== undefined && payload !== null) res.payload += String(payload)
    res.writableEnded = true
  }
  res.on = () => {}
  return res
}

// ───────────────────────────── P1-15：body 上限 ─────────────────────────────

test('P1-15：超过 1MB 的请求体必须在读取阶段被 413 拒绝，不得全量读进内存', async () => {
  const { routes, dispose } = rig()
  assert.equal(routes.length, 1, 'Native RPC 应直挂在 webServer 上（route 已注册）')
  const route = routes[0]

  const body = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 0x78) // 1.5MB，超过 1MB 上限
  const req = fakeReq({
    url: `${CONTROL_SURFACE_CHANNEL}/surface.wait`,
    headers: { 'content-length': String(body.length) },
    chunks: [body],
  })
  const res = fakeRes()
  await route.handler(req, res)

  assert.equal(res.statusCode, 413, '超限 body 必须是 413（可诊断/可重试），而不是被当成 JSON 解析失败')
  if (typeof dispose === 'function') dispose()
})

test('P1-15：正常小负载仍被正确处理（上限未改坏 happy path）', async () => {
  const seen = []
  const { routes } = rig({ call: async (method) => { seen.push(method); return { ok: true, value: { revision: 1, changed: false } } } })
  const body = Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'r1', method: 'surface.wait', payload: { after: 0 },
  }))
  const req = fakeReq({
    url: `${CONTROL_SURFACE_CHANNEL}/surface.wait`,
    headers: { 'content-length': String(body.length) },
    chunks: [body],
  })
  const res = fakeRes()
  await routes[0].handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(seen, ['surface.wait'])
  assert.match(res.payload, /"ok":true/)
})

// ─────────────────────────── P1-16：waiter 上限 ───────────────────────────

test('P1-16：waiter 达到上限后，新的 wait 必须立即返回 capacity，不得挂到 timeout', async () => {
  const revision = createSurfaceRevision({ maxWaiters: 1 })
  const cursor = revision.current().revision

  // 占满唯一名额
  const first = revision.wait({ after: cursor, timeoutMs: 30_000 })
  // 再来一个：修复后必须立即结算为 capacity
  const second = await Promise.race([
    revision.wait({ after: cursor, timeoutMs: 30_000 }).then((value) => value.topic),
    DELAY(200).then(() => 'still-pending'),
  ])

  assert.equal(second, 'capacity', '超限的 wait 必须立即结算，绝不能继续堆积在 timeout 上')

  revision.dispose()
  assert.equal((await first).topic, 'disposed', 'dispose 仍必须结算既有 waiter')
})

test('P1-16：dispose 后 waiter 必须归零（Promise 与 timer 不泄漏）', async () => {
  const revision = createSurfaceRevision()
  const cursor = revision.current().revision
  const pendings = [
    revision.wait({ after: cursor, timeoutMs: 30_000 }),
    revision.wait({ after: cursor, timeoutMs: 30_000 }),
  ]

  const before = typeof revision.waiterCount === 'function' ? revision.waiterCount() : -1
  assert.equal(before, 2, '应有 2 个挂起 waiter（waiterCount 是 C2 新增的观测口）')

  revision.dispose()
  await Promise.all(pendings)
  assert.equal(revision.waiterCount(), 0, 'dispose 后不得残留 waiter')
})