import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'

/** 返回一个可编程的 fake questionBridge（只实现本桥使用的三个方法）。 */
function fakeQuestionBridge(overrides = {}) {
  return {
    askQuestions: async () => ({ ok: true, answered: true, results: [] }),
    adminPending: () => [],
    adminSettle: () => ({ ok: true, handled: false }),
    ...overrides,
  }
}

/** 返回一个可编程的 fake ctx.userQuestions（registerProvider 记录 provider 并返回撤销函数）。 */
function fakeUserQuestions(overrides = {}) {
  let provider = null
  let disposeCalls = 0
  return {
    recorded: () => provider,
    disposeCalls: () => disposeCalls,
    registerProvider(p) {
      provider = p
      const registered = provider
      return () => {
        if (provider === registered) provider = null
        disposeCalls += 1
      }
    },
    ask() {},
    ...overrides,
  }
}

test('native questions: capabilities reflect the host seam without attaching', () => {
  const bridge = createNativeQuestionBridge({ ctx: {}, questionBridge: fakeQuestionBridge() })
  assert.deepEqual(bridge.capabilities(), { seam: 'unsupported', mode: 'unsupported', attached: false, error: null })
  const bridge2 = createNativeQuestionBridge({
    ctx: { userQuestions: { ask() {}, registerProvider() {} } },
    questionBridge: fakeQuestionBridge(),
  })
  assert.equal(bridge2.capabilities().seam, 'provider-chain')
  assert.equal(bridge2.capabilities().attached, false)
})

test('native questions: attach registers a provider and dispose unregisters it', () => {
  const service = fakeUserQuestions()
  const bridge = createNativeQuestionBridge({ ctx: { userQuestions: service }, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), true)
  assert.equal(bridge.capabilities().attached, true)
  assert.equal(bridge.capabilities().mode, 'provider-chain')
  const provider = service.recorded()
  assert.ok(provider !== null)
  assert.equal(typeof provider.ask, 'function')
  bridge.dispose()
  assert.equal(service.recorded(), null)
  assert.equal(service.disposeCalls(), 1)
  assert.deepEqual(bridge.capabilities(), { seam: 'provider-chain', mode: 'unsupported', attached: false, error: null })
})

test('native questions: duplicate provider degrades to unsupported and records the error', () => {
  const service = {
    registerProvider() { const error = new Error('dup'); error.code = 'DUPLICATE_PROVIDER'; throw error },
    ask() {},
  }
  const bridge = createNativeQuestionBridge({ ctx: { userQuestions: service }, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().attached, false)
  assert.equal(bridge.capabilities().mode, 'unsupported')
  assert.equal(bridge.capabilities().error, 'DUPLICATE_PROVIDER')
})

test('native questions: successful re-attach clears the stale error of the failed attempt', () => {
  // 重放场景：首次 attach 失败（seam 抛错）记录错误码；服务重建后重放成功——
  // 两条成功路径（provider / waterfall）都必须清掉旧失败码，capabilities 不残留。
  const failing = {
    registerProvider() { const error = new Error('occupied'); error.code = 'DUPLICATE_PROVIDER'; throw error },
    ask() {},
  }
  const ctx = { userQuestions: failing }
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().error, 'DUPLICATE_PROVIDER')
  // 服务重建：registerProvider 恢复可用 → provider 路径成功
  ctx.userQuestions = fakeUserQuestions()
  assert.equal(bridge.attach(), true)
  assert.equal(bridge.capabilities().attached, true)
  assert.equal(bridge.capabilities().error, null, 'provider 路径成功后清空旧失败码')
  // 服务再次重建为 ask-only → waterfall 路径成功，同样不得残留
  ctx.userQuestions = { ask() {} }
  ctx.on = () => () => {}
  assert.equal(bridge.attach(), true)
  const caps = bridge.capabilities()
  assert.equal(caps.attached, true)
  assert.equal(caps.mode, 'waterfall')
  assert.equal(caps.error, null, 'waterfall 路径成功后清空旧失败码')
})

test('native questions: missing seam degrades without throwing', () => {
  const bridge = createNativeQuestionBridge({ ctx: {}, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().error, 'no_userQuestions')
  const bridge2 = createNativeQuestionBridge({ ctx: { userQuestions: { ask() {} } }, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge2.attach(), false)
  assert.equal(bridge2.capabilities().error, 'no_register_provider')
})

test('native questions: hostAsk bridges a batch into aq semantics and maps option answers back', async () => {
  const service = fakeUserQuestions()
  const seenPayloads = []
  const bridge = createNativeQuestionBridge({
    ctx: { userQuestions: service },
    questionBridge: fakeQuestionBridge({
      askQuestions: async (payload) => {
        seenPayloads.push(payload)
        return {
          ok: true,
          answered: true,
          results: [
            { question: 'q1', answered: true, answers: ['是'], via: 'telegram:button' },
            { question: 'q2', answered: true, answers: ['乙', '丙'], via: 'feishu:button' },
          ],
        }
      },
    }),
  })
  bridge.attach()
  const provider = service.recorded()
  const answer = await provider.ask({
    questions: [
      { id: 'a', question: '继续吗', options: [{ label: '是', description: 'go' }, { label: '否' }] },
      { id: 'b', question: '选哪些', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }], multiSelect: true },
    ],
  })
  assert.deepEqual(answer, { answers: [{ id: 'a', selected: ['是'] }, { id: 'b', selected: ['乙', '丙'] }] })
  assert.equal(seenPayloads.length, 1)
  assert.deepEqual(seenPayloads[0].questions.map((q) => q.options.map((o) => o.label)), [['是', '否'], ['甲', '乙', '丙']])
})

test('native questions: hostAsk maps unanswered and custom text answers', async () => {
  const service = fakeUserQuestions()
  const bridge = createNativeQuestionBridge({
    ctx: { userQuestions: service },
    questionBridge: fakeQuestionBridge({
      askQuestions: async () => ({
        ok: true,
        answered: false,
        results: [
          { question: 'q1', answered: false, reason: 'timeout' },
          { question: 'q2', answered: true, answers: ['我想自定义'], via: 'telegram:text' },
        ],
      }),
    }),
  })
  bridge.attach()
  const answer = await service.recorded().ask({
    questions: [
      { id: 'a', question: '超时问题', options: [{ label: '是' }] },
      { id: 'b', question: '自定义', options: [{ label: '默认' }] },
    ],
  })
  assert.deepEqual(answer, { answers: [{ id: 'a', selected: [] }, { id: 'b', selected: [], custom: '我想自定义' }] })
})

test('native questions: hostAsk never swallows the host even when the bridge throws', async () => {
  const service = fakeUserQuestions()
  const bridge = createNativeQuestionBridge({
    ctx: { userQuestions: service },
    questionBridge: fakeQuestionBridge({
      askQuestions: async () => { throw new Error('boom') },
    }),
  })
  bridge.attach()
  const answer = await service.recorded().ask({ questions: [{ id: 'a', question: 'q', options: [{ label: 'x' }] }] })
  assert.deepEqual(answer, { answers: [{ id: 'a', selected: [] }] })
})

test('native questions: pending and settle delegate to questionBridge', () => {
  const bridge = createNativeQuestionBridge({
    ctx: {},
    questionBridge: fakeQuestionBridge({
      adminPending: () => [{ ref: 'r1', question: 'q' }],
      adminSettle: (input) => ({ ok: true, handled: false, echo: input }),
    }),
  })
  assert.deepEqual(bridge.pending(), [{ ref: 'r1', question: 'q', source: 'native' }])
  const settled = bridge.settle({ ref: 'r1', action: 'choose', options: [0] })
  assert.equal(settled.ok, true)
  assert.equal(settled.echo.ref, 'r1')
})

test('native questions: pending/settle fail closed when bridge methods are missing', () => {
  const bridge = createNativeQuestionBridge({ ctx: {}, questionBridge: {} })
  assert.deepEqual(bridge.pending(), [])
  assert.deepEqual(bridge.settle({}), { ok: false, handled: false, reason: 'no_settle', message: '原生桥未装配结算入口' })
})
// ---------- #27 / waterfall 拦截器契约 ----------

/** 可编程 fake ctx：userQuestions 只有 ask()（dsh 0.1.5-rc.x 真实形态）+ ctx.on 记录器。 */
function fakeWaterfallCtx() {
  const listeners = []
  return {
    userQuestions: { ask() {} },
    on(name, cb, opts) {
      listeners.push({ name, cb, opts, disposed: false })
      const entry = listeners[listeners.length - 1]
      return () => { entry.disposed = true }
    },
    listeners,
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const REQUEST = {
  questions: [{ id: 'q1', question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }],
}

test('native questions: #27 safe read — throwing proxy ctx no longer aborts probing', () => {
  const proxyCtx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'userQuestions') throw new Error('cannot get property "userQuestions" without inject')
      return target[prop]
    },
  })
  const bridge = createNativeQuestionBridge({ ctx: proxyCtx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().error, 'no_userQuestions')
  assert.equal(bridge.capabilities().seam, 'unsupported')
})

test('native questions: waterfall attach when only ask() exists, dispose unregisters', () => {
  const ctx = fakeWaterfallCtx()
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(), true)
  const caps = bridge.capabilities()
  assert.equal(caps.seam, 'native-event')
  assert.equal(caps.mode, 'waterfall')
  assert.equal(caps.attached, true)
  assert.equal(ctx.listeners.length, 1)
  assert.equal(ctx.listeners[0].name, 'user-questions/request')
  assert.deepEqual(ctx.listeners[0].opts, { prepend: true, global: true })
  bridge.dispose()
  assert.equal(ctx.listeners[0].disposed, true)
  assert.equal(bridge.capabilities().attached, false)
})

test('native questions: waterfall interceptor — telegram wins, downstream loser never rejects unhandled', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: () => ask.promise,
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler(REQUEST, () => downstream.promise)
  ask.resolve({ ok: true, answered: true, results: [{ answered: true, answers: ['yes'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['yes'] }] })
  // 输家卫生：下游之后才 reject，必须被吞掉（node:test 会把未处理拒绝判为失败）
  downstream.reject(new Error('ASK_ABORTED'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('native questions: waterfall interceptor — GUI wins, interception signal aborts (no late cards)', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  const settles = []
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => { seenSignal = execContext?.signal ?? null; return ask.promise },
      adminSettle: (input) => { settles.push(input); return { ok: true } },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler(REQUEST, () => downstream.promise)
  downstream.resolve({ answers: [{ id: 'q1', selected: ['no'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['no'] }] })
  // 收尾机制 = askQuestions 侧的取消信号（清延迟推卡/停升级/终结账本行/后续问题不开）
  assert.ok(seenSignal !== null && typeof seenSignal.aborted === 'boolean', 'execContext.signal passed to askQuestions')
  assert.equal(seenSignal.aborted, true, 'interception signal aborted after downstream win')
  assert.equal(settles.length, 0, 'no adminSettle sweep — termination lives in askQuestions')
})

test('native questions: canDeliver false passes through to next() without interception', async () => {
  const ctx = fakeWaterfallCtx()
  let asked = false
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({ askQuestions: async () => { asked = true; return {} } }),
    canDeliver: () => false,
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const result = await handler(REQUEST, () => Promise.resolve({ answers: [{ id: 'q1', selected: ['no'] }] }))
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['no'] }] })
  assert.equal(asked, false)
})

test('native questions: empty questions pass through to next()', async () => {
  const ctx = fakeWaterfallCtx()
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  let nextCalls = 0
  const result = await handler({ questions: [] }, () => { nextCalls += 1; return Promise.resolve({ answers: [] }) })
  assert.deepEqual(result, { answers: [] })
  assert.equal(nextCalls, 1)
})

// ---------- waterfall 拦截器契约（race 韧性 / 清扫闸 / 子上下文生命周期） ----------

test('waterfall: downstream rejects FIRST (headless NO_PROVIDER) — race still resolves via telegram answer', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({ askQuestions: () => ask.promise }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  let nextCalls = 0
  const race = handler(REQUEST, () => {
    nextCalls += 1
    return Promise.reject(new Error('no user-questions answerer accepted the request'))
  })
  // 下游立刻拒绝；race 不许跟着死——等手机面答案兜底
  await new Promise((resolve) => setImmediate(resolve))
  ask.resolve({ ok: true, answered: true, results: [{ answered: true, answers: ['yes'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['yes'] }] })
  assert.equal(nextCalls, 1)
})

test('waterfall: GUI win aborts the signal exactly once and never settles other surfaces rows', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  let abortCount = 0
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => {
        execContext?.signal?.addEventListener?.('abort', () => { abortCount += 1 })
        return ask.promise
      },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler(REQUEST, () => downstream.promise)
  downstream.resolve({ answers: [{ id: 'q1', selected: [] }] })
  await race
  assert.equal(abortCount, 1, 'abort fired exactly once')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(abortCount, 1, 'abort stays once (idempotent settle)')
})

test('waterfall: attach(subCtx) registers the listener on the dependency sub-context', () => {
  const rootCtx = fakeWaterfallCtx()
  const subCtx = fakeWaterfallCtx()
  subCtx.userQuestions = rootCtx.userQuestions
  const bridge = createNativeQuestionBridge({ ctx: rootCtx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.attach(subCtx), true)
  assert.equal(rootCtx.listeners.length, 0, 'root ctx must stay untouched')
  assert.equal(subCtx.listeners.length, 1)
  assert.equal(subCtx.listeners[0].name, 'user-questions/request')
  assert.deepEqual(subCtx.listeners[0].opts, { prepend: true, global: true })
  // 服务重建重放：旧句柄作废再重挂（不重复堆积）
  const subCtx2 = fakeWaterfallCtx()
  subCtx2.userQuestions = rootCtx.userQuestions
  assert.equal(bridge.attach(subCtx2), true)
  assert.equal(subCtx.listeners[0].disposed, true, 'stale handle disposed before re-register')
  assert.equal(subCtx2.listeners.length, 1)
})
