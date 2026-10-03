# Telegram fallback connection and self-hosted Bark

## Enable a Telegram fallback connection

1. Open the Telegram channel and choose **Prepare a fallback connection** under **Connection help**.
2. Choose **Log in to Cloudflare** and complete authorization.
3. Select your account. Leave the bot token and recipient blank to reuse existing settings; fill them in for first-time setup.
4. Keep **Automatically fill and save Telegram settings** selected and choose **Prepare a fallback connection**.

The plugin deploys the service, obtains its address and saves your connection settings. Select **Also receive messages** if needed, then restart DSH when prompted.

The fallback connection reuses the bot token. After changing that token, enable the fallback connection again to update both sides.

## Use an existing fallback connection

Choose **Use a custom address** under the Telegram channel's **Connection help** and enter its root address. Ordinary Telegram reverse proxies and this plugin's fallback connection are supported. Save to apply. Choose **Direct** and save to stop using the fallback connection.

## Self-host Bark

Open the Cloudflare deploy page, log in, select an account and choose Bark. Reach it from the Telegram channel's **Connection help**.

Allow Bark App registration for initial setup and deploy. Add the displayed server address in Bark App. Enter the Bark Key provided by the app and select **Link channel**.

After adding devices, turn registration off and redeploy. Personal self-hosting uses Bark's officially published push configuration; no separate Apple certificate application is required.

## Retry or disconnect

Check login and connectivity after an error, then retry. Existing resources are reused. If deployment succeeds but local saving fails, the address remains available for linking later and prior settings remain intact.

**Unbind** restores local connection settings and retains the cloud service. Delete the service in your Cloudflare account if you no longer need it.
