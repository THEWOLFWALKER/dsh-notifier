# Workstream: task-05-wechat-ilink

- Agent identity: Terra provider slice | GPT-5.6-terra | shared Windows workspace
- Agent: `/root/terra_wechat_ilink_batch4`
- Branch: `codex/task-05-wechat-ilink`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: single-account QR-first WeChat iLink transport/provider boundary with bounded polling, account-scoped state, text fallback, and explicit media evidence gating.
- Plan:
  1. Inventory the legacy iLink transport and preserve its public inbound contract.
  2. Add pure protocol normalization for QR status, bounded cursors, source/account envelopes, and known image fields.
  3. Add `src/channels/wechat-ilink/` provider entry and switch main assembly to it; keep old inbound path as compatibility entry.
  4. Make new-provider cursor/context/session keys account-scoped and commit cursors only after batch delivery.
  5. Add focused tests for expiry, cursor bounds, unknown-field isolation, image failure isolation, and account state.
  6. Review against fail-closed and no-real-device-claim gates; update docs and run all validation.
- Owned files: `src/channels/wechat-ilink/index.mjs`, `src/channels/wechat-ilink/protocol.mjs`, `src/inbound/wechat-ilink.mjs` (compatibility wiring), `src/index.mjs`, `test/channels/wechat-ilink.test.mjs`, `docs/test-notes/WECHAT-TEST.md`, `docs/memory/risks.md`, `CHANGELOG.md`, `HANDOFF.md`.
- Do not touch: Feishu, Telegram, QQ, PR #12, `approval.parallel`, public repository.
- Validation: `node --test test/channels/wechat-ilink.test.mjs test/inbound.wechat.test.mjs`; `npm test`; `node scripts/verify-release.mjs`; `node scripts/gen-channel-matrix.mjs --check`; `node --check src/index.mjs`; `git diff --check`.
- Adversarial review: checked cursor overlength/rejection, session QR expiry, account-scoped state cleanup, duplicate message IDs on reconnect, unknown payload fields, image-only and text+image messages, optional image download failure, and capability evidence labels. Found/fixed an image-only normalization undefined case and kept legacy capability shape unchanged.
- Handoff: provider slice implemented and locally validated. Text/QR/reconnect are `contract-tested`; media is optional and remains `declared` pending protocol/device evidence. Commit recorded after full validation.
