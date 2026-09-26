// Issue #37：管理台语言表、服务端组合器、客户端动态文案与内联脚本边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ADMIN_EN, ADMIN_ZH, adminStringsOf, safeJsonForInlineScript } from '../src/admin/ui/strings.mjs'
import { createAdminUiHtml } from '../src/admin/ui.mjs'
import { ADMIN_UI_JS } from '../src/admin/ui/client.mjs'

function shapeOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)]))
  }
  return typeof value
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('Admin UI i18n：zh/en 文案表递归同形，未知语言回落 zh', () => {
  assert.deepEqual(shapeOf(ADMIN_ZH), shapeOf(ADMIN_EN))
  assert.equal(adminStringsOf('en'), ADMIN_EN)
  assert.equal(adminStringsOf('zh'), ADMIN_ZH)
  assert.equal(adminStringsOf('fr'), ADMIN_ZH)
  assert.equal(adminStringsOf('__proto__'), ADMIN_ZH)
})

test('Admin UI i18n：html lang/title 与核心导航随语言切换', () => {
  const zh = createAdminUiHtml('zh')
  const en = createAdminUiHtml('en')
  assert.match(zh, /<html lang="zh-CN">/)
  assert.match(en, /<html lang="en">/)
  assert.match(zh, new RegExp('<title>' + ADMIN_ZH.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</title>'))
  assert.match(en, new RegExp('<title>' + ADMIN_EN.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</title>'))
  const visible = en.replace(/<style[\s\S]*?<\/style>/i, '').replace(/<script[\s\S]*?<\/script>/i, '')
  assert.ok(visible.includes(ADMIN_EN.markup.tabDashboard))
  assert.ok(visible.includes(ADMIN_EN.markup.tabChannels))
  assert.ok(!visible.includes(ADMIN_ZH.markup.tabDashboard))
  assert.ok(!visible.includes(ADMIN_ZH.markup.tabChannels))
  assert.ok(en.includes("tr('heroReady')"), '客户端动态文案通过 tr() 查表')
})

test('Admin UI i18n：客户端可见文案不回退为硬编码中文', () => {
  assert.match(ADMIN_UI_JS, /function tr\(path, vars\)/)
  assert.doesNotMatch(stripComments(ADMIN_UI_JS), /[\u4e00-\u9fff]/)
})

test('Admin UI i18n：内联 JSON 转义恶意 script 片段，不生成第二个 script 标签', () => {
  const malicious = '</script><script>alert(1)</script>'
  const inline = safeJsonForInlineScript({ malicious })
  const html = '<script>' + inline + '</script>'
  assert.equal((html.match(/<script>/g) || []).length, 1)
  assert.equal((html.match(/<\/script>/g) || []).length, 1)
  assert.doesNotMatch(inline, /<\/?script/i)
  assert.ok(inline.includes('\\u003c/script\\u003e'))
})

test('Admin UI i18n：生产 index 按 resolveConfig(lang) 接线', () => {
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ createAdminUiHtml \} from ['"]\.\/admin\/ui\.mjs['"]/)
  assert.match(source, /ui: createAdminUiHtml\(resolved\.lang\)/)
  assert.doesNotMatch(source, /ui: ADMIN_UI_HTML/)
})
