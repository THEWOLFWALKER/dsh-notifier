// v0.11 Commit18 — 英文公共契约 `PLUGINS.en.md` 与中文 `PLUGINS.md` 的结构对齐门（plan §9.9/§9.10）。
// 英文版是中文版的**完整公共契约**（不是摘要）：H1/H2/H3、表格、代码块、注意事项、安全限制一一对应，
// 且必须使用最新事实（不机械翻历史错误口径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const zh = readFileSync(resolve(root, 'PLUGINS.md'), 'utf8')
const en = readFileSync(resolve(root, 'PLUGINS.en.md'), 'utf8')

const headings = (text, level) => [...text.matchAll(new RegExp(`^#{${level}} (.+)$`, 'gm'))].map((m) => m[1])
const fenceCount = (text) => text.split('\n').filter((line) => line.startsWith('```')).length
const tableRows = (text) => text.split('\n').filter((line) => line.trim().startsWith('|')).length

test('plugins docs: both files have exactly one H1', () => {
  assert.equal(headings(zh, 1).length, 1)
  assert.equal(headings(en, 1).length, 1)
})

test('plugins docs: H2 and H3 counts match between zh and en', () => {
  assert.equal(headings(zh, 2).length, headings(en, 2).length, 'H2 count parity')
  assert.equal(headings(zh, 3).length, headings(en, 3).length, 'H3 count parity')
  assert.ok(headings(zh, 2).length >= 13, '公共契约至少 13 个章节')
})

test('plugins docs: required sections are present in both languages', () => {
  const zhRequired = ['30 秒上手', '服务获取', 'push API', '限流', 'sent 事件', 'flush', '三态语义', '版本与兼容', '完整示例', 'dsh-notifier/testing', 'dsh-notifier/types', '真机验证记录', 'FAQ']
  const enRequired = ['quick start', 'Getting the service', 'push API', 'Rate limiting', 'sent event', 'flush', 'Three-state', 'Version and compatibility', 'Full example', 'dsh-notifier/testing', 'dsh-notifier/types', 'On-device verification', 'FAQ']
  for (const heading of zhRequired) assert.equal(headings(zh, 2).some((h) => h.includes(heading)), true, `zh missing section: ${heading}`)
  for (const heading of enRequired) assert.equal(headings(en, 2).some((h) => h.includes(heading)), true, `en missing section: ${heading}`)
})

test('plugins docs: code fence parity and no unbalanced fence', () => {
  assert.equal(fenceCount(zh) % 2, 0, 'zh fences must be balanced')
  assert.equal(fenceCount(en) % 2, 0, 'en fences must be balanced')
  assert.equal(fenceCount(en), fenceCount(zh), 'fence count parity between zh and en')
})

test('plugins docs: table parity between zh and en', () => {
  assert.equal(tableRows(en), tableRows(zh), '表格行数必须一一对应')
  assert.ok(tableRows(zh) > 0, '公共契约必须含表格')
})

test('plugins docs: en carries the current public API facts', () => {
  assert.match(en, /dsh-notifier\/testing/)
  assert.match(en, /dsh-notifier\/types/)
  assert.match(en, /'0\.7'/, 'en must state the 0.7 public-surface version')
  assert.match(en, /metadata-only/, 'en must state the sent event is metadata-only')
})

test('plugins docs: no stale "sole registerProvider" wording survives', () => {
  // Commit13 已把官方 seam 校准为 `user-questions/request` waterfall；
  // 「唯一公开 seam = registerProvider」是过时口径，两份文档都不得残留。
  for (const [label, text] of [['zh', zh], ['en', en]]) {
    assert.equal(/registerProvider/.test(text), false, `${label} must not mention the stale registerProvider seam`)
    assert.equal(/唯一公开\s*seam/.test(text), false, `${label} must not claim a sole public seam`)
  }
})

test('plugins docs: bilingual backlinks are present both ways', () => {
  assert.match(zh, /English: \[PLUGINS\.en\.md\]\(PLUGINS\.en\.md\)/)
  assert.match(en, /中文: \[PLUGINS\.md\]\(PLUGINS\.md\)/)
})