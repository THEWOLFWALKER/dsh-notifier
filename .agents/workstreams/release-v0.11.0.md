# Workstream: release-v0.11.0

- Agent identity: `root | TraeCode agent | remote sandbox (linux)`
- Agent: `root`
- Branch: `dev` (direct small commits; the `codex/<topic>` workflow is deprecated for this line per the v0.11 owner instruction)
- Status: `done`
- Start/end: `2026-09-25 -> 2026-09-25`
- Scope: Finalize the v0.11.0 release on `dev` and prepare the `dev -> main` promotion: version/test-count metadata, CHANGELOG close-out, bilingual + memory documentation sync, and the six release gates. No runtime code change.
- Plan:
  1. Confirm the measured full-suite count (`npm test`) and reconcile it with `package.json.dshQuality.testCount`, README badges, and HANDOFF.
  2. Close `CHANGELOG.md` `[Unreleased]` into `## [0.11.0] - 2026-09-25` with a W0 / host-alignment / W1-W6 summary.
  3. Sync version + test baselines across README (en/zh), HANDOFF, KNOWLEDGE_BASE, OPERATIONS, TECHNICAL_DEBT, ROADMAP, and `docs/memory/project-state.md`.
  4. Archive the temporary v0.11 planning inputs and re-check the release gates.
- Owned files: `package.json`, `src/admin/ui/markup.mjs`, `CHANGELOG.md`, `README.md`, `README.zh-CN.md`, `HANDOFF.md`, `docs/{KNOWLEDGE_BASE,OPERATIONS,ROADMAP,TECHNICAL_DEBT,taskbook-v0.11,repair-plan-v0.11}.md`, `docs/memory/project-state.md`, `scripts/gen-channel-matrix.mjs`
- Do not touch: `src/**` runtime modules, `test/**` (no behavior change in a release-metadata pass)
- Validation:
  - `npm test` -> **1816 total / 1816 pass / 0 fail** (Linux/CI checkout)
  - `node scripts/verify-release.mjs` -> `release guard ok: dsh-notifier v0.11.0, documented tests=1816`
  - `node scripts/gen-channel-matrix.mjs --check` -> `OK: README 渠道矩阵与注册表一致（28 渠道）`
  - `node --check src/index.mjs` -> ok; `git diff --check` -> clean
  - `npm pack --dry-run --json` -> 243 entries; required payload present (`types/index.d.ts`, `PLUGINS.en.md`, `docs/compatibility-matrix.md`, `docs/upgrade-guide.en.md`, `src/testing.mjs`, `scripts/verify-host-compat.mjs`, `CHANGELOG.md`); no `examples/`, `.agents/`, `HANDOFF.md`, or `ADAPTER.md` leakage
- Adversarial review:
  - Caught a **pre-existing release-gate failure**: `gen-channel-matrix --check` was red at HEAD because the Qmsg 3.0 v3 migration (`f16fa9e`) updated `README.md` but not the generator's `META`. Since the matrix is generated, hand-editing README is not durable; fixed the single source of truth (`META.qmsg.auth -> 'key (+ optional group, v3)'`) and regenerated, keeping the bilingual rows aligned.
  - Verified `dshQuality.testCount` matches the *measured* 1816 rather than a carried-over number, and that every guarded marker (badge / test text / metadata version / HANDOFF row) agrees — `verify-release` enforces this mechanically.
  - W7/W8/W9/W10 are explicitly and consistently recorded as deferred in CHANGELOG, ROADMAP, HANDOFF, and `memory/project-state.md`, so the released v0.11.0 scope is not overstated.
  - Kept the temporary planning docs as archived history (status banners) rather than deleting content the owner may still want; neither is in the npm payload.
- Handoff: v0.11.0 release metadata and documentation are synced and all six gates pass on `dev`. Release commit `8fc099f`. Remaining owner-gated steps (not performed here): `git push origin dev`, merge `dev -> main`, tag `v0.11.0`, `npm publish`, and the ecosystem listing refresh — these require the owner's credentials. Real-device / provider / real-host validation gaps are unchanged and remain in [risks.md](../../docs/memory/risks.md).