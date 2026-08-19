# dsh-notifier Agent Rules

## Source Of Truth

- Runtime truth is the tracked source under `src/` and its tests under `test/`.
- `package.json` is the package and version authority.
- `README.md` and `README.zh-CN.md` are user-facing entry points.
- `HANDOFF.md` is the detailed engineering snapshot; do not copy it into this file.
- `docs/KNOWLEDGE_BASE.md` is the documentation map. `docs/memory/` contains concise durable facts, not a second implementation spec.
- The npm package archive is an output. It never overrides the engineering tree.

## Hard Boundaries

- Preserve the zero-runtime-dependency design: use platform `fetch`, `node:*`, and native WebSocket; optional dependencies stay optional and lazy-loaded.
- A failed or missing notification channel must not break startup or other channels.
- Every listener and assembly block is defensive: catch failures, log through the host logger and stderr where diagnostics matter.
- Approval, action, and question paths are fail-closed: timeout, malformed input, invalid token, wrong source, or any exception must return control to the desktop; silence never approves.
- Inbound access is denied by default. Identity is a `(channel, userId)` binding, not a global user string.
- Tokens are single-use and time-limited. A callback or reply must be scoped to its original channel/chat when the record carries source metadata.
- State writes must preserve unrelated keys, use the existing store locking/merge behavior, and never expose credentials in logs or API responses.
- The admin server binds to `127.0.0.1` only. Never weaken this in a convenience change.
- Behavior changes require focused tests, a full `npm test`, and a CHANGELOG entry with the review/security reason when applicable.
- Real HTTP shape, payload length, callback limits, and long-running connections require real-device or protocol-level validation; mocked fetch alone is insufficient.

## Working Tree And Branches

- Start every task with `git status --short --branch` and `git log --oneline -5`.
- Work on `codex/<topic>` branches. Do not develop directly on `main` or `master`.
- Keep the first baseline commit immutable. Group each follow-up by one logical concern.
- Do not mix source, release metadata, and unrelated cleanup in one commit.
- Before handoff, the working tree must be clean, the branch must identify its purpose, and the final commit list must be reported.
- Never commit `node_modules/`, `package-lock.json`, credentials, state files, `.log` files, or generated local artifacts.

## Multi-Agent Protocol

- Read `docs/KNOWLEDGE_BASE.md` and `docs/memory/README.md` before editing.
- Reserve a workstream by creating one file under `.agents/workstreams/` from `TEMPLATE.md`. Each agent owns its file and must not edit another agent's reservation.
- Agents may edit disjoint files in parallel. If two tasks touch the same file, the later task must rebase its reasoning on the current file rather than overwrite it.
- Every workstream records scope, files, tests, and handoff notes. Mark it `done` before the agent exits; keep only durable records, not chat transcripts.
- Prefer narrow commits. The parent agent integrates commits after checking `git diff`, tests, and version guards.

## Validation

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
```

For a channel change, also run the relevant adapter contract test and `node scripts/test-channel.mjs` with safe test credentials when available. For inbound changes, use the matching `test/inbound.*.test.mjs` suite and record any real-device gap in `docs/memory/risks.md`.

## Deep References

| Need | Read |
|---|---|
| Project map and source hierarchy | `docs/KNOWLEDGE_BASE.md` |
| Stable architecture and state flows | `docs/architecture.md` |
| Local operation and troubleshooting | `docs/OPERATIONS.md` and `docs/guide.md` |
| Version/release anti-split rules | `docs/VERSIONING.md` |
| Durable facts and decisions | `docs/memory/` |
| Existing detailed handoff | `HANDOFF.md` |
| Adapter contribution contract | `ADAPTER.md` |
| Plugin consumer contract | `PLUGINS.md` |
