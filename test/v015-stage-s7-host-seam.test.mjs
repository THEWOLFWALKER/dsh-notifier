// v0.15 T13 — 官方 Host seam 集中化。
//
// 验收对应 04 必测矩阵：
//  - H01 服务缺失/晚注入/撤销/重建 → 局部降级；其他渠道继续，旧 listener 退出
//  - H02 timed 等待结束 Host 仍 pending → 不误取消；可 late reply 按官方能力处理
//  - H03 官方 Cordis/Connection/slot/event scope → 生产模块消费真实 fixture，生命周期与权限边界有效
//
// 本套件驱动**真实生产模块**（src/host/seam.mjs 与 src/host/native-questions.mjs），
// 不是重述；宿主侧以 documented Cordis 形状（get/on/inject/userQuestions）的 fixture 驱动。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CONSERVATIVE_QUESTION_CAPABILITY,
  HOST_QUESTION_CAPABILITY,
  createHostLifetime,
  createHostSeam,
  hostQuestionFeatures,
  readHostService,
} from '../src/host/seam.mjs'
import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'

const ROOT = new URL('..', import.meta.url)

function fakeQuestionBridge(overrides = {}) {
  return {
    askQuestions: async () => ({ ok: true, answered: true, results: [] }),
    adminPending: () => [],
    adminSettle: () => ({ ok: true, handled: false }),
    ...overrides,
  }
}

/** userQuestions 只有 ask()（DSH 0.1.7-rc.* 实测形态）+ ctx.on 记录器。 */
function fakeWaterfallCtx(extra = {}) {
  const listeners = []
  return {
    userQuestions: { ask() {} },
    on(name, cb, opts) {
      listeners.push({ name, cb, opts, disposed: false })
      const entry = listeners[listeners.length - 1]
      return () => { entry.disposed = true }
    },
    listeners,
    ...extra,
  }
}

/**
 * documented Cordis `ctx.inject(deps, cb)` fixture：登记回调并返回撤销句柄；
 * 依赖是否可用由测试决定（immediate / late / replacement），不自动触发。
 */
function fakeInjectCtx(inner = {}) {
  const calls = []
  return {
    ctx: {
      ...inner,
      inject(names, cb) {
        const entry = { names, cb, disposed: false }
        calls.push(entry)
        return () => { entry.disposed = true }
      },
    },
    calls,
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const REQUEST = { questions: [{ id: 'q1', question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] }

// ---------------------------------------------------------------- H03：读取/能力描述

test('H03 readHostService：get 优先（非抛错）、直读兜底、抛错代理按无服务处理', () => {
  const service = { ask() {} }
  assert.equal(readHostService({ get: (name, strict) => {
    assert.equal(name, 'userQuestions')
    assert.equal(strict, false, '必须走非抛错的 optional 读')
    return service
  } }, 'userQuestions'), service)
  assert.equal(readHostService({ get: () => undefined }, 'attachments'), null)
  assert.equal(readHostService({ agents: service }, 'agents'), service)
  assert.equal(readHostService({}, 'connection'), null)
  // 真机 #27 现场：cordis 代理对未 inject 的服务直读会抛错 → 按无服务
  const proxyCtx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'webServer') throw new Error('cannot get property "webServer" without inject')
      return target[prop]
    },
  })
  assert.equal(readHostService(proxyCtx, 'webServer'), null)
  assert.equal(readHostService({}, ''), null, '空服务名不读取')
})

test('H03 hostQuestionFeatures：seam 永远来自运行时探测，声明表只补版本差异', () => {
  // rc.2 声明 waterfall=true；运行时确实暴露 ask-only → seam=native-event，waterfall=true
  const observed = hostQuestionFeatures({ version: '0.1.7-rc.2', userQuestions: { ask() {} } })
  assert.equal(observed.seam, 'native-event')
  assert.equal(observed.known, true)
  assert.equal(observed.verified, true)
  assert.equal(observed.waterfall, true)
  assert.equal(observed.timed, false)
  assert.equal(observed.continued, false)

  // 声明 waterfall=false 的 alpha 行：即使运行时暴露 ask-only，也不谎报 waterfall
  const alpha = hostQuestionFeatures({ version: '0.1.7-alpha.2', userQuestions: { ask() {} } })
  assert.equal(alpha.seam, 'native-event')
  assert.equal(alpha.known, true)
  assert.equal(alpha.waterfall, false)

  // 未列版本：known=false，回落保守描述（版本差异能力全关）
  const unknown = hostQuestionFeatures({ version: '9.9.9', userQuestions: { ask() {}, registerProvider() {} } })
  assert.equal(unknown.known, false)
  assert.equal(unknown.seam, 'provider-chain')
  assert.deepEqual(
    { waterfall: unknown.waterfall, provider: unknown.provider, timed: unknown.timed, continued: unknown.continued },
    { waterfall: false, provider: false, timed: false, continued: false },
  )
  assert.deepEqual(CONSERVATIVE_QUESTION_CAPABILITY, {
    waterfall: false, provider: false, timed: false, continued: false, verified: false,
  })
})

test('H03 hostQuestionFeatures：0.2 timed/continued 声明（未 fixture 验证）与 unsupported fail-closed', () => {
  const next = hostQuestionFeatures({ version: '0.2.0-rc.2', userQuestions: { ask() {} } })
  assert.equal(next.known, true)
  assert.equal(next.verified, false, '0.2 行尚无 fixture，不得标 verified')
  assert.equal(next.timed, true, '较新宿主支持有界等待（等待结束 Host 仍可能 pending）')
  assert.equal(next.continued, true, '较新宿主支持迟到答复')

  // 没有暴露任何 seam → 版本差异能力一律不成立（绝不谎报可用）
  const noSeam = hostQuestionFeatures({ version: '0.2.0-rc.2' })
  assert.equal(noSeam.seam, 'unsupported')
  assert.equal(noSeam.supported, false)
  assert.equal(noSeam.timed, false)
  assert.equal(noSeam.continued, false)

  // 声明表的键就是 auditedHosts（0.1.7 线）+ 发布版 next
  assert.deepEqual(
    Object.keys(HOST_QUESTION_CAPABILITY).filter((v) => v.startsWith('0.1.7')),
    ['0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'],
  )
})

test('H03 createHostSeam：聚合只读门面在空 ctx 上不抛错、不谎报', () => {
  const seam = createHostSeam({})
  assert.equal(seam.version(), 'unknown')
  assert.equal(seam.questions(), null)
  assert.equal(seam.attachments(), null)
  assert.equal(seam.agents(), null)
  assert.equal(seam.connection(), null)
  assert.equal(seam.webServer(), null)
  assert.equal(seam.questionFeatures().seam, 'unsupported')
  assert.doesNotThrow(() => seam.dispose())
  seam.dispose()
  assert.equal(seam.disposed, true)
})

test('H03 集中化：生产 src/ 只有 host/seam.mjs 直接调用 ctx.inject', () => {
  const indexSrc = readFileSync(new URL('src/index.mjs', ROOT), 'utf8')
  assert.doesNotMatch(indexSrc, /ctx\.inject\(/, 'index.mjs 不再裸调 ctx.inject（生命周期收敛到 hostLifetime）')
  const seamSrc = readFileSync(new URL('src/host/seam.mjs', ROOT), 'utf8')
  assert.match(seamSrc, /ctx\.inject\(list,/, 'host/seam.mjs 是唯一 inject 入口')
})

// ---------------------------------------------------------------- H01：生命周期

test('H01 无 ctx.inject 的宿主/测试桩：立即以根 ctx 直连 attach（局部降级，不阻断）', () => {
  const seen = []
  const lifetime = createHostLifetime({}, {})
  const used = lifetime.inject(['userQuestions'], (subCtx) => seen.push(subCtx))
  assert.equal(used, false, '无可选依赖 API → 回落直连（报告未使用 inject）')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], {}, '根 ctx 直连')
})

test('H01 晚注入：服务晚出现时才 attach；dispose 释放登记且幂等', () => {
  const { ctx, calls } = fakeInjectCtx()
  const seen = []
  let warnCount = 0
  const lifetime = createHostLifetime(ctx, { warn: () => { warnCount += 1 } })
  assert.equal(lifetime.inject(['userQuestions'], (subCtx) => seen.push(subCtx)), true)
  assert.equal(seen.length, 0, 'inject 登记后依赖未就绪 → 尚未 attach')
  assert.equal(calls.length, 1)

  // 依赖晚出现：cordis 触发回调
  const subCtx = { on() {} }
  calls[0].cb(subCtx)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], subCtx)

  lifetime.dispose()
  assert.equal(calls[0].disposed, true, 'dispose 释放登记句柄')
  lifetime.dispose()
  assert.equal(calls[0].disposed, true, 'dispose 幂等')
  // dispose 后依赖事件不再 attach（不复活）
  calls[0].cb({ on() {} })
  assert.equal(seen.length, 1)
  assert.equal(warnCount, 0)
})

test('H01 重建/replacement：子插件重放时旧 listener 退出、只留一个（真实原生桥）', async () => {
  const rootCtx = fakeWaterfallCtx()
  const { ctx, calls } = fakeInjectCtx({ userQuestions: rootCtx.userQuestions })
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  const lifetime = createHostLifetime(ctx, {})
  lifetime.inject(['userQuestions'], (subCtx) => bridge.attach(subCtx))

  // 第一次服务就绪
  calls[0].cb(rootCtx)
  assert.equal(bridge.capabilities().attached, true)
  assert.equal(rootCtx.listeners.length, 1)

  // 服务被重建 → 子插件重放（旧子 fiber 释放后回调再次进入）
  calls[0].cb(rootCtx)
  assert.equal(rootCtx.listeners.length, 2, '重放会新注册一次')
  assert.equal(rootCtx.listeners[0].disposed, true, '旧 listener 必须退出')
  assert.equal(rootCtx.listeners[1].disposed, false, '只保留一个活动 listener')
  assert.equal(bridge.capabilities().attached, true)

  lifetime.dispose()
  bridge.dispose()
  assert.equal(rootCtx.listeners[1].disposed, true, 'dispose 后无遗留监听')
})

test('H01 attach 抛错绝不炸装配（warn 后继续），inject 抛错回落直连', () => {
  const { ctx, calls } = fakeInjectCtx()
  const warnings = []
  const lifetime = createHostLifetime(ctx, { warn: (m) => warnings.push(m) })
  assert.doesNotThrow(() => lifetime.inject(['userQuestions'], () => { throw new Error('attach boom') }, { label: 'q' }))
  calls[0].cb({})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /attach 失败（q）/)

  // ctx.inject 本身抛错 → fail-open 直连根 ctx
  const seen = []
  const throwingCtx = { inject() { throw new Error('inject boom') } }
  const lifetime2 = createHostLifetime(throwingCtx, { warn: (m) => warnings.push(m) })
  assert.equal(lifetime2.inject(['connection'], (subCtx) => seen.push(subCtx)), false)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], throwingCtx)
})

test('H01 服务缺失：原生桥局部降级 unsupported，其他宿主能力读取照常', () => {
  const ctx = { agents: { list() {} }, attachments: { saveImage() {} } }
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().error, 'no_userQuestions')
  assert.equal(bridge.capabilities().attached, false)
  // 缺 questions 不阻断其他 seam 读取（其他通道继续）
  const seam = createHostSeam(ctx)
  assert.ok(seam.agents() !== null)
  assert.ok(seam.attachments() !== null)
  assert.equal(seam.questionFeatures().supported, false)
})

// ---------------------------------------------------------------- H02：timed 等待 / late reply

test('H02 timed 等待结束（本侧未作答）不误取消：0.2 宿主支持迟到答复 → 迟到 GUI 答复仍 win', async () => {
  const ctx = fakeWaterfallCtx({ version: '0.2.0-rc.2' })
  const caller = new AbortController()
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => {
        seenSignal = execContext?.signal ?? null
        // 模拟「有界等待结束、Host 仍 pending」：本侧返回未作答（不是取消）
        return Promise.resolve({ ok: true, answered: false, results: [{ answered: false, reason: 'timed-out' }] })
      },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb

  const downstream = deferred()
  const race = handler({ ...REQUEST, signal: caller.signal }, () => downstream.promise)
  await tick()
  assert.ok(seenSignal !== null)
  assert.equal(caller.signal.aborted, false, '有界等待结束不得取消宿主 caller signal')

  // late reply：宿主问题仍 pending，GUI 稍后作答 → 作答被采用（按宿主 continued/timed 能力处理）
  downstream.resolve({ answers: [{ id: 'q1', selected: ['yes'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['yes'] }] }, '迟到答复仍可结算（不误判为取消）')
})

test('H02 无迟到答复能力的宿主（0.1.7）：不误取消 caller，但本侧有界等待即终态（保守）', async () => {
  const ctx = fakeWaterfallCtx({ version: '0.1.7-rc.2' })
  const caller = new AbortController()
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: async () => ({ ok: true, answered: false, results: [{ answered: false, reason: 'timed-out' }] }),
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  let downstreamSettled = false
  const winner = await handler({ ...REQUEST, signal: caller.signal }, () => {
    downstreamSettled = true
    return new Promise(() => {})
  })
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: [] }] }, '0.1.7 无迟到答复能力 → 未作答即终态')
  assert.equal(caller.signal.aborted, false, '无论能力如何都不得误取消宿主 caller signal')
  assert.equal(downstreamSettled, true)
})

test('H02 有界等待结束但宿主侧无 answerer（下游已 reject）：有界收尾、不悬挂', async () => {
  const ctx = fakeWaterfallCtx({ version: '0.2.0-rc.2' })
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: async () => ({ ok: true, answered: false, results: [{ answered: false, reason: 'timed-out' }] }),
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const winner = await handler(REQUEST, () => Promise.reject(new Error('no answerer')))
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: [] }] }, '下游无 answerer → 回交未作答，绝不悬挂')
})

test('H02 手机侧先答（明确答复）：不 abort caller，也不因迟到能力影响终态', async () => {
  const ctx = fakeWaterfallCtx({ version: '0.2.0-rc.2' })
  const caller = new AbortController()
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => {
        seenSignal = execContext?.signal ?? null
        return Promise.resolve({ ok: true, answered: true, results: [{ answered: true, answers: ['no'] }] })
      },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const winner = await handler({ ...REQUEST, signal: caller.signal }, () => new Promise(() => {}))
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['no'] }] }, '明确答复即终态，不交回下游')
  assert.equal(caller.signal.aborted, false, '宿主 caller signal 不被取消')
  assert.equal(seenSignal.aborted, false, '本侧先答无需本地 abort（无待取消的下游卡片）')
})