# Project state

Snapshot date: 2026-09-12. Current release line **v0.10.0** (`codex/mobile-task-loop-v010`; **1605 tests, all pass**). Scope: the "mobile takes over DSH tasks" loop — host capability bridge (`createHostCapabilitySnapshot` / `detectEventsMode` / `detectQuestionsMode` / `detectConversationMode` / `detectHostVersion` in `src/host/capability.mjs`), native-question bridging through the sole public host seam `registerProvider` (`createNativeQuestionBridge`, safe degradation to `unsupported` + plugin `ask_user` fallback, never faking "bridged"), Web-first staged remote escalation (Stage 0 Web / Stage 1 delayed IM / Stage 2 reminders, timer cancellation, cross-end terminal sync), mobile task routing (read-only projection `projectTasks`/`tasksSnapshot` + `createTaskSelection` ambiguity cards + `/tasks`/`/use`), image input into DSH sessions (`normalizeInboundMessage` text+image dual-load, SSRF-hardened `normalizeImageUrl` including IPv4-mapped IPv6), and admin console exposure (`GET /api/tasks`, `GET /api/host`). All mock/contract/fixture evidence; native-question bridge and QQ image parsing lack real-device re-verification (see [risks.md](risks.md)). Previous line: v0.9.7 pr22-issue23-fix (Telegram ask_user custom/skip buttons + callback-ref reclamation; QQ Issue #23 gateway heartbeat resequencing; 1548 tests). Before that: v0.9.6 zero-config onboarding; R1–R5 fix trains complete; v0.9.5 closed with 1531 tests. The 80-item 2026-08 review list is reconciled: 70 fixed, G-19 evidence-logged, 9 registered non-fix (G-35/36/37; S-01/03/08/09/10/15). Latest released npm artifact is `0.9.7` (published 2026-09-12, 1548-test contract); `0.10.0` is queued for `main`. Test-count baselines in release guards are updated at train close, not per-commit.

- Current development validation: `npm test` = **1605** total, **1605 pass** (2026-09-12, mobile-task-loop-v010 line); v0.9.7 close baseline was **1548** (2026-09-12).
- Historical npm `0.8.6` artifact carried contract count **909**; `0.9.0` used **1352**; v0.9.5 closed at **1531**; v0.9.6 closed at **1544**; v0.9.7 closed at **1548**; the current v0.10.0 line is **1605**.
- Canonical engineering repository is private `dsh-notifier-dev`; the public GitHub repository is a release/source mirror (`main` now carries v0.10.0) and is not a development relay.
- Runtime is Node.js ESM, Node `>=22`, no production dependencies, no build step. There are 27 outbound adapters and six inbound control channels.
- Inbound identity is composite and source-bound: `(channel,userId)` plus exact `accountId`/`chatId` when present. Unknown or missing source authority fails closed; channel names are never used as account IDs.
- The loopback Web/admin console is the only control console (`127.0.0.1` + Bearer). It supports personal-mode setup, pairing, channel test sends, masked question listing, and Control-Core choose/reject settlement. YAML remains an advanced/automation entry.
- Desktop `ask_user` has no safe host interface. Desktop fallback is the fail-closed outcome for timeout/error; do not claim desktop settlement or dual-end parity.
- Control Core, session arbiter, bounded approval members, session control overlay persistence, provider facades, callback capacity, and public notifier facade limits are code/contract-tested.
- Public discovery metadata is aligned with v0.10.0; Awesome DSH refresh is tracked by PR #3490, and dshfind consumes the repository metadata on its scheduled sync.
- QQ C2C buttons, QQ GROUP text fallback, and QQ/WeChat iLink/DingTalk image envelopes are contract-tested only. Media/file support and provider-specific payload/reconnect behavior remain `declared` or unverified.
- `allowUsers` is retained as one-shot `inbound:migrated` compatibility import; optional Feishu/QQ SDK lifecycle seams are documented in [compatibility-matrix.md](../compatibility-matrix.md).

## Validation evidence

- `npm test`: 1605 total (1605 pass), 2026-09-12 (v0.10.0 publication baseline); focused Telegram 117 pass, focused QQ 45 pass.
- `node scripts/verify-release.mjs`: release guard compares package `0.10.0` with its documented 1605-test contract (badge / test text / homepage metadata / HANDOFF).

## Next release gate

v0.10.0 is queued for `main`. The next gate reuses the same checklist: run `npm pack --dry-run --json` and a registry-artifact disposable-profile smoke (registry install in a disposable profile, not a `file:` install). Validate startup, one outbound test, one inbound command, and the `ask_user` assembly boundary. Real-device, provider, and DSH-host validation remains an external gate; see [risks.md](risks.md).
