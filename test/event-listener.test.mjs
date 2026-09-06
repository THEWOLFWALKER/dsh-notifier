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

test('createEventListener: G-18 同 seq 不同负载的 approval/asked 不互吞（dedup 键带负载摘要）', async () => {
  const { ctx, listeners } = fakeCtx()
  let pushes = 0
  const notifier = { notifyAll: async () => { pushes += 1; return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  // 同 session 同 seq 重放但负载不同（宿主重放先请 toolA 后请 toolB）：
  // 键追加 hash6(detail) → 两条都推；turn 类维持现状（同 seq 即同一事件）。
  listeners['session/event'][0](session, { type: 'approval/asked', seq: 9, data: { toolName: 'email_send', reason: '给 x@y.z 发邮件' } })
  listeners['session/event'][0](session, { type: 'approval/asked', seq: 9, data: { toolName: 'bash', reason: '跑构建命令' } })
  assert.equal(pushes, 2, '同 seq 不同负载 → 双推不互吞')
  dispose()
})

test('createEventListener: root-context fallback accepts envelope and preserves duplicate delivery dedup', () => {
  const listeners = {}
  const root = {
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return () => {}
    },
  }
  root.root = root
  const ctx = {
    root,
    logger: { warn() {} },
    on() { throw new Error('scoped context must not receive host subscription') },
  }
  const pushes = []
  const notifier = { notifyAll: async (message) => { pushes.push(message); return { ok: true } }, flush: async () => {} }
  const dispose = createEventListener(ctx, notifier, { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' })
  const envelope = { session: makeSession('s1'), event: { type: 'approval/asked', seq: 7, data: {} } }
  listeners['session/event'][0](envelope)
  listeners['session/event'][0](envelope)
  assert.equal(pushes.length, 1)
  dispose()
})

test('createEventListener: malformed session/event does not notify or throw', () => {
  const warnings = []
  const listeners = {}
  const ctx = { logger: { warn: (...args) => warnings.push(args.join(' ')) }, on(event, listener) { ;(listeners[event] ??= []).push(listener); return () => {} } }
  const notifier = { notifyAll: async () => { throw new Error('must not notify') }, flush: async () => {} }
  const dispose = createEventListener(ctx, notifier, { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' })
  listeners['session/event'][0]({ session: { id: 's1' }, event: { type: 3 } })
  assert.ok(warnings.some((line) => /session\/event 载荷已拒绝/.test(line)))
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

test('createTrailingDebounce.flush 必须 clearTimeout 已挂起定时器（否则卸载后进程被吊住整个防抖窗口）', () => {
  const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const before = liveTimers()
  const debounce = createTrailingDebounce(600000) // 10 分钟窗口：泄漏则进程要等 10 分钟才退
  for (let i = 0; i < 32; i += 1) debounce.schedule(`k${i}`, () => {})
  assert.equal(liveTimers() - before, 32, '每个 key 一个在途定时器')
  debounce.flush()
  assert.equal(liveTimers() - before, 0, 'flush 后不得留活定时器（grace.flush 一直如此，两者必须对齐）')
  assert.equal(debounce.pendingCount(), 0)
  debounce.dispose()
})

test('createTrailingDebounce.dispose 同样清空在途定时器（既有行为防回归）', () => {
  const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const before = liveTimers()
  const debounce = createTrailingDebounce(600000)
  for (let i = 0; i < 8; i += 1) debounce.schedule(`d${i}`, () => {})
  debounce.dispose()
  assert.equal(liveTimers() - before, 0)
})

// ---------- createTrailingDebounce 有界（v0.8.7 P1-7，宪法#4「状态必须有界」）----------
// 溢出语义 = 提前触发最旧 key 的最新任务（合并窗提前收口，绝不静默丢弃——宪法#3）。

test('createTrailingDebounce 有界：maxKeys=2 时第 3 个 key 提前触发最旧，且触发的是该 key 最新一次任务', async () => {
  const calls = []
  const overflow = []
  const debounce = createTrailingDebounce(60000, {
    maxKeys: 2,
    onOverflow: (key, size) => overflow.push([key, size]),
  })
  debounce.schedule('a', () => calls.push('a1'))
  debounce.schedule('a', () => calls.push('a2')) // 尾沿覆盖：a 的待发换成 a2
  debounce.schedule('b', () => calls.push('b'))
  assert.deepEqual(calls, [], '未溢出前不该提前触发')
  assert.equal(debounce.pendingCount(), 2)
  debounce.schedule('c', () => calls.push('c'))
  assert.deepEqual(calls, ['a2'], '提前触发最旧 key，且尾沿语义保持（送最新任务而非首个）')
  assert.deepEqual(overflow, [['a', 2]])
  assert.equal(debounce.pendingCount(), 2, '在途数恒不超上限')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['a2'], '提前触发后其定时器已清，不二次送达')
  debounce.dispose()
})

test('createTrailingDebounce 有界：同 key 反复重排不触发溢出（重排不是新增）', () => {
  const calls = []
  const overflow = []
  const debounce = createTrailingDebounce(60000, { maxKeys: 2, onOverflow: (k) => overflow.push(k) })
  debounce.schedule('a', () => calls.push('a'))
  debounce.schedule('b', () => calls.push('b'))
  for (let i = 0; i < 10; i += 1) debounce.schedule('a', () => calls.push(`a${i}`))
  assert.deepEqual(calls, [])
  assert.deepEqual(overflow, [])
  assert.equal(debounce.pendingCount(), 2)
  debounce.dispose()
})

test('createTrailingDebounce 有界：onOverflow 抛错 / task 抛错都不外抛，表不卡在超量状态', () => {
  const calls = []
  const debounce = createTrailingDebounce(60000, {
    maxKeys: 1,
    onOverflow: () => { throw new Error('通报炸了') },
  })
  debounce.schedule('boom', () => { throw new Error('任务炸了') })
  assert.doesNotThrow(() => debounce.schedule('next', () => calls.push('next')))
  assert.equal(debounce.pendingCount(), 1)
  debounce.flush()
  assert.deepEqual(calls, ['next'])
  debounce.dispose()
})

test('createTrailingDebounce 有界：maxKeys 三态——负数钳 1；0/NaN 回落 256；默认 256 压测零丢失', () => {
  for (const bad of [-3, 1]) {
    const calls = []
    const debounce = createTrailingDebounce(60000, { maxKeys: bad })
    debounce.schedule('a', () => calls.push('a'))
    debounce.schedule('b', () => calls.push('b'))
    assert.deepEqual(calls, ['a'], `maxKeys=${bad} 应钳到 1`)
    debounce.dispose()
  }
  for (const bad of [0, NaN]) {
    const calls = []
    const debounce = createTrailingDebounce(60000, { maxKeys: bad })
    for (let i = 0; i < 256; i += 1) debounce.schedule(`k${i}`, () => calls.push(i))
    assert.deepEqual(calls, [], `maxKeys=${String(bad)} 应回落 256`)
    debounce.schedule('k256', () => calls.push(256))
    assert.equal(calls.length, 1)
    debounce.dispose()
  }
  const calls = []
  const debounce = createTrailingDebounce(60000) // 缺省 256
  for (let i = 0; i < 1000; i += 1) {
    debounce.schedule(`s${i}`, () => calls.push(i))
    assert.ok(debounce.pendingCount() <= 256, '任何时刻在途数不得越界')
  }
  assert.equal(calls.length, 1000 - 256, '提前送达 744 条')
  debounce.flush()
  assert.equal(calls.length, 1000, '合计零丢失')
  debounce.dispose()
})

test('createEventListener 有界装配：300 个会话 turn/end → 在途稳定 256、超量提前推送并 warn，dispose 后零丢失', async () => {
  const { ctx, listeners } = fakeCtx()
  const lines = []
  ctx.logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const pushes = []
  const notifier = {
    notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } },
    flush: async () => {},
  }
  // debounceMs 极长 + graceSeconds=0：待发全部堆在防抖表，直接观测其上界
  const resolved = { enabled: true, debounceMs: 600000, graceSeconds: 0, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  for (let i = 0; i < 300; i += 1) {
    listeners['session/event'][0](makeSession(`s${i}`), { type: 'turn/end', seq: i, data: { reason: { kind: 'completed' } } })
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(pushes.length, 300 - 256, '超出 256 的会话被提前推送（44 条），不静默丢弃')
  assert.ok(lines.some((line) => line.includes('防抖表达上限')), '溢出必须 warn 出声（宪法#3）')
  await dispose()
  assert.equal(pushes.length, 300, 'dispose flush 后 300 条通知全部送达，零丢失')
})

test('createEventListener 有界装配：宽限窗溢出同样提前推送并 warn（graceSeconds 配长也不无界堆积）', async () => {
  const { ctx, listeners } = fakeCtx()
  const lines = []
  ctx.logger = { warn: (prefix, message) => lines.push(`${prefix} ${message}`) }
  const pushes = []
  const notifier = {
    notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } },
    flush: async () => {},
  }
  // debounceMs=0 让事件立刻穿过防抖落进宽限窗；graceSeconds 极长 ⇒ 堆在 grace 表
  const resolved = { enabled: true, debounceMs: 0, graceSeconds: 3600, summaryMaxChars: 100, titlePrefix: '' }
  const dispose = createEventListener(ctx, notifier, resolved)
  for (let i = 0; i < 300; i += 1) {
    listeners['session/event'][0](makeSession(`g${i}`), { type: 'turn/end', seq: i, data: { reason: { kind: 'completed' } } })
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pushes.length, 300 - 256, '宽限窗在途超 256 即提前推送最旧')
  assert.ok(lines.some((line) => line.includes('宽限窗表达上限')), '宽限窗溢出必须 warn 出声')
  await dispose()
  assert.equal(pushes.length, 300, 'dispose flush 后零丢失')
})

// ---------- 阶段 2：规则引擎（事件分控 / 关键词 / 宽限窗） ----------

test('createEventListener: events.turnEnd 按结束原因分控', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    // 注意：这里传的是 resolveConfig 归一化后的形状（生产路径 index.mjs -> resolveConfig -> listener）
    events: { turnEnd: { enabled: true, kinds: { completed: false } } }, // 只要完成类
  }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  listeners['session/event'][0](session, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(pushes.length, 0, 'completed 被分控拦下')
  listeners['session/event'][0](session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'error' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(pushes.length, 1, 'error 不受 completed 开关影响')
  dispose()
})

test('createEventListener: events 整类开关关闭时静默（不占 dedup 名额）', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    events: { approval: false, agentError: false },
  }
  const dispose = createEventListener(ctx, notifier, resolved)
  listeners['session/event'][0](makeSession('s1'), { type: 'approval/asked', seq: 1, data: {} })
  listeners['agent/error'][0]({ agent: { id: 'a1', session: makeSession('s1') }, turn: 1, step: 1, error: new Error('x') })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(pushes.length, 0)
  dispose()
})

test('createEventListener: 关键词 exclude 拦截推送，include 白名单放行', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    keywords: { exclude: ['heartbeat'] },
  }
  const dispose = createEventListener(ctx, notifier, resolved)
  // turn/error 的 detail 是「任务执行出错」；用 approval 携带可控文本更直接
  listeners['session/event'][0](makeSession('s1'), {
    type: 'approval/asked', seq: 1, data: { toolName: 'bash', reason: '例行 heartbeat 检查' },
  })
  assert.equal(pushes.length, 0, 'exclude 命中应拦截')
  listeners['session/event'][0](makeSession('s1'), {
    type: 'approval/asked', seq: 2, data: { toolName: 'bash', reason: '需要部署生产环境' },
  })
  assert.equal(pushes.length, 1, '未命中放行')
  dispose()
})

test('createEventListener: 宽限窗内用户接管（user/* 事件）取消打扰', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    graceSeconds: 0.05, // 测试用亚秒窗
  }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  listeners['session/event'][0](session, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20)) // 防抖到期，进宽限窗
  listeners['session/event'][0](session, { type: 'user/message', seq: 2, data: { text: '我看到了' } })
  await new Promise((resolve) => setTimeout(resolve, 100)) // 宽限窗早已到期
  assert.equal(pushes.length, 0, '用户接管后不打扰')
  dispose()
})

test('createEventListener: 宽限窗到期无人接管则正常送达；dispose flush 宽限窗任务', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true, delivered: [], failed: [] } }, flush: async () => {} }
  const resolved = {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    graceSeconds: 0.05,
  }
  const dispose = createEventListener(ctx, notifier, resolved)
  const session = makeSession('s1')
  listeners['session/event'][0](session, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(pushes.length, 1, '无人接管，到期送达')

  // dispose 路径：宽限窗未到期即卸载（headless 退出），flush 送达
  listeners['session/event'][0](session, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20)) // 防抖到期进宽限窗
  const cleanup = dispose()
  assert.ok(cleanup instanceof Promise)
  await cleanup
  assert.equal(pushes.length, 2, 'dispose flush 宽限窗内待发任务')
})

// ---------------------------------------------------------------- v0.5 状态上报 + 动作闭环

/** 假时钟+假定时器（同 turn-tracker.test 惯例；minMs=1 让 afterMs 可用毫秒级）。 */
function fakeTimers(startMs = 1_000_000) {
  let seq = 0
  let nowMs = startMs
  const timers = new Map()
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    setTimeoutFn(fn, ms) {
      seq += 1
      timers.set(seq, { at: nowMs + ms, fn })
      return seq
    },
    clearTimeoutFn(id) {
      timers.delete(id)
    },
  }
}

const tickAsync = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

test('v0.5 turn/start：默认关（旧形状直传零感知），显式开启才推送', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const resolved = { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' } // 旧形状：无 events 键
  const dispose = createEventListener(ctx, notifier, resolved)
  listeners['session/event'][0](makeSession('s1'), { type: 'turn/start', seq: 1 })
  await tickAsync(40)
  assert.equal(pushes.length, 0, '默认关：不推送')
  dispose()

  const { ctx: ctx2, listeners: listeners2 } = fakeCtx()
  const pushes2 = []
  const notifier2 = { notifyAll: async (msg) => { pushes2.push(msg); return { ok: true } }, flush: async () => {} }
  const dispose2 = createEventListener(ctx2, notifier2, {
    ...resolved,
    events: { turnStart: { enabled: true }, turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true },
  })
  listeners2['session/event'][0](makeSession('s1'), { type: 'turn/start', seq: 1 })
  await tickAsync(40)
  assert.equal(pushes2.length, 1, '开启后推送')
  assert.match(pushes2[0].title, /任务开始/)
  assert.equal(pushes2[0].level, 'passive')
  assert.equal(pushes2[0].content, 'ws', '正文 = workspace 名')
  dispose2()
})

test('v0.5 turn/start → turn/end 10s 内：尾沿合并只发一条「任务完成」', async () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 30, summaryMaxChars: 100, titlePrefix: '',
    events: { turnStart: { enabled: true }, turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true },
  })
  const session = makeSession('s1')
  listeners['session/event'][0](session, { type: 'turn/start', seq: 1 })
  await tickAsync(10)
  listeners['session/event'][0](session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
  await tickAsync(60)
  assert.equal(pushes.length, 1, 'start 被 end 替换（supersede），只发一条')
  assert.match(pushes[0].title, /任务完成/)
  dispose()
})

test('v0.5 stall：timeSensitive 直推 + 文案含 /stop hint；心跳：passive + 摘录', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 10, summaryMaxChars: 500, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: true, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }, {
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  const session = makeSession('sess-stall-1234', [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在跑长测试' }] } } },
  ])
  listeners['session/event'][0](session, { type: 'turn/start', seq: 1 })
  t.advance(600_000)
  assert.equal(pushes.length, 1, 'stall 直推（不进宽限窗）')
  assert.match(pushes[0].title, /疑似卡住/)
  assert.equal(pushes[0].level, 'timeSensitive')
  assert.match(pushes[0].content, /ws \/ sess-sta/)
  assert.match(pushes[0].content, /\/stop 取消/)
  t.advance(300_000)
  assert.equal(pushes.length, 2, '心跳在 15min 首跳（卡住已报不抑制心跳）')
  assert.match(pushes[1].title, /任务进行中/)
  assert.equal(pushes[1].level, 'passive')
  assert.match(pushes[1].content, /正在跑长测试/, '心跳附最近输出摘录')
  assert.match(pushes[1].content, /已运行 15m/, '心跳首跳在 firstAfter=15min')
  dispose()
})

test('v0.5 stall：events.stall 关闭时不装定时器（零推送）', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: false, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: false, afterMs: 600_000 },
    },
  }, {
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  listeners['session/event'][0](makeSession('s1'), { type: 'turn/start', seq: 1 })
  t.advance(3_600_000)
  assert.equal(pushes.length, 0)
  dispose()
})

test('v0.5 动作卡片：stall 触发时对交互通道 mint + sendActionCard（ac: 负载）', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const minted = []
  const dispatcher = {
    mintAction: (kind, payload) => {
      minted.push({ kind, payload })
      return { key: `act:${kind}:dead`, token: 'tok.sig' }
    },
  }
  const cards = []
  const rawChannel = {
    // S-12：形状守卫对未登记渠道整体拒绝——测试替身也用真实渠道名（telegram），
    // 既过了闸，也比自造 'mock' 键更贴近真实路径。
    channel: 'telegram',
    notifyTargets: () => [{ chatId: '10086', userId: 'u1' }],
    sendActionCard: async (payload) => { cards.push(payload); return { messageId: 'm1' } },
  }
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: false, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }, {
    actions: () => dispatcher,
    interactive: () => [rawChannel],
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  const session = makeSession('sess-card-1')
  listeners['session/event'][0](session, { type: 'turn/start', seq: 1 })
  t.advance(600_000)
  assert.equal(minted.length, 1)
  assert.equal(minted[0].kind, 'turn/cancel')
  assert.deepEqual(minted[0].payload, { sessionId: 'sess-card-1' })
  assert.equal(cards.length, 1)
  assert.match(cards[0].title, /疑似卡住/)
  assert.equal(cards[0].actions[0].label, '⏹ 停止任务')
  assert.match(cards[0].actions[0].data, /^ac:act:turn\/cancel:dead:tok\.sig$/)
  dispose()
})

test('v0.5 动作卡片：wiring.actions 缺省时 stall 通知仍出（文本 hint 兜底，无卡片）', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: false, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }, {
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  listeners['session/event'][0](makeSession('s1'), { type: 'turn/start', seq: 1 })
  t.advance(600_000)
  assert.equal(pushes.length, 1, '无 actions 注入：通知照发（hint 兜底），仅无卡片')
  dispose()
})

test('v0.5 dispose：tracker 定时器被清（退出后不再触发 stall）', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: false, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }, {
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  listeners['session/event'][0](makeSession('s1'), { type: 'turn/start', seq: 1 })
  dispose()
  t.advance(3_600_000)
  assert.equal(pushes.length, 0, 'dispose 后不再触发')
})

test('B3 dispose 级联：agent/disposed 事件调 bus.abandonByAgent（裸 agent 与 { agent } 载荷均可）', () => {
  const { ctx, listeners } = fakeCtx()
  const notifier = { notifyAll: async () => ({ ok: true }), flush: async () => {} }
  const disposed = []
  const bus = { abandonByAgent: (agentId) => { disposed.push(agentId); return 1 } }
  const dispose = createEventListener(ctx, notifier, { enabled: true, debounceMs: 10, summaryMaxChars: 100, titlePrefix: '' }, {
    bus: () => bus,
  })
  listeners['agent/disposed'][0]({ id: 's9' })
  listeners['agent/disposed'][0]({ agent: { id: 's9' } })
  assert.deepEqual(disposed, ['s9', 's9'], '裸 agent 与 { agent } 容器形态都解包出 id')
  dispose()
})
