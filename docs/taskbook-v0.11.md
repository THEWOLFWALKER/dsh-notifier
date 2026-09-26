# dsh-notifier v0.11.0 规划输入（临时快照）

> **已归档（2026-09-25）**：v0.11.0 已收口并发布（1816 tests），本快照中的 W0/W1~W6 与宿主对齐项均已完成，W7/W8/W9/W10 顺延下一版。本文保留作历史规划记录，**不再是当前执行入口**；发行说明见 [CHANGELOG.md](../CHANGELOG.md)，规格见 [ROADMAP.md](ROADMAP.md)，当前事实见 [memory/project-state.md](memory/project-state.md)。

> 用途：供外部只读 agent 基于云端 dev 分支**重新规划** v0.11.0。本文件是临时输入，
> 规划完成后可删除或归档。不是执行规格的替代品——W1~W10 唯一规格在 `docs/ROADMAP.md`。
> 生成时间：2026-09-24 · 基准 commit：`9edaf41` · 测试基线：`npm test` 实测 **1663 全过 / 0 失败**。

## 1. 目标版本与总体结构

- 目标：**v0.11.0**（单一大版本，功能 = minor）。
- 组成：W0 善后（4 项 issue 修复，2 项已完成）+ 宿主 P0/P1/P2（细节待重新取证设计）+ ROADMAP W1~W10 + 发布收口。

## 2. 执行红线（任何工作项不得违反）

1. **零强制运行时依赖**：不新增 `dependencies`；`optionalDependencies` 仍可按需声明并 lazy-load；其余只用 Node 22+ 标准库与既有代码。
2. **公共面无 breaking**：`ctx.notifier.version` 锁 `0.7`；`push(message, options)` 签名、`sent` payload、`flush()` 语义不变；只做新增。
3. **接口铁律——禁止瞎猜**：宿主 API（cordis ctx、session.events、userQuestions、tools、agent 生命周期等）以官方仓库 https://github.com/deepseek-ai/deepseek-harness 对应版本的【实际源码】为准；渠道侧（QQ/飞书/钉钉等）以对应官方开放平台文档为准。每个设计/实现依据在 commit message 与设计书中引用「官方仓库 文件+符号」。拿不到证据标「待验证」，不得直接实现。**特别注意：DSH 0.1.2 起 `session.events` 已移除（issue #32），别按旧文档写。**
4. **双语**：新增手机/管理台文案进 `src/strings.mjs`，zh/en 键成对；禁机翻味/硬编码。
5. **fail-closed 默认**：新能力默认关闭或最小权限，需显式开启；未知来源/未配对身份一律拒绝；超时≠批准。
6. **分支纪律**（所有者指令覆盖 AGENTS.md/ROADMAP 旧说法）：**直接在 dev 分支小步提交，一个工作项一个 commit；禁止新建 codex/* 分支（该工作流已废弃）；禁止动 main 分支**。
7. **不顺手优化**：diff 不得含规格外改动；规格与现实冲突选不破红线的方案并在 commit message + CHANGELOG 写明取舍；无法两全写 HANDOFF.md「待裁决」继续下一项，禁止发明规格。

## 3. 现状（云端 dev 已包含）

- 上游已合：#28（turn/end 事件订阅 global scope）、#30（原生提问桥 waterfall，已关 #27/#29）、#34（wps-bot 出站渠道 27→28）、#35（QQ 长文本句末分段）。
- 本执行已合（commit）：
  - `c03b26c` — **W0 #31 入站 transport 有限超时**：QQ/钉钉所有 fetch（换 token、发文本/卡片、互动回执、开网关、业务 POST）注入 `AbortController + signal`，`config.timeoutMs` 缺省 10000ms；超时 AbortError 由调用方既有 catch 处理（token 失败进 token 管理器传播、发送失败 warn+降级），**不盲目重试**。飞书走官方 SDK（`@larksuiteoapi/node-sdk@1.73.0`），Client 构造级 request 超时字段未在公开类型面确认 → **未注入、标「待验证」**（登记 `docs/memory/risks.md`：SDK 无显式超时时长连接仍可能无限挂起，飞书侧残余）。
  - `9edaf41` — **W0 #32 turn/end 正文恒空修复**：`src/event-listener.mjs` 新增 `assistantTextOf(event)`（提取 assistant/message 的 text 块）+ `createAssistantTextCache(maxEntries=256)`（有界 Map，按 sessionId 存最近一次输出，超限淘汰最旧）；事件到达时沉淀缓存，turn/end 正文与心跳摘录从缓存取；**彻底移除对 session.events / snapshotEvents 的依赖**。
- CHANGELOG [Unreleased] 已含上述条目；新增测试 `test/inbound-transport-timeout.test.mjs`，更新 `test/event-listener.test.mjs`、`test/lang-strings.test.mjs`。
- 已知测试基线：**1663 全过 / 0 失败**。`package.json` 的 `dshQuality.testCount` 仍是旧值 1625，发布收口时按实测校准。

## 4. 待办 W0（未开始，顺序 #26 → #36 → #33）

### W0 #26 — QQ markdown+键盘按钮 label≤10 + permission 收敛

- **根因**：QQ 官方按钮 `render_data.label` 上限 **10 字符**（官方《发送单聊/群消息》文档，`docs/protocol-preflight/qq-bot.md` 已登记）；现 `src/inbound/qq-gw.mjs` 提问钮 `label: `${index+1}. ${label}`.slice(0, 40)` 超限，真机不渲染。
- **设计结论（已拍板）**：所有 QQ 按钮 label 按 Unicode 码点收敛到 ≤10（复用 `splitByCodePoints`，G-22 同根，不产生孤立代理项）；permission 结构收敛为统一工厂——单聊 `{ type: 2, specify_user_ids: [chatId] }`，群聊不产按钮；消除 sendApprovalCard / sendQuestionCard 三处散落写法。
- **改动面**：`src/inbound/qq-gw.mjs`（按钮构造）+ 对应测试（真机不渲染为 contract 证据，按既有 QQ C2C contract tests 口径）。
- **证据**：QQ 官方发送接口页 keyboard label ≤10；本项目 `docs/protocol-preflight/qq-bot.md`。

### W0 #36 — QQ 附件静默丢弃（attachments 白名单已登记但从未解析）

- **根因**：QQ C2C/GROUP 事件 `attachments` 字段在协议白名单（`docs/protocol-preflight/qq-bot.md` 事件体白名单）但从未解析；现状只解析 C2C `extra` 图片段（`parseQQImageMessage`），群消息图片/文件完全丢。
- **设计结论**：解析 `attachments`，按 `content_type` 判定 image 段透出为 image 信封；SSRF/下载防护沿用 v0.10 图片入会话既有口径（`normalizeImageAttachment` 静态 SSRF 拒绝 + `downloadInboundImage` 有界超时/大小/类型校验、不落盘、`redirect:'error'`）；非图片附件 fail-closed 丢弃并出声（不得静默）。C2C 与 GROUP 信封都接线。
- **改动面**：`src/inbound/message.mjs`（新增 QQ attachments 解析函数）、`src/inbound/qq-gw.mjs`（C2C+GROUP 信封接线）、消费面 `src/inbound/conversation.mjs` 已有 image 路径（`normalizeImageAttachment(envelope?.image)` + UserMessage image_url + 受控下载），对应测试。
- **证据**：QQ 官方 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 事件字段（attachments 结构）。

### W0 #33 — QQ 出站 markdown opt-in（已拍板：默认开启）

- **结论（所有者拍板「md 默认开启吧」）**：`src/adapters/qq-bot.mjs` 当前恒发 `msg_type: 0` 纯文本；改为**默认发 markdown**（`msg_type: 2` + `markdown.content`），提供配置开关可显式关闭（opt-out）。默认开启是所有者决策，优先于「新能力默认关」的 fail-closed 惯例——取舍必须在 commit message + CHANGELOG 写明。
- **注意**：msg_type 2 有 3000 码点上限（复用 `splitByCodePoints`）；QQ markdown 内容约束与既有 `qq-gw.mjs` postMarkdownWithKeyboard 同源。
- **改动面**：`src/adapters/qq-bot.mjs`（resolve 新增开关 + send 分流）、渠道配置校验/描述、对应测试。
- **证据**：QQ 官方《发送单聊/群消息》msg_type 0/2 与 markdown 说明。

## 5. 宿主工作项（主题已定、细节需重新取证设计）

> 上一轮执行的上下文丢失，以下四项仅有主题；**必须按接口铁律从 deepseek-harness 对应版本实际源码重新取证设计**（官方仓库 文件+符号），禁止照旧文档或猜测。拿不到证据就标「待验证」。

- **宿主 P0-A：UserMessage V4（source + image attachment）**——宿主会话输入消息结构升级，含 source 溯源与图片附件；证据方向：deepseek-harness `packages/core/session/src/types.ts` 等实际源码。
- **宿主 P0-B：agent.cancel 结构化 cause**——取消事件的 cause 结构化；证据方向同上。
- **宿主 P1：Qmsg 3.0 / SC3 endpoint / peer 兼容声明**——渠道侧（Qmsg 3.0、SC3 新 endpoint）+ 兼容性声明；证据方向：对应官方开放平台文档。
- **宿主 P2：ctx.root 收敛 / ask_user 文档口径**——宿主 ctx 面收敛与 ask_user 文档口径对齐；证据方向：deepseek-harness 源码 + 本项目 PLUGINS.md 公共面契约。

## 6. W1~W10（完整规格在 docs/ROADMAP.md，此处仅要点）

- W1 testing fake / W2 types / W3 consumer-demo / W4 PLUGINS.en.md：相互独立可并行。
- W5 `/sessions`、W6 `/log`（默认关）：同文件 `src/inbound/conversation.mjs`，先 W5 后 W6。
- W7 策略模板、W10 健康面板：同 `src/admin/`（api.mjs + ui/），注意串行或分文件。
- W8 `docs/reliability.md`、W9 `test/reliability-*.test.mjs`：W9 是**原位重命名**既有可靠性用例（移动而非复制，避免重复计数），迁移后全量通过数只允许来自新增用例；新增 script `test:reliability`。
- 建议顺序：W1→W2→W3→W4→W5→W6→W7→W9→W8→W10。

## 7. 发布收口（W0 + W1~W10 完成后，门禁缺一即停）

1. `package.json.version` → `0.11.0`；`dshQuality.testCount` → 实测全量通过数（当前基线 1663，会再涨）。
2. `CHANGELOG.md` 新增 `## [0.11.0]`，按工作项分条。
3. `src/admin/ui.mjs` 版本显示同步（verify-release 不变式）。
4. `README.md` / `README.zh-CN.md`：徽章测试数、能力段新增 `/sessions` `/log` 与「生态通知层」一句。
5. `HANDOFF.md` 发布线描述更新；`docs/memory/project-state.md` 同步；wps-bot 渠道数按实际校准（代码已是 28）。
6. 六门禁全过才允许 push：
   - `git status --short --branch` 干净
   - `npm test` 全绿
   - `npm run test:reliability`（W9 后才有此 script）
   - `npm run verify:release`
   - `node scripts/gen-channel-matrix.mjs --check`
   - `npm pack --dry-run --json`（payload 含 `types/`、`PLUGINS.en.md`；不含 `examples/`）
7. `git push origin dev`；`npm publish`、打 tag `v0.11.0`（不 retag）、`dev → main` 合并推送——这三步**等所有者回来执行**；若没拿到 NPM_TOKEN 或 GH token，只写后果进报告，不强行操作。
8. 熔断：任一门禁修三次不过 → 停，现场写入 HANDOFF.md「待裁决」，不强行推送。

## 8. 已登记接口证据

- **QQ**：`docs/protocol-preflight/qq-bot.md`——官方页面 URL + 摘录（access_token、WS 网关、msg_type 0/2/7、被动回复配额、keyboard label≤10、`msg_id+msg_seq` 去重、file_info TTL、撤回 2 分钟等）。
- **deepseek-harness**：`packages/core/session/src/types.ts`（`SessionEventMap['assistant/message']` surface 事件、data.message.content 块数组）；`session.events` getter 已移除（issue #32）。
- **飞书 SDK 超时**：待验证（`@larksuiteoapi/node-sdk@1.73.0` 公开类型面无 Client 级 timeout 字段，`timeout?` 仅存在于底层 per-request `HttpRequestOptions`）。
