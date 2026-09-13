# Workstream: fix-admin-settle-audit

- Agent identity: relay-fix-train | TraeWork parent + subagents | remote sandbox
- Agent: relay-fix-train (R1)
- Branch: `codex/fix-admin-settle-audit`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28
- Scope: 管理台裁决审计写失败隔离（G-05 P1）+ 裁决接收人校验 fail-open 封口（G-41），R1 列车。
- Plan: 1. admin/api.mjs settleQuestion 的 appendAudit 包独立 try/catch：失败 warn 后返回已生效结果。2. 同文件其余 appendAudit 调用点同模式核查。3. G-41：approval/router.mjs:347-351 删除 `targets.length > 0 &&` 门控，pushedTo 空时同样执行 userId 比对，无法证明投递对象即 fail-closed 回拒（回执引导回桌面）。4. CHANGELOG 注明'审计静默降级'与'空表回拒'取舍。5. mock appendAudit 抛错单测 + pushedTo 空/错源/对源三态单测。
- Owned files: src/admin/api.mjs; src/approval/router.mjs; test/admin-questions.test.mjs; test/approval.test.mjs(扩展); test/approval-phase2-hardening.test.mjs(扩展); CHANGELOG.md
- Do not touch: admin/ui.mjs（归 fix-store-lifecycle 的 G-14 标记项）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: appendAudit 抛错→仍 settled:true；正常路径审计行完整；pushedTo 空+错源→拒绝、pushedTo 空+正确 userId→拒绝并回执、pushedTo 正常+对源→放行
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 见下方 2026-08-28 记录。
- 2026-08-28 done: 提交 c169323+6826436。G-05/41 全修。审查：四红线未触碰，G-41 纯收紧（非空两分支行为测试锚定）；审计降级经 warn（host logger+stderr 双出口）可观测。遗留：磁盘长期满时审计有洞；临时空表窗口回拒需重点（方向与 fail-closed 一致）。
