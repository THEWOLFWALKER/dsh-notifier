# Operations Runbook

## Current release baseline

Current release: **dsh-notifier v0.12.0**.

Release evidence (2026-09-25):

- `npm test`: **1831 / 1831 pass**
- `node scripts/verify-release.mjs`: release guard green
- `node scripts/gen-channel-matrix.mjs --check`: **28 channels**
- `npm pack --dry-run --json`: **262 files**, `client.js` included, no agent-config leak
- npm registry: `latest = 0.12.0`
- registry shasum: `e1499cc4a246921be4262aa49e5a8080377bf999`
- real DSH host `0.1.7-rc.2`: Native UI + setup + save/test + Hot Apply walkthrough passed
- compatibility floor `0.1.7-alpha.1`: activation/RPC/client-module smoke passed

`main` may contain docs-only follow-up commits after the annotated `v0.12.0` tag. The tag points to the release artifact commit; this is expected.

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

v0.12 has three distinct operator surfaces:

1. **DSH Native Notify & Control** — primary daily surface.
2. **Advanced Console** — loopback-only (`127.0.0.1`) deep management/recovery.
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
3. Open **Notify & Control** from Sidebar or Plugins.
4. Configure one outbound channel.
5. Use **Save and test**; setup is complete only after a real delivered test.
6. If remote control is needed, configure an inbound channel and pair the intended identity.
7. Exercise one notification, one approval fallback, and one `ask_user` timeout/settlement before unattended use.

Outbound config changes are Hot Apply in v0.12. Inbound transports may still be restart-bound; honor the UI `applyMode`.

## Advanced Console recovery

Advanced Console remains:

- loopback-only;
- Bearer-protected for privileged APIs;
- available for members/pairing/bindings/sessions/diagnostics.

Normal Native handoff uses a short-lived one-time launch ticket. Native does not receive the long-lived Admin bearer.

If `admin.enabled=false`, Native must report Advanced Console unavailable; it must not start a new listener as a side effect.

Recovery address: use the actual `Web 管理台已就绪` startup line; never guess the port.

## Diagnostics

| Symptom | First checks |
|---|---|
| No Native Sidebar entry | package is `0.12.0+`, DSH restarted, Host version in declared range, client module served |
| Native panel fails to load | DSH slot/client errors, `client.js` package payload, Connection/webServer control route |
| No outbound delivery | Channels health, real test result, `channel-selfcheck.mjs`, adapter validation |
| Saved outbound still uses old credentials | Confirm actual registry version; v0.12 must read the live `OutboundSource` |
| Inbound silent | optional SDK/transport, account/source identity, pairing, provider WS/long-poll logs, restart-pending state |
| Approval did not apply | original source/chat, token age, first-arrival state; timeout is never approval |
| `ask_user` missing | installed version, questions assembly, task/session binding |
| `/pair` rejected | private-chat boundary, code age/use state, failure lock |
| Advanced Console unavailable | `admin.enabled`, loopback bind, current port; Native will not auto-enable it |
| Behavior differs on provider/device | consult `docs/memory/risks.md`; contract tests do not certify provider payloads |

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
