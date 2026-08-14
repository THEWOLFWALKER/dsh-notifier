import test from 'node:test'
import assert from 'node:assert/strict'
import {
  intentOfSessionEvent,
  intentOfAgentError,
  intentToMessage,
  lastAssistantText,
  workspaceNameOf,
  createDedupLedger,
  createTrailingDebounce,
  createEventListener,
} from '../src/event-listener.mjs'

test('intentOfSessionEvent: turn/end completed/error', () => {
  const ok = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(ok.headline, '✅ 任务完成')
  assert.equal(ok.level, 'active')
  const err = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.equal(err.headline, '❌ 任务出错')
  assert.equal(err.detail, 'boom')
})

test('intentOfSessionEvent: 未知 reason.kind 与未知事件保持沉默', () => {
  assert.equal(intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'weird' } } }), undefined)
  assert.equal(intentOfSessionEvent({ type: 'assistant/message', data: {} }), undefined)
  assert.equal(intentOfSessionEvent(null), undefined)
})

test('intentOfSessionEvent: approval/asked 含工具名与原因', () => {
  const intent = intentOfSessionEvent({ type: 'approval/asked', data: { toolName: 'email_send', reason: '给 x@y.z 发邮件' } })
  assert.equal(intent.headline, '🔐 需要你批准')
  assert.equal(intent.detail, '工具 email_send 需要授权：给 x@y.z 发邮件')
  const bare = intentOfSessionEvent({ type: 'approval/asked', data: {} })
  assert.equal(bare.detail, '一个操作 需要授权')
})

test('intentOfAgentError: Error 实例/字符串/对象', () => {
  assert.equal(intentOfAgentError({ error: new Error('kaboom') }).detail, 'kaboom')
  assert.equal(intentOfAgentError({ error: 'str err' }).detail, 'str err')
  assert.equal(intentOfAgentError({ error: { message: 'obj err' } }).detail, 'obj err')
  assert.equal(intentOfAgentError({}).detail, 'agent 执行出错')
})

test('intentToMessage: 标题前缀 + 正文截断', () => {
  const msg = intentToMessage({ headline: '✅ 任务完成', detail: 'abcd', level: 'active' }, { config: { titlePrefix: '[dsh]', summaryMaxChars: 2 } })
  assert.equal(msg.title, '[dsh] ✅ 任务完成')
  assert.equal(msg.content, 'ab…')
  assert.equal(msg.level, 'active')
  const short = intentToMessage({ headline: 'h', detail: 'ok' }, { config: { titlePrefix: '', summaryMaxChars: 100 } })
  assert.equal(short.content, 'ok')
})

test('lastAssistantText 取最后一条 assistant/message 文本块', () => {
  const session = {
    events: [
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: ' first ' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second' }, { type: 'text', text: ' third' }] } } },
    ],
  }
  assert.equal(lastAssistantText(session), 'second\n third')
  assert.equal(lastAssistantText({ events: [] }), '')
  assert.equal(lastAssistantText(null), '')
})

test('workspaceNameOf 取 cwd 末段，缺省回退 session id', () => {
  assert.equal(workspaceNameOf({ id: 's1', header: { cwd: '/tmp/dsh-notifier' } }), 'dsh-notifier')
  assert.equal(workspaceNameOf({ id: 's1', header: {} }), 's1')
  assert.equal(workspaceNameOf({ id: 's1' }), 's1')
})

test('createDedupLedger: 24h 窗口内同一 key 只放行一次，超量淘汰最旧', () => {
  const ledger = createDedupLedger(3)
  assert.equal(ledger.test('a'), true)
  assert.equal(ledger.test('a'), false)
  assert.equal(ledger.test('b'), true)
  assert.equal(ledger.test('c'), true)
  assert.equal(ledger.test('d'), true) // 淘汰最旧 a
  assert.equal(ledger.test('a'), true) // 被淘汰后重新放行
  assert.equal(ledger.size(), 3)
})

test('createTrailingDebounce: 窗口内连续触发只推最后一次', async () => {
  const debounce = createTrailingDebounce(30)
  const calls = []
  debounce.schedule('s', () => calls.push(1))
  debounce.schedule('s', () => calls.push(2))
  debounce.schedule('s', () => calls.push(3))
  assert.equal(debounce.pendingCount(), 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(calls, [3])
  assert.equal(debounce.pendingCount(), 0)
  debounce.dispose()
})

test('createTrailingDebounce: 不同 key 互不影响', async () => {
  const debounce = createTrailingDebounce(20)
  const calls = []
  debounce.schedule('a', () => calls.push('a'))
  debounce.schedule('b', () => calls.push('b'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(calls.sort(), ['a', 'b'])
  debounce.dispose()
})

function fakeCtx(listeners = {}) {
  const ctx = {
    logger: { warn() {} },
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {}
    },
  }
  return { ctx, listeners }
}

function makeSession(id = 's1', events = []) {
  return { id, header: { cwd: '/tmp/ws' }, events }
}

test('createEventListener: turn/end 走防抖，approval/asked 即时，两者都进 notifyAll', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)

  const session = makeSession('s1')
  const eventTurn = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }
  const eventApproval = { type: 'approval/asked', seq: 2, data: { toolName: 'bash' } }

  listeners['session/event'][0](session, eventApproval)
  assert.equal(pushes.length, 1, 'approval/asked 应即时推送')
  assert.match(pushes[0].title, /需要你批准/)

  listeners['session/event'][0](session, eventTurn)
  assert.equal(pushes.length, 1, 'turn/end 应先进入防抖，尚未推送')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(pushes.length, 2, '防抖窗口过后应推送 turn/end')
  assert.match(pushes[1].title, /任务完成/)

  dispose()
})

test('createEventListener: 同 session 重复 turn/end 防抖合并为一次', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = 0
  const notifier = { notifyAll: async () => { pushes += 1; return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  const evt = (seq) => ({ type: 'turn/end', seq, data: { reason: { kind: 'completed' } } })
  listeners['session/event'][0](session, evt(1))
  listeners['session/event'][0](session, evt(2))
  listeners['session/event'][0](session, evt(3))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(pushes, 1, '同 session 连续 turn/end 应合并为一次推送')
  dispose()
})

test('createEventListener: dedup 防止同一 seq 重放', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = 0
  const notifier = { notifyAll: async () => { pushes += 1; return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  const approval = { type: 'approval/asked', seq: 7, data: { toolName: 'bash' } }
  listeners['session/event'][0](session, approval)
  listeners['session/event'][0](session, approval) // 同 seq 重放
  assert.equal(pushes, 1)
  dispose()
})

test('createEventListener: agent/error 总线即时推送且按 turn:step 去重', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  const agent = { id: 'a1', session: makeSession('s1') }
  listeners['agent/error'][0]({ agent, turn: 1, step: 2, error: new Error('kaboom') })
  listeners['agent/error'][0]({ agent, turn: 1, step: 2, error: new Error('kaboom') }) // 同 turn:step 去重
  assert.equal(pushes.length, 1)
  assert.match(pushes[0].title, /Agent 执行出错/)
  assert.match(pushes[0].content, /kaboom/)
  dispose()
})

test('createEventListener: enabled:false 时全部静默', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = 0
  const notifier = { notifyAll: async () => { pushes += 1; return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: false, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  listeners['session/event'][0](makeSession('s1'), { type: 'approval/asked', seq: 1, data: {} })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(pushes, 0)
  dispose()
})

test('createEventListener: 无 agent/error 总线时降级不致命', () => {
  const ctx = {
    logger: { warn() {} },
    on(event, fn) {
      if (event === 'agent/error') throw new Error('no such bus')
      return () => {}
    },
  }
  const notifier = { notifyAll: async () => ({ ok: true, delivered: [], failed: [] }), flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('createEventListener: dispose 时 flush 未到期的 turn/end 防抖任务', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 60000, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  listeners['session/event'][0](session, { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } })
  assert.equal(pushes.length, 0, '防抖窗口未到，不应推送')
  const cleanup = dispose() // 模拟 cordis 卸载
  assert.ok(cleanup instanceof Promise, 'cleanup 应返回可 await 的 Promise（headless 退出前 flush）')
  await cleanup
  assert.equal(pushes.length, 1, 'dispose 应触发 flush 推送 pending turn/end')
  assert.match(pushes[0].title, /任务完成/)
})

test('createTrailingDebounce.flush 立即触发 pending 任务', () => {
  const debounce = createTrailingDebounce(60000)
  const calls = []
  debounce.schedule('a', () => calls.push('a'))
  debounce.schedule('b', () => calls.push('b'))
  const triggered = debounce.flush()
  assert.deepEqual(calls.sort(), ['a', 'b'])
  assert.equal(debounce.pendingCount(), 0)
  debounce.dispose()
})
