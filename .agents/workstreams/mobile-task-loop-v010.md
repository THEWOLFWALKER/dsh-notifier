# Workstream: mobile-task-loop-v010

- Agent identity: `TraeWork agent | dsh-notifier-dev | remote sandbox`
- Branch: `codex/mobile-task-loop-v010`
- Status: `done`
- Start/end: `2026-09-12 -> 2026-09-12`
- Scope: 交付 v0.10「手机接管 DSH 任务」闭环（宿主桥 + 原生提问 + Web-first 升级 + 任务路由 + 图片输入 + 管理台状态），窄提交到 `main`。
- Plan:
  1. 冻结 v0.10 目标契约（宿主能力、原生问题、双端首答、延迟升级、多任务歧义、图片消息块）。
  2. 宿主能力快照 + 事件实证入口 + 生命周期诊断（扩展 `src/host-events.mjs`）。
  3. 经 `ctx.userQuestions` 公开 seam 桥接原生 `ask_user_question`；无安全扩展点时可观测 fallback。
  4. Web-first 远程延迟升级（Stage 0/1/2 + 定时器取消 + 跨端终态同步）。
  5. 移动任务路由（任务投影、任务选择、歧义前置、`/tasks`/`/use`、回执）。
  6. 图片进入 DSH 会话（P0 图片路径 + 受控下载 + 失败回执）。
  7. 管理台暴露 DSH 连接与任务状态。
  8. 文档 + CHANGELOG + 对抗性 review 修正。
- Owned files: `src/host-events.mjs`、`src/questions/router.mjs`、`src/approval/escalation.mjs`、`src/inbound/conversation.mjs`、`src/routing/*`、`src/inbound/message.mjs`、`src/admin/api.mjs`、`src/admin/server.mjs`、`test/mobile-task-loop-contract.test.mjs` 及新增 focused tests。
- Do not touch: DSH 宿主 / `@deepseek-ai/*` / 上游仓库（只读研究）；`docs/screenshots/*`；公开发布库 `THEWOLFWALKER/dsh-notifier`。
- Validation:
  ```
  npm test
  node scripts/verify-release.mjs
  node scripts/gen-channel-matrix.mjs --check
  node --check src/index.mjs
  ```
- Adversarial review: 见末尾记录（双端各成功一次、root/current 双收去重、多会话投错、旧卡消费 ref、宿主重启伪恢复、图片 SSRF、文本+图丢一半、关闭远程提问误伤宿主 Web）。
- Handoff: 已完成。全部 9 个窄提交落位 `codex/mobile-task-loop-v010`，`npm test` 1605 全绿，`verify-release` / 渠道矩阵 / `node --check` 全过，版本与测试计数四处对齐，待推送 `main`。

## 调查结论（2026-09-12）

- 基线：`v0.9.7`，1548 tests 全绿，工作树干净，`src/`+`test/` 为运行时真相。
- 宿主 seam（`@deepseek-ai/dsh-user-questions@0.0.1-rc.3`）公开 API：
  - `ctx.userQuestions.registerProvider(provider): () => void`；`ctx.userQuestions.ask(request): Promise<answer>`。
  - **一个 context 最多一个 provider**：重复注册抛 `DUPLICATE_PROVIDER`，无注册抛 `NO_PROVIDER`，无 fan-out/路由。
  - `AskUserQuestionRequest = { questions:[{id,question,detail?,header?,options?,multiSelect?,intent?}], agent?, signal? }`；`Answer = { answers:[{id,selected,custom?}] }`。
  - 错误码：`EMPTY_QUESTIONS`/`BAD_INTENT`/`NO_PROVIDER`/`DUPLICATE_PROVIDER`/`ASK_ABORTED`/`CALLER_NOT_LIVE`/`DELEGATED_CALLER`。
- 关键约束：`@deepseek-ai/dsh-user-questions` 只暴露「注册 provider」与「ask」，未暴露「读取当前已注册 provider」。因此任务书 3.2 的「组合已有 Web provider（策略 3）」在缺少取回 provider 的公开 API 时不可安全实现 → 落点取决于宿主是否有其他安全扩展点，否则安全降级到 `unsupported`（策略 4），保留插件自有 `ask_user` fallback。
- 现有可复用底座齐备：`selectHostEventContext`/`createHostEventRegistrar`（host-events）、`createQuestionBridge`+`registerAskUserTool`（questions）、`createControlEntry`（唯一授权结算边界）、`createEscalationChain`（escalation）、`resolveTarget`（conversation）、`createSessionRegistry`（routing）、`capabilitiesOf`（capability-matrix）。

## 提交边界（窄提交）

1. `test: freeze mobile task-loop contracts`
2. `feat: add native host capability bridge`
3. `feat: bridge native host questions`
4. `feat: add web-first remote escalation`
5. `feat: complete mobile task routing`
6. `feat: deliver image input to host sessions`
7. `feat: expose host and task status in admin`
8. `docs: document v0.10 mobile task loop`
9. `fix: address adversarial review findings`