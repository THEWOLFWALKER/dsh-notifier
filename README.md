<p align="center"><img src="docs/assets/readme-hero.png" alt="dsh-notifier" width="100%"></p>

# dsh-notifier

Keep up with your agent from your phone.

Get DeepSeek Harness task updates wherever you are. Reply to questions, handle approvals, or continue a conversation when needed. Supports 28 notification channels, including Telegram, Bark, WeChat, QQ, Feishu and DingTalk.

[简体中文](README.zh-CN.md) · [Get started](docs/user/guide.en.md) · [Troubleshooting](docs/user/TROUBLESHOOTING.en.md)

[![npm](https://img.shields.io/npm/v/dsh-notifier?style=flat-square)](https://www.npmjs.com/package/dsh-notifier) [![License](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE) [![dshfind](https://dshfind.com/api/badge/THEWOLFWALKER/dsh-notifier?lang=en)](https://dshfind.com/en/plugins/THEWOLFWALKER/dsh-notifier?ref=badge)

`dsh-notifier@0.13.1`

## Get started

Replace `<profile-name>` with the DSH profile you use:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH and refresh the page. Open **Notify & Control**, choose a notification channel, fill in its settings and save. Send a test and check your phone.

For notifications, that is all you need. To reply from your phone, configure incoming messages and [pair your account](docs/user/guide.en.md).

You can also [ask an assistant to install it](docs/user/AI_INSTALL.en.md).

## One-click Telegram gateway

If Telegram cannot connect, choose **Enable gateway** in its settings. Log in to Cloudflare and select an account. The plugin deploys the gateway, obtains its address, and fills and saves the settings automatically. It reuses your bot token.

Already have a gateway? Choose **Custom gateway address** and enter its root address. [Steps](docs/user/cloudflare.en.md).

## Move your settings

Export settings from **Channels**, then preview and choose what to import on another computer. Passwords and bot credentials are excluded; add them after importing.

## Get help

Check [troubleshooting](docs/user/TROUBLESHOOTING.en.md), then [report the issue](docs/user/SUPPORT.en.md) with the steps and a diagnostic summary.

QQ: 3622976831 · Email: 3622976831@qq.com · QQ group: 947656156

Development and integration references are in [docs/developer](docs/developer/README.md).

MIT; cloud template licenses are listed in [third-party notices](THIRD_PARTY_NOTICES.md).
