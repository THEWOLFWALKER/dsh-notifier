# Workstream: qq-group-control-guard

- Agent identity: `Codex | GPT-5 | desktop workspace`
- Agent: `/root`
- Branch: `codex/qq-group-control-guard`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Harden QQ group inbound provenance and keep all group control paths fail-closed without changing the broader control protocol.
- Plan: Inspect current envelope/session/conversation behavior; patch explicit QQ group chat type and conservative control rejection; add focused regression tests; run adversarial review and required validation guards.
- Owned files: `src/inbound/qq-gw.mjs`, `src/control/session-arbiter.mjs`, `src/inbound/conversation.mjs`, relevant QQ/control tests, this workstream record.
- Do not touch: `README.md`, `README.zh-CN.md`, `HANDOFF.md`, `CHANGELOG.md`, unrelated workstream files, Web/admin ask_user protocol.
- Validation: `node --test test/inbound.qq.test.mjs test/control-entry.integration.test.mjs test/conversation.test.mjs`; `npm test` (1177 total, 1176 pass + 1 skip); `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check` all passed.
- Adversarial review: Explicit QQ group/private/unknown classification; QQ group controls reject even with team/group capability; missing chatType only remains compatible for one-to-one legacy C2C shape; conversation no-session path cannot bypass the gate; approval/question/stop/steer/ordinary group cases are covered; reconnect, dedup, and lifecycle suites remain green. No real-device validation performed per request.
- Handoff: Local commit records the fix; do not push GitHub. Web/desktop settlement currently has no safe reuse entry point and this change does not claim dual-end sharing. README/HANDOFF/CHANGELOG were intentionally not changed per request; current docs retain their pre-task release snapshot.
