import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // 阶段 6：notify 之外还注册 notify_test（健康自检）
  assert.deepEqual(defs.map((def) => def.name).sort(), ['notify', 'notify_test'], '注册 notify + notify_test 工具')
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
  assert.deepEqual(defs.map((def) => def.name).sort(), ['notify', 'notify_test'])
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

test('apply: inbound 白名单 + approval 配置 → 注册 approval/request；state 落指定目录', () => {
  const { ctx, listeners, warnings } = bootCtx()
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-wire-'))
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { allowUsers: ['42'], stateDir },
    approval: { mode: 'observe' },
  })
  assert.equal(listeners['approval/request'].length, 1)
  assert.ok(warnings.some((w) => /未启动.*telegram/i.test(w) === false))
})

test('apply: approval 配置但白名单为空 → 只 warn 不注册（默认全拒）', () => {
  const { ctx, listeners, warnings } = bootCtx()
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    approval: { mode: 'answer' },
  })
  assert.equal(listeners['approval/request'], undefined)
  assert.ok(warnings.some((w) => /allowUsers 为空.*远程审批未启动/.test(w)))
})

test('apply: 未配置 inbound/approval → 不注册 approval/request，零额外副作用', () => {
  const { ctx, listeners } = bootCtx()
  apply(ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  assert.equal(listeners['approval/request'], undefined)
})

// v0.3.1 TDZ 回归：store 曾在 feishu/qq/dingtalk resolve 之后才创建（声明前引用 →
// ReferenceError）。配置任一 inbound 通道（含凭证不全被跳过的）都必须不崩启动。
test('apply: 配置 inbound.feishu/qq/dingtalk 不因 store TDZ 崩启动', () => {
  for (const channel of ['feishu', 'qq', 'dingtalk']) {
    const { ctx, warnings } = bootCtx()
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-tdz-'))
    // 凭证齐全会真启动长连接，这里给凭证不全的形态：resolve 读 store 回退后仍跳过
    apply(ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: { allowUsers: ['u1'], stateDir, [channel]: {} },
    })
    assert.ok(
      warnings.some((w) => w.includes(`inbound.${channel} 跳过`) || w.includes(`inbound 已启动：${channel}`)),
      `${channel}：应出现跳过 warn 或启动提示（实际：${warnings.join(' | ')}）`,
    )
  }
})

// v0.3.1 扫码凭证回退：state.json 预置 feishu:account → inbound.feishu: {} 直接可用
test('apply: 扫码凭证回退——state 预置 feishu:account 后 inbound.feishu 空配置即启用', () => {
  const { ctx, warnings } = bootCtx()
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-scan-'))
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    'feishu:account': { appId: 'cli_a', appSecret: 'sec', at: 0 },
  }))
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { allowUsers: ['u1'], stateDir, feishu: {} },
  })
  assert.ok(warnings.some((w) => /inbound 已启动：feishu/.test(w)), `应启动 feishu（实际：${warnings.join(' | ')}）`)
})
