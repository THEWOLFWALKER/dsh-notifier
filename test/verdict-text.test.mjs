// W7 G-54：裁决失败话术分层单元测试（TG/飞书按钮共用映射）
import test from 'node:test'
import assert from 'node:assert/strict'
import { verdictFailureText, cardMissingText } from '../src/inbound/verdict-text.mjs'

test('verdictFailureText: 每个已知 reason 有专属话术（不再折叠成一句）', () => {
  assert.match(verdictFailureText('token-required'), /缺少有效凭证/)
  assert.match(verdictFailureText('key-mismatch'), /不匹配/)
  assert.equal(verdictFailureText('source-chat-mismatch'), '请到原会话操作')
  assert.match(verdictFailureText('already-resolved'), /已处理，无需重复操作/)
  assert.match(verdictFailureText('expired'), /已过期/)
  assert.match(verdictFailureText('invalid-decision'), /无效的操作类型/)
})

test('verdictFailureText: question 类卡片措辞区分', () => {
  assert.match(verdictFailureText('already-resolved', 'question'), /该提问已处理/)
  assert.match(verdictFailureText('expired', 'question'), /该提问已过期/)
})

test('verdictFailureText: 未知/缺失 reason 走兜底，不抛错', () => {
  assert.match(verdictFailureText(undefined), /已处理或已过期/)
  assert.match(verdictFailureText('some-new-reason'), /已处理或已过期/)
  assert.match(verdictFailureText(null, 'approval', '自定义兜底'), /自定义兜底/)
})

test('verdictFailureText: 文案不含内部标识符形态', () => {
  for (const reason of ['token-required', 'key-mismatch', 'already-resolved', 'expired', 'invalid-decision', 'unknown']) {
    const text = verdictFailureText(reason)
    assert.doesNotMatch(text, /token|approvalKey|eventId|open_id/i, `reason=${reason} 文案泄漏内部标识符: ${text}`)
  }
})

test('cardMissingText: 卡片被删专用话术，不误导「到原会话」', () => {
  const text = cardMissingText()
  assert.match(text, /已被删除/)
  assert.doesNotMatch(text, /请到原会话/)
})
