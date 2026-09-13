# Workstream: fix-dingtalk-stream-protocol

- Agent identity: relay-fix-train | TraeWork parent + subagents | remote sandbox
- Agent: relay-fix-train (R1)
- Branch: `codex/fix-dingtalk-stream-protocol`
- Status: done
- Start/end: 2026-08-28 -> 2026-08-28
- Scope: 修复钉钉 Stream 协议六项偏差（G-01/02 P1，G-10/23/24/42），R1 列车。
- Plan: 1. ackFrame 改读 frame.headers.messageId、回执头字段 messageId、data JSON.stringify('OK')。2. handleFrame 增加 SYSTEM 分支：ping 回显 headers+data，其余 SYSTEM 记 debug。3. 建连 body uesrAgent→ua 并改写误导注释（注明三版 SDK 核对结论）。4. data 二次 parse 失败加 warn。5. richText 混排归一（text 拼接+图片走既有管线）。6. 被动回复 messageId 改单调 seq 合成。7. 重写 test/inbound.dingtalk.test.mjs mock 形态（headers.messageId 钉契约）。8. 新建 docs/protocol-preflight/dingtalk.md 沉淀协议证据；真机 10 分钟长连缺口记 docs/memory/risks.md。
- Owned files: src/inbound/dingtalk-stream.mjs; test/inbound.dingtalk.test.mjs; docs/protocol-preflight/dingtalk.md(新); CHANGELOG.md
- Do not touch: 其余 src/inbound/*（归 fix-command-matrix / fix-merge-window-keys 等批次）
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`; focused: test/inbound.dingtalk.test.mjs（ack 头字段/载荷、SYSTEM ping 回显、parse 失败 warn、messageId 唯一性、richText 混排）
- Adversarial review: 按《01-修复计划.md》对抗性审查清单逐问自查后填写结论；本条目预留。
- Handoff: 见下方 2026-08-28 记录。
- 2026-08-28 done: 提交 20611d5（源码+测试）+34ab419（docs）。G-01/02/10/23/24/42 六项全修。审查：四红线未触碰；mock 与实现同源（注入 webSocketImpl 驱动真实路径）；fixtures 来自三版 SDK 源码形态（解包件留 /data/user/work/sdk-check/）。遗留：未经真机验证（SYSTEM ping 判定字段并集防御、SDK ack 顶层 message:'OK' 省略），已记 risks.md + protocol-preflight/dingtalk.md。
