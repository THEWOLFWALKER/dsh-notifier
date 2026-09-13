# Workstream: task-01-release-facts

- Agent identity: `terra_batches_0_1_2 | terra | shared Windows workspace`
- Agent: `terra_batches_0_1_2`
- Branch: `codex/control-core-restart`
- Status: `done`
- Start/end: `2026-08-25 -> 2026-08-25`
- Scope: reconcile current public issue/PR facts and private-vs-public release boundaries.
- Source query: `gh issue list --repo THEWOLFWALKER/dsh-notifier --state all --limit 20`; `gh pr list --repo THEWOLFWALKER/dsh-notifier --state all --limit 20`.
- Findings: latest open issues are #16 (session events/web profile), #15 (QQ heartbeat ACK), #14 (inbound images), #13 (admin token UX), #10 (admin entry); PR #12 remains open reference only; PR #9 is already merged in public mirror. #11 is closed.
- Runtime edits: none. Updated `HANDOFF.md`, `docs/KNOWLEDGE_BASE.md`, and `CHANGELOG.md` to record current statuses, PR #12 reference-only posture, and exact `hintTargets` wording.
- Validation: network query succeeded; full tests not rerun in this documentation-only pack.
- Handoff: no issue is claimed fixed solely from the public status query; historical changelog entries remain historical and are explicitly disambiguated.
