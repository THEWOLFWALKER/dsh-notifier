// dsh-notifier src/admin/ui/markup.mjs
// 管理台页面骨架（<body> 内部）。信息架构：首页（链路状态/下一步/健康矩阵/提问/审计）→
// 通知渠道（出站主、入站次）→ 成员 → 通知 → 高级（绑定矩阵/会话，默认隐藏）。
// 首访路径：fragment 启动凭证 → 静默验证；无 token → 站内解锁门（不弹 window.prompt）；
// 未配置 → 首页三步向导（选渠道 → 填凭证 → 真实测试送达）。
//
// i18n（Issue #37）：全部用户可见文案来自 strings.mjs 的 markup 段（createAdminMarkup(t)）。
// 骨架只描述结构，不重复各语言文案；ADMIN_UI_MARKUP 保留为 zh 默认产物（向后兼容导出）。
// 注意：本文件是模板字面量——正文不得出现反引号与 ${ 序列（文案值同样受此约束，见 strings.mjs）。
import { ADMIN_ZH } from './strings.mjs'

/** 按文案表 t（含 t.markup 段）渲染页面骨架。 */
export function createAdminMarkup(t) {
  const m = t.markup
  return `<a class="skip" href="#main">${m.skip}</a>

<!-- 解锁门：无 token / token 失效 / 手动更换 token。站内页，不用系统 prompt。 -->
<div id="gate" class="gate" hidden>
  <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
    <span class="beacon"><svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
    <h1 id="gateTitle">${m.gateTitle}</h1>
    <p class="gate-sub">${m.gateSub}</p>
    <p id="gateNote" class="gate-note">${m.gateNote}</p>
    <form id="unlockForm" autocomplete="off">
      <label class="gate-label" for="unlockInput">${m.gateLabel}</label>
      <div class="gate-field">
        <input id="unlockInput" type="password" autocomplete="off" spellcheck="false" placeholder="${m.gatePlaceholder}">
        <button type="button" id="unlockPeek" aria-label="${m.gatePeekAria}">${m.gatePeekShow}</button>
      </div>
      <p id="unlockError" class="gate-err" role="alert" hidden></p>
      <div class="gate-actions">
        <button type="submit" id="unlockBtn" class="btn-primary">${m.gateSubmit}</button>
        <button type="button" id="unlockCancel" hidden>${m.gateCancel}</button>
      </div>
    </form>
    <p class="gate-hint muted small">${m.gateHint}</p>
  </div>
</div>

<div id="app">
<header>
  <div class="brand">
    <span class="beacon"><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
    <h1>${m.brandTitle}<small>v0.13.1</small></h1>
  </div>
  <span id="loadState" role="status" aria-live="polite"></span>
  <span id="entryHint">${m.entryHint}<code id="entryUrl"></code></span>
  <button id="btnCopyEntry" title="${m.btnCopyEntryTitle}">${m.btnCopyEntry}</button>
  <button id="tokenState" title="${m.tokenStateTitle}"></button>
  <button id="btnLogout" title="${m.btnLogoutTitle}">${m.btnLogout}</button>
  <button id="btnRefresh">${m.btnRefresh}</button>
</header>
<p id="recoveryNote" class="muted small">${m.recoveryNote}</p>
<nav aria-label="${m.navAria}" data-mode="recovery">
  <button class="tabbtn" data-tab="diagnostics">${m.tabDiagnostics}</button>
</nav>
<main id="main">
  <div id="globalMsg" class="msg"></div>

  <section id="tab-diagnostics" class="tabsec active">
    <p class="muted small">${m.diagLead}</p>
    <div class="row"><button id="diagRefresh">${m.diagRefresh}</button></div>
    <div id="diagView"></div>
  </section>

</main>
</div>
`
}

/** zh 默认骨架产物（向后兼容导出；组合层 UI 走 createAdminMarkup）。 */
export const ADMIN_UI_MARKUP = createAdminMarkup(ADMIN_ZH)
