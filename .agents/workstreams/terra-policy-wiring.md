# Workstream: terra-policy-wiring

- Agent identity: `terra_policy_wiring | Codex | Windows desktop`
- Agent: `terra_policy_wiring`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Wire the persisted per-session control overlay into the existing provider-neutral Control Core without creating a second authorization path.
- Plan:
  1. Add optional `policyForSession`/`sessionPolicy` resolver aliases to `createControlEntry`; preserve synchronous legacy `handle()` contracts.
  2. Resolve only after a normalized event supplies a non-empty session id; accept only the canonical four overlay fields and fall back to the static base policy on resolver errors, promises, malformed/unknown/source/conflicting data.
  3. Merge the validated overlay into the existing policy snapshot, then continue through the existing source-binding and `canSettleApproval`/arbiter checks. Never let overlay data set channel/account/user/chat/session fields.
  4. Add adversarial integration coverage for team member approval, wrong source, owner-only, personal defaults, resolver failures/unknown fields, missing or cross-session ids, and legacy paths.
  5. Independently inspect the diff and run focused plus full validation gates; commit only source/tests/workstream.
- Owned files: `src/control/entry.mjs`, `test/control-entry.integration.test.mjs`, `.agents/workstreams/terra-policy-wiring.md`
- Do not touch: `src/control/session-arbiter.mjs`, `src/routing/session-registry.mjs`, `src/routing/agent-router.mjs`, other agents' files, version/release/public mirror.
- Validation: `node --test test/control-entry.integration.test.mjs`; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/control/entry.mjs`; `git diff --check`.
- Adversarial review: challenge source-field injection, resolver throw/thenable, unknown/invalid overlay, missing/cross-session id, approvalMembers not widening steer/ordinary-message, personal default stability, and owner cross-channel rejection.
- Handoff: `src/control/entry.mjs` now accepts optional synchronous `policyForSession` / `sessionPolicy` (ambiguous dual resolvers disable both), strictly validates the canonical four-field overlay, ignores resolver errors/thenables/unknown/source/unnormalized values, and merges only after existing source checks before the existing arbiter. `src/index.mjs` production assembly now injects a defensive `registry.getControl(sessionId)` resolver; missing/throwing reads return null and preserve static policy. `test/control-entry.integration.test.mjs` adds 6 adversarial groups (17 focused tests total). Focused tests pass; release guard, channel matrix, syntax and diff checks pass. Full `npm test` was run against a concurrently dirty tree and reports 1252 pass + 5 unrelated failures + 1 skip in `test/approval.multi.test.mjs`; do not attribute those failures to this commit. No version/public push/real-device claim. Commits: `aba0949`, `36dcfed`.
