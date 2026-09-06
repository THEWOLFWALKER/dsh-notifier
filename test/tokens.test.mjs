// W8 token/QQ 网关批次（G-11/29/55）：token 管理器与 TTL 归一化单元测试。
// 覆盖：normalizeTtlMs 异常值 fail-closed + 上下限钳制；invalidate 代际守卫（旧 inflight
// 晚完成不得把失效 token 写回缓存）；动态刷新余量（短 TTL 不再每发必取，长 TTL 维持 60s 窗）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTokenManager, normalizeTtlMs } from '../src/adapters/_tokens.mjs'

// ---------------------------------------------------------------- G-55 normalizeTtlMs

test('G-55 normalizeTtlMs：非法值（0/负/NaN/非数值串）fail-closed 抛错，不再各自兜底', () => {
  for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined]) {
    assert.throws(() => normalizeTtlMs(bad), /TTL 非法/, `值 ${String(bad)} 应抛错（四种兜底走向曾是同值不同命）`)
  }
})

test('G-55 normalizeTtlMs：正数钳制 [1s, 7d]，正常值直通', () => {
  assert.equal(normalizeTtlMs(1000), 1000)
  assert.equal(normalizeTtlMs(7200_000), 7200_000)
  assert.equal(normalizeTtlMs(500), 1000, '低于下限钳到 1s（0.5s TTL 实务上无意义且防抖动）')
  assert.equal(normalizeTtlMs(8 * 24 * 3600 * 1000), 7 * 24 * 3600 * 1000, '高于上限钳到 7d')
  assert.equal(normalizeTtlMs(1500.6), 1501, '小数毫秒四舍五入')
})

// ---------------------------------------------------------------- G-11 代际守卫

test('G-11 invalidate 代际守卫：旧 inflight 晚完成不覆盖新缓存（失效 token 不复活）', async () => {
  const deferred = []
  const fetchToken = () => new Promise((resolve) => deferred.push(resolve))
  const tm = createTokenManager(fetchToken)

  const p1 = tm.get() // 旧代际任务在飞（后被证明携带的正是被吊销的 token）
  tm.invalidate() // 平台 401/40014 → 作废
  const p2 = tm.get() // 新代际任务
  assert.equal(deferred.length, 2, 'invalidate 清 inflight 后新 get 必须发起新换取')

  deferred[1]({ token: 'NEW', expiresInMs: 7200_000 }) // 新任务先完成
  assert.equal(await p2, 'NEW')
  deferred[0]({ token: 'OLD', expiresInMs: 7200_000 }) // 旧任务晚完成——写回必须被代际比对拦下
  assert.equal(await p1, 'OLD', '旧调用者拿到自己发起的结果（值本身无妨）')

  // 关键断言：缓存里必须是 NEW。旧实现（无代际）此处会把 OLD 连同 7200s 的 expiresAt
  // 写回 cached——此后两小时所有调用方都用死 token。
  assert.equal(await tm.get(), 'NEW', '旧 inflight 晚完成不得把失效 token 写回缓存')
  assert.equal(await tm.get(), 'NEW', '后续调用命中新缓存，不再换取')
})

test('G-11 invalidate 后立刻 get：必须发起换取（不复用失效前发起的旧任务结果）', async () => {
  const deferred = []
  let fetches = 0
  const fetchToken = () => { fetches += 1; return new Promise((resolve) => deferred.push(resolve)) }
  const tm = createTokenManager(fetchToken)
  const p1 = tm.get()
  tm.invalidate()
  const p2 = tm.get()
  assert.equal(fetches, 2, '第二次 get 应发起第二次换取（invalidate 清掉了旧 inflight）')
  deferred[0]({ token: 'OLD', expiresInMs: 7200_000 })
  deferred[1]({ token: 'NEW', expiresInMs: 7200_000 })
  assert.equal(await p1, 'OLD')
  assert.equal(await p2, 'NEW')
  assert.equal(await tm.get(), 'NEW')
})

// ---------------------------------------------------------------- G-29 动态刷新余量

test('G-29 动态余量：TTL(1s) < 60s 余量时不再「永判不新鲜」每发必取', async () => {
  let fetches = 0
  const tm = createTokenManager(async () => { fetches += 1; return { token: `T${fetches}`, expiresInMs: 1000 } })
  assert.equal(await tm.get(), 'T1')
  assert.equal(await tm.get(), 'T1')
  assert.equal(await tm.get(), 'T1')
  assert.equal(fetches, 1, '短 TTL 缓存可用到自然到期（旧固定 60s 余量下永判不新鲜，每发必取）')
  await new Promise((resolve) => setTimeout(resolve, 1050))
  assert.equal(await tm.get(), 'T2', 'TTL 到点后重取')
  assert.equal(fetches, 2)
})

test('G-29 动态余量：长 TTL(7200s) 维持默认 60s 提前刷新窗（既有行为不变）', async () => {
  let fetches = 0
  const tm = createTokenManager(async () => { fetches += 1; return { token: `T${fetches}`, expiresInMs: 7200_000 } })
  assert.equal(await tm.get(), 'T1')
  assert.equal(await tm.get(), 'T1')
  assert.equal(fetches, 1, '余量 = min(60s, 剩余 20%)=60s：两小时内不重复换取')
})
