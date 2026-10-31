# test/host — disposable DSH rc.5 test harness

Reusable infrastructure for driving the **real** DSH 0.2.1-rc.5 CLI against a
throwaway `DSH_HOME`. It backs the real-host acceptance journeys (T25) and the
per-stage host-rc5 evidence.

Nothing here is a product file. `test/host/**` is deliberately **outside** the
`npm test` glob (`test/*.test.mjs`), so it never runs as part of the unit suite
and does not change the 2011/0 baseline. Run it explicitly.

## Quick start

```bash
node test/host/harness.smoke.mjs     # web + headless boot, real notify push
```

Exit code is `0` on PASS and non-zero on FAIL.

## Host-rc5 vs provider-live (read this first)

| Tier | What it is | In scope? |
|---|---|---|
| **host-rc5** | The real, shipped DSH 0.2.1-rc.5 CLI composing the real Cordis tree, with our plugin activated in a disposable profile. External I/O stays **local/controlled** (loopback HTTP receiver). | **Yes — this harness.** |
| **provider-live** | A real IM/provider account or device (Telegram bot, WeChat, WxPusher, …) receiving an actual push. | **No.** Out of scope; there are no real accounts here and none should be requested. Never claim it passed. |

Everything this harness proves is `host-rc5` (activation, tool/RPC wiring,
outbound delivery to a local webhook). It says nothing about a real provider.

## Prerequisites

- Node **v22** (`node --version` → v22.x).
- DSH **0.2.1-rc.5** installed at
  `/home/orca/work/dsh-notifier-rc5/dsh-host/node_modules/@deepseek-ai/`.
  CLI entrypoint: `…/@deepseek-ai/dsh/lib/bin.js`.
- **pnpm is NOT installed** in this environment. Therefore
  `dsh plugin --profile <name> add <path>` (which shells out to pnpm) is
  **unavailable**. The harness uses the host's own **profile-bundle path**
  instead — the same one the host itself uses at boot:

  ```
  <home>/profiles/<profile>/package.json   → dsh.profile.bundles: [<base…>, "dsh-notifier"]
  <home>/profiles/<profile>/node_modules/dsh-notifier/   → plugin payload
  <home>/profiles/<profile>/cordis.patch.yml             → profile patch layer
  ```

  This is exactly the recipe recorded in
  `docs/new-host/evidence/T02.json`. The app-boot preflight reads the path
  manifest directly, so the install gate is exercised identically.
  `installPluginIntoProfile()` implements this.

## Environment / paths

- **Scratch root** (the only place we may create homes):
  `/home/orca/work/dsh-notifier-rc5/scratch/`
  Homes are named `dshhome-<name>`. `makeDisposableDshHome()` **refuses** any
  path outside this root.
- **Real DSH home** `~/.dsh` is sacred. `never-touch-real-profile.md` documents
  the guard; `assertNotRealDshHome()` throws if a target resolves there.
- Booting sets a **minimal allowlisted env** (`bootEnv`) — only `PATH`, `HOME`,
  `DSH_HOME`, `NO_COLOR`, `FORCE_COLOR`. The parent environment is not forwarded
  wholesale, so no secrets leak into the child.

## API (`test/host/harness.mjs`)

| Helper | Purpose |
|---|---|
| `makeDisposableDshHome(name)` | Create `scratch/dshhome-<name>` (guarded). Returns `{ home, name, cleanup }`. |
| `installPluginIntoProfile({home, profile, bundles, …})` | Write the profile dir + plugin node_modules + `cordis.patch.yml` via the profile-bundle path. `bundles` = the base bundles **without** the plugin. |
| `installProbeIntoProfile({home, profile, probeDir})` | Add a separate probe bundle (e.g. `fixtures/smoke-probe`) alongside the plugin. |
| `dumpConfig({home, profile})` | Run `dsh --profile <p> --dump-config` (the T02 verification command). |
| `bootProfile({home, profile, args, timeoutMs})` | Spawn the CLI with `DSH_HOME=<home>`, bounded timeout, guaranteed group kill (own process group, SIGTERM→SIGKILL). Returns `{ stdout, stderr, waitFor, result, stop, output }`. Never leaves an orphan. |
| `startLocalReceiver(opts)` | Loopback HTTP server recording `{method, path, headers, body}`. Variants: `{slowMs}` (stalled body for T09 deadline tests), `{stallBody:true}` (never ends the response), `{redirectTo}` (302). Returns `{ port, url(path), requests, close }`. |
| `readPluginState(dir)` | Read `<dir>/state.json` if present. **Never writes.** Returns `null` when absent. |

## What the smoke proves

`harness.smoke.mjs`:
- **A. web** — installs the plugin into a `web` profile (`dsh-base` + `dsh-web-app`),
  runs `--dump-config` (must compose the `dsh-notifier` row, no "skipping"),
  boots it, and asserts the plugin's own `[dsh-notifier] …渠道` /
  `[dsh-notifier/admin:server]` line and the advertised web URL.
- **B. headless** — installs the plugin into a `headless` profile
  (`dsh-base` + `dsh-headless`, which composes **neither** `connection` nor
  `webServer`) with a webhook channel pointed at the local receiver, plus the
  probe bundle. Boots it and asserts: the plugin activates
  (`已启用渠道：webhook`), there is **no** PENDING / waiting-for-services line,
  the probe sees `ctx.notifier` present with the `notify` tool registered, its
  `push()` returns `ok:true`, and the receiver logged a real `POST /hook`.

## Known limitations

- **pnpm absent** → `dsh plugin … add` untestable; the profile-bundle path is
  used instead (equivalent for the install gate).
- **No LLM key** → headless exits `1` with `MISSING_CREDENTIAL` **after** the
  plugin has activated and delivered; that exit code is expected, not a plugin
  failure. No full agent turn is driven.
- The admin UI is not driven (that is T19); no browser screenshot is claimed.
- Everything under `scratch/` is disposable and is **not** committed.
