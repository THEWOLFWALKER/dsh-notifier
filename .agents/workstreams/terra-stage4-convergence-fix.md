# Workstream: terra-stage4-convergence-fix

- Agent identity: `terra_stage4_convergence_fix | gpt-5.6-sol | Windows`
- Agent: `terra_stage4_convergence_fix`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Repair session-registry/router convergence for concurrent route:sessions writes and stale cache reads.
- Plan:
  1. Inspect current registry/router state merge and identify write-order, stale-read, and control-sanitization gaps.
  2. Add a single defensive refresh/merge path that reads current store records before registry reads and writes, preserving unrelated fields and router updates.
  3. Add focused adversarial regressions for both write orders, stale/missing cache, malformed uncached control, store throw/false/undefined behavior, multiple sessions, and nested copy isolation.
  4. Run focused tests and required full validation, review the diff, then commit only owned files.
- Owned files:
  - `src/routing/session-registry.mjs`
  - `src/routing/agent-router.mjs` (only if required)
  - `test/session-registry.test.mjs`
  - `test/agent-router.test.mjs` (only if required)
  - `.agents/workstreams/terra-stage4-convergence-fix.md`
- Do not touch: channels, inbound, control, admin UI/API, package/version, README, CHANGELOG, HANDOFF, public remotes.
- Validation: focused session/router tests; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`.
- Adversarial review: challenge registry cache clobbering router writes in both orderings, stale read visibility, malformed controls on uncached sessions, merge preservation, and failed/false/undefined store outcomes.
- Adversarial review: Added field-level dirty tracking so lifecycle writes only overlay fields changed by this registry; each read refreshes from the shared store while retaining unsaved local fields. Persist deep-copies the base map and normalizes control overlays on every record, including uncached records. Regression coverage includes both router-after-registry write ordering, stale read convergence, nested copy isolation, uncached malformed control, durable false/throw/undefined sweep writes, and tombstone non-resurrection.
- Handoff: focused and full validation passed; commit recorded below. No public push.
