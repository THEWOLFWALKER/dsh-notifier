# Workstream: fix-codepoint-segmentation

- Agent identity: relay-fix-train | TraeWork parent + subagents | remote sandbox
- Agent: relay-fix-train (R1)
- Branch: `codex/fix-codepoint-segmentation`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28
- Scope: 码点安全分段统一（G-03 P1 + G-22 + G-40 stripMention 形态白名单化），消除孤立代理项、配额静默与 @ 残片，R1 列车。
- Plan: 1. src/inbound/segment.mjs 新增导出 splitByCodePoints(text, size)（Array.from 码点语义，注释说明 ZWJ 序列拆分为可接受降级）。2. wechat-ilink/legacy-core.mjs:374-386、qq-gw.mjs:422,460 三处 slice 循环改用 helper。3. qq-gw 出站分段补被动回复配额常量（c2c 4/群 5）与超限 warn。4. G-40：qq-gw.mjs:73-76 stripMention 白名单化（`<@!ID>`/`<@ID>`/行首 `@名字 ` 三形态），未命中保留原文 + debug 日志，fixtures 用真实网关样本。5. 星体平面与 ZWJ 边界单测 + stripMention 形态单测。
- Owned files: src/inbound/segment.mjs; src/channels/wechat-ilink/legacy-core.mjs; src/inbound/qq-gw.mjs(分段+stripMention); 对应 test; CHANGELOG.md
- Do not touch: legacy-core 轮询循环（归 fix-token-qq-gateway 批次的 G-12 监督项）；qq-gw 关闭码/INVALID_SESSION 分支（同归 fix-token-qq-gateway）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 分段边界单测（孤立代理项正则不匹配、配额超限 warn）、stripMention 三形态剥净/未知形态保留且有 debug 日志
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 见下方 2026-08-28 记录。
- 2026-08-28 done: 提交 dd94ac2+2ffd1ee+17b0d96。G-03/22/40 全修。审查：四红线未触碰；孤立代理项断言用与实现无关的 Unicode 探测器正则。遗留：QQ @ 形态真机样本为零（debug 采样观察记 risks.md）；ZWJ 序列拆多码点属可接受降级。
