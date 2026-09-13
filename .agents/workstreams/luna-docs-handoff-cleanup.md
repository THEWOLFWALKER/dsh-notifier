# Workstream: luna-docs-handoff-cleanup

- Agent identity: `Luna | GPT-5 | Codex desktop`
- Agent: `luna`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-27 -> 2026-08-27`
- Scope: Reconcile user-facing and maintainer Markdown with the 0.8.6/current development line; retire completed execution taskpacks and stale test notes; keep the public README concise, capability-led, and synchronized in English and Chinese.
- Plan: (1) inventory Markdown and stale facts/links; (2) edit current docs and memory; (3) remove completed taskpacks/test notes after checking replacement coverage; (4) adversarially review claims, links, and relative dates; (5) run Markdown/reference checks; (6) commit one logical documentation cleanup.
- Owned files: `HANDOFF.md`, `CHANGELOG.md`, `README.md`, `README.zh-CN.md`, `docs/KNOWLEDGE_BASE.md`, `docs/TECHNICAL_DEBT.md`, `docs/guide.md`, `docs/OPERATIONS.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`, `docs/agent-taskpacks/README.md`, `docs/agent-taskpacks/00-*.md` through `07-final-code-maintenance-luna.md`, `docs/test-notes/TG-TEST.md`, `docs/test-notes/WECHAT-TEST.md`, this workstream.
- Do not touch: `src/`, `test/`, `package.json`, files owned by other active workstreams, public remotes.
- Validation: `npm test` (1352 total, 1351 pass + 1 skip); `node scripts/verify-release.mjs` (pass, documented release contract 909); `node scripts/gen-channel-matrix.mjs --check` (pass, 27); `node --check src/index.mjs` (pass); `git diff --check` (pass); PowerShell local Markdown-link scan (pass); deleted-entry reference scan (pass); relative-time scan of maintained docs (pass).
- Adversarial review: Removed stale execution-entry references and old TG/WeChat test-note links; release guard required preserving the 909 package-contract marker; confirmed README.md and README.zh-CN.md carry matching badges, links, feature claims, and positive fallback wording without internal validation-gap language; engineering docs retain the full risk record; checked local Markdown links after deletions.
- Handoff: Deleted completed `docs/agent-taskpacks/00-cc1-test-migration.md`, `00-host-event-compat.md`, `01-release-facts-cleanup.md`, `02-control-contract.md`, `03-session-arbiter.md`, `04-admin-ux.md`, `05-wechat-ilink.md`, `06-team-policy-contract.md`, `07-final-code-maintenance-luna.md`, plus `docs/test-notes/TG-TEST.md` and `WECHAT-TEST.md`. Rewrote/updated `HANDOFF.md`, `docs/KNOWLEDGE_BASE.md`, `docs/TECHNICAL_DEBT.md`, `docs/memory/project-state.md`, `docs/memory/risks.md`, `README.md`, `README.zh-CN.md`, `docs/guide.md`, `docs/OPERATIONS.md`, `CHANGELOG.md`, and taskpack README. Documentation cleanup commit: `47c5296`; README packaging follow-up is included in the current working tree.
