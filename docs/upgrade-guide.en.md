# dsh-notifier Upgrade Guide

> For DSH users: update, verify the installed build, migrate from v0.12.1 to v0.13, triage stale installs, and roll back.
>
> 中文版：[`upgrade-guide.md`](upgrade-guide.md)

## 1. Update to the latest release

Recommended:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

If your DSH CLI does not accept `@latest`:

```bash
dsh plugin add dsh-notifier --profile <profile-name>
```

Or manage it from the DSH root:

```bash
npm install dsh-notifier@latest
# or
pnpm add dsh-notifier@latest
```

### Restart once after installing the new package

Restart DSH once so the new Host plugin and `client.js` are loaded.

That restart is required to **load the upgrade**. It does not mean v0.13 outbound edits are restart-bound: once v0.13 is running, outbound channel saves Hot Apply through the shared canonical runtime truth.

## 2. What changes from v0.11 to v0.12

### Native is now the primary UI

Old daily path:

```text
startup log
→ copy localhost /#token link
→ configure in Web Admin
```

v0.12 primary path:

```text
DSH Sidebar "Notify & Control"
or Plugins → dsh-notifier
→ configure channel
→ save + real test
```

The Standalone Web console remains as **Advanced / Recovery**.

### Outbound saves are live

The old v0.11 “view-hot, delivery-cold / restart required” rule no longer applies to v0.12 outbound configuration.

v0.12:

```text
save
→ validate / resolve
→ persist
→ atomically replace OutboundSource entry
→ next send uses the new config
```

### Canonical outbound state changed

New writes use:

```text
channel:<type>:outbound
```

Old `admin:channel:<type>:outbound` and legacy `<type>:account` entries are compatibility inputs only.

The canonical state is independent of `admin.enabled`.

### Inbound can still be restart-bound

v0.12 intentionally does not implement a generic hot-reloader for every inbound SDK/WS/long-poll transport. Follow the UI `applyMode`.

## 3. Verify the actual installed version

| Evidence | How | v0.12 expected |
|---|---|---|
| Native UI | DSH Sidebar / Plugins | `Notify & Control` entry exists |
| CLI | `npm ls dsh-notifier` / `pnpm ls dsh-notifier` | `0.13.1` or newer |
| Registry | `npm view dsh-notifier version` | matches the release you intended to install |

Developers can also inspect the installed package:

```text
exports["./client"] = "./client.js"
dshQuality.testCount = 2011    # v0.13.1 release line; last published v0.13.0 snapshot was 1985
```

## 4. Version says 0.12, behavior looks old

The usual cause is a stale `file:` install, manual node_modules overwrite, or pnpm restoring a different package tree.

Check:

```bash
pnpm why dsh-notifier
# or
npm ls dsh-notifier
```

A `file:` / absolute local path means you are not testing the registry artifact.

Clean reinstall:

```bash
dsh plugin remove dsh-notifier --profile <profile-name>
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

Restart DSH afterwards.

## 5. v0.12 triage

### Native entry is missing

Check:

1. installed package is `0.13.1+`;
2. DSH restarted;
3. Host version is in the declared range;
4. installed package contains `client.js`;
5. the web profile reports no client-module/slot failure.

Declared range:

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

### Outbound save still requires restart

That is not normal v0.12 behavior. Verify that you are testing the registry build, that the edit is outbound (not inbound), and that no stale local package is shadowing it.

### Advanced Console will not open

Native does not auto-enable `admin.enabled`. If you explicitly disabled Admin, re-enable it or use YAML/CLI for recovery.

## 6. Roll back to v0.11

```bash
dsh plugin add dsh-notifier@0.11.0 --profile <profile-name>
```

Back up state first.

v0.11 does not understand the v0.12 canonical key:

```text
channel:<type>:outbound
```

A channel configured only through v0.12 Native UI may therefore disappear after downgrade unless the same configuration still exists in YAML/legacy state. Reconfigure it in v0.11 if needed.

Do not edit a live state file by hand.

## 7. Developers: use the registry artifact as the real-machine baseline

`file:` is for temporary development only.

Before publishing or reporting a real-host result, install the registry build, then verify:

- registry version;
- package payload;
- Native client module;
- one real save/test;
- one real post-save outbound operation without restart.

Green mocks/contracts do not certify external provider/device behavior.

## 8. v0.13.1 → v0.14 (dev line) preview

v0.14 is the **Native-first Completion** development line and is not released yet. It keeps moving
daily management into the Native **Notify & Control** panel and demotes the Advanced Console further
toward recovery:

- **Native gains the daily views**: Questions, Tasks, Members, Pending identities, Pairing codes,
  Sessions, Channels, Activity and Diagnostics. Members / pairing / pending / session management
  that used to require the Advanced Console are done in Native on v0.14.
- **New Diagnostics view**: answers “does anything need attention / why / when did we last check” and
  offers a one-click, redacted, pasteable support report.
- **Advanced Console**: still loopback + Bearer, now positioned as recovery / raw audit / low-level
  storage diagnosis rather than a daily management entry.
- **Outbound and canonical keys are unchanged**: `channel:<type>:outbound`, Hot Apply, and the
  “Admin-off must not resurrect the overlay” rule all match v0.13; v0.13.1 → v0.14 needs **no new
  state migration** (the v0.12 legacy-key migration already ran in earlier versions and is idempotent).

This preview describes dev-line behavior only; installs should follow the published release, and do
not change production based on it before it ships.
