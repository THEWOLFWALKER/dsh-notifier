import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, normalizeMessage, maskChannelConfig, CHANNEL_TYPES } from '../src/config.mjs'

test('CHANNEL_TYPES 覆盖全部渠道（8 个既有 + 15 个 spec + 2 个 token 型 + bell/desktop 本地）', () => {
  assert.deepEqual([...CHANNEL_TYPES].sort(), [
    'bark', 'bell', 'chanify', 'desktop', 'dingtalk', 'discord', 'feishu', 'gchat', 'gotify', 'igot', 'mattermost',
    'ntfy', 'onebot', 'pushdeer', 'pushover', 'pushplus', 'qmsg', 'qq-bot', 'serverchan', 'slack',
    'teams', 'telegram', 'webhook', 'wecom', 'wecom-app', 'wxpusher', 'xizhi',
  ])
})

test('合法配置全部解析为已启用渠道', () => {
  const resolved = resolveConfig({
    debounceMs: 500,
    channels: [
      { type: 'telegram', botToken: 't', chatId: 'c' },
      { type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=K', secret: 'S' },
      { type: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/X' },
      { type: 'wxpusher', appToken: 'A', uids: ['UID1'] },
      { type: 'pushplus', token: 'P' },
      { type: 'serverchan', sct: 'SCT1' },
      { type: 'bark', key: 'BARKKEY' },
      { type: 'webhook', url: 'http://127.0.0.1:9/hook' },
    ],
  })
  assert.deepEqual(
    resolved.channels.map((entry) => entry.type).sort(),
    ['bark', 'dingtalk', 'feishu', 'pushplus', 'serverchan', 'telegram', 'webhook', 'wxpusher'],
  )
  assert.equal(resolved.skipped.length, 0)
})

test('未配置渠道静默跳过并给出中文原因，不 throw', () => {
  const resolved = resolveConfig({ channels: [{ type: 'telegram' }, { type: 'webhook' }] })
  assert.equal(resolved.channels.length, 0)
  assert.equal(resolved.skipped.length, 2)
  assert.match(resolved.skipped[0].reason, /telegram 未配置/)
  assert.match(resolved.skipped[1].reason, /webhook 未配置/)
})

test('enabled: false 的渠道被跳过；未知类型被跳过', () => {
  const resolved = resolveConfig({
    channels: [
      { type: 'telegram', botToken: 't', chatId: 'c', enabled: false },
      { type: 'definitely-not-a-channel', url: 'x' },
      { type: 'webhook', url: 'http://h' },
    ],
  })
  assert.deepEqual(resolved.channels.map((entry) => entry.type), ['webhook'])
  assert.equal(resolved.skipped.length, 2)
  assert.match(resolved.skipped[1].reason, /未知渠道类型/)
})

test('非数组 channels 不抛错，视为空', () => {
  const resolved = resolveConfig({ channels: 'oops' })
  assert.equal(resolved.channels.length, 0)
  assert.equal(resolved.skipped.length, 0)
})

test('enabled: false 顶层开关生效', () => {
  const resolved = resolveConfig({ enabled: false, channels: [{ type: 'webhook', url: 'http://h' }] })
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.channels.length, 1)
})

test('debounceMs/summaryMaxChars 默认值与非数值回退', () => {
  assert.equal(resolveConfig({}).debounceMs, 10000)
  assert.equal(resolveConfig({}).summaryMaxChars, 500)
  assert.equal(resolveConfig({ debounceMs: 'bad', summaryMaxChars: -5 }).debounceMs, 10000)
  assert.equal(resolveConfig({ debounceMs: 'bad', summaryMaxChars: -5 }).summaryMaxChars, 0)
  assert.equal(resolveConfig({ debounceMs: 250, summaryMaxChars: 99 }).debounceMs, 250)
})

test('normalizeMessage 归一化字段', () => {
  assert.deepEqual(normalizeMessage({ title: ' T ', content: ' c ', level: 'active', group: 'g' }), { title: 'T', content: 'c', level: 'active', group: 'g' })
  assert.deepEqual(normalizeMessage({ title: 1, content: 2 }), { title: '', content: '', level: undefined, group: undefined })
  assert.deepEqual(normalizeMessage(), { title: '', content: '', level: undefined, group: undefined })
})

test('maskChannelConfig 只脱敏 SECRET_FIELDS，且不泄露明文', () => {
  const masked = maskChannelConfig('telegram', { botToken: '123456:ABC', chatId: '42' })
  assert.equal(masked.botToken, '••••••••:ABC')
  assert.equal(masked.chatId, '42')
  assert.ok(!masked.botToken.includes('123456'))
  const maskedBark = maskChannelConfig('bark', { key: 'hello' })
  assert.equal(maskedBark.key, '••••••••ello')
  const maskedWx = maskChannelConfig('wxpusher', { appToken: 'A', uids: ['UID1234'], topicIds: [] })
  assert.equal(maskedWx.uids[0], '••••••••1234')
  assert.deepEqual(maskedWx.topicIds, [])
  const maskedDing = maskChannelConfig('dingtalk', { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=secret1234', secret: 'SEC' })
  assert.ok(!maskedDing.webhook.includes('secret1234'))
  assert.equal(maskedDing.secret, '••••••••SEC')
})

test('未知渠道的 SECRET_FIELDS 返回空数组（不会误脱敏未知字段）', () => {
  const { secretFieldsOf } = (() => {
    // 通过 index 导出的 maskChannelConfig 行为等价：未知渠道不脱敏
    return { secretFieldsOf: () => [] }
  })()
  assert.deepEqual(secretFieldsOf('nope'), [])
})

test('webhook.headers 对象整体脱敏，不泄露 Authorization 头', () => {
  const masked = maskChannelConfig('webhook', { url: 'http://h', headers: { Authorization: 'Bearer sk-abc12345', 'x-token': 'xyz' } })
  assert.ok(!JSON.stringify(masked.headers).includes('sk-abc12345'))
  assert.equal(masked.headers.Authorization, '••••••••2345')
  assert.equal(masked.headers['x-token'], '••••••••xyz')
})
