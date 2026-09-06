// v0.9.3 测试（W9 / S-05）：出站片段脱敏——maskSecrets 形态矩阵、redaction 配置解析、
// intentToMessage minimal/extended 两档行为。

import test from 'node:test'
import assert from 'node:assert/strict'
import { maskSecrets, normalizeRedaction, MINIMAL_EXCERPT_CHARS } from '../src/redact.mjs'
import { intentToMessage } from '../src/event-listener.mjs'
import { resolveConfig } from '../src/config.mjs'

test('maskSecrets：sk-/ghp_/xox/AKIA/JWT/Bearer/长hex/长base64 全部打码为 ***', () => {
  const cases = [
    ['key 是 sk-abc123def456ghi789xyz', 'sk-abc123def456ghi789xyz'],
    ['token ghp_16CharTokenAAAAAA 泄露', 'ghp_16CharTokenAAAAAA'],
    ['slack xoxb-1234567890abcdef', 'xoxb-1234567890abcdef'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['header Bearer abcdef1234567890abcdef', 'abcdef1234567890abcdef'],
    ['sha e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    // 44 连续 base64 字符（≥40 阈值；带 == 分隔的短段拼串是两段 <40，不构成形态）
    ['base64 QWxhZGRpbjpvcGVuIHNlc2FtZTNCZWJ1dHRvbnF6eXo', 'QWxhZGRpbjpvcGVuIHNlc2FtZTNCZWJ1dHRvbnF6eXo'],
  ]
  for (const [text, secret] of cases) {
    const masked = maskSecrets(text)
    assert.ok(!masked.includes(secret), `打码后不得再含原文：${secret.slice(0, 12)}…`)
    assert.ok(masked.includes('***'), `应有 *** 替代：${masked}`)
  }
})

test('maskSecrets：正常中文/英文正文零误伤；幂等（二次过闸不变）', () => {
  const benign = '任务完成：已修复登录页面的三个样式问题，测试全部通过。\nSecond line with words and 123 numbers.'
  assert.equal(maskSecrets(benign), benign)
  const once = maskSecrets('密钥 sk-abcdefghijklmnop1234 已轮换')
  assert.equal(maskSecrets(once), once)
})

test('normalizeRedaction：仅 extended 关闭脱敏，缺省/拼错/非法类型一律 minimal', () => {
  assert.equal(normalizeRedaction('extended'), 'extended')
  assert.equal(normalizeRedaction('minimal'), 'minimal')
  assert.equal(normalizeRedaction(undefined), 'minimal')
  assert.equal(normalizeRedaction('MINIMAL'), 'minimal')
  assert.equal(normalizeRedaction('off'), 'minimal')
  assert.equal(normalizeRedaction(1), 'minimal')
})

test('resolveConfig：redaction 字段解析与透传（默认 minimal）', () => {
  assert.equal(resolveConfig({}).redaction, 'minimal')
  assert.equal(resolveConfig({ redaction: 'extended' }).redaction, 'extended')
  assert.equal(resolveConfig({ redaction: '别的' }).redaction, 'minimal')
})

test('intentToMessage：minimal（默认）下 assistantText 摘录压到 80 码点且打码；detail 一并打码', () => {
  const secret = 'sk-abcdefghijklmnopqrst'
  const long = `A`.repeat(300) + ` tail ${secret}`
  const message = intentToMessage(
    { headline: '✅ 任务完成', level: 'active', detail: `出错信息 Bearer abcdef1234567890abc` },
    { assistantText: long, config: {} },
  )
  assert.ok(!message.content.includes(secret), '密钥形态不得外发')
  assert.ok(!message.content.includes('abcdef1234567890abc'), 'detail 中的 Bearer token 同样打码')
  const excerpt = message.content.split('---\n')[1] ?? ''
  assert.ok(excerpt.length <= MINIMAL_EXCERPT_CHARS + 10, `摘录应压到 ~${MINIMAL_EXCERPT_CHARS}，实际 ${excerpt.length}`)
  assert.ok(message.content.includes('tail'), '尾沿截断保留结论段')
})

test('intentToMessage：extended 维持原行为（不额外截摘录、不打码，仅 summaryMaxChars 总钳）', () => {
  const secret = 'sk-abcdefghijklmnopqrst'
  // detail 450 + 分隔 6 + 摘录 473 = 929 > 500 触发总钳；secret 落在 456..478（前 500 内不被截掉）
  const long = `${secret}${'B'.repeat(450)}`
  const message = intentToMessage(
    { headline: '✅ 任务完成', level: 'active', detail: 'D'.repeat(450) },
    { assistantText: long, config: { redaction: 'extended' } },
  )
  assert.ok(message.content.includes(secret), 'extended 显式选择原文外发')
  assert.equal(message.content.length, 500 + 1, 'summaryMaxChars 默认 500 总钳 + 省略号')
})

test('intentToMessage：minimal 下短摘录不受 80 截断影响', () => {
  const message = intentToMessage(
    { headline: '🚀 任务开始', level: 'passive', detail: '' },
    { assistantText: '只有一句话', config: {} },
  )
  assert.equal(message.content, '只有一句话')
})
