# Operations Runbook

## Release and development branches

Current package version: **0.13.1**. Development happens on `dev`; `main` is the release branch. A local package dry run does not publish to npm.

Before preparing a release, run the checks below and follow [VERSIONING.md](VERSIONING.md). Historical package evidence remains in [archive/CHANGELOG.md](archive/CHANGELOG.md). Do not retag an existing release or treat a local tarball as a registry publication.

## Local checks

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
node --check client.js
npm pack --dry-run --json
git diff --check
```

The project has no runtime install step for tests. Optional packages are only needed for the corresponding real inbound flows (Feishu SDK, QQ connector, QR terminal rendering).

## Control-plane model

Three distinct operator surfaces:

1. **DSH Native Notify & Private chat** — the single daily page with channel selection, account settings, the private-chat wizard and contextual pending items. Secondary settings and support reports are under More.
2. **Advanced Console** — loopback-only (`127.0.0.1`) recovery / raw-audit fallback: the shared read-only support report when the Native surface cannot be used. Daily administration markup is removed; startup does not fetch old daily APIs.
3. **YAML / CLI** — automation/headless/reproducible deployment.

Do not describe the Advanced Console as the only control console.

Native and Standalone reuse the same runtime authorities. Native must never call the localhost Admin API directly.

## State directory

Use `$DSH_HOME/dsh-notifier` when `DSH_HOME` is set; otherwise the plugin falls back to `~/.dsh/dsh-notifier`.

Keep private:

- `state.json`
- ledger/audit files
- lock/corrupt backups
- `bootstrap-paircode.txt` while present

The bootstrap pairing file is mode `0600`; logs print only its path.

### v0.12 outbound state

Canonical editable outbound state:

```text
channel:<type>:outbound
```

Read precedence is intentionally compatibility-aware:

1. canonical `channel:<type>:outbound` — always;
2. old `admin:channel:<type>:outbound` — compatibility-only when Admin is enabled;
3. legacy non-dual `<type>:account` — compatibility-only under the old Admin path;
4. YAML bootstrap.

Do not manually edit a live state file while DSH is running.

## First-time setup

1. Install the registry package:
   ```bash
   dsh plugin add dsh-notifier@latest --profile <profile-name>
   ```
2. Restart DSH once.
3. Open **Notify & Private chat** from Sidebar or Plugins.
4. Configure one outbound channel.
5. Save settings, then use the separate optional test action. Check the phone; provider acceptance alone is not confirmed delivery.
6. If remote control is needed, configure an inbound channel and pair the intended identity.
7. Exercise one notification, one approval fallback, and one `ask_user` timeout/settlement before unattended use.

Outbound config changes are Hot Apply in v0.12. Inbound transports may still be restart-bound; honor the UI `applyMode`.

## Advanced Console recovery

Advanced Console remains:

- loopback-only;
- Bearer-protected for privileged APIs;
- recovery access to members, pairing, bindings, sessions and diagnostics (the Native surface owns the daily path).

Normal Native handoff uses a short-lived one-time launch ticket. Native does not receive the long-lived Admin bearer.

If `admin.enabled=false`, Native must report Advanced Console unavailable; it must not start a new listener as a side effect.

Recovery address: use the actual `Web 管理台已就绪` startup line; never guess the port.

## Diagnostics

| Symptom | First checks |
|---|---|
| No Native Sidebar entry | package is `0.13.1+`, DSH restarted, Host version in declared range, client module served |
| Native panel fails to load | DSH slot/client errors, `client.js` package payload, Connection/webServer control route |
| No outbound delivery | Channels health, real test result, `channel-selfcheck.mjs`, adapter validation |
| Saved outbound still uses old credentials | Confirm actual registry version; v0.13.1 must read the live `OutboundSource` |
| Inbound silent | optional SDK/transport, account/source identity, pairing, provider WS/long-poll logs, restart-pending state |
| Approval did not apply | original source/chat, token age, first-arrival state; timeout is never approval |
| `ask_user` missing | installed version, questions assembly, task/session binding |
| `/pair` rejected | private-chat boundary, code age/use state, failure lock |
| Advanced Console unavailable | `admin.enabled`, loopback bind, current port; Native will not auto-enable it |
| Need a pasteable diagnostic | Native Diagnostics view (attention summary + one-click redacted report); Advanced Console for raw storage |
| Behavior differs on provider/device | consult `docs/developer/memory/risks.md`; contract tests do not certify provider payloads |

Provider-specific media, callback ACK and long-connection behavior remains evidence-scoped. Do not turn “contract-tested” into “real-device-verified”.

## DSH host compatibility

Declared peer range:

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

Release evidence levels are documented in [compatibility-matrix.md](compatibility-matrix.md). `verify-host-compat.mjs` is part of the release guard.

## Release smoke test

Before publishing:

1. clean working tree;
2. full local gates;
3. `npm pack --dry-run --json` payload review;
4. install the **registry artifact** into a disposable DSH profile (not a lingering `file:` install);
5. verify package version + `exports["./client"]`;
6. boot DSH;
7. open Native surface;
8. save/test one outbound channel;
9. verify the next real notifier operation sees the saved channel without restart;
10. exercise one inbound command / question path when available.

Record unverified real-provider gaps instead of hand-waving them away.

## Branch / release flow

Repository model:

- `dev` — development
- `main` — release/public docs

Typical flow:

```text
git switch dev
git status --short --branch
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check

git switch main
git merge --ff-only dev
npm pack --dry-run --json
# tag the reviewed release commit, then publish
```

Never retag or force-push published history. Docs-only release-fact follow-ups may legitimately put `main` ahead of the annotated tag.

The npm payload is controlled independently by `package.json.files`; agent/tool directories and contributor-only handoff files remain excluded.
