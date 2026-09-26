# dsh-notifier Diagnostics

Use this after first-line troubleshooting has not resolved the problem.

The goal is a **small reproducible support report**, not a giant log dump.

## Evidence to collect

Record:

```text
OS
Node
DSH/Harness
DSH profile
dsh-notifier version
install source
channel
direction/capability
first known bad version
reproducibility
```

Install source must be explicit: registry, `file:`, Git, manual node_modules, or unknown.

## Minimal reproduction

Reduce the failure to the shortest sequence of actions.

Separate:

```text
Expected
Actual
```

For delivery issues also separate:

```text
provider accepted?
confirmed receipt?
client actually displayed?
```

## Safe version/install evidence

Examples:

```bash
node -v
npm ls dsh-notifier
pnpm why dsh-notifier
npm view dsh-notifier version
```

Do not guess the active package from the repository checkout; inspect the dependency tree used by the active DSH profile.

## Native UI

Capture:
- Plugins entry present?
- Notify & Control sidebar entry present?
- installed `client.js` present?
- client/slot/module error?
- blank, crash, or stale UI?

Screenshots are useful, but redact tokens/private data first.

## Outbound

Capture:
- channel type
- save result
- provider status/code/message, redacted
- Hot Apply result
- whether the next real send uses the new config

## Inbound

Capture:
- configured
- active
- restartPending
- transport state
- last connect/disconnect error

## Identity/pairing

Capture:
- private/group
- channel
- presence of accountId/userId
- code expired/used/locked?
- role
- rejection reason/code

Do not post full user identifiers when unnecessary.

## Storage

Report status only:

```text
file exists/readable/writable
bootStatus
disk/permission condition
STATE_BUSY / STATE_CORRUPT / STATE_READ_FAILED / STATE_WRITE_FAILED
```

Never upload full `state.json`.

## Network

Capture:
- DNS/proxy/TLS/timeout
- non-secret target host
- HTTP status/provider code
- redirect behavior

Never post Authorization headers.

## Support Report template

```markdown
# dsh-notifier Support Report

## Environment
- OS:
- Node:
- DSH/Harness:
- Profile:
- dsh-notifier:
- Install source:

## Scope
- Channel:
- Direction:
- Capability:
- First known version:
- Reproducible: yes/no

## Expected
...

## Actual
...

## Minimal reproduction
1.
2.
3.

## Evidence
- Provider accepted:
- Confirmed receipt:
- Runtime state:
- Relevant error code:
- Sanitized log excerpt:

## Checks already completed
- [ ] actual package version verified
- [ ] install source checked
- [ ] correct profile confirmed
- [ ] DSH restarted after package upgrade
- [ ] stale file: install checked
- [ ] restartPending checked where relevant
- [ ] secrets redacted

## Local fixes attempted
...

## AI diagnosis
Most likely layer:
Evidence:
Remaining uncertainty:

## Attachments
- screenshots:
- sanitized logs:
```

Remove tokens, secrets, bearer headers, full webhooks, full state files and unredacted private chat before reporting.
