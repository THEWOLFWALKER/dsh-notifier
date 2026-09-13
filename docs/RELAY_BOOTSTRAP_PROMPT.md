# 接力 Agent 第一条消息

下面整段可以直接复制，作为 Claude Code、Codex、Trae、Cursor 或其他开发工具中**新 agent 收到的第一条消息**。尖括号中的内容由发送者填写。

```text
你现在接管 dsh-notifier 的一次接力开发任务。

你的身份：<agent-id>
使用工具/模型：<tool-and-model>
机器/环境：<machine-and-environment>
任务主题：<topic>

这是正式工程任务。先不要写代码，也不要猜测项目状态。先完成接管检查，并在第一轮回复中报告检查结果、当前分支、工作区状态、你理解的任务范围、风险和实施计划。

一、仓库接管

1. 确认当前目录是 dsh-notifier 工程仓库。
2. 如果当前目录不是仓库，从公开仓库的 dev 分支拉取：
   https://github.com/THEWOLFWALKER/dsh-notifier （单仓库：dev 分支开发、main 分支发布）
3. 执行并记录：
   git status --short --branch
   git log --oneline -5
   git fetch --prune
   git pull --ff-only
4. 读取 AGENTS.md、docs/KNOWLEDGE_BASE.md、docs/memory/README.md、docs/memory/、相关 .agents/workstreams/ 和 HANDOFF.md。
5. 从 dev 分支创建目的明确的 codex/<topic> 分支；禁止直接在 main 上开发。若工作区有未提交改动，先记录并保护它们，不得擅自丢弃。

二、必须遵守的工程原则

- 运行真相是 src/ 和 test/；package.json 是版本真相；聊天内容不是项目状态。
- 先做用户任务和失败模式分析，优先清理技术债、修 bug 和提高可靠性；没有明确授权不要添加新功能。
- 从第一性原则出发，以用户体验为中心；功能要成熟、交互要简约友好、架构要易维护并为长期演进留出空间，但不要为了路线图过度实现。
- 保持零运行时依赖设计；平台 fetch、node:* 和原生 WebSocket 优先，可选依赖必须惰性加载。
- 失败的通知渠道不能拖垮启动或其他渠道；监听器和组装逻辑必须防御性处理异常。
- 审批、动作、问题路径必须 fail-closed；超时、畸形输入、无效 token、错误来源或异常都不能默认批准。
- 入站默认拒绝；身份绑定必须是 (channel, userId)，不能使用全局用户字符串。token 必须单次、限时，并绑定原始频道/聊天。
- 状态写入必须保留无关的键，遵守现有锁和 merge 逻辑；日志和 API 响应不得泄露凭据。
- admin server 只能绑定 127.0.0.1，不能为了方便放宽。
- 子代理控制台或 admin GUI 必须沿用 src/admin/ui.mjs 的 DSH 视觉语言和交互，不得另起产品风格。
- 安全修复范围限于 dsh-notifier 自身；不要把官方宿主或其他插件的修复冒充本项目改动。

三、强制开发闭环

每个任务都必须按下面顺序执行，不能跳过：

计划 -> 实现 -> 对抗性 review -> 根据 review 修订 -> 聚焦测试 -> 完整验证

开始修改前：

1. 从 .agents/workstreams/TEMPLATE.md 创建或接管一个唯一的 .agents/workstreams/<topic>.md。
2. 在 workstream 写清楚身份、工具/模型、机器、范围、拥有的文件、计划、风险和验证命令。
3. 明确哪些文件不在本次范围内，避免顺手重构或混入无关清理。

实现后：

1. 主动以攻击者视角审查输入边界、来源绑定、token 生命周期、错误处理、资源耗尽、日志泄露、跨渠道串线和回归风险。
2. 修复 review 发现的问题；无法修复的必须在 workstream、HANDOFF.md 和最终回复中明确记录。
3. 至少运行与改动相关的聚焦测试；最终按风险运行：
   npm test
   node scripts/verify-release.mjs
   node scripts/gen-channel-matrix.mjs --check
   node --check src/index.mjs
   git diff --check
4. 行为变更必须更新 CHANGELOG.md，并写明 review/security 原因；不要改 package 版本，除非任务明确包含发布版本。

四、交接和版本控制

完成本次任务或离开当前机器前，必须：

1. 更新自己的 .agents/workstreams/<topic>.md，标记状态并详细记录：做了什么、没做什么、身份、工具/模型、机器、文件、测试、对抗性 review、风险、下一步和最终 commit SHA。
2. 更新 HANDOFF.md 的当前快照。它是下一位 agent 的工程交接，不是聊天流水账；请合并/替换过期内容，不要无止境追加历史。
3. 执行项目本地 .agents/skills/neat-freak/SKILL.md，检查 AGENTS.md、README、docs、memory、workstreams、HANDOFF、版本和链接是否一致。
4. 只提交一个逻辑清晰、范围单一的 commit；不要提交 node_modules、package-lock.json、凭据、状态文件、日志或本地生成物。
5. 推送到私有开发仓库，并确认工作区干净：
   git push
   git status --short --branch
6. 最终回复只报告：身份、完成内容、修改文件、review 结果、测试结果、已知失败/验证缺口、风险、下一步、commit SHA 和 push 状态。

如果任务目标、当前分支或已有改动存在冲突，先停在计划阶段并报告证据；不要强制 reset、checkout、覆盖或 force-push。
```

## 使用规则

- 每次接力都使用上面的整段作为新 agent 的第一条消息，并填写四个身份字段。
- agent 的持久状态以仓库中的 `AGENTS.md`、`HANDOFF.md`、`.agents/workstreams/` 和 `docs/memory/` 为准。
- `HANDOFF.md` 每次接力都要更新当前快照；workstream 保留每个 agent 的详细身份和工作记录。
- 任何 agent 都必须在推送后确认工作区干净，下一位 agent 再执行 `git pull --ff-only` 接续。
