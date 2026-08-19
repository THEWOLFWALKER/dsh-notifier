# dsh-notifier Knowledge Base

This is the navigation page for humans and agents. It deliberately points to one authority per question instead of duplicating the whole handoff document.

## Current Baseline

- Canonical engineering baseline: Git commit `3fc3f24`, package version `0.8.5`.
- Baseline branch created for this handoff: `codex/knowledge-baseline`.
- Runtime: Node.js ESM, Node `>=22`, no build step, no production dependencies.
- Test contract: `885` total tests. The `2026-08-19` Windows run passed `881`; the four failures are the platform-dependent desktop adapter tests when BurntToast is unavailable. Release documentation retains `885` as the full contract count.
- The attached npm archive is a release artifact. The engineering archive is the source authority.

## Read Order

1. `AGENTS.md` for hard boundaries and collaboration rules.
2. `docs/memory/README.md` for durable project facts and decision hygiene.
3. `README.zh-CN.md` or `README.md` for user-visible capabilities and configuration.
4. `docs/architecture.md` for the stable module/data-flow map.
5. `docs/OPERATIONS.md` for start-up, state, admin, and release smoke checks.
6. `docs/TECHNICAL_DEBT.md` for the active no-new-features maintenance queue.
7. `HANDOFF.md` for detailed historical rationale, review findings, and known traps.
8. `CHANGELOG.md` for chronological changes; it is not a substitute for current rules.
9. `docs/security/PLUGIN_ATTACK_REVIEW.md` and `docs/security/PLUGIN_SECURITY_FIX_PLAN.md` for the hostile-plugin threat model and staged remediation ownership.

## Audience Map

| Surface | Audience | Keep here |
|---|---|---|
| `AGENTS.md` | Coding agents | Boundaries, workflow, commands, ownership rules |
| `README*.md` | Users | Install, configure, use, and capability overview |
| `docs/architecture.md` | Maintainers | Stable components, flows, state keys, trust boundaries |
| `docs/OPERATIONS.md` | Operators | Verification, troubleshooting, rollback, real-device checks |
| `docs/VERSIONING.md` | Release owners | Canonical version fields, package comparison, release gate |
| `docs/memory/` | Future agents | Short durable facts, decisions, and recurring risks |
| `HANDOFF.md` | Detailed successor context | Historical rationale and full engineering snapshot |
| `.agents/workstreams/` | Parallel agents | Temporary scope reservations and handoff notes |

The product, UX, planning, review-loop, and DSH GUI consistency contract is maintained in `docs/architecture.md` and summarized as agent-enforced rules in `AGENTS.md`.

## Capability Summary

- Outbound: 27 adapters through `createNotifier()`; level routing is `timeSensitive`, `active`, or `passive`.
- Inbound: Telegram, Feishu, QQ Bot, WxPusher, WeChat iLink, and DingTalk.
- Trust stack: identity bindings, pairing codes, HMAC token vault, callback references, inbound bus deduplication, source-chat checks, and first-arrival settlement.
- Agent integration: `notify`, `notify_test`, optional `ask_user`, public `ctx.notifier` facade, and `dsh-notifier/sent` events.
- Operations: JSON state store with key-level merge, cross-process lock, convergence reads, JSONL ledger, local admin API/UI, SSE event stream, route CLI, and channel login/test CLIs.
- Security posture: installed DSH plugins share the host process and must currently be treated as trusted code; notifier-specific leakage, audit, identity, and resource-bound fixes are tracked separately from DSH host isolation requirements.

## Authority Rules

- If docs and source disagree, inspect the source and tests, then update the stale document in the same change.
- If the engineering archive and npm archive disagree, keep the engineering tree as truth and record the artifact mismatch in `docs/memory/project-state.md`.
- If two agents produce competing edits, preserve both diffs until the parent agent resolves them; never silently reset or checkout another agent's work.
