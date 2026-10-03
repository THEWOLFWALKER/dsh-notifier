# Workstream: v015-stage3-final

- Agent identity: Codex | GPT Work | Linux
- Branch: dev (explicit owner instruction)
- Status: active
- Baseline: remote 4066cf4; offline Stage 2 imported as 830d7b5 without rewriting remote history.
- Scope: TASKPACK DSH-NOTIFIER-V015-STAGE2-REVIEW-STAGE3-FINAL-V1 only.
- Plan: P0 account-aware current task, instance generation, durable Cloud jobs and secret references, leaf test count; P1 daily legacy cleanup; P2 private-only and copy; P3 fault/capacity; P4 docs/screenshots/package; P5 full gates.
- Owned files: current-task/router/conversation, runtime manager, Cloud deployment, native actions/read-model, client, tests, developer/user documentation, package guards.
- Risks: ambiguous legacy identity, stale async completion, remote success/local failure, duplicate secret authority, obsolete UI tests.
- Validation: focused behavior tests and diff review per phase, push dev each phase; full test after P0 and at P5; DOM, release/channel/host/package checks at P5.
- Review: no main/tag/publish/force; retain protocol assets and synchronous Store; ambiguous state fails closed.
- Handoff: import focused tests 54/54; continuing P0.

- P0: 6f33b87 pushed; 2510 full leaves (5 obsolete assertions updated), focused 56/56 green.
- P1: deleted 26 old Native components, 212 unused locale entries, isolated compatibility dispatch, recovery console report-only.

- P1: afb069a pushed; focused 52/52, release/private DOM 17/17.
- P2: common pre-routing private admission; six provider negative cases; copy gate expanded; focused 92/92 and DOM 41/41.

- P3: fault/capacity focused 166/166; real rename contention, runtime disposal/caps, 1000 local HTTP sends, 500 private events, Cloud restart and receipt failure; external account evidence BLOCKED (documented).
