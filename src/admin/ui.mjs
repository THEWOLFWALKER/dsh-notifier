// dsh-notifier src/admin/ui.mjs
// v0.3.3 Web 管理台单文件内嵌 HTML（设计稿 §5）：vanilla JS + fetch，零构建、无 CDN、离线可用。
// 由 src/admin/server.mjs 以 200 text/html 返回本串；无任何外部资源引用（无外链脚本 /
// link / CSS url()），系统字体栈。四标签页：Dashboard（通道健康矩阵/会话数/审计）、
// 绑定矩阵（route:agents + route:channels）、会话（route:sessions 出站覆盖 diff）、通道（凭证+测试+扫码授权）。
// 鉴权：Bearer token（用户首次输入，只保存在浏览器会话；401 清除重询）；错误形状 { error }。
// 注意：内嵌脚本刻意不用模板字符串与反斜杠，避免与外层模板字面量转义纠缠。
export const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-notifier 管理台</title>
<style>
:root {
  --bg: #0e1116; --panel: #151a22; --panel2: #1b212c; --border: #262e3b;
  --text: #d6dce6; --muted: #8a93a6; --accent: #4f8cff; --ok: #3fb950; --warn: #d29922; --err: #f85149;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--border); }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
header h1 small { color: var(--muted); font-weight: 400; margin-left: 6px; }
#loadState { color: var(--accent); }
#entryHint { color: var(--muted); font-size: 12px; min-width: 0; overflow-wrap: anywhere; flex: 1 1 220px; }
#entryUrl { color: var(--text); }
#tokenState { margin-left: auto; color: var(--muted); border-style: dashed; }
nav { display: flex; gap: 6px; padding: 10px 18px 0; flex-wrap: wrap; }
main { padding: 14px 18px 48px; max-width: 1240px; }
h3 { font-size: 14px; margin: 18px 0 8px; }
p { margin: 8px 0; }
a { color: var(--accent); }
.tabbtn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.tabsec { display: none; }
.tabsec.active { display: block; }
button { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button.danger { color: var(--err); }
input, select { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
input:focus, select:focus, button:focus { outline: 1px solid var(--accent); }
input.wide { width: 100%; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
tr.editor td { background: var(--panel2); }
.edbox { padding: 6px 2px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.center { text-align: center; }
.wrap { max-width: 520px; }
.empty { color: var(--muted); text-align: center; padding: 14px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
label.ck { display: inline-flex; align-items: center; gap: 4px; margin: 0 10px 4px 0; white-space: nowrap; font-size: 13px; }
label.fld { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
label.fld span { width: 200px; color: var(--muted); }
label.fld input { flex: 1; }
.msg, .inline { display: none; }
.msg.show, .inline.show { display: block; }
.msg { border: 1px solid var(--border); border-left-width: 3px; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; background: var(--panel); }
.inline { margin-top: 8px; font-size: 13px; }
.msg.ok, .inline.ok { color: var(--ok); border-left-color: var(--ok); }
.msg.err, .inline.err { color: var(--err); border-left-color: var(--err); }
.msg.warn, .inline.warn { color: var(--warn); border-left-color: var(--warn); }
.stats { display: flex; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; min-width: 130px; }
.stat b { display: block; font-size: 22px; }
.stat span { color: var(--muted); font-size: 12px; }
.group { margin: 6px 0 12px; }
.gtitle { font-size: 13px; margin-bottom: 4px; }
.gtitle.ok { color: var(--ok); } .gtitle.warn { color: var(--warn); } .gtitle.none { color: var(--muted); }
.chip { display: inline-block; padding: 2px 9px; margin: 2px; border-radius: 10px; font-size: 12px; border: 1px solid var(--border); }
.chip.ok { color: var(--ok); border-color: var(--ok); }
.chip.warn { color: var(--warn); border-color: var(--warn); }
.chip.none { color: var(--muted); }
.paircode { display: none; margin: 10px 0; padding: 14px 16px; border: 1px dashed var(--ok); border-radius: 8px; background: var(--panel2); }
.paircode.show { display: block; }
.paircode .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 26px; letter-spacing: 4px; color: var(--ok); word-break: break-all; }
.paircode .ttl { margin-top: 6px; font-size: 13px; color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot.ok { background: var(--ok); } .dot.off { background: var(--muted); }
.auditlist { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; max-height: 300px; overflow: auto; }
.auditrow { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.auditrow .at { color: var(--muted); white-space: nowrap; }
.auditrow b { white-space: nowrap; }
.card { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--panel); }
.card-head { display: flex; gap: 10px; align-items: center; padding: 9px 12px; cursor: pointer; }
.card-head .badge { margin-left: auto; }
.card-body { padding: 4px 12px 12px; border-top: 1px solid var(--border); }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); }
.badge.ok { color: var(--ok); border-color: var(--ok); }
.badge.none { color: var(--muted); }
.qr .mono { background: var(--panel2); padding: 3px 8px; border-radius: 6px; word-break: break-all; }
/* 首次使用引导卡（Issue #10：Dashboard 首屏 UX） */
.onboard-steps { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; }
.onboard-step { display: flex; gap: 12px; flex: 1 1 260px; padding: 10px 0; }
.onboard-num { flex: 0 0 32px; height: 32px; border-radius: 50%; background: var(--accent);
  color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; }
.onboard-body { flex: 1; min-width: 0; }
.onboard-title { font-weight: 600; margin-bottom: 4px; }
.onboard-desc { color: var(--muted); font-size: 13px; margin-bottom: 8px; line-height: 1.55; }
.onboard-step.done .onboard-num { background: var(--ok); }
.onboard-step.done .onboard-title { color: var(--muted); text-decoration: line-through; }
.muted-btn { background: transparent; border: 1px solid var(--border); color: var(--muted); font-size: 12px; padding: 3px 10px; }
.first-run-state { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 14px; }
.first-run-state .state-node { display: inline-flex; gap: 5px; align-items: center; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-size: 12px; }
.first-run-state .state-node.current { color: var(--accent); border-color: var(--accent); }
.first-run-state .state-node.done { color: var(--ok); border-color: var(--ok); }
.first-run-state .state-arrow { color: var(--muted); }
.first-visit-hint { border-left: 3px solid var(--accent); }
.first-visit-hint .card-head { cursor: default; }

/* v0.5 特性 D：移动端适配（≤768px 单列 / 导航横滚 / 宽表横滚 / 触控目标 ≥44px）。
   纯 CSS 增量，零逻辑变更零构建；桌面端（>768px）逐字节不变。 */
@media (max-width: 768px) {
  header { flex-wrap: wrap; padding: 10px 12px; gap: 8px; }
  #entryHint { flex-basis: 100%; order: 2; }
  main { padding: 12px 10px 40px; }
  nav { flex-wrap: nowrap; overflow-x: auto; padding: 8px 10px 0; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  nav::-webkit-scrollbar { display: none; }
  .tabbtn { flex: 0 0 auto; }
  label.fld { flex-direction: column; align-items: stretch; gap: 4px; }
  label.fld span { width: auto; }
  table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  button { min-height: 44px; }
  input, select { min-height: 44px; font-size: 16px; } /* 16px：iOS 聚焦不触发页面自动缩放 */
  .stat { min-width: 104px; padding: 10px 14px; }
}
</style>
</head>
<body>
<header>
  <h1>dsh-notifier 管理台<small>v0.9.0</small></h1>
  <span id="loadState" role="status" aria-live="polite"></span>
  <span id="entryHint">仅本机回环 · 当前入口：<code id="entryUrl"></code></span>
  <button id="btnCopyEntry" title="复制当前管理台地址">复制地址</button>
  <button id="tokenState" title="点击输入或更换访问 token"></button>
  <button id="btnLogout" title="清除此浏览器会话中的访问 token">退出</button>
  <button id="btnRefresh">刷新</button>
</header>
<nav>
  <button class="tabbtn active" data-tab="dashboard">Dashboard</button>
  <button class="tabbtn advanced-tab" data-tab="bindings" hidden>绑定矩阵</button>
  <button class="tabbtn advanced-tab" data-tab="sessions" hidden>会话</button>
  <button class="tabbtn" data-tab="channels">通道</button>
  <button class="tabbtn" data-tab="members">成员</button>
  <button class="tabbtn" data-tab="notify">通知</button>
  <button id="modeToggle" class="muted-btn" title="显示或隐藏高级会话与绑定设置">打开高级设置</button>
</nav>
<main>
  <div id="globalMsg" class="msg"></div>

  <section id="tab-dashboard" class="tabsec active">
    <div id="firstVisitHint" class="card first-visit-hint">
      <div class="card-head">
        <span class="dot ok"></span><b>首次打开：先走个人模式</b>
        <span class="badge none">无需先写 YAML</span>
      </div>
      <div class="card-body">
        <p>这是仅本机可访问的管理台。地址已显示在顶部；服务启动时会在终端打印访问 token，点击右上角「未设置 token」输入即可（token 只保存在当前浏览器会话）。</p>
        <div class="row">
          <button id="btnFirstVisitToken" type="button">输入管理台 token</button>
          <button class="tabbtn" data-tab="channels" type="button">配置通道 / 扫码授权 →</button>
          <button class="tabbtn" data-tab="members" type="button">配对成员 →</button>
        </div>
        <p class="muted small">个人模式默认：observe + approve 已开启；converse 可按需开启；群聊控制默认关闭。绑定矩阵与会话覆盖等高级设置默认隐藏，完成基础配置后可点顶部「打开高级设置」。</p>
        <p class="muted small">当前管理台入口：<code id="firstVisitEntryUrl"></code>（也可点顶部「复制地址」）</p>
      </div>
    </div>
    <div id="firstRunState" class="first-run-state" aria-label="首次配置进度">
      <span class="state-node current" data-state="unconfigured">未配置</span><span class="state-arrow">→</span>
      <span class="state-node" data-state="paired">已配对</span><span class="state-arrow">→</span>
      <span class="state-node" data-state="tested">测试通知</span><span class="state-arrow">→</span>
      <span class="state-node" data-state="ready">正常运行</span>
    </div>
    <!-- 首次使用引导：无成员 + 无出站通道配置时显示，完成后自动隐藏 -->
    <div id="onboarding" class="card" hidden>
      <div class="card-head" style="cursor:default">
        <span class="dot ok"></span><b>个人模式：四步开始使用 dsh-notifier</b>
        <span class="badge none" id="onboardDismiss">已完成可关闭</span>
      </div>
      <div class="card-body">
        <div class="onboard-steps">
          <div class="onboard-step" id="step1">
            <div class="onboard-num">1</div>
            <div class="onboard-body">
              <div class="onboard-title">配置通知通道</div>
              <div class="onboard-desc">挑一个你手机上有的 App 做通知通道（Bark / Telegram / 飞书 / 钉钉 / 企微 都行），填凭证点「测试发送」，手机收到就通了。</div>
              <button class="tabbtn" data-tab="channels">去「通道」页配置 →</button>
            </div>
          </div>
          <div class="onboard-step" id="step2">
            <div class="onboard-num">2</div>
            <div class="onboard-body">
              <div class="onboard-title">配对你的 IM 身份</div>
              <div class="onboard-desc">告诉插件「这个 IM 账号就是我」。扫码授权通道通常会自动登记；其他通道用配对码 <code>/pair</code> 即可。做完一次后续不用再配。</div>
              <button class="tabbtn" data-tab="members">去「成员」页配对 →</button>
            </div>
          </div>
          <div class="onboard-step" id="step3">
            <div class="onboard-num">3</div>
            <div class="onboard-body">
              <div class="onboard-title">发送测试通知</div>
              <div class="onboard-desc">回到「通道」页点击「测试发送」。成功后再开始使用，失败时页面会显示原因和下一步。</div>
              <button class="tabbtn" data-tab="channels">去「通道」页测试 →</button>
            </div>
          </div>
          <div class="onboard-step" id="step4">
            <div class="onboard-num">4</div>
            <div class="onboard-body">
              <div class="onboard-title">开始使用</div>
              <div class="onboard-desc">给 agent 发消息，它会把通知推到你刚配的通道上。需要审批的操作会发送通知给你，按提示回复编号或点按钮即可决定。</div>
              <div class="onboard-desc muted small">详细步骤见「使用指南」文档，或顶部菜单各标签页。</div>
            </div>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button id="btnHideOnboard" class="small muted-btn">我已熟悉，隐藏引导</button>
        </div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><b id="statActive">–</b><span>活跃会话</span></div>
      <div class="stat"><b id="statTotal">–</b><span>会话总数</span></div>
      <div class="stat"><b id="statKeys">–</b><span>agent 路由键</span></div>
      <div class="stat"><b id="statMembers">–</b><span>成员</span></div>
    </div>
    <h3>出站通道健康（configured / enabled 着色分组）</h3>
    <div id="outGroups"></div>
    <h3>入站通道</h3>
    <div id="inGroups"></div>
    <h3>待处理远程提问</h3>
    <div id="pendingQuestionsPanel" class="pendingq"></div>
    <h3>最近审计（写操作 append-only）</h3>
    <div id="auditList" class="auditlist"></div>
  </section>

  <section id="tab-bindings" class="tabsec">
    <p class="muted small">出站 <b>route:agents</b>：键 = workspace 名（默认，同项目多会话聚合）或精确 agentId（高级键，优先解析）。勾选该键的出站渠道；<b>全不勾 = 显式空集（该键出站全静默，仍写账本）</b>；删除行 = 删除整条绑定（出站回落全局渠道池）。「保存矩阵」按整表替换语义 PUT /api/bindings。</p>
    <table>
      <thead><tr><th style="width:190px">键（workspace / agentId）</th><th>出站渠道勾选</th><th>quiet</th><th>操作</th></tr></thead>
      <tbody id="agentsBody"></tbody>
    </table>
    <div class="row"><input id="newKey" placeholder="新增键：workspace 名或精确 agentId"><button id="btnAddKey">新增键</button></div>
    <h3>入站通道默认 agent（route:channels）</h3>
    <p class="muted small">对话无显式 /bind 时，该通道消息默认投给此键（workspace 名下多活跃会话时投最近活跃者并提示 /bind 精确指定）。留空 = 不设置（回落 唯一 agent &gt; 最近活跃）。</p>
    <table>
      <thead><tr><th style="width:190px">入站通道</th><th>默认 agent（可下拉选现有键，也可自由输入）</th></tr></thead>
      <tbody id="defaultsBody"></tbody>
    </table>
    <datalist id="agentKeyOptions"></datalist>
    <p class="row"><button id="btnSaveBindings">保存矩阵</button><span id="bindingsMsg" class="inline"></span></p>
  </section>

  <section id="tab-sessions" class="tabsec">
    <p class="muted small">route:sessions 会话台账：出站按「会话 diff → 精确 agentId → workspace → 全局渠道池」实时解析，覆盖层只存 diff，未覆盖字段跟随上游（改默认立即生效）。quiet 只静音出站推送（仍写账本），入站与审批永不被静音。</p>
    <table>
      <thead><tr><th>workspace</th><th>会话</th><th>状态</th><th>出站渠道（resolved）</th><th>quiet</th><th>来源</th><th>入站挂钩</th><th>操作</th></tr></thead>
      <tbody id="sessionsBody"></tbody>
    </table>
  </section>

  <section id="tab-channels" class="tabsec">
    <p class="muted small">凭证写入 state.json（YAML 只做首次 bootstrap）。值为 *** 的字段视为未修改，提交时自动剔除；「测试发送」做连通性自检；qq / dingtalk / feishu / wechat 入站卡片支持扫码授权（v0.3.1 扫码流，UI 展示二维码内容并轮询状态）。</p>
    <div id="channelCards"></div>
  </section>

  <section id="tab-members" class="tabsec">
    <p class="muted small">v0.7 身份成员（inbound:bindings）：谁能驱动入站（会话/审批/命令）。<b>YAML allowUsers 只做首次导入</b>（origin=migrated），此后增删改以此页为准——运行中宿主半秒内热生效，无需重启。首位成员即 owner；owner 独占铸码/撤码/删成员/改角色，末位 owner 不可删不可降。成员换号：旧号在 IM 里发 /unpair，新号持新配对码 /pair。</p>
    <div class="stats">
      <div class="stat"><b id="mCount">–</b><span>成员</span></div>
      <div class="stat"><b id="mOwners">–</b><span>owner</span></div>
      <div class="stat"><b id="mPending">–</b><span>待确认绑定</span></div>
    </div>
    <div id="mGuided" class="msg show warn" hidden>引导态：绑定表为空。宿主启动日志（stderr）有一枚引导配对码，任意通道私聊机器人发送 /pair &lt;码&gt; 即成为 owner（首位成功者单胜，码随之作废）。</div>
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
    <p class="muted small">扫码授权 / 订阅事件学到的身份（origin=learned）在此收口：确认即转正为成员，忽略即丢弃。 </p>
    <table>
      <thead><tr><th style="width:90px">渠道</th><th>身份 id</th><th style="width:110px">来源</th><th style="width:150px">发现时间</th><th style="width:150px">操作</th></tr></thead>
      <tbody id="pendingBody"></tbody>
    </table>
  </section>

  <section id="tab-notify" class="tabsec">
    <p class="muted small">本页开着的浏览器收<b>系统桌面通知</b>（macOS 通知中心 / Windows Toast / Linux 通知服务）：事件流实时推送全部广播结果；页面不可见或最小化时弹系统通知，可见时只进下方日志。偏好保存在浏览器 localStorage；权限被拒后需在浏览器站点设置里重新允许。</p>
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
</main>

<script>
'use strict'
var TOKEN_KEY = 'dsh-admin-session-token'
var SCAN_TYPES = ['qq', 'dingtalk', 'feishu', 'wechat']
var state = { overview: null, bindings: null, sessions: null, channels: null, members: null }
var draft = null
var scanTimers = {}
var flashTimer = null
var MODE_KEY = 'dsh-admin-mode'
var TESTED_KEY = 'dsh-admin-first-run-tested'

function $(sel, root) { return (root || document).querySelector(sel) }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
function plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function errText(e) { return e && e.message ? e.message : String(e) }
function byAttr(sel, attr, val) {
  var found = null
  $all(sel).forEach(function (el) { if (el.getAttribute(attr) === val) found = el })
  return found
}
function setStatus(el, text, kind) {
  if (!el) return
  el.textContent = text
  el.className = el.className.split(' ')[0] + ' show ' + (kind || 'ok')
}
function flash(text, kind) {
  setStatus($('#globalMsg'), text, kind)
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(function () { $('#globalMsg').className = 'msg' }, 6000)
}
function setLoading(on) {
  $('#loadState').textContent = on ? '加载中…' : ''
  $('#btnRefresh').disabled = on
}
function sidPrefix(id) { id = String(id || ''); return id.length > 8 ? id.slice(0, 8) + '…' : id }
function fmtTime(v) {
  if (v === undefined || v === null || v === '') return '(未知)'
  var n = Number(v)
  var d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(v)
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}
function sourceLabel(s) {
  var map = { session: '会话 diff', 'agent-exact': '精确 agentId', 'agent-workspace': 'workspace', global: '全局渠道池' }
  return map[s] || s || '(未知)'
}

// ---------- 鉴权：会话级 Bearer token；单飞门 + 401 单次恢复 ----------
// token 永不进入 URL、日志、响应或 localStorage。sessionStorage 保证同一浏览器会话刷新
// 后无需重输；受限浏览器退化到本页内存，仍可继续使用且不会因存储异常而中断。
var authGate = null
var reloginPromise = null
var authGen = 0
var recoveryUsed = false
var memoryToken = ''
function sessionStore() { try { return window.sessionStorage } catch (e) { return null } }
function getToken() {
  if (memoryToken) return memoryToken
  var store = sessionStore()
  if (store) {
    try {
      var stored = store.getItem(TOKEN_KEY) || ''
      if (stored) return stored
    } catch (e) {}
  }
  return memoryToken
}
function setCandidateToken(v) {
  memoryToken = v || ''
  var store = sessionStore()
  if (!store) return false
  try { store.removeItem(TOKEN_KEY); return true } catch (e) { return false }
}
function setToken(v) {
  memoryToken = v || ''
  var store = sessionStore()
  if (!store) return false
  try { if (v) store.setItem(TOKEN_KEY, v); else store.removeItem(TOKEN_KEY); return true } catch (e) { return false }
}
function askToken() {
  var t = window.prompt('请输入管理台访问 token（服务启动时打印；仅保存在当前浏览器会话，关闭标签页后需重新输入）：', '')
  return t && t.trim() ? t.trim() : ''
}
/** token 询问单飞门：fetch、SSE 与手动操作共享同一次弹窗；空串 = 用户取消。 */
function acquireToken() {
  if (!authGate) {
    authGate = Promise.resolve().then(function () {
      return askToken()
    }).then(function (t) {
      authGate = null
      return t
    }, function (error) {
      authGate = null
      throw error
    })
  }
  return authGate
}
function renderTokenState() {
  var t = getToken()
  $('#tokenState').textContent = t ? '会话 token 已设置（点击更换）' : '未设置 token（点击输入）'
  $('#btnLogout').disabled = !t
  var firstVisit = $('#firstVisitHint')
  if (firstVisit) firstVisit.hidden = !!t
}
function renderEntryPoint() {
  var target = window.location.origin + window.location.pathname
  $('#entryUrl').textContent = target
  var firstVisitEntry = $('#firstVisitEntryUrl')
  if (firstVisitEntry) firstVisitEntry.textContent = target
  return target
}
function copyEntryPoint() {
  var target = renderEntryPoint()
  var clipboard = window.navigator && window.navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    flash('当前地址已显示在顶部，可手动复制', 'warn')
    return
  }
  clipboard.writeText(target).then(function () { flash('管理台地址已复制', 'ok') }, function () {
    flash('复制失败：当前地址已显示在顶部，可手动复制', 'warn')
  })
}
/** 低层 Bearer 请求（不含 401 处理；401 由 apiWith/relogin 统一裁决）。 */
function request(path, options, token) {
  var init = { method: options.method || 'GET', headers: { Authorization: 'Bearer ' + token } }
  if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body) }
  return fetch(path, init)
}
/** 成功响应（非 401）才保存到会话；错误 token 不会留下。 */
function adoptToken(t) { if (t) setToken(t) }
/** 任何非 401 响应说明当前 token 当时有效 → 重新允许一次未来自动恢复。 */
function markAuthOk() { recoveryUsed = false }
/** 401 单飞重登录门：清旧 token → 单次询问 → 返回新 token（空串 = 取消）。 */
function reloginGate() {
  if (!reloginPromise) {
    reloginPromise = Promise.resolve().then(function () {
      setToken('')
      renderTokenState()
      return acquireToken()
    }).then(function (t) {
      authGen += 1 // 世代推进：此后老 token 发出的迟到 401 = 过期请求，不再自动弹窗
      reloginPromise = null
      return t
    }, function (error) {
      reloginPromise = null
      throw error
    })
  }
  return reloginPromise
}
/** 用新 token 恰好重试一次；仍 401 = 抛错（不循环）。成功则持久化并重新武装。 */
function retryRelogin(path, options, t) {
  return request(path, options, t).then(function (res) {
    if (res.status === 401) {
      setToken('')
      renderTokenState()
      throw new Error('鉴权失败：token 无效或已失效（已按一次自动重登录处理，请点击右上角 token 状态手动更新）')
    }
    markAuthOk()
    adoptToken(t)
    return res
  })
}
function api(path, options) {
  options = options || {}
  var token = getToken()
  var gen = authGen
  if (!token) return acquireToken().then(function (t) {
    if (!t) throw new Error('未提供 token，点击右上角 token 状态重新输入')
    return apiWith(path, options, t, gen)
  })
  return apiWith(path, options, token, gen)
}
/** 一次请求 + 单次 401 裁决（并发 401 共享 reloginGate，只弹一次窗）。 */
function apiWith(path, options, token, gen) {
  return request(path, options, token).then(function (res) {
    if (res.status !== 401) {
      markAuthOk()
      adoptToken(token)
      return res
    }
    if (gen < authGen) {
      // 用已作废 token 发出的迟到 401：请求本身过期，不重登录、只拒掉这一条
      throw new Error('鉴权失败：该请求基于已失效的 token，请刷新后重试')
    }
    if (reloginPromise) {
      // 已有在途重登录（并发 401）→ 等它，用新 token 各自重试一次
      return reloginGate().then(function (t) {
        if (!t) throw new Error('登录已取消')
        return retryRelogin(path, options, t)
      })
    }
    if (recoveryUsed) throw new Error('鉴权失败：token 无效或已失效（已自动重试一次，请点击右上角 token 状态手动更新）')
    recoveryUsed = true
    return reloginGate().then(function (t) {
      if (!t) throw new Error('登录已取消')
      return retryRelogin(path, options, t)
    })
  }).then(function (res) {
    return res.json().catch(function () { throw new Error('HTTP ' + res.status + '：响应不是 JSON') }).then(function (data) {
      if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status)
      return data
    })
  })
}

// ---------- 数据加载与总渲染 ----------
function overviewChannels() {
  var o = plain(state.overview)
  return Array.isArray(o.channels) ? o.channels : []
}
function outboundTypes() {
  return overviewChannels().filter(function (c) { return c.direction === 'outbound' }).map(function (c) { return c.type })
}
function inboundTypes() {
  return overviewChannels().filter(function (c) { return c.direction === 'inbound' }).map(function (c) { return c.type })
}
function loadAll() {
  setLoading(true)
  return Promise.all([api('/api/overview'), api('/api/bindings'), api('/api/sessions'), api('/api/channels'), api('/api/members'), api('/api/questions')])
    .then(function (rs) {
      state.overview = rs[0]; state.bindings = rs[1]; state.sessions = rs[2]; state.channels = rs[3]; state.members = rs[4]; state.questions = rs[5]
      draft = null
      renderDashboard(); renderBindings(); renderSessions(); renderChannels(); renderMembers(); renderPendingQuestions()
      flash('已刷新 ' + new Date().toLocaleTimeString(), 'ok')
    })
    .catch(function (e) { flash('加载失败：' + errText(e), 'err') })
    .then(function () { setLoading(false); renderTokenState() })
}
function switchTab(name) {
  $all('.tabbtn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name) })
  $all('.tabsec').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name) })
}

// 个人模式是默认路径；高级导航仅在用户明确打开后显示。localStorage 受限时按个人模式降级。
function readAdminMode() {
  try { return window.localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'personal' } catch (e) { return 'personal' }
}
function applyAdminMode() {
  var advanced = readAdminMode() === 'advanced'
  $all('.advanced-tab').forEach(function (el) { el.hidden = !advanced })
  var toggle = $('#modeToggle')
  if (toggle) toggle.textContent = advanced ? '关闭高级设置' : '打开高级设置'
  if (!advanced && (document.querySelector('#tab-bindings.active') || document.querySelector('#tab-sessions.active'))) switchTab('dashboard')
}
function setAdminMode(mode) {
  try { window.localStorage.setItem(MODE_KEY, mode === 'advanced' ? 'advanced' : 'personal') } catch (e) {}
  applyAdminMode()
}
function readTestedState() {
  try { return window.localStorage.getItem(TESTED_KEY) === '1' } catch (e) { return false }
}
function markTestedState() {
  try { window.localStorage.setItem(TESTED_KEY, '1') } catch (e) {}
}

// ---------- Dashboard：通道健康矩阵 + 统计 + 审计流 ----------
/** 审计 detail 归一为可展示文本：对象/数组 JSON.stringify，空值空串（避免 [object Object]）。 */
function fmtDetail(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch (e) { return String(v) } }
  return String(v)
}
function chipGroups(groups, emptyText) {
  var total = 0
  groups.forEach(function (g) { total += g[2].length })
  if (total === 0) return '<div class="muted small">' + esc(emptyText) + '</div>'
  return groups.map(function (g) {
    var chips = g[2].map(function (c) { return '<span class="chip ' + g[1] + '">' + esc(c.type) + '</span>' }).join('')
    return '<div class="group"><div class="gtitle ' + g[1] + '">' + esc(g[0]) + ' · ' + g[2].length + '</div>' + chips + '</div>'
  }).join('')
}
function renderDashboard() {
  var o = plain(state.overview)
  var sess = plain(o.sessions)
  var keys = plain(o.agents).keys
  var m = plain(o.members) || {}
  $('#statActive').textContent = sess.active !== undefined ? String(sess.active) : '–'
  $('#statTotal').textContent = sess.total !== undefined ? String(sess.total) : '–'
  $('#statKeys').textContent = keys !== undefined ? String(keys) : '–'
  $('#statMembers').textContent = m.total !== undefined ? String(m.total) : '–'

  var out = overviewChannels().filter(function (c) { return c.direction === 'outbound' })
  var inn = overviewChannels().filter(function (c) { return c.direction === 'inbound' })
  var outConfigured = out.filter(function (c) { return c.configured }).length
  var outEnabled = out.filter(function (c) { return c.configured && c.enabled }).length
  var anyOutConfigured = outConfigured > 0
  var anyOutEnabled = outEnabled > 0
  var hasMembers = m.total > 0

  // Issue #10：首次使用引导卡——无成员或无任何已启用出站通道时显示
  // 注：步骤 1 完成条件 = configured && enabled（仅配置未启用 = 还不能发通知）。
  // 步骤状态总是先算（无论卡显隐，保持内部状态一致），再决定是否显示。
  var ob = $('#onboarding')
  var step1Done = anyOutEnabled
  var step2Done = hasMembers
  var step3Done = hasMembers && anyOutEnabled && sess.total > 0
  var step4Done = step3Done
  $('#step1').classList.toggle('done', step1Done)
  $('#step2').classList.toggle('done', step2Done)
  $('#step3').classList.toggle('done', step3Done)
  var step4 = $('#step4')
  if (step4) step4.classList.toggle('done', step4Done)
  // 进度条单独表达首次配置状态；不写服务器状态，也不把本地测试标记当成凭证。
  var configured = anyOutConfigured
  var tested = readTestedState() || step3Done
  var ready = anyOutEnabled && hasMembers && tested
  var current = !configured ? 'unconfigured' : !hasMembers ? 'paired' : (!tested || !anyOutEnabled) ? 'tested' : 'ready'
  var order = ['unconfigured', 'paired', 'tested', 'ready']
  var currentIndex = order.indexOf(current)
  $all('#firstRunState [data-state]').forEach(function (el) {
    var idx = order.indexOf(el.getAttribute('data-state'))
    el.classList.toggle('done', ready ? idx < order.length - 1 : idx < currentIndex)
    el.classList.toggle('current', idx === currentIndex)
  })
  var userDismissed = false
  try { userDismissed = window.localStorage.getItem('onboard_dismissed') === '1' } catch (e) {}
  var allDone = step1Done && step2Done
  if (allDone) {
    ob.hidden = true
  } else {
    if (!userDismissed) ob.hidden = false
  }

  $('#outGroups').innerHTML = chipGroups([
    ['已启用（configured 且 enabled）', 'ok', out.filter(function (c) { return c.configured && c.enabled })],
    ['已配置未启用', 'warn', out.filter(function (c) { return c.configured && !c.enabled })],
    ['未配置', 'none', out.filter(function (c) { return !c.configured })]
  ], '出站通道 ' + out.length + ' 个，均未配置（打开「通道」页按字段配置；YAML 仅作为高级入口）')
  $('#inGroups').innerHTML = chipGroups([
    ['已配置', 'ok', inn.filter(function (c) { return c.configured })],
    ['未配置', 'none', inn.filter(function (c) { return !c.configured })]
  ], '（无入站通道）')
  var audit = Array.isArray(o.audit) ? o.audit.slice(0, 30) : []
  $('#auditList').innerHTML = audit.map(function (row) {
    var r = plain(row)
    return '<div class="auditrow"><span class="at">' + esc(fmtTime(r.time)) + '</span><b>' + esc(r.action || '') + '</b><span class="mono">' + esc(fmtDetail(r.detail)) + '</span></div>'
  }).join('') || '<div class="muted small" style="padding:8px 0">暂无审计记录</div>'
}

// ---------- 路线图阶段 2A：待处理远程提问（脱敏只读快照 + 受保护结算）----------
// 只渲染 { ref, question, options, source(掩码), agent(掩码), 时间 }；token/凭证/完整标识
// 绝不下发到 DOM。为每个选项提供「采用此项」、整题一个「驳回（交还桌面）」。
function renderPendingQuestions() {
  var list = Array.isArray(state.questions) ? state.questions : []
  var el = $('#pendingQuestionsPanel')
  if (!el) return
  if (!list.length) {
    el.innerHTML = '<div class="muted small" style="padding:8px 0">暂无待处理远程提问</div>'
    return
  }
  el.innerHTML = list.map(function (q) {
    var qq = plain(q)
    var opts = (Array.isArray(qq.options) ? qq.options : []).map(function (label, idx) {
      return '<li><code>' + esc(String(idx + 1)) + '</code> · ' + esc(String(label)) +
        ' <button type="button" class="small q-choose" data-ref="' + esc(qq.ref) + '" data-opt="' + idx + '">采用此项</button></li>'
    }).join('')
    var cul = (Array.isArray(qq.source) ? qq.source : []).map(function (s) {
      var sp = plain(s)
      return (esc(String(sp.channel || '?'))) + (sp.user ? ' · ' + esc(sp.user) : '') + (sp.chat ? ' · ' + esc(sp.chat) : '')
    }).join('；')
    var meta = []
    if (qq.agent) meta.push('agent ' + esc(qq.agent))
    if (cul) meta.push('来源 ' + cul)
    meta.push('创建 ' + esc(fmtTime(qq.createdAt)))
    meta.push('截至 ' + esc(fmtTime(qq.expiresAt)))
    return '<div class="card"><div class="card-head" style="cursor:default"><span class="dot warn"></span>' +
      '<b>' + esc(String(qq.question || '(无文本)')) + '</b><span class="badge none">待决</span></div>' +
      '<div class="card-body"><ul class="qopts">' + opts + '</ul>' +
      '<div class="muted small">' + meta.join(' · ') + '</div>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="small muted-btn q-reject" data-ref="' + esc(qq.ref) + '">驳回（交还桌面处理）</button>' +
      '<span class="q-msg inline muted small"></span></div></div></div>'
  }).join('')
}
/** 提交一条 settle 到收件人识别的路由；成功/失败都写到卡片内 q-msg 并联动刷新。 */
function settleQuestionClick(ref, action, opt) {
  var target = undefined
  var refS = String(ref || '')
  if (action === 'choose' && opt !== undefined && opt !== null) {
    // Ref values come from the server but are still untrusted DOM data. Avoid
    // interpolating them into a CSS selector (a malformed quote would throw
    // before the request and leave the button stuck in an indeterminate state).
    target = $all('button[data-ref]').find(function (el) {
      return el.getAttribute('data-ref') === refS && el.getAttribute('data-opt') === String(opt)
    })
  } else {
    target = $all('button[data-ref]').find(function (el) {
      return el.getAttribute('data-ref') === refS
        && el.classList.contains(action === 'reject' ? 'q-reject' : 'q-choose')
    })
  }
  var msgBox = null
  if (target) {
    target.disabled = true
    var card = target.closest ? target.closest('.card') : null
    msgBox = card ? card.querySelector('.q-msg') : null
  }
  if (msgBox) setStatus(msgBox, '提交中…', '')
  var body = { action: action }
  if (action === 'choose') body.options = [Number(opt)]
  api('/api/questions/' + encodeURIComponent(refS) + '/settle', {
    // api()/request() serializes object bodies exactly once. Passing a
    // pre-stringified payload here would double-encode JSON and make the
    // server spread a string, dropping action/options and returning 422.
    method: 'POST', body: body
  })
    .then(function (d) { if (msgBox) setStatus(msgBox, d.message || '已结算', 'ok') })
    .catch(function (e) { if (msgBox) setStatus(msgBox, '未生效：' + errText(e), 'err') })
    .then(function () { if (target) target.disabled = false; loadAll() })
}
function onQuestionsClick(evt) {
  var btn = evt.target && evt.target.closest ? evt.target.closest('button[data-ref]') : null
  if (!btn || btn.disabled) return
  if (btn.classList.contains('q-choose')) settleQuestionClick(btn.getAttribute('data-ref'), 'choose', Number(btn.getAttribute('data-opt')))
  else if (btn.classList.contains('q-reject')) settleQuestionClick(btn.getAttribute('data-ref'), 'reject')
}

// ---------- 绑定矩阵：agent 键勾选网格 + 通道默认 agent，整表 PUT ----------
function draftFromBindings() {
  var agents = {}
  var src = plain(plain(state.bindings).agents)
  Object.keys(src).forEach(function (k) {
    var e = plain(src[k])
    agents[k] = { channels: Array.isArray(e.channels) ? e.channels.slice() : [], quiet: e.quiet === true }
  })
  var defaults = {}
  var ch = plain(plain(state.bindings).channels)
  Object.keys(ch).forEach(function (c) {
    var d = plain(ch[c]).defaultAgent
    if (typeof d === 'string' && d !== '') defaults[c] = d
  })
  return { agents: agents, defaults: defaults }
}
function renderBindings() {
  if (!draft) draft = draftFromBindings()
  var outbound = outboundTypes()
  var keys = Object.keys(draft.agents)
  var rows = keys.map(function (key) {
    var e = draft.agents[key]
    var checks = outbound.map(function (t) {
      return '<label class="ck"><input type="checkbox" data-agent="' + esc(key) + '" value="' + esc(t) + '"'
        + (e.channels.indexOf(t) >= 0 ? ' checked' : '') + '>' + esc(t) + '</label>'
    }).join('')
    return '<tr><td class="mono">' + esc(key) + '</td><td class="wrap">'
      + (checks || '<span class="muted small">（当前无出站通道可选）</span>')
      + '</td><td class="center"><input type="checkbox" data-quiet="' + esc(key) + '"' + (e.quiet ? ' checked' : '')
      + ' title="只静音出站推送（仍写账本）；入站与审批不受影响"></td>'
      + '<td class="center"><button class="danger" data-del="' + esc(key) + '">删除</button></td></tr>'
  }).join('')
  if (keys.length === 0) rows = '<tr><td colspan="4" class="empty">尚无 agent 绑定（route:agents 为空）—— 所有会话出站回落全局渠道池</td></tr>'
  $('#agentsBody').innerHTML = rows
  var drows = inboundTypes().map(function (c) {
    return '<tr><td class="mono">' + esc(c) + '</td><td><input class="wide" list="agentKeyOptions" data-default="'
      + esc(c) + '" value="' + esc(draft.defaults[c] || '') + '" placeholder="未设置：显式 bind &gt; 唯一 agent &gt; 最近活跃"></td></tr>'
  }).join('')
  $('#defaultsBody').innerHTML = drows || '<tr><td colspan="2" class="empty">（无入站通道）</td></tr>'
  $('#agentKeyOptions').innerHTML = keys.map(function (k) { return '<option value="' + esc(k) + '"></option>' }).join('')
}
function onBindingsChange(ev) {
  if (!draft) draft = draftFromBindings()
  var el = ev.target
  var key = el.getAttribute('data-agent')
  var quietKey = el.getAttribute('data-quiet')
  var defChan = el.getAttribute('data-default')
  if (key !== null && draft.agents[key]) {
    var list = draft.agents[key].channels
    var i = list.indexOf(el.value)
    if (el.checked && i < 0) list.push(el.value)
    if (!el.checked && i >= 0) list.splice(i, 1)
  } else if (quietKey !== null && draft.agents[quietKey]) {
    draft.agents[quietKey].quiet = el.checked
  } else if (defChan !== null) {
    draft.defaults[defChan] = el.value
  }
}
function onBindingsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  if (!draft) draft = draftFromBindings()
  if (btn.id === 'btnAddKey') {
    var v = $('#newKey').value.trim()
    if (v === '') { setStatus($('#bindingsMsg'), '请输入键名（workspace 名或精确 agentId）', 'err'); return }
    if (draft.agents[v]) { setStatus($('#bindingsMsg'), '键已存在：' + v, 'err'); return }
    draft.agents[v] = { channels: [], quiet: false }
    $('#newKey').value = ''
    renderBindings()
    setStatus($('#bindingsMsg'), '已加入编辑表（注意：全不勾渠道 = 显式空集 = 该键出站全静默）', 'warn')
  } else if (btn.id === 'btnSaveBindings') {
    saveBindings(btn)
  } else if (btn.getAttribute('data-del')) {
    var k = btn.getAttribute('data-del')
    delete draft.agents[k]
    renderBindings()
    setStatus($('#bindingsMsg'), '已从编辑表移除：' + k + '（点「保存矩阵」后整表生效）', 'warn')
  }
}
function saveBindings(btn) {
  var agents = {}
  Object.keys(draft.agents).forEach(function (k) {
    agents[k] = { channels: draft.agents[k].channels.slice(), quiet: draft.agents[k].quiet === true }
  })
  var channels = {}
  $all('#tab-bindings input[data-default]').forEach(function (inp) {
    var v = inp.value.trim()
    if (v !== '') channels[inp.getAttribute('data-default')] = { defaultAgent: v }
  })
  btn.disabled = true; var old = btn.textContent; btn.textContent = '保存中…'
  api('/api/bindings', { method: 'PUT', body: { agents: agents, channels: channels } })
    .then(function (nb) { state.bindings = nb; draft = null; renderBindings(); setStatus($('#bindingsMsg'), '矩阵已保存（整表替换生效，未配置的会话即刻跟随新默认）', 'ok') })
    .catch(function (e) { setStatus($('#bindingsMsg'), '保存失败：' + errText(e), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}

// ---------- 会话：台账列表 + 出站覆盖（diff）编辑，PATCH ----------
function sessionRow(s, outbound) {
  var id = String(s.id || '')
  var res = plain(s.resolved)
  var diff = plain(s.outbound)
  var resolvedCh = Array.isArray(res.channelTypes) ? res.channelTypes : []
  var hasDiffCh = Array.isArray(diff.channels)
  var initCh = hasDiffCh ? diff.channels : resolvedCh
  var checks = outbound.map(function (t) {
    return '<label class="ck"><input type="checkbox" data-sch="' + esc(id) + '" value="' + esc(t) + '"'
      + (initCh.indexOf(t) >= 0 ? ' checked' : '') + '>' + esc(t) + '</label>'
  }).join('')
  var qv = diff.quiet === undefined || diff.quiet === null ? '' : (diff.quiet ? 'on' : 'off')
  var qsel = '<select data-squiet="' + esc(id) + '">'
    + '<option value=""' + (qv === '' ? ' selected' : '') + '>quiet 跟随上游</option>'
    + '<option value="on"' + (qv === 'on' ? ' selected' : '') + '>quiet 开（静音）</option>'
    + '<option value="off"' + (qv === 'off' ? ' selected' : '') + '>quiet 关</option></select>'
  var main = '<tr><td>' + esc(s.workspace || '(未知)') + '</td>'
    + '<td class="mono" title="' + esc(id) + '">' + esc(sidPrefix(id)) + '</td>'
    + '<td><span class="dot ' + (s.active ? 'ok' : 'off') + '"></span>' + (s.active ? '活跃' : '已离场') + '</td>'
    + '<td class="wrap">' + esc(resolvedCh.join('、') || '(空)') + '</td>'
    + '<td>' + (res.quiet ? '静音' : '正常') + '</td>'
    + '<td>' + esc(sourceLabel(res.source)) + '</td>'
    + '<td class="center">' + (Array.isArray(s.inbound) ? String(s.inbound.length) : '0') + '</td>'
    + '<td><button data-edit="' + esc(id) + '">编辑出站</button></td></tr>'
  var editor = '<tr class="editor" data-edfor="' + esc(id) + '" hidden><td colspan="8"><div class="edbox">'
    + '<label class="ck"><input type="checkbox" data-sover="' + esc(id) + '"' + (hasDiffCh ? ' checked' : '') + '>覆盖出站渠道</label>'
    + checks + '<span class="muted">·</span>' + qsel + '<button data-save="' + esc(id) + '">PATCH 保存</button>'
    + '<div class="inline" data-sstat="' + esc(id) + '"></div>'
    + '<div class="muted small">不勾「覆盖出站渠道」→ channels 发 null（删覆盖键，回落上游实时解析）；quiet 选「跟随上游」→ 发 null。</div>'
    + '</div></td></tr>'
  return main + editor
}
function renderSessions() {
  var list = Array.isArray(state.sessions) ? state.sessions : []
  var outbound = outboundTypes()
  $('#sessionsBody').innerHTML = list.map(function (s) { return sessionRow(plain(s), outbound) }).join('')
    || '<tr><td colspan="8" class="empty">尚无会话记录（route:sessions 为空；会话在 agent/created 时自动建档，出站回落全局渠道池）</td></tr>'
}
function onSessionsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  var id = btn.getAttribute('data-edit')
  if (id) {
    $all('tr[data-edfor]').forEach(function (tr) { if (tr.getAttribute('data-edfor') === id) tr.hidden = !tr.hidden })
    return
  }
  var saveId = btn.getAttribute('data-save')
  if (saveId) saveSession(saveId, btn)
}
function saveSession(id, btn) {
  var msg = byAttr('.inline[data-sstat]', 'data-sstat', id)
  var over = byAttr('input[data-sover]', 'data-sover', id)
  var qsel = byAttr('select[data-squiet]', 'data-squiet', id)
  var chans = $all('input[data-sch]').filter(function (c) { return c.getAttribute('data-sch') === id && c.checked })
    .map(function (c) { return c.value })
  var body = { channels: over && over.checked ? chans : null, quiet: !qsel || qsel.value === '' ? null : qsel.value === 'on' }
  btn.disabled = true; var old = btn.textContent; btn.textContent = '保存中…'
  api('/api/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: body })
    .then(function () { return api('/api/sessions') })
    .then(function (list) {
      state.sessions = list
      renderSessions()
      flash('会话出站覆盖已保存：' + sidPrefix(id), 'ok')
    })
    .catch(function (e) { setStatus(msg, '保存失败：' + errText(e), 'err') })
    .then(function () { if (btn.parentNode) { btn.disabled = false; btn.textContent = old } })
}

// ---------- 通道：凭证表单（fields 驱动建单 + *** 未修改剔除）+ 测试发送 + 扫码授权轮询 ----------
function splitKey(key) { var i = key.indexOf('|'); return [key.slice(0, i), key.slice(i + 1)] }
/**
 * 单个凭证字段行：fields 声明表驱动（required 标 * / desc 作 placeholder 与悬停提示），
 * config 已有键带脱敏当前值（字符串 → ***），fields 有而 config 无的键留空 = 从零新建。
 */
function fieldRow(key, spec, current, disabled) {
  var specObj = plain(spec)
  var req = specObj.required === true
  var desc = typeof specObj.desc === 'string' && specObj.desc !== '' ? specObj.desc : ''
  var shown = current === undefined ? '' : current
  return '<label class="fld"><span class="mono">' + esc(key) + (req ? ' <b style="color:var(--warn)">*</b>' : '')
    + '</span><input data-ck="' + esc(key) + '"' + (req ? ' data-req="1"' : '')
    + ' value="' + esc(shown) + '"'
    + (disabled ? ' disabled title="只读字段"' : '')
    + (desc ? ' title="' + esc(desc) + '" placeholder="' + esc(desc) + '"' : '')
    + '></label>'
}
function cardHtml(c) {
  var cfg = plain(c.config)
  var specs = plain(c.fields)
  var ro = c.editable === false // 双域出站：键域归入站，UI 只读
  // 字段键 = fields 声明键 ∪ config 现有键（YAML bootstrap 的 endpoint/timeoutMs 等也要展示）
  var seen = {}
  var keys = Object.keys(specs).filter(function (k) { seen[k] = 1; return true })
    .concat(Object.keys(cfg).filter(function (k) { return !seen[k] }))
  var fields = keys.map(function (k) {
    var current = Object.prototype.hasOwnProperty.call(cfg, k)
      ? (cfg[k] === undefined || cfg[k] === null ? '***' : cfg[k])
      : undefined
    return fieldRow(k, specs[k], current, ro)
  }).join('')
  var dir = c.direction === 'inbound' ? '入站' : '出站'
  var badge = c.configured ? '<span class="badge ok">已配置</span>' : '<span class="badge none">未配置</span>'
  var scan = c.direction === 'inbound' && SCAN_TYPES.indexOf(c.type) >= 0
    ? '<button data-scan="' + esc(c.type) + '">扫码授权</button>' : ''
  // 微信专属提示：iLink 机器人 = 扫码微信的专属好友（1:1），扫码那一刻即完成配对
  var wechatHint = c.type === 'wechat' && c.direction === 'inbound'
    ? '<p class="muted small">点「扫码授权」网页直接出二维码，用<b>你自己的微信</b>扫并确认：机器人会出现在你的微信好友里（专属好友，只和你聊），<b>扫码那一刻就完成配对</b>，不需要配对码。</p>'
    : ''
  var key = c.type + '|' + c.direction
  // v0.7（审查 #8）：testChannel 语义是出站连通性自检——入站凭证行按钮换文案，
  // 不再让用户误以为它能验证入站链路是否可用
  var testLabel = c.direction === 'inbound' ? '连通性自检（出站）' : '测试发送'
  var controls = ro
    ? '<span class="muted small">只读：出站 webhook 走 YAML bootstrap（cordis.patch.yml channels）——'
      + esc(c.type) + ':account 键域归入站机器人凭证，网页写入会破坏扫码凭证</span>'
    : '<button data-save="' + esc(key) + '">保存</button>'
  return '<div class="card" data-key="' + esc(key) + '">'
    + '<div class="card-head"><b class="mono">' + esc(c.type) + '</b><span class="muted small">' + dir + '</span>' + badge + '</div>'
    + '<div class="card-body" hidden>'
    + (fields || '<p class="muted small">（该通道暂无可编辑凭证键）</p>')
    + wechatHint
    + (keys.length > 0 && !ro
      ? '<p class="muted small">值为 *** 的字段视为未修改，提交时自动剔除；带 * 为必填（空值不提交）。</p>' : '')
    + '<div class="row">' + controls
    + '<button data-test="' + esc(key) + '" title="验证该渠道的出站链路连通性（入站凭证是否可用需在 IM 端实际收发验证）">' + esc(testLabel) + '</button>' + scan + '</div>'
    + '<div class="inline" data-cmsg="' + esc(key) + '"></div>'
    + '<div class="inline" data-smsg="' + esc(c.type) + '"></div>'
    + '</div></div>'
}
function renderChannels() {
  var list = Array.isArray(state.channels) ? state.channels : []
  $('#channelCards').innerHTML = list.map(function (c) { return cardHtml(plain(c)) }).join('')
    || '<p class="muted">（通道列表为空）</p>'
}
function saveChannel(key, btn) {
  var type = splitKey(key)[0]
  var direction = splitKey(key)[1]
  var card = byAttr('.card[data-key]', 'data-key', key)
  var msg = byAttr('.inline[data-cmsg]', 'data-cmsg', key)
  var payload = {}
  var missing = []
  $all('input[data-ck]', card).forEach(function (inp) {
    var k = inp.getAttribute('data-ck')
    // 必填字段被清空（值非 *** 即代表用户动过）→ 记入缺失清单提示，不静默剔除
    if (inp.getAttribute('data-req') === '1' && inp.value !== '***' && inp.value.trim() === '') {
      missing.push(k)
      return
    }
    if (inp.value === '***' || inp.value === '') return // *** 未修改 / 空值，均不提交
    payload[k] = inp.value
  })
  if (missing.length > 0) {
    setStatus(msg, '必填字段未填写：' + missing.join('、'), 'err')
    return
  }
  if (Object.keys(payload).length === 0) {
    setStatus(msg, '没有修改的字段（值为 *** 视为未修改，空值不提交），已跳过保存', 'warn')
    return
  }
  btn.disabled = true; var old = btn.textContent; btn.textContent = '保存中…'
  api('/api/channels/' + encodeURIComponent(type), { method: 'PUT', body: { config: payload } })
    .then(function (r) {
      if (plain(r).saved === false) {
        setStatus(msg, '写入失败：state 存储不可用（查看插件日志）', 'err')
        return
      }
      // 热更新边界：store 凭证在下次插件启动时并入运行时（YAML ⊕ store 合并）；
      // v0.7（审查 #8）：不再引导用户用出站自检去“验证”入站凭证——语义分开说清
      setStatus(msg, direction === 'inbound'
        ? '凭证已保存（state.json，0600）；入站通道在插件下次启动时启用/重连。入站是否可用请在 IM 端实际发消息验证'
        : '凭证已保存（state.json，0600）；出站在插件下次启动时并入运行时（YAML ⊕ store 合并），可点「测试发送」验证出站链路', 'ok')
    })
    .catch(function (e) { setStatus(msg, '保存失败：' + errText(e), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}
function testChannel(key, btn) {
  var type = splitKey(key)[0]
  var msg = byAttr('.inline[data-cmsg]', 'data-cmsg', key)
  btn.disabled = true; var old = btn.textContent; btn.textContent = '测试中…'
  api('/api/channels/' + encodeURIComponent(type) + '/test', { method: 'POST' })
    .then(function (r) {
      var ok = plain(r).ok === true
      if (ok) {
        markTestedState()
        setStatus(msg, '测试通过' + (r.detail ? '：' + r.detail : '') + '；下一步：回 Dashboard 确认状态，或直接开始使用', 'ok')
      } else {
        setStatus(msg, '测试失败' + (r.detail ? '：' + r.detail : '') + '；下一步：检查必填凭证后重试', 'err')
      }
    })
    .catch(function (e) { setStatus(msg, '测试失败：' + errText(e), 'err') })
    .then(function () { btn.disabled = false; btn.textContent = old })
}
function scanMsgEl(type) { return byAttr('.inline[data-smsg]', 'data-smsg', type) }
function toggleScan(type, btn) {
  if (scanTimers[type]) {
    clearTimeout(scanTimers[type]); scanTimers[type] = null
    btn.textContent = '扫码授权'
    setStatus(scanMsgEl(type), '已停止轮询扫码状态', 'warn')
    return
  }
  btn.textContent = '停止轮询'
  scanStep(type, btn)
}
function scanStep(type, btn) {
  api('/api/scan/' + encodeURIComponent(type), { method: 'POST' })
    .then(function (r) {
      var qr = plain(r).qrContent
      var failed = typeof r.error === 'string' && r.error !== ''
      var html = ''
      if (qr) {
        html += '<div class="row qr"><span class="mono">' + esc(qr) + '</span><button data-copy="' + esc(qr) + '">复制</button></div>'
        html += /^https?:/i.test(qr)
          ? '<div class="small"><a href="' + esc(qr) + '" target="_blank" rel="noopener">打开授权链接</a> · 或复制内容贴到扫码工具</div>'
          : '<div class="small muted">复制上面的内容，贴到任意扫码工具完成授权</div>'
      }
      if (failed) html += '<div class="small" style="color:var(--err)">扫码失败：' + esc(r.error) + '（可重新发起）</div>'
      else if (r.saved) html += '<div class="small" style="color:var(--ok)">授权完成，凭证已保存（通道在插件下次启动时启用/重连）</div>'
      else if (r.done) html += '<div class="small" style="color:var(--ok)">扫码流程已完成</div>'
      else html += '<div class="small muted">等待扫码确认…（每 2 秒轮询一次）</div>'
      var el = scanMsgEl(type)
      if (el) { el.className = 'inline show ' + (failed ? 'err' : 'ok'); el.innerHTML = html }
      if (!r.done && !r.saved && !failed) scanTimers[type] = setTimeout(function () { scanStep(type, btn) }, 2000)
      else { scanTimers[type] = null; btn.textContent = '扫码授权' }
    })
    .catch(function (e) {
      scanTimers[type] = null
      btn.textContent = '扫码授权'
      setStatus(scanMsgEl(type), '扫码授权失败：' + errText(e), 'err')
    })
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { flash('已复制到剪贴板', 'ok') },
      function () { flash('复制失败，请手动选择文本复制', 'err') })
  } else {
    window.prompt('请手动复制：', text)
  }
}
function onChannelsClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (btn) {
    var saveKey = btn.getAttribute('data-save')
    var testKey = btn.getAttribute('data-test')
    var scanType = btn.getAttribute('data-scan')
    var copyVal = btn.getAttribute('data-copy')
    if (saveKey) { saveChannel(saveKey, btn); return }
    if (testKey) { testChannel(testKey, btn); return }
    if (scanType) { toggleScan(scanType, btn); return }
    if (copyVal) { copyText(copyVal); return }
  }
  var head = ev.target.closest ? ev.target.closest('.card-head') : null
  if (head) {
    var body = head.parentNode.querySelector('.card-body')
    if (body) body.hidden = !body.hidden
  }
}

// ---------- 成员页（v0.7）：身份绑定表 + 配对码生命周期 + 待确认绑定 ----------
function fmtRemain(ms) {
  var s = Math.floor(ms / 1000)
  if (s <= 0) return '已过期'
  var m = Math.floor(s / 60)
  if (m >= 60) return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分'
  return m + ' 分 ' + (s % 60) + ' 秒'
}
var pairCountdownTimer = null
function stopPairCountdown() {
  if (pairCountdownTimer) { clearInterval(pairCountdownTimer); pairCountdownTimer = null }
  var box = $('#pairCodeBox')
  if (box) { box.hidden = true; box.className = 'paircode' }
}
function showPairCode(r) {
  var box = $('#pairCodeBox')
  box.innerHTML = '<div class="code">' + esc(r.code) + '</div>'
    + '<div class="ttl">有效期至 ' + esc(fmtTime(r.expiresAt)) + '（<span data-remain></span>）——码面仅此一次展示，关闭后不可找回；发给用户私聊命令：/pair ' + esc(r.code) + '</div>'
  box.hidden = false
  box.className = 'paircode show'
  stopPairCountdown()
  var remain = box.querySelector('[data-remain]')
  pairCountdownTimer = setInterval(function () {
    var left = Number(r.expiresAt) - Date.now()
    if (left <= 0) { stopPairCountdown(); return }
    remain.textContent = '剩余 ' + fmtRemain(left)
  }, 1000)
  remain.textContent = '剩余 ' + fmtRemain(Number(r.expiresAt) - Date.now())
}
function mintPairingCode() {
  var btn = $('#btnMint')
  var msg = $('#pairMsg')
  var body = { ttlMin: Number($('#pairTtl').value) || 10 }
  var label = $('#pairLabel').value.trim()
  if (label !== '') body.label = label
  btn.disabled = true
  api('/api/pairing', { method: 'POST', body: body })
    .then(function (r) {
      var res = plain(r)
      showPairCode(res)
      var ttlText = body.ttlMin >= 60 ? Math.floor(body.ttlMin / 60) + ' 小时内有效' : body.ttlMin + ' 分钟内有效'
      setStatus(msg, '已铸造（id ' + (res.id || '') + '）。' + ttlText + '，单次核销。', 'ok')
      return loadMembersOnly()
    })
    .catch(function (e) { setStatus(msg, '铸造失败：' + errText(e), 'err') })
    .then(function () { btn.disabled = false })
}
function loadMembersOnly() {
  return api('/api/members').then(function (r) { state.members = r; renderMembers() })
    .catch(function (e) { flash('成员数据刷新失败：' + errText(e), 'err') })
}
function renderMembers() {
  var m = plain(state.members)
  var members = Array.isArray(m.members) ? m.members : []
  var pending = Array.isArray(m.pending) ? m.pending : []
  var codes = Array.isArray(m.pairingCodes) ? m.pairingCodes : []
  $('#mCount').textContent = String(members.length)
  $('#mOwners').textContent = String(members.filter(function (r) { return plain(r).role === 'owner' }).length)
  $('#mPending').textContent = String(pending.length)
  $('#mGuided').hidden = m.guided !== true
  $('#membersBody').innerHTML = members.map(function (row) {
    var r = plain(row)
    return '<tr>'
      + '<td><span class="chip ' + (r.role === 'owner' ? 'warn' : 'ok') + '">' + esc(r.channel) + '</span></td>'
      + '<td class="mono" title="' + esc(r.key) + '">' + esc(r.userId) + '</td>'
      + '<td><input data-mlabel="' + esc(r.key) + '" value="' + esc(r.label || '') + '" placeholder="备注" style="max-width:160px"></td>'
      + '<td><select data-mrole="' + esc(r.key) + '">'
      + '<option value="member"' + (r.role !== 'owner' ? ' selected' : '') + '>member</option>'
      + '<option value="owner"' + (r.role === 'owner' ? ' selected' : '') + '>owner</option>'
      + '</select></td>'
      + '<td>' + esc(fmtTime(r.pairedAt)) + '</td>'
      + '<td>' + (Number(r.lastSeenAt) > 0 ? esc(fmtTime(r.lastSeenAt)) : '—') + '</td>'
      + '<td><button class="danger" data-mdel="' + esc(r.key) + '">删除</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="7" class="empty">暂无成员。引导态下宿主启动日志（stderr）有引导码：用户私聊机器人发送 /pair &lt;码&gt; 即成首位 owner。</td></tr>'
  $('#pairingBody').innerHTML = codes.map(function (row) {
    var r = plain(row)
    var left = Number(r.expiresAt) - Date.now()
    return '<tr>'
      + '<td class="mono">' + esc(r.id || '') + '</td>'
      + '<td>' + esc(r.origin || '') + '</td>'
      + '<td><span class="chip ' + (r.state === 'active' ? 'ok' : 'warn') + '">' + esc(r.state || '') + '</span></td>'
      + '<td>' + esc(fmtTime(r.mintedAt)) + '</td>'
      + '<td>' + esc(fmtRemain(left)) + '</td>'
      + '<td>' + esc(r.label || '') + '</td>'
      + '<td><button class="danger" data-prevoke="' + esc(r.id) + '">撤销</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="7" class="empty">无在铸配对码。生成一枚发给要接入的成员（单次核销，过期作废）。</td></tr>'
  $('#pendingBody').innerHTML = pending.map(function (row) {
    var r = plain(row)
    return '<tr>'
      + '<td><span class="chip none">' + esc(r.channel) + '</span></td>'
      + '<td class="mono">' + esc(r.userId) + '</td>'
      + '<td>' + esc(r.origin || 'learned') + '</td>'
      + '<td>' + esc(fmtTime(r.at)) + '</td>'
      + '<td><button data-pconfirm="' + esc(r.key) + '">确认转正</button>'
      + ' <button class="danger" data-pdismiss="' + esc(r.key) + '">忽略</button></td>'
      + '</tr>'
  }).join('') || '<tr><td colspan="5" class="empty">暂无待确认绑定（扫码/订阅学到的新身份会出现在这里）。</td></tr>'
}
function memberKeyOf(el, attr) { return el.getAttribute(attr) || '' }
function onMembersChange(ev) {
  var labelKey = ev.target.getAttribute && ev.target.getAttribute('data-mlabel')
  var roleKey = ev.target.getAttribute && ev.target.getAttribute('data-mrole')
  if (labelKey !== null && labelKey !== undefined && labelKey !== '' && ev.target.getAttribute('data-mlabel')) {
    api('/api/members/' + encodeURIComponent(labelKey), { method: 'PUT', body: { label: ev.target.value } })
      .then(function () { flash('备注已更新', 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('备注更新失败：' + errText(e), 'err') })
    return
  }
  if (roleKey) {
    api('/api/members/' + encodeURIComponent(roleKey), { method: 'PUT', body: { role: ev.target.value } })
      .then(function () { flash('角色已更新', 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('角色更新失败：' + errText(e), 'err'); return loadMembersOnly() })
  }
}
function onMembersClick(ev) {
  var btn = ev.target.closest ? ev.target.closest('button') : null
  if (!btn) return
  if (btn.id === 'btnMint') { mintPairingCode(); return }
  var delKey = memberKeyOf(btn, 'data-mdel')
  if (delKey) {
    if (!window.confirm('删除成员 ' + delKey + '？该身份立即失去入站权限（运行中宿主半秒内生效）。')) return
    api('/api/members/' + encodeURIComponent(delKey), { method: 'DELETE' })
      .then(function () { flash('已删除成员 ' + delKey, 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('删除失败：' + errText(e), 'err') })
    return
  }
  var revokeId = memberKeyOf(btn, 'data-prevoke')
  if (revokeId) {
    // Revoking a pairing code is destructive: the one-shot code becomes unusable
    // immediately and cannot be recovered. Require an explicit confirmation so a
    // fat-fingered click on a narrow/mobile layout does not strand the invitee.
    if (!window.confirm('撤销配对码 ' + revokeId + '？该码将立即失效，且无法恢复。')) return
    api('/api/pairing/' + encodeURIComponent(revokeId), { method: 'DELETE' })
      .then(function () { flash('已撤销配对码 ' + revokeId, 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('撤销失败：' + errText(e), 'err') })
    return
  }
  var confirmKey = memberKeyOf(btn, 'data-pconfirm')
  if (confirmKey) {
    api('/api/members/' + encodeURIComponent(confirmKey) + '/confirm', { method: 'POST' })
      .then(function () { flash('已确认转正 ' + confirmKey, 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('确认失败：' + errText(e), 'err') })
    return
  }
  var dismissKey = memberKeyOf(btn, 'data-pdismiss')
  if (dismissKey) {
    if (!window.confirm('忽略待确认绑定 ' + dismissKey + '？当前请求将被删除，之后需要对方重新触发订阅/扫码。')) return
    api('/api/members/' + encodeURIComponent(dismissKey) + '/dismiss', { method: 'POST' })
      .then(function () { flash('已忽略 ' + dismissKey, 'ok'); return loadMembersOnly() })
      .catch(function (e) { flash('操作失败：' + errText(e), 'err') })
  }
}

// ---------- 通知页：SSE 事件流 → 系统桌面通知 + Web Audio 提示音 + 页面日志 ----------
// 偏好四项存 localStorage（默认全开）：总开关 / 普通级也弹 / 紧急级提示音 / 仅页面不可见时弹。
// 语义（对齐参考成品 dsh-notification 的取舍）：replay 事件只进日志不弹（断线期间的不补弹）；
// 同级别 tag 复用让新通知顶掉旧的（通知中心不堆山）；声音走 Web Audio（用户手势解锁 AudioContext）。
var NOTIFY_PREFS_KEY = 'dsh-notify-prefs'
var notifyLog = []
var notifyCount = 0
var audioCtx = null
var notifyStreamTimer = null
var notifyStreamEpoch = 0

function readNotifyPrefs() {
  var p = {}
  try { p = plain(JSON.parse(window.localStorage.getItem(NOTIFY_PREFS_KEY) || '{}')) } catch (e) {}
  return {
    enable: p.enable !== false,
    active: p.active !== false,
    sound: p.sound !== false,
    hiddenOnly: p.hiddenOnly !== false,
  }
}
function writeNotifyPrefs() {
  var p = readNotifyPrefs()
  try { window.localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(p)) } catch (e) {}
  $('#npEnable').checked = p.enable
  $('#npActive').checked = p.active
  $('#npSound').checked = p.sound
  $('#npHidden').checked = p.hiddenOnly
}
function setStreamState(text) { var el = $('#nStream'); if (el) el.textContent = text }
function stopNotifyStream() {
  notifyStreamEpoch += 1
  if (notifyStreamTimer) { clearTimeout(notifyStreamTimer); notifyStreamTimer = null }
}
function renderPermState() {
  var el = $('#nPerm')
  if (!el) return
  var perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  el.textContent = perm === 'granted' ? '已授权' : perm === 'denied' ? '已拒绝' : perm === 'unsupported' ? '不支持' : '未授权'
}
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    var osc = audioCtx.createOscillator()
    var gain = audioCtx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start()
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4)
    osc.stop(audioCtx.currentTime + 0.45)
  } catch (e) { /* 声音是锦上添花：AudioContext 被策略挡住时静默 */ }
}
/** 弹系统通知：同级别 tag 复用（新事件顶掉旧横幅）；构造失败静默（API 缺失/权限收回）。 */
function fireNotification(title, body, level) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try { new Notification(title, { body: body, tag: 'dsh-notify-' + level }) } catch (e) {}
}
function levelClass(level) {
  return level === 'timeSensitive' ? 'err' : level === 'active' ? 'ok' : 'none'
}
function onNotifyEvent(evt) {
  var e = plain(evt)
  var payload = plain(e.payload)
  var msg = plain(payload.message)
  notifyCount += 1
  $('#nCount').textContent = String(notifyCount)
  notifyLog.unshift({ time: e.time || '', level: msg.level || '', title: msg.title || '(无标题)', body: msg.content || '', delivered: Array.isArray(payload.delivered) ? payload.delivered : [], failed: Array.isArray(payload.failed) ? payload.failed.length : 0, replay: e.replay === true })
  if (notifyLog.length > 50) notifyLog.length = 50
  renderNotifyLog()
  if (e.replay === true) return // 断线期间的事件只补日志不补弹（不轰炸通知中心）
  var prefs = readNotifyPrefs()
  if (!prefs.enable) return
  if (msg.level === 'passive') return // 摘要类永不弹
  if (msg.level !== 'timeSensitive' && !prefs.active) return
  if (prefs.hiddenOnly && document.hidden === false) return // 页面正看着：日志已可见，不再弹系统横幅
  fireNotification(msg.title || 'dsh-notifier', msg.content || '', msg.level || 'active')
  if (prefs.sound && msg.level === 'timeSensitive') beep()
}
function renderNotifyLog() {
  var body = $('#notifyLog')
  if (!body) return
  if (notifyLog.length === 0) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无事件</td></tr>'; return }
  body.innerHTML = notifyLog.map(function (row) {
    var delivery = row.delivered.length > 0 ? '送达 ' + row.delivered.join('、') : '未送达'
    if (row.failed > 0) delivery += '（' + row.failed + ' 渠道失败）'
    return '<tr><td class="small">' + esc(fmtTime(row.time)) + '</td>'
      + '<td><span class="chip ' + levelClass(row.level) + '">' + esc(row.level || '?') + '</span></td>'
      + '<td>' + esc(row.title) + '</td>'
      + '<td class="small">' + esc(row.body) + '<div class="muted small">' + esc(delivery) + '</div></td>'
      + '<td class="small">' + (row.replay ? '重放' : '实时') + '</td></tr>'
  }).join('')
}
/** SSE 客户端（fetch 流式读：EventSource 不支持 Authorization 头）；断线 5s 退避重连。
 * 401 与 api 共用同一 reloginGate：并发时只弹一次窗，重登录成功后原流重播。 */
function startNotifyStream(explicitToken) {
  if (notifyStreamTimer) { clearTimeout(notifyStreamTimer); notifyStreamTimer = null }
  var token = explicitToken || getToken()
  if (!token) {
    // 首访无 token：与并行 loadAll 共享同一单飞询问（不重复弹窗）
    var waitingGen = authGen
    acquireToken().then(function (t) {
      if (t && waitingGen === authGen) startNotifyStream(t)
      else setStreamState('未设置 token，点击右上角 token 状态输入')
    })
    return
  }
  var gen = authGen
  var epoch = notifyStreamEpoch + 1
  notifyStreamEpoch = epoch
  fetch('/api/events', { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
    if (epoch !== notifyStreamEpoch) return
    if (res.status === 401) {
      if (gen >= authGen) { handleStream401(token); return } // 活 token 失效 → 走共享重登录门
      setStreamState('旧会话请求已失效；当前 token 未受影响'); return // 迟到旧流不得清掉新 token
    }
    markAuthOk()
    adoptToken(token) // 连接正常 → 持久化（首访 prompt 输入的 token 在此落库）
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
    setStreamState('已连接')
    var reader = res.body.getReader()
    var decoder = new TextDecoder()
    var buf = ''
    function pump() {
      return reader.read().then(function (chunk) {
        if (epoch !== notifyStreamEpoch || gen !== authGen) throw new Error('stream superseded')
        if (chunk.done) throw new Error('stream end')
        buf += decoder.decode(chunk.value, { stream: true })
        var blocks = buf.split('\\n\\n')
        buf = blocks.pop()
        blocks.forEach(function (block) {
          block.split('\\n').forEach(function (line) {
            if (line.indexOf('data: ') !== 0) return // ': connected'/': hb' 注释行
            try { onNotifyEvent(JSON.parse(line.slice(6))) } catch (e) { /* 残包/坏包丢弃 */ }
          })
        })
        return pump()
      })
    }
    return pump()
  }).catch(function () {
    if (epoch !== notifyStreamEpoch || gen !== authGen || getToken() !== token) return
    setStreamState('已断开，5 秒后重连')
    notifyStreamTimer = setTimeout(startNotifyStream, 5000)
  })
}
/** SSE 401 单次重登录（与 api 共享门；并发已由 reloginGate 兜住）。 */
function handleStream401(lastToken) {
  if (reloginPromise) {
    reloginGate().then(function (t) { if (t) startNotifyStream(t); else setStreamState('token 失效（未重新登录，请点击右上角重试）') })
    return
  }
  if (recoveryUsed) { setStreamState('token 失效（已自动重试一次，请刷新或点击右上角更新）'); return }
  recoveryUsed = true
  reloginGate().then(function (t) {
    if (t) startNotifyStream(t)
    else { setToken(''); renderTokenState(); setStreamState('token 失效（未重新登录，请点击右上角重试）') }
  })
}
var NOTIFY_PREF_IDS = { npEnable: 'enable', npActive: 'active', npSound: 'sound', npHidden: 'hiddenOnly' }
function initNotifyTab() {
  writeNotifyPrefs() // 同步 checkbox 与存储（首访写入默认值）
  renderPermState()
  $('#nPermBtn').addEventListener('click', function () {
    if (typeof Notification === 'undefined') { flash('此浏览器不支持系统通知', 'err'); return }
    Notification.requestPermission().then(function () { renderPermState(); beep() }) // 手势顺带解锁 AudioContext
  })
  $('#nTestBtn').addEventListener('click', function () {
    beep()
    fireNotification('dsh-notifier 测试', '如果你看到这条系统通知，桌面通知已就绪（' + new Date().toLocaleTimeString() + '）', 'active')
    flash('已发起测试通知（权限未授权时只在浏览器内可见此提示）', 'ok')
  })
  Object.keys(NOTIFY_PREF_IDS).forEach(function (id) {
    $('#' + id).addEventListener('change', function () {
      var p = readNotifyPrefs()
      p[NOTIFY_PREF_IDS[id]] = $('#' + id).checked
      try { window.localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(p)) } catch (e) {}
    })
  })
  startNotifyStream()
}

// ---------- 初始化 ----------
function init() {
  $all('.tabbtn').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')) })
  })
  $('#btnRefresh').addEventListener('click', function () { loadAll() })
  applyAdminMode()
  var modeToggle = $('#modeToggle')
  if (modeToggle) modeToggle.addEventListener('click', function () {
    setAdminMode(readAdminMode() === 'advanced' ? 'personal' : 'advanced')
  })
  // Issue #10：Dashboard 首屏引导——手动隐藏记 localStorage，下次不弹
  var hideBtn = $('#btnHideOnboard')
  if (hideBtn) hideBtn.addEventListener('click', function () {
    try { window.localStorage.setItem('onboard_dismissed', '1') } catch (e) {}
    $('#onboarding').hidden = true
  })
  function promptAndLoadToken() {
    var t = askToken()
    if (t) { authGen += 1; recoveryUsed = false; stopNotifyStream(); setCandidateToken(t); renderTokenState(); loadAll(); startNotifyStream(t) } // 候选仅在成功响应后写入会话
  }
  $('#tokenState').addEventListener('click', promptAndLoadToken)
  var firstVisitToken = $('#btnFirstVisitToken')
  if (firstVisitToken) firstVisitToken.addEventListener('click', promptAndLoadToken)
  $('#btnLogout').addEventListener('click', function () {
    authGen += 1
    stopNotifyStream()
    setToken('')
    renderTokenState()
    setStreamState('已退出本浏览器会话；点击 token 状态重新输入')
    flash('已退出本浏览器会话', 'ok')
  })
  $('#btnCopyEntry').addEventListener('click', copyEntryPoint)
  renderEntryPoint()
  $('#tab-bindings').addEventListener('change', onBindingsChange)
  $('#tab-bindings').addEventListener('click', onBindingsClick)
  $('#tab-sessions').addEventListener('click', onSessionsClick)
  $('#tab-channels').addEventListener('click', onChannelsClick)
  // v0.7 成员页事件委托（R5 审查 R5-2-P1-1：首版漏挂——铸码/删成员/撤码/转正/忽略/改角色整页死键）
  $('#tab-members').addEventListener('click', onMembersClick)
  $('#tab-members').addEventListener('change', onMembersChange)
  // 路线图阶段 2A：待处理远程提问结算（事件委托，面板空/缺按钮时静默）
  $('#pendingQuestionsPanel').addEventListener('click', onQuestionsClick)
  initNotifyTab()
  renderTokenState()
  loadAll()
}
init()
</script>
</body>
</html>`
