# Workstream: fix-security-medium

- Agent identity: `<agent name> | <tool/model> | <machine or environment>`（接手代理填写）
- Agent: `<name>`
- Branch: `codex/fix-security-medium`
- Status: planned
- Start/end: 2026-08-28 -> active
- Scope: 安全中危加固（S-02 SSRF、S-06 Origin/Host、S-07 答案上界、S-05 按 D2 默认），R3 列车。
- Plan: 1. 新建 src/adapters/_urlguard.mjs：assertPublicHttpUrl（IP 字面量直查私网/保留段；域名 node:dns lookup all 全址校验+短 TTL 缓存）；webhook 与自托管渠道发送前强制；postJson 加 redirect:'manual'，3xx 抛错。2. admin/server.mjs：Origin 白名单（127.0.0.1/localhost:port）不符 403；Host 头校验防 DNS rebinding。3. control/entry.mjs settle 链答案长度上限 2000 码点+控制字符过滤。4. event-listener 摘要默认 80 字符+密钥形态打码，redaction 配置项（D2 默认 minimal）。5. SSRF/Origin/答案/打码矩阵单测。CHANGELOG 带 security 段。
- Owned files: src/adapters/webhook.mjs; src/adapters/_shared.mjs(redirect); src/adapters/_urlguard.mjs(新); src/admin/server.mjs; src/control/entry.mjs; src/event-listener.mjs(S-05 片段); 对应 test; CHANGELOG.md
- Do not touch: event-listener dedup 键（归 fix-inbound-lifecycle 的 G-18）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: SSRF 矩阵（私网/域名解析私网/::ffff:/3xx/0.0.0.0/公网放行）、Origin 403、超长答案、sk- 打码
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 完成后填写结果/风险/下一步/提交哈希；审查性工作须写 `no code commit`。
