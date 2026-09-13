# Workstream: final-code-maintenance-luna-recovery

- Agent identity: `final-code-maintenance-luna-recovery | GPT-5.6 Luna | Windows desktop`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-27 -> 2026-08-27`
- Scope: Continue taskpack 07 from the existing hardening commits; verify Session Control Overlay runtime wiring and close compatibility/documentation evidence without real-device or public-release operations.
- Plan: (1) audit overlay resolver and focused integration evidence; (2) assess legacy YAML `allowUsers`, optional SDK lifecycle, and WxPusher multi-account behavior; (3) update only stale durable docs/workstream records; (4) run focused and required validation, then commit each logical topic.
- Owned files: this workstream, `docs/compatibility-matrix.md`, `docs/OPERATIONS.md`, `docs/TECHNICAL_DEBT.md`, `docs/memory/risks.md`, `docs/memory/project-state.md`, `docs/KNOWLEDGE_BASE.md`, `CHANGELOG.md`, and `HANDOFF.md` only where evidence requires synchronization.
- Do not touch: public repository, package version, credentials/state/generated artifacts, or already-landed source changes (`96f019a`, `649be45`, `fec2dcd`, `3155851`, `b154536`, `cb4499f`).
- Validation: focused overlay/compatibility suites; `npm test`; release guard; channel matrix check; `node --check src/index.mjs`; `git diff --check`; `npm pack --dry-run --json`.
- Adversarial review: challenge overlay resolver failures/async values/source-field injection, migration replay, SDK missing/version/reconnect/dispose behavior, and WxPusher account ambiguity.
- Handoff: Session overlay wiring was evidence-reviewed as already live in production assembly (`src/index.mjs` passes `registry.getControl` to `createControlEntry`). Existing integration tests prove admin/registry persistence affects Control Core authorization and reject malformed/unknown/async overlays. Added `docs/compatibility-matrix.md`, assessed P2-2/P2-3, documented WxPusher shared-`default` multi-app residual, corrected the stale Operations test count (`987a0d6`), and added explicit confirmation before destructive pairing-code revocation in the admin UI (`8d46168`). The settlement/accountId compatibility fixes and focused UI regressions are included in `49786ad`; final documentation synchronization is `b38a04b`, with P1-4 debt closure in `5727461`.
- Focused tests: overlay/SDK/provider suites 128/128 pass; `node --test test/admin-ui-behavior.test.mjs` 33/33 pass after destructive pairing-code revoke confirmation and settlement/accountId checks.
- Full validation rerun: `npm test` 1352 total (1351 pass + 1 skip); `verify-release` passed (v0.8.6 / 909), channel matrix passed (27), `node --check src/index.mjs`, `git diff --check`, and `npm pack --dry-run --json` passed (193 package entries, no bundled dependencies).
- Desktop ask_user assessment: no host desktop settlement/event contract exists in this repository. Approval and question desktop paths intentionally return `next()`/desktop fallback; adding a new desktop endpoint would invent a second authorization surface, so no speculative code was added. Existing admin settle remains the only non-mobile entry and routes through Control Core.
- Residual risks: no real-device, tenant, host-protocol, or npm registry acceptance was performed; optional SDK and WxPusher multi-account behavior remain contract/documented only.
- Push note: private remote push was attempted for `b38a04b`/`5727461` but GitHub connectivity to port 443 was unavailable on this host; no public remote operation was attempted.
