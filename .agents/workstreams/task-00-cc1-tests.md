# Workstream: task-00-cc1-tests

- Agent identity: `terra_batches_0_1_2 | terra | shared Windows workspace`
- Agent: `terra_batches_0_1_2`
- Branch: `codex/control-core-restart`
- Status: `done`
- Start/end: `2026-08-25 -> 2026-08-25`
- Scope: migrate question fixtures to exact `(channel,userId,chatId)` hintTargets evidence without runtime changes.
- Owned files: `test/questions.test.mjs`, this workstream record.
- Do not touch: `src/questions/router.mjs`, inbound adapters, PR #12 paths.
- Validation: `node --test test/questions.test.mjs` (54/54 pass); focused CC-1/SEC-2/CRACK-004 suite (28/28 pass).
- Adversarial review: replaced channel-level delivered assumptions with valid provider-shaped chat ids and explicit per-chat send evidence; preserved fail-closed old-row, wrong-chat, missing-chat, partial-delivery, and alias tests.
- Handoff: test migration complete; full repository gates remain for parent agent. Commit pending in parent branch.
