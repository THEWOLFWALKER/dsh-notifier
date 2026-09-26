<p align="center">
  <img src="docs/assets/readme-hero.png" alt="dsh-notifier — Agent ⇄ User, across every channel" width="100%">
</p>

<div align="center">

# dsh-notifier

**Your agent, in your pocket.**

Bring DeepSeek Harness to your phone: notifications, approvals, questions, remote conversation, and task/session control across **28 outbound** and **6 inbound** channels.

[简体中文](README.zh-CN.md) · [Quick Guide](docs/guide.en.md) · [Troubleshooting](docs/TROUBLESHOOTING.en.md) · [Compatibility](docs/compatibility-matrix.md)

<p>
  <a href="https://www.npmjs.com/package/dsh-notifier"><img src="https://img.shields.io/npm/v/dsh-notifier?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT license"></a>
  <a href="https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge"><img src="https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=en" alt="dshfind"></a>
</p>

</div>

<p align="center">
  <img src="https://img.shields.io/badge/tests-2011-brightgreen" alt="2011 tests">
  `dsh-notifier@0.13.0` · test/ 2011 tests · 2011 automated contract tests
</p>

## What it does

dsh-notifier is the notification and remote-operations layer for DeepSeek Harness. It is built for the common workflow of **leaving the DSH window while still wanting to know what your agent is doing — and respond when it needs you**.

- **Get notified anywhere** — task completion, approvals, errors, long-running status, and model-triggered notifications.
- **Respond from your phone** — approve/reject, answer `ask_user`, continue a conversation, steer a running turn, or switch tasks/sessions.
- **Manage it inside DSH** — the Native **Notify & Control** panel is the daily control surface; the loopback Advanced Console remains available for recovery and deeper management.
- **Keep failures contained** — unsafe or unknown inbound actions fail closed; outbound channel failures do not take down the rest of the notifier.

<p align="center">
  <img src="docs/screenshots/fresh-wizard-desktop.png" alt="dsh-notifier setup wizard" width="49%">
  <img src="docs/screenshots/configured-channels-desktop.png" alt="dsh-notifier configured channels" width="49%">
</p>

## Install

### Ask an AI to install it for you

Copy this sentence to an AI/agent that can operate your terminal:

> Install or upgrade the latest stable **dsh-notifier** on this machine. First detect the active DSH profile and current install source, verify the installed DSH/Node versions are compatible, and preserve the existing configuration. Do not modify unrelated plugins or print any token/secret. Install from the official package, restart the relevant DSH Host once, verify the actual installed version and the **Notify & Control** entry, then report the commands you ran, the result, and any remaining problem. Project: `https://github.com/THEWOLFWALKER/dsh-notifier`

The full AI installation procedure is in [AI_INSTALL.en.md](docs/AI_INSTALL.en.md).

### Install manually

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH once so the new Host plugin and `client.js` are loaded. Then:

1. Open **Notify & Control** from the DSH sidebar, or **Plugins → dsh-notifier**.
2. Choose a channel you already use.
3. Enter its credentials and choose **Save and test**.
4. If the provider only confirms API acceptance, verify the message on your device; a provider acceptance is not presented as end-to-end delivery proof.

Outbound configuration changes are hot-applied after installation. Inbound transports can still show **Restart pending** when their long-lived connection must be recreated.

## Pick the mode you need

| I want to… | Start here |
| --- | --- |
| Only receive task notifications | Configure one outbound channel in **Notify & Control** |
| Approve / answer questions from my phone | Add a supported inbound channel, then pair your identity |
| Talk to the agent remotely | Pair your identity, then send plain text in the private bot chat |
| Steer a running task | Send `! <instruction>` from the bound private chat |
| Manage members, bindings, sessions or recovery | Open the **Advanced Console** from Native |
| Automate or run headless | Use YAML / CLI from the [guide](docs/guide.en.md) |

## Channels

**Outbound (28):** Bark, Bell, Chanify, Desktop, DingTalk, Discord, Feishu, Google Chat, Gotify, iGot, Mattermost, ntfy, OneBot 11, PushDeer, Pushover, PushPlus, Qmsg, QQ official bot, ServerChan, Slack, Microsoft Teams, Telegram, Webhook, WeCom robot, WeCom app, WPS Bot, WxPusher, Xizhi.

**Inbound control (6):** Telegram, Feishu, QQ official bot, WxPusher, WeChat iLink, DingTalk.

<details>
<summary><strong>Full channel matrix (generated from the channel registry)</strong></summary>

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

</details>

Provider behavior differs. Buttons, attachments, delivery receipts, reconnect behavior, and account limits are only claimed at the evidence level documented in [Compatibility](docs/compatibility-matrix.md).

<details>
<summary><strong>Common private-chat commands</strong></summary>

| Command | Purpose |
| --- | --- |
| `/help` | Show commands |
| `/whoami` | Show identity / pairing state |
| `/status` | Current routing / session state |
| `/tasks` / `/use …` | List or select active tasks |
| `/sessions` | Session overview |
| `/stop` | Stop the current turn |
| `/route` | Show bidirectional routing |
| `/quiet …` / `/unquiet …` | Mute / restore notification delivery |
| `/pair <code>` / `/unpair` | Pair / detach an inbound identity |
| `/log [N]` | Bounded redacted recent-notification summary; off by default and owner-only |

Plain text continues the conversation. Prefix with `!` to steer a running turn. Unsafe remote-control semantics are not enabled in group chats.

</details>

## How it fits together

```text
DSH events / notify() / other plugins
                 │
                 ▼
        dsh-notifier core
        ┌────────┴────────┐
        ▼                 ▼
  28 outbound        health / activity
     channels             │
        │                 │
        ▼                 │
      phone               │
        │                 │
        └─ 6 inbound ─────┘
             │
             ▼
 identity + Control Core
 approval · ask_user · conversation · task/session control
```

The Native UI, notifier runtime, tests, and Advanced Console are designed to observe the same underlying state rather than maintaining separate “UI truth” and “runtime truth”.

## Need help? Diagnose first, then report

Please **do not start by pasting a large log into an issue**. The fastest support path is:

1. Give an AI the [troubleshooting prompt](docs/TROUBLESHOOTING.en.md) and let it perform read-only diagnosis first.
2. Let the AI identify the installed version, DSH profile/version, install source, failing subsystem, and a minimal reproduction — with secrets redacted.
3. If the problem is safely fixable locally, fix and re-test it.
4. If it remains unresolved, have the AI generate a compact [diagnostic report](docs/DIAGNOSTICS.en.md).
5. Send that report through GitHub Issues or the contact channels below.

This keeps “old package / wrong profile / stale `file:` install / missing restart / provider credential” cases out of maintainer triage, while giving us a reproducible report when there is a real project bug.

## Documentation

| Document | Use it for |
| --- | --- |
| [Guide](docs/guide.en.md) | Install, first setup, outbound/inbound, pairing, daily use |
| [AI installation](docs/AI_INSTALL.en.md) | Safe copy/paste prompt for a terminal-capable AI |
| [Troubleshooting](docs/TROUBLESHOOTING.en.md) | Human + AI first-line diagnosis |
| [Diagnostics](docs/DIAGNOSTICS.en.md) | Evidence collection and support report format |
| [Compatibility](docs/compatibility-matrix.md) | DSH / optional SDK / provider evidence levels |
| [Upgrade guide](docs/upgrade-guide.en.md) | Update, verify version, stale-install cleanup, rollback |
| [Plugin API](PLUGINS.en.md) | `ctx.notifier` consumer API |
| [Architecture](docs/architecture.md) | Internal design and runtime authorities |
| [Changelog](CHANGELOG.md) | Release history |

## Contact

For reproducible bugs, prefer **GitHub Issues after AI-assisted diagnosis**.

- QQ: **3622976831**
- Email: **3622976831@qq.com**
- QQ group: **947656156**

<p align="center">
  <img src="docs/assets/qq-group.png" alt="dsh-notifier QQ group 947656156" width="300">
</p>

Do not send bot tokens, webhook secrets, admin tokens, full `state.json`, or unredacted private chat content through an issue, QQ, or email.

> Maintenance note: replies may be slower until **2026-10-01** because the maintainer is taking exams.

## Development

Node.js **22+**, ESM, and zero **mandatory** runtime dependencies. Some provider onboarding features use optional dependencies and load them only when needed.

Release verification remains documented in [AGENTS.md](AGENTS.md), [OPERATIONS](docs/OPERATIONS.md), and the repository test suite.

## License

MIT
