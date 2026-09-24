// v0.11 Commit13 — Issue #38 host-compat regression.
// Locks the two #38 technical contracts:
//  1. producer-owned source: outbound-to-session messages carry source.kind
//     'dsh-notifier' (never the removed catch-all 'plugin'), form 'notice' with a
//     bounded summary, and never an `image_url` block (V4 UserMessage).
//  2. userQuestions proxy read: the defensive `ctx.get(name, false)` path must
//     detect the service WITHOUT ever touching a throwing `ctx.userQuestions`
//     getter (cordis 4.0.2 `cannot get property … without inject`).
// Runtime truth: src/host/messages.mjs + src/host/native-questions.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRemoteUserMessage,
  CONTEXT_SUMMARY_MAX_CHARS,
} from '../src/host/messages.mjs'
import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { createAgentRouter } from '../src/routing/agent-router.mjs'
import { createSessionRegistry } from '../src/routing/session-registry.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FLUSH_MS = 60
const SID = 'aaaaaaaa-0038-4aaa-8bbb-cccccccccccc'

// ---------- producer-owned source contract (unit) ----------

test('issue38: text-only message is producer-owned notice with a bounded summary', () => {
  const msg = buildRemoteUserMessage({ text: 'hello' })
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'dsh-notifier')
  assert.equal(msg.source.form, 'notice')
  assert.equal(Object.prototype.hasOwnProperty.call(msg.source, 'plugin'), false, 'catch-all plugin kind is removed')
  assert.equal(msg.source.summary, 'hello')
  assert.deepEqual(msg.content, [{ type: 'text', text: 'hello' }])
})

test('issue38: summary is truncated to the host CONTEXT_SUMMARY_MAX_CHARS bound', () => {
  const msg = buildRemoteUserMessage({ text: 'x'.repeat(CONTEXT_SUMMARY_MAX_CHARS + 40) })
  assert.equal(msg.source.summary.length, CONTEXT_SUMMARY_MAX_CHARS)
  // The full text still reaches the model in the content block.
  assert.equal(msg.content[0].text.length, CONTEXT_SUMMARY_MAX_CHARS + 40)
})

test('issue38: file-only message uses a fallback summary and never an image_url block', () => {
  const msg = buildRemoteUserMessage({ text: '', blocks: [{ type: 'file', attachment: { attachmentId: 'f1' } }] })
  assert.equal(msg.source.summary, '(附件消息)')
  assert.deepEqual(msg.content, [{ type: 'file', attachment: { attachmentId: 'f1' } }])
  assert.ok(msg.content.every((block) => block.type !== 'image_url'))
})

// ---------- producer-owned source contract (end-to-end through conversation) ----------

function makeAgent(id = SID, status = 'idle') {
  const calls = { followup: [], inject: [], steer: [], cancel: [] }
  return {
    id, status, header: { cwd: '/home/u/proj/alpha' }, calls,
    followup: (msg) => calls.followup.push(msg),
    inject: (msg) => calls.inject.push(msg),
    steer: (msg) => calls.steer.push(msg),
    cancel: (cause) => calls.cancel.push(cause),
  }
}

function makeRig({ agents = [] } = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'dsh-notifier-38-')), 'state.json'))
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const handlers = {}
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const ctx = {
    agents: { get: (id) => agentMap.get(id), list: () => [...agentMap.values()] },
    on: (event, handler) => {
      ;(handlers[event] ??= []).push(handler)
      return () => { handlers[event] = handlers[event].filter((h) => h !== handler) }
    },
  }
  const router = createAgentRouter({ store, agentsList: () => ctx.agents.list() })
  const registry = createSessionRegistry({ ctx, store, now: () => Date.now(), touchWriteMs: 0, sweepEveryMs: 0 })
  const dispose = registerConversationRouter({
    ctx, bus, store,
    reply: () => {},
    config: { mergeWindowMs: FLUSH_MS },
    logger: null,
    router, registry,
    channelTypes: () => ['telegram'],
  })
  const flush = async ({ userId = '42', chatId = userId, text = '' }) => {
    bus.accept({ channel: 'telegram', userId, chatId, messageId: `m${Math.random()}`, text })
    await sleep(FLUSH_MS + 10)
  }
  const fire = (event, payload) => (handlers[event] ?? []).forEach((h) => h(payload))
  return { store, dispose, flush, fire }
}

test('issue38: a text-only Telegram envelope reaches the Agent as a producer-owned V4 message', async () => {
  const agent = makeAgent()
  const rig = makeRig({ agents: [agent] })
  rig.fire('agent/created', agent)

  await rig.flush({ text: 'hi there' })
  assert.equal(agent.calls.followup.length, 1)
  const msg = agent.calls.followup[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'dsh-notifier')
  assert.equal(msg.source.form, 'notice')
  assert.equal(Object.prototype.hasOwnProperty.call(msg.source, 'plugin'), false)
  assert.ok(msg.source.summary.length <= CONTEXT_SUMMARY_MAX_CHARS)
  assert.deepEqual(msg.content, [{ type: 'text', text: 'hi there' }])
  assert.ok(msg.content.every((block) => block.type !== 'image_url'), 'V4 removes image_url blocks')
  rig.dispose()
})

// ---------- userQuestions proxy read regression ----------

function fakeQuestionBridge() {
  return {
    askQuestions: async () => ({ ok: true, answered: true, results: [] }),
    adminPending: () => [],
    adminSettle: () => ({ ok: true, handled: false }),
  }
}

test('issue38: ctx.get service read detects userQuestions without touching a throwing getter', () => {
  const service = { ask() {} }
  const listeners = []
  const ctx = {
    get(name, required) {
      assert.equal(name, 'userQuestions')
      assert.equal(required, false, 'must use the non-throwing optional read')
      return service
    },
    on(name, cb, opts) { listeners.push({ name, cb, opts }); return () => {} },
  }
  let getterReads = 0
  Object.defineProperty(ctx, 'userQuestions', {
    get() {
      getterReads += 1
      throw new Error('cannot get property "userQuestions" without inject')
    },
    configurable: true,
  })

  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  assert.equal(bridge.capabilities().seam, 'native-event')
  assert.equal(bridge.attach(), true)
  assert.equal(bridge.capabilities().mode, 'waterfall')
  assert.equal(getterReads, 0, 'the throwing getter must never be read')
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'user-questions/request')
  assert.deepEqual(listeners[0].opts, { prepend: true, global: true })
  bridge.dispose()
})

test('issue38: a proxy that only throws on userQuestions degrades without throwing', () => {
  const ctx = new Proxy({ on: () => () => {} }, {
    get(target, prop) {
      if (prop === 'userQuestions') throw new Error('cannot get property "userQuestions" without inject')
      return target[prop]
    },
  })
  const bridge = createNativeQuestionBridge({ ctx, questionBridge: fakeQuestionBridge() })
  assert.doesNotThrow(() => bridge.capabilities())
  assert.equal(bridge.attach(), false)
  assert.equal(bridge.capabilities().seam, 'unsupported')
  assert.equal(bridge.capabilities().error, 'no_userQuestions')
})