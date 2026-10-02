# Upgrade

Update dsh-notifier from the DSH plugin page, then restart DSH and refresh the page. You can also repeat the installation command:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Open **More → Import old settings** to export settings before upgrading if desired. Exported files exclude passwords and bot credentials.

After upgrading, open **Notify & Private chat**, check your channels and send a test. Restart again only if incoming-message settings request it.

If the old interface remains, confirm you updated the profile currently in use. See [troubleshooting](TROUBLESHOOTING.en.md).
