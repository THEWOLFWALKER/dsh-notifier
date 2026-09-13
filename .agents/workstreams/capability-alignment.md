# Workstream: capability-alignment

- Agent identity: `Codex / GPT-5 / desktop workspace`
- Agent: `root`
- Branch: `codex/capability-alignment`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Align inbound capability declarations and native renderer/fallback contracts with the actual Telegram, Feishu, QQ, WxPusher, WeChat iLink, and DingTalk implementations.
- Plan: (1) inspect matrix/provider/renderer contracts; (2) make narrow declaration and fallback fixes; (3) add focused consistency and failure-isolation tests; (4) run focused and full validation.
- Owned files: `src/inbound/capability-matrix.mjs`, `src/inbound/_contract.mjs`, affected inbound/provider files, focused tests.
- Do not touch: `README*`, `HANDOFF.md`, `CHANGELOG.md`, public remotes, unrelated workstreams.
- Validation: focused capability/contract/renderer and channel suites passed; `npm test` (1169 pass + 1 skip); `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`.
- Adversarial review: fixed QQ matrix/renderer drift; QQ group question cards now fail closed; native card failure sends direct text only to the original target and records `hintTargets`; button authorization remains restricted to native `pushedTo`; unrelated users and legacy `hintChannels` remain fail-closed.
- Handoff: capability alignment complete; local commit pending, no public push.
