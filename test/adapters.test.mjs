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
import { NotifyError } from '../src/adapters/_shared.mjs'

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

test('feishu: send 走加签 URL + interactive 卡片', async () => {
  const cap = capture({ code: 0, msg: "success" })
  await feishu.send(feishu.resolve({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/X', secret: 'S' }), MSG)
  const seen = await cap.done()
  assert.ok(seen.url.startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/X'))
  assert.ok(seen.url.includes('timestamp='))
  assert.ok(seen.url.includes('sign='))
  const body = JSON.parse(seen.body)
  assert.equal(body.msg_type, 'interactive')
  assert.equal(body.card.header.title.content, '标题')
  assert.equal(body.card.elements[0].content, '正文 markdown **bold**')
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
})
