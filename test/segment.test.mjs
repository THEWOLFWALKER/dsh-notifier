// 阶段 5 测试：inbound/segment（1200 码点收敛分段 + 顺序送达）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentText, countCodepoints, sendSegmented, splitByCodePoints } from '../src/inbound/segment.mjs'

// 孤立代理项探测器（实现无关，纯 Unicode 断言）：高代理后无低代理 / 低代理前无高代理。
// 注意第二个字符类区间是 \uDC00-\uDFFF（低代理区）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('countCodepoints：代理对按 1 计（😀 = 1 码点）', () => {
  assert.equal(countCodepoints('abc'), 3)
  assert.equal(countCodepoints('你好'), 2)
  assert.equal(countCodepoints('a😀b'), 3) // 不是 4（UTF-16 两个 code unit）
  assert.equal(countCodepoints(null), 0)
})

test('splitByCodePoints：星体平面字符（🀄/𝕏）按码点切块，块边界绝不产生孤立代理项', () => {
  // 🀄=U+1F004、𝕏=U+1D54F 均为星体平面（UTF-16 代理对）。size=2 时旧码元 slice
  // 会在第 2/4 码元处切开代理对（'a🀄b𝕏c'.slice(0,2) = 'a' + 孤立高代理）。
  const chunks = splitByCodePoints('a🀄b𝕏c', 2)
  assert.deepEqual(chunks, ['a🀄', 'b𝕏', 'c'])
  assert.equal(chunks.join(''), 'a🀄b𝕏c')
  for (const chunk of chunks) {
    assert.equal(LONE_SURROGATE.test(chunk), false, `块含孤立代理项: ${JSON.stringify(chunk)}`)
  }
})

test('splitByCodePoints：任意块大小逐块扫描——拼接无损且无孤立代理项（属性式）', () => {
  const text = '🀄'.repeat(9) + '𝕏'.repeat(3) + '中🙂文'
  for (let size = 1; size <= 12; size += 1) {
    const chunks = splitByCodePoints(text, size)
    assert.equal(chunks.join(''), text, `size=${size} 拼接必须无损`)
    for (const chunk of chunks) {
      assert.equal(LONE_SURROGATE.test(chunk), false, `size=${size} 块含孤立代理项: ${JSON.stringify(chunk)}`)
      assert.ok(Array.from(chunk).length <= size, `size=${size} 块超预算`)
    }
  }
})

test('splitByCodePoints：ZWJ 序列（🏳️‍🌈）跨界拆成完整码点——可接受降级且不产生非法序列', () => {
  const flag = '🏳️‍🌈' // U+1F3F3 U+FE0F U+200D U+1F308 = 4 个码点
  assert.equal(countCodepoints(flag), 4)
  const chunks = splitByCodePoints(flag + flag + flag, 5) // 边界必然落在序列中间
  assert.equal(chunks.join(''), flag + flag + flag)
  for (const chunk of chunks) {
    assert.equal(LONE_SURROGATE.test(chunk), false, 'ZWJ 序列被拆也不得产生孤立代理项（拆的是完整码点）')
  }
})

test('splitByCodePoints：边界语义——空串 []、短文整段、非法步长退化整段（绝不死循环）', () => {
  assert.deepEqual(splitByCodePoints('', 10), [])
  assert.deepEqual(splitByCodePoints(null, 3), [])
  assert.deepEqual(splitByCodePoints('abc', 10), ['abc'])
  assert.deepEqual(splitByCodePoints('abc', 3), ['abc'])
  // size=0 在旧码元循环（i += size）是死循环；helper 退化为整段（与 segmentText 退化语义一致）
  assert.deepEqual(splitByCodePoints('abc', 0), ['abc'])
  assert.deepEqual(splitByCodePoints('abc', -2), ['abc'])
  assert.deepEqual(splitByCodePoints('abc', undefined), ['abc'])
  assert.deepEqual(splitByCodePoints('abc', 2.9), ['ab', 'c'], '非整数步长向下取整')
})

test('segmentText：短文本单段返回且不加前缀（零开销）', () => {
  assert.deepEqual(segmentText('短消息'), ['短消息'])
  assert.deepEqual(segmentText('', {}), [''])
})

test('segmentText：长文本切段，每段（含前缀）不超预算，前缀为（i/n）', () => {
  const text = Array.from({ length: 500 }, (_, i) => `第${i}行内容`).join('\n') // 500 行
  const max = 1200
  const segments = segmentText(text, { maxCodepoints: max })
  assert.ok(segments.length > 1)
  assert.equal(segments[0].startsWith('（1/'), true)
  assert.equal(segments[segments.length - 1].startsWith(`（${segments.length}/`), true)
  for (const segment of segments) {
    assert.ok(countCodepoints(segment) <= max, `段超预算: ${countCodepoints(segment)} > ${max}`)
  }
  // 拼回原文（去前缀）无损
  const rejoined = segments.map((s) => s.replace(/^（\d+\/\d+）/, '')).join('')
  assert.equal(rejoined, text)
})

test('segmentText：收敛——预算紧时前缀计入仍不超限', () => {
  // max=60（resolveConfig 的下限）：确保前缀占用后每段仍 ≤ 60
  const text = 'x'.repeat(1000)
  const segments = segmentText(text, { maxCodepoints: 60 })
  assert.ok(segments.length > 10)
  for (const segment of segments) {
    assert.ok(countCodepoints(segment) <= 60)
  }
  assert.equal(segments.map((s) => s.replace(/^（\d+\/\d+）/, '')).join(''), text)
})

test('segmentText：预算装不下前缀时退化整段（不切）', () => {
  const text = 'x'.repeat(100)
  // max=5 < 前缀长度（（1/20）= 7 码点）→ budget ≤ 0 → 整段返回
  assert.deepEqual(segmentText(text, { maxCodepoints: 5 }), [text])
})

test('segmentText：切分偏好换行 > 空格 > 硬切（不在行中间断开）', () => {
  const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n') // 19 码点
  const segments = segmentText(text, { maxCodepoints: 12 })
  assert.ok(segments.length >= 2)
  for (let i = 0; i < segments.length; i += 1) {
    const body = segments[i].replace(/^（\d+\/\d+）/, '')
    // 非末段的段尾必须是换行（行边界）；末段无此要求
    if (i < segments.length - 1) {
      assert.ok(body.endsWith('\n'), `非末段应在行边界结束: ${JSON.stringify(body)}`)
    }
  }
  // 拼接无损 + 每段预算内
  assert.equal(segments.map((s) => s.replace(/^（\d+\/\d+）/, '')).join(''), text)
  for (const segment of segments) assert.ok(countCodepoints(segment) <= 12)
})

test('sendSegmented：单段直通（title/content 原样），只调一次 send', async () => {
  const sent = []
  const outcome = await sendSegmented(async (piece) => { sent.push(piece) }, { title: 'T', content: '短内容' }, { maxCodepoints: 1200 })
  assert.deepEqual(outcome, { sent: 1, total: 1, error: null })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, 'T')
  assert.equal(sent[0].content, '短内容')
})

test('sendSegmented：多段顺序送达，title 只在首段文本里（不重复渲染）', async () => {
  const sent = []
  const long = 'y'.repeat(300)
  const outcome = await sendSegmented(
    async (piece) => { sent.push(piece) },
    { title: '标题', content: long },
    { maxCodepoints: 100 },
  )
  assert.ok(outcome.total > 2)
  assert.equal(outcome.sent, outcome.total)
  assert.equal(outcome.error, null)
  for (const piece of sent) assert.equal(piece.title, '') // 多段时 title 不重复
  assert.ok(sent[0].content.includes('标题'))
  assert.ok(sent[0].content.startsWith('（1/'))
})

test('sendSegmented：中途失败即停（顺序送达语义），返回已送段数', async () => {
  let calls = 0
  const outcome = await sendSegmented(
    async () => {
      calls += 1
      if (calls === 2) throw new Error('second segment boom')
    },
    { title: '', content: 'z'.repeat(200) },
    { maxCodepoints: 50 },
  )
  assert.equal(outcome.total, 5)
  assert.equal(outcome.sent, 1)
  assert.equal(outcome.error.message, 'second segment boom')
  assert.equal(calls, 2) // 失败后不再尝试后续段
})
