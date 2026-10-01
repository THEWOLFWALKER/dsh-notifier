# Get started

[简体中文](guide.md)

## Install

Replace `<profile-name>` with the DSH profile you use:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH and refresh the page. Open **Notify & Control** in the sidebar. An assistant can also follow the [installation request](AI_INSTALL.en.md).

## Receive a notification

Open **Channels**, choose an app you use, enter its settings and save. Select **Test** and check your phone. This is enough if you only want task notifications.

If Telegram cannot connect, enter a custom gateway address or choose **Enable gateway**. The plugin can deploy it to your Cloudflare account and fill in the settings automatically. See [gateway setup](cloudflare.en.md).

## Reply from your phone

Configure incoming messages for a supported channel. Restart DSH if prompted.

Open **Pairing codes**, generate a code and send `/pair CODE` in a private chat with the bot. Once paired, you can answer questions, handle approvals and continue conversations.

Send `/help` to see available commands or `/tasks` to view active tasks.

## Move to another computer

Open **Import / export** from Channels. Export a file, then preview it on the new computer and choose the changes to apply. Credentials are excluded. Open each imported channel marked for configuration, add its credentials and save before using it.

Notification changes usually apply after saving. Incoming-message settings may ask for a restart. See [upgrading](upgrade-guide.en.md) or [troubleshooting](TROUBLESHOOTING.en.md) when needed.
