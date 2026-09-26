// dsh-notifier src/admin/ui.mjs
// 管理台单文件内嵌 HTML 组合器：零构建、无 CDN、离线可用，由 src/admin/server.mjs 以
// 200 text/html 原样返回本串；无任何外部资源引用（无外链脚本 / link / CSS url()），系统字体栈。
//
// 源码按职责拆为四个分片（本文件只做组合，勿在此写具体样式/结构/逻辑）：
//  - ui/strings.mjs → 文案表（ADMIN_ZH / ADMIN_EN / adminStringsOf / escapeHtml / safeJsonForInlineScript）
//  - ui/theme.mjs   → ADMIN_UI_CSS     「宿主对齐·蓝白」视觉语言（白面板 + #f5f6f7 底 + DeepSeek Blue 主色）
//  - ui/markup.mjs  → createAdminMarkup(t)  页面骨架：解锁门 / 首访三步向导 / 首页 / 渠道 / 成员 / 通知 / 高级
//  - ui/client.mjs  → ADMIN_UI_JS      浏览器端逻辑：fragment 启动凭证、站内解锁门、向导、SSE、全部面板交互
//
// i18n（Issue #37）：组合层按 lang 取文案表 → <html lang> / <title> / 骨架 / 内联脚本一次性本地化。
// 浏览器端脚本不含硬编码文案：它在同一 <script> 内先读 window.__DSH_NOTIFIER_ADMIN_STRINGS__
// （safeJsonForInlineScript 序列化的 client 段），再由 tr(path, vars) 取词——服务端与客户端共用
// 同一张表，无重复骨架、无重复逻辑、无正则后处理。
//
// 鉴权契约（Issue #13 重构后）：URL 仅在 fragment 携带启动 token（/#token=...），验证成功后
// 清地址栏 fragment 并只写 sessionStorage（禁止 localStorage）；无 token → 站内解锁门，绝不弹
// window.prompt；401 → 清 token 回解锁门，单飞询问不重试风暴。
// 组合约束：内嵌脚本正文不得含 "</script" 序列；测试以最后一个 "<script>" 与首个 "</script>" 切取脚本。
import { ADMIN_UI_CSS } from './ui/theme.mjs'
import { createAdminMarkup } from './ui/markup.mjs'
import { ADMIN_UI_JS } from './ui/client.mjs'
import { adminStringsOf, escapeHtml, safeJsonForInlineScript } from './ui/strings.mjs'

/** 取 lang 的短码（写入 window.__DSH_NOTIFIER_ADMIN_LANG__）：zh-CN → zh，其余原样。 */
function adminLangCode(table) {
  return table.lang === 'zh-CN' ? 'zh' : table.lang
}

/**
 * 按语言组合管理台单页 HTML；lang 未知/缺失回落 zh（与 strings.mjs 同法）。
 * 文案表以 safeJsonForInlineScript 内联进同一 <script>，浏览器端 tr() 直接消费。
 */
export function createAdminUiHtml(lang = 'zh') {
  const t = adminStringsOf(lang)
  return `<!DOCTYPE html>
<html lang="${escapeHtml(t.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.title)}</title>
<style>${ADMIN_UI_CSS}</style>
</head>
<body>
${createAdminMarkup(t)}
<script>'use strict'
window.__DSH_NOTIFIER_ADMIN_LANG__ = ${safeJsonForInlineScript(adminLangCode(t))}
window.__DSH_NOTIFIER_ADMIN_STRINGS__ = ${safeJsonForInlineScript(t.client)}
${ADMIN_UI_JS}</script>
</body>
</html>
`
}

/** zh 默认产物（零配置首访的存量契约；wiring 走 createAdminUiHtml(resolved.lang)）。 */
export const ADMIN_UI_HTML = createAdminUiHtml('zh')
