import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger, yesterdayWindow, classifyTitle, composeDigest } from '../src/ledger.mjs'
import { runChannelTest } from '../src/health.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-notifier-ledger-'))
}

const record = (over = {}) => ({
  time: new Date('2026-08-14T10:00:00Z').toISOString(),
  message: { title: '✅ 任务完成', content: 'c', level: 'active' },
  ok: true,
  delivered: ['telegram'],
  failed: [],
  ...over,
})

test('classifyTitle 按标题前缀约定推断事件种类', () => {
  assert.equal(classifyTitle('✅ 任务完成'), 'completed')
  assert.equal(classifyTitle('前缀 ✅ 任务完成'), 'completed', '含 titlePrefix 也能子串命中')
  assert.equal(classifyTitle('❌ 任务出错'), 'error')
  assert.equal(classifyTitle('❌ Agent 执行出错'), 'agentError')
  assert.equal(classifyTitle('🔐 需要你批准'), 'approval')
  assert.equal(classifyTitle('⏹ 任务已中止'), 'aborted')
  assert.equal(classifyTitle('⚠️ 达到 Token 上限'), 'maxTokens')
  assert.equal(classifyTitle('📊 通知摘要'), 'digest')
  assert.equal(classifyTitle('随便什么'), 'other')
  assert.equal(classifyTitle(undefined), 'other')
})

test('ledger: append 落账 JSONL，read 按时间窗过滤', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir })
    ledger.append(record()) // 2026-08-14T10:00
    ledger.append(record({ time: new Date('2026-08-14T12:00:00Z').toISOString(), message: { title: '❌ 任务出错', content: 'x', level: 'timeSensitive' }, failed: [{ channel: 'bark', error: 'boom' }] }))
    ledger.append(record({ time: new Date('2026-08-15T00:00:00Z').toISOString() })) // 窗外

    const from = Date.parse('2026-08-14T00:00:00Z')
    const to = Date.parse('2026-08-15T00:00:00Z')
    assert.equal(ledger.read(from, to).length, 2)
    const summary = ledger.summarize(from, to)
    assert.equal(summary.counts.total, 2)
    assert.equal(summary.counts.completed, 1)
    assert.equal(summary.counts.error, 1)
    assert.equal(summary.failedDeliveries, 1, '渠道投递失败计数')
    assert.ok(existsSync(join(dir, 'ledger.jsonl')))
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0]).kind, 'completed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: source 落 JSONL（plugin 带 name；无 source 的行不出现该键）', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir })
    ledger.append(record({ source: { kind: 'plugin', name: 'dsh-email' } }))
    ledger.append(record())
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n')
    assert.equal(JSON.parse(lines[0]).source, 'dsh-email')
    assert.equal('source' in JSON.parse(lines[1]), false, '无 source 的行逐字节保持旧形状')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: digest 类不计入摘要（避免摘要的摘要）', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir })
    ledger.append(record())
    ledger.append(record({ message: { title: '📊 通知摘要', content: 'x', level: 'passive' } }))
    const from = Date.parse('2026-08-14T00:00:00Z')
    const to = Date.parse('2026-08-15T00:00:00Z')
    assert.equal(ledger.summarize(from, to).counts.total, 1, 'digest 被过滤')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 超过 2 倍上限时重写保留最新 maxEntries 条', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir, maxEntries: 50 })
    for (let index = 0; index < 120; index += 1) {
      ledger.append(record({ time: new Date(Date.parse('2026-08-14T00:00:00Z') + index * 1000).toISOString() }))
    }
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n')
    // 触发线是 2×maxEntries：重写回 maxEntries 条后继续累积到下一条触发线之前
    assert.ok(lines.length < 120, `确实发生了重写（实际 ${lines.length} 条 < 120）`)
    assert.ok(lines.length <= 100, `不超过下一触发线 2×maxEntries（实际 ${lines.length}）`)
    assert.ok(JSON.parse(lines[lines.length - 1]).at > JSON.parse(lines[0]).at, '保留的是最新记录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: markDigestDone/lastDigestDate 同日去重标记', () => {
  const dir = tempDir()
  try {
    const ledger = createLedger({ dir })
    assert.equal(ledger.lastDigestDate(), null)
    ledger.markDigestDone('2026-08-14')
    assert.equal(ledger.lastDigestDate(), '2026-08-14')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 脏行与不可写目录绝不抛错', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'ledger.jsonl'), 'not-json\n\n{broken\n')
    const ledger = createLedger({ dir })
    const from = Date.parse('2026-08-13T00:00:00Z')
    const to = Date.parse('2026-08-16T00:00:00Z')
    assert.deepEqual(ledger.read(from, to), [], '脏行跳过')
    // 不可写目录：用「文件占位的父路径」构造 ENOTDIR（不同内核/沙箱下立即失败，不依赖 /proc 行为）
    writeFileSync(join(dir, 'blocker'), 'x')
    const bad = createLedger({ dir: join(dir, 'blocker', 'nope') })
    bad.append(record()) // 不应抛错
    assert.equal(bad.lastDigestDate(), null, '状态读写失败回 null')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('composeDigest 中文摘要文案', () => {
  const text = composeDigest({
    from: '2026-08-14', to: '2026-08-15',
    counts: { total: 3, completed: 2, error: 1, agentError: 0, blocked: 0, aborted: 0, maxTokens: 0, interrupted: 0, approval: 0, other: 0 },
    failedDeliveries: 1,
  })
  assert.match(text, /共 3 条通知/)
  assert.match(text, /✅完成 x2/)
  assert.match(text, /❌出错 x1/)
  assert.match(text, /1 条渠道投递失败/)
  assert.equal(composeDigest({ from: 'a', to: 'b', counts: { total: 0 }, failedDeliveries: 0 }), '时间窗：a ~ b，无通知记录')
})

test('yesterdayWindow 返回昨日本地时间窗', () => {
  const fixed = new Date('2026-08-15T23:30:00').getTime()
  const window = yesterdayWindow(() => fixed)
  assert.equal(window.dateStr, '2026-08-14')
  assert.equal(window.toMs - window.fromMs, 24 * 60 * 60 * 1000)
  // 中午视角同样成立
  const noon = new Date('2026-08-15T12:00:00').getTime()
  assert.equal(yesterdayWindow(() => noon).dateStr, '2026-08-14')
})

// ---------- runChannelTest（health.mjs） ----------

test('runChannelTest: 未知渠道返回中文指引，不抛错', async () => {
  const result = await runChannelTest({ type: 'nope', rawConfig: {} })
  assert.equal(result.ok, false)
  assert.match(result.detail, /未知渠道/)
  assert.match(result.detail, /telegram/)
})

test('runChannelTest: 配置校验失败透传中文错误', async () => {
  const result = await runChannelTest({ type: 'bark', rawConfig: {} }) // bark 缺 key
  assert.equal(result.ok, false)
  assert.match(result.detail, /配置校验失败/)
  assert.match(result.detail, /bark/)
})

test('runChannelTest: 成功路径真发一条测试消息（mock fetch）', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return new Response(JSON.stringify({ code: 200 }), { status: 200 })
  }
  try {
    const result = await runChannelTest({ type: 'bark', rawConfig: { key: 'K' }, message: '自定义正文' })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    const body = JSON.parse(calls[0].body)
    assert.equal(body.title, 'dsh-notifier 自检')
    assert.equal(body.body, '自定义正文')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runChannelTest: ENV 引用先于校验解析', async () => {
  process.env.DSH_TEST_BARK_KEY_LEDGER = 'env-key'
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ code: 200 }), { status: 200 })
  }
  try {
    const result = await runChannelTest({ type: 'bark', rawConfig: { key: '${ENV:DSH_TEST_BARK_KEY_LEDGER}' } })
    assert.equal(result.ok, true)
    assert.match(calls[0], /env-key$/)
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_TEST_BARK_KEY_LEDGER
  }
})
