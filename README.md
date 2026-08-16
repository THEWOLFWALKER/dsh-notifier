# dsh-notifier

**English** · [**简体中文**](README.zh-CN.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![Zero deps](https://img.shields.io/badge/zero%20deps-000000?style=flat-square)
![Bilingual](https://img.shields.io/badge/bilingual-EN%2F%E7%AE%80%E4%BD%93-00A98F?style=flat-square)
![Channels](https://img.shields.io/badge/channels-25%2B-00B4D8?style=flat-square)

![npm version](https://img.shields.io/npm/v/dsh-notifier?style=flat-square&logo=npm&logoColor=white)
![tests](https://img.shields.io/badge/tests-625-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-00B4D8?style=flat-square)
![omdsh workshop](https://img.shields.io/badge/omdsh-workshop-7C3AED?style=flat-square)

![never miss](https://img.shields.io/badge/never%20miss-a%20turn-00BFFF?style=flat-square)
![silence](https://img.shields.io/badge/silence%20never-approves-9C27B0?style=flat-square)
![push](https://img.shields.io/badge/push%20it-real%20good-FF4081?style=flat-square)

Unified notification push plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — one minimal `notify()` API in front, 25+ channels behind.

Your agent and the harness itself both push through it: session events (`turn/end` · `approval/asked` · `agent/error`) auto-notify, the model calls a `notify` tool directly, and six inbound channels bring approvals and conversations back from your phone. v0.3 adds a local web console and multi-agent routing; v0.4 adds native desktop notifications — all with zero runtime dependencies.

## How it works

```
DSH agent ──notify() tool─────────┐
                                  ├─▶ notifier core ─▶ 25+ channels (IM webhooks / push apps / China apps)
DSH session events ──auto push────┘   level routing · tiered retries · segmentation · anti-disturb · ledger
your phone ──6 inbound channels───▶   remote approval (buttons · reply 1/2) · remote conversation (followup/inject/steer)
```

Every message resolves through one chain — level (`timeSensitive` / `active` / `passive`) → routing (multi-agent matrix) → channel adapter (`resolve(cfg)` + `send(msg)`). Two trigger lines feed it: the harness auto-pushes session events (debounced, deduped), and the model calls the `notify` tool. Six inbound channels ride the same core in reverse for approvals and conversation.

## Quick start

```bash
dsh plugin add dsh-notifier
```

Add channels to your profile patch (`cordis.patch.yml`):

```yaml
insert:
  - id: dsh-notifier
    name: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "123456:ABC-DEF..."
          chatId: "987654321"
        - type: dingtalk
          webhook: "https://oapi.dingtalk.com/robot/send?access_token=..."
          secret: "SEC..."
        - type: bark
          key: "your-device-key"
```

That's it. `turn/end`, `approval/asked`, and `agent/error` events now reach every configured channel, and the model can push on its own with `notify({ message, channel, title })`.

## Core features

| Feature | What it does |
|---|---|
| **Dual trigger lines** | Auto status push (`turn/end` · `approval/asked` · `agent/error`) plus a model-facing `notify` tool. |
| **25+ channels** | Telegram, Slack, Discord, Feishu, DingTalk, WeCom, QQ bot, OneBot, Teams, Mattermost, Google Chat, Bark, Pushover, PushDeer, Chanify, ntfy, Gotify, iGot, WxPusher, PushPlus, Server酱, Qmsg, 息知, webhook, bell — zero runtime deps. |
| **Level routing** | `timeSensitive` / `active` / `passive` → per-channel delivery semantics (silent push, priority headers, @-mentions) with tiered retries. |
| **Remote approval** | Answer approvals from your phone — Telegram buttons, Feishu cards, QQ / WxPusher / WeChat iLink / DingTalk reply `1`/`2`. Silence never approves. |
| **Remote conversation** | Chat with your agent: plain text → `followup`/`inject`, `!` prefix steers mid-turn, a merge window reassembles mobile typing. |
| **Multi-agent routing** (v0.3.2) | Bidirectional agent × channel matrix; sessions auto-register; `/agent` command family + `route.mjs` CLI. |
| **Web admin console** (v0.3.3) | 127.0.0.1-only + Bearer token; five pages — dashboard / notify / bindings / sessions / channels. |
| **QR login** (v0.3.1) | One-command official scan authorization for QQ / DingTalk / Feishu (WeChat keeps iLink). |
| **Desktop notifications** (v0.4.0) | Native `desktop` channel (`osascript` / `notify-send` / PowerShell toast) + admin SSE live stream. |
| **Long-message segmentation** | Over-budget messages split into ordered `（i/n）` segments. |
| **Anti-disturb rules** | Per-result event gating, keyword include/exclude, idle grace window. |
| **Ledger & daily digest** | Append-only JSONL ledger + one `passive` summary of yesterday's traffic. |
| **Secrets safe** | `role('secret')` keys redacted everywhere; `${ENV:NAME}` refs keep secrets out of the profile. |
| **Never breaks startup** | Misconfigured channels are skipped silently with a log line. |

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
| `inbound` | Remote approval + conversation | `allowUsers: [...]` |
| `approval` | Timeout, numbered reply, escalation | `mode: answer` |
| `conversation` | Merge window, steer prefix | `mergeWindowMs: 1500` |
| `route` | Multi-agent routing | `sessionTtlHours: 24` |
| `admin` | Web console | `enabled: true, port: 8104` |
| `events` / `keywords` / `graceSeconds` | Anti-disturb gates | `exclude: ["heartbeat"]` |
| `digest` | Ledger + daily summary | `enabled: true` |

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

Six channels also open inbound (remote approval + conversation): `telegram`, `feishu`, `qq-bot`, `wxpusher`, `wechat`, `dingtalk` — long-lived connections or long polling, so no public IP is required (only the WxPusher callback needs one).

## Screenshots

The web admin console (`admin.enabled: true`, loopback only) — all five pages (demo data):

| Page | What it shows |
|---|---|
| **Dashboard** | session stats, outbound/inbound channel health groups, recent audit |
| **Notifications** (v0.4.0) | live SSE event stream, system-notification preferences, event log |
| **Bindings** | agent × channel checkbox grid, per-channel default agent |
| **Sessions** | per-session outbound resolution with override editing |
| **Channels** | credential forms for every channel (masked `***`), test send, QR scan |

![Dashboard](docs/screenshots/admin-dashboard.png)
![Notify](docs/screenshots/admin-notify.png)
![Bindings](docs/screenshots/admin-bindings.png)
![Sessions](docs/screenshots/admin-sessions.png)
![Channels](docs/screenshots/admin-channels.png)

## Architecture

```
src/
  adapters/           25+ channel adapters (resolve(cfg) + send(msg)) + declarative spec engine
  config.mjs          channel registry + config schema — single source of truth for the matrix
  index.mjs           plugin assembly: patch, tools, event listeners, admin wiring
  event-listener.mjs  auto-push line (debounce, dedup, level routing)
  notify.mjs          notify / notify_test tools + sliding-window rate limiting
  routing/            multi-agent matrix (resolveOutbound / resolveInbound)
  inbound/            six inbound channels (telegram/feishu/qq/wxpusher/wechat/dingtalk)
  approval/           HMAC one-time tokens, dedup, escalation
  admin/              web console (5 pages, SSE, bearer auth)
  ledger.mjs          JSONL ledger + daily digest
  rules.mjs           anti-disturb gates (event / keyword / grace)
scripts/              channel-login.mjs · test-channel.mjs · route.mjs · gen-channel-matrix.mjs
test/                 625 tests (node --test)
```

Design rules: pure ESM (`.mjs`), zero runtime dependencies, a declarative spec engine for the bulk of channels, thin honest adapters, no build step.

## Development

```bash
npm test          # node --test, 625 cases
```

To add a channel: implement the adapter interface (`resolve(cfg)` + `send(msg)`) in `src/adapters/` and register it in `src/config.mjs`; the channel matrix above self-regenerates via `node scripts/gen-channel-matrix.mjs`.

## License

[MIT](LICENSE) · third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
