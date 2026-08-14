import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.mjs'

function bootCtx() {
  const warnings = []
  const listeners = {}
  const defs = []
  const effects = []
  return {
    warnings,
    listeners,
    defs,
    ctx: {
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      tools: { register(def) { defs.push(def); return () => {} } },
      on(event, fn) { (listeners[event] ??= []).push(fn); return () => {} },
      effect(fn) { effects.push(fn) },
    },
  }
}

test('apply: 空配置不崩启动，只 warn', () => {
  const { ctx, warnings, defs } = bootCtx()
  apply(ctx, {})
  assert.equal(defs.length, 1, '仍注册 notify 工具')
  assert.ok(warnings.some((w) => /未配置任何可用渠道/.test(w)))
})

test('apply: 部分渠道配置缺失时逐个 warn，可用渠道照常启用', () => {
  const { ctx, warnings, defs } = bootCtx()
  apply(ctx, {
    channels: [
      { type: 'telegram' }, // 缺失 botToken/chatId
      { type: 'bogus' },    // 未知类型
      { type: 'webhook', url: 'http://127.0.0.1:1/hook' },
    ],
  })
  assert.equal(defs.length, 1)
  assert.ok(warnings.some((w) => /渠道 "telegram" 跳过.*telegram 未配置/.test(w)))
  assert.ok(warnings.some((w) => /渠道 "bogus" 跳过.*未知渠道类型/.test(w)))
  assert.ok(warnings.some((w) => /已启用渠道：webhook/.test(w)))
})

test('apply: enabled:false 时不注册事件监听与工具', () => {
  const { ctx, warnings, defs, listeners } = bootCtx()
  apply(ctx, { enabled: false })
  assert.equal(defs.length, 0)
  assert.equal(listeners['session/event'], undefined)
  assert.ok(warnings.some((w) => /已禁用/.test(w)))
})

test('apply: 注册 session/event 与 agent/error 两个监听', () => {
  const { ctx, listeners } = bootCtx()
  apply(ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  assert.equal(listeners['session/event'].length, 1)
  assert.equal(listeners['agent/error'].length, 1)
})
