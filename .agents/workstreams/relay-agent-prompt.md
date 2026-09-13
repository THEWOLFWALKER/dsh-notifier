# Workstream: relay-agent-prompt

- Agent identity: `root | Codex primary | Windows workspace`
- Agent: `root`
- Branch: `codex/plugin-security-hardening`
- Status: done
- Start/end: `2026-08-20 -> 2026-08-20`
- Scope: Make the relay bootstrap document an unambiguous first message that can be sent directly to a new development agent.
- Plan: 1. Compare the existing prompt with AGENTS.md and durable memory. 2. Add explicit identity, repository, plan/review, UX, security, validation, and handoff requirements. 3. Run adversarial documentation checks and neat-freak. 4. Commit and push the prompt and synchronized knowledge records.
- Owned files: `docs/RELAY_BOOTSTRAP_PROMPT.md`, `docs/KNOWLEDGE_BASE.md`, `HANDOFF.md`, `docs/memory/project-state.md`, `.agents/workstreams/relay-agent-prompt.md`.
- Do not touch: runtime source, tests, package version, npm artifacts, or the public release history.
- Validation: direct prompt phrase/path checks; read all tracked Markdown docs; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`.
- Adversarial review: checked that the prompt cannot silently select the public mirror, skip the plan/review loop, weaken security boundaries, omit identity-bearing records, or finish without private push and clean-tree confirmation. Fixed the unrelated-key wording and added the missing knowledge-base pointer.
- Handoff: Rewrote `docs/RELAY_BOOTSTRAP_PROMPT.md` as a direct first message for new agents, synchronized the knowledge index, `HANDOFF.md`, and project state. Adversarial documentation review and release guards passed. Relay commits: `e576088` (prompt) and `8ce3329` (handoff metadata). The private branch was pushed successfully; the final closeout commit is recorded in Git history.
