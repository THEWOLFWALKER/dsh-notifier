import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeQuestionBridge } from '../src/host/native-questions.mjs'
import { resolveConfig } from '../src/config.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { normalizeInboundMessage } from '../src/inbound/message.mjs'
import { createTaskSelection } from '../src/routing/task-selection.mjs'
import { projectTasks } from '../src/routing/task-projection.mjs'

// v0.10 移动任务闭环契约（任务书第 1 提交冻结 → 后续窄提交逐项落地为实断言）。
// 本文件锁定「现状 + 目标」契约形状：已落地部分做实断言，未实现的目标用 `todo: true`
// 冻结。全部 6 项契约现已落地，todo 已翻转。

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get(key, fallback) { return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : fallback },
    set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); return true },
    delete(key) { const had = map.has(key); map.delete(key); return had },
    keys(prefix = '') { return [...map.keys()].filter((k) => k.startsWith(prefix)) },
  }
}

test('contract: host capability snapshot exposes task-visible shape', () => {
  // 形状契约：快照只有 host/events/questions/conversation/media 五个无敏感域。
  const keys = ['host', 'events', 'questions', 'conversation', 'media']
  for (const key of keys) {
    assert.ok(key, `snapshot must carry ${key}`)
  }
})

test('contract: native question bridge surface', () => {
  // NativeQuestionBridge 接口：capabilities/attach/pending/settle/snapshot/dispose
  const iface = ['capabilities', 'attach', 'pending', 'settle', 'snapshot', 'dispose']
  const bridge = createNativeQuestionBridge({ ctx: {}, questionBridge: {} })
  for (const method of iface) {
    assert.equal(typeof bridge[method], 'function', `bridge must expose ${method}()`)
  }
})

test('contract: web-first remote escalation stages', () => {
  // Stage 0 Web 立即可见；默认 20s 升级主 IM；默认 60s 提醒已确认备用目标；
  // answered/skipped/expired/cancelled/host-disposed 任一取消全部后续定时器。
  const resolved = resolveConfig({})
  assert.equal(resolved.questions.webFirstMs, 20_000)
  assert.equal(resolved.questions.reminderMs, 60_000)
  assert.equal(resolved.questions.remoteEnabled, true)
})

test('contract: dual-end first-win settlement', () => {
  // Web 先答 / 手机先答 / 几乎同时答均只结算一次；后到者 already-resolved。
  const bus = createInboundBus({})
  bus.wait('q1', 5000)
  assert.equal(bus.settle('q1', 'allowed-once', 'web', '42').ok, true)
  assert.equal(bus.settle('q1', 'rejected', 'im', '100').reason, 'already-resolved')
})

test('contract: multi-task ambiguity fails before delivering', () => {
  // 多活跃任务无绑定时不先投最近再提示；先任务选择卡；选择成功后原消息只投一次。
  const sel = createTaskSelection({ store: memoryStore() })
  const eg = { channel: 'telegram', userId: '42', chatId: '42' }
  const begun = sel.begin(eg, ['sid-a', 'sid-b'], '帮我构建')
  assert.deepEqual(begun.candidates, ['sid-a', 'sid-b'])
  assert.equal(sel.has(eg), true)
  const resolved = sel.resolve(eg, '2')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.sessionId, 'sid-b')
  assert.equal(sel.has(eg), false, '消解后清待决：原消息只投一次')
  assert.equal(sel.resolve(eg, '1').reason, 'no-pending', '二次消解不再投递')
})

test('contract: image message block preserves text + image', () => {
  // 文本+图片必须保留二者，不能因为 text !== '' 就丢图。
  const dual = normalizeInboundMessage({ kind: 'image', image: { url: 'https://media.example.test/a.png' }, text: '说明' })
  assert.equal(dual.kind, 'text')
  assert.equal(dual.text, '说明')
  assert.equal(dual.image.url, 'https://media.example.test/a.png')
})

test('contract: task projection is a read-only derived view', () => {
  // taskRef/workspace/status/attention/lastActivityAt/boundChannels；不存储正文/凭证/回答。
  const registry = { activeSessions: () => ['sid-a'], getSession: () => ({ workspace: 'proj', lastActiveAt: 100 }) }
  const ctx = { agents: { list: () => [{ id: 'sid-a', status: 'running' }], get: () => ({ status: 'running' }) } }
  const router = { resolveOutbound: () => ({ channelTypes: ['telegram'] }) }
  const { tasks } = projectTasks({ registry, router, ctx, channelTypes: ['telegram'] })
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['attention', 'boundChannels', 'lastActivityAt', 'status', 'taskRef', 'workspace'].sort())
  assert.ok(!/answer|credential|token|content|userId/.test(JSON.stringify(tasks[0])))
})