# Operations Runbook

## Local Checks

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
```

On Windows without the BurntToast PowerShell module, the full suite is expected to report four failures in `test/desktop.test.mjs`; treat this as a desktop capability gap and validate that adapter on a host with BurntToast installed. The remaining `881` tests must pass for the current `885`-test contract.

The project has no install step for runtime tests. Optional packages are needed only for the corresponding real inbound flows: Feishu SDK, QQ connector, or QR terminal rendering.

## State Directory

Use `$DSH_HOME/dsh-notifier` when `DSH_HOME` is set; otherwise the plugin falls back to `~/.dsh/dsh-notifier`. Keep `state.json`, ledger files, audit files, and lock/corrupt backups private. Do not manually edit a live state file while DSH is running; use the admin API or route CLI so the store merge/lock protocol is preserved.

## First-Time Setup

1. Install the registry package with the DSH plugin command and select the real profile.
2. Enable the loopback admin UI if browser configuration is desired.
3. Configure one outbound channel and use the admin test or `scripts/test-channel.mjs`.
4. Configure one inbound channel, pair the intended `(channel, userId)`, and verify `/whoami`.
5. Exercise one notification, one approval fallback, and one `ask_user` timeout before enabling unattended workflows.

The full end-user flow is in `docs/guide.md`. The CLI-only upgrade and rollback procedure is in `docs/upgrade-guide.md` and its English counterpart.

## Diagnostics

| Symptom | First checks |
|---|---|
| No outbound delivery | Admin channel status, `test-channel.mjs`, adapter config resolution, stderr warnings |
| Inbound silent | Optional dependency installed, token/account fallback, paired composite identity, provider long-poll/WS logs |
| Approval did not apply | Original chat/channel, token age, first-arrival state, desktop fallback; never treat timeout as approval |
| Ask-user missing | Installed package version, `questions.enabled`, startup assembly log, `npm ls dsh-notifier` |
| Route seems ignored | `node scripts/route.mjs show`, then `route.mjs test <sessionId>`; check enabled channel filtering |
| Admin unavailable | `admin.enabled`, loopback port, Bearer token, 1 MiB request limit, SSE connection cap |
| Behavior differs on phone | Run protocol/real-device validation; mocks do not model provider payload limits or callback parsing |

## Release Smoke Test

Before publishing, use a clean checkout or clean working tree, run `npm test`, run the release guard, regenerate the channel matrix in check mode, and compare the generated package manifest with the repository files. Then install the registry artifact in a disposable DSH profile, restart once, and verify the package version, `ask_user` assembly log, one outbound test, and one inbound command.
