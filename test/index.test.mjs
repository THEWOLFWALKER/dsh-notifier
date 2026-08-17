import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.mjs'

// 真机残留 state 隔离（R6 审查 P1，2026-08-17 真机 796/1 事故）：
// defaultStateDir() 读 $DSH_HOME → 在宿主真机跑过 dsh 的机器上
// ~/.dsh/dsh-notifier/state.json 携带扫码凭证/绑定表，未显式传 stateDir 的 apply()
// 经凭证回退读到真机残留——「无凭证不注册审批」断言当场翻车（沙箱无残留恒绿，
// mock 盲区又一例）。文件加载即整文件隔离：DSH_HOME 指向一次性空目录。
// node --test 每文件独立进程，不会泄漏到其他测试文件。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-notifier-test-home-'))

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

test('apply: approval 配置但无任何入站通道凭证 → 只 warn 不注册（无回传通道可承载裁决）', () => {
  const { ctx, listeners, warnings } = bootCtx()
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    approval: { mode: 'answer' },
  })
  assert.equal(listeners['approval/request'], undefined)
  // v0.7 文案变更：空名单不再是问题（引导态），无通道凭证才是
  assert.ok(warnings.some((w) => /没有任何入站通道凭证.*远程审批未启动/.test(w)))
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

// v0.7.3（GitHub issue #2）回归：入站配置的 ${ENV:NAME} 引用必须在装配层展开
// （与出站同构）。旧代码 resolve 未过 resolveEnvRefs，README 示例
// ${ENV:FEISHU_SECRET} 原样透传 SDK → invalid appId，且无提示。
test('apply: inbound.feishu 的 ${ENV:} 引用被展开（#2）——不再原样透传给 SDK', () => {
  process.env.DSH_TEST_FEISHU_APPID = 'cli_env1234567890'
  process.env.DSH_TEST_FEISHU_SECRET = 'sec-from-env'
  try {
    const { ctx, warnings } = bootCtx()
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-env-'))
    apply(ctx, {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
      inbound: {
        allowUsers: ['u1'],
        stateDir,
        feishu: { appId: '${ENV:DSH_TEST_FEISHU_APPID}', appSecret: '${ENV:DSH_TEST_FEISHU_SECRET}' },
      },
    })
    // 引用已展开 → resolve ok（启动或 SDK 缺失告警，但绝不是「appId 缺失」跳过）
    assert.ok(
      warnings.some((w) => /inbound 已启动：feishu|启动失败/.test(w)),
      `应启动 feishu 或 SDK 级告警（实际：${warnings.join(' | ')}）`,
    )
    assert.ok(
      warnings.every((w) => !/inbound\.feishu 跳过.*appId 缺失/.test(w)),
      'ENV 引用未展开会导致 appId 缺失跳过',
    )
  } finally {
    delete process.env.DSH_TEST_FEISHU_APPID
    delete process.env.DSH_TEST_FEISHU_SECRET
  }
})

// v0.6.1 真机事故修复（TG inbound 装配问题报告）：告警双写 stderr，
// web profile 宿主 cordis logger 不落 stdout 时部署问题仍可诊断。
test('v0.6.1 warn 双写 console.error：宿主 logger 不可见路径仍有 stderr 输出', () => {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const { ctx } = bootCtx()
    apply(ctx, {}) // 空配置 → 必然 warn「未配置任何可用渠道」
  } finally {
    console.error = original
  }
  assert.ok(lines.some((line) => /\[dsh-notifier\]/.test(line) && /未配置任何可用渠道/.test(line)),
    `stderr 应出现未配置渠道告警（实际：${lines.join(' | ')}）`)
})

// v0.6.1 逐通道装配隔离：某条 inbound 通道装配抛错只点名跳过，
// 不冒出 apply、不拖垮其余装配（此前同步抛错被 cordis 吃掉 → 出站正常 + inbound 全死 + 零可见）。
test('v0.6.1 inbound 逐通道隔离：telegram 装配炸了不崩 apply，其余装配照常', () => {
  const { ctx, warnings, defs } = bootCtx()
  const evilApiBase = { toString() { throw new Error('evil apiBase') } } // createTelegramInbound 内 .replace 即抛
  apply(ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    approval: { mode: 'answer' },
    inbound: {
      allowUsers: ['42'],
      stateDir: mkdtempSync(join(tmpdir(), 'dsh-notifier-iso-')),
      telegram: { botToken: 'T0KEN', apiBase: evilApiBase },
    },
  })
  assert.ok(warnings.some((w) => /inbound:telegram 装配失败，已跳过/.test(w)),
    `应点名 telegram 装配失败（实际：${warnings.join(' | ')}）`)
  assert.ok(!warnings.some((w) => /inbound 已启动：telegram/.test(w)), 'telegram 不应有启动成功告警')
  assert.deepEqual(defs.map((def) => def.name).sort(), ['notify', 'notify_test'], '出站工具照常注册（apply 未被拖垮）')
})
