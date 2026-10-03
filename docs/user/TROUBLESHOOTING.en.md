# Troubleshooting

## Notify & Private chat is missing

Check that dsh-notifier appears in the DSH plugin page. Restart DSH and refresh the page after installation. Make sure it is installed in the profile you use.

## Messages do not arrive

Send a test, read the result and check your phone. Confirm the recipient and app notification permissions. Replace invalid credentials. For Telegram connection problems, open its **Connection help** and choose **Prepare a fallback connection**.

## Notifications arrive but replies do not work

Configure incoming messages and restart if prompted. Open the channel's **Private chat** and confirm it is you; if not confirmed yet, make a confirmation code and send `/pair CODE` in the private chat.

## Confirmation or approval has expired

Confirmation codes expire and are single-use. Make a new one and use the corresponding bot's private chat. For an expired question or approval, return to the task on your computer.

## Fallback connection deployment fails

Check your Cloudflare login, account selection and connectivity, then retry. Existing resources remain. After changing the bot token, enable the fallback connection again.

## Imported channels are inactive

Open each channel marked for configuration, add its credentials and save. Credentials are not included in exported files.

Still stuck? Follow the [reporting steps](SUPPORT.en.md).
