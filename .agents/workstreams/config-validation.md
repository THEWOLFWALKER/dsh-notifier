# Workstream: fix-config-validation

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-config-validation`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 配置校验与渠道枚举收敛（G-13 P2 + G-61/62/63/64/32/38/39/45/28 + S-12），R4 列车。
- Plan: 1. 新建 src/inbound/channels-registry.mjs 导出冻结 INBOUND_CHANNELS；identity/target-guard/assembly/admin-api 四处改引。2. target-guard 未知渠道改拒绝+warn（S-12，依赖枚举收敛）。3. spec 数值字段补 type:'number'。4. pushplus 双枚举统一白名单抛错；webhook headers 值 String()+warn；desktop sound 布尔形态解析；_bounded max 非数字回默认上限；discord >2000 fail-fast；slack Incoming Webhook 边界显式报错；postText 补 content-type；iLink contextToken 缺省 warn。5. config 矩阵单测扩展。
- Owned files: src/inbound/channels-registry.mjs(新); src/inbound/identity.mjs(枚举引用); src/inbound/target-guard.mjs; src/assembly/inbound-channels.mjs; src/admin/api.mjs(枚举引用); src/adapters/_engine.mjs; src/adapters/pushplus.mjs; src/adapters/webhook.mjs(headers); src/adapters/desktop.mjs; src/adapters/_bounded.mjs; src/spec-channels.mjs; src/channels/wechat-ilink/_ilink-api.mjs; test/config.test.mjs 等; CHANGELOG.md
- Do not touch: identity.mjs allows/binding 键语义（fix-merge-window-keys 已收敛）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: 非法枚举/布尔形态/headers 嵌套/max 非数字/超长/未知渠道拒绝矩阵
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
