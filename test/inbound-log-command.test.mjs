// v0.11 Commit20 — 手机侧 `/log` 敏感诊断命令（plan §11）。
// 安全定位：**默认关 + owner-only + 脱敏 + 有界**，不是普通聊天命令。
// 数据源单一：通知账本 `ledger.recent()`（账本无 sessionId 语义 → 口径如实写作
// 「最近通知/事件摘要」，绝不谎称「当前会话日志」）；绝不读 session.events / snapshotEvents。
// 覆盖矩阵：权限（owner/member/identity 缺/list 抛错/跨渠道 owner）、开关（缺省关/false/开）、
// 账本（空/一条/20 条/N smaller/N above max/recent 抛错/ledger 缺）、参数解析（无参/0/负/小数/
// 垃圾/多余参数）、脱敏、行数上限、UTF-8 字节上限（emoji/中文/ASCII 无孤立代理项）、zh+en、
// 未配对不可达、静态守卫（生产代码零 session.events/snapshotEvents）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'
import { stringsOf } from '../src/strings.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-notifier-log-')), 'state.json')
}

let seq = 0
function makeEntry({ title = '任务完成', kind = 'turn', level = 'info', delivered = ['telegram'], failed = [] } = {}) {
  seq += 1
  return {
    at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    kind, level, title, delivered, failed,
  }
}

/** owner 是 channel-scoped：仅 'telegram' 渠道的 42 是 owner。 */
const telegramOwner = { list: (channel) => (channel === 'telegram' ? [{ userId: '42', role: 'owner' }] : []) }

/**
 * 测试替身账本（copy-on-read）：`recent(n)` 返回最近 n 条（正序）并记录调用实参，
 * 便于断言「命令层是否已按 maxLines clamp 后再取」。
 */
function makeLedger(entries = []) {
  const calls = []
  return {
    calls,
    recent: (n) => {
      const limit = Math.max(0, Math.trunc(Number(n) || 0))
      calls.push(limit)
      return entries.slice(-limit).map((entry) => JSON.parse(JSON.stringify(entry)))
    },
  }
}

function makeRig({
  entries = [],
  identity,
  ledger,
  remoteLog,
  lang = 'zh',
  allowUsers = ['42'],
  withRemoteLog = true,
  withIdentity = true,
  withLedger = true,
} = {}) {
  const store = createStore(tempPath())
  const bus = createInboundBus({ allowUsers, store })
  const replies = []
  const t = stringsOf(lang).conversation
  const deps = {
    ctx: { agents: { get: () => undefined, list: () => [] }, on: () => () => {} },
    bus,
    store,
    reply: (channel, chatId, text) => replies.push({ channel, chatId, text }),
    config: { mergeWindowMs: 0 },
    logger: null,
    channelTypes: () => ['telegram'],
  }
  if (withIdentity) deps.identity = identity === undefined ? telegramOwner : identity
  if (withLedger) deps.ledger = ledger === undefined ? makeLedger(entries) : ledger
  if (withRemoteLog) deps.remoteLog = remoteLog === undefined ? { enabled: true, maxLines: 200, maxBytes: 8192 } : remoteLog
  const dispose = registerConversationRouter(deps, stringsOf(lang))
  const say = async (text, { userId = '42' } = {}) => {
    bus.accept({ channel: 'telegram', userId, chatId: userId, messageId: `m${Math.random()}`, text })
    await sleep(15)
    return replies.at(-1)?.text
  }
  return { replies, dispose, say, t }
}

// ---------------------------------------------------------------- 开关（默认关）

test('/log 未注入 remoteLog：deps 缺省视为未开启（默认关）', async () => {
  const rig = makeRig({ entries: [makeEntry()], withRemoteLog: false })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logDisabled)
  rig.dispose()
})

test('/log remoteLog.enabled=false：回 disabled（不泄露账本）', async () => {
  const rig = makeRig({ entries: [makeEntry()], remoteLog: { enabled: false, maxLines: 200, maxBytes: 8192 } })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logDisabled)
  assert.equal(text.includes('任务完成'), false, '未开启不得回任何账本内容')
  rig.dispose()
})

// ---------------------------------------------------------------- 权限 owner-only

test('/log owner：允许，返回摘要', async () => {
  const rig = makeRig({ entries: [makeEntry({ title: '任务完成' })] })
  const text = await rig.say('/log')
  assert.equal(text.includes(rig.t.logSummaryHeader(1)), true)
  assert.equal(text.includes('任务完成'), true)
  rig.dispose()
})

test('/log member：拒绝（仅 owner 可用，不泄露谁是 owner）', async () => {
  const rig = makeRig({ entries: [makeEntry()], identity: { list: () => [{ userId: '42', role: 'member' }] } })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logOwnerOnly)
  assert.equal(text.includes('任务完成'), false)
  rig.dispose()
})

test('/log identity 缺失：fail-closed 拒绝', async () => {
  const rig = makeRig({ entries: [makeEntry()], withIdentity: false })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logOwnerOnly)
  rig.dispose()
})

test('/log identity.list 抛错：fail-closed 拒绝，绝不 crash', async () => {
  const rig = makeRig({ entries: [makeEntry()], identity: { list: () => { throw new Error('identity bomb') } } })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logOwnerOnly)
  rig.dispose()
})

test('/log 跨渠道 owner：同 userId 在别的渠道是 owner 不算数（channel-scoped）', async () => {
  const rig = makeRig({
    entries: [makeEntry()],
    identity: { list: (channel) => (channel === 'wechat' ? [{ userId: '42', role: 'owner' }] : []) },
  })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logOwnerOnly, 'telegram 渠道未登记 owner → 拒绝')
  rig.dispose()
})

test('/log 未配对身份：根本触达不到命令（无回执）', async () => {
  const rig = makeRig({ entries: [makeEntry()] })
  await rig.say('/log', { userId: '99' })
  assert.equal(rig.replies.length, 0, '未配对用户不得触达 /log')
  rig.dispose()
})

// ---------------------------------------------------------------- 账本数据

test('/log 空账本：回 empty', async () => {
  const rig = makeRig({ entries: [] })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logEmpty)
  rig.dispose()
})

test('/log 一条记录：header 标 1，单行含 time/kind/title/计数', async () => {
  const entry = makeEntry({ title: '任务出错', kind: 'error', level: 'error', delivered: ['telegram'], failed: ['wechat'] })
  const rig = makeRig({ entries: [entry] })
  const text = await rig.say('/log')
  assert.equal(text.includes(rig.t.logSummaryHeader(1)), true)
  assert.equal(text.includes('任务出错'), true)
  assert.equal(text.includes('✔1 ✘1'), true, 'delivered/failed 计数')
  rig.dispose()
})

test('/log 无参：缺省取 20 条', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => makeEntry({ title: `t${index}` }))
  const ledger = makeLedger(entries)
  const rig = makeRig({ ledger })
  const text = await rig.say('/log')
  assert.equal(text.includes(rig.t.logSummaryHeader(20)), true)
  assert.equal(text.split('\n').length - 1, 20, 'header + 20 行')
  assert.equal(ledger.calls.at(-1), 20, '命令层向 recent 传 20')
  rig.dispose()
})

test('/log N smaller：只取 N 条（从最新往前）', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => makeEntry({ title: `t${index}` }))
  const rig = makeRig({ entries })
  const text = await rig.say('/log 3')
  assert.equal(text.includes(rig.t.logSummaryHeader(3)), true)
  assert.equal(text.includes('t24'), true, '含最新')
  assert.equal(text.includes('t22'), true)
  assert.equal(text.includes('t21'), false, '不越界')
  rig.dispose()
})

test('/log N above max：clamp 到 maxLines（§11.5 用户不能放大）', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => makeEntry({ title: `t${index}` }))
  const ledger = makeLedger(entries)
  const rig = makeRig({ ledger, remoteLog: { enabled: true, maxLines: 5, maxBytes: 8192 } })
  const text = await rig.say('/log 100')
  assert.equal(ledger.calls.at(-1), 5, 'recent 实参被 clamp 到 5')
  assert.equal(text.includes(rig.t.logSummaryHeader(5)), true)
  assert.equal(text.split('\n').length - 1, 5, '最多 5 records（§11.34 line cap）')
  rig.dispose()
})

test('/log ledger 缺省：回 unavailable（账本未运行）', async () => {
  const rig = makeRig({ withLedger: false })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logUnavailable)
  rig.dispose()
})

test('/log ledger.recent 抛错：回 unavailable，绝不 crash', async () => {
  const rig = makeRig({ ledger: { recent: () => { throw new Error('ledger bomb') } } })
  const text = await rig.say('/log')
  assert.equal(text, rig.t.logUnavailable)
  rig.dispose()
})

// ---------------------------------------------------------------- 参数解析

test('/log 参数解析：0/负数/小数/垃圾/多余参数 → usage', async () => {
  const rig = makeRig({ entries: [makeEntry()] })
  const usage = rig.t.logUsage(20, 200)
  for (const bad of ['/log 0', '/log -3', '/log 3.5', '/log abc', '/log 0x10', '/log +3', '/log 1e3', '/log 3 extra']) {
    const text = await rig.say(bad)
    assert.equal(text, usage, `「${bad}」应回 usage`)
  }
  rig.dispose()
})

// ---------------------------------------------------------------- 脱敏

test('/log 标题脱敏：token-like 文本不得原样出现（走 maskSecrets 正式入口）', async () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx',
    'abcdefghijklmnopqrstuvwxyz0123',
    'deadbeefdeadbeefdeadbeefdeadbeef',
  ]
  const title = `token=${secrets[0]} Authorization: Bearer ${secrets[1]} password=${secrets[2]}`
  const rig = makeRig({ entries: [makeEntry({ title })] })
  const text = await rig.say('/log')
  assert.equal(text.includes('***'), true, '出现打码标记')
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `密钥形态 ${secret.slice(0, 8)}… 不得原样出现`)
  }
  rig.dispose()
})

// ---------------------------------------------------------------- UTF-8 字节上限

test('/log 字节上限：emoji/中文/ASCII 混排，最终 UTF-8 ≤ maxBytes 且无孤立代理项', async () => {
  const title = '中文😀abc'.repeat(200)
  const rig = makeRig({ entries: [makeEntry({ title })], remoteLog: { enabled: true, maxLines: 200, maxBytes: 256 } })
  const text = await rig.say('/log')
  const bytes = new TextEncoder().encode(text).length
  assert.ok(bytes <= 256, `UTF-8 字节 ${bytes} 应 ≤ 256`)
  assert.equal(text.endsWith(rig.t.logTruncated), true, '追加 localized 截断标记')
  assert.equal(text.isWellFormed(), true, '无半个代理项（按 code point 截断）')
  rig.dispose()
})

test('/log 字节上限：未超限时原样返回，无截断标记', async () => {
  const rig = makeRig({ entries: [makeEntry({ title: '短标题' })], remoteLog: { enabled: true, maxLines: 200, maxBytes: 8192 } })
  const text = await rig.say('/log')
  assert.equal(text.includes(rig.t.logTruncated), false)
  rig.dispose()
})

// ---------------------------------------------------------------- 双语

test('/log 英文文案：disabled / usage / empty / header 均为英文', async () => {
  const disabled = makeRig({ entries: [makeEntry()], remoteLog: { enabled: false }, lang: 'en' })
  assert.equal(await disabled.say('/log'), disabled.t.logDisabled)
  assert.equal(disabled.t.logDisabled.includes('远程'), false)
  disabled.dispose()

  const rig = makeRig({ entries: [makeEntry({ title: 'done' })], lang: 'en' })
  const header = await rig.say('/log')
  assert.equal(header.includes(rig.t.logSummaryHeader(1)), true)
  assert.equal(header.includes('Recent notifications/events summary'), true)
  const usage = await rig.say('/log 0')
  assert.equal(usage, rig.t.logUsage(20, 200))
  rig.dispose()

  const empty = makeRig({ entries: [], lang: 'en' })
  assert.equal(await empty.say('/log'), empty.t.logEmpty)
  empty.dispose()
})

// ---------------------------------------------------------------- 静态守卫

test('静态守卫：index 装配——remoteLog 单独开启建账本，但晨报仍只由 digest.enabled 决定', () => {
  const src = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(ledgerEnabled \|\| remoteLogEnabled\)/, '账本创建条件含 remoteLog 单独开启（/log 数据源）')
  assert.match(src, /if \(ledgerEnabled && ledger !== null\)/, '晨报守卫看 digest.enabled，不被 remoteLog 顺带触发')
  assert.doesNotMatch(src, /if \(ledger !== null\) \{\n\s*try \{\n\s*const window = yesterdayWindow/, '晨报块不得仅以「账本存在」为守卫')
})

test('静态守卫：生产 src/ 零 session.events / snapshotEvents 调用（仅注释可提及）', () => {
  const files = [
    'src/event-listener.mjs',
    'src/inbound/conversation.mjs',
    'src/host/native-questions.mjs',
  ]
  for (const file of files) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const line of src.split('\n')) {
      if (!line.includes('session.events') && !line.includes('snapshotEvents')) continue
      const trimmed = line.trim()
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
      assert.equal(isComment, true, `${file} 出现非注释的 ${trimmed.slice(0, 60)}`)
    }
  }
})