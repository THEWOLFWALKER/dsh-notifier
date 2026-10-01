# Notification channel registry

Generated from `src/config.mjs`; update with `node scripts/gen-channel-matrix.mjs`.

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
