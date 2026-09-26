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
<nav aria-label="${m.navAria}">
  <button class="tabbtn active" data-tab="dashboard">${m.tabDashboard}</button>
  <button class="tabbtn" data-tab="channels">${m.tabChannels}</button>
  <button class="tabbtn" data-tab="members">${m.tabMembers}</button>
  <button class="tabbtn" data-tab="notify">${m.tabNotify}</button>
  <button class="tabbtn advanced-tab" data-tab="bindings" hidden>${m.tabBindings}</button>
  <button class="tabbtn advanced-tab" data-tab="sessions" hidden>${m.tabSessions}</button>
  <button id="modeToggle" class="muted-btn" title="${m.modeToggleTitle}">${m.modeToggleOpen}</button>
</nav>
<main id="main">
  <div id="globalMsg" class="msg"></div>

  <section id="tab-dashboard" class="tabsec active">

    <!-- 首次配置向导：无任何已配置出站通道时作为首屏主内容；完成条件 = 用户当场收到测试通知 -->
    <div id="setup" class="setup" hidden>
      <div class="setup-head">
        <h2>${m.setupTitle}</h2>
        <p>${m.setupLead}</p>
      </div>
      <ol class="rail" id="setupRail" aria-label="${m.setupRailAria}">
        <li data-step="1" class="current"><span class="rn">1</span>${m.setupStep1}</li>
        <li data-step="2"><span class="rn">2</span>${m.setupStep2}</li>
        <li data-step="3"><span class="rn">3</span>${m.setupStep3}</li>
        <li data-step="4"><span class="rn">4</span>${m.setupStep4}</li>
      </ol>
      <div class="setup-pane" id="setupPane1">
        <p class="muted small">${m.setupPickHint}</p>
        <div id="setupTiles"></div>
        <div class="inline" id="setupMsg1"></div>
      </div>
      <div class="setup-pane" id="setupPane2" hidden>
        <h3 id="setupFormTitle"></h3>
        <div id="setupForm"></div>
        <p class="muted small">${m.setupFormHint}</p>
        <div class="row">
          <button id="setupBack2" type="button">${m.setupBack2}</button>
          <button id="setupGoTest" type="button" class="btn-primary">${m.setupGoTest}</button>
          <button id="setupSaveOnly" type="button">${m.setupSaveOnly}</button>
        </div>
        <div class="inline" id="setupMsg2"></div>
      </div>
      <div class="setup-pane" id="setupPane3" hidden>
        <div id="setupTestState"></div>
        <div class="row">
          <button id="setupBack3" type="button">${m.setupBack3}</button>
          <button id="setupRetest" type="button" class="btn-primary">${m.setupRetest}</button>
        </div>
      </div>
      <div class="setup-pane" id="setupPane4" hidden>
        <div class="setup-done">
          <span class="beacon"><svg viewBox="0 0 32 32" width="44" height="44" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
          <h3>${m.setupDoneTitle}</h3>
          <p id="setupDoneDetail">${m.setupDoneDetail}</p>
          <div class="row">
            <button id="setupFinish" type="button" class="btn-primary">${m.setupFinish}</button>
            <button class="tabbtn" data-tab="channels" type="button">${m.setupDoneChannels}</button>
            <button class="tabbtn" data-tab="members" type="button">${m.setupDoneMembers}</button>
          </div>
        </div>
      </div>
      <div class="setup-foot">
        <button id="setupSkip" type="button" class="muted-btn">${m.setupSkip}</button>
        <span class="muted small">${m.setupFoot}</span>
      </div>
    </div>

    <!-- 升级用户验证横幅：已有启用通道但本浏览器未验证过送达 -->
    <div id="verifyBanner" class="verify" hidden>
      <span class="dot warn"></span>
      <div><b>${m.bannerTitle}</b><p class="muted small" style="margin:2px 0 0">${m.bannerLead}</p></div>
      <div class="row">
        <button id="bannerTest" type="button" class="btn-primary">${m.bannerTest}</button>
        <button id="bannerDismiss" type="button" class="muted-btn">${m.bannerDismiss}</button>
      </div>
      <div class="inline" id="bannerMsg" style="flex-basis:100%"></div>
    </div>

    <!-- 英雄区：系统是否工作、通知是否可达 -->
    <div class="hero">
      <span class="beacon" id="heroBeacon"><svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
      <div class="hero-main">
        <div class="hero-state none" id="heroState">${m.heroStateInit}</div>
        <div class="hero-sub" id="heroSub">${m.heroSub}</div>
        <div class="hero-rail" id="heroRail" aria-label="${m.heroRailAria}">
          <span class="state-node" data-hstate="unconfigured">${m.hstateUnconfigured}</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="saved">${m.hstateSaved}</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="tested">${m.hstateTested}</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="ready">${m.hstateReady}</span>
        </div>
      </div>
    </div>

    <!-- 下一件该做的事 -->
    <div id="nextAction"></div>

    <div class="stats">
      <div class="stat"><b id="statActive">–</b><span>${m.statActive}</span></div>
      <div class="stat"><b id="statTotal">–</b><span>${m.statTotal}</span></div>
      <div class="stat"><b id="statKeys">–</b><span>${m.statKeys}</span></div>
      <div class="stat"><b id="statMembers">–</b><span>${m.statMembers}</span></div>
    </div>

    <h3>${m.outTitle}</h3>
    <div id="outGroups"></div>
    <h3>${m.inTitle}<span class="muted">${m.inTitleHint}</span></h3>
    <div id="inGroups"></div>

    <h3>${m.pendingTitle}</h3>
    <div id="pendingQuestionsPanel" class="pendingq"></div>

    <h3>${m.auditTitle}</h3>
    <div id="auditList" class="auditlist"></div>
  </section>

  <section id="tab-channels" class="tabsec">
    <p class="muted small">${m.channelsLead}</p>
    <div id="channelCards"></div>
  </section>

  <section id="tab-members" class="tabsec">
    <p class="muted small">${m.membersLead1}</p>
    <p class="muted small">${m.membersLead2}</p>
    <div class="stats">
      <div class="stat"><b id="mCount">–</b><span>${m.mStatMembers}</span></div>
      <div class="stat"><b id="mOwners">–</b><span>${m.mStatOwners}</span></div>
      <div class="stat"><b id="mPending">–</b><span>${m.mStatPending}</span></div>
    </div>
    <div id="mGuided" class="msg show warn" hidden>${m.mGuided}</div>
    <h3>${m.membersTableTitle}</h3>
    <table>
      <thead><tr><th style="width:90px">${m.thChannel}</th><th>${m.thIdentity}</th><th>${m.thNote}</th><th style="width:100px">${m.thRole}</th><th style="width:150px">${m.thPairedAt}</th><th style="width:150px">${m.thLastSeen}</th><th style="width:70px">${m.thActions}</th></tr></thead>
      <tbody id="membersBody"></tbody>
    </table>
    <h3>${m.pairingTitle}</h3>
    <div class="row">
      <input id="pairLabel" placeholder="${m.pairLabelPlaceholder}" style="max-width:260px">
      <select id="pairTtl">
        <option value="10">${m.ttl10}</option>
        <option value="30">${m.ttl30}</option>
        <option value="60">${m.ttl60}</option>
        <option value="1440">${m.ttl1440}</option>
      </select>
      <button id="btnMint">${m.btnMint}</button>
      <span id="pairMsg" class="inline"></span>
    </div>
    <div id="pairCodeBox" class="paircode" hidden></div>
    <table>
      <thead><tr><th style="width:110px">${m.thId}</th><th style="width:90px">${m.thOrigin}</th><th style="width:80px">${m.thState}</th><th style="width:150px">${m.thMintedAt}</th><th style="width:110px">${m.thRemain}</th><th>${m.thNote}</th><th style="width:70px">${m.thActions}</th></tr></thead>
      <tbody id="pairingBody"></tbody>
    </table>
    <h3>${m.pendingTableTitle}</h3>
    <p class="muted small">${m.pendingLead}</p>
    <table>
      <thead><tr><th style="width:90px">${m.thChannel}</th><th>${m.thIdentity}</th><th style="width:110px">${m.thOrigin}</th><th style="width:150px">${m.thFoundAt}</th><th style="width:150px">${m.thActions}</th></tr></thead>
      <tbody id="pendingBody"></tbody>
    </table>
  </section>

  <section id="tab-notify" class="tabsec">
    <p class="muted small">${m.notifyLead}</p>
    <div class="stats">
      <div class="stat"><b id="nStream">${m.streamInit}</b><span>${m.nStatStream}</span></div>
      <div class="stat"><b id="nPerm">${m.permInit}</b><span>${m.nStatPerm}</span></div>
      <div class="stat"><b id="nCount">0</b><span>${m.nStatCount}</span></div>
    </div>
    <div class="row">
      <button id="nPermBtn">${m.btnPerm}</button>
      <button id="nTestBtn">${m.btnTestNotify}</button>
      <label class="ck"><input type="checkbox" id="npEnable" checked>${m.npEnable}</label>
      <label class="ck"><input type="checkbox" id="npActive" checked>${m.npActive}</label>
      <label class="ck"><input type="checkbox" id="npSound" checked>${m.npSound}</label>
      <label class="ck"><input type="checkbox" id="npHidden" checked>${m.npHidden}</label>
    </div>
    <h3>${m.notifyLogTitle}</h3>
    <table>
      <thead><tr><th style="width:150px">${m.thTime}</th><th style="width:70px">${m.thLevel}</th><th style="width:220px">${m.thTitle}</th><th>${m.thBody}</th><th style="width:64px">${m.thSource}</th></tr></thead>
      <tbody id="notifyLog"><tr><td colspan="5" class="empty">${m.emptyEvents}</td></tr></tbody>
    </table>
  </section>

  <section id="tab-bindings" class="tabsec">
    <p class="muted small">${m.bindingsLead}</p>
    <table>
      <thead><tr><th style="width:190px">${m.thKey}</th><th>${m.thOutboundChecks}</th><th>${m.thQuiet}</th><th>${m.thActions}</th></tr></thead>
      <tbody id="agentsBody"></tbody>
    </table>
    <div class="row"><input id="newKey" placeholder="${m.newKeyPlaceholder}"><button id="btnAddKey">${m.btnAddKey}</button></div>
    <h3>${m.defaultsTitle}</h3>
    <p class="muted small">${m.defaultsLead}</p>
    <table>
      <thead><tr><th style="width:190px">${m.thInboundChannel}</th><th>${m.thDefaultAgent}</th></tr></thead>
      <tbody id="defaultsBody"></tbody>
    </table>
    <datalist id="agentKeyOptions"></datalist>
    <p class="row"><button id="btnSaveBindings">${m.btnSaveBindings}</button><span id="bindingsMsg" class="inline"></span></p>
  </section>

  <section id="tab-sessions" class="tabsec">
    <p class="muted small">${m.sessionsLead}</p>
    <table>
      <thead><tr><th>${m.thWorkspace}</th><th>${m.thSession}</th><th>${m.thStatus}</th><th>${m.thResolved}</th><th>${m.thQuiet}</th><th>${m.thSource}</th><th>${m.thInboundHooks}</th><th>${m.thActions}</th></tr></thead>
      <tbody id="sessionsBody"></tbody>
    </table>
  </section>
</main>
</div>
`
}

/** zh 默认骨架产物（向后兼容导出；组合层 UI 走 createAdminMarkup）。 */
export const ADMIN_UI_MARKUP = createAdminMarkup(ADMIN_ZH)
