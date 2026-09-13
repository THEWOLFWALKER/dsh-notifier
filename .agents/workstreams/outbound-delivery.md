# Workstream: fix-outbound-delivery

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-outbound-delivery`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 出站投递语义（G-50/08/09 P2 + G-56），R2 列车。
- Plan: 1. _shared.mjs postJson 超时抛错标记 noRetry（错误码 TIMEOUT，文案'投递超时，结果未知'）；确定性失败维持重试。2. telegram api() 429 读 parameters.retry_after，退避取 max(backoff, retryAfterMs)。3. serverchan 按 sctp 前缀分流域名，三别名并存 warn。4. qq-bot 2xx 非 JSON 改抛格式错误（BAD_UPSTREAM_RESPONSE）+ warn。5. 各 focused 单测（超时不重试、429 退避、URL 域名断言、200+HTML 拒绝）。
- Owned files: src/adapters/_shared.mjs; src/routing.mjs(如需注释/断言); src/adapters/telegram.mjs; src/adapters/serverchan.mjs; src/adapters/qq-bot.mjs; test/routing.test.mjs; test/adapters.test.mjs; CHANGELOG.md
- Do not touch: notify.mjs failed[].error 文案输出（归 fix-error-visibility 批次统一收编）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 超时无重试、连接拒绝重试、429 retryAfter、sctp 分流、2xx HTML 拒绝
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
