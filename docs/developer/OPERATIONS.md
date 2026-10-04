# Operations Runbook

## Development and release branches

The rebuild targets package version 0.15.0. Development happens on `dev`; `main` is the release branch. A local package dry run does not publish to npm.

Before preparing a release, run the checks below and follow [VERSIONING.md](VERSIONING.md). Historical package evidence remains in [archive/CHANGELOG.md](archive/CHANGELOG.md). Do not retag an existing release or treat a local tarball as a registry publication.

## Local checks

```text
npm test
npm run test:dom
npm run verify:release
node scripts/gen-channel-matrix.mjs --check
node scripts/verify-host-compat.mjs
node --check src/index.mjs
node --check client.js
npm pack --dry-run --json
git diff --check
```

Optional provider packages are needed only for their real inbound flows, including the Feishu SDK and QR terminal rendering.

## Product surfaces

- **DSH Native Notify & Private chat** is the daily interface for channels, private chat setup, task selection, pending questions, help and support reports.
- **YAML and CLI** support reproducible and headless deployments.

There is no standalone Admin Console or recovery server. Native actions use the admitted DSH Host connection. If Native is unavailable, inspect the host and plugin logs or stop the host and use the offline state backup; the plugin does not start an alternate listener.

## State directory and reset

Use `$DSH_HOME/dsh-notifier` when `DSH_HOME` is set; otherwise the plugin falls back to `~/.dsh/dsh-notifier`.

Keep private:

- `state.json`
- ledger files and lock/corrupt backups
- `bootstrap-paircode.txt` while present

On first v0.15 startup, prior plugin state is copied to a mode-0600 offline backup and a fresh schema is initialized. Credentials, identities, authorization and routes are not loaded from the old state. Re-add channels, confirm the private identity and select a task in Native. Use the backup only for offline reference; do not restore the whole file.

The bootstrap pairing file is mode `0600`; logs print only its path, never the code. Do not manually edit live state while DSH is running.

## First-time setup

1. Install the package into the intended DSH profile and restart DSH.
2. Open **Notify & Private chat** from Sidebar or Plugins.
3. Add a notification channel, enter its credentials and save.
4. Send a test notification and check the device. Provider acceptance alone does not confirm delivery.
5. If private control is needed, explicitly enable private chat, confirm the intended identity and choose its task.
6. Exercise a notification, an approval and an `ask_user` response before unattended use.

Outbound edits apply immediately when the runtime reports hot apply. Inbound transports may require a restart; follow the Native status.

## Troubleshooting

| Symptom | First checks |
|---|---|
| Native entry missing | Installed package, supported Host version, DSH restart, client module load errors |
| Native panel cannot load | DSH Connection/webServer route and Host logs |
| Notification not received | Channel credentials, test result, `channel-selfcheck.mjs`, provider response |
| Private chat silent | Explicit channel enablement, stable account identity, provider private-chat evidence, pairing and task selection |
| Approval did not apply | Original private chat, token age and first-arrival state; timeout never means approval |
| `/pair` rejected | Private-chat boundary, code age/use state and failure lock |
| Behavior differs on device | Provider/Host evidence in `compatibility-matrix.md`; contract tests do not certify device behavior |

Provider-specific media, callback ACK and long-connection behavior remains evidence-scoped. Do not describe contract-tested behavior as real-device verified.

## DSH Host compatibility

Declared peer range:

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

Release evidence levels are documented in [compatibility-matrix.md](compatibility-matrix.md). `verify-host-compat.mjs` is part of the release guard.

## Branch flow

```text
git switch dev
git status --short --branch
npm test
npm run test:dom
npm run verify:release
node scripts/gen-channel-matrix.mjs --check
node scripts/verify-host-compat.mjs
```

The npm payload is controlled by `package.json.files`; contributor-only rebuild notes and test artifacts remain excluded.
