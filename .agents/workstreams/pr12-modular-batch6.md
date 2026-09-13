# Workstream: pr12-modular-batch6

- Agent: Terra / Codex orchestration
- Scope: modular PR #12 reimplementation on top of Control Core; QQ button transport, approval/question callbacks, explicit `approval.parallel`.
- Status: implementation complete; real QQ protocol/device verification pending.
- Files: `src/inbound/qq-gw.mjs`, `src/approval/router.mjs`, `src/questions/router.mjs`, focused QQ tests.
- Safety: callbacks use explicit key + single-use token + channel/chat/user checks. QQ group targets never receive actionable buttons; text fallback is used. `parallel` is opt-in and defaults off; promise rejection is converted to fail-closed timeout.
- Validation: QQ focused tests and full validation must be recorded before handoff.
- Known limits: QQ payload shape and interaction permission behavior are contract-tested/mocked only; do not mark real-device-verified.
