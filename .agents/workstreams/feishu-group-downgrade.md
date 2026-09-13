# Workstream: feishu-group-downgrade

- Agent identity: `feishu_group_downgrade | GPT-5.6 | Codex desktop`
- Agent: `feishu_group_downgrade`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: 修复飞书群聊敏感审批/提问降级，不产生原生按钮送达证据或群聊控制泄漏；保留普通动作通知。
- Plan: 1) 审查 router 与 Feishu 群聊目标/降级契约；2) 让敏感群聊路径 fail-closed 且不登记 pushedTo/buttonChannels；3) 增加回归测试；4) 聚焦测试并做 adversarial review。
- Owned files: `src/approval/router.mjs`, `src/inbound/feishu-bot.mjs`, `test/approval.multi.test.mjs`, `test/inbound.feishu.test.mjs`
- Do not touch: assembly/Telegram/微信文件及其他 agent workstream 文件。
- Validation: `node --test test/approval.multi.test.mjs test/inbound.feishu.test.mjs`
- Adversarial review: Group approval marker is excluded from `pushedTo`/`buttonChannels` and suppresses generic numbered fallback; Feishu question fallback text is blocked only for `oc_*` groups while ordinary status/action text remains available. Private `ou_*` cards remain interactive. No real-device validation performed.
- Handoff: Focused tests pass (`node --test test/approval.multi.test.mjs test/inbound.feishu.test.mjs`, 58/58); syntax and diff checks pass. Narrow commit recorded below; parent should integrate after reviewing shared-worktree diffs.
