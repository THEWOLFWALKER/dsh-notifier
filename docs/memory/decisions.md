# Durable Decisions

## Source Versus Artifact

The engineering tree is authoritative. npm archives are generated outputs and may omit contributor-only files. An artifact mismatch is recorded and investigated; it never causes source files to be replaced by package contents.

## Release Integrity

Version, changelog heading, admin UI version, documented test count, and npm file allowlist must pass one mechanical guard before publishing. Registry installation and restart are required for real-machine acceptance.

## Multi-Agent Ownership

Agents share one working tree but reserve scope with one file per workstream under `.agents/workstreams/`. The parent agent integrates narrow commits after checking the current diff; agents must not reset or checkout other agents' work.

## Collaboration Authority

Tracked `.agents/` workstreams and `docs/memory/` are the authority for collaboration status, ownership, and durable decisions. Chat is a request channel, never a durable source of project state. Runtime truth remains `src/` and `test/`; package truth remains `package.json`.

## Repository Roles And Relay Cadence

The single repository `THEWOLFWALKER/dsh-notifier` hosts two branches with distinct jobs: `dev` for development and `main` for releases. Every agent completion records identity, scope, files, tests, review, risks, next step, and commit in its workstream, then refreshes the consolidated current handoff snapshot in `HANDOFF.md`; `docs/memory/` carries only durable facts and decisions.

## Security Defaults

Remote approval and remote questions fail closed. Timeout, malformed input, invalid token, wrong source chat, or any exception returns control to the desktop and never invents an answer.

## User-Centered Product Direction

Feature decisions start from the user's task and first-principles failure modes. Prefer mature, composable functionality, progressive disclosure, clear status, reversible actions, and actionable errors. Do not trade maintainability or safety for superficial feature breadth.

## Plan And Review Loop

Every change requires a written plan and follows `plan -> implement -> adversarial review -> revise -> validate`. Long-term work is staged around evidence and decision points; speculative infrastructure is deferred until a concrete user need justifies it.

## DSH Visual Consistency

The sub-agent console and admin GUI are part of the DSH product surface. Their visual tokens, density, navigation, responsive behavior, and interaction patterns must remain aligned with `src/admin/ui.mjs`; a parallel visual language is not acceptable.

## Cross-IM Control Plane Direction

The planned product direction is a DSH cross-IM mobile control plane, not a notification-only fan-out. The control core must own session commands, permissions, approvals, questions, conversation, and delivery receipts; channel adapters own transport and native rendering. The staged direction and channel roles are authoritative in `docs/architecture-roadmap.md`.

## Personal Mode Defaults

Personal mode is the default onboarding path: one paired owner identity, `observe + approve` enabled, and `converse` opt-in. Team roles, workspace/session ACL, TTL, and audit controls are progressive disclosure. Group-chat control is disabled by default and is not a supported sensitive-action surface.

## WeChat iLink Scope

WeChat iLink starts as a single-account, QR-first personal channel. Internal account boundaries remain so credentials and context tokens cannot cross-contaminate, but multi-account configuration is deferred. The preferred reference is the MIT-licensed Tencent `openclaw-weixin` implementation; iLink remains an undocumented, changeable backend protocol and must not be described as a stable public API.

## Optional SDK Acceptance

An external SDK may be used only when its source/package license is clear, maintenance is active, security behavior is reviewable, and it can be lazy-loaded without making runtime dependencies mandatory. Unlicensed projects and `UNLICENSED` connectors are design references only, never copied or redistributed.
