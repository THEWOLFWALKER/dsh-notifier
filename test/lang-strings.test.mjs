import test from 'node:test'
import assert from 'node:assert/strict'
import { stringsOf } from '../src/strings.mjs'
import { resolveConfig } from '../src/config.mjs'
import { intentOfSessionEvent, intentOfAgentError, intentToMessage, createEventListener } from '../src/event-listener.mjs'

test('stringsOf: 未知语言回落 zh；继承键（__proto__/constructor）不命中表', () => {
  assert.equal(stringsOf('weird'), stringsOf('zh'))
  assert.equal(stringsOf(undefined), stringsOf('zh'))
  assert.equal(stringsOf('__proto__'), stringsOf('zh'))
  assert.equal(stringsOf('constructor'), stringsOf('zh'))
})

/** 递归 key 形状对比（函数按同位置处理，只对形状不做内容比较）。 */
function keyShape(obj, path = [], out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) keyShape(value, [...path, key], out)
    else out.push([...path, key].join('.'))
  }
  return out
}

test('stringsOf: zh/en 表 key 形状一致（全节递归，防单边漂移）', () => {
  const zh = stringsOf('zh')
  const en = stringsOf('en')
  assert.deepEqual(keyShape(en), keyShape(zh))
})

test('resolveConfig: lang 归一化 — en 保留，未知回落 zh', () => {
  assert.equal(resolveConfig({ lang: 'en' }).lang, 'en')
  assert.equal(resolveConfig({ lang: 'fr' }).lang, 'zh')
  assert.equal(resolveConfig({}).lang, 'zh')
  assert.equal(resolveConfig(null).lang, 'zh')
})

test('intentOfSessionEvent: 默认（zh）文案与既有硬编码逐字节一致', () => {
  const zh = stringsOf('zh')
  assert.deepEqual(zh.turnEndDetail, {
    error: '任务执行出错',
    blocked: '任务被阻塞，等待你处理',
    'max-tokens': '某一步骤达到输出 Token 上限',
    interrupted: '会话被异常中断，等待恢复',
  })
  assert.deepEqual(zh.turnEndHeadline, {
    completed: '✅ 任务完成',
    error: '❌ 任务出错',
    blocked: '🚫 任务被阻塞',
    aborted: '⏹ 任务已中止',
    'max-tokens': '⚠️ 达到 Token 上限',
    interrupted: '⏸ 任务异常中断',
  })
  const ok = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(ok.headline, '✅ 任务完成')
  const approval = intentOfSessionEvent({ type: 'approval/asked', data: { toolName: 'email_send', reason: '给 x@y.z 发邮件' } })
  assert.equal(approval.detail, '工具 email_send 需要授权：给 x@y.z 发邮件')
})

test('intentOfSessionEvent: lang en — headline/detail 级别不变仅文案切换', () => {
  const strings = stringsOf('en')
  const ok = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, strings)
  assert.equal(ok.headline, '✅ Task complete')
  assert.equal(ok.level, 'active')
  const blocked = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }, strings)
  assert.equal(blocked.headline, '🚫 Task blocked')
  assert.equal(blocked.detail, 'Task blocked, waiting for you')
  const approval = intentOfSessionEvent({ type: 'approval/asked', data: { toolName: 'email_send', reason: 'send mail' } }, strings)
  assert.equal(approval.headline, '🔐 Approval needed')
  assert.equal(approval.detail, 'Tool email_send needs your approval: send mail')
  assert.equal(intentOfSessionEvent({ type: 'turn/start' }, strings).headline, '🚀 Task started')
})

test('intentOfAgentError: lang en — 错误原文不翻译，仅 fallback/headline 切换', () => {
  const strings = stringsOf('en')
  assert.equal(intentOfAgentError({}, strings).headline, '❌ Agent error')
  assert.equal(intentOfAgentError({}, strings).detail, 'agent execution failed')
  assert.equal(intentOfAgentError({ error: new Error('boom') }, strings).detail, 'boom')
})

test('intentToMessage: en 标题套 titlePrefix 与钳制不变', () => {
  const strings = stringsOf('en')
  const intent = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, strings)
  const message = intentToMessage(intent, { assistantText: 'done', config: { titlePrefix: '[DSH]', summaryMaxChars: 500, lang: 'en' } })
  assert.equal(message.title, '[DSH] ✅ Task complete')
  assert.equal(message.level, 'active')
})

// ---- helpers（镜像 event-listener.test.mjs）----

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

test('createEventListener: lang en — stall/longRunning 状态正文与 headline 走 EN 文案', () => {
  const { ctx, listeners } = fakeCtx()
  const pushes = []
  const notifier = { notifyAll: async (msg) => { pushes.push(msg); return { ok: true } }, flush: async () => {} }
  const t = fakeTimers()
  const dispose = createEventListener(ctx, notifier, resolveConfig({
    lang: 'en',
    debounceMs: 10, summaryMaxChars: 500, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: true, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }), {
    trackerOverrides: { now: t.now, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn, minMs: 1 },
  })
  const session = makeSession('sess-stall-en', [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'long test running' }] } } },
  ])
  listeners['session/event'][0](session, { type: 'turn/start', seq: 1 })
  t.advance(600_000)
  assert.equal(pushes.length, 1, 'stall 直推')
  assert.equal(pushes[0].title, '⚠️ Possibly stalled')
  assert.equal(pushes[0].level, 'timeSensitive')
  assert.match(pushes[0].content, /ws \/ sess-sta/)
  assert.match(pushes[0].content, /reply \/stop to cancel/)
  t.advance(300_000)
  assert.equal(pushes.length, 2, '心跳在 15min 首跳')
  assert.equal(pushes[1].title, '⏱ Task still running')
  assert.equal(pushes[1].level, 'passive')
  assert.match(pushes[1].content, /long test running/, '心跳附最近输出摘录')
  assert.match(pushes[1].content, /^ws \/ sess-sta\nRunning 15m, last activity .+ ago\n/m, 'EN 时长行')
  dispose()
})

test('lang en: commands/actions/adapter 段为英文（防 zh 副本回潮）', () => {
  const en = stringsOf('en')
  assert.equal(en.commands.pairUsage.startsWith('Usage: /pair'), true)
  assert.equal(en.commands.pairSuccess('x', 'h').startsWith('Paired!'), true)
  assert.equal(en.actions.executed, '✅ Executed')
  assert.equal(en.commands.channelNames.feishu, 'Feishu')
  assert.equal(en.telegram.refExpired.startsWith('This action'), true)
  assert.equal(en.feishu.approvalResolvedTitle, 'Approval completed')
  assert.equal(en.qq.resultLine('y'), '[Approval result] y')
  assert.equal(en.bus.identityLine('Telegram', 'u1'), 'Your Telegram identity is u1.')
})
