# Workstream: plugin-security-a1-a2

- Agent: `terra-security-implementer`
- Branch: `codex/plugin-security-hardening`
- Status: done
- Scope: Implement only A1 event redaction and A2 directed-send audit unification inside dsh-notifier.
- Plan: Read the security fix plan and existing public/notify tests; patch source and focused tests; update PLUGINS.md and CHANGELOG.md; run focused tests and syntax checks; report residual concerns without changing A3-A6.
- Owned files: `src/index.mjs`, `src/notify.mjs`, `src/public.mjs`, `test/public.test.mjs`, `test/notify.test.mjs`, `PLUGINS.md`, `CHANGELOG.md`, this workstream file.
- Do not touch: `docs/security/PLUGIN_ATTACK_REVIEW.md`, `docs/security/PLUGIN_SECURITY_FIX_PLAN.md`, `docs/KNOWLEDGE_BASE.md`, `docs/memory/risks.md`, or unrelated source/tests.
- Validation: `node --test test/public.test.mjs test/notify.test.mjs`, `node --check src/index.mjs`, `git diff --check`.
- Adversarial review: no raw message content or reversible encoding in cross-plugin events; exactly one audit callback for direct sends; caller result compatibility; sink failures isolated; no duplicate broadcast records.
- Handoff: A1/A2 implemented without changing DSH host or A3-A6. Internal `onSend` records retain normalized `message` for ledger/admin compatibility; `ctx.emit` projects a frozen metadata-only record. Directed and rate-limited public sends use the same audit callback exactly once. Focused tests and syntax/diff checks passed; full `npm test` remains parent-agent validation.
