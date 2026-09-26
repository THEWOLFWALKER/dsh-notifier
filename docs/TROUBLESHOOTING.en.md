# dsh-notifier Troubleshooting

Use this support flow:

```text
AI-assisted read-only diagnosis
→ identify the failing layer
→ safely fix locally when clear
→ otherwise generate a Support Report
→ then report upstream
```

Do **not** start with uninstall/reinstall or state deletion. Preserve evidence.

## Copy/paste troubleshooting prompt

> Help me troubleshoot dsh-notifier. The first pass must be read-only: do not uninstall, reinstall, delete state, or change credentials. Identify the actual dsh-notifier version and install source, DSH version/profile, Node version, whether `client.js` is loaded, and whether the failure belongs to Native UI, outbound, inbound, identity/pairing, provider, storage, network, or Host compatibility. Build a minimal reproduction. Redact all logs/config and never print tokens, secrets, or Authorization headers. Report evidence and your conclusion first; only then propose a low-risk local fix if one is clear. If unresolved, generate a support report using `docs/DIAGNOSTICS.en.md`. Project: `https://github.com/THEWOLFWALKER/dsh-notifier`

## First-pass checklist

Confirm:
- Node version
- DSH/Harness version
- active profile
- actual dsh-notifier version
- install source (`registry`, `file:`, Git, manual)
- failing channel and direction
- minimal reproduction
- relevant sanitized logs

Classify the failure:

| Layer | Typical symptom |
| --- | --- |
| Install/profile | plugin/version not actually loaded |
| Native client | missing sidebar, empty page, slot error |
| Outbound config | save or Hot Apply mismatch |
| Provider | API/permission/quota/client rendering |
| Inbound runtime | configured but bot/WS not online |
| Identity/pairing | `/pair`, member/role mismatch |
| Control Core | approval/question settlement |
| Storage | read/write/corrupt/permission/disk |
| Network | DNS/proxy/timeout/TLS/webhook |
| Host compatibility | missing attachment/session/client seam |

Preserve the current state. Do not delete `state.json`, disable security checks, expose Admin publicly, rotate all secrets, or dump full configuration.

## Common cases

### Native entry missing
Check actual installed version, DSH restart, correct profile, installed `client.js`, Host compatibility, and client/slot logs.

### New version number, old behavior
Check:

```bash
npm ls dsh-notifier
pnpm why dsh-notifier
```

A stale `file:` installation is a common cause.

### Outbound save still requires restart
v0.13 outbound config is Hot Apply. Verify the running package and distinguish outbound from inbound.

### Inbound configured but offline
Check whether the UI reports **Restart pending**.

### API test succeeds but no phone message
Provider acceptance is not the same as confirmed client delivery. Record the provider result and actual client behavior separately.

### Pairing fails
Check private-chat source, code expiry/use, lockout, and identity/account scope.

If unresolved, use [DIAGNOSTICS.en.md](DIAGNOSTICS.en.md) to generate a compact support report.
