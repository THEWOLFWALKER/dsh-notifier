# Workstream: protocol-preflight-luna

- Agent identity: `Codex sub-agent | GPT-5 | shared Windows workspace`
- Agent: `/root/protocol_preflight_luna`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-27 -> 2026-08-27`
- Scope: 阶段0协议预审：QQ Bot、飞书开放平台、Telegram Bot API、微信 iLink 的事实、限制与实现映射文档；不改运行时代码。
- Plan: 读取项目契约与现有 provider；查官方协议和必要的活跃社区证据；为每渠道写 preflight 文档和可脱敏 fixture；补索引、审查未知项与 fail-closed 约束；运行文档/JSON 轻量检查并提交窄 commit。
- Owned files: `docs/protocol-preflight/`, `test/fixtures/channels/qq-bot.json`, `test/fixtures/channels/feishu.json`, `test/fixtures/channels/telegram.json`, `test/fixtures/channels/wechat-ilink.json`, this workstream.
- Do not touch: `src/`, package metadata/dependencies, public repository, other agents' workstreams.
- Validation: JSON parse for four new fixtures, `git diff --check`; no real-device/network delivery. Runtime tests intentionally not rerun because `src/` is unchanged.
- Adversarial review: Added per-channel source registries (URL/title/query date/excerpt), separated documented/contract-tested/declared, restored existing `qq-bot.json` untouched, and marked Feishu/iLink limits as declared where official evidence was unavailable.
- Handoff: Added `docs/protocol-preflight/{README,qq-bot,telegram,feishu,wechat-ilink}.md` and shape-only fixtures (`qq-bot-protocol.json`, `telegram.json`, `feishu.json`, `wechat-ilink.json`). No src/package/public-repo changes. Commit recorded below.
