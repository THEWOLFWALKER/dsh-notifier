# Workstream: docs-sync-qq-fail-closed

- Agent identity: `Codex | GPT-5 | desktop workspace`
- Agent: `/root`
- Branch: `codex/docs-sync-qq-fail-closed`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Synchronize current QQ fail-closed, test-count, settlement, and validation facts without changing runtime code or release metadata.
- Plan: Audit current docs; update only stale current facts; run neat-freak review and release/channel/node guards; commit locally without pushing.
- Owned files: `README.md`, `README.zh-CN.md`, `HANDOFF.md`, `docs/KNOWLEDGE_BASE.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`, `CHANGELOG.md`, this workstream record.
- Do not touch: `src/`, `test/`, `package.json`, `package-lock.json`, credentials, state files, or public issue/remote state.
- Validation: `git diff --check`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; full `npm test` result carried from `c4fef26` as `1177 total = 1176 pass + 1 skip`.
- Adversarial review: Checked that published v0.8.6/909 remains distinct from the unreleased 1177/1176 development line; QQ C2C/GROUP/missing-chatType/unknown-source and `routeUnsafe` fail-closed wording is explicit; Web/admin and desktop settlement are not claimed as shared; real-device/host validation remains open.
- Handoff: Documentation-only sync; no runtime or package changes and no push. Local commit: `bc82b81` (`docs: sync qq fail-closed handoff facts`).
