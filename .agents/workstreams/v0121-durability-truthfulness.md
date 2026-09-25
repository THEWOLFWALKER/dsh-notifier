# Workstream: v0.12.1 durability and truthfulness remediation

- Agent identity: `Codex | Work Mode | Cloud workspace`
- Agent: `Codex`
- Branch: `codex/v0121-durability-truthfulness`
- Status: complete (Phase A-E code/contract work; Phase F real-device evidence remains open)
- Start/end: `2026-09-25 -> 2026-09-25`
- Scope: Implement and validate the remediation pack's Phase A, B, C, D, and E code changes on top of `dev`; keep Phase F as an explicit real-device evidence track.
- Plan: Run the clean baseline and red tests; implement Phase A and push a checkpoint; implement Phase B and push; implement Phase C and push; implement Phase E and push; implement Phase D as its own wire-contract commit; run final gates and document all unverified real-device items.
- Owned files: `src/inbound/store.mjs`, `src/control-surface/`, `src/interaction/ledger.mjs`, `src/ledger.mjs`, `src/routing/session-registry.mjs`, related inbound/router modules, `client.js`, tests, changelog and workstream state files required by the remediation pack.
- Do not touch: provider-specific real-device behavior or claim Phase F items as fixed; do not rewrite `store.delete()` return semantics; do not retag or republish `0.12.0`.
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; remediation-pack phase tests and `99-GATES/verify-all.mjs`.
- Adversarial review: Challenge durable-write false/undefined semantics, partial in-memory mutation, malformed state recovery, alias round-trips, request races, unbounded inputs, stale snapshots, and accidental wire-contract changes outside Phase D.
- Handoff: complete for the code work; every phase checkpoint was pushed to `origin/dev`. Full `npm test` closeout was not claimed because an existing integration path attempted a real DingTalk API call; targeted pack tests and static gates are recorded, and Phase F remains explicitly open.
