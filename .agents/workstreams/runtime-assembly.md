# Workstream: runtime-assembly

- Agent identity: `Codex | GPT-5 | local desktop`
- Agent: `root`
- Branch: `codex/runtime-assembly`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Extract only high-cohesion runtime assembly from `src/index.mjs` and add focused lifecycle/import regression coverage without changing behavior.
- Plan: 1) inventory index assembly and tests; 2) extract 1-2 bounded modules; 3) add focused tests; 4) adversarial review and full validation; 5) refresh handoff and commit.
- Owned files: `src/index.mjs`, new runtime assembly module(s), focused tests, this workstream record, `HANDOFF.md`.
- Do not touch: README files, CHANGELOG, UI code, channel transport semantics, unrelated workstream files.
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; focused assembly tests.
- Adversarial review: Moved only transport start/registry and aggregate lifecycle cleanup. Checked optional factory throws, start-time allocation cleanup, repeated host cleanup, async disposer settling, and preserved 127.0.0.1 admin path and existing provider/control boundaries. No approval/question semantics moved into the registry.
- Handoff: Added `src/assembly/inbound-channels.mjs` and `src/assembly/lifecycle.mjs`; `src/index.mjs` delegates transport registry and disposer aggregation while retaining all control semantics. Focused `test/assembly-runtime.test.mjs` plus `test/index.test.mjs` pass. Full `npm test` passes 1173 with 1 win32 skip; release/channel matrix/syntax guards pass. HANDOFF/README/CHANGELOG intentionally untouched per task scope. Commit: `707d57b`.
