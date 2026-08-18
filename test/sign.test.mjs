import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { computeDingTalkSign, dingTalkTimestamp, signedUrl as dingtalkSignedUrl } from '../src/adapters/dingtalk.mjs'
import { feishuSign, feishuTimestamp } from '../src/adapters/feishu.mjs'
import { barkEndpoint } from '../src/adapters/bark.mjs'

const SECRET = 'SEC8c9f1a2b3c4d5e6f'
const MS_TIMESTAMP = '1700000000000'

test('dingtalk 加签与官方算法已知用例一致（urlencode(base64(HmacSHA256))）', () => {
  const sign = computeDingTalkSign(SECRET, MS_TIMESTAMP)
  assert.equal(sign, 'nw2DJH9MlafhSsHNrpyAXxqp9TZcNqKQEdc3PzfQDOs%3D')
  const raw = decodeURIComponent(sign)
  const expected = createHmac('sha256', SECRET).update(MS_TIMESTAMP + '\n' + SECRET, 'utf8').digest('base64')
  assert.equal(raw, expected)
})

test('dingtalk signedUrl 追加 timestamp 与 sign；secret 为空原样返回', () => {
  const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=TOKEN'
  const url = dingtalkSignedUrl(webhook, SECRET, MS_TIMESTAMP)
  assert.ok(url.includes('access_token=TOKEN'))
  assert.ok(url.includes('timestamp=' + MS_TIMESTAMP))
  assert.ok(url.includes('sign=nw2DJH9MlafhSsHNrpyAXxqp9TZcNqKQEdc3PzfQDOs%3D'))
  assert.equal(dingtalkSignedUrl(webhook, undefined, MS_TIMESTAMP), webhook)
  assert.equal(dingtalkSignedUrl(webhook, '', MS_TIMESTAMP), webhook)
})

test('dingtalk 时间戳为 13 位毫秒；feishu 为 10 位秒', () => {
  assert.equal(dingTalkTimestamp(1700000000123), '1700000000123')
  assert.match(dingTalkTimestamp(), /^\d{13}$/)
  assert.equal(feishuTimestamp(1700000000123), '1700000000')
  assert.match(feishuTimestamp(), /^\d{10}$/)
})

test('feishu 加签 = base64(HmacSHA256(key=秒+换行+secret, data=空))，不 URL 编码（#8）', () => {
  const SECONDS = '1700000000'
  const sign = feishuSign(SECRET, SECONDS)
  // 飞书官方算法：stringToSign 是 HMAC 的 key，message 是空串，与钉钉（secret 当 key）不同。
  // 真值用 node -e createHmac('sha256', SECRET').update(SECONDS+'\n'+SECRET).update('') 独立算出，写死防回归。
  assert.equal(sign, 'Hkt69Qn6mNjkXHiSsldFT8wTESygypp9jaPOx4NIyRc=')
  const expected = createHmac('sha256', `${SECONDS}\n${SECRET}`).update('').digest('base64')
  assert.equal(sign, expected)
  assert.equal(sign, decodeURIComponent(sign)) // base64 未 URL 编码：与钉钉差异点
})

test('bark endpoint 组装：默认服务器 + 自定义服务器 + barkUrl 直连 + 尾斜杠清理', () => {
  assert.equal(barkEndpoint({ key: 'K1' }), 'https://api.day.app/K1')
  assert.equal(barkEndpoint({ key: 'K1' }).includes('K1'), true)
  assert.equal(barkEndpoint({ server: 'https://my.bark.example.com/', key: 'K2' }), 'https://my.bark.example.com/K2')
  assert.equal(barkEndpoint({ barkUrl: 'https://api.day.app/K3/' }), 'https://api.day.app/K3')
  assert.equal(barkEndpoint({}), '')
  assert.equal(barkEndpoint({ key: '' }), '')
})
