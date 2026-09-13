# Workstream: docs-release-audit

- Agent identity: `Codex primary | GPT-5 | Windows desktop`
- Branch: `codex/issue16-host-events`
- Status: done (read-only audit; no runtime edits)
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: 对照当前源码、测试、Git 与公开 Issue/PR 状态，审计 README、架构、记忆、HANDOFF、CHANGELOG 及全部 workstream 的事实漂移。
- Owned files: `.agents/workstreams/docs-release-audit.md` only
- Do not touch: `src/`, `test/`, `package.json`, README/docs/memory/HANDOFF/CHANGELOG and other workstreams
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `gh issue list --repo THEWOLFWALKER/dsh-notifier --state all`; `gh pr list --repo THEWOLFWALKER/dsh-notifier --state all`
- Handoff: 本文件为审计报告；无代码提交。以下结论以 2026-08-26 当前工作树为准。

## 1. 可复现基线

| 项目 | 当前事实 | 文档常见旧值/问题 |
|---|---|---|
| Git | `HEAD=1fd2c17`，分支 `codex/issue16-host-events`；本地 `main=37f2ec7`，当前分支比 main 多 51 个提交 | `HANDOFF.md`、`docs/memory/project-state.md` 仍把 `codex/maintenance-architecture` 或 `codex/task-05-wechat-ilink` 写成当前线，且沿用旧快照日期 |
| 版本 | `package.json=0.8.6`，管理台标题 `v0.8.6` | 版本本身仍是已发布版本；当前分支已有未发布的 provider、QQ、图片、host-event 改动，不应被用户误认为已在 npm 0.8.6 中 |
| 测试 | `npm test`：1160 total，1159 pass，1 skipped（Windows 条件跳过） | README、`package.json.dshQuality`、HANDOFF、memory 仍以 909；维护 workstream 还写 1111/1140/1141/1151/1159。`verify-release` 通过是因为它校验已发布 v0.8.6 的 909，不代表当前树只有 909 |
| 渠道 | 生成矩阵检查通过，出站 27 个 | 27 本身正确；入站能力矩阵与 QQ 实现不一致（见下） |
| Release guard | `release guard ok: dsh-notifier v0.8.6, documented tests=909` | 应明确标注为“发布工件契约”，不要把它当作当前工程线测试数 |

## 2. 最高优先级事实漂移

### A. QQ 能力矩阵仍写成“无按钮”，但运行时代码已实现单聊按钮

- 运行时证据：`src/inbound/qq-gw.mjs:24,250,470,515-577` 已导入并调用 `parseQQImageMessage`，声明 `capabilities: { buttons: true }`，实现 `sendApprovalCard`/`sendQuestionCard` 和 `INTERACTION_CREATE`；群目标明确降级为文本。
- 过时文档/测试：`src/inbound/capability-matrix.mjs:153-159` 把 QQ 的 `buttons/approvalCard/questionCard` 全设为 false，并注释“批 5 未接线”；`test/inbound.capability-matrix.test.mjs` 同样断言“当前无按钮能力（批 6 前）”。`README.md:95`、`docs/architecture.md:78` 仍只描述 QQ 回复 `1/2` 或泛化为无按钮渠道。
- 精确修订建议：主管应先决定矩阵是否代表“当前实现”还是“已真机证明”。推荐保留证据层语义：QQ `buttons/approvalCard/questionCard=true`、证据字段另标 `contract-tested`、`real-device-verified=false`；群聊仍 `text-only`。同步矩阵注释、矩阵测试、双语 README、`docs/architecture.md`、`HANDOFF.md`、CHANGELOG 顶部条目。若暂不改变矩阵，则必须把 `qq-gw.mjs` 的实现回退或明确解释两套矩阵，不能继续让测试声称源码能力不存在。

### B. 图片已接线，仍有多处写“接口已发但未接线/只提取文本”

- 运行时证据：`src/inbound/qq-gw.mjs:24,250-259`、`src/inbound/dingtalk-stream.mjs:64,293`、`src/channels/wechat-ilink/index.mjs:64-68` 已把图片归一结果送入入站信封；能力矩阵 `src/inbound/capability-matrix.mjs:156,174,183` 已将 QQ/WeChat/DingTalk `imageInbound=true`。
- 过时条目：`docs/architecture.md:15` 仍写 QQ 图片解析“intentionally not wired”；`docs/memory/risks.md:5` 写“parseQQImageMessage…NOT wired”；`CHANGELOG.md:82-88` 的 MNT-5 条目写“全网不接线”、QQ 仅接口；`HANDOFF.md:29-31` 仍按旧 batch A+B+C/1012 叙述。
- 精确修订建议：不要删除历史记录；在 CHANGELOG 增加 2026-08-26 的 follow-up 条目，说明 QQ C2C、iLink item_list、DingTalk image URL 已接线且仅 contract-tested，媒体下载/真实字段/渲染仍未验证。将 architecture、risks、HANDOFF 的“未接线”改为“已接线、未 real-device-verified”，保留具体真实协议缺口。

### C. 测试数、版本和发布边界已分裂

- `README.md:16,205,213`、`README.zh-CN.md:16,205,213`、`package.json:28` 固定为 909；当前 npm test 是 1160。
- `HANDOFF.md:5,9,51,62,81,265` 和 `docs/memory/project-state.md:9,16,26-28` 同时出现 909、1111、1141、1104/1108 等互相覆盖的历史快照，并把旧分支写成当前分支。
- `docs/architecture-roadmap.md` 明确规划态，这一点正确；但当前实现已完成其“控制契约→WeChat/Feishu/Telegram provider groundwork”部分，文档没有“已落地切片/仍规划部分”的边界。
- 精确修订建议：发布负责人必须选择一个发布策略：
  1. 若不发版：`package.json.dshQuality.testCount=909` 可暂留以保护 v0.8.6 release guard，但双语 README、HANDOFF、memory 要改成“已发布 0.8.6=909；当前工程 HEAD=1160（1159+1 skip）”，并禁止 `npm test # 909` 这种误导命令注释。
  2. 若发版：在同一逻辑提交中 bump 版本、CHANGELOG、UI 标题、`dshQuality.testCount`、README、HANDOFF、memory，并重新跑 release guard/pack/registry gate。不要只改单一计数。

### D. HANDOFF 是旧快照拼接，当前状态和 PR #12 描述互相矛盾

- `HANDOFF.md:5` 仍称 2026-08-23 “v0.8.6 候选、registry 待核验”；`HANDOFF.md:8` 又称 npm v0.8.6 已发布；`HANDOFF.md:9` 说 QQ 按钮等待后续；`HANDOFF.md:12` 又说 QQ 按钮已接入；`HANDOFF.md:61-64` 仍以 `codex/maintenance-architecture`/909 为当前。
- `HANDOFF.md:29-35` 把 `crack-fix-batchA-v0.8.7` 写成在途未合并，但当前 Git HEAD 已包含后续 provider/QQ/image/host-event 提交；这段应迁为历史背景或删除。
- 精确修订建议：重写顶部快照（日期、HEAD、分支、main 基线、当前未发布改动、真实验证门）；将 PR #12 统一写为“私有线已模块化移植，公共 PR 仍 open/reference-only，QQ 真实协议/设备验证未完成”。删除所有“等待后续重写”与当前代码冲突的句子。

### E. CHANGELOG 顶部有重复 Unreleased，且历史条目被当作当前状态

- `CHANGELOG.md:3` 有英文 `## Unreleased`，`CHANGELOG.md:8` 又有 `## [Unreleased]`；应合并为一个标题。
- `CHANGELOG.md:82-88` 的 MNT-5 “全网不接线”已被 2026-08-26 图片接线取代；`CHANGELOG.md:153-154` 仍把 1012/909 说成当前分支事实。
- 当前顶部缺少 Issue #16 host-event 兼容性条目；最近提交 `cbb444f`/`1fd2c17` 已完成代码/契约工作，但明确没有 DSH 真机宿主验证。
- 精确修订建议：保留历史条目但加“当时状态/已由 follow-up superseded”措辞；新增 host-event、image wiring、QQ modular 的未发布条目；删除重复 heading；每个条目明确“contract-tested”与“real-device pending”。

## 3. 个人模式、群聊边界与 UX 文档

- `docs/architecture-roadmap.md:13-19` 的个人模式/群聊禁用是规划方向，不是当前所有 inbound 的运行时闸门。
- `test/session-arbiter.test.mjs` 证明 provider-neutral arbiter 的默认 `groupChatControl=false`，但 `HANDOFF.md:9` 已明确该 arbiter 尚未接入具体 IM；`src/index.mjs` 仍装配既有 `conversation`/六入站通道。
- QQ 运行时仍接收 `GROUP_AT_MESSAGE_CREATE`（`src/inbound/qq-gw.mjs:269-281`），群目标发送文本回执，且群目标禁止可操作按钮；这与“群聊控制完全禁用”不是同一语义。当前可安全表述应是：个人模式默认不开放敏感群聊控制；QQ 群 @消息仍可进入既有普通会话/文本回退路径，直到 arbiter 接线后再宣称统一禁用。
- `README.md:95,97`、`README.zh-CN.md:95,97` 和 `docs/guide.md:113-127` 把 QQ 一律写成回复 `1/2`，漏掉单聊按钮；`docs/guide.md:162` 只说明群消息需 @，没有说明群目标只文本回退、敏感控制不应在群聊使用。
- 精确修订建议：双语 README 与 guide 的能力表拆为“Telegram/Feishu 卡片；QQ 单聊按钮、旧客户端/群聊文本编号回退；WeChat/DingTalk/WxPusher 文本编号”。在 guide 加粗安全边界：“群聊仅普通消息/文本回退，不用于审批/提问等敏感操作”。路线图保留规划态，但增加“已实现 groundwork 与未接线 arbiter”的状态注释。

## 4. 真机/协议验证声明过度或过时

- 当前代码与本次验证没有可用 DSH 0.1.1-rc.2 宿主；`issue16-host-events.md:14` 正确写明未能关闭 Issue #16。README 的“session events auto-notify”应加“需兼容的 DSH host；本分支 contract-tested，Issue #16 real host pending”注记。
- `docs/guide.md:48` 仍写“出站，2 分钟”；Task 04 CHANGELOG 明确要求删除未经证明的“2 分钟”等承诺。应改为“按页面提示完成配置并测试发送”。
- `docs/guide.md:64,85,165` 使用“扫码那一刻就配对好了/微信不需要配对码/重扫即自动换绑”等确定性文案；实现确实在 `src/admin/scan.mjs:218-333` 尝试扫码即 `identity.addBinding`，但当前没有真实 iLink 端到端证据。建议改为“扫码成功后会尝试自动登记；若成员页仍显示待确认，手动确认或使用 `/pair`”，并记录真机门。
- `docs/test-notes/TG-TEST.md:1,14`、`WECHAT-TEST.md:1,13,88` 仍是 0.8.2/846/807 的内部测试包。它们应明确“历史测试包”，或由主管在真实重跑后更新版本/计数；不要让 HANDOFF 把它们当当前验证证据。
- `docs/memory/risks.md:5,26` 的总体风险方向正确（mock 不等于真机），但 QQ 图片“未接线”子句必须改为“已接线、真实 d.extra 形状仍未确认”；保留 QQ RESUME/ACK、Telegram clamp、Feishu `open_chat_id`、媒体 payload 等未验证项。

## 5. Issue/PR 状态对照（只读 `gh` 查询，2026-08-26）

公开仓库实际状态：开放 #16、#15、#14、#13、#10、#7、#6、#5、#4、#3、#2、#1；关闭 #11、#8；PR #12 open，PR #9 merged。

- `docs/KNOWLEDGE_BASE.md` 的公开快照与上述列表基本一致，是目前最可靠的状态表。
- `HANDOFF.md:27` 把 #1/#2/#4/#6 描述为“私有已修”，但它们在公共仓库仍 OPEN；应拆成“公共状态 OPEN / 私有树已有代码修复 / 是否已发布或真机验证”三列，不能用私有修复暗示 issue 已关闭。
- `.agents/workstreams/release-v0.8.6.md` 的“#1/#2/#4/#6/#11 already fixed in private main”是历史 release 记录，#11 已 CLOSED，但 #1/#2/#4/#6 仍公开 OPEN；补日期和“未自动关闭公共 issue”限定。
- Issue #10/#13/#14/#15/#16 均已有当前私有线代码/契约工作，但公开 issue 仍 OPEN，且 #14/#16 明确缺真机证据。所有 HANDOFF/CHANGELOG/workstream 应使用“code-level/contract-tested，未关闭/未 real-device-verified”，不要写“已解决”或“完成 issue”。
- PR #12 仍是公开 OPEN；当前私有实现不是 PR 合并事实。应写“私有线独立重写/移植，PR #12 仅 reference，未对公共 PR 做操作”。

## 6. Workstream 协作状态漂移

以下记录应由主管在不改历史细节的前提下补“已整合到当前线/历史快照”或更新验证数：

- `.agents/workstreams/maintenance-architecture.md`：仍以 `codex/maintenance-architecture`、1111 为当前，并写 batch 5 QQ 图片“不接线”；改为历史批次，指向当前 HEAD/1160。
- `.agents/workstreams/issue14-images.md`：验证数 1151，且报告停在图片刚接线前后；当前应为 1160，保留“真实字段/媒体下载未验证”。
- `.agents/workstreams/issue16-host-events.md`：验证数 1159；当前 1160。其“无 host、不可关闭 issue”判断正确，应保留并补当前 HEAD。
- `.agents/workstreams/task-04-admin-ux.md`：验证数 1140、`push pending`，但提交 `d9d2f6b` 已在当前祖先；改为已整合/历史验证。
- `.agents/workstreams/task-05-wechat-ilink.md`、`task-06-feishu-telegram.md`：分支名是旧 topic；加“已被 `codex/issue16-host-events` 包含”的 handoff 注记。
- `.agents/workstreams/control-core-step1.md`、`task-00-cc1-tests.md`：仍写 `no push/commit pending`，但提交已出现在当前 Git 历史；改为已整合，并保留 exact-chat/fail-closed 风险。
- `.agents/workstreams/maintenance-takeover-terra.md`：残余风险仍写“初始编号兜底用 notifier.channels、留待 Control Core”，但 CC-1 已将新证据收紧为 `hintTargets`；改为仅记录 legacy rows/缺逐目标 delivery evidence 的限制。
- `.agents/workstreams/pr12-modular-batch6.md`：状态格式不完整，`Validation` 仍是“must be recorded”；补实际 focused/full 验证、commit `017b0ce`、contract-tested/real-device pending。
- `.agents/workstreams/release-readiness-audit.md`、`relay-mirror-v085-fixes.md` 等早期记录可保留为历史，但应避免被索引为当前 baseline；特别是 891/909 计数不要复制到现状摘要。

## 7. 建议收尾顺序

1. 先重写 `HANDOFF.md` 顶部当前快照和 `docs/memory/project-state.md`，确立唯一当前分支/HEAD/测试数/发布边界。
2. 修正能力事实：QQ 单聊按钮、QQ/WeChat/DingTalk 图片已接线但仅 contract-tested；同步 capability matrix、双语 README、architecture、guide、risks。
3. 清理 CHANGELOG 双 `Unreleased` 和被 supersede 的“不接线”表述，补 Issue #16 host-event 条目。
4. 统一 issue/PR 状态为“公开状态”和“私有代码状态”双列，不自动暗示关闭。
5. 决定是否发版；若不发版，保留 `package.json.dshQuality.testCount=909` 但所有用户/工程文档必须明确 909 是 v0.8.6 发布契约、1160 是当前工程线；若发版则按版本守卫一次性同步全部 release metadata。
6. 最后更新 workstream 的历史/整合状态，并重新跑 `npm test`、release guard、矩阵检查、语法检查；真机门另列为未完成，不得由 mock 绿灯替代。

## 8. 已检查且未发现同类问题的文件

`AGENTS.md` 的硬边界与验证命令仍有效；`docs/memory/README.md`、`docs/memory/decisions.md` 的职责/安全决策未发现与源码直接冲突；`docs/architecture-roadmap.md` 明确写着 planning only，问题在于缺少已实现切片标注而非应改成“已发布”。`node scripts/gen-channel-matrix.mjs --check` 通过，27 渠道注册表与 README 矩阵一致。
