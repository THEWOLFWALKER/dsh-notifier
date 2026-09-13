# Workstream: task-03-session-arbiter

- Agent identity: `codex | shared Windows workspace`
- Branch: `codex/control-core-restart`
- Status: `done`
- Scope: provider-neutral session policy, exact source binding, command precedence, revoke/expiry, bounded audit, and idempotent disposal.
- Files: `src/control/session-arbiter.mjs`, `test/session-arbiter.test.mjs`, this record.
- Deliberately not touched: IM adapters, admin UI, approval/questions routers, QQ buttons, and `approval.parallel`.
- Validation: focused session-arbiter tests 6/6; full repository gate follows this commit.
- Review: empty policy cannot act as wildcard; settlement deduplication is by event id; all source dimensions are exact; failed settlement is retryable and exceptions return desktop fallback.
- Handoff: next batch may design admin UX on top of this provider-neutral layer. Real-provider validation remains open.
