# Workstream: release-readiness-audit

- Agent: `root`
- Branch: `codex/plugin-security-hardening`
- Status: done
- Scope: Reconcile collaboration/release facts, audit tracked and npm package contents, and prepare a safe GitHub/npm release handoff without changing product behavior.
- Plan: 1. Inventory tracked files, docs, package contents, and sensitive-material exposure. 2. Correct stale collaboration, security, and release documentation. 3. Compare the branch with the GitHub remote and push only a review branch. 4. Authenticate npm through its web flow and confirm the candidate package/version before publication. 5. Perform adversarial review and full release validation.
- Owned files: `.agents/workstreams/release-readiness-audit.md`, `AGENTS.md`, `.agents/README.md`, `docs/KNOWLEDGE_BASE.md`, `docs/memory/decisions.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`, `docs/security/PLUGIN_ATTACK_REVIEW.md`, `docs/v0.6-design.md`, `README.md`, `README.zh-CN.md`, `scripts/verify-release.mjs`, `package.json`, `CHANGELOG.md` only if evidence requires a release-metadata correction.
- Do not touch: source modules and tests reserved by implementation workstreams.
- Validation: `npm pack --dry-run --json`, package/secrets scans, `npm test`, `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, `git diff --check`.
- Adversarial review: challenge stale truth sources, private or internal files in the npm tarball, credential leakage, version/document split, and unsafe remote-history assumptions.
- Adversarial review: Completed. Confirmed no credential-shaped material in tracked files, no `.agents/`, security reports, handoff, screenshots, or local state in the npm manifest; retained `test/` and `scripts/` because the package contract and `npm test` depend on them. Confirmed local and remote `main` histories are unrelated and rejected any implicit merge or force-push.
- Handoff: Collaboration authority, repository facts, 890-test documentation, A1/A2 security status, and release metadata are synchronized. Release guard, channel matrix, syntax, diff checks, and npm dry-run pass. npm authentication and publication remain external gates; no package was published in this workstream.
