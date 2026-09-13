# Workstream: fix-inbound-lifecycle

- Agent identity: `trae | R4 收口代理 | remote sandbox`
- Agent: trae
- Branch: `codex/fix-inbound-lifecycle`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28（R4 收口，v0.9.4）
- Scope: 入站生命周期与交互健壮性（G-16/17/18 + G-46/27/26/30/31/34/15，G-19 先取证），R4 列车。
- Plan: 1. 启动扫描 ap: pending 行：waiter 已死→标 expired+补发失效告知（D4 默认）。2. feishu 旧卡片 refs 对齐 TG 15min TTL。3. event-listener dedup 键按 intent 分离（approval/asked 加 payload 摘要）。4. 合成 messageId 去重窗口 24h→60s（仅微信兜底/WxPusher 合成键；平台原生 msgId 不变）+ wxpusher 键加单调 seq。5. feishu 非文本消息静默忽略+回执（不再注入占位符）。6. pairing 过期码独立分支不计锁出。7. 卡片成功后同 key 文本线 5min 抑制（D5 默认）。8. bus 注册显式 priority+断言测试。9. G-19 按 protocol-preflight 模式先取证宿主 scoped 事件过滤行为，证据不足只登记不改码。依赖 fix-config-validation 先行（target-guard 断言前置）。
- Owned files: src/inbound/bus.mjs; src/interaction/ledger.mjs(如需); src/inbound/feishu-bot.mjs; src/inbound/telegram-bot.mjs(refs TTL 如需); src/event-listener.mjs(dedup); src/inbound/wxpusher-callback.mjs; src/inbound/pairing.mjs; src/inbound/commands.mjs(过期码文案); 对应 test; CHANGELOG.md
- Do not touch: telegram-bot 按钮失败话术（fix-error-visibility 已处理）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 重启 expired+补发、TTL 过期拒绝、同 seq 异 payload 双推、60s 窗外重复裁决、过期码不锁出、priority 断言
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。

## 完成记录（2026-08-28）

- 结果：9 项全部落地（G-15/G-46 提交 `6036706`；G-16/G-17/G-18/G-26/G-27/G-30/G-31/G-34 提交 `01c20ec`；G-19 取证登记 `docs/memory/risks.md` 不改码）。npm test 1494/1494（W11 收口时基线），v0.9.4 全量 1531/1531。
- 风险：G-19 scoped 事件契约待真机/宿主源码复验后定策略（root / 双订阅 / payload 兜底）；G-34 抑制窗口为 5min 默认值，若产品要更长/更短改 `TEXT_SUPPRESS_WINDOW_MS` 一处即可。
- 下一步：无（R4 已收口）。
- 提交哈希：`6036706` `01c20ec`。
