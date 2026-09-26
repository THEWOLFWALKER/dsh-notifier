# dsh-notifier Guide

> Goal: go from “plugin installed” to “notifications reach my phone, and I can respond when the agent needs me.”\
> 中文版: [guide.md](guide.md)

## Choose your target

| Mode | What you get | Required setup |
| --- | --- | --- |
| **Notifications** | Task completion, approval, error and long-running status notifications | At least one outbound channel |
| **Remote control** | Mobile approvals, `ask_user`, remote conversation, task/session control | Outbound + supported inbound + pairing |
| **Headless / automation** | YAML / CLI without depending on Native UI | DSH profile + YAML / CLI |

For a first install, get **notifications** working before adding remote control.

## 1. Install

### Ask an AI to install it

Copy this to an AI/agent with terminal access:

> Install or upgrade the latest stable dsh-notifier on this machine. First detect the active DSH profile and current install source, verify that the installed DSH/Node versions are compatible, and preserve the current configuration. Do not modify unrelated plugins or print any token/secret. Install from the official package, restart the relevant DSH Host once, verify the actual installed version and the **Notify & Control** entry, then report the commands you ran, the result, and any remaining problem. Project: `https://github.com/THEWOLFWALKER/dsh-notifier`

Full procedure: [AI_INSTALL.en.md](AI_INSTALL.en.md).

### Manual install

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH once so the Host plugin and `client.js` are loaded.

Verify:
1. **Notify & Control** appears in the sidebar.
2. `dsh-notifier` appears under Plugins.
3. The actual installed version is the release you expect.

If the version looks correct but behavior is old, see [upgrade-guide.en.md](upgrade-guide.en.md) and check for stale `file:` installs.

## 2. Configure your first notification channel

Open:

```text
DSH Sidebar
→ Notify & Control
→ Channels
```

Pick a service you already use, enter its credentials, then choose **Save and test**.

### What “test success” means

dsh-notifier distinguishes:

- **provider accepted** — the provider API accepted the request;
- **confirmed** — explicit end-to-end receipt evidence exists.

Many providers only expose the first signal. If the UI says the provider accepted the test, verify it on the device.

## 3. Understand Hot Apply

Outbound changes are hot-applied:

```text
save
→ validate
→ persist canonical state
→ update live runtime
→ next send uses the new config
```

Inbound WebSocket/SDK/long-poll transports may still show **Restart pending** and require a restart to recreate the connection.

## 4. Notifications-only mode

Common automatic notification sources include:

- `turn/end`
- `approval/asked`
- `agent/error`
- long-running heartbeat
- stall
- model-triggered `notify`

No member pairing is required if you only receive notifications.

## 5. Enable remote control

Supported inbound control channels:

```text
Telegram
Feishu
QQ official bot
WxPusher
WeChat iLink
DingTalk
```

Provider onboarding differs. If the UI marks an inbound change as restart-pending, restart DSH after saving it.

## 6. Pair identities

Membership uses the canonical principal:

```text
(channel, accountId, userId)
```

`chatId` / `chatType` scope the event source; they are not the membership identity itself.

Create a pairing code in Advanced Console, then send:

```text
/pair <code>
```

from the bot private chat.

Unknown or incomplete identities fail closed.

## 7. Daily mobile control

Plain text continues the remote conversation.

To steer a running turn:

```text
! use plan B and do not touch the database yet
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `/help` | Commands |
| `/whoami` | Identity / pairing |
| `/status` | Routing / session state |
| `/tasks` / `/use …` | Task list / selection |
| `/sessions` | Session overview |
| `/stop` | Stop current turn |
| `/route` | Bidirectional route |
| `/quiet …` / `/unquiet …` | Mute / restore notifications |
| `/pair <code>` / `/unpair` | Pair / detach |
| `/log [N]` | Bounded redacted recent log; off by default, owner-only |

Unsafe remote-control semantics are not enabled in group chats.

## 8. Advanced Console

Use the Native UI for daily work. Use Advanced Console for:

- members / pairing;
- pending identities;
- bindings;
- session management;
- deeper diagnostics;
- Native recovery.

It remains loopback-only on `127.0.0.1`.

## 9. YAML / CLI

For automation/headless use:

```yaml
insert:
  - id: dsh-notifier
    config:
      channels:
        - type: telegram
          botToken: "${ENV:TELEGRAM_BOT_TOKEN}"
          chatId: "987654321"
```

Prefer `${ENV:NAME}` for credentials and never commit secrets.

CLI examples:

```bash
node scripts/channel-login.mjs <qq|dingtalk|feishu|wechat>
node scripts/channel-selfcheck.mjs ...
node scripts/route.mjs show
```

Avoid manually editing a live `state.json`; let the existing store preserve lock/transaction/merge semantics.

## 10. Upgrade

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart once after installing a new package version. See [upgrade-guide.en.md](upgrade-guide.en.md) for stale installs and rollback.

## If something is wrong

Start with AI-assisted read-only diagnosis:

[TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md)

If it remains unresolved, generate a support bundle using:

[DIAGNOSTICS.en.md](DIAGNOSTICS.en.md)

Do not post secrets, full state files, authorization headers, or unredacted private messages.

## More docs

- [AI installation](AI_INSTALL.en.md)
- [Troubleshooting](TROUBLESHOOTING.en.md)
- [Diagnostics](DIAGNOSTICS.en.md)
- [Compatibility](compatibility-matrix.md)
- [Operations](OPERATIONS.md)
- [Plugin API](../PLUGINS.en.md)
