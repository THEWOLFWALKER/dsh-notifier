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