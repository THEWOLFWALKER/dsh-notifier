# Workstream: fix-store-lifecycle

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-store-lifecycle`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 存储与状态（G-20/14 P2 + G-44/47 + S-14 + S-04 缓解加固），R4 列车收口。
- Plan: 1. pairing.mint 双写合并为单次原子写（minted+active 一行落盘）。2. sweep 扩展：无 disposedAt 的出站覆盖行 30d TTL 回收，行含会话字段时保留出站覆盖字段。3. 启动一次性清洗坏绑定键并写回+warn 计数（测试含白纸重置+白名单重播交互）。4. G-14 按 D1 默认最小修：管理台保存出站配置后 UI'重启后生效'标记（ui.mjs 通道卡片角标），README/guide 声明语义；若 D1 改选全量重建则本条移出另立 workstream。5. ledger.resolve 前态检查（已终态返回 already-resolved）。6. S-04：store.mjs 加载时权限自检（mode 非 0600 → warn + chmod 收紧尝试，失败仅 warn）；加密/keychain 超零依赖线，登记 TECHNICAL_DEBT + risks.md 文件系统级暴露面结论。
- Owned files: src/inbound/pairing.mjs; src/inbound/store.mjs(扫描+权限自检); src/inbound/identity.mjs(清洗写回); src/inbound/agent-router.mjs(sweep); src/admin/api.mjs; src/admin/ui.mjs(标记); src/interaction/ledger.mjs; 对应 test; docs/TECHNICAL_DEBT.md; docs/memory/risks.md; CHANGELOG.md
- Do not touch: pairing 过期码计数分支（fix-inbound-lifecycle 已处理）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: mint 崩溃注入无孤儿码、sweep 回收+保留字段、清洗写回计数、UI 标记可见、双 resolve 幂等、权限异常 mock→warn 且尝试收紧
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
