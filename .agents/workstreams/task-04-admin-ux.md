# Workstream: task-04-admin-ux

- Agent identity: Terra admin UX | GPT-5.6-terra | shared Windows workspace
- Agent: /root/terra_batch4_admin_ux
- Branch: codex/task-04-admin-ux
- Status: done
- Start/end: 2026-08-26 -> 2026-08-26
- Scope: streamline first-run local admin console onboarding while preserving existing API, loopback binding, bearer auth, and channel contracts.
- Plan:
  1. Inventory current UI/server/API routes and empty/error states.
  2. Add a visible local console entry hint, personal-mode-first navigation, and actionable first-run state model in the existing inline UI.
  3. Keep advanced bindings/sessions behind an explicit toggle; preserve localStorage failure fallback.
  4. Add focused static/behavior tests for the new UI contract, then run all validation gates.
  5. Review security/failure paths, document the real-device gap, commit and push private only.
- Owned files: `src/admin/ui.mjs`, `test/admin-ui-behavior.test.mjs`, `test/admin-server.test.mjs`, `README.md`, `README.zh-CN.md`, `docs/guide.md`, `docs/OPERATIONS.md`, `HANDOFF.md`, `CHANGELOG.md`, this workstream.
- Do not touch: channel adapters/transports, QQ/PR12, `approval.parallel`, admin bind/auth implementation, unrelated agent files.
- Inventory before edit:
  - UI: `/` serves `ADMIN_UI_HTML`; dashboard loads `/api/overview`, `/api/bindings`, `/api/sessions`, `/api/channels`, `/api/members`; channel save/test uses `/api/channels/:type` and `/test`; pairing uses `/api/pairing` and `/api/scan/:type`.
  - Empty state: dashboard onboarding appears when no enabled outbound channel or members; channel empty copy still points users to YAML bootstrap; members page explains `/pair` and bootstrap code.
  - Auth: bearer token prompt is single-flight and 401 retry is bounded; token is never rendered in full.
  - Server: startup logs actual loopback address/port; `/api/*` remains bearer protected.
- Validation: `node --test test/admin-ui-behavior.test.mjs test/admin-server.test.mjs`; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`.
- Adversarial review: challenge hidden advanced tabs, storage exceptions, token error loops, empty channel list, failed test-channel responses, and accidental secret rendering.
- Adversarial review: verified advanced tabs remain hidden by default and personal mode survives localStorage errors; token remains redacted and bounded re-entry; empty channels point to field forms; per-channel test failure does not suppress other channels. No transport, bind, or API auth changes. Real browser/device visual QA remains unrun as required by the pack.
- Validation: focused admin UI/server tests 54/54; full `npm test` 1140 pass + 1 skip; `node scripts/verify-release.mjs` passed (v0.8.6/documented 909); channel matrix check passed; `node --check src/index.mjs` passed; `git diff --check` passed.
- Handoff: first-run UX implemented in existing inline console. Commit/push pending.
