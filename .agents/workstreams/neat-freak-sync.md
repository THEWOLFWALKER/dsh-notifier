# Workstream: neat-freak-sync

- Agent identity: `Codex root | GPT-5 | Windows worktree 4010`
- Agent: `root`
- Branch: `codex/neat-freak-sync`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Reconcile current documentation and memory facts with the issue16-host-events development HEAD without changing runtime code.
- Plan: Update current baselines and capability/fallback wording; preserve published v0.8.6 and historical counts; add a dated unreleased changelog note; run documentation and repository checks.
- Owned files: `README.md`, `README.zh-CN.md`, `HANDOFF.md`, `docs/KNOWLEDGE_BASE.md`, `docs/architecture.md`, `docs/guide.md`, `docs/OPERATIONS.md`, `docs/VERSIONING.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`, `CHANGELOG.md`, this workstream.
- Do not touch: `src/`, `test/`, `package.json`, public repositories, GitHub issues.
- Validation: `git diff --check`; stale-current grep; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`.
- Adversarial review: Checked for accidental release-count changes, claims of real-device verification, stale "QQ image not wired" wording, and a missing Web/admin `ask_user` settlement path; retained historical 909/1111/1141/1165/1169 references only where they describe prior batches or release history, while recording 1174/1173+1 as the current HEAD result.
- Handoff: Documentation-only synchronization complete; current HEAD remains unreleased at 0.8.6/1174 (1173 pass + 1 skip), with real-device/host protocol validation pending. Commits: `59cb438` (docs sync), `53461dd` (workstream record). Not pushed per task instruction.
