# Install dsh-notifier with an AI

This document is intended for an AI/agent with terminal access to the machine.

## One-sentence prompt

> Install or upgrade the latest stable dsh-notifier on this machine. First detect the active DSH profile and current install source, verify the installed DSH/Node versions are compatible, and preserve the existing configuration. Do not modify unrelated plugins or print any token/secret. Install from the official package, restart the relevant DSH Host once, verify the actual installed version and the **Notify & Control** entry, then report the commands you ran, the result, and any remaining problem. Project: `https://github.com/THEWOLFWALKER/dsh-notifier`

## Full agent prompt

```text
You are helping the user install or upgrade dsh-notifier.

Project:
https://github.com/THEWOLFWALKER/dsh-notifier

First perform read-only inspection:

1. Identify Node.js version.
2. Identify DSH/Harness version.
3. Detect the active/common DSH profile. If multiple profiles exist and you cannot determine the target, list them and ask instead of guessing.
4. Check whether dsh-notifier is already installed.
5. Identify its install source: registry, file:, Git, or manual node_modules.
6. Record the current version.
7. Never print full state.json, bot tokens, webhook secrets, admin tokens, or Authorization headers.
8. Do not modify unrelated plugins.

Then install the official stable release:

dsh plugin add dsh-notifier@latest --profile <correct-profile>

If that CLI does not accept @latest:

dsh plugin add dsh-notifier --profile <correct-profile>

Do not replace a stable release with dev source unless explicitly requested.
Do not use manual source-copying into node_modules as the persistent installation method.

After installation:

1. Restart the relevant DSH Host once.
2. Verify the actual installed package version, not just command output.
3. Verify client.js exists in the installed package.
4. For a web/Native-capable profile, check:
   - Notify & Control appears in the sidebar;
   - dsh-notifier appears in Plugins.
5. Do not require notification-channel secrets merely to verify installation.
6. Preserve existing channel configuration.
7. If installation fails, preserve evidence and switch to read-only diagnosis instead of repeated reinstall loops.

Final report:
- profile
- Node version
- DSH version
- dsh-notifier version/source before
- actual version after
- commands executed
- restart status
- Native entry status
- stale file:/install-source risk
- warnings/failures
- next step

Never include secrets.
```

If the package is installed but the UI is missing or behavior is stale, use [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md).
