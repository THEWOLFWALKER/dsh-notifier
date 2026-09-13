import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHostCapabilitySnapshot,
  detectEventsMode,
  detectHostVersion,
  detectQuestionsMode,
  detectConversationMode,
  receivedEventsView,
  MAX_RECEIVED_EVENT_KEYS,
} from '../src/host/capability.mjs'

test('host capability: events mode covers current/root/dual/unsupported', () => {
  assert.equal(detectEventsMode({}), 'unsupported')
  assert.equal(detectEventsMode({ on() {} }), 'current')
  const root = { on() {} }; root.root = root
  assert.equal(detectEventsMode({ root }), 'root')
  assert.equal(detectEventsMode({ on() {}, root }), 'dual')
  // 非 cordis root 形状不是 root 上下文
  assert.equal(detectEventsMode({ on() {}, root: { on() {} } }), 'current')
})

test('host capability: questions mode is feature-detected from ctx.userQuestions', () => {
  assert.equal(detectQuestionsMode({}), 'unsupported')
  assert.equal(detectQuestionsMode({ userQuestions: { ask() {} } }), 'native-event')
  assert.equal(detectQuestionsMode({ userQuestions: { ask() {}, registerProvider() {} } }), 'provider-chain')
  // 非函数 ask 不算公开 seam
  assert.equal(detectQuestionsMode({ userQuestions: { ask: 'x', registerProvider() {} } }), 'unsupported')
})

test('host capability: conversation mode is conservative (never false-available)', () => {
  assert.deepEqual(detectConversationMode({}), { followup: 'unknown', inject: 'unknown', steer: 'unknown' })
  assert.deepEqual(detectConversationMode({ agents: { list() {} } }), { followup: 'available', inject: 'available', steer: 'available' })
  assert.deepEqual(detectConversationMode({ agents: {} }), { followup: 'unknown', inject: 'unknown', steer: 'unknown' })
})

test('host capability: host version detection does not throw', () => {
  assert.equal(detectHostVersion({}), 'unknown')
  assert.equal(detectHostVersion({ version: '0.1.0' }), '0.1.0')
  assert.equal(detectHostVersion({ config: { version: '0.1.0-rc.6' } }), '0.1.0-rc.6')
  assert.equal(detectHostVersion({ hostVersion: '' }), 'unknown')
})

test('host capability: received events view is bounded and keeps only counts/lastAt', () => {
  assert.deepEqual(receivedEventsView({ events: { 'session/event': { received: 2, lastAt: 111 } } }), {
    'session/event': { received: 2, lastAt: 111 },
  })
  // received <= 0 不携带 lastAt
  assert.deepEqual(receivedEventsView({ events: { 'agent/created': { received: 0 } } }), {
    'agent/created': { received: 0 },
  })
  // 无 events 字段时回落把整个对象当来源
  assert.deepEqual(receivedEventsView({ 'turn/end': { received: 1, lastAt: 5 } }), {
    'turn/end': { received: 1, lastAt: 5 },
  })
})

test('host capability: received events view caps the number of keys', () => {
  const events = {}
  for (let i = 0; i < MAX_RECEIVED_EVENT_KEYS + 10; i += 1) {
    events[`event:${i}`] = { received: 1, lastAt: i }
  }
  const view = receivedEventsView({ events })
  assert.equal(Object.keys(view).length, MAX_RECEIVED_EVENT_KEYS)
})

test('host capability: snapshot is sensitive-field-free and normalizes enums', () => {
  const snapshot = createHostCapabilitySnapshot({
    ctx: { version: '0.1.0-rc.6', on() {} },
    events: { events: { 'session/event': { received: 3, lastAt: 7 } } },
    questionsFallbackEnabled: true,
    webLocal: 'bogus',
    imageInput: 'available',
  })
  assert.deepEqual(snapshot.host, { version: '0.1.0-rc.6' })
  assert.equal(snapshot.events.mode, 'current')
  assert.deepEqual(snapshot.events.received, { 'session/event': { received: 3, lastAt: 7 } })
  assert.equal(snapshot.questions.mode, 'plugin-tool-fallback') // unsupported seam + fallback
  assert.equal(snapshot.questions.webLocal, 'unknown') // bogus 归一
  assert.equal(snapshot.media.imageInput, 'available')
  const serialized = JSON.stringify(snapshot)
  assert.ok(!/sessionId|token|secret|credential|chatId|userId/.test(serialized))
})

test('host capability: provider-chain seam wins over fallback in the snapshot', () => {
  const snapshot = createHostCapabilitySnapshot({
    ctx: { userQuestions: { ask() {}, registerProvider() {} } },
    questionsFallbackEnabled: true,
    webLocal: 'available',
  })
  assert.equal(snapshot.questions.mode, 'provider-chain')
  assert.equal(snapshot.questions.webLocal, 'available')
})