# Workstream: stage5-wechat-ilink-hardening

- Agent identity: Provider-slice hardener | Claude Code (claude-fable-5) | shared Windows workspace
- Agent: `stage5-wechat-ilink-slice`
- Branch: `codex/stage5-wechat-ilink-hardening`
- Status: done
- Start/end: `2026-08-26 -> 2026-08-26`
- Scope: Single-account QR-first WeChat iLink provider slice hardening — close the code-level contracts for QR grouping fail-closed, bounded cursor retention, at-least-once cursor advance, bounded reconnect, reconnect-duplicate non-re-execution, account-scoped transport state, session-expiry qr-required, image-failure isolation, unknown-field isolation, and imageSend declared.

## Plan (implemented)

1. Inventory Stage-4 provider slice + tests; confirmed 9 of the ten goals were already contract-satisfied by `src/channels/wechat-ilink/index.mjs` + `legacy-core.mjs` + `protocol.mjs`; the one real behavioral gap was at-least-once cursor advance.
2. Fixed the behavioral gap in `legacy-core.mjs` `pollLoop`: added `fullyConsumed` flag — cursor advances only after every message in the batch was handled without throwing. A per-message handler throw now keeps the last usable cursor (with a loud warn) so the provider re-replays the same batch on the next poll. Already-consumed commands are de-duplicated by the bus by messageId, so replay never double-executes. This makes the pre-existing comment `先处理整批，再推进游标` actually true.
3. Added focused adversarial tests (see below) in `test/channels/wechat-ilink.test.mjs` and `test/inbound.wechat.test.mjs`.
4. Ran focused tests, full `npm test`, `verify-release`, `channel-matrix --check`, `node --check src/index.mjs`, `git diff --check`.
5. Committed only the WeChat slice + its two test files + this workstream.

## Adversarial review output (contract-by-contract)

| Goal | Where locked | Evidence |
|---|---|---|
| QR states/expiry rescan | `normalizeQrStatus` (`protocol.mjs`) | QR status matrix test: wait/scaned/redirect/confirmed/expired normalized; unknown/null fails closed with rescan guidance; timeout→expired, success→confirmed aliases |
| Bounded cursor rejection | `boundedCursor` + `batch.cursorRejected` + poll keep-old | unit test + overlong/illegal-cursor poll test: 4097-byte cursor → rejected, next poll still sends `GOOD_CURSOR`; reject must warn |
| At-least-once cursor advance | `pollLoop fullyConsumed` (code change, this workstream) | at-least-once test: CTRL handler throw keeps old cursor (`sent[1] === ''`), re-poll executes CTRL exactly once, cursor then BUF_C → BUF_D; warn must fire |
| Bounded reconnect | backoff logic `failures >= 3` + `retry/backoffDelayMs` | backoff test: sleeps == [1000,1000,5000,1000,1000], every sleep ≤ 5000, resets after a backoff |
| Duplicate-safe control delivery | bus de-dups by messageId | inflow test: reconnect/cursor-recovery replay of same batch executes control once, cursor still advances; at-least-once test asserts OK delivered twice / executed once |
| Account-scoped ctx/cursor | `accountScoped` key prefix `wechat:<accountId>:` | account-scoping test: only `wechat:ACC_A:*` written, never global `wechat:sync_buf` / `wechat:ctx:*`; context_token never enters Control Core envelope |
| Session expiry qr-required | `sessionExpired()` + `status()` | session-expiry test: state `qr-required`, `qrRequired:true`, clears account-scoped cursor/ctx/account + `wechat:account` global credential |
| Image failure isolation | `downloadImageBestEffort` non-blocking | oversize test (text delivered despite over-limit image, warn), timeout test (text delivered before 1000ms download timeout fires, warn), account-scoping failure test |
| Unknown-field isolation | `normalizeInboundMessage` / `normalizeUpdateBatch` strip unknown fields, fail-closed | unknown-fields test: injected_control/payload/type-999 never in envelope; kind/text/image shape |
| imageSend declared | `WECHAT_ILINK_CAPABILITIES.imageSend='declared'` | capability-evidence test |

## Test-authoring notes (non-obvious)

- The poll-loop `fetchImpl` in these slice tests must **park on a never-resolving abort-sensitive promise** after the scripted updates are exhausted (mirroring the real 35s long poll). Returning an immediate empty `get_updates_buf` triggers an infinite microtask spin that starves Node's timer phase — the `setTimeout` in the test never fires and the run hangs. All three originally-spinning tests (at-least-once, overlong cursor, backoff) were corrected to park after their scripted polls.
- `imageDownloadTimeoutMs` is a **top-level option**, not a `config` sub-key (read by `clampInt(options.imageDownloadTimeoutMs, …)` in `legacy-core.mjs`). The timeout test originally put it inside `config`, so the default 10000ms applied and the 1200ms assertion never saw the timeout warning; also left a 10s timer pending which delayed process exit. Fixed to pass `imageDownloadTimeoutMs: 1000` at the top level.

## Validation

- `node --test test/channels/wechat-ilink.test.mjs test/inbound.wechat.test.mjs` → 49 pass / 0 fail
- `npm test` → 1246 tests, 1245 pass / 0 fail / 1 skip (win32) — refreshed from 1230 baseline
- `node scripts/verify-release.mjs` → ok (v0.8.6, documented tests=909)
- `node scripts/gen-channel-matrix.mjs --check` → OK (27 channels)
- `node --check src/index.mjs` → SYNTAX_OK
- `git diff --check` → OK

## Commit

- Owned files only: `src/channels/wechat-ilink/legacy-core.mjs`, `test/channels/wechat-ilink.test.mjs`, `test/inbound.wechat.test.mjs`, this workstream. No assembly/routing/admin/docs/CHANGELOG/package-version touched. No public push.

---

## Second slice: protocol-preflight code adaptation (2026-08-27, same branch)

- Agent: Claude Code (Opus 4.8) | shared Windows workspace | branch `codex/stage5-wechat-ilink-hardening`.
- Scope: turn `docs/protocol-preflight/` evidence into code-layer channel adaptation + security closure, per the strict rules (no channel-as-accountId, no Control Core bypass, fail-closed on missing source fields, declared capabilities stay declared). Protocol docs are the only boundary; no real-device verification.

### Source fixes (each a separate commit)

1. **WxPusher local accountId** (`src/inbound/wxpusher-callback.mjs`): the only inbound among the six interactive channels whose envelope lacked an accountId. After Control-Core source-binding hardening, WxPusher approval/question numbered replies were consumed but never settled, and conversation routing used channel-as-accountId. Now `resolveWxpusherInboundConfig` carries optional `accountId`; `createWxpusherInbound` resolves `config.accountId ?? 'default'`, includes it in the envelope and the returned instance; never from the callback's `data.appId`.
2. **Remove channel-as-accountId fallbacks** (`src/inbound/conversation.mjs` route, `src/control/entry.mjs` `pendingMeta`) and forward the transport's local accountId from `actions.dispatch` into Control Core (was dropped). Missing accountId now fails closed with `missing_accountId`.
3. **Telegram/Feishu button callbacks pass provider eventId into Control Core** (`src/inbound/telegram-bot.mjs`, `src/inbound/feishu-bot.mjs`): the `ap:`/`aq:` direct branches called `control.handle` without `eventId`; approval/question `buildEvent` reads `input.eventId` verbatim → `missing_eventId` rejected every wired button callback (tests had only covered the unwired legacy path). Telegram uses `callback_query.id`; Feishu composes `feishu:<open_message_id>:<operator.open_id>:<act>`.
4. **Questions numbered-reply real defects** (`src/questions/router.mjs`): missing-chatId fail-closed branch dropped `envelope.accountId` (bare numbers leaked to the conversation router instead of being consumed); accepted-reply confirmation read a non-existent `verdict.answers` (empty `✅ 已作答：`) and now reads labels from the resolved ledger row.

### Test synchronization (HEAD had 7 pre-existing failures)

- `test/approval.test.mjs`, `test/approval-phase2-hardening.test.mjs`: rigs wire `createControlEntry()` by default; phase2 accepts carry a messageId (eventId). E-2 race test now reflects wired behavior (reply consumed, ledger settles once, no extra receipt).
- `test/questions.test.mjs`: two standalone bridges got `control: createControlEntry()`; hintTargets assertions carry the local accountId.
- `test/questions-admin-settlement.test.mjs`: phone-late receipt allows accepted/desktop_fallback (first-arrival is the ledger, not the receipt status).
- `test/contract.spec.mjs`: only runs contract-shaped fixtures; the preflight protocol-shape fixtures (`feishu.json`/`telegram.json`/`wechat-ilink.json`/`qq-bot-protocol.json`, no `type`) in `test/fixtures/channels/` are skipped.
- New focused tests: wxpusher accountId (config/default/never-from-event), wxpusher numbered-approval binding (correct / wrong / missing account fail-closed), actions accountId forwarding, conversation control-gated route (converse off / on / missing accountId / QQ group), control-entry stop missing-accountId fail-closed, telegram/feishu button eventId forwarding.

### Validation

- Focused suites green (494 tests); `npm test` = **1339 (1338 pass + 1 skip / 0 fail)**; `node scripts/verify-release.mjs` ok (0.8.6 / 909); `node scripts/gen-channel-matrix.mjs --check` ok (27); `node --check src/index.mjs` SYNTAX_OK; `git diff --check` ok.
- No real-device/protocol verification performed. QQ INTERACTION_CREATE field shapes, Feishu callback ids, Telegram 429 retry_after parsing, QQ msg_id+msg_seq receiving-side dedup, and provider payload limits remain on the real-device handoff list. QQ, Telegram, Feishu, iLink declared file/signature/CardKit capabilities stay declared.

### Commits (new, in order)

- (list filled at handoff below)

### Not done / residual (out of scope this session)

- QQ receiving-side `msg_id+msg_seq` dedup shape (preflight guidance) — needs device evidence, left on the candidate list.
- Telegram 429 `retry_after` honored instead of a fixed backoff — robustness improvement, mock cannot verify the response shape.
- Persisted control-overlay wiring into `createControlEntry` (`policyForSession` resolver) — pre-existing Stage-4 slice boundary, already documented in `task-07-policy-persistence.md`.
- Multi-account WxPusher disambiguation without explicit `config.accountId` (shared `'default'`) — acceptable because accountId is always paired with `channel` in comparisons.