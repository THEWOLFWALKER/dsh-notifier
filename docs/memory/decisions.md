# Durable Decisions

## Source Versus Artifact

The engineering tree is authoritative. npm archives are generated outputs and may omit contributor-only files. An artifact mismatch is recorded and investigated; it never causes source files to be replaced by package contents.

## Release Integrity

Version, changelog heading, admin UI version, documented test count, and npm file allowlist must pass one mechanical guard before publishing. Registry installation and restart are required for real-machine acceptance.

## Multi-Agent Ownership

Agents share one working tree but reserve scope with one file per workstream under `.agents/workstreams/`. The parent agent integrates narrow commits after checking the current diff; agents must not reset or checkout other agents' work.

## Security Defaults

Remote approval and remote questions fail closed. Timeout, malformed input, invalid token, wrong source chat, or any exception returns control to the desktop and never invents an answer.
