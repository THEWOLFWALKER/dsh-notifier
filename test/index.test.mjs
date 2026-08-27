import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
    /** 执行 ctx.effect 收集的清理（真 cordis 语义：fn 返回值才是 disposer，需二次调用）。
     * 起了真长轮询/HTTP 监听的用例必须调，否则 node --test 事件循环挂住不退。 */
    async cleanup() {
      for (const fn of effects) {
        try {
          const dispose = fn()
          const result = typeof dispose === 'function' ? dispose() : dispose
          if (result != null && typeof result.then === 'function') await result
        } catch { /* 卸载失败不致命 */ }
      }
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
  assert.deepEqual(defs.map((def) => def.name).sort(), ['ask_user', 'notify', 'notify_test'], '出站工具照常注册（apply 未被拖垮）')
})

// ————————————————— v0.8.7 B1：引导码文件交付（LEAK-2） —————————————————
// 漏洞原状：showBootstrap 经 warn() 双写（logger + stderr）把码面明文打进持久化日志
// （journald/Loki/ELK）——任何能读日志的账号可拿 owner 级凭证。改为写本机 0600 文件，
// stderr 只印路径。这里往死里测「码面绝不出现在任何 warn/stderr 里」。

/** 引导态启动（空 allowUsers + telegram 凭证就绪但 apiBase 不可达 → 只走装配不真联网）。 */
function guidedBoot(stateDir) {
  const rig = bootCtx()
  apply(rig.ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { stateDir, telegram: { botToken: 'T0KEN', apiBase: 'http://127.0.0.1:1' } },
  })
  return rig
}

/** 码面形状：8 位 [A-Z2-9]（pairing.mjs CODE_ALPHABET，无 0/1/I/O 等易混字符）。 */
const CODE_TOKEN = /\b[A-Z2-9]{8}\b/

test('B1-1 引导码文件交付：bootstrap-paircode.txt 存在、mode 0600、内容是单行码面', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-b1-file-'))
  const rig = guidedBoot(stateDir)
  try {
    const codePath = join(stateDir, 'bootstrap-paircode.txt')
    assert.ok(existsSync(codePath), `引导态必须写码文件（warn：${rig.warnings.join(' | ')}）`)
    // POSIX 才是 0600 权限位语义面：强断言同组/他人零权限。win32 的 Node stat 不反映
    // Unix 权限位（writeFileSync mode:0o600 后 stat 仍报 666），实际边界是用户目录 ACL
    // 继承私有——存在性/单行内容/路径告警/无泄漏断言仍在全平台执行，权限面在 POSIX 锁定。
    if (process.platform !== 'win32') {
      assert.equal((statSync(codePath).mode & 0o777).toString(8), '600', '仅所有者可读写（同组/其他人零权限）')
    }
    assert.match(readFileSync(codePath, 'utf8'), /^[A-Z2-9]{8}\n$/, '文件只放码面本体 + 换行，无标签无说明')
    // stderr/logger 只印路径与时长，不印码面。路径分隔符归一化：Windows 上 warn 可能混合
    // `\` 与 `/`（dirname 是反斜杠、文件名拼接是斜杠），逐字节匹配会误报——归一后比语义。
    const norm = (p) => p.replace(/\\/g, '/')
    assert.ok(rig.warnings.some((w) => /【引导配对码】/.test(w) && norm(w).includes(norm(codePath))),
      `warn 必须给出码文件路径（实际：${rig.warnings.join(' | ')}）`)
  } finally {
    await rig.cleanup()
  }
})

test('B1-3 引导码零泄漏：码面绝不出现在任何 warn 条目里（LEAK-2 回归钉）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-b1-leak-'))
  const rig = guidedBoot(stateDir)
  try {
    const code = readFileSync(join(stateDir, 'bootstrap-paircode.txt'), 'utf8').trim()
    assert.match(code, /^[A-Z2-9]{8}$/, '前置：确实拿到了 8 位码面')
    // 正控：真码面串不在任何 warn 里（前缀断言测不出泄漏，必须比对真码面）
    for (const line of rig.warnings) {
      assert.ok(!line.includes(code), `码面泄漏进 warn：${line}`)
    }
    // 负控加固：连「像码面的 8 位 token」都不该出现（防未来改动换个变量又把码印回去）
    // 路径里的临时目录名含随机段，先剔除路径再扫
    for (const line of rig.warnings) {
      const withoutPaths = line.replace(/\/\S+/g, '')
      assert.ok(!CODE_TOKEN.test(withoutPaths), `warn 出现疑似码面 token：${line}`)
    }
  } finally {
    await rig.cleanup()
  }
})

test('B1-1b 引导码文件写入失败：warn 指引管理台且绝不回退印码面（不静默、不泄漏）', async () => {
  // stateDir 的父路径是普通文件 → mkdirSync ENOTDIR，写文件必失败
  const base = mkdtempSync(join(tmpdir(), 'dsh-notifier-b1-enotdir-'))
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, 'x')
  const rig = guidedBoot(join(blocker, 'nested'))
  try {
    assert.ok(rig.warnings.some((w) => /引导码文件写入失败/.test(w)), '写失败必须可见（宪法#3 静默即事故）')
    assert.ok(rig.warnings.some((w) => /【引导配对码】文件写入失败，请使用管理台铸码/.test(w)), '给出可用的替代路径')
    for (const line of rig.warnings) {
      const withoutPaths = line.replace(/\/\S+/g, '')
      assert.ok(!CODE_TOKEN.test(withoutPaths), `写失败路径不得回退印码面：${line}`)
    }
  } finally {
    await rig.cleanup()
  }
})

// win32 非管理员/非开发者模式主机不允许创建 symlink（EPERM）——探测能力，不具备即跳过
// （挡的是沙箱/主机能力，不挡攻击面语义；支持 symlink 的平台依旧全量断言写穿防护）。
const CAN_CREATE_SYMLINK = (() => {
  try {
    const probeDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-symlink-probe-'))
    const probeFile = join(probeDir, 'victim.txt')
    writeFileSync(probeFile, 'x')
    symlinkSync(probeFile, join(probeDir, 'link'))
    return true
  } catch {
    return false
  }
})()

test('B1-1c 引导码文件写入前先 unlink：预置 symlink 不被跟随写穿（symlink 攻击面）', { skip: !CAN_CREATE_SYMLINK }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-b1-symlink-'))
  const victim = join(stateDir, 'victim.txt')
  writeFileSync(victim, 'ORIGINAL')
  symlinkSync(victim, join(stateDir, 'bootstrap-paircode.txt'))
  const rig = guidedBoot(stateDir)
  try {
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL', 'symlink 目标不得被写穿（写前 unlink 生效）')
    assert.match(readFileSync(join(stateDir, 'bootstrap-paircode.txt'), 'utf8'), /^[A-Z2-9]{8}\n$/,
      '码文件本身是新建的普通文件')
  } finally {
    await rig.cleanup()
  }
})

test('B1-2c 启动清理：非引导态（allowUsers 非空）启动删掉上一轮残留码文件', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-b1-stale-'))
  const first = guidedBoot(stateDir) // 第一轮：引导态铸码写文件
  const codePath = join(stateDir, 'bootstrap-paircode.txt')
  assert.ok(existsSync(codePath), '前置：第一轮写了码文件')
  await first.cleanup()
  // 第二轮：白名单已配 → 非引导态，陈旧码文件必须被清
  const second = bootCtx()
  apply(second.ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    inbound: { stateDir, allowUsers: ['42'], telegram: { botToken: 'T0KEN', apiBase: 'http://127.0.0.1:1' } },
  })
  try {
    assert.ok(!existsSync(codePath), '引导态结束后不得残留码面文件')
  } finally {
    await second.cleanup()
  }
})
