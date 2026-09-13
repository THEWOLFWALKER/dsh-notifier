# Workstream: fix-tests-docs

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-tests-docs`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 测试保真与文档一致性（G-57/58/59/60 + S-11/S-13），R5 列车收口。
- Plan: 1. scripts/test-channel.mjs 重命名 channel-selfcheck.mjs，README/AGENTS/文档引用同步；裸 node --test 恢复全绿。2. dshQuality.testCount 按实际 runner 汇总更新，README/HANDOFF/verify-release 同步（VERSIONING 第 4 条）。3. qq FakeWebSocket error/半帧/超时支路、public.test fetch 超时支路复核（前序批次已部分覆盖）。4. 新增 test/health.test.mjs、test/escalation.test.mjs、test/pairing.test.mjs。5. README/README.zh-CN 命令清单补全 11 条会话命令；accountId 规则入 docs/guide.md 排障条目。6. S-11：hook-server.mjs 从 npm files 排除（scripts 目录改显式列举或排除该文件）。7. S-13 按 D6 默认：optionalDependencies 收敛精确版本+文档声明可选装配语义。8. mock 分层原则写入 docs/TECHNICAL_DEBT.md 维护规则。
- Owned files: scripts/test-channel.mjs(重命名); package.json(files/scripts 引用); README.md; README.zh-CN.md; docs/guide.md; docs/TECHNICAL_DEBT.md; docs/memory/risks.md; test/inbound.qq.test.mjs; test/public.test.mjs; test/health.test.mjs(新); test/escalation.test.mjs(新); test/pairing.test.mjs(新); CHANGELOG.md
- Do not touch: docs/memory/decisions.md（仅当 D6 决策变化时按 neat-freak 原则更新）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 基线口径唯一性（裸 node --test 与 npm test 同绿）、新增三套件、命令清单与实现一致性
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
