# Workstream: fix-token-qq-gateway

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-token-qq-gateway`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: token 生命周期与 QQ 网关/iLink 假死（G-11/07/12 P2 + G-55/29/21），R2 列车收口。
- Plan: 1. _tokens.mjs generation 计数：invalidate 递增，inflight 写回前比对，旧任务不覆盖新缓存。2. normalizeTtlMs 单一 helper（非有限/≤0 抛配置错误，正数钳 [1000,7d]），_tokens/qq-bot/wecom-app/_feishu-register 四处收敛。3. refreshMarginMs 动态钳制（min(配置, expiresIn 20%)）。4. qq-gw close code 分支表：4004 invalidate+重 IDENTIFY；4008 固定 60s；4006/4007/4009 弃会话；其余现行为。INVALID_SESSION 看 d 标志。5. iLink 轮询看门狗：连续零消息超阈值断链重连+warn。6. FakeWebSocket 补 error/半帧/超时支路。
- Owned files: src/adapters/_tokens.mjs; src/adapters/qq-bot.mjs; src/adapters/wecom-app.mjs; src/adapters/_feishu-register.mjs; src/inbound/qq-gw.mjs; src/channels/wechat-ilink/legacy-core.mjs(轮询监督); 对应 test; CHANGELOG.md
- Do not touch: legacy-core 发送分段（已由 fix-codepoint-segmentation 处理）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: generation 竞态、close code 矩阵、INVALID_SESSION 双分支、看门狗触发、TTL 边界
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
