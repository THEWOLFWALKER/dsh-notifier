# Troubleshooting

## Notify & Control is missing

Check that dsh-notifier appears in the DSH plugin page. Restart DSH and refresh the page after installation. Make sure it is installed in the profile you use.

## Messages do not arrive

Send a test, read the result and check your phone. Confirm the recipient and app notification permissions. Replace invalid credentials. For Telegram connection problems, use a custom gateway address or Enable gateway.

## Notifications arrive but replies do not work

Configure incoming messages and restart if prompted. Send `/whoami` to the bot in a private chat. If unpaired, create a pairing code and send `/pair CODE`.

## Pairing or approval has expired

Pairing codes expire and are single-use. Generate a new one and use the corresponding bot's private chat. For an expired question or approval, return to the task on your computer.

## Gateway deployment fails

Check your Cloudflare login, account selection and connectivity, then retry. Existing resources remain. After changing the bot token, enable the gateway again.

## Imported channels are inactive

Open each channel marked for configuration, add its credentials and save. Credentials are not included in exported files.

Still stuck? Follow the [reporting steps](SUPPORT.en.md).
