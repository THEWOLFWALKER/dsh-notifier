# Workstream: release-v0.9.0

- Agent identity: `root | Codex primary`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Scope: Promote the reviewed development line to the v0.9.0 release line, relay it to the private development repository, sync the filtered public mirror, and complete authorized ecosystem updates without exposing credentials.
- Changes: package/UI version 0.9.0; release test contract 1352 (1351 pass + 1 skip); bilingual README, CHANGELOG, HANDOFF, KNOWLEDGE_BASE, and project-state synchronized.
- Public mirror allowlist: runtime `src/`, tests `test/`, tooling `scripts/`, `.github/`, user/release docs and root package metadata only. Never copy `.agents/`, `.codex/`, `.claude/`, `.opencode/`, credentials, state, logs, `node_modules/`, or `package-lock.json`.
- Validation already observed: `npm test` 1352 total / 1351 pass / 1 skip; release guard, channel matrix check, syntax check, diff check, and npm pack dry-run pass.
- Private relay: pushed successfully on 2026-08-27; `private/main` and `private/codex/stage5-wechat-ilink-hardening` now point to `12f7c2d`.
- Public mirror: `codex/public-v0.9.0-mirror` at `1415d7d` was pushed to `origin/main` on 2026-08-27; it contains the v0.9.0 allowlisted source/test/docs mirror and no forbidden internal files.
- Cleanup: superseded `docs/v0.5-design.md` and `docs/v0.6-design.md` were removed from the private tree and public staging; `architecture.md` and `architecture-roadmap.md` are the maintained design references.
- External status: resolved issues were replied to and closed; unresolved #3/#5/#14/#16 remain open; PR #12 remains open with an integration explanation. npm `0.9.0` is published with `latest` pointing to `0.9.0`. Awesome DSH listing refresh is submitted as PR #3490. The public repository description and discovery topics now reflect v0.9.0; dshfind will pick up the same metadata on its next scheduled sync (its current snapshot may remain cached until then).
