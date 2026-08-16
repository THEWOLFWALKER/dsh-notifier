// dsh-notifier test/contract.spec.mjs
// 参数化契约测试：循环 test/fixtures/channels/*.json，对每个渠道验证
//   1. resolve：合法配置通过；缺字段抛中文指引
//   2. mock fetch：断言 URL / method / headers / body 与 golden 完全一致
//   3. 成功 / 失败响应路径（失败 message 含排障指引）
//   4. secret 脱敏（SECRET_FIELDS 登记的字段不泄露明文）
// golden 数据参考 push-all-in-one 的 vitest 断言（各家 API 真实行为的记录）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ADAPTERS, normalizeMessage, maskChannelConfig } from '../src/config.mjs'
import { NotifyError } from '../src/adapters/_shared.mjs'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'channels')
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')))

/** 造一个按队列出队的 fetch mock：记录每次调用，按序返回 Response。 */
function mockFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fetchMock = async (url, init = {}) => {
    // v0.6.5（审查 R4-3-P1-1 教训）：用真实 Headers 构造一遍——mock 不校验 ByteString 时，
    // 非 ASCII 头值（如中文 x-title）测试期不炸、真机必炸（undici TypeError），
    // 契约测试假绿掩盖运行时必然故障。构造失败=请求失败，与真实 fetch 语义一致。
    new Headers(init.headers ?? {})
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    const next = queue.shift() ?? { status: 200, body: '' }
    const status = next.status ?? 200
    // 204/205/304 是 null-body 状态码，Response 构造器不允许携带 body
    const nullBodyStatus = status === 204 || status === 205 || status === 304
    return new Response(nullBodyStatus ? null : (next.body ?? ''), { status })
  }
  return { calls, fetchMock }
}

/** body 归一化为可比较形态：URLSearchParams → 对象；JSON 字符串 → 对象；其余字符串。 */
function bodyOf(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return { kind: 'json', value: JSON.parse(trimmed) } } catch { /* 保留字符串 */ }
    }
    return { kind: 'text', value: raw }
  }
  if (raw instanceof URLSearchParams) {
    const value = {}
    for (const [key, item] of raw.entries()) value[key] = item
    return { kind: 'form', value }
  }
  return { kind: 'json', value: raw }
}

function assertRequestMatches(actual, expected, type) {
  assert.equal(actual.method, expected.method, `${type}: method 不匹配`)
  assert.equal(actual.url, expected.url, `${type}: url 不匹配`)
  if (expected.headers !== undefined) {
    const normalized = {}
    for (const [key, value] of Object.entries(actual.headers)) normalized[String(key).toLowerCase()] = value
    for (const [key, value] of Object.entries(expected.headers)) {
      assert.equal(lowerHeader(normalized, key), value, `${type}: header ${key} 不匹配`)
    }
  }
  if (expected.bodyJson !== undefined) {
    assert.deepEqual(bodyOf(actual.body)?.value, expected.bodyJson, `${type}: JSON body 与 golden 不一致`)
  }
  if (expected.bodyForm !== undefined) {
    const parsed = bodyOf(actual.body)
    assert.equal(parsed?.kind, 'form', `${type}: 应为 form 编码`)
    assert.deepEqual(parsed.value, expected.bodyForm, `${type}: form body 与 golden 不一致`)
  }
  if (expected.bodyText !== undefined) {
    const parsed = bodyOf(actual.body)
    assert.ok(parsed?.kind === 'text' || typeof parsed?.value === 'string', `${type}: 应为纯文本 body`)
    assert.equal(parsed.value, expected.bodyText, `${type}: text body 与 golden 不一致`)
  }
}

function lowerHeader(headers, key) {
  return headers[String(key).toLowerCase()]
}

test('渠道 fixture 覆盖全部新渠道（spec + token 型）', () => {
  const covered = new Set(fixtures.map((fixture) => fixture.type))
  const expected = ['slack', 'discord', 'wecom', 'mattermost', 'gchat', 'teams', 'ntfy', 'gotify', 'pushover', 'chanify', 'pushdeer', 'xizhi', 'qmsg', 'igot', 'onebot', 'qq-bot', 'wecom-app']
  for (const type of expected) {
    assert.ok(covered.has(type), `缺少 fixture: ${type}`)
    assert.ok(ADAPTERS[type] !== undefined, `注册表缺少渠道: ${type}`)
  }
})

for (const fixture of fixtures) {
  test(`契约: ${fixture.type}`, async () => {
    const adapter = ADAPTERS[fixture.type]
    assert.ok(adapter !== undefined, `渠道未注册: ${fixture.type}`)

    // 1. resolve：合法配置通过
    const resolved = adapter.resolve(structuredClone(fixture.validConfig))

    // 1b. resolve：缺字段抛中文指引（NOT_CONFIGURED）
    assert.throws(
      () => adapter.resolve(structuredClone(fixture.invalidConfig)),
      (error) => error instanceof NotifyError && /未配置|必填/.test(error.message),
      `${fixture.type}: 缺字段应抛中文指引`,
    )

    // 2. mock fetch：断言请求与 golden 完全一致
    const { calls, fetchMock } = mockFetch(fixture.successResponses)
    globalThis.fetch = fetchMock
    try {
      await adapter.send(resolved, normalizeMessage(fixture.message))
    } finally {
      delete globalThis.fetch
    }
    assert.equal(calls.length, fixture.expectedRequests.length, `${fixture.type}: 请求次数不符`)
    fixture.expectedRequests.forEach((expected, index) => {
      assertRequestMatches(calls[index], expected, fixture.type)
    })

    // 3. 失败路径：前面的步骤照常成功，最后一步返回失败响应
    const failQueue = [...fixture.successResponses.slice(0, -1), fixture.failResponse]
    const failMock = mockFetch(failQueue)
    globalThis.fetch = failMock.fetchMock
    try {
      const resolvedAgain = adapter.resolve(structuredClone(fixture.validConfig))
      await assert.rejects(
        () => adapter.send(resolvedAgain, normalizeMessage(fixture.message)),
        (error) => {
          assert.ok(error instanceof Error, `${fixture.type}: 失败应为 Error`)
          if (fixture.errorMatch !== undefined) {
            assert.match(error.message, new RegExp(fixture.errorMatch), `${fixture.type}: 失败文案应含排障指引`)
          }
          // v0.6.5（审查 R4-3-P2-4）：错误信息永不回显完整凭证——原实现此处恒
          // return true（注释宣称校验但零断言），任何渠道未来把含 token 的完整
          // URL/Authorization 头写进错误文案都不会被测试抓住。改为硬断言。
          for (const field of fixture.secretFields ?? []) {
            const raw = fixture.validConfig[field]
            if (typeof raw === 'string' && raw.length > 4) {
              assert.ok(
                !error.message.includes(raw),
                `${fixture.type}: 错误文案不应回显 secret 明文（${field}）`,
              )
            }
          }
          return true
        },
      )
    } finally {
      delete globalThis.fetch
    }

    // 4. secret 脱敏：登记的 secret 字段不泄露明文
    for (const field of fixture.secretFields ?? []) {
      const masked = maskChannelConfig(fixture.type, { ...fixture.validConfig })
      const raw = fixture.validConfig[field]
      if (typeof raw === 'string' && raw.length > 4) {
        assert.ok(!JSON.stringify(masked).includes(raw), `${fixture.type}: 脱敏后不应包含明文 ${field}`)
      }
    }
  })
}
