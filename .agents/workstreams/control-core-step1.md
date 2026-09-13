# Workstream: control-core-step1

- Agent identity: Claude Fable 5 | Claude Code | Windows 11
- Agent: Codex
- Branch: codex/control-core-restart
- Status: done
- Start/end: 2026-08-25 -> active
- Scope: 修复 ask_user 文本编号回复的 chat 来源隔离——将 hint 证据从渠道级 `hintChannels` 升级为逐目标 `hintTargets`，`latestPendingFor` 与 `handleNumberedReply` 强制匹配 `(channel, userId, chatId)`，所有非精确 chat 路径 fail-closed。
- Plan:
  1. 写 workstream 计划、影响文件、风险、停止条件和对抗审查
  2. 先补失败回归测试（覆盖正确 chat、错误 chat、缺 chatId、跨渠道、发送失败、部分送达、旧记录、重复回复、并发 pending、僵尸 pending）
  3. 只做最小代码修改：`src/questions/router.mjs`
  4. 自审并修复跨 chat 泄漏、假送达证据和误消费问题
  5. 更新 CHANGELOG.md、HANDOFF.md、docs/memory/risks.md、docs/architecture.md 和 workstream
  6. 运行全量验证
  7. 运行时代码和文档分开提交
  8. 推送私有 remote

- Owned files:
  - src/questions/router.mjs
  - test/questions.test.mjs
  - CHANGELOG.md
  - HANDOFF.md
  - docs/memory/risks.md
  - docs/architecture.md
  - .agents/workstreams/control-core-step1.md

- Do not touch:
  - private/codex/hint-scope-regression
  - private/codex/questions-chat-gate
  - QQ 按钮、QQ 提问卡片、approval.parallel
  - 新 IM、群聊、团队 ACL、Session 仲裁
  - src/inbound/bus.mjs
  - src/interaction/ledger.mjs
  - src/actions.mjs
  - src/approval/

- Validation: npm test && node scripts/verify-release.mjs && node scripts/gen-channel-matrix.mjs --check && node --check src/index.mjs

- Adversarial review:
  - 正确 chat：同一 (channel, userId, chatId) 匹配 hintTargets → 编号回复生效
  - 错误 chat：同一用户、同一渠道、不同 chat → 消费消息 + 提示回原会话，不裁决
  - 缺 chatId：envelope 无 chatId → fail-closed，不匹配任何 pending
  - 跨渠道：不同渠道的编号回复 → 不匹配（已有 SEC-2 覆盖）
  - 发送失败：hint 未送达的 target → 不匹配
  - 部分送达：hint 送达 chat A 但未送达 chat B → 只有 chat A 可回复
  - 旧记录：旧 `hintChannels` 格式（字符串数组）→ 不匹配 hint 路径
  - 重复回复：同 chat 两次编号 → 首达采纳
  - 并发 pending：多个 pending 问题 → 按 createdAt 优先级匹配最近一个
  - 僵尸 pending：已决行 → isPending 过滤
  - 误消费：无关用户裸编号 → 不被消费

- Stop conditions:
  - 无法证明具体 chat 的送达证据 → 停止并记录风险
  - 任何现有测试回归 → 停止并修复
  - 修改范围超出 src/questions/router.mjs + test/questions.test.mjs → 停止

- Implementation: `hintTargets` now records only confirmed per-target inbound `sendText` delivery. Channel-level `notifyAll().delivered` is never promoted to a chat receipt; new rows no longer write `hintChannels`.
- Source matching: exact `(channel,userId,chatId)` wins; same-user wrong-chat is consumed with a return-to-original-chat feedback; missing `chatId`, legacy channel hints, cross-channel and stale rows fail closed. Matching hint evidence includes `userId` and latest pending selection prefers exact/hint over wrong-chat guard from another row.
- Focused validation: `node --test --test-name-pattern='CC-1' test/questions.test.mjs` = 13/13 pass; `node --check src/questions/router.mjs` pass.
- Full validation: pending parent integration; legacy pre-CC tests that assert channel-only hint authorization require expectation updates because outbound channel delivery cannot prove a concrete chat.
- Review/risk: no real-device evidence that any provider's outbound `delivered` result identifies a chat; therefore covered outbound aliases remain unable to authorize numbered fallback until target-level evidence exists. No push performed.
- Handoff commits: `afba252` (source/tests) and `8b3a707` (docs/workstream); no push performed.
