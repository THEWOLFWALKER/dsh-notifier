# Workstream: telegram-assembly-account

- Agent identity: `tg_assembly_account | GPT-5.6-terra | Codex desktop`
- Agent: `tg_assembly_account`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: `done`
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Preserve configured Telegram accountId through inbound assembly and callback envelopes.
- Plan: Inspect assembly/transport contracts; patch accountId forwarding; add focused assembly regression test; run focused and required validation; update handoff record and commit.
- Owned files: `src/assembly/inbound-channels.mjs`, `test/assembly-runtime.test.mjs`, `.agents/workstreams/tg-assembly-account.md`
- Do not touch: Other source, tests, release metadata, or docs outside this reservation.
- Validation: `node --test test/assembly-runtime.test.mjs`; `npm test`; `node --check src/index.mjs`.
- Adversarial review: Verify custom accountId is not derived from botToken and remains in message/callback envelopes; ensure default behavior remains intact.
- Handoff: Forwarded `tgRaw.accountId` into the Telegram facade config and added a real transport assembly regression covering message and callback envelopes. Focused Telegram/assembly tests, `node --check src/index.mjs`, and full `npm test` pass (1251 passed, 1 skipped). The unrelated concurrent edits in `src/approval/router.mjs`, `src/control/entry.mjs`, `src/inbound/feishu-bot.mjs`, and `test/control-entry.integration.test.mjs` were observed after the clean baseline and left untouched. Commit `d09e6a1` (amended after this record update).
