# Get started

[简体中文](guide.md)

## Install

Replace `<profile-name>` with the DSH profile you use:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH and refresh the page. Open **Notify & Private chat** in the sidebar. An assistant can also follow the [installation request](AI_INSTALL.en.md).

## Receive a notification

Open **Notify & Private chat**, add a channel you use, enter its settings and save. Select **Test** and check your phone. This is enough if you only want task notifications.

If Telegram cannot connect, open its **Connection help** to enter a custom fallback connection address or choose **Prepare a fallback connection**. The plugin sets up the connection in your Cloudflare account. See [fallback connection setup](cloudflare.en.md).

## Reply from your phone

Configure incoming messages for a supported channel. Restart DSH if prompted.

Open the channel's **Private chat** and follow **Confirm it is you → Choose a task → Try it**. To confirm, send the bot a message from your phone, or make a confirmation code and send `/pair CODE` in the private chat. Once done, you can answer questions, handle approvals and continue conversations.

Message the bot privately. Pairing, replies and task control are unavailable in groups.

Send `/help` to see available commands or `/tasks` to view your current tasks.

## Move to another computer

Open **More → Import old settings**. Export a file, then preview it on the new computer and choose the changes to apply. Credentials are excluded. Open each imported channel marked for configuration, add its credentials and save before using it.

Notification changes usually apply after saving. Incoming-message settings may ask for a restart. See [upgrading](upgrade-guide.en.md) or [troubleshooting](TROUBLESHOOTING.en.md) when needed.
