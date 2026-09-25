# dsh-notifier

<p align="center">
  <img src="https://raw.githubusercontent.com/THEWOLFWALKER/dsh-notifier/main/docs/assets/dsh-notifier-icon.png" width="132" alt="dsh-notifier logo">
</p>

<p align="center"><strong>Your agent, in your pocket.</strong><br>Notifications, approvals, remote control — now with a native DSH control surface.</p>

> **Maintenance notice (维护公告)**: until **2026-10-01**, the author is taking exams and cannot promptly maintain the project or review PRs/issues — replies will be delayed. Apologies for the inconvenience. 至 **2026-10-01** 前作者因考试无法及时维护与查看 PR/Issue，回复会延迟。

**English** · [**简体中文**](README.zh-CN.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Zero deps](https://img.shields.io/badge/runtime%20deps-0-000000?style=flat-square)
![Channels](https://img.shields.io/badge/channels-28-00B4D8?style=flat-square)
![npm version](https://img.shields.io/npm/v/dsh-notifier?style=flat-square&logo=npm&logoColor=white)
![tests](https://img.shields.io/badge/tests-1889-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
[![dshfind](https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=en)](https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)

`dsh-notifier@0.12.1` is the notification and remote-operations control plane for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **28 outbound channels**, **6 inbound control channels**, remote approvals/questions/conversation, task visibility, health/activity projections, and a **native DSH Sidebar/Main experience** — with zero runtime dependencies.

Package metadata: `dsh-notifier@0.12.1` · 1889 automated contract tests · MIT licensed.

[Get started](docs/guide.md) · [Upgrade](docs/upgrade-guide.en.md) · [Compatibility](docs/compatibility-matrix.md) · [Plugin API](PLUGINS.en.md) · [Changelog](CHANGELOG.md)

## v0.12: daily control moves into DSH

The primary daily surface is now **Notify & Control** inside DSH. You no longer need to hunt through startup logs for a localhost URL just to add or test a notification channel.

- **Native Control Surface** — DSH Sidebar + Main panel, plus a Plugins activation/config entry.
- **Live outbound Hot Apply** — save an outbound channel and the next send uses it immediately; no notifier rebuild and no DSH restart.
- **One runtime authority** — notifier, routing, tools, questions/approvals availability and UI projections read the same `OutboundSource`.
- **Health / Tasks / Questions / Activity** — operational views reuse existing runtime state; no second task/question database.
- **Advanced Console stays available** — the loopback Web console is now an advanced/recovery surface for members, pairing, bindings, sessions and diagnostics.
- **Safer handoff** — Native launches the Advanced Console with a short-lived one-time ticket; the Native client never receives the long-lived Admin bearer.

> Outbound changes are hot. Inbound transports may still require a restart when the UI says **Restart pending**; v0.12 intentionally does not pretend every inbound SDK/long connection can be reconfigured live.

## Quick start

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH once so the newly installed client module and host plugin are loaded, then:

1. Open **Notify & Control** from the DSH sidebar, or **Plugins → dsh-notifier → Start setup**.
2. Choose a notification channel you already use.
3. Enter credentials and select **Save and test**.
4. Setup finishes when the provider **accepts** the test; if no end-to-end receipt exists, the UI explicitly asks you to confirm it on your device.

After that, outbound edits apply immediately. No YAML is required for normal setup.

If the Native surface is unavailable (for example on a headless profile), the loopback **Advanced Console** and YAML/CLI paths remain available as recovery/automation entry points.

## How it works

```text
DSH Sidebar / Plugins
        │
        ▼
Native Control Surface ── DSH Connection RPC ──┐
                                                │
DSH events ────────────────┐                    ▼
agent notify() tool ───────┼──▶ OutboundSource ─▶ notifier core ─▶ 28 outbound channels
other plugins / ctx.notifier┘         │
                                      └── health · activity · ledger

your phone ── 6 inbound channels ──▶ identity + Control Core
                                      ├─ approval
                                      ├─ conversation / steer
                                      ├─ ask_user questions
                                      └─ task/session control

Advanced Console (127.0.0.1) ──▶ same runtime state
  members · pairing · bindings · sessions · diagnostics · recovery
```

Session events such as `turn/end`, `approval/asked`, and `agent/error` can auto-notify; the model can also call the `notify` tool directly. Six inbound channels carry approvals, conversation and `ask_user` responses back from your phone. Decisions are one-shot and fail-closed: silence never approves, unknown/unbound sources are rejected, and settlement remains behind the shared Control Core.

## Control surfaces

| Surface | Use it for | Notes |
|---|---|---|
| **Notify & Control** (DSH Native) | Home status, channels, real test sends, task projection, pending questions, recent activity | **Primary daily UI** |
| **Plugins → dsh-notifier** | First setup, status, handoff into Notify & Control | No duplicate admin dashboard |
| **Advanced Console** | Members/pairing, bindings, sessions, detailed diagnostics and recovery | Loopback-only, `127.0.0.1`; launched from Native when enabled |
| **YAML / CLI** | Automation, reproducible deployments, headless operation | Advanced path; see [guide](docs/guide.md) |

## Core features

| Feature | What it does |
|---|---|
| **28 outbound channels** | IM webhooks, push apps, China-centric services, desktop/local targets — zero runtime deps. |
| **Native DSH UX** (v0.12) | Sidebar/Main panel + plugin activation/config card using Host React and DSH visual tokens; no iframe, Vite, esbuild or bundled React. |
| **Live outbound Hot Apply** (v0.12) | Save → validate/resolve → persist canonical state → atomically swap the live channel; the next send uses the new config without restart. |
| **Dual trigger lines** | Auto status push (`turn/end` · `approval/asked` · `agent/error`) plus a model-facing `notify` tool. |
| **Level routing** | `timeSensitive` / `active` / `passive` with per-channel semantics, retries, segmentation and anti-disturb rules. |
| **Remote approval** | Telegram/Feishu cards, QQ C2C native buttons, numbered-reply fallbacks; silence never approves. |
| **Remote questions** | `ask_user` option cards / numbered replies, multi-select, custom/skip where supported, first-arrival-wins settlement. |
| **Remote conversation** | Plain text → followup/inject; `!` steers mid-turn; a merge window reconstructs mobile typing. |
| **Mobile task/session control** | `/tasks`, `/use`, `/sessions`, `/stop`, `/quiet`, `/unquiet`; `/log [N]` is off by default and owner-only. |
| **Identity & pairing** | Runtime `(channel,userId)` bindings, pairing codes, owner/member roles, source-bound fail-closed checks. |
| **Plugin public API** | Other plugins can inject `ctx.notifier`, push through the same channels/routing/ledger/limits, and subscribe to metadata-only `dsh-notifier/sent`. |
| **Advanced Console** | Local-only recovery and deeper management; Native uses a one-time launch ticket instead of exposing its long-lived bearer. |
| **Ledger & digest** | Append-only delivery ledger plus optional daily summary. |
| **Secret hygiene** | Secret fields are masked/omitted in projections; `${ENV:NAME}` keeps credentials out of YAML. |

### Session commands

| Command | What it does | Boundary |
|---|---|---|
| `/help` | List available commands | Private chat |
| `/whoami` | Show identity/binding state | Private chat |
| `/status` | Show current routing/session status | Private chat |
| `/agent` / `/agent use …` / `/agent back` | Inspect and switch the active session | Bound identity |
| `/bind <sessionId>` / `/unbind` | Exact session binding | Bound identity |
| `/tasks` / `/use …` | List/select active tasks | Read-only task projection |
| `/sessions` | Session overview with attention flags | Read-only projection |
| `/log [N]` | Bounded redacted recent-notification summary | **Off by default**, owner-only |
| `/stop` | Cancel the current turn | Bare `/stop` only |
| `/route` | Show bidirectional route resolution | Router must be available |
| `/quiet <target>` / `/unquiet <target>` | Mute/restore outbound pushes for a session | Conversation remains active |
| `/pair <code>` / `/unpair` | Pair or detach an inbound identity | Private chat |

Plain text talks to the agent; prefix with `!` to steer a running turn. Group chats do not get unsafe remote-control semantics — use the original private chat.

## Configuration

For ordinary use, configure outbound channels in **Notify & Control**. YAML remains useful for bootstrap, automation and headless deployments:

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
        - type: feishu
          webhook: "${ENV:FEISHU_WEBHOOK}"
```

v0.12 writes editable outbound runtime state to the canonical `channel:<type>:outbound` store key. YAML is still a bootstrap/fallback source; old `admin:channel:<type>:outbound` and legacy `<type>:account` overlays are compatibility-only.

| Block | Purpose | Typical key |
|---|---|---|
| `inbound` | Remote approval + conversation | first-import `allowUsers`, then runtime pairing |
| `approval` | timeout, numbered reply, escalation | `mode: answer` |
| `conversation` | merge window, steer prefix | `mergeWindowMs: 1500` |
| `route` | multi-agent routing | `sessionTtlHours: 24` |
| `admin` | Advanced Console | loopback-only; enabled by default unless explicitly disabled |
| `events` / `keywords` / `graceSeconds` | anti-disturb gates | `exclude: ["heartbeat"]` |
| `events.turnStart` / `longRunning` / `stall` | long-task status | `longRunning: { firstAfterMs: 900000 }` |
| `digest` | ledger + daily summary | `enabled: true` |

See the full walkthrough in [docs/guide.md](docs/guide.md).

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
| `qmsg` | Qmsg酱 (QQ) | key (+ optional group, v3) | ✅ (limits) |
| `qq-bot` | QQ official bot | appId + appSecret | ✅ |
| `serverchan` | Server酱 (WeChat) | sendkey | ✅ (limits) |
| `slack` | Slack | incoming webhook URL | ✅ |
| `teams` | Microsoft Teams | Power Automate workflow URL | ✅ |
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `webhook` | Any custom endpoint | — | — |
| `wecom` | WeCom group robot | webhook key | ✅ |
| `wecom-app` | WeCom app message | corpid + agentId + secret | ✅ |
| `wps-bot` | WPS collaboration group robot (WOA) | webhook URL (with ?key=) | ✅ |
| `wxpusher` | WxPusher (WeChat) | appToken + uid | ✅ (limits) |
| `xizhi` | 息知 Xizhi | sendkey | ✅ (limits) |

<!-- CHANNEL-MATRIX-END -->

Six channels also provide inbound control: `telegram`, `feishu`, `qq-bot`, `wxpusher`, `wechat`, and `dingtalk`. Telegram/Feishu and QQ C2C can use native control buttons; other destinations fall back to safe text/numbered replies. Provider-specific media/file support remains capability- and validation-dependent — see [compatibility](docs/compatibility-matrix.md) and the capability matrix in the source.

## DSH compatibility

Declared host range:

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

v0.12 release evidence includes:

- **0.1.7-rc.2**: real-host Native UI / channel setup / save+test / Hot Apply walkthrough passed.
- **0.1.7-alpha.1**: compatibility-floor smoke passed (activation, RPC, 28-channel projection, client-module serving).
- **alpha.2 / rc.1**: source/artifact seam compatibility is verified; see the exact evidence level in [docs/compatibility-matrix.md](docs/compatibility-matrix.md).

## Architecture

```text
src/
  adapters/                 28 outbound adapters + declarative spec engine
  runtime/
    outbound-source.mjs     single live outbound authority
  control-surface/
    service.mjs             Native command/query facade
    rpc.mjs                 DSH authenticated control transport
    channels.mjs            channel projection
    health.mjs              bounded operational evidence
    activity.mjs            redacted activity projection
    tasks.mjs               task projection adapter
    questions.mjs           Control-Core question bridge
    launch-ticket.mjs       one-time Advanced Console launch tickets
  notify.mjs                notify / notify_test + routing/limits
  event-listener.mjs        automatic session-event notifications
  routing/                  multi-agent routing
  inbound/                  six inbound control channels + identity/pairing
  approval/                 approval tokens/dedup/escalation
  questions/                remote ask_user flow
  admin/                    Advanced / recovery Web console
  ledger.mjs                append-only delivery ledger + digest
client.js                   DSH Native web client module
```

The public consumer surface is documented in [PLUGINS.en.md](PLUGINS.en.md). `ctx.notifier.version` remains `0.7`; v0.12 changes the product control surface and runtime channel authority, not the consumer API contract.

## Development

Release gates:

```bash
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
node --check client.js
npm pack --dry-run --json
git diff --check
```

v0.12.1 remediation line: **1889 registered contract tests**; the focused remediation suites pass, while real-provider/device evidence remains an external gate.

test/ 1889 tests in the current line; the historical 0.8.6 package carried 909 tests.

## License

MIT
