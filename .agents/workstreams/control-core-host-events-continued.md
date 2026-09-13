# Workstream: control-core-host-events-continued

- Agent identity: `Codex | GPT-5 | Codex desktop`
- Agent: `root`
- Branch: `codex/issue16-host-events-control-core`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Wire the existing Control Core into still-unconnected QQ, DingTalk, WeChat iLink, and any safely supported Web/admin inbound control entry points with focused integration coverage.
- Plan: Inspect actual inbound handlers; implement smallest safe adapters using `deps.control.handle`; add focused tests for QQ and at least one additional channel; adversarially review fail-closed source/group/replay semantics; run full validation and hand off a narrow commit.
- Owned files: `src/channels/**`, `src/admin/**` only where an existing inbound callback is safely connectable, and focused tests/workstream record.
- Do not touch: `README.md`, `README.zh-CN.md`, `HANDOFF.md`, `CHANGELOG.md`, public remotes, unrelated workstream files.
- Validation: Focused channel/inbound tests, `npm test`, `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, `git diff --check`.
- Adversarial review: Challenge wrong chat/user, duplicate/replay, expiry, missing chatId, group control rejection, personal converse disabled, and legacy text fallback.
- Handoff: QQ INTERACTION_CREATE approval/question envelopes now carry accountId and route through the existing approval/questions Control Core registrations; DingTalk and WeChat iLink remain text/number fallback only because no confirmed native callback protocol exists. Web/admin ask_user has no safe inbound settlement entry and was intentionally left untouched. Validation passed: `npm test` (1165 pass, 1 existing win32 skip), release/channel guards, `node --check src/index.mjs`, and `git diff --check`. Private push intentionally not attempted per latest constraint. Commit: `367e285`.
