# Workstream: fix-merge-window-keys

- Agent identity: relay-fix-train | TraeWork parent + subagents | remote sandbox
- Agent: relay-fix-train (R1)
- Branch: `codex/fix-merge-window-keys`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28
- Scope: 合并窗 chatId 维度与身份路由键归一（G-51 P2 + G-48/49），R1 列车收口。
- Plan: 1. conversation.mjs pending/flush 键加 chatId 维度（缺失仍聚合），注释同步改写。2. /bind 与 /agent use 覆盖绑定前 detach 旧 sid 的 registry 挂钩（无 API 则补幂等 detachInbound）。3. 新增 bindingKey(channel,userId) 单一 helper，identity/conversation/agent-router/registry 四处键构造收敛。4. 跨 chat 合并与绑定切换单测。
- Owned files: src/inbound/conversation.mjs(合并窗/绑定); src/inbound/identity.mjs; src/inbound/agent-router.mjs; src/status/session-registry.mjs(如需); test/conversation.route.test.mjs; test/identity.test.mjs; CHANGELOG.md
- Do not touch: identity.mjs 坏键清洗写回（归 fix-store-lifecycle 的 G-44）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 同 userId 双 chat 交替发言两条独立；/route 单挂；带空白 userId 键全链路一致
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 见下方 2026-08-28 记录。
- 2026-08-28 done: 提交 a60fce7+2d5a005+5ed4f6f。G-51/48/49 全修；实际路径为 src/routing/{agent-router,session-registry}.mjs（非计划所写 src/inbound/、src/status/）；session-registry 既有 detachInbound 幂等契约已满足，零改动。审查：四红线未触碰；userId 保持大小写敏感是刻意决策（wxpusher/飞书 ID 大小写语义真实）。遗留：bindingKey 与 registry inboundBindingOf 镜像规则一致性由测试锁死（非编译期保证）。
