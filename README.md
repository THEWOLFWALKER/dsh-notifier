# dsh-notifier

> **Your agent, in your pocket.** — 通知、审批、遥控，全在你的手机里。

**English** · [**简体中文**](README.zh-CN.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![Zero deps](https://img.shields.io/badge/zero%20deps-000000?style=flat-square)
![Bilingual](https://img.shields.io/badge/bilingual-EN%2F%E7%AE%80%E4%BD%93-00A98F?style=flat-square)
![Channels](https://img.shields.io/badge/channels-27-00B4D8?style=flat-square)

![npm version](https://img.shields.io/npm/v/dsh-notifier?style=flat-square&logo=npm&logoColor=white)
![tests](https://img.shields.io/badge/tests-1605-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-00B4D8?style=flat-square)
![omdsh workshop](https://img.shields.io/badge/omdsh-workshop-7C3AED?style=flat-square)
[![dshfind](https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=en)](https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)
[![dshfind downloads](https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?metric=downloads&lang=en)](https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)
[![dshfind plugin card](https://dshfind.com/api/card/THEWOLFWALKER/dsh-notifier?lang=en)](https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)

![never miss](https://img.shields.io/badge/never%20miss-a%20turn-00BFFF?style=flat-square)
![silence](https://img.shields.io/badge/silence%20never-approves-9C27B0?style=flat-square)
![push](https://img.shields.io/badge/push%20it-real%20good-FF4081?style=flat-square)

Package metadata: `dsh-notifier@0.10.0` · 1605 automated contract tests (1605 pass) · MIT licensed.

Bring your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent to the places you already use. dsh-notifier puts one minimal `notify()` API in front of 27 channels, then adds phone-friendly approvals, questions, session controls, and a calm local console — with no second runtime to deploy.

[Get started](docs/guide.md) · [Upgrade guide](docs/upgrade-guide.en.md) · [Plugin integration](PLUGINS.md)

Your agent and the harness itself both push through it: session events (`turn/end` · `approval/asked` · `agent/error`) auto-notify, the model calls a `notify` tool directly, and six inbound channels bring approvals and conversations back from your phone. QQ control ingress is source-marked: C2C is single-chat, while GROUP, missing `chatType`, and unknown source metadata fail closed; the conversation `routeUnsafe` bypass is blocked. v0.3 adds a local web console and multi-agent routing; v0.4 adds native desktop notifications; v0.5 turns your phone into a command center — long-task heartbeats, stall alerts, and a stop button riding the notification itself; v0.7 upgrades "who counts as family" from opaque YAML strings into a runtime identity system — pairing codes, composite-key bindings, and a members page in the admin console; v0.8 lets the agent ask you multiple-choice questions straight from your phone (`ask_user`: option cards + numbered-reply fallback, timeout never fabricates an answer) — all with zero runtime dependencies.

## How it works

```
DSH agent ──notify() tool─────────┐
                                  ├─▶ notifier core ─▶ 27 channels (IM webhooks / push apps / China apps)
DSH session events ──auto push────┘   level routing · tiered retries · segmentation · anti-disturb · ledger
                                      heartbeat ⏱ / stall ⚠ (v0.5) ──▶ cards with a ⏹ stop button
your phone ──6 inbound channels───▶   remote approval (buttons · reply 1/2) · remote conversation (followup/inject/steer) · remote questions (option cards, v0.8)
```

Every message resolves through one chain — level (`timeSensitive` / `active` / `passive`) → routing (multi-agent matrix) → channel adapter (`resolve(cfg)` + `send(msg)`). Two trigger lines feed it: the harness auto-pushes session events (debounced, deduped), and the model calls the `notify` tool. Six inbound channels ride the same core in reverse for approvals and conversation — and since v0.5 the outbound line reports back too: long-running turns send heartbeats, silent turns raise stall alerts, and Telegram/Feishu notifications carry a one-click stop action.

## Web admin console

The console is enabled by default and binds loopback only (mobile-friendly since v0.5). Zero-config onboarding: no YAML needed after install — open the exact `http://127.0.0.1:<port>/#token=...` link printed by the startup line (port conflicts fall back to a free port automatically; the token lives only in the URL fragment and is printed once). The in-page unlock gate verifies silently, then a first-visit wizard walks you through: pick a notification channel → fill in credentials → receive a real test notification on your phone. Remote reply, approvals, and member pairing can be configured later; bindings and sessions stay behind an explicit advanced-settings toggle.

| Page | What it shows |
|---|---|
| **Home** | link status & next actions, outbound/inbound channel health matrix, pending questions, audit stream; a three-step setup wizard when nothing is configured yet |
| **Channels** | outbound-first credential forms (masked `***`; untouched `***` fields are never submitted), instant real test send, QR authorization |
| **Members** (v0.7.0) | identity bindings (roles / labels / pairing time), pairing codes, pending-binding confirmations |
| **Notifications** (v0.4.0) | live SSE event stream, system-notification preferences, event log |
| **Bindings** (advanced) | agent × channel checkbox grid, per-channel default agent |
| **Sessions** (advanced) | per-session outbound resolution with override editing |

> **Outbound config is "view-hot, delivery-cold"** (G-14, W12): saving an **outbound** channel in the admin console reflects in the UI immediately, and the channel card shows a **"重启后生效" (takes effect after restart)** badge — the delivery layer (outbound router/channel instances) only merges runtime config (YAML ⊕ store) at the **next plugin startup**; inbound credentials likewise reconnect at next startup. Test send is exempt: it runs against the latest merged config instantly, no restart needed.

### What it looks like

| Zero-config onboarding wizard | Channel setup (configured + collapsible groups) |
|---|---|
| ![First-visit onboarding wizard](docs/screenshots/fresh-wizard-desktop.png) | ![Channel setup](docs/screenshots/configured-channels-desktop.png) |

| In-page unlock gate (silent token check) | Mobile layouts |
|---|---|
| ![Unlock gate](docs/screenshots/gate-unlock.png) | ![Mobile · channels](docs/screenshots/configured-channels-mobile.png) · ![Mobile · wizard](docs/screenshots/fresh-wizard-mobile.png) |

Screenshots captured from the loopback console (blue-white theme, aligned with the DeepSeek Harness design tokens). The console binds loopback only and is mobile-friendly from v0.5.

## Quick start

```bash
dsh plugin add dsh-notifier --profile <profile-name>
```

> `--profile` is required (DSH 0.1.0-rc.6+): plugin installs target a named profile — use the one you run (e.g. `web`).

No YAML needed. Restart DSH, then open the full link printed by the `Web 管理台已就绪` startup line (looks like `http://127.0.0.1:<port>/#token=...`):

1. The token in the link verifies silently and the first-visit wizard opens;
2. Pick a channel your phone already has (Bark / Telegram / Feishu / DingTalk …) and fill in its credentials;
3. Hit "save & send test notification" — **once your phone buzzes, setup is done**.

That's it. `turn/end`, `approval/asked`, and `agent/error` events now reach every configured channel, and the model can push on its own with `notify({ message, channel, title })`. Long tasks send heartbeats and stall alerts out of the box (v0.5 defaults), and you can stop a runaway turn right from the notification card.

## Core features

| Feature | What it does |
|---|---|
| **Dual trigger lines** | Auto status push (`turn/end` · `approval/asked` · `agent/error`) plus a model-facing `notify` tool. |
| **27 channels** | Telegram, Slack, Discord, Feishu, DingTalk, WeCom, WeCom App, QQ bot, OneBot, Teams, Mattermost, Google Chat, Bark, Pushover, PushDeer, Chanify, ntfy, Gotify, iGot, WxPusher, PushPlus, Server酱, Qmsg, 息知, webhook, bell, desktop — zero runtime deps. |
| **Level routing** | `timeSensitive` / `active` / `passive` → per-channel delivery semantics (silent push, priority headers, @-mentions) with tiered retries. |
| **Remote approval** | Answer approvals from your phone — Telegram/Feishu cards, QQ native buttons in 1:1 chats, and numbered-reply fallback on channels without cards. Group destinations use a safe text fallback. Silence never approves. |
| **Remote conversation** | Chat with your agent: plain text → `followup`/`inject`, `!` prefix steers mid-turn, a merge window reassembles mobile typing. |
| **Remote questions** (v0.8.0) | The model asks you multiple-choice questions on your phone: 1-4 questions × 2-5 options (multi-select supported). Option cards on Feishu/Telegram and QQ 1:1 chats; Telegram single-select cards also carry ✍️ custom-answer and ⏭ skip buttons (source/token-checked, first-arrival wins); other destinations use a safe numbered-reply fallback. Out-of-range answers get a re-prompt without voiding the question; timeout never fabricates an answer. Same trust chain as approvals (HMAC one-time tokens, first-arrival wins, 30s/60s escalation). The loopback Web/admin console provides a masked pending-question list with choose/reject through Control Core. |
| **Mobile command center** (v0.5.0) | Long-task heartbeats (default 15min start) and stall alerts (default 10min no events); Telegram/Feishu cards carry a ⏹ stop button (HMAC one-time tokens, same trust chain as approvals); `/quiet`·`/unquiet` mute or restore a session's pushes from your phone. |
| **Open event source** (v0.6.0) | Other plugins push via the `notifier` service (`ctx.inject(['notifier'], …)` — shared config, routing, ledger, rate limits, flush) and subscribe to delivery metadata via `ctx.on('dsh-notifier/sent')`. Broadcast and directed sends each produce one audited event; message text is never exposed. Per-source rate limiting (10/min), 20k-codepoint clamps, never-reject API; consumer contract in [PLUGINS.md](PLUGINS.md). |
| **Identity system** (v0.7.0) | "Who can drive inbound" becomes a runtime object: pairing codes (`/pair <code>` in any DM; first redeemer becomes owner), composite-key bindings (`channel:userId` — a Telegram-bound id no longer admits a Feishu message), role management (last owner can't be deleted or demoted), and rejection receipts that tell unbound senders how to get in. Empty whitelist boots into a guided state with a bootstrap pairing code written to a local 0600 file (`<stateDir>/bootstrap-paircode.txt`; logs print the path, never the code) instead of refusing to start. **Full setup-to-daily-use walkthrough: [docs/guide.md](docs/guide.md) (中文)**. |
| **Multi-agent routing** (v0.3.2) | Bidirectional agent × channel matrix; sessions auto-register; `/agent` command family + `route.mjs` CLI. |
| **Web admin console** (v0.3.3; zero-config onboarding rebuild) | 127.0.0.1-only + Bearer token; enabled by default with a one-time fragment launch link and automatic port fallback; four main pages — home / channels / members (v0.7) / notify, with bindings / sessions behind an explicit advanced toggle; first-visit wizard finishes the moment a real test notification lands on your phone; responsive ≤768px layout (v0.5). |
| **QR login** (v0.3.1) | One-command official scan authorization for QQ / DingTalk / Feishu (WeChat keeps iLink). |
| **Desktop notifications** (v0.4.0) | Native `desktop` channel (`osascript` / `notify-send` / PowerShell toast) + admin SSE live stream. |
| **Long-message segmentation** | Over-budget messages split into ordered `（i/n）` segments. |
| **Anti-disturb rules** | Per-result event gating, keyword include/exclude, idle grace window. |
| **Ledger & daily digest** | Append-only JSONL ledger + one `passive` summary of yesterday's traffic. |
| **Secrets safe** | `role('secret')` keys redacted everywhere; `${ENV:NAME}` refs keep secrets out of the profile. |
| **Never breaks startup** | Misconfigured channels are skipped silently with a log line. |

### Session commands (private-chat with the bot)

| Command | What it does | Boundaries |
|---|---|---|
| `/help` | List every available command. | No args; also explains the text / `!` / `..` conventions below. |
| `/status` | Show binding & agent status: bound session, resolved target, agent status, active-session list. | No args; when unbound it reports the channel-default routing instead. |
| `/agent` | Active-session group view: `workspace \| sid \| status \| outbound channel \| quiet`. | No args. |
| `/agent use <workspace\|sid prefix>` | Switch this conversation to that session (smart binding). | The target may contain spaces (the whole remainder is matched, G-33); unknown target gets a usage receipt. |
| `/agent back` | Release this conversation's binding and go back to the channel default. | No args. |
| `/bind <sessionId>` | Bind to an exact session (sid-level precise operation). | Unknown sid → "session not found" receipt. Rebinding detaches the old session's inbound hook first (G-48), so one user is never double-hooked. |
| `/unbind` | Unbind (back to channel-default routing: the channel's default agent, or the most recently active session when unset). | No args. |
| `/stop` | Cancel the current turn. | Bare `/stop` only (G-04): an appended message such as `/stop wait` is **not** a cancel — it falls through as an unknown command and is delivered as text. |
| `/route` | Show the bidirectional resolution: session → channel and channel → session. | Unavailable (with a receipt) when the router engine is not assembled. |
| `/quiet <workspace\|sid>` | Mute that session's outbound pushes; remote conversation is unaffected. | Target required (full name or ≥4-char sid prefix); unavailable when the router engine is not assembled. |
| `/unquiet <workspace\|sid>` | Restore that session's outbound pushes. | Same boundary as `/quiet`. |

Sending plain text talks to the agent; a `!` prefix steers mid-turn; a `..` suffix flushes immediately (inside the merge window). Group chats refuse remote-control commands (QQ groups reply with a "群聊不允许远程控制" receipt) — use the original private chat.

## Configuration

All channels live under `config.channels`. Key example:

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
        - type: feishu
          webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/..."
        - type: wxpusher
          appToken: "AT_..."
          uids: ["UID_..."]
        - type: serverchan
          sct: "SCT..."
```

Optional blocks each opt in under their own key:

| Block | Purpose | Key |
|---|---|---|
| `inbound` | Remote approval + conversation | `allowUsers: [...]` (first-import only since v0.7; manage members at runtime via the admin console or `/pair`) |
| `approval` | Timeout, numbered reply, escalation | `mode: answer` |
| `conversation` | Merge window, steer prefix | `mergeWindowMs: 1500` |
| `route` | Multi-agent routing | `sessionTtlHours: 24` |
| `admin` | Web console | enabled by default (127.0.0.1 only); open the exact `/#token=...` startup link — no port guessing |
| `events` / `keywords` / `graceSeconds` | Anti-disturb gates | `exclude: ["heartbeat"]` |
| `events.turnStart` / `longRunning` / `stall` | v0.5 status line | `longRunning: { firstAfterMs: 900000 }` |
| `digest` | Ledger + daily summary | `enabled: true` |

v0.5 status line defaults: `longRunning` and `stall` are **on** (15min first heartbeat, then every 15min; stall after 10min of silence) — zero-config long tasks are no longer a black box. `turnStart` is **off** by default (one message per turn is noise at the desk; turn it on when you fire a task and walk away). All timings clamp to a 60s floor; disable any of them with `enabled: false`.

## Channels

<!-- CHANNEL-MATRIX-START -->

| type | Channel | Auth | Free? |
|---|---|---|---|
| `bark` | Bark (iOS) | device key (or self-host URL) | ✅ |
| `bell` | Terminal bell (local) | — | local |
| `chanify` | Chanify (iOS) | token (or self-host) | ✅ |
| `desktop` | Desktop notification (local) | — (Windows needs BurntToast module) | local |
| `dingtalk` | DingTalk custom robot | webhook + secret (HMAC sign) | ✅ |
| `discord` | Discord webhook | webhook URL | ✅ |
| `feishu` | Feishu custom bot | webhook (+ sign secret) | ✅ |
| `gchat` | Google Chat | space webhook URL | ✅ |
| `gotify` | Gotify | server URL + app token | self-host |
| `igot` | iGot (iOS) | push key | ✅ (limits) |
| `mattermost` | Mattermost | base URL + token (+ channel) | self-host |
| `ntfy` | ntfy | topic (+ server URL) | ✅ (self-host) |
| `onebot` | OneBot 11 (QQ) | HTTP endpoint | self-host |
| `pushdeer` | PushDeer | push key | ✅ |
| `pushover` | Pushover | user key + app token | paid (one-time) |
| `pushplus` | PushPlus (WeChat) | token | ✅ (limits) |
| `qmsg` | Qmsg酱 (QQ) | key + qq number | ✅ (limits) |
| `qq-bot` | QQ official bot | appId + appSecret | ✅ |
| `serverchan` | Server酱 (WeChat) | sendkey | ✅ (limits) |
| `slack` | Slack | incoming webhook URL | ✅ |
| `teams` | Microsoft Teams | Power Automate workflow URL | ✅ |
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `webhook` | Any custom endpoint | — | — |
| `wecom` | WeCom group robot | webhook key | ✅ |
| `wecom-app` | WeCom app message | corpid + agentId + secret | ✅ |
| `wxpusher` | WxPusher (WeChat) | appToken + uid | ✅ (limits) |
| `xizhi` | 息知 Xizhi | sendkey | ✅ (limits) |

<!-- CHANNEL-MATRIX-END -->

Six channels also open inbound (remote approval + conversation): `telegram`, `feishu`, `qq-bot`, `wxpusher`, `wechat`, `dingtalk` — long-lived connections or long polling, so no public IP is required (only the WxPusher callback needs one). Telegram/Feishu and QQ C2C single chats use native control buttons; other targets receive safe text or numbered-reply fallbacks, and the conversation `routeUnsafe` path cannot bypass the source-safety gate. QQ, WeChat iLink, and DingTalk image-message paths are wired; file receiving/sending follows the capability matrix. The loopback Web/admin console is the single control surface and offers a masked list of pending multi-choice questions plus choose/reject settlement through the shared Control Core. Since v0.5, telegram and feishu additionally carry notification action cards (stop button). Since v0.7, every inbound channel answers `/help` `/whoami` `/pair` `/unpair` registration commands, and outbound card targets resolve through a three-tier priority (per-channel bindings → channel config lists → global fallback) with per-channel id-shape guards.

## Architecture

```
src/
  adapters/           27 channel adapters (resolve(cfg) + send(msg)) + declarative spec engine
  config.mjs          channel registry + config schema — single source of truth for the matrix
  index.mjs           plugin assembly: patch, tools, event listeners, admin wiring
  event-listener.mjs  auto-push line (debounce, dedup, level routing) + v0.5 status wiring
  status/             v0.5 turn tracker (heartbeat / stall detection, pure logic)
  actions.mjs         v0.5 notification action dispatch (turn/cancel, HMAC one-time tokens)
  notify.mjs          notify / notify_test tools + sliding-window rate limiting
  routing/            multi-agent matrix (resolveOutbound / resolveInbound)
  inbound/            six inbound channels (telegram/feishu/qq/wxpusher/wechat/dingtalk) + v0.7 identity stack
                      (identity.mjs bindings · pairing.mjs codes · commands.mjs registration · target-guard.mjs resolution)
  approval/           HMAC one-time tokens, dedup, escalation
  questions/          v0.8 ask_user remote questions (option cards + numbered fallback, rides the approval stack)
  admin/              web console (6 pages, SSE, bearer auth, mobile layout)
  ledger.mjs          JSONL ledger + daily digest
  rules.mjs           anti-disturb gates (event / keyword / grace)
scripts/              channel-login.mjs · channel-selfcheck.mjs · route.mjs · gen-channel-matrix.mjs
test/                 1605 tests (1605 pass) in the 0.10.0 release line; historical 0.8.6 package carried 909 tests.
```

Design rules: pure ESM (`.mjs`), zero runtime dependencies, a declarative spec engine for the bulk of channels, thin honest adapters, no build step.

### Optional dependencies (optional assembly, S-13)

`package.json` carries two `optionalDependencies`, both **exact-pinned** and **lazy-loaded only** — installing them is never required, and their absence never breaks startup or the core notify path:

- `@larksuiteoapi/node-sdk` `1.73.0` — Feishu QR login / inbound WebSocket only. Missing → the Feishu channel reports `missing-sdk` with install guidance (`npm i @larksuiteoapi/node-sdk@1.73.0`), other channels keep working.
- `qrcode-terminal` `0.12.0` — terminal QR rendering in the login CLIs only. Missing → the CLIs print a scannable link instead.

Pin discipline (S-13): optional ranges are locked to the reviewed versions (the `^` floor that let `@larksuiteoapi/node-sdk` drift past the `registerApp` callback rename at ≥1.73 is gone). `@tencent-connect/qqbot-connector` is **not** an optionalDependency: it is npm-flagged `UNLICENSED`, so per `docs/memory/decisions.md` it stays a design reference only — never copied, redistributed, or introduced as a dependency. The QQ QR-login code path keeps its lazy `import()` and degrades to a `missing-sdk` receipt if the package is installed manually.

## Development

> For active development and contributor work, use the private dev repository `THEWOLFWALKER/dsh-notifier-dev`. This public mirror is a release/source snapshot only — do not develop here.

```bash
npm test          # 0.10.0 release line: 1605 (1605 pass)
```

To add a channel: implement the adapter interface (`resolve(cfg)` + `send(msg)`) in `src/adapters/` and register it in `src/config.mjs`; the channel matrix above self-regenerates via `node scripts/gen-channel-matrix.mjs`.

## License

[MIT](LICENSE) · third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
