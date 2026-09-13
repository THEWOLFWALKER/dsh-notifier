# Workstream: issue16-host-events

- Agent identity: `terra_issue16_host | gpt-5.6-sol | Codex desktop`
- Agent: `terra_issue16_host`
- Branch: `codex/issue16-host-events`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Make DSH host event registration root-context compatible and observable without changing interaction semantics.
- Plan: 1) verify Cordis/DSH event and scope APIs; 2) centralize root-context feature fallback, diagnostics, and payload normalization; 3) wire session and agent lifecycle listeners; 4) test failure, scope, payload, and duplicate paths; 5) adversarial review and release gates.
- Owned files: `.agents/workstreams/issue16-host-events.md`, `src/host-events.mjs`, `src/event-listener.mjs`, `src/routing/session-registry.mjs`, `test/host-events.test.mjs`, `test/event-listener.test.mjs`, `test/session-registry.test.mjs`
- Do not touch: channel adapters, approval/question routers, release metadata, handoff, and public remote.
- Validation: `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`
- Adversarial review: Verified current Cordis source exposes a self-referential `ctx.root`; non-Cordis `root` services are rejected. Verified current DSH source documents `session/event(session, event)` and `{ agent }` lifecycle payloads, and dsh-scope's `Symbol('dsh.scope')` tag is inspected only as tagged/untagged. Root fallback is subscription-local and never uses `global: true`; malformed payloads are rejected, callbacks and registration failures are contained, diagnostics are bounded and metadata-only, and normal event dedup remains in the listener. Existing `questions.enabled` wiring test continues to prove `ask_user` is separately registered; this batch does not alter desktop/provider behavior.
- Handoff: Added `src/host-events.mjs` and routed session/event plus agent lifecycle/error/dispose subscriptions through a feature-detected Cordis root context. DSH 0.1.1-rc.2 runtime delivery remains device/protocol dependent: no local host was available, so Issue #16 is code/contract hardened but not eligible to close from this evidence alone. Validation passed: focused host/event/index suites (87 pass, 1 skip); `npm test` (1159 pass, 1 skip); release guard; channel matrix check; `node --check src/index.mjs`; `node --check src/host-events.mjs`. Commit: `cbb444f` (amended handoff record follows).
