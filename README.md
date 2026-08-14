# dsh-notifier

Unified notification push plugin for DeepSeek Harness (DSH). One minimal `notify()` API in front, many channels behind — both your agent and the harness itself can push to wherever you live.

## Features

- **Dual trigger lines**:
  - **Auto status push** — listens to `session/event` (`turn/end`, `approval/asked`, `agent/error`) and notifies you when tasks finish, fail, or need approval. Debounced 10s, deduped by session.
  - **Agent-initiated** — registers a `notify` tool so the model can call it directly (e.g. when it finishes a long task or needs a decision).
- **8 channels out of the box** (each a ~30-line adapter, zero runtime deps — only `fetch` + `node:crypto`):
  - Telegram / DingTalk (HMAC-SHA256 signed) / Feishu (second-level signed) / WxPusher / PushPlus / Server酱 / Bark (self-hosted or default) / generic webhook
- **Secrets safe** — channel keys marked `role('secret')`, redacted everywhere including custom webhook headers.
- **Never breaks startup** — misconfigured or missing channels are skipped silently with a log line.

## Install

```bash
dsh plugin add dsh-notifier
```

## Configuration

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
        - type: feishu
          webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/..."
        - type: wxpusher
          appToken: "AT_..."
          uids: ["UID_..."]
        - type: pushplus
          token: "..."
        - type: serverchan
          sct: "SCT..."
        - type: bark
          key: "your-device-key"   # or selfHost: "https://your-bark-server"
        - type: webhook
          url: "https://your-webhook"
          headers: { "x-token": "..." }   # optional
```

## Usage

### Auto push

Just enable the plugin. `turn/end` (success/error/cancelled), `approval/asked`, and `agent/error` events are pushed to all configured channels.

### Agent-initiated

The model can call the `notify` tool:

```
notify({ message: "调研完成，结果已写入 docs/", channel: "telegram", title: "任务完成" })
```

## Channels

| type | Channel | Auth | Free? |
|---|---|---|---|
| `telegram` | Telegram Bot API | bot token + chat id | ✅ |
| `dingtalk` | DingTalk custom robot | webhook + secret (HMAC) | ✅ |
| `feishu` | Feishu custom bot | webhook | ✅ |
| `wxpusher` | WxPusher (WeChat) | app token + uid | ✅ (with limits) |
| `pushplus` | PushPlus (WeChat) | token | ✅ (with limits) |
| `serverchan` | Server酱 (WeChat) | sct token | ✅ (with limits) |
| `bark` | Bark (iOS) | device key | ✅ |
| `webhook` | Any custom endpoint | — | — |

## Development

```bash
npm test          # node --test, 72 cases
```

Pure ESM (`.mjs`), zero runtime dependencies. To add a channel: implement the adapter interface (`resolve(cfg)` + `send(msg)`) in `src/adapters/` and register it.

## TODO

- WeCom (企业微信), Discord, Slack, Email (SMTP) adapters
- Web settings UI
- Per-channel rate limiting / retry with backoff

## License

MIT
