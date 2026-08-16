// v0.6 测试：public.mjs（开放事件源）。
// 覆盖设计稿 §7：facade 广播/限流/防御、no-op stub、source 穿透、emit、composeOnSend、
// deepFreeze、装配级（provide 注入 / 禁用 stub / emit 开关）与 PLUGINS.md 文档同步。
// fetch 全 mock（同 notify.test.mjs 手法），不发真实网络请求。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicFacade, composeOnSend, deepFreeze, PUBLIC_API_VERSION } from '../src/public.mjs'
import { createNotifier } from '../src/notify.mjs'
import { resolveConfig } from '../src/config.mjs'
import { apply } from '../src/index.mjs'

// ---------------------------------------------------------------- 测试基建

function makeLogger() {
  const warnings = []
  return { warnings, warn: (...args) => warnings.push(args.join(' ')) }
}

/** 可注入 fetch 的真 notifier（webhook 渠道）+ onSend record 捕获。 */
function makeRig({ channels = [{ type: 'webhook', url: 'http://x/hook' }], logger } = {}) {
  const resolved = resolveConfig({ channels })
  assert.equal(resolved.skipped.length, 0)
  const records = []
  const notifier = createNotifier({ logger: logger ?? { warn() {} } }, resolved.channels, {
    onSend: (record) => records.push(record),
  })
  return { notifier, records }
}

async function withFetch(ok = true, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, json: async () => ({}), text: async () => 'err' })
  try {
    // 必须 await：finally 在 fn 整体 settle 后才恢复 fetch（return fn() 会在首个 await 处提前恢复）
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** apply 级桩 ctx：可选 provide/emit spy。 */
function bootCtx({ provide = false, emit = false } = {}) {
  const state = {
    warnings: [],
    listeners: {},
    defs: [],
    effects: [],
    provided: [],
    unprovided: 0,
    emitted: [],
    ctx: {
      logger: { warn: (...a) => state.warnings.push(a.join(' ')), info() {} },
      tools: { register: (def) => { state.defs.push(def); return () => {} } },
      on: (event, fn) => { (state.listeners[event] ??= []).push(fn); return () => {} },
      effect: (fn) => { state.effects.push(fn) },
    },
  }
  if (provide) {
    state.ctx.provide = (name, value) => { state.provided.push({ name, value }); return () => { state.unprovided += 1 } }
  }
  if (emit) {
    state.ctx.emit = (event, payload) => { state.emitted.push({ event, payload }) }
  }
  return state
}

// ---------------------------------------------------------------- facade 广播

test('facade 广播：走 notifyAll 带 source，返回值同构 + source；record 带同一 source', async () => {
  const { notifier, records } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  await withFetch(true, async () => {
    const result = await facade.push({ title: 't', content: 'c' }, { sourceName: 'dsh-email' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.delivered, ['webhook'])
    assert.deepEqual(result.source, { kind: 'plugin', name: 'dsh-email' })
    assert.equal(records.length, 1)
    assert.deepEqual(records[0].source, { kind: 'plugin', name: 'dsh-email' })
    assert.deepEqual(records[0].delivered, ['webhook'])
  })
})

test('facade 定向推送：走 notify 单渠道路径，返回值适配为 outcome 形状', async () => {
  const { notifier, records } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  await withFetch(true, async () => {
    const result = await facade.push({ title: 't', content: 'c' }, { channel: 'webhook', sourceName: 'ci' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.delivered, ['webhook'])
    // §3.3 矩阵：单渠道不进 onSend（不记账不发事件，结果仅凭返回值）
    assert.equal(records.length, 0)
  })
})

test('facade 定向推送：skipped 与 failed 的形状适配', async () => {
  const { notifier: okNotifier } = makeRig()
  const facade = createPublicFacade({ notifier: okNotifier, logger: { warn() {} } })
  const skipped = await facade.push({ title: 't', content: 'c' }, { channel: 'telegram' }) // 未配置
  assert.equal(skipped.ok, false)
  assert.deepEqual(skipped.skipped, ['(telegram)'])
  await withFetch(false, async () => {
    const failed = await facade.push({ title: 't', content: 'c' }, { channel: 'webhook', sourceName: 'x' })
    assert.equal(failed.ok, false)
    assert.equal(failed.failed.length, 1)
    assert.equal(failed.failed[0].channel, 'webhook')
    assert.ok(failed.failed[0].error.length > 0)
  })
})

test('facade never-reject：notifyAll 内部抛错 → failed:[{reason:"internal"}]，绝不 reject', async () => {
  const broken = { notifyAll: async () => { throw new Error('boom') } }
  const logger = makeLogger()
  const facade = createPublicFacade({ notifier: broken, logger })
  const result = await facade.push({ title: 't', content: 'c' }, { sourceName: 'a' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.failed, [{ reason: 'internal' }])
  assert.ok(logger.warnings.some((w) => /内部异常/.test(w)))
})

// ---------------------------------------------------------------- 按源限流

test('按源限流：每源独立滑动窗（A 超限不影响 B）', async () => {
  const { notifier } = makeRig()
  let clock = 1_000_000
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 2 }, logger: { warn() {} }, now: () => clock })
  await withFetch(true, async () => {
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })).ok, true)
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })).ok, true, '额度 2 内第 2 次放行')
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })).skipped[0], '(rate-limited)', '第 3 次超限')
    assert.equal((await facade.push({ title: 'b', content: 'x' }, { sourceName: 'B' })).ok, true, 'B 独立窗口照常放行')
  })
})

test('限流拦截：返回 (rate-limited)，sink 收到完整 record（静音不等于没发生）', async () => {
  const { notifier } = makeRig()
  const sunk = []
  const facade = createPublicFacade({
    notifier,
    config: { limitPerMinutePerSource: 1 },
    logger: { warn() {} },
    sink: (record) => sunk.push(record),
  })
  await withFetch(true, async () => {
    await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })
    const limited = await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })
    assert.deepEqual(limited.skipped, ['(rate-limited)'])
    assert.equal(sunk.length, 1)
    assert.equal(sunk[0].ok, false)
    assert.deepEqual(sunk[0].source, { kind: 'plugin', name: 'A' })
    assert.equal(sunk[0].message.title, 'a')
  })
})

test('限流：limitPerMinutePerSource: 0 = 不限', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 0 }, logger: { warn() {} } })
  await withFetch(true, async () => {
    for (let i = 0; i < 12; i += 1) {
      const result = await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })
      assert.equal(result.ok, true, `第 ${i + 1} 次不应被限`)
    }
  })
})

test('限流：anonymous 共享单窗（两次匿名调用共享额度）', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 1 }, logger: { warn() {} } })
  await withFetch(true, async () => {
    assert.equal((await facade.push({ title: 'a', content: 'x' })).ok, true)
    const second = await facade.push({ title: 'a', content: 'x' }) // 不传 sourceName = anonymous
    assert.equal(second.skipped[0], '(rate-limited)')
    assert.equal(second.source.name, 'anonymous')
  })
})

test('限流：LRU 淘汰最旧源且 warn（容量 32）', async () => {
  const { notifier } = makeRig()
  const logger = makeLogger()
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 1 }, logger })
  await withFetch(true, async () => {
    for (let i = 0; i < 33; i += 1) {
      await facade.push({ title: 'a', content: 'x' }, { sourceName: `src-${i}` })
    }
    assert.ok(logger.warnings.some((w) => /限流表已满.*src-0.*窗口归零/.test(w)), '淘汰最旧源 src-0 必须 warn')
    // 被淘汰的 src-0 获得全新窗口（限流归零是已知安全代价，warn 已显性化）
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'src-0' })).ok, true)
  })
})

test('限流：滑动窗跨分钟恢复（t+60s 再放行）', async () => {
  const { notifier } = makeRig()
  let clock = 1_000_000
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 1 }, logger: { warn() {} }, now: () => clock })
  await withFetch(true, async () => {
    await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })).ok, false)
    clock += 60_001
    assert.equal((await facade.push({ title: 'a', content: 'x' }, { sourceName: 'A' })).ok, true, '窗口滑出后恢复')
  })
})

// ---------------------------------------------------------------- no-op stub

test('no-op stub：notifier=null 时 push 返回 (disabled)、flush 即 resolve、enabled()=false', async () => {
  const facade = createPublicFacade({ notifier: null, logger: { warn() {} } })
  assert.equal(facade.enabled(), false)
  const result = await facade.push({ title: 't', content: 'c' })
  assert.deepEqual(result.skipped, ['(disabled)'])
  assert.deepEqual(await facade.flush(), { ok: true })
  assert.equal(typeof facade.version, 'string')
})

test('facade version 与 PUBLIC_API_VERSION 一致；真 notifier 时 enabled()=true', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  assert.equal(facade.version, PUBLIC_API_VERSION)
  assert.equal(PUBLIC_API_VERSION, '0.6')
  assert.equal(facade.enabled(), true)
})

// ---------------------------------------------------------------- 输入防御

test('输入防御：非字符串 title/content 归一为空不炸；双空返回 (malformed) 且不推', async () => {
  const { notifier, records } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  const malformed = await facade.push({ title: Symbol('nope'), content: null })
  assert.deepEqual(malformed.skipped, ['(malformed)'])
  assert.equal(records.length, 0)
})

test('输入防御：双空不占限流名额', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, config: { limitPerMinutePerSource: 1 }, logger: { warn() {} } })
  await withFetch(true, async () => {
    const empty = await facade.push({ title: '', content: '' }, { sourceName: 'A' }) // 真双空（空白串不算空）
    assert.deepEqual(empty.skipped, ['(malformed)'])
    const next = await facade.push({ title: 'ok', content: 'x' }, { sourceName: 'A' })
    assert.equal(next.ok, true, 'malformed 不消耗 A 的额度')
  })
})

test('输入防御：20000 码点长度钳制（截断 + warn，码点安全）', async () => {
  const { notifier } = makeRig()
  const logger = makeLogger()
  const facade = createPublicFacade({ notifier, logger })
  const long = '🍅'.repeat(20_001) // 4 字节 emoji：UTF-16 slice 会把它截成乱码，Array.from 不会
  await withFetch(true, async () => {
    const result = await facade.push({ title: long, content: 'c' }, { sourceName: 'A' })
    assert.equal(result.ok, true)
    assert.ok(logger.warnings.some((w) => /超长.*截断/.test(w)))
  })
})

test('输入防御：非法 level 丢弃（undefined 交由下游兜底 active）', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  await withFetch(true, async () => {
    await facade.push({ title: 't', content: 'c', level: 'critical' }, { sourceName: 'A' })
    // 不炸即为过；level 归一细节由 notify.test 的 normalizeMessage 断言守
  })
})

test('输入防御：sourceName 归一（空/非字符串→anonymous，超长→64 截断）', async () => {
  const { notifier } = makeRig()
  const facade = createPublicFacade({ notifier, logger: { warn() {} } })
  await withFetch(true, async () => {
    assert.equal((await facade.push({ title: 't', content: 'c' }, { sourceName: '  ' })).source.name, 'anonymous')
    assert.equal((await facade.push({ title: 't', content: 'c' }, { sourceName: 42 })).source.name, 'anonymous')
    assert.equal((await facade.push({ title: 't', content: 'c' }, { sourceName: 'x'.repeat(100) })).source.name.length, 64)
  })
})

// ---------------------------------------------------------------- source 穿透（notify.mjs 侧）

test('source 穿透：无 source 时 record 不出现 source 键（旧行为逐字节不变）', async () => {
  const { notifier, records } = makeRig()
  await withFetch(true, async () => { await notifier.notifyAll({ title: 't', content: 'c' }) })
  assert.equal('source' in records[0], false)
})

test('source 穿透：quiet 路径 record 同带 source（静音不等于没发生）', async () => {
  const { notifier, records } = makeRig()
  await notifier.notifyAll({ title: 't', content: 'c' }, { quiet: true, source: { kind: 'plugin', name: 'q' } })
  assert.deepEqual(records[0].skipped, ['(quiet)'])
  assert.deepEqual(records[0].source, { kind: 'plugin', name: 'q' })
})

test('source 穿透：notifyAll 返回值形状不变（无 source 键——notify.test 全形状 deepEqual 的同款防线）', async () => {
  const { notifier } = makeRig()
  await withFetch(true, async () => {
    const outcome = await notifier.notifyAll({ title: 't', content: 'c' }, { source: { kind: 'plugin', name: 'x' } })
    assert.equal('source' in outcome, false)
    assert.deepEqual(Object.keys(outcome).sort(), ['delivered', 'failed', 'ok', 'skipped'])
  })
})

// ---------------------------------------------------------------- composeOnSend

test('composeOnSend：全空 → undefined（v0.5 边界语义不变）', () => {
  assert.equal(composeOnSend([]), undefined)
  assert.equal(composeOnSend([null, undefined]), undefined)
})

test('composeOnSend：逐项隔离——甲抛错乙照跑', () => {
  const seen = []
  const composed = composeOnSend([
    () => { throw new Error('甲炸了') },
    (record) => seen.push(record),
  ])
  composed({ tag: 1 })
  assert.deepEqual(seen, [{ tag: 1 }])
})

test('composeOnSend：与旧 if/else 双实现输出逐字节等价（同 record 对照）', () => {
  // 旧实现（index.mjs v0.5）：admin 开启时账本+hub 双挂
  const legacyLedger = []
  const legacyHub = []
  const legacyOnSend = (record) => { legacyLedger.push(JSON.stringify(record)); legacyHub.push(JSON.stringify(record)) }
  const newLedger = []
  const newHub = []
  const newOnSend = composeOnSend([
    (record) => newLedger.push(JSON.stringify(record)),
    (record) => newHub.push(JSON.stringify(record)),
  ])
  for (const record of [{ a: 1 }, { a: 2 }]) {
    legacyOnSend(structuredClone(record))
    newOnSend(structuredClone(record))
  }
  assert.deepEqual(newLedger, legacyLedger)
  assert.deepEqual(newHub, legacyHub)
})

// ---------------------------------------------------------------- deepFreeze

test('deepFreeze：message 与数组逐层冻结（delivered.push 抛 TypeError）', () => {
  const record = deepFreeze({
    time: 't',
    message: { title: 'x', content: 'y' },
    delivered: ['webhook'],
    skipped: [],
    failed: [{ channel: 'bark', error: 'e' }],
    source: { kind: 'plugin', name: 'a' },
  })
  assert.throws(() => { record.message.title = 'hack' }, TypeError)
  assert.throws(() => { record.delivered.push('fake') }, TypeError)
  assert.throws(() => { record.failed[0].channel = 'hack' }, TypeError)
  assert.equal(record.message.title, 'x')
})

test('deepFreeze：原始值/环引用/函数防御（不炸）', () => {
  assert.equal(deepFreeze('str'), 'str')
  assert.equal(deepFreeze(42), 42)
  const cyclic = { self: null }
  cyclic.self = cyclic
  const frozen = deepFreeze(cyclic)
  assert.equal(frozen, cyclic, '环引用原值返回不炸')
  const fn = () => {}
  assert.equal(deepFreeze(fn), fn)
})

// ---------------------------------------------------------------- 装配级（apply）

test('装配：宿主有 provide → ctx.provide("notifier", facade) 注册服务（spike 配方）', async () => {
  const state = bootCtx({ provide: true })
  const resolved = apply(state.ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  assert.equal(resolved.public.enabled, true)
  assert.equal(state.provided.length, 1)
  assert.equal(state.provided[0].name, 'notifier')
  assert.equal(state.provided[0].value.version, PUBLIC_API_VERSION)
})

test('装配：无 provide（测试桩宿主）→ 回退直接赋值 ctx.notifier', async () => {
  const state = bootCtx()
  apply(state.ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  assert.equal(typeof state.ctx.notifier?.push, 'function')
  assert.equal(state.ctx.notifier.version, '0.6')
})

test('装配：顶层 enabled:false → 仍提供 no-op stub（服务缺失会阻塞宿主启动），不注册工具', async () => {
  const state = bootCtx({ provide: true })
  apply(state.ctx, { enabled: false })
  assert.equal(state.defs.length, 0, '禁用时不注册 notify 工具')
  assert.equal(state.listeners['session/event'], undefined, '禁用时不挂事件监听')
  assert.equal(state.provided.length, 1, '但 notifier 服务必须照常提供')
  const stub = state.provided[0].value
  const result = await stub.push({ title: 't', content: 'c' })
  assert.deepEqual(result.skipped, ['(disabled)'])
  assert.deepEqual(await stub.flush(), { ok: true })
  assert.ok(state.warnings.some((w) => /no-op 形态照常提供/.test(w)))
})

test('装配：public.enabled:false → 真 notifier 在场也注入 stub（push 返回 (disabled)）', async () => {
  const state = bootCtx({ provide: true })
  apply(state.ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    public: { enabled: false },
  })
  const stub = state.provided[0].value
  assert.equal(stub.enabled(), false)
  const result = await stub.push({ title: 't', content: 'c' })
  assert.deepEqual(result.skipped, ['(disabled)'])
})

test('装配 + emit：push 一次 → dsh-notifier/sent 收到冻结的完整 record', async () => {
  const state = bootCtx({ provide: true, emit: true })
  apply(state.ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  const facade = state.provided[0].value
  await withFetch(true, async () => {
    const result = await facade.push({ title: 'et', content: 'ec' }, { sourceName: 'emit-test' })
    assert.equal(result.ok, true)
    assert.equal(state.emitted.length, 1)
    const { event, payload } = state.emitted[0]
    assert.equal(event, 'dsh-notifier/sent')
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.delivered, ['webhook'])
    assert.deepEqual(payload.source, { kind: 'plugin', name: 'emit-test' })
    assert.equal(typeof payload.time, 'string')
    assert.throws(() => { payload.delivered.push('hack') }, TypeError, 'payload 深冻结')
    assert.throws(() => { payload.message.title = 'hack' }, TypeError)
  })
})

test('装配 + emit：public.emit:false → 整链不发射（零开销家训）', async () => {
  const state = bootCtx({ provide: true, emit: true })
  apply(state.ctx, {
    channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    public: { emit: false },
  })
  const facade = state.provided[0].value
  await withFetch(true, async () => {
    await facade.push({ title: 't', content: 'c' }, { sourceName: 'A' })
    assert.equal(state.emitted.length, 0)
  })
})

test('装配 + emit：宿主无 ctx.emit → push 照常成功，仅 warn 一次（可观测降级）', async () => {
  const state = bootCtx({ provide: true }) // 无 emit
  apply(state.ctx, { channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }] })
  const facade = state.provided[0].value
  await withFetch(true, async () => {
    const result = await facade.push({ title: 't', content: 'c' }, { sourceName: 'A' })
    assert.equal(result.ok, true, 'emit 缺席不影响推送主链路')
    assert.ok(state.warnings.some((w) => /宿主不支持 ctx\.emit/.test(w)), '缺 emit 必须 warn 一次（可观测降级）')
  })
})

// ---------------------------------------------------------------- 文档同步（PLUGINS.md）

test('PLUGINS.md：版本字面量与 PUBLIC_API_VERSION 导出值一致（v0.4 版本号漏更教训同款防线）', () => {
  const text = readFileSync(new URL('../PLUGINS.md', import.meta.url), 'utf8')
  assert.ok(text.includes(`\`${PUBLIC_API_VERSION}\``), `PLUGINS.md 必须含公共面版本字面量 ${PUBLIC_API_VERSION}`)
  assert.ok(/ctx\.notifier\.version/.test(text), '版本探测说明存在')
})

test('PLUGINS.md：代码块可被 node --check（防文档腐烂）', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const text = readFileSync(new URL('../PLUGINS.md', import.meta.url), 'utf8')
  const blocks = [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.ok(blocks.length >= 4, '示例代码块数量合理')
  for (const [index, code] of blocks.entries()) {
    // 每块独立成文件过语法检查（export 语句在 .mjs 下合法）
    const file = join(tmpdir(), `dsh-plugins-doc-${index}.mjs`)
    writeFileSync(file, code)
    try {
      await run('node', ['--check', file])
    } finally {
      rmSync(file, { force: true })
    }
  }
})
