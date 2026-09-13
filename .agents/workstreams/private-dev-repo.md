# Workstream: private-dev-repo

- Agent identity: `root | Codex primary | Windows workspace`
- Agent: `root`
- Branch: `codex/plugin-security-hardening`
- Status: done
- Start/end: `2026-08-20 -> 2026-08-20`
- Scope: Establish a private canonical development repository and record the serial relay rules for multiple tools and machines.
- Plan: 1. Inspect current GitHub visibility and authentication. 2. Document the private-development/public-release split and HANDOFF cadence. 3. Create `dsh-notifier-dev` privately and push the reviewed branch/baseline. 4. Configure Git to use the existing GitHub credential helper. 5. Validate repository state and leave a concise handoff.
- Owned files: `.agents/workstreams/private-dev-repo.md`, `AGENTS.md`, `docs/KNOWLEDGE_BASE.md`, `docs/memory/decisions.md`, `docs/memory/project-state.md`.
- Do not touch: runtime source, tests, package version, or public release history.
- Validation: `gh auth status`, `gh repo view`, `git ls-remote`, `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, `git diff --check`.
- Adversarial review: ensure public release repo is not treated as the private work queue, no token is written to Git/config/files, and the private remote contains the exact reviewed commit.
- Handoff: Created private canonical repository `https://github.com/THEWOLFWALKER/dsh-notifier-dev`; pushed the reviewed baseline `1fc396f`, then the relay/skill checkpoint `b0e6fbe` as both `main` and `codex/plugin-security-hardening`; configured the local `private` remote and `gh auth setup-git`; installed canonical `.agents/skills/neat-freak/` with Claude/Codex/OpenCode pointers; recorded relay and per-agent HANDOFF cadence rules. Public `origin` remains a release mirror.
