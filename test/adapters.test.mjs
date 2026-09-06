import test from 'node:test'
import assert from 'node:assert/strict'
import * as telegram from '../src/adapters/telegram.mjs'
import * as dingtalk from '../src/adapters/dingtalk.mjs'
import * as feishu from '../src/adapters/feishu.mjs'
import * as wxpusher from '../src/adapters/wxpusher.mjs'
import * as pushplus from '../src/adapters/pushplus.mjs'
import * as serverchan from '../src/adapters/serverchan.mjs'
import * as bark from '../src/adapters/bark.mjs'
import * as webhook from '../src/adapters/webhook.mjs'
import * as qqBot from '../src/adapters/qq-bot.mjs'
import { postJson, NotifyError } from '../src/adapters/_shared.mjs'

/** 用 stub fetch 捕获一次 send 的 url/body/contentType；json 可指定成功响应体。 */
function capture(json) {
  const originalFetch = globalThis.fetch
  const seen = { value: null }
  globalThis.fetch = async (url, init) => {
    seen.value = { url, body: init.body, headers: init.headers, contentType: init.headers['content-type'] }
    return { ok: true, status: 200, json: async () => json ?? {} }
  }
  return {
    /** 在 await send 之后调用，返回捕获到的请求信息并恢复全局 fetch。 */
    async done() {
      const value = seen.value
      globalThis.fetch = originalFetch
      return value
    },
  }
}

const MSG = { title: '标题', content: '正文 markdown **bold**', level: 'active', group: 'g1' }

test('telegram: URL 拼接 + 纯文本正文（title 与 content 合并）', async () => {
  const cap = capture({ ok: true, result: { message_id: 1 } })
  await telegram.send(telegram.resolve({ botToken: '123:ABC', chatId: '-100', apiBase: 'https://api.telegram.org' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
  const body = JSON.parse(seen.body)
  assert.equal(body.chat_id, '-100')
  assert.equal(body.text, '标题\n\n正文 markdown **bold**')
  assert.equal(body.disable_web_page_preview, true)
})

test('telegram: 自定义 apiBase 生效', async () => {
  const cap = capture({ ok: true, result: { message_id: 1 } })
  await telegram.send(telegram.resolve({ botToken: 't', chatId: 'c', apiBase: 'https://self-hosted.example.com/' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://self-hosted.example.com/bott/sendMessage')
})

test('telegram: resolve 缺失 botToken/chatId 抛中文指引', () => {
  assert.throws(() => telegram.resolve({}), (e) => e instanceof NotifyError && /botToken/.test(e.message))
  assert.throws(() => telegram.resolve({ botToken: 't' }), (e) => e instanceof NotifyError && /chatId/.test(e.message))
})

test('dingtalk: send 走加签 URL + markdown 负载', async () => {
  const cap = capture({ errcode: 0, errmsg: "ok" })
  await dingtalk.send(dingtalk.resolve({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=K', secret: 'S' }), MSG)
  const seen = await cap.done()
  assert.ok(seen.url.startsWith('https://oapi.dingtalk.com/robot/send?access_token=K'))
  assert.ok(seen.url.includes('timestamp='))
  assert.ok(seen.url.includes('sign='))
  const body = JSON.parse(seen.body)
  assert.equal(body.msgtype, 'markdown')
  assert.equal(body.markdown.title, '标题')
  assert.equal(body.markdown.text, '正文 markdown **bold**')
})

test('dingtalk: errcode 非 0 抛带中文指引的错误', async () => {
  const cap = capture({ errcode: 310000, errmsg: "sign not match" })
  await assert.rejects(
    dingtalk.send(dingtalk.resolve({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=K', secret: 'S' }), MSG),
    (e) => e instanceof NotifyError && /310000/.test(e.message) && /加签/.test(e.message),
  )
  await cap.done()
})

test('feishu: send 走原样 URL + interactive 卡片，#8 timestamp/sign 进 JSON body', async () => {
  const cap = capture({ code: 0, msg: "success" })
  await feishu.send(feishu.resolve({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/X', secret: 'S' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/X', '签名不得拼进 URL query')
  assert.equal(seen.url.includes('?'), false)
  const body = JSON.parse(seen.body)
  assert.equal(body.msg_type, 'interactive')
  assert.equal(body.card.header.title.content, '标题')
  assert.equal(body.card.elements[0].content, '正文 markdown **bold**')
  assert.match(body.timestamp, /^\d{10}$/, 'body 应含秒级 timestamp')
  assert.ok(typeof body.sign === 'string' && body.sign.length > 0, 'body 应含 sign')
  // 与秒级 timestamp 对应：sign 由同一 timestamp 算出
  assert.equal(body.sign, feishu.feishuSign('S', body.timestamp))
})

test('feishu: send 无 secret 时请求体不含 timestamp/sign（保持不加签名行为）', async () => {
  const cap = capture({ code: 0, msg: "success" })
  await feishu.send(feishu.resolve({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/X' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/X')
  const body = JSON.parse(seen.body)
  assert.equal('timestamp' in body, false, '无 secret 时 body 不含 timestamp')
  assert.equal('sign' in body, false, '无 secret 时 body 不含 sign')
})

test('wxpusher: 端点 + appToken + uids + contentType=1', async () => {
  const cap = capture({ code: 1000 })
  await wxpusher.send(wxpusher.resolve({ appToken: 'AT', uids: ['UID1', 'UID2'] }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://wxpusher.zjiecode.com/api/send/message')
  const body = JSON.parse(seen.body)
  assert.equal(body.appToken, 'AT')
  assert.deepEqual(body.uids, ['UID1', 'UID2'])
  assert.equal(body.contentType, 1)
  assert.equal(body.summary, '标题')
})

test('wxpusher: 无 uid 且无 topicId 时 resolve 拒绝', () => {
  assert.throws(() => wxpusher.resolve({ appToken: 'AT' }), /uids|topicIds/)
})

test('pushplus: 端点 + token + markdown template', async () => {
  const cap = capture({ code: 200 })
  await pushplus.send(pushplus.resolve({ token: 'PT' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://www.pushplus.plus/send')
  const body = JSON.parse(seen.body)
  assert.equal(body.token, 'PT')
  assert.equal(body.title, '标题')
  assert.equal(body.template, 'markdown')
})

test('pushplus: 合法 channel 透传到请求体', async () => {
  const cap = capture({ code: 200 })
  await pushplus.send(pushplus.resolve({ token: 'PT', channel: 'wechat' }), MSG)
  const seen = await cap.done()
  const body = JSON.parse(seen.body)
  assert.equal(body.channel, 'wechat')
})

test('pushplus: 非法 channel warn 并拒绝发送', async () => {
  const cap = capture({ code: 200 })
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try {
    assert.throws(
      () => pushplus.resolve({ token: 'PT', channel: 'wexchat' }),
      (e) => e instanceof NotifyError && /channel/.test(e.message),
    )
  } finally {
    console.error = original
  }
  const seen = await cap.done()
  assert.equal(seen, null)
  assert.ok(lines.some((line) => /pushplus/.test(line) && /wexchat/.test(line)))
})

test('serverchan: 端点含 sct + form 表单', async () => {
  const cap = capture({ code: 0 })
  await serverchan.send(serverchan.resolve({ sct: 'SCT123' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://sctapi.ftqq.com/SCT123.send')
  assert.match(seen.contentType, /application\/x-www-form-urlencoded/)
  const form = Object.fromEntries(new URLSearchParams(seen.body))
  assert.equal(form.title, '标题')
  assert.equal(form.desp, '正文 markdown **bold**')
})

test('serverchan: sendKey 别名可用', () => {
  assert.equal(serverchan.resolve({ sendKey: 'SK1' }).sct, 'SK1')
  assert.throws(() => serverchan.resolve({}), /SENDKEY/)
})

test('bark: JSON POST 到 endpoint，group/level 透传', async () => {
  const cap = capture({ code: 200 })
  await bark.send(bark.resolve({ key: 'K1' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://api.day.app/K1')
  const body = JSON.parse(seen.body)
  assert.equal(body.title, '标题')
  assert.equal(body.body, '正文 markdown **bold**')
  assert.equal(body.group, 'g1')
  assert.equal(body.level, 'active')
})

test('bark: 配 device → 请求体含 device（V2 多设备路由）', async () => {
  const cap = capture({ code: 200 })
  await bark.send(bark.resolve({ key: 'K1', device: 'iPhone15' }), MSG)
  const seen = await cap.done()
  const body = JSON.parse(seen.body)
  assert.equal(body.device, 'iPhone15')
})

test('bark: 不配 device → 请求体无 device 字段（行为兼容）', async () => {
  const cap = capture({ code: 200 })
  await bark.send(bark.resolve({ key: 'K1' }), MSG)
  const seen = await cap.done()
  const body = JSON.parse(seen.body)
  assert.equal('device' in body, false)
})

test('bark: 非 200 code 抛错误', async () => {
  const cap = capture({ code: 400, message: "bad request" })
  await assert.rejects(bark.send(bark.resolve({ key: 'K1' }), MSG), (e) => e instanceof NotifyError && /400/.test(e.message))
  await cap.done()
})

test('webhook: JSON 负载含 title/content/timestamp，headers 透传', async () => {
  const cap = capture()
  await webhook.send(webhook.resolve({ url: 'http://h/hook', headers: { 'x-token': 'abc' } }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'http://h/hook')
  const body = JSON.parse(seen.body)
  assert.equal(body.title, '标题')
  assert.equal(body.content, '正文 markdown **bold**')
  assert.ok(typeof body.timestamp === 'string')
  assert.equal(seen.headers['x-token'], 'abc')
})

test('webhook: resolve 缺失 url 抛中文指引', () => {
  assert.throws(() => webhook.resolve({}), /webhook 未配置/)
})

test('各 adapter 都导出 type', () => {
  assert.equal(telegram.type, 'telegram')
  assert.equal(dingtalk.type, 'dingtalk')
  assert.equal(feishu.type, 'feishu')
  assert.equal(wxpusher.type, 'wxpusher')
  assert.equal(pushplus.type, 'pushplus')
  assert.equal(serverchan.type, 'serverchan')
  assert.equal(bark.type, 'bark')
  assert.equal(webhook.type, 'webhook')
  assert.equal(qqBot.type, 'qq-bot')
})

// ===== W6 出站投递语义（G-50/08/09/56）=====

/** 两段式 fetch stub：第一次 token 换取，第二次消息投递（响应用 raw 字符串而非 Response.json 契约）。 */
function captureQq(messageResponse, tokenPayload = { access_token: 'T1', expires_in: 7200 }) {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    if (String(url).includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => tokenPayload }
    }
    return messageResponse
  }
  return { async done() { globalThis.fetch = originalFetch; return seen } }
}

test('qq-bot: 两段式成功投递（token 换取 + v2 消息）', async () => {
  const cap = captureQq({ ok: true, status: 200, json: async () => ({ id: 'msg1', timestamp: '1' }) })
  const resolved = qqBot.resolve({ appId: 'A1', appSecret: 'S1', groupId: 'G1' })
  await qqBot.send(resolved, MSG)
  const seen = await cap.done()
  assert.equal(seen.length, 2)
  assert.match(seen[0], /getAppAccessToken/)
  assert.match(seen[1], /\/v2\/groups\/G1\/messages/)
  assert.equal(resolved._msgSeq, 1)
})

test('qq-bot: 2xx 非 JSON（网关错误页）抛 BAD_UPSTREAM_RESPONSE，不再乐观当成功（G-56）', async () => {
  const cap = captureQq({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } })
  const resolved = qqBot.resolve({ appId: 'A1', appSecret: 'S1', groupId: 'G1' })
  await assert.rejects(() => qqBot.send(resolved, MSG), (error) => {
    assert.ok(error instanceof NotifyError)
    assert.equal(error.code, 'BAD_UPSTREAM_RESPONSE')
    assert.match(error.message, /2xx 但响应非 JSON/)
    return true
  })
  await cap.done()
})

test('qq-bot: 失败不推进 msg_seq（重试幂等基线锚定）', async () => {
  const cap = captureQq({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } })
  const resolved = qqBot.resolve({ appId: 'A1', appSecret: 'S1', targetType: 'user', userId: 'U1' })
  await assert.rejects(() => qqBot.send(resolved, MSG), /非 JSON/)
  await cap.done()
  assert.equal(resolved._msgSeq, 0)
})

test('qq-bot: expires_in=0 不再 || 7200 静默活两小时——TTL 归一 fail-closed 抛错（G-55）', async () => {
  const cap = captureQq({ ok: true, status: 200, json: async () => ({ id: 'm' }) }, { access_token: 'T1', expires_in: 0 })
  const resolved = qqBot.resolve({ appId: 'A1', appSecret: 'S1', groupId: 'G1' })
  await assert.rejects(() => qqBot.send(resolved, MSG), /TTL 非法/, '上游损坏响应必须失败可见，不得默认值掩盖')
  await cap.done()
})

test('serverchan: sctp 前缀 SENDKEY 走 sctp.ftqq.com 域名（G-09 SC3）', async () => {
  const cap = capture({ code: 0 })
  await serverchan.send(serverchan.resolve({ sct: 'SCTP1234' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://sctp.ftqq.com/SCTP1234.send')
})

test('serverchan: Turbo key 维持 sctapi 域名（G-09 回归锚定）', async () => {
  const cap = capture({ code: 0 })
  await serverchan.send(serverchan.resolve({ sct: 'SCT123' }), MSG)
  const seen = await cap.done()
  assert.equal(seen.url, 'https://sctapi.ftqq.com/SCT123.send')
})

test('serverchan: 三别名同时配置出声一次并按 sct 优先（G-09）', async () => {
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const cap = capture({ code: 0 })
    const resolved = serverchan.resolve({ sct: 'SCT1', sendKey: 'SK2', sctKey: 'SK3' })
    assert.equal(resolved.sct, 'SCT1')
    await serverchan.send(resolved, MSG)
    await serverchan.send(resolved, MSG) // 第二次不再出声
    await cap.done()
  } finally {
    console.error = originalError
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /sct、sendKey、sctKey/)
  assert.match(errors[0], /优先级取 sct/)
})

test('telegram: 429 限流应答解析 parameters.retry_after → retryAfterMs（G-08）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, error_code: 429, description: 'Too Many Requests: retry after 3',
    parameters: { retry_after: 3 },
  }), { status: 429, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      () => telegram.send(telegram.resolve({ botToken: '123:ABC', chatId: '-100' }), MSG),
      (error) => {
        assert.equal(error.status, 429)
        assert.equal(error.retryAfterMs, 3000)
        // G-53 分层：公开文案=渠道中文名+状态码；响应体片段只在 detail
        assert.equal(error.message, 'Telegram推送失败（HTTP 429）')
        assert.doesNotMatch(error.message, /retry after 3/)
        assert.doesNotMatch(error.publicMessage, /Too Many Requests/)
        assert.match(error.detail, /Too Many Requests: retry after 3/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('postJson: 网络层错误公开文案不带底层 message（代理地址/机器路径不外泄，G-53）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND proxy.corp.internal:8080 (via /etc/resolv.conf)')
  }
  try {
    await assert.rejects(
      () => postJson('https://api.example.com/x', {}, { channel: 'telegram', timeoutMs: 500 }),
      (error) => {
        assert.ok(error instanceof NotifyError)
        assert.equal(error.code, 'NETWORK_ERROR')
        assert.equal(error.message, 'Telegram网络连接失败')
        assert.doesNotMatch(error.publicMessage, /proxy\.corp\.internal|resolv\.conf/)
        assert.match(error.detail, /proxy\.corp\.internal:8080/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('postJson: 超时抛 noRetry 错误（结果未知，不盲目重试，G-50）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  try {
    await assert.rejects(
      () => postJson('https://example.invalid/x', {}, { timeoutMs: 30, channel: 'test' }),
      (error) => {
        assert.ok(error instanceof NotifyError)
        assert.equal(error.code, 'TIMEOUT')
        assert.equal(error.noRetry, true)
        assert.match(error.message, /结果未知/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// S-02：urlguard DNS 恒公网夹具（假域名不打真网，见 helpers/urlguard-public.mjs）
import './helpers/urlguard-public.mjs'
