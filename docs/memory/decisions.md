# Durable Decisions

## Source Versus Artifact

The engineering tree is authoritative. npm archives are generated outputs and may omit contributor-only files. An artifact mismatch is recorded and investigated; it never causes source files to be replaced by package contents.

## Release Integrity

Version, changelog heading, admin UI version, documented test count, and npm file allowlist must pass one mechanical guard before publishing. Registry installation and restart are required for real-machine acceptance.

## Multi-Agent Ownership

Agents share one working tree but reserve scope with one file per workstream under `.agents/workstreams/`. The parent agent integrates narrow commits after checking the current diff; agents must not reset or checkout other agents' work.

## Collaboration Authority

Tracked `.agents/` workstreams and `docs/memory/` are the authority for collaboration status, ownership, and durable decisions. Chat is a request channel, never a durable source of project state. Runtime truth remains `src/` and `test/`; package truth remains `package.json`.

## Security Defaults

Remote approval and remote questions fail closed. Timeout, malformed input, invalid token, wrong source chat, or any exception returns control to the desktop and never invents an answer.

## User-Centered Product Direction

Feature decisions start from the user's task and first-principles failure modes. Prefer mature, composable functionality, progressive disclosure, clear status, reversible actions, and actionable errors. Do not trade maintainability or safety for superficial feature breadth.

## Plan And Review Loop

Every change requires a written plan and follows `plan -> implement -> adversarial review -> revise -> validate`. Long-term work is staged around evidence and decision points; speculative infrastructure is deferred until a concrete user need justifies it.

## DSH Visual Consistency

The sub-agent console and admin GUI are part of the DSH product surface. Their visual tokens, density, navigation, responsive behavior, and interaction patterns must remain aligned with `src/admin/ui.mjs`; a parallel visual language is not acceptable.
