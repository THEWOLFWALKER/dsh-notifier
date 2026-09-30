// v0.14（Stage D）宿主原生提问生命周期回归：caller signal 与 GUI-race signal 合并。
//
// 锁定 01-findings 的 P1-08：waterfall 拦截器曾用自建 AbortController **替换**掉宿主
// `request.signal`——caller abort 后手机侧 ask 仍在等待、可能继续开延迟卡片。修复后两路
// signal 合并（AbortSignal.any），caller abort / GUI win / downstream reject / dispose
// 各自独立可测，且不遗留迟到卡片或悬挂 waiter。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'

function fakeQuestionBridge(overrides = {}) {
  return {
    askQuestions: async () => ({ ok: true, answered: true, results: [] }),
    adminPending: () => [],
    adminSettle: () => ({ ok: true, handled: false }),
    ...overrides,
  }
}

/** userQuestions 只有 ask()（DSH rc.1 真实形态）+ ctx.on 记录器。 */
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

const tick = () => new Promise((resolve) => setImmediate(resolve))
const REQUEST = { questions: [{ id: 'q1', question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] }

test('D1 caller abort propagates to the phone-side signal and the race still settles', async () => {
  const ctx = fakeWaterfallCtx()
  const caller = new AbortController()
  const ask = deferred()
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => { seenSignal = execContext?.signal ?? null; return ask.promise },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler({ ...REQUEST, signal: caller.signal }, () => downstream.promise)
  await tick()
  assert.ok(seenSignal !== null, 'execContext.signal passed to askQuestions')
  assert.equal(seenSignal.aborted, false, 'not aborted before caller abort')

  caller.abort()
  assert.equal(seenSignal.aborted, true, 'caller abort must reach the phone-side ask (no late card)')

  // 手机侧随后返回未作答（宿主已取消）——race 必须收尾，不悬挂 waiter。
  ask.resolve({ ok: true, answered: false, results: [{ answered: false, reason: 'aborted' }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: [] }] })
})

test('D2 GUI win aborts the local race signal exactly once and never touches the caller signal', async () => {
  const ctx = fakeWaterfallCtx()
  const caller = new AbortController()
  const ask = deferred()
  let abortCount = 0
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => {
        seenSignal = execContext?.signal ?? null
        seenSignal?.addEventListener?.('abort', () => { abortCount += 1 })
        return ask.promise
      },
    }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler({ ...REQUEST, signal: caller.signal }, () => downstream.promise)
  await tick()
  downstream.resolve({ answers: [{ id: 'q1', selected: ['no'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['no'] }] })
  assert.equal(abortCount, 1, 'local race abort fired exactly once')
  assert.equal(caller.signal.aborted, false, 'GUI win must not cancel the caller signal')
  await tick()
  assert.equal(abortCount, 1, 'abort stays once (idempotent settle)')
})

test('D3 downstream reject first (headless NO_PROVIDER) — phone fallback still completes', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({ askQuestions: () => ask.promise }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const race = handler(REQUEST, () => Promise.reject(new Error('no user-questions answerer accepted the request')))
  await tick()
  ask.resolve({ ok: true, answered: true, results: [{ answered: true, answers: ['yes'] }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: ['yes'] }] })
})

test('D4 dispose mid-flight unregisters the listener and leaves no orphan waiter', async () => {
  const ctx = fakeWaterfallCtx()
  const ask = deferred()
  const bridge = createNativeQuestionBridge({
    ctx,
    questionBridge: fakeQuestionBridge({ askQuestions: () => ask.promise }),
  })
  bridge.attach()
  const handler = ctx.listeners[0].cb
  const downstream = deferred()
  const race = handler(REQUEST, () => downstream.promise)
  await tick()

  bridge.dispose()
  assert.equal(ctx.listeners[0].disposed, true, 'waterfall listener unregistered on dispose')
  assert.equal(bridge.capabilities().attached, false)

  // 进行中的 race 仍要收尾（无悬挂 waiter）；下游迟到 rejection 被吞掉。
  downstream.reject(new Error('late GUI rejection after dispose'))
  ask.resolve({ ok: true, answered: false, results: [{ answered: false }] })
  const winner = await race
  assert.deepEqual(winner, { answers: [{ id: 'q1', selected: [] }] })
  await tick()
})

test('D5 provider path forwards the caller signal to askQuestions', async () => {
  const service = {
    registerProvider(provider) { this.provider = provider; return () => { this.provider = null } },
    ask() {},
  }
  const caller = new AbortController()
  let seenSignal = null
  const bridge = createNativeQuestionBridge({
    ctx: { userQuestions: service },
    questionBridge: fakeQuestionBridge({
      askQuestions: (_payload, execContext) => { seenSignal = execContext?.signal ?? null; return { ok: true, answered: false, results: [] } },
    }),
  })
  bridge.attach()
  await service.provider.ask({ ...REQUEST, signal: caller.signal })
  assert.equal(seenSignal, caller.signal, 'provider.ask must pass the host caller signal through')
})