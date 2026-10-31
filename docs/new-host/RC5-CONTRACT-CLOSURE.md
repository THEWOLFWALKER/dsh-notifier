# rc.5 Contract Closure (T01)

Status: **implemented** (evidence/contract-closure only — no product code changed).
Source commit: `9d69dd7a8908fcfec6e20d92d56509764a8f23ec` (working tree at `da5db99`).
Machine evidence: `docs/new-host/evidence/T01.json`.

This report closes T01: it fixes the exact rc.5 artifact identity, records the runtime
dependency closure, enumerates every host API the plugin actually calls, and lists every
mismatch between the plugin's *declared* contracts and the *shipped* rc.5 artifacts.
No manifest change is made here — T02 owns the install gate and applies the fixes.

---

## 1. Artifact identity (no floating targets)

Target pinned to DSH **0.2.1-rc.5**, source commit `b830ec950faba0a46dda564be3e2d854afed94f1`.

| Field | Value | Matches `baseline.json`? |
|---|---|---|
| tarball | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.5.tgz` | yes |
| `dist.integrity` | `sha512-WkyJZv4zl9sCAxSzRctGm58m0rilGqwR6pniBiLOz5CPDfHfDuAUicg0AAazXI7oj/Cph6/cjNTncA/rpLTXpw==` | yes |
| `dist.shasum` | `8e1bfd31869414f7a5ec10c34403a852ac9c3dc7` | yes |
| `fileCount` | `20` | yes |
| `unpackedSize` | `75972` | yes |
| packed size | `25131` bytes (re-verified via `npm pack`) | — |

The installed tarball at `dsh-host/node_modules/@deepseek-ai/dsh` is recorded in
`node_modules/.package-lock.json` (lockfileVersion 3) with
`version=0.2.1-rc.5`, `resolved=<the tarball above>`, `integrity=<the integrity above>` —
byte-identical to `baseline.json`. The npm cacache entry for the same URL carries the same
integrity and `size=25131`. Integrity is confirmed four independent ways: registry
metadata, a fresh `npm pack` byte-hash, the local package-lock, and the npm cache.

## 2. Runtime dependency closure (actual resolved versions)

Read from `dsh-host/node_modules/.package-lock.json` and each package's `package.json`.

| Package | Resolved version | Expected | Note |
|---|---|---|---|
| `@deepseek-ai/cordis` | `4.0.5` | 4.0.5 | matches; `dsh` declares `~4.0.5` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.6` | 1.0.6 | matches |
| `@deepseek-ai/cordis-plugin-include` | `1.0.10` | 1.0.10 | matches |
| `@deepseek-ai/cordis-plugin-group` | `1.0.5` | 1.0.5 | matches |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.7` | — | `dsh` declares `~1.1.7` |
| `@deepseek-ai/dsh-session` | `0.2.1-rc.5` | — | **diverges from the plugin's declared peer range (see §4)** |

All four expected version targets are confirmed. Cordis and the loader plugins are
*floating-free*: `dsh`'s own `dependencies` pin `~4.0.5` / `~1.0.10` / `~1.0.6`, so the
closure is reproducible from the pinned `dsh` tarball.

## 3. Public-call inventory (every host API the plugin uses)

For each contract: the plugin `file:line` that consumes it, and the shipped rc.5 file that
defines it.

| Host contract | Plugin call site | rc.5 definition (shipped) |
|---|---|---|
| Cordis plugin `inject` list | `src/index.mjs:63` `inject = ['tools','agents','connection']` | loader semantics (`@deepseek-ai/cordis-plugin-loader`) |
| `ctx.provide(name, impl)` | `src/index.mjs:96` `ctx.provide('notifier', facade)` | cordis service registry |
| `ctx.get(name, false)` | `src/host/capability.mjs:43` (`userQuestions`), `src/host/messages.mjs:40` (`attachments`) | cordis (non-throwing read) |
| `ctx.effect(fn, label)` | `src/index.mjs:146,979`; `src/control-surface/rpc.mjs:142`; `client.js:1037,1042,1046,1054` | cordis effect/fiber |
| `ctx.inject([deps], cb)` | `src/index.mjs:713` (`['userQuestions']`), `src/index.mjs:854` (`['connection','webServer']`) | cordis conditional inject |
| `ctx.emit(name, payload)` | `src/index.mjs:124` `ctx.emit('dsh-notifier/sent', …)` | cordis event bus |
| `ctx.on(evt, cb, opts)` | `src/host/native-questions.mjs:256` (`user-questions/request`); `src/approval/router.mjs:707` (`approval/request`); `src/inbound/conversation.mjs:1154,1157` (`agent/created`/`agent/disposed`) | cordis events; waterfall seams via `@deepseek-ai/dsh-user-questions` (`lib/index.js:681`) and `@deepseek-ai/dsh-user-approval` (`lib/index.js:176`) |
| `ctx.tools.register(def)` + tool `execute(args, exec)` | `src/tool-register.mjs:108` (`ask_user`), `:192` (`notify_test`), `src/questions/router.mjs:1215` (`notify`) | `@deepseek-ai/dsh-tools` `ToolRuntime.register` (`lib/index.js:2974`); exec shape `execute(args, exec)` with `exec.agent` + `exec.signal` (`lib/index.js:1531`) |
| `ctx.agents.list()` | `src/index.mjs:354`; `src/routing/session-registry.mjs:369`; `src/routing/task-projection.mjs:58`; `src/inbound/conversation.mjs:198` | `@deepseek-ai/dsh-agent` `AgentRegistry.list()` (`lib/index.js:614`) |
| `ctx.agents.get(id)` | `src/index.mjs:589`; `src/inbound/conversation.mjs:201` | `@deepseek-ai/dsh-agent` `AgentRegistry.get(id)` (`lib/index.js:596`) |
| `agent.cancel({kind})` | `src/index.mjs:594`; `src/inbound/conversation.mjs:371` | `@deepseek-ai/dsh-agent` agent cancel (structured cause) |
| `ctx.connection.rpc.handle(channel, handler)` | `src/control-surface/rpc.mjs:154` | `@deepseek-ai/dsh-client-connection` (`lib/index.js:724` `get rpc`, service name `connection` at `:710`) |
| `ctx.connection.rpc.call(channel, …)` | `client.js:175` | same service, browser half |
| `webServer.register(route)` (via `ctx.effect`) | `src/control-surface/rpc.mjs:142` | `@deepseek-ai/dsh-host-webserver` (`super(ctx,'webServer')` at `lib/index.js:286`), row `dsh-web-app/cordis.patch.yml:179-180` |
| Stage slots `ctx.slots.inject/register` | `client.js:1064,1071,1077,1081` | `@deepseek-ai/dsh-client-ui-plugin-manager` client (`main`, `sidebar.panellist`, `plugins.bundle.config`, `plugins.bundle.activation` all present) |
| `ctx.locale.*` | `client.js:167,460,464,1037` | `@deepseek-ai/dsh-client-locale` |
| `engines` / `peerDependencies` / `dshWorkshop` / `dsh.client` (manifest) | `package.json:69-179` | `@deepseek-ai/dsh-app-boot` `evaluatePluginCompatibility` (`lib/index.js:311`) |

Notable: `ctx.args` is declared in `package.json` / `cordis.patch.yml` context but the plugin
does **not** call `ctx.args`; the headless runner consumes `ctx.headlessStartup` (host-owned).
`ctx.registry`/`ctx.attachments` appear only in comments, not as calls.

### rc.5 seams verified still present

- `user-questions/request` waterfall — `dsh-user-questions/lib/index.js:681`.
- `approval/request` waterfall — `dsh-user-approval/lib/index.js:176`.
- Tool `execute(args, exec)` with `exec.agent` + `exec.signal` — `dsh-tools/lib/index.js:1531`.
- All 6 declared `dsh.client.inject` packages exist at `0.2.1-rc.5` with exact names
  (`dsh-client-connection`, `dsh-client-locale`, `dsh-client-ui-renderer`,
  `dsh-client-ui-layout`, `dsh-client-ui-sidebar`, `dsh-client-ui-plugin-manager`).
- All 4 stage slot ids exist in shipped client code.

## 4. Declared-vs-shipped diff (the heart of T01)

| # | Declared (plugin) | Shipped (rc.5) | Consequence | Responsible task |
|---|---|---|---|---|
| D1 | `peerDependencies["@deepseek-ai/dsh-session"] = "0.1.7-alpha.1 \|\| 0.1.7-alpha.2 \|\| 0.1.7-rc.1 \|\| 0.1.7-rc.2"` (`package.json:87`) | runtime `0.2.1-rc.5` | **BLOCKER.** No `engines.dsh` is declared, so app-boot evaluates this peer with `includePrerelease`; `semver.satisfies('0.2.1-rc.5', <range>) = false` → the plugin is **DISABLED at load** | **T02** |
| D2 | `engines = { "node": ">=22" }` (`package.json:98-100`) — no `engines.dsh` | app-boot: an own `engines.dsh` decides alone; else every `@deepseek-ai/dsh*` peer is tested | The absence of `engines.dsh` is what forces the D1 peer evaluation. | **T02** |
| D3 | `inject = ['tools','agents','connection']` (`src/index.mjs:63`, static) | `connection` (and `webServer`) exist ONLY in `dsh-web-app`; `dsh-base` and `dsh-headless` supply neither | In `headless`, the required `connection` never resolves → plugin stays **PENDING** (not degraded to Standalone) | **T02** (+ T16 lifecycle) |
| D4 | `dshWorkshop.compatibility.dshVersions = ["0.1.7-alpha.1","0.1.7-alpha.2","0.1.7-rc.1","0.1.7-rc.2"]` (`package.json:159-166`) | target `0.2.1-rc.5` | Stale compatibility metadata. `verify-host-compat.mjs:84-87` requires `dshVersions === matrix verified rows`, so this, the peer range, and `docs/compatibility-matrix.md` must move together | **T02** (matrix), **T27** (docs/version) |
| D5 | `peerDependencies["@deepseek-ai/cordis"] = "^4.0.1"` (`package.json:86`) | rc.5 ships vendored `@deepseek-ai/cordis` `4.0.5` (`dsh` declares `~4.0.5`) | Not a load blocker (app-boot skips non-`dsh` peers; `^4.0.1` is satisfied by `4.0.5`). Declared range no longer matches the shipped runtime family; align to `~4.0.5` to match `dsh-base` | **T02** |
| D6 | `docs/compatibility-matrix.md` rows = the `0.1.7-*` family (`peerPackage: @deepseek-ai/dsh-session`) | — | Matrix, peer range, `dshVersions` are a single consistency unit enforced by `verify-host-compat.mjs` | **T02**, **T27** |
| D7 | `dsh.client.inject` = 6 `@deepseek-ai/dsh-client-*` packages (`package.json:75-82`) | All 6 exist at `0.2.1-rc.5`, exact names | **No mismatch** — names are correct; only D1/D2 need to change for the plugin to load at all | — (verified) |
| D8 | `cordis.patch.yml` sets `admin.enabled: true` by default | Admin/HTTP surface needs `webServer`, present only in web | Patch row is profile-agnostic; behavior on headless/web must be re-verified | **T02**, **T19** |

### Proposed T02 values (documented, NOT applied in T01)

```
engines.dsh            = "0.2.1-rc.5"                       # an own engines.dsh decides alone
# OR, if engines.dsh is not adopted, repoint the peer:
peerDependencies["@deepseek-ai/dsh-session"] = "0.2.1-rc.5"  # keep peerDependenciesMeta.optional = true
dshWorkshop.compatibility.dshVersions = ["0.2.1-rc.5"]
peerDependencies["@deepseek-ai/cordis"] = "~4.0.5"
docs/compatibility-matrix.md          # single verified row: 0.2.1-rc.5, tag dsh-v0.2.1-rc.5
inject                                # drop the static 'connection'; move connection/webServer into a
                                      # conditional sub-Fiber (ctx.inject already used at src/index.mjs:854)
```

The `engines.dsh` vs peer-range choice is mutually exclusive by app-boot design (§ `unmetRequirements`):
an own `engines.dsh` makes peer evaluation irrelevant. T02 must pick one and make the matrix and
`dshWorkshop.dshVersions` agree with it.

## 5. Not closed in T01 (explicit)

- **Live install/activation proof.** T01 did not boot DSH rc.5 or install the plugin into a
  disposable profile. The D1/D3 denial/pending outcomes are read from shipped app-boot source
  (`lib/index.js:1025` throw path; `lib/index.js:2327` `row.disabled = true` path) and from the
  base/headless/web patch rows, not observed at runtime. T02 must confirm with a real install.
- **`dsh-session` optionality.** `peerDependenciesMeta["@deepseek-ai/dsh-session"].optional = true`
  does **not** exempt the plugin — app-boot reads `peerDependencies` regardless of the optional
  meta. Read from source, not observed.
- **Manifest edits.** Deliberately deferred to T02; the plugin is still load-blocked on rc.5 as of
  T01, by design.
- **Provider/IM/LLM** verification: out of scope (`provider-live` = no real accounts).

## 6. Commands run (exact) and results

All exit code 0 unless noted; observations sanitized in `evidence/T01.json`.

```
npm view @deepseek-ai/dsh@0.2.1-rc.5 dist.integrity dist.shasum dist.tarball dist.fileCount dist.unpackedSize version
npm pack @deepseek-ai/dsh@0.2.1-rc.5            # in /tmp; then sha512/sha1 of the .tgz
node -e "require('./node_modules/.package-lock.json')[...]"   # cwd dsh-host: resolved versions + integrity
cat ~/.npm/_cacache/index-v5/ad/97/…d75f        # cacache entry for the tarball
sed -n '251,326p' dsh-host/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js    # preflight
node -e "semver.satisfies('0.2.1-rc.5', <peerRange>, {includePrerelease:true})"   # -> false
cat dsh-host/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml                  # no connection/webServer
cat dsh-host/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml              # no Host/HTTP/web
grep -n webserver|connection dsh-host/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml
grep -n 'user-questions/request' dsh-host/node_modules/@deepseek-ai/dsh-user-questions/lib/index.js
grep -n 'approval/request'       dsh-host/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js
grep -n 'register(definition)'   dsh-host/node_modules/@deepseek-ai/dsh-tools/lib/index.js
grep -n 'slots.inject("…'        dsh-host/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js
```
