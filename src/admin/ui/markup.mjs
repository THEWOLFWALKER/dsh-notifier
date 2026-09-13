// dsh-notifier src/admin/ui/markup.mjs
// 管理台页面骨架（<body> 内部）。信息架构：首页（链路状态/下一步/健康矩阵/提问/审计）→
// 通知渠道（出站主、入站次）→ 成员 → 通知 → 高级（绑定矩阵/会话，默认隐藏）。
// 首访路径：fragment 启动凭证 → 静默验证；无 token → 站内解锁门（不弹 window.prompt）；
// 未配置 → 首页三步向导（选渠道 → 填凭证 → 真实测试送达）。
// 注意：本文件是模板字面量——内容里不得出现反引号与 ${ 序列。
export const ADMIN_UI_MARKUP = `<a class="skip" href="#main">跳到主要内容</a>

<!-- 解锁门：无 token / token 失效 / 手动更换 token。站内页，不用系统 prompt。 -->
<div id="gate" class="gate" hidden>
  <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
    <span class="beacon"><svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
    <h1 id="gateTitle">dsh-notifier 管理台</h1>
    <p class="gate-sub">本机通知中枢 · 仅 127.0.0.1 回环可访问</p>
    <p id="gateNote" class="gate-note">输入插件启动时打印在终端的访问 token 进入管理台。</p>
    <form id="unlockForm" autocomplete="off">
      <label class="gate-label" for="unlockInput">访问 token</label>
      <div class="gate-field">
        <input id="unlockInput" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴终端打印的 token">
        <button type="button" id="unlockPeek" aria-label="显示或隐藏输入的 token">显示</button>
      </div>
      <p id="unlockError" class="gate-err" role="alert" hidden></p>
      <div class="gate-actions">
        <button type="submit" id="unlockBtn" class="btn-primary">进入管理台</button>
        <button type="button" id="unlockCancel" hidden>取消</button>
      </div>
    </form>
    <p class="gate-hint muted small">token 首次启动时打印一次，此后只存哈希。遗失请删除 state 中的 <code>admin:token-hash</code> 后重启。token 仅存当前浏览器会话（sessionStorage），绝不写入 localStorage，关页即失效。</p>
  </div>
</div>

<div id="app">
<header>
  <div class="brand">
    <span class="beacon"><svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
    <h1>dsh-notifier 管理台<small>v0.10.2</small></h1>
  </div>
  <span id="loadState" role="status" aria-live="polite"></span>
  <span id="entryHint">仅本机回环 · 当前入口：<code id="entryUrl"></code></span>
  <button id="btnCopyEntry" title="复制当前管理台地址">复制地址</button>
  <button id="tokenState" title="点击输入或更换访问 token"></button>
  <button id="btnLogout" title="清除此浏览器会话中的访问 token">退出</button>
  <button id="btnRefresh">刷新</button>
</header>
<nav aria-label="主导航">
  <button class="tabbtn active" data-tab="dashboard">首页</button>
  <button class="tabbtn" data-tab="channels">通知渠道</button>
  <button class="tabbtn" data-tab="members">成员</button>
  <button class="tabbtn" data-tab="notify">通知</button>
  <button class="tabbtn advanced-tab" data-tab="bindings" hidden>绑定矩阵</button>
  <button class="tabbtn advanced-tab" data-tab="sessions" hidden>会话</button>
  <button id="modeToggle" class="muted-btn" title="显示或隐藏高级会话与绑定设置">打开高级设置</button>
</nav>
<main id="main">
  <div id="globalMsg" class="msg"></div>

  <section id="tab-dashboard" class="tabsec active">

    <!-- 首次配置向导：无任何已配置出站通道时作为首屏主内容；完成条件 = 用户当场收到测试通知 -->
    <div id="setup" class="setup" hidden>
      <div class="setup-head">
        <h2>先把通知送到你手上</h2>
        <p>选渠道、填凭证、发一条真实测试通知，手机收到即完成。回复、审批、成员以后再说。</p>
      </div>
      <ol class="rail" id="setupRail" aria-label="初始化进度">
        <li data-step="1" class="current"><span class="rn">1</span>选择渠道</li>
        <li data-step="2"><span class="rn">2</span>填写凭证</li>
        <li data-step="3"><span class="rn">3</span>测试送达</li>
        <li data-step="4"><span class="rn">4</span>完成</li>
      </ol>
      <div class="setup-pane" id="setupPane1">
        <p class="muted small">推荐选手机上已有的应用，更多渠道可展开。</p>
        <div id="setupTiles"></div>
        <div class="inline" id="setupMsg1"></div>
      </div>
      <div class="setup-pane" id="setupPane2" hidden>
        <h3 id="setupFormTitle"></h3>
        <div id="setupForm"></div>
        <p class="muted small">带 * 为必填。保存后即可测试，无需重启。</p>
        <div class="row">
          <button id="setupBack2" type="button">← 重选渠道</button>
          <button id="setupGoTest" type="button" class="btn-primary">保存并发送测试通知</button>
          <button id="setupSaveOnly" type="button">仅保存</button>
        </div>
        <div class="inline" id="setupMsg2"></div>
      </div>
      <div class="setup-pane" id="setupPane3" hidden>
        <div id="setupTestState"></div>
        <div class="row">
          <button id="setupBack3" type="button">← 返回修改</button>
          <button id="setupRetest" type="button" class="btn-primary">重新发送测试通知</button>
        </div>
      </div>
      <div class="setup-pane" id="setupPane4" hidden>
        <div class="setup-done">
          <span class="beacon"><svg viewBox="0 0 32 32" width="44" height="44" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
          <h3>测试通知已送达</h3>
          <p id="setupDoneDetail">通知链路已打通，此后 agent 通知会直接推送到该渠道。</p>
          <div class="row">
            <button id="setupFinish" type="button" class="btn-primary">进入管理台首页</button>
            <button class="tabbtn" data-tab="channels" type="button">配置手机回复（可选）</button>
            <button class="tabbtn" data-tab="members" type="button">配对成员（可选）</button>
          </div>
        </div>
      </div>
      <div class="setup-foot">
        <button id="setupSkip" type="button" class="muted-btn">稍后再说，先进管理台</button>
        <span class="muted small">YAML 仍可用于自动部署与高级配置，但不是默认路径</span>
      </div>
    </div>

    <!-- 升级用户验证横幅：已有启用通道但本浏览器未验证过送达 -->
    <div id="verifyBanner" class="verify" hidden>
      <span class="dot warn"></span>
      <div><b>通知通道已在运行</b><p class="muted small" style="margin:2px 0 0">本浏览器还没验证过送达——发一条真实测试通知确认链路。</p></div>
      <div class="row">
        <button id="bannerTest" type="button" class="btn-primary">发送测试通知</button>
        <button id="bannerDismiss" type="button" class="muted-btn">我已确认可用</button>
      </div>
      <div class="inline" id="bannerMsg" style="flex-basis:100%"></div>
    </div>

    <!-- 英雄区：系统是否工作、通知是否可达 -->
    <div class="hero">
      <span class="beacon" id="heroBeacon"><svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><circle cx="16" cy="21" r="3.4" fill="currentColor"/><path d="M8.8 15.6a10.2 10.2 0 0 1 14.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5.2 11.8a15.3 15.3 0 0 1 21.6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg></span>
      <div class="hero-main">
        <div class="hero-state none" id="heroState">正在读取状态…</div>
        <div class="hero-sub" id="heroSub">出站通知链路总览</div>
        <div class="hero-rail" id="heroRail" aria-label="运行状态进度">
          <span class="state-node" data-hstate="unconfigured">未配置</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="saved">已保存</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="tested">已测试</span><span class="state-arrow">→</span>
          <span class="state-node" data-hstate="ready">正常运行</span>
        </div>
      </div>
    </div>

    <!-- 下一件该做的事 -->
    <div id="nextAction"></div>

    <div class="stats">
      <div class="stat"><b id="statActive">–</b><span>活跃会话</span></div>
      <div class="stat"><b id="statTotal">–</b><span>会话总数</span></div>
      <div class="stat"><b id="statKeys">–</b><span>agent 路由键</span></div>
      <div class="stat"><b id="statMembers">–</b><span>成员</span></div>
    </div>

    <h3>出站通道</h3>
    <div id="outGroups"></div>
    <h3>入站通道<span class="muted">手机远程控制（可选）</span></h3>
    <div id="inGroups"></div>

    <h3>待处理远程提问</h3>
    <div id="pendingQuestionsPanel" class="pendingq"></div>

    <h3>最近审计</h3>
    <div id="auditList" class="auditlist"></div>
  </section>

  <section id="tab-channels" class="tabsec">
    <p class="muted small">在本页填好各渠道凭证即可。YAML 仅作为高级入口；未配置渠道在此页按字段配置。值为 *** 的字段视为未修改，提交时自动忽略。<b>出站通知</b>保存后即可测试，无需重启；<b>入站控制</b>为可选，配置后可在手机回复、审批。</p>
    <div id="channelCards"></div>
  </section>

  <section id="tab-members" class="tabsec">
    <p class="muted small">这里管理谁能远程操作（会话 / 审批 / 命令）。首位成员即 owner：负责生成、撤销配对码与角色分配，末位 owner 不可删。改号请在旧号发 /unpair、新号持码 /pair。</p>
    <p class="muted small">个人模式默认：observe + approve 已开启；converse 可按需开启；群聊控制默认关闭。绑定矩阵与会话等高级设置默认隐藏，需要时点顶部「打开高级设置」。</p>
    <div class="stats">
      <div class="stat"><b id="mCount">–</b><span>成员</span></div>
      <div class="stat"><b id="mOwners">–</b><span>owner</span></div>
      <div class="stat"><b id="mPending">–</b><span>待确认绑定</span></div>
    </div>
    <div id="mGuided" class="msg show warn" hidden>引导态：绑定表为空。宿主启动日志里有一枚引导配对码，任意通道私聊机器人发送 /pair &lt;码&gt; 即成为 owner（码随之作废）。</div>
    <h3>成员表</h3>
    <table>
      <thead><tr><th style="width:90px">渠道</th><th>身份 id</th><th>备注</th><th style="width:100px">角色</th><th style="width:150px">配对时间</th><th style="width:150px">最近活跃</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="membersBody"></tbody>
    </table>
    <h3>配对码</h3>
    <div class="row">
      <input id="pairLabel" placeholder="备注（可选，≤64 字，核销时带上）" style="max-width:260px">
      <select id="pairTtl">
        <option value="10">10 分钟</option>
        <option value="30">30 分钟</option>
        <option value="60">1 小时</option>
        <option value="1440">24 小时</option>
      </select>
      <button id="btnMint">生成配对码</button>
      <span id="pairMsg" class="inline"></span>
    </div>
    <div id="pairCodeBox" class="paircode" hidden></div>
    <table>
      <thead><tr><th style="width:110px">id</th><th style="width:90px">来源</th><th style="width:80px">状态</th><th style="width:150px">铸造时间</th><th style="width:110px">剩余时效</th><th>备注</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="pairingBody"></tbody>
    </table>
    <h3>待确认绑定</h3>
    <p class="muted small">扫码授权 / 订阅事件学到的身份（origin=learned）在此收口：确认即转正为成员，忽略即丢弃。</p>
    <table>
      <thead><tr><th style="width:90px">渠道</th><th>身份 id</th><th style="width:110px">来源</th><th style="width:150px">发现时间</th><th style="width:150px">操作</th></tr></thead>
      <tbody id="pendingBody"></tbody>
    </table>
  </section>

  <section id="tab-notify" class="tabsec">
    <p class="muted small">本页打开时可接收<b>系统桌面通知</b>（macOS 通知中心 / Windows Toast / Linux 通知服务），实时推送事件流。页面不可见时弹系统通知，可见时只进下方日志。偏好存在浏览器 localStorage。</p>
    <div class="stats">
      <div class="stat"><b id="nStream">未连接</b><span>事件流</span></div>
      <div class="stat"><b id="nPerm">未知</b><span>通知权限</span></div>
      <div class="stat"><b id="nCount">0</b><span>累计事件</span></div>
    </div>
    <div class="row">
      <button id="nPermBtn">授权系统通知</button>
      <button id="nTestBtn">发送测试通知</button>
      <label class="ck"><input type="checkbox" id="npEnable" checked> 总开关</label>
      <label class="ck"><input type="checkbox" id="npActive" checked> 普通级也弹（关=仅紧急级）</label>
      <label class="ck"><input type="checkbox" id="npSound" checked> 紧急级提示音</label>
      <label class="ck"><input type="checkbox" id="npHidden" checked> 仅页面不可见时弹</label>
    </div>
    <h3>事件日志（缓冲重放 + 实时，最多 50 条）</h3>
    <table>
      <thead><tr><th style="width:150px">时间</th><th style="width:70px">级别</th><th style="width:220px">标题</th><th>正文 / 送达</th><th style="width:64px">来源</th></tr></thead>
      <tbody id="notifyLog"><tr><td colspan="5" class="empty">暂无事件</td></tr></tbody>
    </table>
  </section>

  <section id="tab-bindings" class="tabsec">
    <p class="muted small">出站 <b>route:agents</b>：键 = workspace 名（同项目多会话聚合），或精确 agentId（优先解析）。勾选该键的出站渠道；全不勾 = 该键出站静默（仍写账本）；删除行 = 删除整条绑定（回落全局渠道池）。「保存矩阵」全量保存。</p>
    <table>
      <thead><tr><th style="width:190px">键（workspace / agentId）</th><th>出站渠道勾选</th><th>quiet</th><th>操作</th></tr></thead>
      <tbody id="agentsBody"></tbody>
    </table>
    <div class="row"><input id="newKey" placeholder="新增键：workspace 名或精确 agentId"><button id="btnAddKey">新增键</button></div>
    <h3>入站通道默认 agent（route:channels）</h3>
    <p class="muted small">对话无显式 /bind 时，该通道消息默认投给此键；留空 = 不设置（回落唯一 agent &gt; 最近活跃）。</p>
    <table>
      <thead><tr><th style="width:190px">入站通道</th><th>默认 agent（可下拉选现有键，也可自由输入）</th></tr></thead>
      <tbody id="defaultsBody"></tbody>
    </table>
    <datalist id="agentKeyOptions"></datalist>
    <p class="row"><button id="btnSaveBindings">保存矩阵</button><span id="bindingsMsg" class="inline"></span></p>
  </section>

  <section id="tab-sessions" class="tabsec">
    <p class="muted small">route:sessions 会话台账：出站按「会话 diff → 精确 agentId → workspace → 全局渠道池」实时解析，覆盖层只存 diff。quiet 只静音出站推送，入站与审批永不被静音。</p>
    <table>
      <thead><tr><th>workspace</th><th>会话</th><th>状态</th><th>出站渠道（resolved）</th><th>quiet</th><th>来源</th><th>入站挂钩</th><th>操作</th></tr></thead>
      <tbody id="sessionsBody"></tbody>
    </table>
  </section>
</main>
</div>
`
