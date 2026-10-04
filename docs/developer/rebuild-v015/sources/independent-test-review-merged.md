# dsh-notifier 测试独立审查汇总（三路审查合并稿）

> 审查对象：`THEWOLFWALKER/dsh-notifier` @ `2542a3107e7d3795e6ba5b294a7a5b82052c3431`（分支 dev）
> 上游契约参考：`xmanrui/dsh-im` @ `ecf6c85b72b213bcc937e379cf125d210d447401`（`plugin-src/host/delivery-service.mjs`、`PROACTIVE_DELIVERY.md`）
> 方式：只读审查，未修改仓库。

本文件由三份相互独立的审查合并而成：

- **第 1 部分**：主审查员报告——仓库全量盘点（主套件 2447 + DOM 41+）、优先级簇深审、dsh-im v1 契约核对。
- **第 2 部分**：外援一报告——Cloud / 公共运行面 / Native 边界（含相关 DOM）。
- **第 3 部分**：外援二报告——旧 Advanced Console / 源码 grep 自证。

**合并原则**：如实汇报，完整保留各审查员的原始结论与证据；不替任何一方补写其未写出的设计推断。三份报告之间的异同与取舍点，在附录中原样并列，交由复核方（Codex）判定。凡某审查员未验证的事项，一律保持 `unknown`，不因其他部分全绿而改写为「通过」。

---

## 第 0 部分：三路覆盖范围速览（仅事实）

| 部分 | 审查员 | 覆盖范围 | 报告自述的主要结论 |
|---|---|---|---|
| 1 | 主审查员 | 全量盘点（主套件 2447 + `test/dom` 41+）；深审簇 A/B/C/D/D2/I/J/K/L/N/O | 主要测试幻觉：dsh-im 桥 mock 伪造 `accountFingerprint`、群目标出站放行、旧卡缺来源放行、空/条件断言 |
| 2 | 外援一 | Cloud、public API、Native 边界、与 Native 截断/空态相关的 DOM | 测试体系不能作为「已达候选发布质量」的充分证据；三项最高风险：Cloud YAML-only token、FakeNotifier 与真实 API 冲突、Native fail-closed/截断/空态证据链不足 |
| 3 | 外援二 | 旧 Advanced Console 全套（admin-* 共 206 点）、源码 grep/结构自证（104 点） | 旧 Advanced Console 未整套退出（HTTP 路由已退、UI markup 已退，但功能层/生产装配/浏览器客户端仍在）；private-only 尚未成为 provider 一致边界；部分 grep 测试锁实现形状 |

---

## 第 1 部分：主审查员报告（全文）

# dsh-notifier 单元测试独立审查报告

> 交付对象：转交 Codex 复核。仅审查，未修改仓库。
> 仓库：`THEWOLFWALKER/dsh-notifier` @ `2542a3107e7d3795e6ba5b294a7a5b82052c3431`（分支 dev）。
> 上游契约参考：`xmanrui/dsh-im` @ `ecf6c85b72b213bcc937e379cf125d210d447401`（`plugin-src/host/delivery-service.mjs`、`PROACTIVE_DELIVERY.md`）。
> 审查方式：直接克隆源码逐文件阅读；断言依据对照「用户需求 / 正式公开契约 / 固定上游源码 / 旧文档 / 当前实现」五类判定，不从当前实现反推需求。

## 0. 方法与口径

- 产品约束（判定基准）：① 只支持私聊；② Native 是日常入口；③ 旧 Advanced Console 整套退出；④ 不为旧版本保持兼容；⑤ dsh-im 是竞品与上游契约参考，不是要复制的产品；⑥ 测试通过不能替代真实 Host / provider / 设备证据。
- 「正式公开契约」= `docs/developer/*.md`、`PROACTIVE_DELIVERY.md`、`types/index.d.ts`、`PLUGINS.md`；「固定上游源码」= dsh-im@ecf6c85 的 `delivery-service.mjs` 及其测试；「旧文档」= 与 v0.15 目标态冲突的历史行为契约（如旧群功能、旧控制台）；「当前实现」= `src/` 现状（**最低可信来源，不能当需求**）。
- 无法确证者一律标 `unknown`，不写「通过」。

## 1. 测试盘点

- 主套件（`node scripts/run-tests.mjs` / `npm test`）：**2447** 个测试点，来自 `test/**/*.{test,spec}.mjs`。
- `test/dom/`（真实 React/jsdom 套件）：7 个文件、41+ 个顶层 `test()`，由 `npm run test:dom` 单独运行。
  - **重要口径**：`scripts/run-tests.mjs:16` 的 `discoverTests` **显式跳过** `test/dom`，故 2447 不包含任何 DOM 用例；`package.json` 的 `dshQuality.testCount=2447` 与 `scripts/verify-release.mjs` 的发布计数门禁同样只取自 `--count`。S2–S5 宣称「用真实 React DOM 套件取代旧 daily-UI 测试」的这部分**不在 `npm test` 与发布计数内**，仅 CI 独立步骤（`.github/workflows/ci.yml`）执行。
- 审查覆盖：主套件按优先级簇深审（见下）；`test/dom` 作为「关闭私聊 / Native 截断与空态」的补充证据抽查。

## 2. 已审清单与发现（按簇）

### 簇 A：dsh-im v1 契约桥（最高风险）

审查文件：`test/v015-stage-s14-dsh-im-bridge.test.mjs`（全 13 个用例）、`src/control-plane/dsh-im-bridge.mjs`、上游 `dsh-im/plugin-src/host/delivery-service.mjs`、`dsh-im/PROACTIVE_DELIVERY.md`、`dsh-im/test/delivery-service.test.mjs`。

**A-1｜mock 伪造字段 `accountFingerprint`，与上游契约 `account.fingerprint` 不符（最高风险测试幻觉）**
- 文件/行/测试名：`test/v015-stage-s14-dsh-im-bridge.test.mjs:11-23`（`makeService` 的 `describeBot` 返回 `accountFingerprint: FP`），被 `:34 'discovery requires describeBot and projects only safe v1 fields'`、`:42`、`:81`、`:109` 复用。
- 实际断言：`dsh-im-bridge.mjs:101` 读取 `str(description.accountFingerprint ?? description.fingerprint)`；mock 在 `:16` 正好返回 `accountFingerprint`，于是 `:38` `assert.deepEqual(bots,[{...,accountFingerprint:FP,connected:true,checked:true}])` 通过。
- 上游固定契约：`PROACTIVE_DELIVERY.md:362` 明确 `describeBot` 返回 `{version:1,botId,channel,account:{fingerprint,name?},connected,capabilities}`；`delivery-service.mjs:311-313` 直接返回 `adapter.describeAccount(id)`；`delivery-service.mjs:340-343` 用 `account.account?.fingerprint !== expectedFingerprint` 判定；上游自测 `dsh-im/test/delivery-service.test.mjs:303-304,367` 构造的也是 `account:{fingerprint}`。
- 预期来源：**当前实现**（bridge 的字段假设）。**不是**上游契约。
- 固化缺陷：把「不再存在于真实 dsh-im 的 `accountFingerprint` 顶层字段」当契约。对真实 Host：`accountFingerprint` 恒为 `undefined` → `isFingerprint` 为 false → `checked:false` → `checkedBot`（bridge:123）抛 `not-supported` → 所有 checked 发送被判 `capability-unavailable`。即**整条 dsh-im checked 投递在真实 Host 上不可用**，而测试全绿。故障方向是 fail-closed（不会误发），但功能静默失效。
- 建议：**改写 mock 为上游真实形状** `{version:1,botId,channel,connected,capabilities:['proactive-text-checked'],account:{fingerprint:FP}}`；bridge 改用 `description.account?.fingerprint`，并校验 `description.version === 1`。新增「真实形状契约夹具」测试，禁止再出现顶层 `accountFingerprint`。

**A-2｜`kind:'private'` 是虚构类型；桥无「目标必须是私聊」证明**
- 文件/行/测试名：`test/v015-stage-s14...:10` 的 `target()` 返回 `kind:'private'`；`:53 'target discovery returns opaque digest...'`、`:63`、`:88` 等均基于它。
- 上游固定契约：`delivery-adapter.mjs:75-105` 的合法 kind 为按渠道枚举（feishu `user|group`、telegram `chat|topic`、qq `user|group` 等），**不存在 `private`**。
- 实际断言：`dsh-im-bridge.mjs:149-155` 对任意 kind 一律投影并可发送；没有任何私聊准入校验。
- 预期来源：**当前实现**（模拟私聊）。其它来源：审计台账 S082「target 私聊证明」为 planned（未实现）。
- 固化缺陷：① 虚构 kind 掩盖了真实渠道里群目标（feishu `group` / qq `group`）也会出现在 `listTargets` 并被 `send` 放行，违反「只支持私聊」；② 测试无法覆盖「群目标应被拒绝」。
- 建议：**改写** fixture 为真实 kind；在 bridge 增加私聊准入（如仅接受 feishu `user`、telegram `chat`、qq `user` 等私聊语义），新增「group/topic 目标被拒绝」的行为测试。

**A-3｜digest 计算口径与上游不完全一致，mock 无法暴露**
- 文件/行：`dsh-im-bridge.mjs:19-28`（`stableValue` **递归**排序所有层级的键）vs `delivery-service.mjs:336-337`（**仅顶层** route 键排序；且 `sendChecked` 先在 `:333-335` 对 saved target 做 `normalizeDeliveryTarget` 再冻结 route 计算 digest）。
- 实际断言：`test/v015-stage-s14...:57` 以内联 `JSON.stringify({kind:'private',route:{chatId:'private-1'}})` 复算 digest；`:60` 断言键序无关。
- 预期来源：**当前实现**（对扁平 route 恰好与上游等价）。
- 固化缺陷：对真实 route（telegram `chat`/`topic` 为扁平键）暂等价，但（a）递归排序在多级 route 上与上游不一致；（b）bridge 用 `listTargets` 的**原始** route 计算 digest，而上游 `sendChecked` 用**规范化后** route 计算，若 adapter 存储的 route 与 `normalizeRoute` 结果有差异，真实发送会被上游判 `target-changed`（映射为 bridge `rejected`），mock 永远看不到。
- 建议：**改写** digest 计算与上游对齐（仅 route 顶层排序、基于规范化 route）；新增「route 含未规范化键/嵌套对象时 digest 与上游一致」的跨实现夹具测试。

**A-4｜源码 grep 自证（删除护栏）**
- 文件/行/测试名：`test/v015-stage-s14...:173 'guessed importer module and test are deleted, with no production importer wiring'`。
- 实际断言：`existsSync(src/control-plane/dsh-im-import.mjs)===false`（`:174`）、`existsSync(./v015-stage-s15-dsh-im-import.test.mjs)===false`（`:175`）、`doesNotMatch(indexSrc,/dsh-im-import|dshImImport/)`（`:177`）。
- 预期来源：旧文档/删除决策护栏。
- 固化缺陷：`:175` 断言一个被删测试文件不存在（引用不存在的路径，信息量近零）；`:177` 依赖 `src/index.mjs` 文本。
- 建议：**保留** `:174` 与 `:177` 作为「不得复活」护栏；**删除** `:175`。

### 簇 B：群聊正向测试（与「只支持私聊」冲突）

判定基准：`docs/developer/v0.15-execution/02-scope-inventory.md` WP07「群事件/未知类型/群目标/Topic 均无业务触发、出站拒绝、迁移停用」；用户产品约束「只支持私聊」。

**B-1｜Telegram 群命令正向（在 stub bus 层放行 supergroup）**
- 文件/行/测试名：`test/inbound.telegram.test.mjs:579 'G-06 群聊命令 @ 后缀：入站 envelope 构造处剥离（/cmd@BotName args → /cmd args）'`。
- 实际断言：`:605` `assert.equal(accepted.length, 4)`；`:608` `assert.equal(accepted[0].chatType, 'supergroup')`。fixture 含 3 条 `type:'supergroup'` 消息（`:584,586,590`）。`bus` 是 `makeBus({accept: env => accepted.push(env)})`（`:581`）——**纯 stub，绕过 `privateControlAdmission`**。
- 预期来源：**当前实现**（adapter 层转发群 envelope 给 bus）。
- 固化缺陷：把「Telegram adapter 仍会把 supergroup 消息规范化后交给 bus（并携带 chatType:'supergroup'）」当契约；真实准入拒绝发生在 `src/inbound/bus.mjs` 的 `privateControlAdmission`，而该测试用 stub bus 永远看不到拒绝，因此**这群聊正向用例不能证明「群被拒绝」**，反而锁死了群 envelope 的转发路径与 `chatType` 传播。若日后准入被上移/重构，群泄漏不会被这套测试挡住。
- 建议：**改写**——@ 后缀剥离本身与私聊无关，用 `type:'private'` 的 `/cmd@BotName` fixture 测剥离；群 supergroup 用例改用真实 `createInboundBus` 断言 `bus.accept` 返回拒绝且消费者 `accepted` 为空。

**B-2｜飞书群消息正向（stub bus 放行 oc_group）**
- 文件/行/测试名：`test/inbound.feishu.test.mjs:258 'im.message.receive_v1：文本入站 → bus.accept 规范化 envelope（@提及剥离）'`。
- 实际断言：`:273` `assert.equal(accepted.length, 1)`；`:276` `assert.equal(accepted[0].chatId, 'oc_group')`。fixture `chat_id:'oc_group'`（`:268`），stub bus `rig.bus.onMessage`（`:261`）。
- 预期来源：**当前实现**。
- 固化缺陷：同 B-1——把 `oc_group` 群消息被适配为 envelope 并推给消费者写成正向契约；不证明产品层拒绝。`oc_` 前缀是飞书群/会话 id，私聊目标是 `ou_`。
- 建议：**改写**为「oc_group 事件用真实 bus → 拒绝，消费者为空」；剥离 @ 的用例用 `ou_` 私聊 id。

**B-3｜飞书群聊出站文本仍放行（降级为纯文本仍发群）**
- 文件/行/测试名：`test/inbound.feishu.test.mjs:1153 'Stage-6 群聊敏感控制降级：审批不发群消息，动作通知仍可纯文本'`；`test/inbound.feishu.test.mjs:1173 'Stage-6 群聊敏感编号兜底：提问文本在群聊被抑制，普通文本仍可发送'`。
- 实际断言：`:1165` `assert.equal(rig.fake.state.sent[0].msgType, 'text', '普通动作通知仍可降级为文本')`；`:1179` `assert.equal(await rig.inbound.sendText('oc_group-q', '任务仍在运行'), true, '普通状态文本仍可发群聊')`；`:1180` `assert.equal(rig.fake.state.sent.length, 1)`。
- 预期来源：**旧文档/旧行为**（v0.13 Stage-6 的群降级策略）。审计台账 F044「删除向群发送敏感内容的 fallback」/ F045 决策为「结构化拒绝群」。
- 固化缺陷：把「群目标仍可发送普通文本 / 动作通知降级为群文本」固化为契约，与「只支持私聊 / 群功能退出 / 出站拒绝」直接冲突；该行为恰好是 F044/F045 判定要删除的群 fallback。
- 建议：**删除**这两条群正向断言（审批卡降级、提问卡拦截的负向断言可保留）；替代行为测试：`sendText('oc_*', ...)` 与 `sendActionCard('oc_*', ...)` 一律返回拒绝/`downgraded` 且不产生任何 `sent` 记录。

**B-4｜合规的群负向测试（保留）**
- `test/inbound.qq.test.mjs:772 / :787 / :800`：`assert.deepEqual(accepted, [], '群事件不能进入业务消费者')`——QQ 群 @ 消息被拒，**合规**。
- `test/inbound.dingtalk.test.mjs:318 'private-only: DingTalk group mentions, commands and pairing never reach consumers'`：`:332` `assert.deepEqual(accepted, [], ...)`——**合规**。
- `test/session-arbiter.test.mjs:9 / :24 / :35`：`group_chat_disabled`——**合规**。
- 建议：保留，并作为 B-1/B-2 改写的参照模板。

### 簇 C：Telegram 通知凭证触发入站 / legacy 缺来源放行

**C-1｜legacy 老卡缺来源仍放行（与「不为旧版本保持兼容」冲突）**
- 文件/行/测试名：`test/actions.test.mjs:289 'F-08 dispatch：legacy 老卡（无来源元数据）→ 显式 warn + 兼容放行'`；同簇 `:267`、`:322`、`:334`。
- 实际断言：`:298` `assert.equal(result.ok, true, '老卡缺来源元数据：兼容放行')`；`:299` `assert.equal(calls.length, 1)`；`:300` 要求 warn 含 `srcChats`。dispatch 来自 `via:'telegram:action', userId:42, chatId:'999'`（`:297`，**任意会话**）。
- 预期来源：**旧文档**（`behavior-contract.md` MIG-02「旧卡缺来源显式 warn 后按官方能力兼容」）+ **当前实现**（`actions.test.mjs:322` 的 10 分钟宽限窗）。与用户产品约束 ④「不为旧版本保持兼容」冲突。
- 固化缺陷：把「无来源元数据的旧卡可在（宽限窗内）从任意 chat/user 执行 handler」写成兼容契约。虽然 CRACK-001 另有窗外拒绝（`:334`）兜底，但 `:289` 本身不绑定时间窗，无法防止「无来源→永久放行」的回归；且产品已要求不为旧版本保持兼容，这条兼容路径本身应退场。
- 建议：**改写/删除**——在无兼容前提下，缺来源元数据的卡应 fail-closed 拒绝（如需迁移，转为一次性迁移告警而非放行）。若保留宽限窗，`:289` 必须显式绑定窗内/窗外两侧断言，不能只测「缺来源→true」。

**C-2｜「Telegram 通知凭证触发入站」**
- 相关实现：`src/cloudflare/telegram-transport.mjs:3-14` 要求 `gatewayKey` 存在时必须等于 `botToken`；`src/cloudflare/deployment.mjs` 的 `link()` 同事务把同一 token 写入出站 `channel:telegram:outbound` 与入站 `telegram:account`（审计 F167/F170/F171）。
- 测试现状：`test/cloudflare-release.test.mjs:159 'CF one-click deploy reads the address and atomically fills both directions using the bot token'` 断言 `:171` `assert.equal(outbound.gatewayKey, BOT); assert.equal(inbound.gatewayKey, BOT)`（`BOT='123456:fixture_token_abcdef'`）。
- 预期来源：**当前实现**（F167 暂接受同 token，但 F170/F171 决策要求「新 bind 不改 token/chatId」「两方向同事务绑定/解绑」「减少传播面」）。
- 固化缺陷：把「通知出站凭证 botToken 与入站凭证 gatewayKey 明文相等、并同时落到两行 store」断言为正常；未区分「同 token 的等价边界」与「凭证传播面」——即通知凭证自动成为入站控制凭证，测试不设任何「凭证传播最小化 / 解绑撤回」断言。
- 建议：保留「两方向同事务绑定、apiBase/endpoint 一致」；**改写**明文相等断言为「入站既不新增 token 副本、unbind 撤回凭据、status/export 不含明文」；新增「YAML-only/env 引用 token 时部署行为」的行为测试（见簇 E）。

### 簇 D：ledger terminate / markUncertain（已核，合规）

- `test/interaction.ledger.test.mjs:78 '账本：terminate 仅待决可翻，已决/缺失返回 false（C2/P1-5 僵尸守卫）'`：`:83` pending→true（decision='terminated'）；`:87` `terminate('ap:k')===false` 已决不可二次终止；`:88` 失败不改写。**合规**。
- `test/v015-stage-s20-equivalence-rollback.test.mjs:166 'L02c: a claimed row is not replayed after a restart/rollback'`：`:177` `claim → {ok:false, reason:'uncertain'}`、`:178` `resolve → 'already-claimed'`。**合规**。
- `test/v015-stage-s20...:181 'L02c: an uncertain row is not replayed...'`：`:185` markUncertain 落盘 true；`:190` `isPending(row)===false`；`:191` claim→`already-resolved`；`:192` resolve→`already-resolved`；`:193` terminate→false。**合规**（对齐 INT-03）。
- 结论：ledger 状态机测试未发现缺陷固化。

### 簇 D2：跨账号 owner（C-DSH-E08 / E09）

- **实况（源码，非测试）**：`src/approval/router.mjs:532-535` 与 `src/questions/router.mjs:948-950` 的 owner 代决/代答回退函数 `isAuthorizedDecider/DeciderQ` 仅匹配 `identity.list(channel).some(r => r.userId===userId && r.role==='owner')`，**不比较 accountId**。审计 C-DSH-E08/E09（P1，planned「完整 Principal」）即指此。对照 `session-arbiter` 的 `canSettleApproval` 已做精确三元组匹配。
- **测试现状**：`approval.test.mjs:392`、`approval.multi.test.mjs:395` 的 owner 代决回退用例，owner 事件与身份同 channel、且**未涉及不同 accountId**；`questions.test.mjs:1504/1537/1561/1577` 覆盖的是 pushedTo/exact 路径（accountId 精确，**合规**），**没有**任何用例断言「同 channel 同 userId、不同 accountId 的 owner 不能经回退代决/代答」。
- **判定**：该缺陷**未被测试固化（无 green 断言跨账号成功）**，但也**完全无测试守护**；`test/wiring.route.test.mjs:286-314` 明确承认「行为侧要跑通 owner 代决需要真卡片往返（真机门）」，改以「源码装配点 + identity 已传入」自证。
- **关键区分（避免误判已覆盖）**：`test/feishu-p2p-source.test.mjs:328 '#10 accountId 不匹配：同渠道同人同 chat，仅账号不同 → 归属拒绝不裁决'` 确实断言了跨账号拒绝，但它走的是 `bus.accept → questionBridge` 的 **exact/P2P 等价路径**（accountId 精确），**不是** `approval/router.mjs:532-535` / `questions/router.mjs:948-950` 的 **owner 代决回退**（该回退只看 `channel+userId`、不比较 accountId）。因此 #10 是**新测试的现成模板**，但不能替代对回退路径的守护。
- **双层结构（务必区分，防止误判严重度）**：
  - **Control Core / session-arbiter 层**已有强隔离：`test/control-entry.integration.test.mjs:218/234/259/552/598` 用 `source_mismatch_accountId` 断言「错账号 owner 回调永不结算」「overlay 不能跨 channel/account/chat/user」「无任何来源元数据时 fail-closed」，`session-arbiter.test.mjs:93 'exact triple'` 亦为精确三元组。**该层合规。**
  - **router 自建的 `authorize` 回退**（`src/approval/router.mjs:266-270`：`input.trusted===true` 时 `return exact || isAuthorizedDecider(identity, event.channel, event.userId)`）以及 `handleNumberedReply`（`router.mjs:496`）**仍只比 channel+userId**。该 `authorize` 会被喂给 Control Core，故**跨账号 owner 代决是否可经此路径达成，取决于 `trusted` 判定与调用装配**——本轮未能确证其真实可达性，标 `unknown`（正因无测试覆盖才无法证伪）。
- 建议：新增真实行为测试——构造 owner 身份绑定账号 A，投放带账号 B 的回退（onChannel/intended/hint）编号回复，断言拒绝。该测试同时可**判定上述回退路径是否可达**（红即暴露 E08/E09，绿则说明 Control Core 层已兜住、可据此下调严重度）。（可直接复用 `feishu-p2p-source.test.mjs` 的 rig 与 #10 的断言形状。）

### 簇 I：发布门槛 / Stage 验收（本审查员自审，未委派外援）

审查文件：`test/v015-stage-s21-rc-guardrails.test.mjs`（全 18 用例）、`test/v015-stage2-acceptance.test.mjs`（全 15 用例）、`test/v015-stage4-postrc-hardening.test.mjs`（全 5 用例）。

**I-1｜Stage-2 验收套件混入源码 grep 自证（A01「单写者」靠读源码文本，而非行为）**
- 文件/行/测试名：`test/v015-stage2-acceptance.test.mjs:43 'A01: the conversation-bindings fact has exactly one writer authority'`。
- 实际断言：`:46-49` 读 `src/inbound/conversation.mjs` 文本 `assert.doesNotMatch(... /\b(?:setDurable|deleteDurable|mergeDurable|transactDurable|transactOutcome)\s*\(/)` 与 `/\bstore\.(?:set|delete|transact|sweepPrefix)\s*\(/`；`:53-54` 读 `src/routing/current-task.mjs` 文本 `assert.match(... /\bsetDurable\s*\(/)`、`/\bdeleteDurable\s*\(/`；`:57-59` 才是行为（`currentTaskKey` 归一化）。
- 预期来源：**当前实现**（源码文本形状），不是需求也不是公开契约。
- 固化缺陷：把「单写者不变量」写成「这两个文件里有没有出现某些函数名」。合法重构（改名 helper、搬到别的模块、加一层包装）会在不变量仍成立时误报；反之，任何间接写路径（经导出 helper、动态属性）能在不变量被破坏时仍通过。它并不验证运行时「只有 current-task 改 `bind:` 键」。真正的行为证据是紧随其后的 `:62 'A01: the current-task authority round-trips through the durable store'`。
- 建议：**删除/降级**文本断言，保留 `:57-59` 与 `:62` 的行为校验；新增行为测试——对真实 store 做写前后快照，驱动 conversation 模块处理入站回复，断言 `bind:*` 键只由 `currentTaskAuthority.select/clear` 变更。

**I-2｜A03 源码 grep 信息量近零（`/accountId/` 只证明词出现过）**
- 文件/行/测试名：`test/v015-stage2-acceptance.test.mjs:100 'A03: the chat principal is derived from the envelope, never self-reported'`。
- 实际断言：`:102-103` `assert.match(wxpusher, /accountId/)`（只要文件里出现过 `accountId` 一词即通过，不证明来源）；`:107-108` `assert.doesNotMatch(actions, /payload\.(?:role|admin|actor)\b/)`（负向 grep，属性访问变体如 `payload['role']` 可绕过）。
- 预期来源：**当前实现**（源码文本）。
- 固化缺陷：`/accountId/` 提供虚假安全感——它对着「本地 config 的 accountId 获胜」这一真实主张毫无证明力；负向 grep 也挡不住等价写法。
- 建议：**改写**为行为测试——向 wxpusher 回调喂入伪造 payload（含攻击者 `appId`/`role`/`admin`），断言派生 peer 使用本地 accountId、且不因 payload 字段获得特权。native 侧的 fail-closed（未解析的不透明 id 抛错）已由 `native-boundary-contracts.test.mjs:455` 覆盖，可复用。

**I-3｜同套件的合规部分（保留，作为改写模板）**
- `v015-stage2-acceptance.test.mjs`：`I01:113`（claim 跨重启不重放）、`R01:131`（旧 runtime 世代不得更新 health）、`R02:144`（retire 关闭准入）、`D01:162`（accepted≠confirmed）、`D02:175/188`（timeout=unknown 不盲重试、rate-limit 按窗口等待）、`D03:201`（分段部分成功不得整条重放）、`A02:79/88`（无显式选择即无当前任务）——均为真行为，**保留**。
- `v015-stage-s21-rc-guardrails.test.mjs`：全部 18 用例直接驱动生产模块（store owner-aware 锁、host disposer 形状、stateful sender 不复活、tunnel 信任/生命周期、notifyAll 同 unknown 语义），确定性 fake，**无缺陷固化；保留**。
- `v015-stage4-postrc-hardening.test.mjs`：`S401:56/64`（声明方法面 = handler table，一一可调用）、`:87`（daily allowlist 不含 REMOVED_LEGACY_PREFIXES）——声明/实现一致性与合规断言，**保留**。轻量提示：`:64` 只断言「非 bad-request」，理论上返回 `not-found` 也能过；可加「已声明方法在合法入参下 `ok:true`」以收紧。

**I-4｜Gate 2 RMW 并发回归（高质量行为测试，保留）**
- `test/v015-stage-s23-gate2-rmw.test.mjs`：核心手法是用 `makeStaleReadStore`（`get()` 返回发布过的旧快照，`transact()` 读提交瞬间真值）制造真实并发交错，验证 `Gate2D identity:117`、`routing:133`、`pairing:147` 的「事务内 fresh read 不吞兄弟键」；`Gate2C:59/80/95`（epoch 捕获于发送开始）、`Gate2E:167/184`（JSON 不可序列化时安全投影、绝不 freeze live 对象、投影与真值无引用共享）均为真行为且直击此前缺陷。**保留**。
- 轻量观察（非缺陷固化，但需对约束④复核）：`Gate2C:59` 明确断言「未携带 epoch 的 legacy record 仍兼容，计入健康」。若产品坚持「不为旧版本保持兼容」，这条兼容兜底需确认是「同进程内合法缺省」还是「历史格式兼容」；前者保留，后者应退场。存疑，标 `unknown` 待产品确认。

**I-5｜P0 修正与 P3 生命周期（行为测试，保留；含少量 legacy 迁移路径需复核）**
- `test/v015-p0-corrective.test.mjs`：`F01:22/47`（同用户跨账号选择/清除独立，重启与 router 一致）、`F02/F11:60`（一次替换=一代；状态观察不推世代；陈旧结果排除）、`F07:77`（计数 reporter 与 TAP 对嵌套叶子用例计数一致）。**保留**。注意 `F01:34 'legacy migration ... ambiguous/no account stays unselected'` 是**保守的一次性数据迁移**（歧义则不动，安全方向），与约束④「不为旧版本保持兼容」需区分：这是迁移既有用户数据，不是保留旧行为契约；但应确认其有明确退场时间点，否则会成为永久兼容路径。标记 `unknown`。
- `test/v015-p3-lifecycle.test.mjs`：`P3:11`（磁盘 rename 争用重试，耗尽时内存与重启真值不变）、`P3:29`（1000 次替换恰好 retire 一次，旧完成不复活已停实例）、`P3:55`（容量溢出拒绝且无部分变更）、`P3:65`（1000 次通知 + 500 私聊事件无悬挂 waiter）。`:65` 用例用**真实 `node:http` server（127.0.0.1）** 而非 mock fetch，证据强度优于多数套件。**保留**。

**I-6｜S11 writer fitness：合法架构护栏，但保证是纯文本的、可被等价写法绕过（勿当运行时证明）**
- 文件/行/测试名：`test/v015-stage-s11-writer-fitness.test.mjs:93 'T17: the generic store.set/store.delete surface stays confined to the store primitive'`、`:101 'every durable-store writer is registered in the registry allowlist'`、`:112 'no stale entries'`、`:122 'layer dependencies point one way'`、`:145 'index.mjs is reached only through the plugin entry'`。
- 实际断言：以正则遍历 `src/**/*.mjs` 文本——`WRITE_SURFACE = /(?:...setDurable|mergeDurable|transactDurable|deleteDurable|transactOutcome)\s*\(|\bstore\.(?:transact|set|delete|sweepPrefix)\s*\(/`（`:45`）判定「写者」，与 `docs/developer/state-writer-registry.md` 内嵌 allowlist（`:61-77`）做集合比对；`:80-91` 用正则抓 `from '...'`/`import('...')` 判层级方向。
- 预期来源：**当前实现 + 架构文档**（fitness function，文件头自认「not a behaviour test」）。
- 固化/绕过风险：① 写者检测是**文本启发式**——改名/别名（`writeDurable()`、`store['set']`、包装函数）会使真实写者不被 `detectedWriters` 命中，从而**逃过 allowlist 与 stale 检查**而测试仍绿；② 层级方向靠抓静态 import，动态计算 specifier、`require`、re-export 变体可绕过；③ 因此「green」只证明当前文本形状符合文档，不证明运行时单写者不变量（真正的运行时证据由 `v015-stage2-acceptance.test.mjs:62` 的 round-trip 与 `v015-stage-s23-gate2-rmw.test.mjs` 的并发 oracle 提供）。
- 建议：**保留**作为漂移护栏（本身有价值），但在文档/发布口径中明确它**不是**单写者的充分证据；新增运行时行为测试——用真实 store 快照 diff 断言除 `current-task` 外无模块改 `bind:*` 键（与 I-1 建议合并），并考虑把文本检测升级为对「导出的 durable 写 helper」的运行时包装计数。

**I-7｜S12 Recovery 诊断（行为测试，保留）＋ `advancedConsole` 能力名存续需产品裁决**
- `test/v015-stage-s12-recovery-diagnostics.test.mjs`：`T20:53`（用**双向抛错的 hostileStore** 证明诊断绝不借道 store；`reads===1` 证明无第二套采集；`snap===canonical` 证明与 Native 同实例）、`:78`（零 secret）、`:88`（未装配 501 fail-closed）、`:97`（读取抛错 503 不谎报健康）、`:110/140`（**真实 HTTP server** 透传同一快照 + Bearer 鉴权）。**高质量行为测试，保留**。
- 交叉发现（需产品裁决，标 `unknown`）：canonical 快照仍携带 `capabilities.advancedConsole`（`src/control-surface/diagnostics.mjs:136-157`、装配 `src/index.mjs:890` 按 `adminListenInfo?.port` 报 `available/unavailable`、UI `src/admin/ui/client.mjs:440` 渲染「高级控制台」），且 `test/diagnostics-v014.test.mjs:72/77/113`、`v014-stage-f-observability.test.mjs:170/207` **把该字段名与取值断言为契约**。约束③要求「旧 Advanced Console 整套退出」、台账 F205/F245 决策为「移除日常双栈、Recovery 定位一致」。若产品决定 `advancedConsole` 仅是 Recovery 台的历史命名残留、应随旧控制台退场，则这些断言属于把遗留命名固化为公开契约，需一并改写；若 Recovery 台仍以此名对外，则保留。当前无任何测试裁决该字段该不该存在。

**I-8｜S13 可移植性 / S22 交互元数据 / S19 文档一致性（均为高质量或合法护栏，保留）**
- `test/v015-stage-s13-config-portability.test.mjs`：真实 store + canonical authorities。`E01:87`（导出零 secret / 去 URL userinfo 与 token 形查询参数 / 无掩码串）、`E01:107`（env 引用不内联，报为 externalReference）、`E03:165`（原型污染键拒绝且零写、不污染 `Object.prototype`）、`E03:175`（超限 200 / 非 JSON 拒绝）、`E04:186/199/211`（取消零变更、重复导入幂等、冲突需显式选择）、`E05:237/251`（staging 失败不激活、不删共享凭证）、`Gate2B:268/284/316/334`（空选择零变更、并发改动判 stale-preview 零写、迟到 channel 判 stale、混合提交单事务）。**无缺陷固化，保留**。
- `test/v015-stage-s22-interaction-metadata.test.mjs`：`Gate2A:31/47/61/74/84`（白名单 `srcChats/pushedTo/hintTargets/deliveryEvidence`、patcher 只见冻结 metadata 视图、非白名单键丢弃、null 删键）、`Gate2A:96/115`（并发 oracle：B 先结算后 A 提交元数据不回滚终态）、`Gate2A:129/144/154`（not-found / not-pending / storage-failed / patcher 抛错被收容）。**保留**。
- `test/v015-stage-s19-lifecycle-docs.test.mjs`：`L01:13`（文档引用的 `scripts/*.mjs` 存在且可 `--check`）、`:19`（文档里的 `npm run X` 均在 package.json）、`:22`（用户指南本地链接可解析）、`:25`（安装/使用/排障/升级/卸载各自可达）、`:29`（实现词汇不出现在用户文档）。属**文档-工具一致性护栏**，非产品行为证据，**保留**但不应计入行为覆盖；`:29` 是禁用词 lint，合法用法也可能误报（轻微脆性，可接受）。

**I-9｜装配抽出模块 + 事务回滚（行为测试，保留；注意 warn 文案正则的脆性）**
- `test/outbound-transaction-rollback-v013.test.mjs`：`R1:76/97`（用 `beforeFail` 钩子精确复现「A 提交失败前 B 已提交 v3，A 的回滚不得抹掉 v3」的 lost-update 交错；断言失败后盘上仍是 v3、运行时 source 不变）、`:117`（成功路径热替换）。**高质量行为测试，保留**。（反方向「遗留 store 需补回滚」由 `durability-contract-v0121.test.mjs` 的 P0-01 守着——后者属未深审范围，见文末。）
- `test/assembly.admin-token.test.mjs`：`:73`（verifyToken 恒时安全：长度差/非串/null/对象一律 false 不抛）、`:31/50`（explicit 覆盖损坏哈希、generated 首启打印且哈希对应、reused 不重发明文）、`:102/116/130`（写盘失败 / 启动读失败 / state corrupt 三种情形**均 fail-closed**，绝不 bootstrap 新 token 覆盖旧事实）。**保留**。
- `test/assembly.outbound.test.mjs`、`test/assembly.inbound-signals.test.mjs`：模块边界纯装配测试——出站 overlay 优先级/双域不过 overlay/store 凭证不混入出站（`:99`）、入站 tg 回退次序与「admin 关闭时 store 凭证零执行」（`inbound-signals:68`）、wxpusher 密径首铸落盘/复用/显式不落盘（`:103`）。行为正确、方向 fail-closed，**保留**。
- 脆性提示（不构成缺陷固化，但会误伤合法改动）：以上装配测试多处 `assert.ok(warns.some((w) => /.../.test(w)))` 锁定**中文 warn 文案**（如 `/沿用 YAML 配置/`、`/跳过（state 凭证不完整）/`、`inbound\.${key} 跳过`）。文案 i18n 化或措辞调整即误报；建议改为断言稳定的结构化 warn 码而非自由文本。
- 交叉依赖：这三份是「从 `apply()` 原样搬出」的模块级测试，其**装配级契约锚**在 `test/admin-wiring.test.mjs`（属委派给外援 B 的旧控制台范围），合并时需一并核对，避免「模块级绿、装配级缺」。`assembly.admin-token.test.mjs:2` 自述该锚由 admin-wiring 的 HTTP 鉴权测试兜底——若该锚缺失，则 admin token 的 apply 级接线无覆盖。

**I-10｜durable 原语 / 落盘失败 / 损坏取证族（行为测试，整体保留；含一处弱断言）**
- `test/durability-contract-v0121.test.mjs`：`P0-01:91/101/114`、`P0-02:129/140`、`P0-03:153/159`、`P0-04:165/176/183`——落盘失败必须抛/返回 `storage-failed`、happy path 不回归、遗留 mock `set()` 返回 undefined 当成功（I9）。**保留**。
  - 关键澄清（消解疑似矛盾）：本文件 `P0-01:114` 断言「落盘失败后内存回滚」，而 `outbound-transaction-rollback-v013.test.mjs:76` 断言「事务提交失败不得回滚」看似冲突，实为**两套 store 语义**：`src/control-surface/outbound-config.mjs:305/313-317` 以 `typeof store?.transact === 'function'` 分派——**有 `transact`** 的 store 走事务路径（失败即未提交，绝不回滚，避免 lost update）；**无 `transact`** 的遗留 store 才补回滚（避免内存/磁盘分裂）。两份测试分别用带/不带 `transact` 的 mock 覆盖两条路径，逻辑自洽，**非缺陷固化**。
  - 契约气味（低风险）：`setDurable` 把「显式 `false`」判失败、「`undefined`/无 return」判成功（`durable-primitives:22-27`）。这是为兼容大量既有 mock 而定的非直觉语义（真实 store 恒返回 boolean），文档需显式标注，否则未来真实 provider 若返回 `undefined` 会被误判成功。
- `test/durable-primitives-v0121.test.mjs`：`A1:22/29/35/50/61`（`setDurable`/`deleteDurable` 对 true/false/undefined/缺失/抛错的归一）、`R1:70/80`（`store.delete` 必须仍返回 boolean，`task-selection.mjs:133` 依赖 `=== true`）。**保留**。
- `test/store-shape-corrupt-v0121.test.mjs`：`P2-06:72/203`（六种形状异常 `[]`/`null`/字符串/数字/布尔/数组含元素——均须取证副本 + 告警 + 写路径 fail-closed、原现场不被覆写）、`R3:96/131/217/227/242`（解析失败与形状异常升级为一等 `corrupt`；修复后写路径恢复；`bootStatus` 三态 ready/corrupt/unavailable 可区分）、`保持:119/149/160`（空文件静默、读失败 fail-open 且不取证、正常文件不误判）。**证据强度高、方向 fail-closed，保留**。
- `test/pending-bounds-v0121.test.mjs`：`P2-01:13` 只断言待确认队列 `<= 512` 条。**弱断言**——若某次回归把队列清空（保留 0 条），`0 <= 512` 仍通过，无法区分「正确上界」与「全部丢弃」。建议收紧为 `=== 512` 并断言保留的是**最新**的入队项（明确淘汰策略）。

**I-11｜有界/上限族（整体高质量；一处把「现状怪癖」钉成契约 + 一处弱断言）**
- `test/surface-bounds-v0121.test.mjs`：`P1-15:55/73`（>1MB body 必须在读取阶段 413，不得全量入内存；happy path 不回归）、`P1-16:94/112`（waiter 达上限立即结算 `capacity` 而非挂到 timeout；dispose 后 waiter 归零）。**保留**。
- `test/ledger-numeric-and-io-v0121.test.mjs`：`P1-22①:58/69/74`（`maxEntries` 为非法串/NaN/对象 → 归一默认 500，消除「每次全量重写」）、`P1-22②:81/86`（`Infinity`/`-Infinity` 必须有界，不得永不 prune）、`保持/回归红线:93/99/106/111`（合法值语义不变）。**保留**，高质量数值归一回归。
- `test/bounded.test.mjs`：核心淘汰/LRU/`onEvict` 隔离/节流 warn 用例稳健，**保留**。**但**以下用例把「当前实现怪癖」显式钉成契约（注释自称「现状语义钉死」）：
  - `:148` 数字字符串 cap（`'3'`）被采纳、`:136` cap 畸形（0/NaN/null/字符串/`{}`）回落 `DEFAULT_MAP_MAX=1024`、`:157` `cap=Infinity` **永不淘汰（无界）**。
  - 问题：`:157` 把「`Infinity` = 关闭保护」固化为契约，而同一仓库的 `ledger-numeric-and-io-v0121.test.mjs:81` 恰恰要求 `Infinity` **必须被归一为有界**（安全姿态相反）。两处对 `Infinity` 的处理**不一致**，且 `bounded.test.mjs` 钉的是危险的一侧（其注释自己都写「调用方不得依赖它做保护」）。
  - 建议：保留 LRU/淘汰顺序/回调隔离等**真实不变量**；删除或改写 `:157`（`Infinity` 应被拒绝或钳到默认上限，与 ledger 一致）、`:148`（字符串 cap 应显式拒绝或至少在文档标注为「非契约」）。将这些「偶然细节固化为需求」是本次审查中**唯一由安全姿势不一致暴露出的可疑固化**。
- `test/attachments-bounds-v0121.test.mjs`：`:34/57`（下载并发不超全局预算、队列满立即拒绝、取槽超时失败关闭）**保留**。弱断言：`:31` 只断言 `large.length * 2MB <= MAX_TOTAL_BYTES`——若 `large.length===0`（全部被丢弃/解析失败）也通过，无法区分「正确按总量截断」与「全丢」。建议断言精确截断条数与保留序。

**I-12｜测试边界自证（v013-invariants）＋ 控制契约（control-contract）**
- `test/v013-invariants.test.mjs`：`skeleton:17`（默认 `npm test` 经 `scripts/run-tests.mjs` 安装 hermetic 网络护栏：`assert.match` package.json/runner/guard **源码文本**，含 `blocked external network` 文案）、`invariant:25`（真实行为：默认模式下 fetch 钉钉被拒）、`skeleton:32`（CI workflow 文本含 `branches/[main,master,dev]`、`concurrency`、`cancel-in-progress`）、`Gate3:40`（CI 文本含 `cd test/dom`、`npm install --ignore-scripts`、`npm test`）。
  - 判定：前/后两组是**测试基础设施的源码 grep 自证**（断言的是配置/护栏**文本**，非产品行为）。方向正确（防止护栏被悄悄摘除），但锁定文案与脚本字符串，合法重排/改写即误报；且它们证明的是「护栏被安装」，不是「护栏有效」——唯一真正的行为证据是 `:25`。
  - 关键缺口（用于「距候选发布」）：`scripts/run-tests.mjs` **显式排除 `test/dom`**，主套件 `2447` 计数**不含** DOM/React 套件（7 文件、41+ 用例，真实 React 渲染）。`:40` 只保证「CI 里有跑 DOM 的命令文本」，并未在本地默认测试中执行它。若 CI 未实际执行或 DOM 依赖安装失败，**真实 React 覆盖会在本地与大部分运行中静默缺失**，而主套件仍全绿。此项计入「未深审范围 + 发布缺口」。
- `test/control-contract.test.mjs`：`:8/17/25/34/43/50/57`（归一化拒绝畸形/未知命令/非法时间戳；凭据/内容零泄漏且事件冻结；来源绑定、过期、重复、first-valid-wins；陈旧 policy 与过期 pending 结算前拒绝；lookup/settle 抛错→`desktop_fallback`；重启后对已决 pending fail-closed；全命令可归一）。**真行为测试，保留**。

**I-13｜host-compat-matrix：manifest↔matrix↔docs 三方自洽，但**不**构成真实 Host 证据（重点标注）**
- 文件/行/测试名：`test/host-compat-matrix.test.mjs:20 'the shipped manifest and matrix verify cleanly'`、`:34`（range 必须精确、禁 `^~><*`）、`:41`（dshWorkshop 列表=verified 行）、`:47`（历史 `0.1.0-rc.6` 标 unverified 且排除）、`:54/66/75/84/93`（五类 drift 必须被抓）、`:100`（matrix 解析缺失/畸形 fail-closed）。
- 实际断言：把 `package.json` 的 peer range、`docs/developer/compatibility-matrix.md` 的机器块、`dshWorkshop.compatibility.dshVersions` 三者做集合一致；`VERIFIED` 在测试内**硬编码**为 `['0.1.7-alpha.1','0.1.7-alpha.2','0.1.7-rc.1','0.1.7-rc.2']`。
- 预期来源：**仓库内配置/文档**（自洽性），非外部证据。
- 关键局限：该测试只证明「三处声明彼此不漂移」，**完全不证明插件在这些 DSH 版本上真能运行**。drift 用例验证的是校验脚本的负路径（好），但 `VERIFIED` 硬编码在测试里意味着它只是把当前 manifest 再断言一遍。结合产品约束⑥「测试通过不能替代真实 Host 证据」——**此文件对「Host 兼容性」提供零行为证据**，真实兼容性必须由真机/真实 DSH 版本运行确认，单元层无法覆盖。
- 建议：**保留**作为防漂移护栏；但在发布口径中明确标注「兼容矩阵为声明一致性，非实测证据」，并把真机矩阵执行列入发布门禁；`VERIFIED` 可改为从单一可信来源（如矩阵 verified 行）读取，避免测试内重复硬编码。
- 标 `unknown`：四个 VERIFIED DSH 版本是否真被人工验证过、验证覆盖哪些能力面——仓库内无从证实。

**I-14｜v014 持久化/并发加固（真实 store 的时序与故障注入，高质量，保留）**
- 文件：`test/v014-persistence-concurrency-hardening.test.mjs`（全 13 用例）。手法：**真实 `createStore` + 真实迁移**（`tempState`/`blockingStore` 用「父级是普通文件」制造真实 I/O 失败），仅持久化 boundary 用 `failingTransactStore` 注入，且注明「mock 不能作为 durability 唯一证据」。
- 关键用例：`S13 migration:81/102/119`（v0.12/v0.13 legacy fixture → canonical 一次性迁移、幂等、canonical 胜出且 legacy 键退役、无关键存活、`state:schema-version=13`）、`read failure:136`/`corrupt:156`（迁移拒绝 `state-untrusted`、共享写 `storage-failed`、`raw` 不回显幽灵配置、live source 不切换）、`lock busy:173`（活 pid + 新鲜 mtime 不可回收 → 拒写）、`write failure:190/200`（真实阻塞路径 + durable boundary 注入，均无 publish）、`two writers:213`（两实例同文件各写不同 canonical 键，重启都存活）、`multi-key tx:230/247`（router 单事务两键都不落盘；mutator 抛错既有键不变）、`late completion:278`（晚到只读测试绝不覆盖更新的 canonical 写入、不回退 revision）、`dispose:321`/`epoch:331`（挂起 wait 结算 disposed；重启携带新 epoch，陈旧 cursor 不得静默匹配）。**保留**。
- 主题汇总（供发布口径）：多个文件（此处 `:81`、`v015-p0-corrective.test.mjs:34`、`channel-config-migration-v013.test.mjs` 等）覆盖 **legacy 数据迁移/旧键退役**。这些是「把既有用户数据迁移到新结构」的**一次性迁移**，方向 fail-closed（歧义/冲突不动或 canonical 胜出），**不等同于**约束④禁止的「为旧版本保留行为契约」。建议在文档明确其退役时间点，避免成为永久兼容层——当前无测试约束其生命周期，标 `unknown`。

**I-15｜v014 投影面（bindings/sessions/members）＋ Stage F 可观测性（高质量；含对约束③的正向证据）**
- `test/bindings-projection-v014.test.mjs`、`test/sessions-projection-v014.test.mjs`、`test/members-projection-v014.test.mjs`：全部用**真实 store + 真实 authority**（agent-router / routingControl / identity）断言「投影只做形态映射、写入落权威表、非法 → `bad-request` 零写入、真实落盘失败 → `storage-failed`、服务缺失 → `not-supported` fail-closed」，并断言**脱敏形状**（members 行精确键集 `:37`、pending `:99`、配对码列表绝不含 code/hash `:135-136`）、末位 owner 守卫 → `conflict`（`:47`）、大表替换不丢行（`bindings:82`）。**保留**。
- **对约束③的正向证据**：三份各有 `S402:106/74/155`——即便装配了投影，daily RPC 面（`bindings.*`/`sessions.*`/`members.*`/`pairing.*`）一律 `not-supported`，且「拒绝路径零副作用、不推进 revision、不记 activity、不落盘」。这是「旧能力已从日常入口退出」的**行为级证据**（与约束③一致），与 admin-api 的「函数层仍在测」形成对照。
- **澄清（避免误判为僵尸能力）**：一度怀疑 `createBindingsProjection/createSessionsProjection/createMembersProjection` 无人使用；经 [index.mjs:850-859](file:///workspace/notifier/src/index.mjs#L850-L859) 与 :884-921 确认，它们被喂给 **诊断快照**（`sessions/bindings/members` 选项）与 **native read model**，属真实消费者，**非僵尸**。其函数层 `canEdit/canList/put/patch/update` 测试是有效覆盖。
- `test/v014-stage-f-observability.test.mjs`：`F1:63`（出站保存单 owner：一次动作只推进一代 revision、只记一条 activity；含 unchanged 早退分支）、`F2:101`（入站无 domain event，由 native action 唯一记账一次）、`F3:131`（support report 快照绝不含 JWT/HEX 原文，渠道 `fields/config` 原始配置对象绝不进快照）、`F4:183`（`diagnostics.snapshot` RPC 再次脱敏）。**强行为证据，保留**。
  - 交叉确认 I-7：`F3:170` 与 index.mjs:890 均显示诊断快照携带 `advancedConsole` 状态（`adminListenInfo?.port ? 'available':'unavailable'`）。此点与约束③、台账 F205/F245 的冲突**再次被证实**，需产品裁决，标 `unknown`。

**I-16｜Stage C runtime truth 分层 ＋ Stage D 宿主提问生命周期（强行为测试，保留）**
- `test/v014-stage-c-runtime-truth.test.mjs`：`C1:68`（valid save + hot apply → saved/applied/hot，无 restartPending）、`C2:86`（desired 落盘成功但运行时 apply 抛错 → `saved:true/applied:false/applyMode:'restart-pending'/runtimeState:'failed'`，**不谎报存储失败、不回滚 desired**）、`C3:106`（显式清 key → desired `valid:false`、旧 runtime 仍 active、`diverged:true`）、`C4:128`（remove desired 成功 + runtime remove 失败 → `deleted:true/applied:false`，不回滚 desired）、`C5:145`（重启后从 desired 重新收敛、restartPending 归零）、`C6:165`（divergence 统一投影到 Native 行 + Diagnostics：`attention.reasons` 含 `restart-pending`、`channels.diverged=['bark']`）、`C7:203`（`healthState` 只在 configured 且 active 时才表达 `restart-pending`，否则 degraded/unconfigured）。**保留**，分层语义（configured/active/applied/restartPending/diverged）覆盖完整。
- `test/v014-stage-d-question-lifecycle.test.mjs`：`D1:45`（caller abort 到达手机侧 signal → 不产生迟到卡片，race 仍收尾）、`D2:73`（GUI win 只 abort 本地 race signal 一次，**不动 caller signal**，幂等）、`D3:103`（下游 headless NO_PROVIDER 先 reject，手机回退仍完成）、`D4:119`（dispose mid-flight 注销监听且无悬挂 waiter）、`D5:144`（provider 路径透传 caller signal）。**保留**，signal 合并语义（`AbortSignal.any`）是真实修复的行为证据。

**I-17｜v015 S1 窄事务/锁内 last-owner ＋ S3 HTTP sender 契约（强行为测试，保留）**
- `test/v015-stage-s1-core.test.mjs`：`T04:45`（业务 abort 零写盘零发布、与提交可区分 `aborted/code=BUSINESS_ABORT`）、`T04:70`（锁忙是 IO 失败 `STATE_BUSY`，`aborted:false`）、`T04:85`（无事务能力 store → `TRANSACTION_UNAVAILABLE`，不伪造原子成功）、`T05:95`（**跨实例并发**：identity B 持陈旧快照，删除/降级末位 owner 仍被**锁内 fresh state** 拒绝 `owner-last`，owner 不清零——真实修复的并发证据）、`T05:119`（同键兄弟字段保留，改 label 不丢 role/pairedAt，且**读回**一致）、`T05:135`（`storage-failed` 与 `owner-last` 互不改写）、`T05:160`/`T06:181`/`T06:197`（业务拒绝零写盘、不误报 `storage-failed`；缺失项 → `not-found`）。**保留**，这是本次审查中并发正确性证据最强的文件之一。
- `test/v015-stage-s3-http-sender.test.mjs`：`契约:59`（stateless sender 对象**精确键集** `['lifecycle','send','type','validate']`，不得有 `createRuntime/start/stop/candidate/dispose`）、`:71`（`defineStatelessSender` 缺动作/缺 type 拒绝）、`证据:80/87`（成功无回执 → `accepted`；显式回执 → `confirmed`）、`golden:96/115`（bark/webhook sender 的 url/body/headers 与旧 adapter **逐字段一致**，协议实现不迁移）、`4xx/timeout/SSRF:130/140/152/168`（`API_ERROR`/`HTTP_ERROR`/`TIMEOUT(noRetry)`/`UNSAFE_TARGET`，错误话术不泄露 endpoint/密钥）、`frozen:183`、`真实装配:195/232`（notifier 经 sender 契约真发）。**保留**。
  - 弱断言（低风险）：`:227` 只断言 `senderTypes().length >= 28`（下界）。若某个 sender 因别名合并/静默丢弃而缺失，仍可能通过。建议对关键类型集合做精确断言，或对「已登记类型集合」设快照。

**I-18｜v015 S6 投递证据/健康 ＋ S7 官方 Host seam（强行为测试，保留）**
- `test/v015-stage-s6-delivery-evidence-health.test.mjs`：`证据:22/37`（accepted / delivered(confirmed) / unknown 三桶分开；成功无回执只算 accepted；**legacy 只有 `delivered` 的旧语义按 accepted 归类、不冒充 confirmed**）、`有界:50/56`（window cap + TTL 淘汰）、`epoch:71/85`（换世代后旧实例迟到观察一律丢弃、epoch 单调不回退）、`状态:99/105/115`（配置存在+在跑但无证据 → `ready`；结果不确定 → `unavailable`；`unsupported` 显式；`restartPending` 优先于 evidence）、`observer:123`（畸形 record 不抛不阻断）、`端到端:133`（超时 → `unknown` 桶 + health `unavailable` + `record.failed[0].uncertain=true`，不重放）。**保留**。这是「证据分级」语义最完整的套件，且方向为 fail-closed（不把 accepted 谎报成 delivered）。
- `test/v015-stage-s7-host-seam.test.mjs`：`H03:81`（`readHostService` get 优先/直读兜底/**cordis 代理直读抛错按无服务**）、`:102/131`（`hostQuestionFeatures` 永远以**运行时探测**为主、声明表只补版本差异；未列版本 → `known:false` + 保守全关；0.2 行 `verified:false`）、`:152`（空 ctx 聚合门面不抛不谎报）、`H01:175/184/209/233/251`（无 inject → 直连降级；晚注入才 attach；**重建/replacement 时旧 listener 退出只留一个**；attach 抛错只 warn 不炸装配；服务缺失局部降级不阻断其他能力）、`H02:266/295/316/330`（有界等待结束**不误取消 caller signal**；0.1.7 无迟到答复能力 → 未作答即终态；下游无 answerer 有界收尾；手机侧先答即终态）。**保留**，且 H02 直接对应产品约束⑥（宿主能力差异必须显式建模，不谎报）。
  - 源码自证（小）：`H03 集中化:166` 断言 `src/index.mjs` 文本不含 `ctx.inject(`、`host/seam.mjs` 含 `ctx.inject(list,`——架构护栏，方向正确但锁文本，属簇 H 主题。
  - 标 `unknown`：`HOST_QUESTION_CAPABILITY` 中 `0.2.0-rc.2` 的 `timed/continued` 是**声明**而非 fixture 验证（测试自标 `verified:false`）；真实 0.2 宿主行为未证实。

**I-19｜v015 S8 Session/Routing 收敛 ＋ S9 交互 claim 收敛（本次最强行为测试，保留）**
- `test/v015-stage-s8-routing-convergence.test.mjs`：用可注入「提交瞬间最新值 vs 过期读取视图」的内存事务 store **稳定复现 TOCTOU 窗口**（不靠真实竞速）。`K02:55/70/88`（注册表生命周期写以**事务内最新 draft** 为基底，并发/兄弟 outbound、control、跨会话无关行一律保留）、`:100`（事务未提交 → `ensureSession` 不返回成功记录、无半提交）、`:109`（无 `transact` 旧 store 回退单键读改写，**仍按字段级合并保留兄弟字段**）、`:125`（他人业务 abort 不影响本写者独立提交）。**保留**。
- `test/v015-stage-s9-claim-convergence.test.mjs`：**只经生产入口**（`bus.accept` / `bridge.adminPending+adminSettle` / `control.handle` / `dispatcher.dispatch`）驱动，定向磁盘故障用 `sabotageWrite` 精确注入。覆盖：`I02:137/153/169/188`（claim 提交前失败 → host effect **0 次**、行保持 pending 可重试、Control Core 返回 `desktop_fallback` 非 accepted、handler 零调用）、`I03:211/233`（claim 后终态落盘失败 → 保持 `claimed`/标 `uncertain`，**重启只报 uncertain 且绝不重放不可逆 effect**）、`I04:245/272/299`（手机先答 → Web 迟到裁决 `already_handled`，终态不反转，host effect 恰好一次；重复点击 `already-resolved`）、`I01:317/341`（跨 chat/跨通道来源不匹配 → 不结算、不消耗正确来源待决、token 未核销；原会话仍可裁决）、`H02:363`（终态已定后迟到结算不翻转、不复活已终结 live waiter）。**保留**，这是「授权→durable claim→首达结算→host effect」边界收敛的最强证据，且与台账 ledger terminate/uncertain、跨账号 owner 主题互相印证。

**I-20｜v015 S20 equivalence/rollback drill（强行为测试，保留；含一处口径提示）**
- `test/v015-stage-s20-equivalence-rollback.test.mjs`：oracle 用**真实 store/迁移/出站权威/identity/ledger**。`L02a:72`（对**全部** `CHANNEL_TYPES` 按分类逐类断言 legacy→canonical 迁移结果：`copied-from-admin`/`copied-from-account`/`dual-domain-kept`/`canonical-wins`，且所有 `admin:` overlay 已退役、`STATE_SCHEMA_KEY=STATE_SCHEMA_VERSION`）、`L02a:125`（二次迁移 no-op、快照 byte-stable）、`L02b:139`（切换窗口内写入的配置与成员在 rollback 后存活，新装配 reader 解析到同一 effective 配置）、`L02c:166/181`（`claimed` 行重启后 `isPending:false`、claim 不重放、结算 `already-claimed`；`uncertain` 行重启后不重放、`already-resolved`、不可再 terminate）、`L02d:198/211`（**一次用户动作 = 恰好一次 durable 事务**，无写放大；save 阶梯线性且每次都提交）。**保留**。
  - 口径提示（非缺陷）：`L02a:72` 的「零未解释差异」是相对**测试自身声明的分类规则**（slot 轮转 + `DUAL_INBOUND_DOMAIN` 常量）。这些规则与迁移实现共享同一来源，属**规范内自洽**而非独立上游契约；作为回归护栏有效，但不能当作「迁移语义独立正确」的证据。建议在报告口径中注明。
  - 健康姿态：`L02d:239` 的墙钟断言 `<30s` **自带免责声明**（仅作挂起/二次爆炸护栏，真实吞吐证据在 `scripts/perf-drill.mjs`）——值得肯定，未把不稳定的计时钉成契约。

### 簇 J：出站「群目标无条件放行」——与「只支持私聊 / WP07 群目标出站拒绝」直接冲突（新发现，高风险）

判定基准：产品约束①「只支持私聊」；`02-scope-inventory.md` WP07 完成标准（`:62`）「**群事件/未知类型/群目标/Topic 均无业务触发、出站拒绝、迁移停用**」；`:35-49` 明确要求逐文件处置 `src/inbound/target-guard.mjs` 等群命中的**群业务/群目标**。

**J-1｜`resolveNotifyTargets` 把群目标（extras）无条件并入审批/提问/动作通知目标**
- 文件/行/测试名：`test/target-guard.test.mjs:128 '一级：该通道有绑定成员 → 绑定接管用户目标；群目标（extras）无条件保留'`、`:148 '二级：…群目标并入去重'`、`:207 '一级 + extras 重复去重…'`。
- 实际断言：`:140-145` `extraTargets:['opengrp01']` → `assert.deepEqual(targets, [{chatId:'user01'...},{chatId:'opengrp01'...}])`（群目标与私聊成员**同列返回**）；`:159-162` 群目标 `opengrp02` 并入；`:216-219` 重复群目标只发一次。
- 生产链路（源码，非测试）：`src/inbound/target-guard.mjs:128-189` 把 `extraTargets` 去重并入 `merged` 返回；调用方 `src/inbound/telegram-bot.mjs:556-565`（`extraTargets = notifyChatIds.filter(id => id.startsWith('-'))`，**负数=群/超级群/频道**）、`src/inbound/qq-gw.mjs:755-763`（`extraTargets = config.notifyGroups`）；其产物经 `notifyTargets()` 喂给 **审批/提问/动作通知**：`src/approval/router.mjs:320`、`src/questions/router.mjs:321`、`src/event-listener.mjs:411`（均 `guardTargets(inbound.channel, inbound.notifyTargets(), warn)`）。
- 预期来源：**旧文档/旧行为**（v0.6/v0.7「群通知是渠道属性、绑定接管用户目标后群通知不消失」——见 `target-guard.mjs:113-117,172`、`telegram-bot.mjs:551-555`、`qq-gw.mjs:752-754` 注释）。**不是**用户需求，也与 WP07 完成标准直接冲突。
- 固化缺陷：把「群/超级群（telegram 负 id、qq notifyGroups）可作为审批/提问/动作通知的出站目标，且无条件保留」写成契约。合成消息「私聊定位/卡片」被投递到群会话，正是 WP07 要求「群目标出站拒绝」要清除的路径。测试全是**正向放行**断言，无任何「群目标被拒绝」用例守护。
- 建议：**删除/改写** `:128/:148/:207` 的正向断言；`resolveNotifyTargets` 应当剥离而非并入群目标（或对 extras 做群语义过滤并要求调用方显式 opt-in）；新增行为测试——telegram `notifyChatIds:['-100123...']` / qq `notifyGroups:['grp']` 下，审批与提问的 `notifyTargets()` **不含任何群目标**，且 `send` 无群记录。
- 交叉印证：与簇 A-2（dsh-im `listTargets` 群目标 `kind:'group'` 被放行）、簇 B-3（飞书群聊出站文本放行）同属「群出站未收敛」这一主题的第三个独立出口。

### 簇 K：会话路由 / 合并窗（核心行为；一处群语义命名与弱断言）

审查文件：`test/conversation.route.test.mjs`（全 32 用例）、`test/conversation.task-selection.test.mjs`（5 用例）。

**K-1｜控制 Core 会话闸（合规，保留）**
- `conversation.route.test.mjs:664`（personal 默认 `converse` 关闭 → 普通文本被拒并提示、不投递）、`:676`（显式开启且本地 accountId 在场 → 投递）、`:693`（缺 accountId → fail-closed，「channel 绝不充当账号」）、`:705`（QQ 群聊来源拒绝远程控制）。**合规**，是「只支持私聊 + 来源绑定」的行为级证据。

**K-2｜G-51 的「群」是伪群（chatId='grp-1' 但无 chatType），命名会掩盖真实群路径（改写建议）**
- 文件/行/测试名：`conversation.route.test.mjs:539 'G-51：同 userId 双 chat（私聊+群）窗口交替发言 → 两条独立投递、不串台'`、`:572 'chatId 缺失仍聚合进 "" 维度'`。
- 实际断言：`:552-555` 用 `chatId:'42'` 与 `chatId:'grp-1'` 交替发言，断言合并窗按 chat 维度隔离、`:559` 两条独立投递。**注意**：这些信封**不带 `chatType:'group'`**（`:552-555,579,586`），故并未穿越准入闸，`grp-1` 只是「第二个 chat 维度」。
- 预期来源：**当前实现**（合并键 `channel:account:user:chat`）。
- 固化风险：① 用例标题把 `grp-1` 称为「群」，但断言只证明「不同 chatId 不并窗」，无法证明群准入；真实 `chatType:'group'` 的拒绝由 `v015-private-admission.test.mjs` 覆盖。② 更需警惕的是反向——若某适配器把群事件规范化为「有 chatId、无 chatType」，本用例的绿色路径会**误当合法投递**。
- 建议：**改写** fixture 的 chatId 为中性名（如 `chat-B`），把「双 chat 不串台」与「群准入」解耦；另加一条断言：`chatType:'group'` 的同一信封在真实 bus 上被拒、不进 conversation 投递。

**K-3｜任务选择卡（行为正确，保留）**
- `conversation.task-selection.test.mjs:71`（多活跃无绑定 → 先出选择卡不投最近）、`:92`（编号消解只投一次到所选任务）、`:114`（越界编号不清待决、原消息不投）、`:132`（`/use` 选择后投一次）、`:150`（`/tasks` 脱敏 + attention 标记）。**保留**，与 R1「不自动挑最近者」一致。

### 簇 L：跨渠道「旧卡缺来源元数据 → 兼容放行」家族（与约束④直接冲突；比 C-1 更广）

判定基准：产品约束④「不为旧版本保持兼容」；AGENTS.md 硬边界「A callback or reply must be scoped to its original channel/chat when the record carries source metadata」+「fail-closed」。测试注释自标依据为 `PLAN §C1(b) 显式保留`——即**旧版计划**，非 v0.15 产品约束。

**L-1｜同一「缺来源→放行」在 4 处独立固化，且均可从任意会话结算**
- 文件/行/测试名与实际断言：
  - `test/inbound.feishu.test.mjs:834 'ac: 卡片回调：F-08 来源会话匹配通过 / 转发拒绝；缺 srcChats 旧卡兼容'`：`:878-882` 用**账本无 srcChats、卡片无 srcChat**的 legacy 卡，从 `oc_legacy` 点击 → `legacy.toast.type==='success'`、`dispatched.length===2`（**放行执行**）。
  - `test/inbound.feishu.test.mjs:887 'aq: 卡片回调：SEC-1 …缺 srcChat 旧卡兼容'`：缺 `srcChat` → 进入 `questions.decide`、`verdicts` 增加（放行作答）。
  - `test/inbound.feishu.test.mjs:1014 'C1 飞书来源比对：srcChat 缺失（旧卡）→ 维持兼容放行 + warn'`：`:1030-1036` **连点击会话都没有**（最坏形状）仍 `success`、`verdicts.length===1`。
  - `test/inbound.telegram.test.mjs:458 'C1 TG 来源比对：origin 缺 chatId（旧卡）→ 兼容放行 + 显式 warn'`：`:473-482` 发卡时无 chatId，从**任意 chat 777** 点击 → `decisions.length===1`、`decisions[0].chatId===777`。
  - `test/inbound.telegram.test.mjs:994 'F-08 ac: 回调：legacy 老卡（无来源元数据）→ 兼容放行 + 显式 warn'`：`:1000-1004` 无 meta 铸卡 → `executed.length===1`。
- 生产链路：`src/approval/router.mjs`、`src/questions/router.mjs`、`src/inbound/*-bot.mjs` 的 `srcChat`/`srcChats`/`origin.chatId` 缺失分支走 warn+放行（键集见 `inbound.feishu.test.mjs:877`、`inbound.telegram.test.mjs:475`）。
- 预期来源：**旧文档/旧计划（PLAN §C1(b)）**，非用户需求。
- 固化缺陷：把「无来源元数据的历史卡片可从任意 chat/user 结算审批或作答」写成兼容契约。虽然 (a) token 一次性且不可猜、(b) `approval.test.mjs:300 G-41 pushedTo 空表` 另有 fail-closed 分支，但**来源缺失一侧的默认作答是「放行」而非「拒绝」**，与约束④（不为旧版兼容）和 fail-closed 军规相反。C-1（`actions.test.mjs:289`）只是这一家族的 dispatch 面；适配器面（飞书 ac/aq、TG ac/ap）还有 4 个入口在同向固化。
- 建议：**改写为 fail-closed**——缺来源元数据的卡应回执「来源无法验证，请重新发起」、不结算、不回退桌面放行；若确需一次性过渡，必须**绑定明确退役时间窗**并用测试断言「窗外必拒」。新增行为测试：铸卡不带来源 → 从任意会话点击 → 拒绝、无 handler 执行、账本零写。
- 交叉印证：与 C-1 同主题；与簇 J（群目标出站）、簇 A-2（dsh-im 群目标）共同说明「旧行为退出」在产品层尚未收敛，而测试正把这些旧兼容路径钉成契约。

### 簇 M：其余非委派文件的通读结论（未发现新的缺陷固化；少数弱断言/命名留存）

以下文件按用例标题遍览并抽查断言，整体为**真实行为/故障注入**测试，方向多为 fail-closed，**未发现新的缺陷固化**，仅登记可收紧点：

- 安全与网络：`test/urlguard.test.mjs`（SSRF 全矩阵：私网 v4/v6/映射/ULA/链路本地拒绝、C9 连接阶段只返回已验证 IP 防重绑定、scheme 白名单、`redirect:manual` 不跟随 3xx、DNS 短 TTL 缓存含被拒结果）、`test/network-policy-production-path.test.mjs`（resolve→pin→native request，loopback hermetic 集成）、`test/channel-fail-closed.test.mjs`（QQ 群/未知来源全命令 fail-closed；微信 iLink 能力「声明而非真机验证」显式标注）、`test/security-structure.test.mjs`（admin 输出掩码、audit 轮转上限、`__proto__` 拒绝）、`test/redact.test.mjs`、`test/sign.test.mjs`（钉钉/飞书加签对官方用例）、`test/tokens.test.mjs`（TTL 归一 fail-closed、invalidate 代际守卫）、`test/target-guard.test.mjs`（除簇 J 的群 extras 外，`isValidTargetId` 形态矩阵与 fail-closed 正确）。**保留**。
- 入站适配器：`test/inbound.test.mjs`（boot 损坏取证副本、原现场不覆写、锁回收），`inbound.transport-timeout`、`inbound-dedup-bounded-v0121`（未绑定来源不落盘 + 内存 FIFO 去重）、`inbound-log-command`、`inbound-sessions-command`、`inbound.message`、`inbound.capability-matrix`、`inbound.wechat`（含旧版超量键族收敛）、`inbound.wxpusher`。**保留**（`inbound.*` 内的群负向用例已在簇 B-4 记为合规模板）。
- 出站/适配器：`test/adapters.test.mjs`（38 用例，payload 逐字段 golden、G-55 TTL、G-08 retry_after、G-53 文案不泄底层 message）、`test/notify.test.mjs`、`test/health.test.mjs`、`test/segment.test.mjs`、`test/breaker.test.mjs`、`test/routing.test.mjs`、`test/wecom-app.test.mjs`、`test/dingtalk-auth.test.mjs`、`test/channel-login.test.mjs`、`test/channels/{telegram,feishu,wechat-ilink}.test.mjs`（facade accountId 取 config 而非事件、能力声明不冒充真机）。**保留**。
- 控制面/服务层：`test/control-contract.test.mjs`、`control-surface-service-v012`/`rpc-v012`/`surface-revision-v012`/`runtime-mutability-v014`/`config-runtime-truth-v013`、`channel-control-service-v014`/`routing-control-service-v014`/`members-control-service-v014`/`questions-control-service-v014`（Native 与 Admin 共用同一 canonical 事实、真实落盘失败如实报错、TOCTOU 事务内 RMW）。**保留**（高质量行为测试）。
- 路由/会话：`test/agent-router.test.mjs`（47 用例：resolveOutbound/Inbound 层级、R1 无显式选择即 `sessionId=null`、并发字段级合并、墓碑保留）、`test/task-routing.test.mjs`、`test/routing.test.mjs`、`test/wiring.route.test.mjs`（除 D2 的源码自证外，路由回落行为正确）、`test/route-cli.test.mjs`。**保留**。
- 事件/生命周期：`test/event-listener.test.mjs`（45 用例：防抖有界 256、宽限窗接管取消、dedup、dispose flush、stall 卡片）、`test/escalation.test.mjs`、`test/activity-v012.mjs(2)`、`test/turn-tracker.test.mjs`、`test/launch-ticket-v012.test.mjs`、`test/v015-p3-lifecycle.test.mjs`。**保留**。
- 身份/配对：`test/identity.test.mjs`（45 用例：迁移一次性播种、坏键清洗、跨渠道准入隔离、`principal` 三元组）、`test/pairing.test.mjs`（15 用例：哈希落盘无码面、锁出滑窗、bootstrap 并发单胜、过期码不锁出）、`test/pairing` 与 `test/commands.test.mjs`（G-06/G-65 解析）。**保留**（`identity.test.mjs:315 C8` 已做 `channel/accountId/userId` 隔离，是 D2 的对照面）。
- 其余：`test/contract.test.mjs`、`test/consumer-demo.test.mjs`、`test/package-exports.test.mjs`、`test/package-payload.test.mjs`、`test/plugins-docs.test.mjs`、`test/user-copy-lint.test.mjs`、`test/lang-strings.test.mjs`、`test/verdict-text.test.mjs`、`test/desktop.test.mjs`、`test/host-capability.test.mjs`、`test/host-events.test.mjs`、`test/host-seam-audit.test.mjs`、`test/issue38-host-compat.test.mjs`、`test/store.test.mjs`、`test/config*.test.mjs`、`test/index.test.mjs`、`test/tool-register.test.mjs`、`test/rules.test.mjs`、`test/client-module.test.mjs`、`test/login-credential-durability-v013.test.mjs`、`test/terminal-cleanup-v013.test.mjs`、`test/v014-stage-b-persistence-tx.test.mjs`、`test/delivery-evidence-v013.test.mjs`、`test/outbound-source-v012.mjs`、`test/surface-*`。**保留**。
- 弱断言/命名留存（可收紧，非缺陷固化）：
  - `test/v015-stage-s5-provider-migration.test.mjs:216 'T11 fitness：入站六通道的 negative 回归套件仍在位'`——仅断言 6 个 `inbound.*.test.mjs` **文件存在**（`doesNotThrow(readFileSync)`），信息量近零（文件被改名/内容清空都能过）；属簇 H 主题的非委派残留，建议删除或改为对具体负向用例命名/内容的校验。
  - `test/v015-stage-s5...:230 'T11 回退：未知渠道 senderOf→null，notifier 回落旧 adapter.send'`——固化「未登记渠道回落旧 adapter」回退路径；因 T11 完整性已证明全部 `CHANNEL_TYPES` 均已登记，该回退仅对真正未知类型可达，风险低，但口径上仍是 legacy 通路，需确认退役计划。
  - `test/package-payload.test.mjs` 仅 3 用例（公开入口文档/链接/排除内部执行说明）；AGENTS.md 要求的「npm 包不得含 `.claude/ .codex/ .opencode/`」**未被显式断言**，但 `package.json.files` 为正向白名单 → 三者按构造排除（见簇 N，原 `unknown` 已降级为低风险）。
  - `test/inbound-log-command.test.mjs:295 '静态守卫：index 装配——remoteLog 单独开启建账本，但晨报仍只由 digest.enabled 决定'`：读 `src/index.mjs` 文本，用多行正则 `assert.doesNotMatch(src, /if \(ledger !== null\) \{\n\s*try \{\n\s*const window = yesterdayWindow/)` 守卫晨报块。属簇 H 的源码 grep 自证主题（此为非委派文件）；多行空白敏感、合法缩进/顺序调整即误报，且不能证明运行时守卫正确。建议保留精神、改为行为测试（remoteLog 单开时晨报**不发**、digest 开启时才发）。同文件 `:302` 的「生产 src 零 `session.events` 调用」亦为文本守卫（逐行判注释），方向正确但脆。

### 簇 N：本审查员本轮续审的非委派文件（深读到断言；均高质量，仅一处重言式）

以下文件**逐用例读到断言**并对照源码，整体是**真实行为/故障注入**测试、方向 fail-closed，未发现新的缺陷固化；仅登记一处重言式与两处口径提示。

- **`test/v015-private-admission.test.mjs`（12 用例，强负向证据，保留）**：对 6 个渠道 ×{群普通文本/命令/配对/数字回复}断言 `bus.accept` 一律 `reason:'group_chat_disabled'` 且 `fanout=0`、`identityReads=0`（`:8-18`）；对 6 渠道 ×{approval/question-answer/stop/steer/ordinary-message}断言 `control.handle` 一律 `status:'rejected'` 且 `lookup=resolve=effect=0`（`:19-30`）。**这是「只支持私聊」在入站准入层的真实守护**，也是簇 B/J 的关键对照：入站群**确实**被拒；簇 B 的群正向用例之所以通过，仅因其用 stub bus 绕过了本文件的真实闸门。
- **`test/inbound.qq.test.mjs`（保留；与 J-1 交叉）**：`GROUP_AT_MESSAGE_CREATE` 群 @ 事件在真实 bus 一律 `accepted=[]`（`:772/:785/:798`）、群按钮回调同样拒绝（`:831`）、群提问卡直接 `null`（`:891`）。但 `notifyTargets()`（`:1082`）把 `notifyGroups:['g1']` **并入出站通知目标**——正是 J-1 的群目标出站面；群出站接口 `/v2/groups/` 被学习与使用（`:930`）。即：群**入站**被拒、群**出站配置目标**仍放行，与 J-1 结论一致。
- **`test/inbound.dingtalk.test.mjs`（46 用例，保留）**：`private-only: DingTalk group mentions, commands and pairing never reach consumers`（`:318`）用真实 bus 断言群消息/命令/配对 `accepted=[]`；另有 ack 契约（G-01 顶层 messageId 陷阱）、SYSTEM/ping 回显隔离、二次 parse 失败可观测、去重/sessionWebhooks/targetKinds/msgSeqs 四个有界表 LRU+warn、熔断、TTL fail-closed（G-55）。协议 mock 自标「未经真机验证」并登记 `docs/protocol-preflight/dingtalk.md`，是**诚实标注**的正面样本。
- **`test/conversation.test.mjs`（24 用例，保留）**：`QQ 群 control gate`（`:67`）用真实 `bus.accept(chatType:'group')` 断言 `group_chat_disabled` 且 `replies=0`，与 private-admission 同向；R1「未显式选择即无处可投/不回落最近活跃」（`:384/:395/:409`）、合并窗 32 段上限（`:158`）、`/stop` 附言不误杀（`:272`）均为真实行为。
- **`test/v015-stage-s16-remote-url.test.mjs`（保留）**：`validateRemoteUrl` 纯函数拒绝矩阵（no-tls/unsafe-scheme/embedded-credentials/contains-secret/empty/unparseable/too-long）、QR⇔明文链接**逐字节相等**、显式断言 `fetch` 零调用（`:96-107`）。高质量。
- **`test/v015-stage-s17-tunnel.test.mjs`（保留）**：驱动真实 `extensions/cloudflare-tunnel/*`；R03 拒绝矩阵（Quick Tunnel、host-trust、Access 未配置冒充）、R05 资产校验和 fail-closed、R01 单飞+deadline、R02 epoch 隔离/不复活/有界重连/stop 竞态、日志脱敏。确定 fake 进程 + fake 定时器，无真实子进程/网络。高质量。
- **`test/v015-stage-s21-rc-guardrails.test.mjs`（保留）**：store owner-aware 活锁不被 age 回收（`:36`）、死 PID 过探测下限回收（`:51`）、畸形锁 >10s 才回收（`:67`）、disposer function/Fiber/PromiseLike 形状（`:86-129`）、stateful sender 退役不复活（`:144-179`）、tunnel 信任/生命周期（`:214-270`）、`notifyAll` 超时归类 unknown（`:275`）。高质量。
- **`test/v015-stage-s10-entry-parity.test.mjs`（保留）**：Native 窄动作与 Admin 落**同一 identity/route 权威**且字段级合并不丢兄弟字段（`:109/:132/:153`）；IO 失败 Native=`storage-failed`、Admin=500，**绝不伪装 not-found**（`:170-225`）；能力缺失 fail-closed（`:229`）；末位 owner 守卫收敛到 identity 锁内（`:253`）。高质量。
- **`test/native-boundary-contracts.test.mjs`（保留）**：secret 只暴露 presence（递归 `keysOf` 断言明文不出现）、accepted≠confirmed 四态映射、accountId 不被 channel 顶替、快照禁内部字段名（sessionId/bindingKey/principal/claim/epoch/revision）、列表显式上限+截断告知、写动作单一 authority 不双记、三态密钥补丁无第四语义、宿主能力缺失 fail-closed。是 Native 面的**强契约证据**（可补强簇 F/I 的 Native 侧）。
- **`test/inbound.message.test.mjs`（保留）**：文本/图片/文件归一与 fail-closed、`normalizeImageUrl` SSRF 硬边界（含 IPv4-mapped IPv6 绕过）、下载超时/超限/非图片、`parseQqAttachments` 官方 attachments 白名单、`C9` DNS 解析到私网即拒绝且不调 transport。高质量。
- **`test/v014-stage-e-native-ux.test.mjs`（保留）**：投影 `detail`/`patchControl` 字段级合并、拒非法源字段与未知键且**零落盘**、无 service 时 `not-supported`。高质量。
- **`test/package-payload.test.mjs`（保留，并解 unknown）**：断言公开入口文档/资产被 `package.json.files` 覆盖、内部执行说明（AGENTS/HANDOFF/audit-ledger 等）不被打包。**`files` 是正向白名单**（`package.json:18` 起），`.claude/ .codex/ .opencode/` 因此**按构造排除**（不在白名单即不进包）——AGENTS 硬边界满足，但未被显式断言（低风险；如需强护栏可加显式排除断言）。
- **`test/mobile-task-loop-contract.test.mjs`（保留，一处重言式）**：`contract: host capability snapshot exposes task-visible shape`（`:24-30`）是**重言式**——`for (const key of keys) assert.ok(key, ...)` 对非空字符串字面量**恒真**，且**不调用任何快照函数、不 import 被测模块**，无法证明快照含这五个域；测试名声称的契约完全未被验证。建议**改为真实断言**（构造 capability snapshot 并断言五域存在且无敏感域），或**删除**。同文件其余 6 项契约（双端先到先结算、多任务歧义先选卡、图像双载、任务投影只读形状）为真实行为，保留。
- 两处口径提示（非缺陷固化）：`v015-stage-s10-entry-parity.test.mjs:132/:153` 以「daily 面已删 sessions.*/bindings.*」为断言依据——属**旧行为退出**的正确方向，但需产品侧确认这些删除已是最终态（与约束③一致）；`inbound.qq.test.mjs:1082` 的群目标入 `notifyTargets` 见 J-1。

### 簇 O：本审查员第三批续审（非委派）——**空断言 / 条件断言 / 自足重言式**（新发现）

以下文件逐行读到断言，多数高质量；但发现**一类与簇 N 重言式同源、更隐蔽的「条件/空断言」**——测试恒绿，却在关键前提不成立时**什么都没断言**，与「测试通过不能替代真实证据」直接冲突。

- **`test/channel-fail-closed.test.mjs`（16 用例；两处命名/自足问题）**
  - **O-1｜`:103 'Telegram: 4096 UTF-16 boundary - splitting respects codepoint boundary' 是自足重言式**：用例**不 import、不调用任何生产切分函数**，在测试内部用 `if (acc.units + size <= LIMIT)` 自行重算一遍切点，再断言 `split.units <= LIMIT`——这是**用自己的守卫证明自己的结果**，恒真。测试名承诺「切分尊重码点边界」，但对 `src/` 的 Telegram 分段实现**零覆盖**；Telegram 真把代理对劈开时本用例仍全绿。与 `mobile-task-loop-contract.test.mjs:24` 同类，但更危险（名字带具体协议数字，最易被当真实证据引用）。**建议改为调用生产 `splitByCodePoints`/`segmentText`（`src/inbound/segment.mjs` 已有强用例）并对 4096 边界断言，或删除。**
  - **O-2｜`:71 'Feishu: callback requires open_chat_id and user_id' 名不副实**：断言只有 `result.channel`、`result.capabilities.buttons` 为 boolean，**完全没有验证 `open_chat_id`/`user_id` 必填**（缺字段/畸形载荷未构造、未断言拒绝）。测试名承诺的准入校验无断言。**建议补「缺 open_chat_id 或缺 user_id → 拒绝」断言，或改名。**
- **`test/security-structure.test.mjs`（Phase 6 安全/结构，13 用例；四处**条件空断言**）**
  - **O-3｜`:88 'admin API: getChannels returns masked secrets'**：masking 断言整段包在 `if (tgRow && tgRow.config)` 内。若 `getChannels()` 不再返回 telegram 出站行（键名/方向口径漂移）或 config 缺省，**循环不执行、用例零断言通过**。安全断言出现「前提不成立就静默通过」是最危险形态。**建议断言行必须存在且 `config` 必须存在，再校验逐字段 `=== '***'`。**
  - **O-4｜`:106 'getSessions does not expose raw control owner/members'**：断言包在 `if (session.control)` 内；`session` 找到但无 `control`、或 control 被整体删掉时**空过**，"不泄漏"从未被证明。**建议断言 `session.control` 存在且 `typeof mode==='string'`，并对 owner/members 恒 `undefined`。**
  - **O-5｜`:131 'audit rotation caps at AUDIT_MAX_BYTES'**：`statSync` 与 `< 2MB` 断言整个包在 `try` 里，`catch {}` 注释「文件可能不存在…那也行」——**文件不存在即空过**，「有界」结论不可证。**建议断言文件存在且 `size <= AUDIT_MAX_BYTES(+1 行余量)`，不吞异常。**
  - **O-6｜`:153 'putChannel failure does not affect other channels'**：`try { api.putChannel('feishu',…) } catch (e) { assert.equal(e.status,422) }`——若 `putChannel` **不抛**（回归：非法 webhook 被放行），catch 不执行、**零断言通过**，"失败"前提从未被证实。**建议 `assert.throws`/`assert.fail` 显式要求抛 422。**
  - 该文件合规部分（`normalizeControlOverlay` 源字段剥离、通配 owner 拒绝、`__proto__`/`constructor` 拒绝、成员额外字段 422）为真实行为，**保留**。
- **`test/actions.test.mjs`（34 用例，属簇 L 家族的装配面；一处重言式）**
  - **O-7｜`:83 '伪造 token → bad-signature；过期 → expired（TTL 核销）' 末句是裸重言式**：`assert.ok(expired.ok === true || expired.ok === false)`——布尔穷举恒真，注释自认「不抛即过」，**测试名承诺的 `expired` 裁决从未被断言**（`ttlMs:50` 与同进程 dispatch 间无 `await`，实际通常仍 `ok:true`）。过期语义的**唯一** E2E 断言缺失。**建议注入可控时钟或 `await sleep` 越过 TTL 后断言 `reason==='expired'`，且不得核销。**
  - 其余（首达采纳、key-mismatch、handler 异常收容、C5 claim 落盘失败/重启 uncertain、CRACK-001 宽限窗分窗与异常形状 fail-closed）为**强行为测试**，保留；其「缺来源→宽限放行」本身即簇 L 的固化对象，处置见 L-1。
- **本轮判定为高质量、保留（逐断言核对）**：`test/control-entry.integration.test.mjs`（25 用例：Control Core 共享入口、`source_chat_type_unknown`/`missing_accountId` fail-closed、owner/team 源绑定精确、overlay 不可伪造源字段/加能力、`conversation_disabled` 不误封 stop、跨重启 overlay 持久化）、`test/conversation.attachment-delivery.test.mjs`（10 用例：文本+文件 durable block、远程 URL 绝不进 Session、16MiB **实际字节**聚合预算精确断言第 6 个被拒、部分/全失败不塞空消息、缺 `saveFile` 能力中英诊断+warn 去重、文件名去路径）、`test/conversation.image-delivery.test.mjs`（5 用例：双载不丢图、纯图无占位 text、合并窗图取首条、下载失败只回执）、`test/segment.test.mjs`（18 用例：码点切分属性式无孤立代理项、句末优先、预算收敛、顺序送达中途失败即停）、`test/redact.test.mjs`（8 用例：密钥形态矩阵、幂等、minimal 80 码点截断+打码、extended 才外发）、`test/verdict-text.test.mjs`（5 用例）、`test/lang-strings.test.mjs`（zh/en key 形状一致、EN 文案零回潮）、`test/user-copy-lint.test.mjs`（可见文案/README/用户词表禁内部词，含字符串感知注释剥离）、`test/client-module.test.mjs`（旧控制台方法从 controller 移除、Native epoch 重启清缓存、导航清旧详情、支持报告按需一次+沙箱无能力回落 failed、静态守卫旧 RPC 名不残留）、`test/v015-stage-s23-gate2-rmw.test.mjs`（6 用例：**stale-read store 并发 oracle** 证明事务内 fresh read 不吞兄弟键、epoch 单调栅栏、安全投影绝不 freeze live）、`test/v015-stage-s2-config-layers.test.mjs`（8 用例：真实装配发 QQ/wecom、commit 失败零 apply、apply 失败 diverged、revision 栅栏）、`test/v015-stage-s5-provider-migration.test.mjs`（13 用例：28 provider 全覆盖、stateless/stateful 形状互不伪造、请求 golden 逐字段一致、错误码两侧一致、依赖方向 fitness、未知渠道回落）、`test/health.test.mjs`（9 用例：G-53 公开文案不含底层原文、`${ENV:}` 解析、纯空白串原样透传）。

（簇 E Cloudflare / 簇 F public·Native / 簇 G 旧控制台 / 簇 H 源码 grep 自证 已委派两名外援分别产出 md，待回收后合并。）

## 3. 已审测试数量与未深审范围

- 主套件总量：**2447**（`test/**/*.{test,spec}.mjs`，含循环生成的动态用例）；`test/dom` 另 **41+**（7 文件，独立运行，**不计入** 2447 与发布计数）。
- 本审查员**逐断言深审**（读到断言本身并对照源码/上游/文档）：**约 780+ 个测试点**，集中在簇 A/B/C/D/D2/I/J/K/L，以及本轮续审的**簇 N**（private-admission 12、inbound.qq/dingtalk/message、conversation 24、s16/s17/s21/s10、native-boundary-contracts、v014-stage-e-native-ux、package-payload、mobile-task-loop 等，约 280+ 点）与**簇 O**（channel-fail-closed 16、security-structure 13、actions 34、control-entry.integration 25、conversation.attachment/image-delivery 15、segment 18、redact 8、verdict-text 5、lang-strings、user-copy-lint、client-module、s23/s2/s5、health 等，约 200+ 点）。
- **按用例标题遍览并抽查断言**：覆盖约 **115+ / 178** 个测试文件；连同深审，文件级覆盖约 **65%**、测试点级覆盖约 **1800+ / 2447（≈73%）**。以上为按 `test()` 计数估算的**近似值**，非逐点精确台账。
- **未深审范围（明确列出）**：
  1. 委派外援的 **簇 E（Cloudflare）、簇 F（public·Native）、簇 G（旧控制台 admin-*）、簇 H（源码 grep 自证其余部分）**——待其 md 回收合并。
  2. 本审查员尚未逐用例展开的剩余文件：`admin-*` 全套（属 G）、`test/dom/*`（F/G 边界）、`host-*`（host-seam-audit/host-capability/host-events/issue38-host-compat）、`desktop`、`diagnostics-v014`、`inbound.wechat`（37）、`inbound.wxpusher`（余段）、`inbound-sessions-command`（10）、`delivery-evidence-v013`、`v015-stage-s1-core`、`v013-invariants`、`v015-stage-s4`（14，仅标题级）、`adapters`、`notify`、`rules`、`tokens`、`sign`、`store*`、`login-credential-durability`、`channel-login`、`config-*`、`questions-*`、`approval*`（余段）等——已做标题级/结构级核对，未逐条读断言。
  3. **完全未读**：`test/fixtures/**` 的逐字段核对、`test/helpers/*`、`test/_helpers.mjs`、`test/_hermetic-network-guard.mjs`、`test/dom/harness.mjs` 等的实现细节（仅按使用方理解其语义）。

## 4. 最高风险的测试幻觉（按危害排序）

1. **A-1 dsh-im 桥 mock 伪造 `accountFingerprint`（顶层）**：真实 Host 上 checked 投递**静默失效**（fail-closed 不误发，但功能不可用），测试全绿——**最可能让「dsh-im 桥已就绪」的结论失真**。
2. **J-1 群目标（telegram 负 id / qq notifyGroups）无条件并入审批/提问/动作通知**：直接违反「只支持私聊」与 WP07「群目标出站拒绝」，且**无任何拒绝用例**；测试把旧群通知行为固化为契约。
3. **L-1 / C-1 旧卡缺来源元数据 → 兼容放行**（飞书 ac/aq、TG ac/ap、actions dispatch 共 5 处）：与约束④「不为旧版兼容」及 fail-closed 军规相反，且可从**任意会话**结算。
4. **B-3 飞书群聊出站文本仍放行**（审批降级群文本、提问兜底群文本）：违反群出站拒绝。
5. **B-1/B-2 群聊正向测试用 stub bus**：锁死群 envelope 转发路径，**不能**证明群被拒绝，反而在有回归时给出虚假安全感。
6. **I-1/I-2/I-6 源码 grep 自证**：把「不变量」写成「源码里出现/不出现某个函数名词」，合法重构即误报、等价写法即漏报；被当作运行时证据会高估。
7. **I-13 host-compat-matrix + DOM 不计入 `npm test`/发布计数**：兼容性为「三方声明自洽」而非实测；真实 React 覆盖在默认本地运行中**静默缺失**（仅 CI 文本守卫），是覆盖率的系统性盲点。
8. **I-11 `bounded.test.mjs:157` 把 `cap=Infinity` 固化为「永不淘汰」**：与同仓库 `ledger-numeric-and-io-v0121.test.mjs:81` 要求的「`Infinity` 必须有界」**安全姿态相反**，是本审查发现的唯一由安全姿势不一致暴露的固化。
9. **D2 跨账号 owner 回退无守护**：`approval/router.mjs`/`questions/router.mjs` 的回退只看 `channel+userId`；`feishu-p2p-source.test.mjs:328 #10` 只覆盖 exact 路径。非 green 固化，但**静默漏洞无测试**。
10. **C-2 通知凭证（botToken）与入站凭证（gatewayKey）明文相等且同落两行**：测试把凭证传播面钉成正常，无「最小化传播 / unbind 撤回」断言。
11. **O-1 `channel-fail-closed.test.mjs:103` Telegram 4096 边界是自足重言式**：不调用任何生产切分函数，测试内自算切点后自证，恒真；名字带具体协议数字，最易被当「已覆盖 Telegram 分段边界」引用。同类：`mobile-task-loop-contract.test.mjs:24`。
12. **O-3~O-6 `security-structure.test.mjs` 四处条件/空断言 + O-7 `actions.test.mjs:83` 过期裁决裸重言式**：安全与过期语义的「唯一断言」在前提不成立时**静默通过**（未断言任何东西）——测试名承诺的安全/过期结论实际未被验证，是「全绿掩盖缺口」的典型。

## 5. 建议新增的真实行为 / 故障测试（按优先级）

1. **dsh-im 真实形状契约夹具**：mock `describeBot` 返回 `{version:1,botId,channel,connected,capabilities,account:{fingerprint}}`；补 `version` 校验；断言顶层无 `accountFingerprint`。（修复 A-1）
2. **群目标出站拒绝**：telegram `notifyChatIds:['-100...']`、qq `notifyGroups`、feishu `oc_*`、dsh-im `kind:'group'` 下，审批/提问/动作/普通通知的 `notifyTargets()` 不含群目标且 `send` 无群记录。（修复 J-1/B-3/A-2）
3. **旧卡缺来源 fail-closed**：铸卡不带 `srcChat`/`srcChats`/`origin.chatId` → 从任意会话点击一律拒绝、handler 零执行、账本零写、不回退桌面放行。（修复 L-1/C-1）
4. **跨账号 owner 回退拒绝**：owner 绑定账号 A，投放账号 B 的 hint/onChannel 编号回复 → 拒绝；复用 `feishu-p2p-source.test.mjs` rig。（修复 D2）
5. **群事件不得进入对话投递**：`chatType:'group'` 的同一信封在真实 bus 被拒、不进 conversation；把 K-2 的 `grp-1` 改为中性 chatId。（修复 K-2/B-1/B-2 命名误导）
6. **有界语义一致性**：`Infinity`/字符串 cap 在 `bounded` 与其他有界组件（ledger/队列）行为统一（拒绝或钳到默认上限），并断言淘汰策略（保留最新）。（修复 I-11）
7. **收紧弱断言/删除重言式**：`pending-bounds-v0121.test.mjs:13`（`=== 512` + 保留最新）、`attachments-bounds-v0121.test.mjs:31`（精确截断条数/序）、`v015-stage-s3-http-sender.test.mjs:227`（关键 sender 类型集合快照，而非 `>=28`）、`v015-stage4-postrc-hardening.test.mjs:64`（已声明方法在合法入参下 `ok:true`）、**`mobile-task-loop-contract.test.mjs:24`（重言式：`assert.ok(key)` 对非空字符串恒真且不调用被测模块——改为真实断言或删除；见簇 N）**。
8. **单写者运行时证据**：以真实 store 写前后快照 diff，断言除 `current-task` 外无模块改 `bind:*` 键（替代/补强 I-1、I-6 的文本断言）。
9. **凭证传播面**：入站不新增 token 副本、unbind 撤回凭据、`status/export` 不含明文；YAML-only / env 引用 token 时部署行为。（修复 C-2 + 簇 E 缺口）
10. **原生路径不跟随重定向与 DNS 重绑定**已由 `urlguard`/`network-policy` 覆盖；建议再加「群/Topic 目标经 dsh-im sendChecked 的实际拒绝」端到端。
11. **消除空断言/条件断言/自足重言式**（簇 O）：`channel-fail-closed.test.mjs:103`（改调生产 `segmentText`/`splitByCodePoints` 断言 4096 边界）、`:71`（补 open_chat_id/user_id 缺字段拒绝）、`security-structure.test.mjs:88/106/131/153`（去掉 `if(...)`/`catch{}` 包裹，先断言前提成立再断言结论，`putChannel` 用 `assert.throws`）、`actions.test.mjs:83`（越 TTL 后断言 `reason==='expired'` 且不核销）。**门禁建议**：在 CI 增加「断言密度」静态守卫——若某 `test()` 体内不含任何 `assert.*`（或全在条件内），直接判失败，防止此类空过回归。

## 6. 距候选发布还缺什么（不计真实账号与真机验证）

- **必须修复的测试幻觉**（否则发布证据不成立）：A-1（dsh-im 桥假字段）、J-1（群目标出站）、L-1/C-1（旧卡兼容放行）、B-3（群文本放行）；以及簇 O 的空过断言 O-1（Telegram 4096 自足重言式）与 O-3~O-7（安全 masking / 不泄漏 / 审计有界 / 多渠道隔离 / 过期裁决实际未断言）。
- **必须补的行为/故障测试**：上节 1–5、9、11；以及 D2 跨账号回退。
- **口径与门禁缺口**：
  1. `npm test`（2447）**不含** `test/dom`（41+ 真实 React 用例），发布计数 `dshQuality.testCount=2447` 同样不含；须把 DOM 套件并入默认门禁或确保 CI 独立步骤**实际执行且失败即阻断**，否则真实 UI 覆盖在本地静默缺失。
  2. `host-compat-matrix` 只是**声明一致性**，零真实 Host 证据；发布口径必须标注，并把真机矩阵执行列为门禁（不计真机则该项在候选发布中**无法闭环**，只能标 `unknown`）。
  3. 群出站（J-1/B-1/B-2/B-3）、旧卡兼容（L-1/C-1）在源码里**仍是活跃路径**——测试修好后需同步改实现，否则新测试会红；这本身就是「距发布还差的功能收敛」。
  4. `advancedConsole` 能力名存续（I-7/I-15）需产品裁决是否随约束③退场。
- **可接受的健康姿态（无需改）**：所有 durability/并发/事务/有界/证据分级用例（簇 I 除 I-1/I-2/I-6/I-11 与弱断言外）质量高、方向 fail-closed，可作为回归基线保留。

## 7. unknown 清单（不得写成通过）

- dsh-im `0.2.x` 宿主真实提问能力（`timed/continued`）——测试自标 `verified:false`，仅声明未 fixture 验证。
- 兼容矩阵中 4 个 VERIFIED DSH 版本是否真被人工验证、覆盖哪些能力面——仓库内无证据。
- `advancedConsole` 应否随旧控制台退场——无测试裁决，待产品决定。
- `pending-bounds`/`attachments-bounds`/`senderTypes` 弱断言的**真实**上界正确性——当前断言不足以证明。
- **安全与过期语义的实际正确性**：`security-structure` 的 secret masking / 不泄漏 owner / 审计有界 / 多渠道隔离，以及 `actions` 的 token 过期裁决——现有断言在前提不成立时**空过**，故「已通过」**不等于**这些性质成立，属 `unknown`（须按簇 O 建议改写后才能判定）。
- `test/dom` 是否在目标环境 CI 中真实执行且失败即阻断——需查 CI 运行记录（本轮未核实）。
- npm 包是否排除 `.claude/ .codex/ .opencode/`——**已降级**：`package.json.files` 为正向白名单 → 按构造排除；仅未被**显式断言**（低风险，非 unknown）。
- 群出站/旧卡兼容路径是否已有书面退役时间点——`02-scope-inventory.md` WP07 有目标但代码未收敛，测试无反证。
- `B-4`/`channel-fail-closed` 之外，各渠道是否还有**未列出的**群正向路径——本轮为抽样，非穷举。

---

## 第 2 部分：外援一报告（Cloud / 公共运行面 / Native 边界，全文）

# dsh-notifier 测试审查结论

**审查固定版本：** `2542a3107e7d3795e6ba5b294a7a5b82052c3431`
**目标分支：** `dev`
**性质：** 只读审查，不修改仓库

审查范围仅包含：

- Cloud
- 公共运行面
- Native 边界
- 与 Native 截断 / 空态直接相关的 DOM 测试

---

## 结论

当前测试体系**不能作为该版本已经达到候选发布质量的充分证据**。

问题不在于测试数量少，而在于部分测试使用人为 fixture / mock 构造了理想环境，绕开了真实运行路径；还有少数测试已经把当前实现中的偶然行为或错误语义直接固化成了“正确行为”。

本轮最需要优先处理的有三组：

1. **Cloud YAML-only Telegram token 路径没有被现有测试真正覆盖。**
2. **`dsh-notifier/testing` fake 与真实 Public API 存在明确语义冲突。**
3. **Native fail-closed / 截断 / 空态测试尚未形成真实 Host → RPC → DOM 的完整证据链。**

---

## 1. Cloud：最高风险

### YAML-only token 路径目前是 unknown

`test/cloudflare-release.test.mjs` 的统一 `rig()` 把：

```js
yamlRows: new Map()
```

固定为空。

因此以下真实场景没有被 Cloud 主测试走过：

```text
YAML 中存在 telegram.botToken
channel:telegram:outbound 不存在
telegram:account 不存在
```

而 `src/cloudflare/deployment.mjs` 中存在值得高度警惕的路径：

```text
首次 token() 可以从 outboundConfig.raw('telegram') 读到 YAML token
→ deployment metadata 写入 secretReference
→ 后续 token() 改为只读取 secretReference 对应的 store row
→ YAML fallback 被跳过
```

所以 YAML-only 首次部署、重启恢复、lost-response recovery 都不能标“通过”。

### 凭证传播面被测试主动固化

当前一键部署测试明确要求：

```text
outbound.gatewayKey === BOT
inbound.gatewayKey === BOT
```

而实现还可能同时写入：

```text
channel:telegram:outbound.botToken
channel:telegram:outbound.gatewayKey
telegram:account.botToken
telegram:account.gatewayKey
```

这意味着一个 Bot Token 可能扩散到多个明文字段。

现有测试不是在限制传播面，而是在把其中一部分复制行为当成成功条件。

### unbind 没有证明秘密真正撤回

现有 unbind 测试主要检查：

- endpoint 恢复；
- Cloud 资源保留；
- 手工修改 endpoint 不被覆盖。

但没有完整检查：

- outbound `gatewayKey`；
- inbound `gatewayKey`；
- Cloud link 新写入的 `botToken`；
- YAML-only 场景下被复制进 canonical store 的 token；
- 原本不存在的 inbound/outbound row 是否恢复到原状态。

因此 **Cloud unbind 的凭证撤回语义仍是 unknown**。

---

## 2. Public API：存在已确认的测试幻觉

### FakeNotifier 与真实 Public API 直接冲突

真实 `src/public.mjs` 对以下分支返回：

```text
malformed     -> ok:false
disabled      -> ok:false
busy          -> ok:false
budget        -> ok:false
rate-limited  -> ok:false
```

但 `src/testing.mjs` / `test/public-testing-fake.test.mjs` 把这些失败或拒绝分支锁成：

```text
ok:true
```

这不是覆盖不足，而是**明确的契约冲突**。

后果是消费方可能在 fake 上写出：

```js
if (result.ok) {
  // 认为成功
}
```

测试全绿，但接入真实 notifier 后行为改变。

这是本轮最明确的测试幻觉之一。

### `flush()` 有三套不同语义

当前：

```text
runtime public facade -> { ok: true }
types/index.d.ts      -> Promise<void>
testing fake          -> undefined
```

与此同时：

`test/public-types.test.mjs` 的测试名声称：

```text
push/flush signatures match the runtime facade
```

但实际上只用正则检查 `.d.ts`，**根本没有比较 runtime**。

因此这个测试目前会制造“类型已经和运行时一致”的错误安全感。

---

## 3. Native：内部单测不错，但发布级证据还不够

### 截断测试使用生产上不可达的 synthetic rows

`test/native-boundary-contracts.test.mjs` 自己已经注明：

> 真投影只遍历固定渠道表，造不出超上限行。

随后测试人为构造：

```text
channel-0
channel-1
...
channel-N
```

再验证 `slice()` 和 `truncated=true`。

它能证明 read-model 的防御性截断逻辑存在，但不能证明：

- 真实 projection 会产生这种状态；
- RPC 会正确传递；
- Native UI 会向用户显示“已截断/还有更多”；
- 真正会增长的 pending 等列表有完整截断 UX。

因此不能把它作为“Native 截断已经完整验证”的证据。

### fail-closed 目前主要停留在内部 service

现有测试能证明：

```text
readModel = null
→ native.snapshot 返回 not-supported
```

这个方向是对的。

但还没有证明真实：

```text
DSH Host capability 缺失
→ assembly / ctx.inject
→ Native transport
→ RPC
→ 浏览器 UI
```

整条链最终仍然保持 fail-closed。

所以“真实 Host seam fail-closed”仍应标 `unknown`。

### DOM 没有测试“错误 ≠ 暂无数据”

现有 DOM 空态测试验证的是：

```text
RPC 成功
channels 存在
但 canNotify=false
→ 显示真正的 empty state
```

这是有效测试。

但本轮没有找到：

```text
native.snapshot -> ok:false
not-supported
storage-failed
transport failure
```

之后浏览器 UI 的测试。

因此目前不能证明 RPC/Host 错误不会被渲染成：

```text
暂无数据
请先添加渠道
当前没有通知渠道
```

这一项必须继续标 `unknown`。

---

## 4. Host 契约仍有 unknown

`native-questions.test.mjs`、`host-capability.test.mjs` 中大量使用手写：

```js
ctx.userQuestions = {
  ask() {},
  registerProvider() {}
}
```

并把它定义成 `provider-chain`。

另一些测试又模拟：

```text
user-questions/request waterfall
```

其中还有注释引用旧 `0.1.5-rc.x` 的真实形态，而当前项目声明支持的是 `0.1.7-alpha/rc` 系列。

本轮能确认当前 deepseek-harness 上游存在 `user-questions/request` waterfall，但没有把本项目声明支持的每个 0.1.7 版本逐一固定验证。

因此：

- `registerProvider` 是否属于正式支持 seam：**unknown**
- root fallback 是否仍是正式要求：**unknown**
- 当前 Host fake 是否精确反映支持版本：**unknown**

这部分不能靠现有 fake 自证。

---

## 5. Cloud recovery 测试的边界

现有 recovery 测试本身有价值，已经覆盖：

- verification failure；
- cancel；
- lost response；
- receipt write failure；
- restart sweep；
- apply failure；
- uncertain create。

但需要明确它们目前主要证明的是：

> 在测试 runner 给出预期 readback 时，本地恢复状态机不会 blind create。

它们并没有证明真实 Wrangler / Cloudflare 在这些故障下会返回同样的：

- endpoint；
- version；
- created_on；
- deployment ordering；
- 唯一资源识别信息。

另外完整 durable-step restart loop 实际主要跑的是 Bark，不是 Telegram。

所以 Telegram：

```text
secret origin × durable step × restart
```

仍然缺完整矩阵，尤其缺 YAML-only secret origin。

---

## 6. 建议候选发布前必须补齐的 Gate

### Gate 1 — Cloud secret / YAML 闭环

必须证明：

```text
YAML-only token 可以首次部署
YAML-only token 可以重启恢复
YAML-only token 不会因 secretReference 切换而丢失
link 不制造无约束 secret copy
unbind 能撤回 Cloud link 自己制造的凭证状态
```

### Gate 2 — Public API 单一契约

必须让：

```text
runtime
types
dsh-notifier/testing fake
```

对同一公共行为保持一致。

尤其：

```text
ok
skipped
failed
flush()
```

不能继续存在三套语义。

### Gate 3 — Native error / empty DOM 分离

至少新增成对测试：

```text
成功 + 空数据 -> 真 empty state

RPC/Host failure -> error / unavailable / retry state
且不得出现 empty-state 文案
```

### Gate 4 — 固定支持版本的真实 Host integration

不需要真实账号。

但应该安装项目声明支持的 DSH Host 版本，实际跑：

```text
plugin apply
service provide/inject
session/event
user-questions/request
Native Web mount
dispose
```

而不是只靠自制 ctx。

### Gate 5 — Provider contract 层

无需真实 Cloudflare 账号也可以补：

```text
真实 Wrangler 固定版本结构化输出测试
真实 cloudflared local process smoke
fresh-process + persistent state recovery
```

---

## 7. 最高风险排序

### 1. Cloud YAML-only token

fixture 完全绕过，而且源码静态路径已经出现 token fallback 被 `secretReference` 截断的高风险逻辑。

### 2. FakeNotifier

明确把真实 `ok:false` 固化成 fake 的 `ok:true`，会误导第三方 consumer 单测。

### 3. Public `flush()` 契约

runtime / types / fake 三方互相不一致，但现有测试仍叫“match runtime”。

### 4. Cloud secret duplication / unbind

测试正在要求秘密复制，却没有证明解绑后秘密撤回。

### 5. Native error-vs-empty

service 层有 fail-closed，但浏览器层没有错误态防假空表证据。

### 6. Native truncation

当前主要是在 synthetic rows 上证明 `slice()`，不是完整生产数据链。

### 7. Host seam

大量 hand-written fake，尚未完全固定到当前声明支持的 DSH 0.1.7 契约。

---

## 8. 当前必须保持 unknown 的关键项

以下不能因为测试全绿而写“已验证”：

- YAML-only Telegram Cloud deploy
- YAML-only restart recovery
- YAML-only link/unbind secret cleanup
- Telegram 各 durable step recovery
- lost-response 下真实 Wrangler readback 能力
- 真实 Cloudflare deploy/recovery
- 真实 cloudflared 子进程行为
- `registerProvider` 在支持版本中的正式契约地位
- root-context fallback 的正式契约地位
- 真实 DSH Host 中 Native fail-closed
- Native RPC failure 后真实 DOM 状态
- Native 截断信息是否真的呈现给用户
- custom gateway 是否仍需要 token-in-URL 兼容
- provider accepted 是否等于终端展示
- 真实账号/provider/真机端到端行为

---

## 最终判断

固定提交 `2542a3107e7d3795e6ba5b294a7a5b82052c3431` 的测试基础已经比普通单元测试体系完整，尤其是 recovery state、fail-closed 意识、delivery truth 文案约束这些方向是对的。

但当前仍存在几处会直接误导发布判断的测试幻觉：

```text
Cloud fixture 绕过 YAML-only token
Public fake 与真实 API 语义相反
类型测试没有真正比较 runtime
Native synthetic truncation 被当成真实链路证据
内部 fail-closed 被放大成 Host/UI 端到端证据
```

因此即使全量测试显示全部通过，也**不能直接据此判断当前 commit 已达到候选发布标准**。

不计算真实账号、provider 和真机验证的前提下，优先补完：

```text
Cloud YAML/secret authority
Public runtime/types/fake parity
Native error-vs-empty DOM
固定 DSH 版本 Host seam
Wrangler/cloudflared 本地真实边界
```

完成这些后，再进入候选发布验证会更可靠。


---

## 第 3 部分：外援二报告（旧 Advanced Console / 源码 grep 自证，全文）

# dsh-notifier 独立测试与旧 Advanced Console 审查报告

> 审查对象：`THEWOLFWALKER/dsh-notifier`
> 固定 commit：`2542a3107e7d3795e6ba5b294a7a5b82052c3431`
> 分支：`dev`
> 审查方式：只读，不修改仓库

## 0. 总结

本轮核心结论：

1. **旧 Advanced Console 没有真正整套退出。**
   HTTP 日常路由基本退了；`src/admin/api.mjs` 的功能层仍保留大量旧能力；`src/admin/ui/markup.mjs` 已 Recovery-only，但 `src/admin/ui/client.mjs` 仍保留大量旧管理代码。

2. **不是单纯“测试忘了删”。**
   `src/index.mjs` 在 `admin.enabled` 时仍创建完整 `createAdminApi()`；Native channel projection 仍会通过 `adminApi.getChannels()` 读取入站行，因此存在生产耦合。

3. **private-only 已成为总准入规则，但还没有成为 provider 的一致边界。**
   QQ / Feishu 等测试中仍存在 `notifyGroups`、群目标学习、群 sendText、群动作降级等正向群聊契约。

4. **部分源码 grep/正则测试锁的是实现形状，不是真实行为。**
   尤其 `wiring.route.test.mjs`、`index.test.mjs`、`client-module.test.mjs` 中若干静态断言，合法重构时会误报。

---

## 1. 范围内测试盘点

### Advanced Console 范围

| 文件 | 测试点 |
|---|---:|
| `test/admin-api.test.mjs` | 51 |
| `test/admin-server.test.mjs` | 26 |
| `test/admin-events.test.mjs` | 9 |
| `test/admin-members.test.mjs` | 16 |
| `test/admin-questions.test.mjs` | 8 |
| `test/admin-scan.test.mjs` | 30 |
| `test/admin-wiring.test.mjs` | 25 |
| `test/admin-origin.test.mjs` | 7 |
| `test/admin-ui-behavior.test.mjs` | 23 |
| `test/admin-ui-i18n.test.mjs` | 5 |
| `test/admin.expose-tasks-host.test.mjs` | 6 |

合计：**206 个测试点**。

### 源码 grep / 结构自证范围

| 文件 | 测试点 |
|---|---:|
| `test/host-seam-audit.test.mjs` | 12 |
| `test/security-structure.test.mjs` | 13 |
| `test/issue38-host-compat.test.mjs` | 6 |
| `test/user-copy-lint.test.mjs` | 4 |
| `test/wiring.route.test.mjs` | 23 |
| `test/package-payload.test.mjs` | 3 |
| `test/plugins-docs.test.mjs` | 8 |
| `test/contract.spec.mjs` | 2 个静态入口，另有 fixture 参数化 |
| `test/client-module.test.mjs` | 9 |
| `test/index.test.mjs` | 17 |
| `test/redact.test.mjs` | 7 |

固定测试入口合计：**104 个**，另有 `contract.spec.mjs` 的渠道 fixture 参数化。

### 交叉验证范围

重点审查：

- `test/actions.test.mjs`：29
- `test/v015-private-admission.test.mjs`
- `test/inbound.*.test.mjs`
- `test/dom/*`

provider 静态测试入口至少包括：

- DingTalk：46
- Feishu：52
- inbound.message：18
- QQ：49
- Telegram：46
- WeChat：37
- WxPusher：24

DOM 重点文件：

- assembly smoke：2
- workerd：3
- Native release：9
- S2 shell：6
- S3 account：8
- S4 private/pending：8
- S5 more：5

---

## 2. 可疑测试清单

### B1 — P0：legacy 老卡无来源元数据仍显式兼容放行

**文件：** `test/actions.test.mjs:289`
**测试名：** `F-08 dispatch：legacy 老卡（无来源元数据）→ 显式 warn + 兼容放行`

实际断言：没有 `srcChats` 的 action，即使从未绑定 `chatId` 点击，也要求 `result.ok === true` 且 handler 被执行。

预期来源：**旧兼容逻辑 / 当前实现**。

风险：与“不为旧版本保持兼容”直接冲突，并把缺来源安全元数据固化为可执行状态。

建议：**删除或改写**。缺来源元数据应 fail-closed。

---

### B2 — P0：10 分钟升级宽限窗仍维护旧卡兼容

**文件：** `test/actions.test.mjs:322`
相关：`:349`、`:360`、`:433`

测试要求缺 `srcChats` 的旧 action 在 10 分钟内继续放行；`srcChats:null` 同样窗内放行；`markSource` 落账失败后也可短时继续执行。

预期来源：**旧版本升级兼容**。

风险：产品既然不再维护旧版本兼容，这个宽限窗已失去产品依据，而且会把 durable metadata 写失败变成短时安全旁路。

建议：**删除宽限兼容契约**。

---

### B3 — P0：Feishu 群聊 sendText 仍被当正式能力

**文件：** `test/inbound.feishu.test.mjs:625`
**测试名：** `sendText：oc_ 前缀走 chat_id 接收类型（群聊回执）；ou_ 走 open_id`

实际断言：`sendText('oc_group', ...)` 必须成功并走 `chat_id`。

预期来源：**旧 provider 能力 / 当前实现**。

风险：直接违反 private-only 产品约束。

建议：群目标应拒绝，不调用 provider send API。

---

### B4 — P0：Feishu 群动作卡仍允许降级为普通群文本

**文件：** `test/inbound.feishu.test.mjs:1153`
**测试名：** `Stage-6 群聊敏感控制降级：审批不发群消息，动作通知仍可纯文本`

风险：这代表“关闭群控制，但保留群功能”的半退出状态。

建议：群目标统一 unsupported / fail-closed。

---

### B5 — P0：QQ `notifyGroups` 仍被维护为正式配置能力

**文件：** `test/inbound.qq.test.mjs:1082`

实际断言：`notifyTargets()` 同时返回用户与群目标。

风险：这已经不是“识别群事件用于拒绝”，而是在主动构建群发送能力。

建议：删除 `notifyGroups` 正向契约。

---

### B6 — P0：QQ 群目标学习与群发送路由仍被测试锁定

**文件：** `test/inbound.qq.test.mjs:930` 及后续 targetKinds/LRU 测试

实际断言：收到群事件后学习群目标，后续调用 `/v2/groups/<id>/messages`。

风险：保留的是完整群发送子系统。

建议：群事件只保留最小解析用于识别和拒绝。

---

### B7 — P0：Telegram provider 测试用 stub bus 绕过真实准入

**文件：** `test/inbound.telegram.test.mjs:579`

`makeBus()` 的 `accept()` 永远返回 `{ok:true}`，群 `supergroup` envelope 因此被测试当作成功输入。

风险：provider 测试绕过 canonical private admission，把群 envelope fanout 固化成契约。

建议：使用真实 `createInboundBus()`；若只测 mention parser，则直接测试纯 parser。

---

### B8 — P0：Feishu 核心 fixture 像群聊却因缺 `chat_type` 被成功 fanout

**文件：** `test/inbound.feishu.test.mjs:258`

fixture 使用：

```text
chat_id = oc_group
```

却未给出 `chat_type:'group'`，随后断言消息成功进入 accepted。

风险：当前非 QQ 的 `chatScopeOf()` 对未知/空 chatType 默认视为 private，这可能把 provider 漏字段固化成放行行为。

建议：私聊 fixture 明确 `p2p`；群 fixture 明确 `group` 并断言拒绝；缺失 chat type 建议 fail-closed。

---

### B9 — P1：`admin-api.test.mjs` 51 个测试继续维护已撤销日常功能面

涉及：

- overview
- bindings
- sessions
- channels
- test/scan
- audit

但 `admin-server.test.mjs` 已经要求旧日常 HTTP 路由全部 404。

风险：函数层僵尸能力被测试误塑成长期契约。

重要修正：不能说所有方法都完全无生产调用。已确认 `getChannels()` 仍被 `src/control-surface/channels.mjs` 通过 `adminApi` 使用。

结论：**多数旧 API 已无 HTTP 产品入口，但整个 Admin API 尚未脱离生产装配。**

---

### B10 — P1：tasks / host 方法无 HTTP 入口，却继续作为 Admin API 能力测试

**文件：** `test/admin.expose-tasks-host.test.mjs`

同一文件一边维护 `getTasks()` / `getHostCapabilities()`，一边又明确 `/api/tasks` 与 `/api/host` 已从 Recovery 路由删除。

建议：若这些能力仍有价值，应迁入 canonical service/projection 测试，而不是继续归属 Admin API。

---

### B11 — P1：Admin UI client 仍保留旧日常 Console 脚本

`src/admin/ui/markup.mjs` 已经只剩 diagnostics。

但 `src/admin/ui/client.mjs` 仍保留约 1800 行代码，包括：

- overview
- channels save/test/delete
- questions
- bindings
- sessions
- scan
- pairing
- members
- SSE notifications
- first-run setup
- `/api/events`
- `/api/channels`
- `/api/bindings`
- `/api/sessions`
- `/api/members`
- `/api/questions`
- `/api/scan/*`

结论：UI 只是**骨架退出**，浏览器端实现没有整套退出。

---

### B12 — P1：Admin event hub 仍在生产装配，但 `/api/events` 已删除

`src/index.mjs` 仍创建：

```js
const eventHub = adminEnabled ? createEventHub() : null
```

并继续 publish `onSend`。

但 Recovery server 已删除 `/api/events`。

结论：存在无消费者的旧生产路径。

---

### B13 — P1：Admin scan handlers 仍在 production 创建

`src/index.mjs` 在 Admin enabled 时仍创建 `createScanHandlers()` 并注入完整 Admin API。

但 `/api/scan/:type` 已被要求 404。

结论：scan 旧能力仍未从生产装配退场。

---

### B14 — P1：`admin.enabled` 仍影响非 Recovery 运行时行为

`test/admin-wiring.test.mjs` 明确维护：

- admin enabled 时 store account overlay；
- admin enabled 时 store account 构成 inbound enable signal；
- admin disabled 时语义不同。

风险：Recovery 开关正在改变真实渠道配置/启动语义。

若 Advanced Console 只剩 Recovery，这种耦合不应继续存在。

---

### B15 — P1：`wiring.route.test.mjs` 用源码正则证明 identity 注入

测试读取 `src/index.mjs`，要求 `registerApprovalHandler({ ... })` 和 `createQuestionBridge({ ... })` 的源码片段必须出现 `identity,`。

需求本身正确，但测试的是**写法**。

合法重构成：

```js
identity: identityService
```

或 deps object 都会假红。

建议：改为真实 `apply()` 装配行为测试。

---

### B16 — P1：`index.test.mjs` 直接锁 `agent.cancel({kind:'user'})` 源码文本

需求来自上游 structured `AgentCancelCause`，方向正确。

但通过正则搜索源码不能证明真实调用。

建议：注入 fake agent，触发真实 remote cancel，断言实际参数为 `{kind:'user'}`。

---

### B17 — P2：`client-module.test.mjs` 混合真实安全护栏与实现形状锁

高价值：

- 不出现 Bearer；
- 不保留旧 RPC；
- Native snapshot/channel 是日常读取入口。

可疑：

- 具体 RPC 字面量；
- `class ErrorBoundary extends Component`；
- 某些类名和实现文字必须存在。

建议：保留行为/安全断言，删除类名和源码结构依赖。

---

### B18 — P2：`user-copy-lint.test.mjs` 虽读文本，但属于有效产品护栏

它验证用户可见文案不暴露内部术语。

**建议保留。**

---

### B19 — P2：`package-payload.test.mjs` 属于发布产物契约

它验证：

- npm allowlist；
- 链接可解析；
- 内部执行材料不进入发布包。

**建议保留。**

---

### B20 — P2：`plugins-docs.test.mjs` 多数属于文档同步护栏

整体可保留。

但硬编码具体版本字符串等内容不应反向阻止合法版本演进。

---

### B21 — P2：`host-seam-audit.test.mjs` 混合正式契约和当前 carrier 决策

有效部分：

- seam matrix 与支持 host range 一致；
- fallback 行为；
- attachments fail-closed；
- service 缺失不伪报可用。

可疑部分：

- 把 `connection.fetch.register` 永久固定为“不采用”。

这只能代表当前支持版本的决策，不能当未来产品契约。

---

## 3. 最高风险测试幻觉

1. **Feishu 缺 chat_type 的 `oc_group` fixture 被成功 fanout**
   最容易产生“测试绿但群聊准入仍有洞”的假安全感。

2. **legacy action 无 srcChats 仍允许执行**
   缺安全来源元数据却继续放行。

3. **10 分钟 legacy action 宽限窗**
   维护已经明确不需要的旧版本兼容。

4. **Telegram 群 envelope 通过 stub bus 成功消费**
   绕过 canonical admission。

5. **Feishu 群 sendText / action text fallback**
   正面维护群聊输出能力。

6. **QQ notifyGroups + group target learning**
   保留完整群发送架构。

7. **Admin API 51 测试继续维护撤销产品面**
   会制造大量“僵尸回归”。

8. **源码正则锁 identity 接线**
   测的是写法，不是权限行为。

9. **structured cancel 源码 grep**
   上游契约正确，但验证方式不正确。

---

## 4. 建议新增的真实行为 / 故障测试

### 4.1 Advanced Console 真退出测试

`admin.enabled=true` 时，除 Recovery 所需能力外，应验证：

- 不构造 eventHub；
- 不构造旧 daily scan handlers；
- 不构造旧 daily Admin API；
- 不注册旧 routes；
- 不存在 bindings/sessions/members/questions daily handler；
- Recovery enabled 不改变 channel overlay 或 inbound enable signal。

### 4.2 Native 与 Admin API 解耦

Native channel projection 在没有 Admin API 的情况下仍应：

- 列出 inbound channel；
- 正确读取 configured/active/fields；
- 支持 Native channel details。

### 4.3 所有 provider 的 private-only 合同测试

对 6 个 inbound provider 使用真实 `createInboundBus()`。

私聊：

```text
provider event
→ normalize
→ admission
→ exactly one downstream delivery
```

群聊：

```text
provider group event
→ recognize
→ admission rejects
→ zero downstream delivery
→ zero identity mutation
→ zero approval/question/action execution
```

### 4.4 缺失 chat type 故障测试

尤其 Feishu：

```text
chat_id = oc_xxx
chat_type missing
```

private-only 产品建议 fail-closed。

### 4.5 Group output fail-closed

对 QQ / Feishu / Telegram 等群目标：

- sendText
- sendApprovalCard
- sendActionCard
- sendQuestionCard

都不得调用 provider send API，也不得产生 delivery evidence。

### 4.6 Action source metadata durable failure

模拟：

```text
mint succeeds
markSource persistence fails
```

断言 card 不进入 executable 状态，handler 永不执行。

### 4.7 真实 identity 装配测试

通过 `apply()` 完整装配：

- owner 原 channel/account/user 可结算；
- 相同 userId 不同 channel 不可；
- 相同 userId 不同 account 不可；
- 非 owner 不可。

### 4.8 structured cancel 行为测试

fake agent 收集 `cancel(cause)` 的实际参数，真实触发 remote stop，并断言：

```js
{ kind: 'user' }
```

### 4.9 Recovery UI 死代码测试

Recovery 页面加载后应只发生：

```text
GET /api/diagnostics
```

并且不启动 `/api/events`，不保留旧 daily controller。

---

## 5. 不计真实账号与真机验证时，距离候选发布还缺什么

### 5.1 真正完成 Advanced Console 退役

当前完成：

```text
HTTP route removal
+
markup Recovery-only
```

尚未完成：

```text
旧 API 功能层移除
旧 browser client 移除
旧 event hub 移除
旧 scan wiring 移除
admin.enabled 与 runtime config 解耦
Native 与 admin API 解耦
```

### 5.2 删除群聊正向产品契约

需要清理：

- `notifyGroups`
- group sendText
- group action fallback
- group target learning
- group notification target
- Telegram group normalization 正向测试
- Feishu group output
- 其他 provider 同类群能力

保留的群逻辑只应服务于：

```text
识别 → 拒绝
```

### 5.3 删除 legacy compatibility allowance

包括：

- 无 srcChats 放行；
- 10 分钟宽限；
- null 宽限；
- markSource 失败后的兼容。

### 5.4 把高风险源码 grep 改成行为测试

至少包括：

- identity wiring；
- cancel cause；
- client RPC surface 的部分静态形状。

### 5.5 增强 provider → canonical admission 集成测试

当前很多 provider 测试只证明 adapter 构造了什么 envelope，不能证明真实产品是否允许其进入 agent/control。

### 5.6 清理旧产品语义

测试名和注释仍大量出现：

- compatibility
- old behavior unchanged
- Advanced Console 共用
- 群聊降级
- 管理台日常能力

这些会继续向后续维护者传递错误产品模型。

---

## 6. Unknown 项

### UNKNOWN-1

`src/admin/api.mjs` 中每一个旧方法是否都有隐藏生产调用者。

已确认 `getChannels()` 有生产依赖；其余多数未发现正常 `src/` 调用，但本轮没有完整 AST call graph。

### UNKNOWN-2

`src/admin/ui/client.mjs` 的旧死代码是否经过最终构建过程被其他机制裁剪。

源码组合路径显示它仍会被内联，但本轮未以真实浏览器请求测最终传输字节。

### UNKNOWN-3

Feishu 官方事件是否保证 `message.chat_type` 永远存在。

不能从当前实现反推。

### UNKNOWN-4

QQ `notifyGroups` 是否有现实存量用户。

即使存在，也不能覆盖当前“private-only”产品约束。

### UNKNOWN-5

旧 Admin scan 流程是否存在其他间接生产调用。

本轮未构建完整动态 call graph。

### UNKNOWN-6

`connection.fetch.register` 在未来 DSH 版本是否会成为正式推荐 carrier。

当前测试只能代表当前支持版本的决策。

### UNKNOWN-7

provider mock 与真实平台行为的一致性。

尤其 QQ 按钮、Feishu card、DingTalk gateway、Telegram callback 等均不能由 mock 证明。

### UNKNOWN-8

当前固定 commit 的全量测试是否实际全部通过。

本轮是只读审查，不能把“存在测试”写成“已经运行通过”。

---

## 7. 最终判定

### Advanced Console

**没有整套退出。**

当前状态：

```text
HTTP 日常路由：已退出
UI markup：已退出
UI client implementation：未退出
Admin API 功能层：未退出
生产装配：部分未退出
Native → Admin API 依赖：仍存在
admin.enabled → runtime 行为耦合：仍存在
```

因此不是：

> 旧 Console 已经彻底退出，只是测试忘了删。

而是：

> **旧 Console 的外部页面入口已经退役，但内部实现和生产耦合仍在，测试又继续把其中大量能力维护成契约。**

### 源码自证测试

应保留：

- package payload；
- docs parity；
- user copy lint；
- secret/redaction；
- public artifact 结构；
- 正式 protocol fixture。

应改写：

- wiring 注入源码正则；
- cancel cause 源码正则；
- client 类名/RPC 实现形状；
- “某方法必须这样写”的静态守卫。

原则：

> **测行为、故障和公开契约，不测实现文字。**

### Private-only

总准入层方向正确，但 provider 侧仍存在明显群聊正向能力残留。

所以当前更准确的状态是：

> **private-only 已成为核心准入规则，但还没有成为全代码库的一致产品边界。**

---

## 8. 建议处理顺序

1. 删除 action legacy 放行与宽限测试；
2. 修 Feishu 缺 chat_type / group fixture；
3. 删除 provider 群聊正向契约；
4. 解耦 Native channel projection 与 Admin API；
5. 拆除 `createAdminApi()` 的 daily 能力；
6. 删除 Admin UI client 死代码；
7. 删除 eventHub / scan 等旧 production wiring；
8. 让 `admin.enabled` 不再改变 runtime 配置语义；
9. 删除对应僵尸测试；
10. 把源码 grep 守卫改成 assembly 行为测试。

---

## 一句话结论

**这个 commit 已经把 Advanced Console 的“门面”关掉了，但屋子里的旧机器大半还通着电；测试又在持续替这些旧机器做保养。真正达到 v0.15 的产品约束前，需要把功能层、装配层、客户端死代码、群聊正向契约和 legacy compatibility 一起清掉。**


---

## 附录 A：三路交叉索引（仅罗列事实，不作裁定）

### A1. 两路及以上独立记录的共同发现（可视为较强证据）

| 主题 | 主审查员（第 1 部分） | 外援一（第 2 部分） | 外援二（第 3 部分） |
|---|---|---|---|
| 旧卡缺来源元数据仍兼容放行 | L-1 / C-1：`actions.test.mjs:289`、飞书 ac/aq、TG ac/ap 共 5 处 | — | B1 / B2：`actions.test.mjs:289`、`:322` 的 10 分钟宽限窗 |
| 群聊正向能力残留（QQ `notifyGroups` / 群 `sendText` / 群动作降级 / 群目标学习） | B-1/B-2/B-3、J-1、A-2 | — | B3/B4/B5/B6/B7/B8 |
| Feishu 群目标 `oc_` 被放行 | B-2（`inbound.feishu.test.mjs:258`）、B-3（`:1153`） | — | B3（`:625`）、B8（`:258`）、B4（`:1153`） |
| 群目标进入出站通知目标 | J-1（`target-guard.test.mjs:128/148/207`；`inbound.qq.test.mjs:1082`） | — | B5 |
| Telegram 群 envelope 经 stub bus 被当成功消费 | B-1（`inbound.telegram.test.mjs:579`） | — | B7（同文件同行） |
| 旧 Advanced Console 未整套退出 / Admin API 仍有生产耦合 | I-7/I-15（`advancedConsole` 能力名存续待产品裁决） | — | B9/B11/B12/B13/B14 + 第 7 节最终判定 |
| 源码 grep / 正则自证锁「写法」而非行为 | I-1/I-2/I-6、M（`inbound-log-command.test.mjs:295`） | — | B15/B16/B17 + 第 7 节「源码自证测试」 |
| 凭证传播面被测试钉成正常 | C-2（`cloudflare-release.test.mjs:159` 断言两向 gatewayKey 明文相等） | 第 1 节「凭证传播面被测试主动固化」 | — |
| `npm test` / 发布计数不含 DOM，真实 React 覆盖在本地静默缺失 | I-13（`run-tests.mjs:16` 跳过 `test/dom`；`dshQuality.testCount=2447`） | 第 3 节（Native 相关 DOM 证据不足） | 第 1 节交叉范围列 DOM 文件 |
| Native 截断 / 空态缺真实 Host→RPC→DOM 证据链 | I-13、簇 N（`native-boundary-contracts.test.mjs` 属内部契约，且用生产不可达的 synthetic rows） | 第 3 节（fail-closed 止于内部 service；DOM 未测「错误≠暂无数据」） | — |

### A2. 仅一路记录（尚未互相印证，需复核）

- **外援一独有**：
  - Cloud YAML-only token 未被 Cloud 主测试覆盖（`test/cloudflare-release.test.mjs` 的 `rig()` 把 `yamlRows` 固定为空 Map）；`src/cloudflare/deployment.mjs` 存在「首次 `token()` 读 YAML → 写 secretReference → 后续只读 secretReference，跳过 YAML fallback」的静态路径。
  - `src/testing.mjs` / `test/public-testing-fake.test.mjs` 把 real `public.mjs` 的 `ok:false`（malformed/disabled/busy/budget/rate-limited）锁成 fake 的 `ok:true`——明确契约冲突。
  - `flush()` 三套语义：runtime facade `{ok:true}` / `types/index.d.ts` `Promise<void>` / testing fake `undefined`；而 `test/public-types.test.mjs` 仅正则检查 `.d.ts`，**未比较 runtime**。
  - Cloud unbind 未证明秘密真正撤回；recovery 测试主要证明「本地恢复状态机不 blind create」，未证明真实 Wrangler readback；完整 durable-step restart 主要跑 Bark 而非 Telegram。
  - Host seam：`registerProvider` 是否属于正式支持 seam、root fallback 是否仍是正式要求——均 unknown（fake 自证）。
- **外援二独有**：
  - `src/admin/api.mjs` 功能层仍保留大量旧能力；`src/admin/ui/client.mjs` 仍保留约 1800 行旧日常 Console 脚本（markup 已 Recovery-only）。
  - `src/index.mjs` 在 `admin.enabled` 时仍创建完整 `createAdminApi()`；Native channel projection 仍经 `adminApi.getChannels()` 读入站行（生产耦合）；eventHub、scan handlers 仍在生产装配，而对应 HTTP 路由已删。
  - `admin.enabled` 仍影响非 Recovery 运行时行为（store account overlay、inbound enable signal）。
- **主审查员独有**：
  - **A-1**：dsh-im 桥 mock 伪造顶层 `accountFingerprint`，与上游 `PROACTIVE_DELIVERY.md:362` / `delivery-service.mjs:311-313,340-343` 的 `account.fingerprint` 不符（真实 Host 上 checked 投递静默失效）。
  - **A-2**：fixture 使用虚构 `kind:'private'`（上游合法 kind 为按渠道枚举，无 `private`）；桥无「目标必须私聊」校验。
  - **A-3**：digest 口径与上游不完全一致（桥递归排序 vs 上游仅顶层排序 + 规范化 route）。
  - **O-1**：`channel-fail-closed.test.mjs:103` Telegram 4096 边界为自足重言式（不调用任何生产切分函数）。
  - **O-2~O-6**：`channel-fail-closed.test.mjs:71` 命名不副实；`security-structure.test.mjs:88/106/131/153` 四处条件/空断言。
  - **O-7**：`actions.test.mjs:83` 过期裁决为裸重言式（`ok===true||ok===false`）。
  - **I-11**：`bounded.test.mjs:157` 把 `cap=Infinity` 固化为「永不淘汰」，与 `ledger-numeric-and-io-v0121.test.mjs:81` 要求的「`Infinity` 必须有界」姿态相反。
  - **D2**：`approval/router.mjs`、`questions/router.mjs` 的 owner 代决回退只看 `channel+userId`、不比较 `accountId`；无测试守护（`feishu-p2p-source.test.mjs:328 #10` 只覆盖 exact 路径）。
  - **K-2**：`conversation.route.test.mjs:539` 的 `grp-1` 为伪群（无 `chatType`），命名会掩盖真实群路径。

### A3. 三源提及、但结论依赖未公开设计的取舍点（需产品方复核）

- 旧 Advanced Console 应退到何种程度（HTTP 路由 / UI markup / UI client 实现 / Admin API 功能层 / 生产装配 / `advancedConsole` 能力名）。
- 群出站与旧卡兼容是否有书面退役时间点（`02-scope-inventory.md` WP07 有目标，代码未收敛）。
- `connection.fetch.register` 在未来 DSH 版本是否会成为正式 carrier（当前测试仅代表当前支持版本的决策）。
- 本项目声明支持的 DSH 版本（0.1.7-alpha/rc 系列）的 Host seam（`registerProvider`、root-context fallback）正式地位。
- Feishu 官方事件是否保证 `message.chat_type` 永远存在（不能从当前实现反推）。

---

## 附录 B：合并 unknown 清单（不得写成「通过」）

**主审查员（第 1 部分）**

- dsh-im `0.2.x` 宿主真实提问能力（`timed/continued`）——测试自标 `verified:false`。
- 兼容矩阵中 4 个 VERIFIED DSH 版本是否真被人工验证、覆盖哪些能力面。
- `advancedConsole` 应否随旧控制台退场——无测试裁决。
- `pending-bounds` / `attachments-bounds` / `senderTypes` 弱断言的「真实」上界正确性。
- `security-structure` 的 secret masking / 不泄漏 owner / 审计有界 / 多渠道隔离，与 `actions` 的 token 过期裁决——现有断言在前提不成立时空过，属 unknown。
- `test/dom` 是否在目标环境 CI 中真实执行且失败即阻断。
- 群出站 / 旧卡兼容路径是否已有书面退役时间点。
- 各渠道是否还有未列出的群正向路径（本轮为抽样，非穷举）。

**外援一（第 2 部分）**

- YAML-only Telegram Cloud deploy / restart recovery / link·unbind secret cleanup。
- Telegram 各 durable step recovery（完整 durable-step restart 仅跑 Bark）。
- lost-response 下真实 Wrangler readback 能力；真实 Cloudflare deploy/recovery；真实 cloudflared 子进程行为。
- `registerProvider` 在支持版本中的正式契约地位；root-context fallback 的正式契约地位。
- 真实 DSH Host 中 Native fail-closed；Native RPC failure 后真实 DOM 状态；Native 截断信息是否真的呈现给用户。
- custom gateway 是否仍需要 token-in-URL 兼容；provider accepted 是否等于终端展示。
- 真实账号 / provider / 真机端到端行为。

**外援二（第 3 部分）**

- `src/admin/api.mjs` 每个旧方法是否都有隐藏生产调用者（已确认 `getChannels()` 有生产依赖；无完整 AST call graph）。
- `src/admin/ui/client.mjs` 旧死代码是否在最终构建被其他机制裁剪（未以真实浏览器请求测最终传输字节）。
- Feishu 官方事件是否保证 `message.chat_type` 永远存在。
- QQ `notifyGroups` 是否有现实存量用户（即使有也不能覆盖 private-only 约束）。
- 旧 Admin scan 流程是否存在其他间接生产调用。
- `connection.fetch.register` 在未来 DSH 版本是否会成为正式推荐 carrier。
- provider mock 与真实平台行为的一致性（QQ 按钮、Feishu card、DingTalk gateway、Telegram callback）。
- 当前固定 commit 的全量测试是否实际全部通过（只读审查，不能把「存在测试」写成「已运行通过」）。

---

## 附录 C：三源建议的处理顺序（合并且去重，仅罗列各方建议）

1. 删除 action legacy 放行与宽限测试，并同步把缺来源元数据改为 fail-closed。
2. 修 Feishu 缺 `chat_type` / group fixture；所有 provider 测试改用真实 `createInboundBus()`。
3. 删除 provider 群聊正向契约（`notifyGroups` / 群 `sendText` / 群动作降级 / 群目标学习）。
4. 群目标出站拒绝：审批 / 提问 / 动作 / 普通通知的 `notifyTargets()` 不含群目标，且 `send` 无群记录。
5. 修复 dsh-im 桥 mock 为上游真实形状（`account.fingerprint` + `version`），并补私聊准入。
6. 解耦 Native channel projection 与 Admin API；拆除 `createAdminApi()` daily 能力；删除 Admin UI client 死代码；删除 eventHub / scan 旧 wiring；让 `admin.enabled` 不再改变 runtime 配置语义。
7. 把源码 grep / 正则守卫（identity 注入、cancel cause、client RPC 形状）改成 assembly 行为测试。
8. 消除空断言 / 条件断言 / 自足重言式（`channel-fail-closed`、`security-structure`、`actions`、`mobile-task-loop-contract`）。
9. 补 Cloud YAML-only secret 闭环（首次部署 / 重启恢复 / link 不复制 / unbind 撤回）。
10. 统一 Public API 契约（runtime / types / fake 就 `ok` / `skipped` / `failed` / `flush()` 一致）。
11. Native error-vs-empty DOM 成对测试（成功+空数据→真 empty state；RPC/Host failure→error/unavailable，且不得出现空态文案）。
12. 固定支持版本的真实 Host integration（安装声明支持的 DSH 版本，实跑 apply / provide / session / user-questions / Native mount / dispose）。
13. 统一有界语义（`Infinity` / 字符串 cap）与淘汰策略断言。

---

## 附录 D：原始报告全文位置

三份报告的原始全文分别见本文件第 1、2、3 部分，未作改写。各审查员自述的「最高风险排序」「最终判定」保留在各自部分内。
