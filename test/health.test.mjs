// G-59 测试：health.mjs（渠道健康自检 runChannelTest）错误形态。
// 覆盖设计稿阶段 6 与 G-53 分层：
//  - 未知渠道 / 空渠道 → 失败回执带可用清单
//  - resolve 抛错（缺必填凭证）→ 中文指引原样进 detail
//  - 发送成功（webhook 全链路）→ 请求体断言（title/content/level）+ 自定义正文透传
//  - 发送失败：SSRF 拦截 / 网络错误 → detail 只含公开文案（G-53：不含响应体/底层原文）
//  - ${ENV:NAME} 引用发送前解析；缺失环境变量 → 配置校验失败
// 不发真实网络请求：公网 IP 字面量过 SSRF 查表（零 DNS 解析），fetch 全 mock。

import test from 'node:test'
import assert from 'node:assert/strict'
import { runChannelTest, TEST_MESSAGE } from '../src/health.mjs'

// 公网 IP 字面量：93.184.216.34 不在 SSRF 黑表（BLOCKED_V4）→ 查表即放行、不触发 DNS。
// 域名（如 example.com）会走 dns.lookup 真解析，测试环境断网时会误报「域名解析失败」。
const PUBLIC_HOOK = 'http://93.184.216.34/hook'

const okResponse = { ok: true, status: 200, json: async () => ({}), text: async () => '' }

/** 临时替换 fetch，fn 整体 settle 后恢复（finally 保证不泄漏到其他用例）。 */
async function withFetch(fn, impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('G-59 渠道自检：未知渠道与空渠道 → 失败回执含可用清单', async () => {
  const unknown = await runChannelTest({ type: 'nosuch', rawConfig: {} })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.channel, 'nosuch')
  assert.match(unknown.detail, /未知渠道 "nosuch"/)
  assert.match(unknown.detail, /可用：/) // 指引带 CHANNEL_TYPES 清单
  const empty = await runChannelTest({ type: '', rawConfig: {} })
  assert.equal(empty.ok, false)
  assert.match(empty.detail, /未知渠道 "\(空\)"/)
})

test('G-59 配置校验失败：resolve 抛错 → 中文指引原样进 detail（去哪拿凭证）', async () => {
  const tg = await runChannelTest({ type: 'telegram', rawConfig: {} })
  assert.equal(tg.ok, false)
  assert.match(tg.detail, /配置校验失败：telegram 未配置：.*botToken.*chatId/)
  const wb = await runChannelTest({ type: 'webhook', rawConfig: {} })
  assert.equal(wb.ok, false)
  assert.match(wb.detail, /配置校验失败：webhook 未配置：url/)
})

test('G-59 发送成功：webhook 全链路 + 请求体断言（title/content/level/自定义正文）', async () => {
  let captured = null
  const ok = await withFetch(
    () => runChannelTest({ type: 'webhook', rawConfig: { url: PUBLIC_HOOK }, message: 'G-59 自定义正文' }),
    async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init.body)) }
      return okResponse
    },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.detail, '已发送测试消息，请到客户端确认收到')
  assert.equal(captured.url, PUBLIC_HOOK)
  assert.equal(captured.body.title, 'dsh-notifier 自检')
  assert.equal(captured.body.content, 'G-59 自定义正文')
  assert.equal(captured.body.level, 'active')
})

test('G-59 默认正文：message 缺省/空串回落 TEST_MESSAGE；非空串原样透传', async () => {
  const bodies = []
  const run = (message) => withFetch(
    () => runChannelTest({ type: 'webhook', rawConfig: { url: PUBLIC_HOOK }, message }),
    async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return okResponse },
  )
  assert.equal((await run(undefined)).ok, true, '缺省 message')
  assert.equal((await run('')).ok, true, '空串 message')
  assert.equal((await run('  ')).ok, true, '纯空白串（实现契约：仅 !==\'\' 判空，不 trim）')
  assert.equal(bodies.length, 3)
  assert.equal(bodies[0].content, TEST_MESSAGE, '缺省 → TEST_MESSAGE')
  assert.equal(bodies[1].content, TEST_MESSAGE, '空串 → TEST_MESSAGE')
  assert.equal(bodies[2].content, '  ', '非空串（含空白）原样透传')
})

test('G-59 发送失败（SSRF 拦截）：detail 只含公开文案，指向 allowPrivateNetwork 逃生口', async () => {
  const blocked = await runChannelTest({ type: 'webhook', rawConfig: { url: 'http://127.0.0.1/hook' } })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.channel, 'webhook')
  assert.match(blocked.detail, /发送失败：Webhook目标被 SSRF 防护拒绝：环回/)
  assert.match(blocked.detail, /allowPrivateNetwork: true/) // 排障指引在公开文案里
})

test('G-59 发送失败（网络错误）：fetch 拒绝 → 公开文案不含底层 message', async () => {
  const failed = await withFetch(
    () => runChannelTest({ type: 'webhook', rawConfig: { url: PUBLIC_HOOK } }),
    async () => { throw new Error('ECONNREFUSED 127.0.0.1:443 (机器路径泄漏面)') },
  )
  assert.equal(failed.ok, false)
  assert.match(failed.detail, /发送失败：Webhook网络连接失败/)
  assert.ok(!failed.detail.includes('ECONNREFUSED'), '底层网络原文只进 stderr（G-53），不进公开 detail')
})

test('G-59 ${ENV:NAME} 引用：rawConfig 里的环境变量引用发送前被解析', async () => {
  process.env.DSH_HEALTH_TEST_HOOK = PUBLIC_HOOK
  try {
    let sent = null
    const ok = await withFetch(
      () => runChannelTest({ type: 'webhook', rawConfig: { url: '${ENV:DSH_HEALTH_TEST_HOOK}' } }),
      async (url) => { sent = String(url); return okResponse },
    )
    assert.equal(ok.ok, true)
    assert.equal(sent, PUBLIC_HOOK, '${ENV:} 引用解析后才进 send')
  } finally {
    delete process.env.DSH_HEALTH_TEST_HOOK
  }
})

test('G-59 ${ENV:NAME} 缺失：解析为空串 → 配置校验失败（与插件运行时同语义）', async () => {
  const missing = await runChannelTest({ type: 'webhook', rawConfig: { url: '${ENV:DSH_HEALTH_TEST_HOOK_NOT_SET}' } })
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /配置校验失败：webhook 未配置：url/)
})
