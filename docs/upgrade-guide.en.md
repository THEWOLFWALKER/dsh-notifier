# dsh-notifier Upgrade Guide (Update · Verify Version · Version-Mismatch Triage · Rollback)

> For **DSH users**: how to update dsh-notifier to the latest release, how to confirm the
> installed version is correct, how to tell a "version mismatch / stale file" apart from a
> real feature bug, and how to roll back to a previous version.
> All commands assume the official **npm registry** release; the `file:` developer warning
> is at the end. 简体中文版：[`upgrade-guide.md`](upgrade-guide.md)

---

## 1. How to update dsh-notifier

### Option A: the DSH plugin command (recommended — registry build)

Run from the DSH installation root:

```bash
dsh plugin add dsh-notifier@latest --profile <profile-name>
```

> For dsh-notifier, re-running `dsh plugin add` on the same package *is* the update: it pulls
> the newest published version from the npm registry over the old install. `--profile` must be
> the profile you actually run (required since DSH 0.1.0-rc.6, see README). If your DSH CLI
> does not accept the `@latest` suffix, plain `dsh plugin add dsh-notifier --profile <profile-name>`.

### Option B: manage it directly from the DSH root

npm hosts:

```bash
npm update dsh-notifier              # or npm install dsh-notifier@latest
```

pnpm hosts:

```bash
pnpm update dsh-notifier             # or pnpm add dsh-notifier@latest
```

### After updating

**Restart DSH.** Channel connections are brought up at startup — installing the package alone
does not activate the new build's connections / tool wiring.

---

## 2. How to confirm the installed version

Three markers; pick any:

| Method | Command / location | Success looks like |
|---|---|---|
| Admin-console badge | Open the web console, page header | `dsh-notifier console v0.8.x` (matches the current release) |
| Startup-log wiring marker | DSH startup log, search for `remote questions enabled` | v0.8+ prints a line about the `ask_user` tool (re-wired since v0.8.2; missing means an old package or skipped wiring) |
| CLI resolves the version | DSH root: `npm ls dsh-notifier` (npm) or `pnpm ls dsh-notifier` (pnpm) | Version shown = version actually assembled |

Then compare against the latest published release:

```bash
npm view dsh-notifier version
```

Good only when "installed ≥ expected" **and** "installed == the release you set out to verify."

> Note: the `remote questions enabled` startup line is a **wiring marker, not a version** — it
> only proves "≥ v0.8.2 with the questions bridge healthy". For the exact patch, use the CLI
> output / console badge.

---

## 3. "A feature doesn't work" — triaging version mismatch / stale files

Typical symptoms (a shipped feature seems not to exist):

- A tool that should exist isn't there (e.g. `ask_user`, or the `remote questions enabled` log line is missing);
- The console version badge is behind the latest release;
- New-version config keys have no effect.

Sequence:

**Step 1 — confirm the actual version.** Use one of the three markers in §2.

- If stale → go update (§1).

**Step 2 — version is right but the feature still misbehaves → suspect mismatch / staleness**

Most common source: the package was installed from a `file:` local path, or files were manually
copied over `node_modules/dsh-notifier`. As soon as local sources change, the package inside
node_modules **silently drifts away from the registry release** — it no longer looks like the
official artifact, so test results don't represent the release. This exact gap once produced a
"`ask_user` tool has an empty name" phantom (see handoff doc `17-toolname-bug.md`).

1. Reinstall the registry build over it:

   ```bash
   dsh plugin add dsh-notifier@latest --profile <profile-name>
   ```

2. For stubborn leftovers, uninstall, clear, and reinstall:

   ```bash
   dsh plugin remove dsh-notifier --profile <profile-name>
   ```

   Back in the DSH root, remove the old package (pnpm hosts: use pnpm commands, never delete
   node_modules by hand — pnpm rolls it back):

   ```bash
   npm uninstall dsh-notifier          # npm hosts
   # or
   pnpm remove dsh-notifier            # pnpm hosts
   ```

   Then install the registry build again: `dsh plugin add dsh-notifier@latest --profile <profile-name>`.

3. Confirm the resolution source is the registry, not `file:`:

   ```bash
   pnpm why dsh-notifier               # pnpm hosts
   # or
   npm ls dsh-notifier                 # npm hosts
   ```

   A `file:` / local absolute path in the resolution is a leftover; a registry address / plain
   version number is normal.

4. **Restart DSH**, then re-check with the §2 markers: badge, log line, and CLI must point at the same version.

**Step 3 — still broken** → go back to the [usage guide](guide.md) troubleshooting table and the
web console "Overview" live event stream.

---

## 4. Downgrade / rollback

To step back to a previous version (e.g. you don't want a behavior the latest introduces):

```bash
dsh plugin add dsh-notifier@0.8.1 --profile <profile-name>
```

pnpm hosts:

```bash
pnpm add dsh-notifier@0.8.1
```

**Restart DSH** afterwards, and confirm with the §2 markers that the badge / log line / CLI
point at the target version.

> Downgrade note: if `state.json` was written by a newer version, the older build may not
> understand some newer keys. When in doubt, back up `state.json` from the DSH data directory first.

---

## 5. For developers: don't keep `file:` installs around — the real-machine baseline is the registry build

- `file:` installs are for **temporary** local verification only. Left in place long-term, they
  leave a package in node_modules that drifts with your local source — it doesn't look like the
  registry release, so results don't represent the release. **Swap back to the registry build
  and restart before shipping.**
- **The real-machine acceptance baseline must be the registry build**: what
  `dsh plugin add dsh-notifier@latest --profile <profile-name>` installs. All-green mocks do not
  equal a correct real machine (project constitution rule 8 — the real-machine acceptance gate).
- On pnpm hosts, manually overwriting `node_modules/dsh-notifier` gets rolled back by pnpm on the
  next operation (see `PLUGINS.md` install notes) — don't copy files by hand; always use
  `dsh plugin add` or pnpm commands.
- The previously observed "`ask_user` tool named empty" symptom was most plausibly a version-mismatch
  phantom from stale builds/packages on the real machine, not a source-code defect — run the §3
  three-marker check before pointing at the code.