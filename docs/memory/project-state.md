# Project State

Snapshot date: 2026-08-19.

- Canonical branch: `codex/knowledge-baseline`.
- Canonical source commit: `3fc3f24` (`chore: import dsh-notifier v0.8.5 baseline`).
- Package version: `0.8.5`.
- Test baseline: `885` total tests. On `2026-08-19` Windows validation, `881` passed and `4` desktop adapter tests failed because the environment could not provide the BurntToast/PowerShell desktop notification capability; non-desktop coverage passed.
- Engineering archive: source authority. Attached npm archive: release artifact only.
- Artifact observation: the two archives share source/tests/package metadata; `CHANGELOG.md` is the only common-file difference.
- Workspace policy: no `node_modules/`, `package-lock.json`, credentials, state files, or generated logs in Git.
- Release status at this snapshot: source is prepared for the normal `0.8.5` release gate; registry publication must be verified independently.

## Validation Evidence

- `npm test`: `881 pass`, `4 fail`, `885 total`; failures are limited to `test/desktop.test.mjs` and are an environment capability gap, not a source assertion regression.
- `node scripts/verify-release.mjs`: passed for package `0.8.5` and documented contract count `885`.

## Current Maintenance Direction

- No new user-facing features are planned for the current cycle. Work is limited to technical debt, bug elimination, protocol/host validation, and documentation truth.
- The ordered queue is `docs/TECHNICAL_DEBT.md`; P0 release truth and artifact acceptance precede P1 protocol/error/concurrency work.

## Next Gate

Run the full tests and `node scripts/verify-release.mjs`, inspect `npm pack --dry-run --json`, then perform disposable-profile registry validation before publishing. Update this file with the actual registry version and final commit after that gate.
