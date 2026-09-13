# Workstream: task-02-control-contract

- Agent identity: `terra_batches_0_1_2 | terra | shared Windows workspace`
- Agent: `terra_batches_0_1_2`
- Branch: `codex/control-core-restart`
- Status: `done`
- Start/end: `2026-08-25 -> 2026-08-25`
- Scope: add a pure normalized control event/receipt compatibility facade; no provider transport or arbitration.
- Owned files: `src/control/contract.mjs`, `test/control-contract.test.mjs`, this workstream record.
- Do not touch: QQ/IM adapters, admin UI, question/approval routers, `approval.parallel`.
- Contract: required non-empty event/session/source/channel/account/user/chat/policy/command/timestamps; commands stop/question-answer/approval/steer/ordinary-message; receipts accepted/rejected/expired/already_handled/transport_failed/desktop_fallback.
- Validation: focused `node --test test/control-contract.test.mjs` (7/7); `node --check src/control/contract.mjs`; full `npm test` (1131 pass + 1 skip); `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`.
- Adversarial review: malformed/unknown/invalid/future timestamps, missing chat, wrong source, stale policy, expired and resolved rows, duplicate/replay, lookup/store/handler exceptions, secret-free receipts, first-valid-wins covered. No wildcard chat or global user matching.
- Handoff: facade is callback-based and deliberately does not mutate existing ledgers; parent must run full npm/release/channel gates before integration with session arbiter.
