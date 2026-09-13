# Workstream: terra-ux-first-run

- Agent identity: `Terra | Codex | shared Windows workspace`
- Agent: `terra-ux-first-run`
- Branch: `codex/stage5-wechat-ilink-hardening` (shared parent branch; no branch switch)
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Improve first-run admin UI guidance and personal-mode progressive disclosure without changing API or channel runtime code.
- Plan: (1) inspect current entry/token/onboarding/mode behavior and focused tests; (2) add only missing first-run guidance and executable navigation; (3) add behavior tests for first visit, copy fallback, token/config empty state, quick paths, and advanced defaults; (4) run focused and full validation; (5) commit only UI, focused tests, and this workstream.
- Owned files: `src/admin/ui.mjs`, `test/admin-ui-behavior.test.mjs`, `.agents/workstreams/terra-ux-first-run.md`
- Do not touch: channel, inbound, routing, control, admin API/server, version, README, CHANGELOG, HANDOFF files owned by other workstreams.
- Validation: `node --test test/admin-ui-behavior.test.mjs`; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`.
- Adversarial review: Checked that the first-visit card contains no credentials or external resources, hides only after a token is present, keeps loopback address rendering, and routes through existing tab listeners/API. Clipboard rejection and unavailable APIs retain a manual-copy fallback.
- Handoff: Added a first-visit personal-mode card with token/address instructions, channels/QR and member quick paths, and explicit observe/approve/converse/group defaults; added behavior/static tests. Validation passed (`node --test test/admin-ui-behavior.test.mjs`, `npm test` 1235 pass/1 skip, release guard, channel matrix check, syntax check, diff check). Commit pending.
