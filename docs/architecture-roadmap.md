# Cross-IM Control Plane Roadmap

> Status: approved direction; the Web/admin `ask_user` settlement slice (stage 2A) is code/contract-tested in the development line, while the remaining stages below are planning only (2026-08-26). This document does not claim real-device/provider support.

## Implementation checkpoint

- Stage 2A (2026-08-26): loopback Web/admin pending-question snapshot plus choose/reject settlement through the shared Control Core is implemented and contract-tested (`ce46edc`, documentation reconciliation `887b71f`). It is not real-host/device verified and does not provide a desktop settlement entry.
- WeChat iLink batch 4 and Feishu/Telegram batch 5 provider facades are wired at contract level; their provider/device evidence remains `declared` or `contract-tested` as recorded in `docs/memory/risks.md`.
- The next implementation slice is the remaining provider-neutral permissions/concurrency and performance-security closure, followed by the staged provider extensions. Real-device validation remains a separate release gate.

## Product direction

`dsh-notifier` is planned to evolve from a notification fan-out plugin into a cross-IM mobile control plane for DSH. Notifications remain the reliable base; observation, approval, questions, conversation, session control, and delivery receipts become the user-facing workflow.

The first user is an individual running DSH on one computer. The default path must therefore be QR-first, local, and understandable without editing YAML. Team controls are progressive disclosure, not the default screen.

## Modes and permissions

### Personal mode (default)

- One paired owner identity per channel; WeChat iLink starts with one account only.
- `observe` and `approve` are enabled after pairing.
- `converse` is a separate opt-in switch and is disabled by default.
- Member, workspace, session ACL, TTL, and audit configuration stays hidden.
- Group-chat control is disabled; documentation warns against using group chats for sensitive actions.

### Team mode (advanced)

- Formally paired members can approve sessions in their assigned scope by default.
- Only the owner can manage workspaces, sessions, members, and policy changes.
- The owner can change approval to owner-only and can grant `converse` separately.
- Every grant/revoke carries scope, expiry, and policy version; stale callbacks fail closed.

## Target architecture

```text
Channel Registry
  -> Transport Adapter (HTTP callback / WebSocket / long poll)
  -> Control Core (session, policy, interaction, arbitration, receipts)
  -> Native Renderer (cards, buttons, threads, draft, markdown, text fallback)
```

The control core owns semantics. A channel adapter owns authentication, reconnect, provider limits, and native rendering. The capability matrix must distinguish `declared`, `contract-tested`, `officially-supported`, and `real-device-verified`.

Desktop and mobile commands enter one `Session Command Arbiter`. Precedence is `stop > current question answer > current approval > steer > ordinary message`. Each event carries `eventId`, `sessionId`, `source`, `channel`, `userId`, `chatId`, and `policyVersion`; first valid settlement wins and later arrivals receive an explicit already-handled receipt.

## Channel strategy

| Channel | Product role | Native focus | Planned tier |
|---|---|---|---|
| WeChat iLink | Personal QR-first control | QR, long poll, text/media, typing, reconnect | P0 |
| Feishu | Rich team control | WebSocket, cards, card updates, files, menus | P0 |
| Telegram | Lightweight remote control | commands, inline buttons, edits/draft, topics, files | P0 |
| WeCom | Enterprise control | HTTP callbacks, template cards, buttons, media | P1 |
| DingTalk | Streamed work control | Stream, AI Card, interactive cards, media | P1 |
| Discord | Threaded collaboration | Gateway, threads, components, attachments | P1 |
| Slack | Enterprise collaboration | Socket Mode, Block Kit, threads, files | P2 |
| QQ | Compatibility and China coverage | WebSocket, markdown, keyboard, media | P2 |
| WhatsApp | Experimental enterprise bridge | Cloud API/webhooks or separately isolated linked-device bridge | P2 |

The implementation order is control contracts first, then WeChat iLink/Feishu/Telegram, then the remaining tiers. All channels keep text and numbered fallbacks when native controls are unavailable.

## Reuse and licensing rule

Borrow behavior and boundaries from `xmanrui/dsh-im`, `NousResearch/hermes-agent`, and OpenClaw. Reimplement the semantics with this project's zero-runtime-dependency constraints; do not import their Python runtimes or large SDK graphs.

The preferred iLink reference is `Tencent/openclaw-weixin` (MIT files and package metadata). It exposes QR login, `getupdates`, `sendmessage`, media upload/download, typing, context tokens, and reconnect/session handling. iLink is still an undocumented, changeable backend protocol, not a guaranteed public API; the adapter must include protocol-version detection, bounded polling, cursor recovery, session-expired re-login, and safe degradation.

Optional third-party SDKs are acceptable only when their package and source licenses are clear, maintenance is active, security behavior is reviewable, and loading is lazy. They must not become mandatory runtime dependencies. Unlicensed community clients and `UNLICENSED` connectors are reference-only and must not be copied or redistributed.

## UX and console direction

Keep one DSH-aligned local web console on `127.0.0.1`; do not create a second competing desktop product. The first screen should expose QR pairing, mode selection, a test notification, and connection status. YAML remains an escape hatch, not the normal setup path. Advanced team controls are progressively disclosed.

## Delivery gates

Each implementation slice follows `plan -> implement -> adversarial review -> revise -> focused tests -> full validation`. In addition to unit contracts, replay issue-derived scenarios, provider payload limits, reconnect behavior, duplicate callbacks, simultaneous desktop/mobile decisions, and first-run onboarding. Real-device or protocol validation is required before claiming provider support.
