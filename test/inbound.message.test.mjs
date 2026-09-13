// dsh-notifier inbound/message.mjs 统一入站消息模型测试（维护批 5）。
// 覆盖：文字兼容归一、结构化 image/file 归一、fail-closed（缺 url/未知结构/非对象）、
// 透传字段保留、QQ 单聊图片解析接口的 fixture 对照与拒绝矩阵。
// 注意：parseQQImageMessage 只测 fixture、【不接线】——真机确认 QQ extra 段形状
// 前，没有任何适配器 import 它（这是本批的协议纪律，不是缺陷）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  INBOUND_KINDS,
  downloadInboundImage,
  normalizeImageAttachment,
  normalizeImageUrl,
  parseQQImageMessage,
  parseExtraSegments,
  normalizeInboundMessage,
} from '../src/inbound/message.mjs'

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/qq-c2c-image.json', import.meta.url))
/** QQ C2C 图片事件样本（文档假设形状，见 parseQQImageMessage 注释；真机证据待补）。 */
const QQ_C2C_IMAGE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

test('normalizeInboundMessage：文字信封原样归一为 text（含透传字段）', () => {
  const result = normalizeInboundMessage({
    channel: 'telegram', userId: '42', chatId: '100', messageId: 'm1', text: '你好',
  })
  assert.equal(result.kind, INBOUND_KINDS.text)
  assert.equal(result.text, '你好')
  assert.equal(result.channel, 'telegram')
  assert.equal(result.userId, '42')
  assert.equal(result.chatId, '100')
  assert.equal(result.messageId, 'm1')
})

test('normalizeInboundMessage：结构化 image/file 归一对应 kind；附件缺 url 一律 null', () => {
  const img = normalizeInboundMessage({ kind: 'image', image: { url: 'https://x/a.png', width: 800, injected_control: true } })
  assert.equal(img.kind, INBOUND_KINDS.image)
  assert.equal(img.image.url, 'https://x/a.png')
  assert.equal(img.image.width, 800)
  assert.equal(img.image.injected_control, undefined, 'image 附件只保留白名单字段')
  const file = normalizeInboundMessage({ kind: 'file', file: { name: 'a.pdf', url: 'https://x/a.pdf', size: 1024 } })
  assert.equal(file.kind, INBOUND_KINDS.file)
  assert.equal(file.file.name, 'a.pdf')
  assert.equal(file.file.url, 'https://x/a.pdf')
  assert.equal(file.file.size, 1024)
  assert.equal(normalizeInboundMessage({ kind: 'image', image: { width: 800 } }), null, 'image 缺 url 拒绝')
  assert.equal(normalizeInboundMessage({ kind: 'file', file: { name: 'a.pdf' } }), null, 'file 缺 url 拒绝')
})

test('normalizeInboundMessage：未知结构 fail-closed（非对象/空文本/纯 kind/缺附件）', () => {
  assert.equal(normalizeInboundMessage(null), null)
  assert.equal(normalizeInboundMessage('text'), null)
  assert.equal(normalizeInboundMessage({ text: '' }), null, '空白文不产生空消息')
  assert.equal(normalizeInboundMessage({ kind: 'text' }), null, '无正文的非文本不伪装成 text')
  assert.equal(normalizeInboundMessage({ kind: 'image' }), null, '提 kind 不带附件拒绝')
  assert.equal(normalizeInboundMessage({ kind: 'video', ...({ image: { url: 'x' } }) }), null, '未知 kind 拒绝')
})

test('normalizeInboundMessage：既有 text + 合法图片附件 → 保留两者（不因 text!==\'\' 丢图）', () => {
  const result = normalizeInboundMessage({ kind: 'image', image: { url: 'https://x/a.png', width: 800 }, text: '说明文字' })
  assert.equal(result.kind, INBOUND_KINDS.text)
  assert.equal(result.text, '说明文字')
  assert.deepEqual(result.image, { url: 'https://x/a.png', width: 800 }, '文本+图片必须双载，不得丢图')
  // 无合法图片附件的纯文字仍只归一为 text（附件缺 url 不产生 image 段）
  const textOnly = normalizeInboundMessage({ text: '说明文字', image: { width: 800 } })
  assert.equal(textOnly.kind, INBOUND_KINDS.text)
  assert.equal(textOnly.image, undefined)
})

test('parseExtraSegments：JSON 字符串/已解析数组/畸形输入', () => {
  assert.deepEqual(parseExtraSegments('[{"type":1,"image":{"url":"u"}}]'), [{ type: 1, image: { url: 'u' } }])
  assert.deepEqual(parseExtraSegments([{ type: 1 }]), [{ type: 1 }], '已解析数组原样透传')
  assert.equal(parseExtraSegments('{not-json'), null)
  assert.equal(parseExtraSegments(''), null)
  assert.equal(parseExtraSegments(42), null, '数字 extra 不解析')
})

test('normalizeImageAttachment：只保留安全 URL 与有界尺寸，未知字段不透传', () => {
  const image = normalizeImageAttachment({
    url: 'https://media.example.test/a.png', width: 800, height: 600, injected_control: { approve: true },
  })
  assert.deepEqual(image, { url: 'https://media.example.test/a.png', width: 800, height: 600 })
  assert.equal(normalizeImageAttachment({ url: 'javascript:alert(1)' }), null)
  assert.equal(normalizeImageAttachment({ url: 'https://user:secret@media.example.test/a.png' }), null)
  assert.deepEqual(normalizeImageAttachment({ url: 'https://media.example.test/a.png', width: 100001 }), {
    url: 'https://media.example.test/a.png',
  })
})

test('normalizeImageUrl：SSRF 硬边界拒绝私有/回环/映射 IPv6（含 IPv4-mapped 绕过）', () => {
  const blocked = [
    'http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/latest', 'http://10.0.0.1/x',
    'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://[::1]/x', 'http://[fe80::1]/x', 'http://[fc00::1]/x',
    // IPv4-mapped IPv6：Node URL 规范化为 hex 形式（::ffff:7f00:1 等），曾绕过纯 IPv6 前缀判断
    'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:169.254.169.254]/x', 'http://[::ffff:10.0.0.1]/x',
    'http://[::ffff:192.168.1.1]/x', 'http://[::ffff:172.16.0.1]/x',
    'http://metadata.google.internal/x', 'http://host.internal/x',
  ]
  for (const url of blocked) assert.equal(normalizeImageUrl(url), '', `应拒绝 ${url}`)
  const allowed = [
    'https://media.example.com/a.png', 'http://[::ffff:8.8.8.8]/x', 'https://cdn.example.org/x/y.png?q=1',
  ]
  for (const url of allowed) assert.notEqual(normalizeImageUrl(url), '', `应放行 ${url}`)
})

test('downloadInboundImage：超时、非图片和声明/实际超限均 fail-closed，不保留二进制', async () => {
  const tooLargeHeader = await downloadInboundImage('https://media.example.test/a.png', {
    fetchImpl: async () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': '5242881' } }),
  })
  assert.equal(tooLargeHeader, null)
  const tooLargeBody = await downloadInboundImage('https://media.example.test/b.png', {
    maxBytes: 2,
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
  })
  assert.equal(tooLargeBody, null)
  const nonImage = await downloadInboundImage('https://media.example.test/c.txt', {
    fetchImpl: async () => new Response('x', { headers: { 'content-type': 'text/plain' } }),
  })
  assert.equal(nonImage, null)
  const timedOut = await downloadInboundImage('https://media.example.test/d.png', {
    timeoutMs: 1,
    fetchImpl: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  })
  assert.equal(timedOut, null)
})

test('parseQQImageMessage：fixture 对照（文档假设形状）解析出图片 URL', () => {
  const parsed = parseQQImageMessage(QQ_C2C_IMAGE)
  assert.ok(parsed !== null)
  assert.equal(parsed.kind, INBOUND_KINDS.image)
  assert.equal(parsed.image.url, 'https://example.invalid/qq-c2c/fixture-001.png')
  assert.equal(parsed.image.width, 800)
  assert.equal(parsed.image.height, 600)
})

test('parseQQImageMessage：拒绝矩阵（无 extra/无图片段/段缺 url/extra 畸形/非对象）', () => {
  assert.equal(parseQQImageMessage({ extra: '[]' }), null, '空段数组')
  assert.equal(parseQQImageMessage({ extra: '[{"type":2,"image":{"url":"u"}}]' }), null, 'type=2 非图片段')
  assert.equal(parseQQImageMessage({ extra: '[{"type":1,"image":{"width":10}}]' }), null, '图片段缺 url')
  assert.equal(parseQQImageMessage({ extra: '{broken' }), null, 'extra JSON 畸形')
  assert.equal(parseQQImageMessage({}), null, '无 extra 字段')
  assert.equal(parseQQImageMessage(null), null)
  assert.equal(parseQQImageMessage({ extra: [null] }), null)
})

test('parseQQImageMessage：extra 已解析数组（部分网关预解析）也可直用', () => {
  const parsed = parseQQImageMessage({ extra: [{ type: 'image', image: { url: 'https://y/x.png' } }] })
  assert.ok(parsed !== null)
  assert.equal(parsed.image.url, 'https://y/x.png')
})
