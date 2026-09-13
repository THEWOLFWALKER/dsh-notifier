# Workstream: Claude Code progress monitor design

- Agent identity: `progress_monitor_terra | Codex | Windows desktop`
- Agent: `progress_monitor_terra`
- Branch: `codex/maintenance-architecture`
- Status: `done`
- Start/end: `2026-08-25 -> 2026-08-25`
- Scope: Read-only design for a local viewer of Claude Code session progress; no DSH runtime or `src/` changes.
- Plan: (1) inspect the live Claude process and its on-disk session/task artifacts; (2) separate supported/observable JSONL data from terminal-output capture; (3) propose a minimal wrapper + static polling viewer and record risks; (4) hand recommendations to the parent agent.
- Owned files: `.agents/workstreams/claude-progress-monitor.md`
- Do not touch: `src/`, public remote, existing Claude process, DSH runtime/configuration.
- Validation: read-only process/file inspection; no second Claude session started.
- Adversarial review: Claude Code currently exposes JSONL under `%USERPROFILE%\\.claude\\projects\\...` and status/task files, but these are implementation artifacts with no stability contract. A viewer must treat malformed/truncated lines, rotation, session termination, stale PID/status, secret-bearing prompts/tool output, and concurrent writes as normal. A wrapper around future `claude` invocations (`claude ... 2>&1 | Tee-Object -FilePath <temp log>`) is the only deterministic stdout/stderr pipeline; it cannot retroactively capture the already-running interactive process and should never drive control input.
- Handoff: Design-only result; no runtime code commit. Recommended MVP location is outside production `src/` (for example `tools/claude-monitor/` or `%TEMP%\\dsh-claude-monitor`), binding HTTP to loopback only. Parent agent should decide whether the small wrapper/static viewer is worth implementing after reviewing privacy and schema risks. Recorded in commit `a0c37d1` and pushed to private `codex/maintenance-architecture`.
