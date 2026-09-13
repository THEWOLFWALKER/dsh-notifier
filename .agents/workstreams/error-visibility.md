# Workstream: fix-error-visibility

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-error-visibility`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 错误可见性分层（G-53 P2 + G-54），R2 列车。
- Plan: 1. NotifyError 增 publicMessage/detail 双字段；detail 仅进日志。2. _shared.mjs 五处构造点、notify.mjs failed[].error、health.mjs detail 全部切 publicMessage；渠道键→中文名映射。3. 按钮失败话术按 bus.decide 原因映射（token-required/key-mismatch/source-chat-mismatch/already-resolved/expired/TG 卡片被删各自文案）。4. 公开文案不含响应体片段/HTTP 原文/底层 message 断言。依赖 fix-outbound-delivery 先行（错误码收编点）。
- Owned files: src/adapters/_shared.mjs(NotifyError); src/notify.mjs; src/health.mjs; src/inbound/telegram-bot.mjs; src/inbound/feishu-bot.mjs; 对应 test; CHANGELOG.md
- Do not touch: bus.mjs decide 错误原因枚举本身（仅消费不改动）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 公开文案形态断言矩阵（参照竞品测试形态，禁抄实现）
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
