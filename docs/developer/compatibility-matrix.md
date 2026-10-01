# Optional SDK and DSH host compatibility matrix

Snapshot: 2026-09-25.

This document separates three evidence levels:

- **contract/source verified** — repository seams and official source/artifact shape match;
- **host smoke verified** — the plugin was booted in that DSH release and the relevant host/client seam responded;
- **real-provider/device verified** — an external provider/device flow was exercised end to end.

Do not collapse these into one “supported” claim.

## Optional SDK / legacy compatibility

| Surface | Optional dependency | Supported seam | Missing/old shape | Lifecycle evidence | Capability status |
|---|---|---|---|---|---|
| Feishu QR login | `@larksuiteoapi/node-sdk` `>=1.61.1` | lazy `registerApp`; named/default export variants | normalized `missing-sdk` guidance | timeout/denied/expired/malformed/partial persistence guarded | contract-tested; provider validation scoped separately |
| QQ QR login | `@tencent-connect/qqbot-connector` `^1.2.0` | lazy `startQrConnect`; named/default export variants | incompatible export/result fails safely | timeout/SDK error/invalid credential list guarded | contract-tested; provider validation scoped separately |
| Feishu inbound WS | `@larksuiteoapi/node-sdk` | lazy `Client`/`WSClient`/`EventDispatcher`; isolated bounded HTTP instance | missing/incomplete SDK reports unavailable | idempotent start/stop, bounded transport, SDK-owned reconnect | contract-tested; long-connection real validation still external |
| QQ inbound gateway | none | native fetch + WebSocket implementation | transport errors isolated | heartbeat/reconnect/stop/restart covered by tests | contract-tested; gateway/device validation still external |
| QR terminal rendering | `qrcode-terminal` | login CLI convenience | absence does not affect credential result | callback failures absorbed | optional convenience |

Legacy YAML `inbound.allowUsers` remains a one-time migration input. Runtime membership is managed by pairing/admin APIs.

WxPusher inbound has a local `accountId` (default `default` when omitted). Multiple apps should use distinct explicit `accountId` values; channel names are never used as account IDs.

No optional SDK is a production runtime dependency.

## DSH host compatibility matrix

Declared peer range:

```text
0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2
```

The optional peer marker is `@deepseek-ai/dsh-session`. `scripts/verify-host-compat.mjs` keeps the peer range, matrix and package compatibility metadata aligned.

| DSH | Core Session/Message seams | Native client dependency/slot seams | Native Control Surface evidence | Evidence level |
|---|---|---|---|---|
| `0.1.7-alpha.1` | compatible with the v0.11/v0.12 host contract set | connection / locale / renderer / layout / sidebar / plugin-manager packages present; global panel slots exist | plugin activated; control route returned 200; 28-channel projection; `dsh-notifier/client.js` in client-module manifest and served | **host smoke verified** |
| `0.1.7-alpha.2` | source/artifact seams verified | required client packages present | not claimed as a fresh real-host visual walkthrough in v0.12 release evidence | **contract/source verified** |
| `0.1.7-rc.1` | source/artifact seams verified | required client packages present | not claimed as a fresh real-host visual walkthrough in v0.12 release evidence | **contract/source verified** |
| `0.1.7-rc.2` | compatible with current Session/Message contract | required client packages/slots present | Sidebar/Main render, setup wizard, save/test, 28 channels, Hot Apply and fail-closed invalid save exercised in real Host | **host smoke + visual/interaction verified** |
| `0.1.0-rc.6` | historical only | current Native surface not re-certified | old historical plugin verification only | **unverified for v0.12** |

Peer range: `0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2`.

No row is `real-device-verified`; every row is source/artifact or host-smoke evidence.

### Inbound file attachment boundary

File admission requires the Host AttachmentStore capability `attachments.saveFile`. A
legacy host that exposes the attachment service but not `saveFile` is outside the current
file-inbound support boundary: the plugin fails closed, does not pass a remote URL into the
Session, and emits a bounded diagnostic in both Chinese and English. The current supported
host matrix above is the 0.1.7 family; the older 0.1.1-rc.2 shape is retained as a
compatibility risk, not as a supported target.

The closed #36 follow-up now has one real QQ C2C file-download sample: the URL used
`grouptalk.c2c.qq.com`, returned HTTP 200 without redirect or authentication, used
`application/octet-stream`, and its declared `content-length` matched the downloaded bytes.
The sample had no usable `content-disposition` filename. This confirms the download-side
shape for that sample only; it does not certify all QQ payloads. QQ GROUP attachment
evidence remains unreachable under the existing upstream group-control deny policy, so
`fileInbound` remains disabled until a supported-host end-to-end image/file admission run
is available.

Machine-readable block (the source of truth for `scripts/verify-host-compat.mjs` and
`npm run verify:release`):

```json dsh-host-matrix
{
  "peerPackage": "@deepseek-ai/dsh-session",
  "runtimes": [
    { "version": "0.1.7-alpha.1", "status": "verified", "tag": "dsh-v0.1.7-alpha.1" },
    { "version": "0.1.7-alpha.2", "status": "verified", "tag": "dsh-v0.1.7-alpha.2" },
    { "version": "0.1.7-rc.1", "status": "verified", "tag": "dsh-v0.1.7-rc.1" },
    { "version": "0.1.7-rc.2", "status": "verified", "tag": "dsh-v0.1.7-rc.2" },
    { "version": "0.1.0-rc.6", "status": "unverified", "tag": null }
  ]
}
```

### v0.12 Connection transport note

The intended logical channel is `/dsh-notifier`.

On the real `0.1.7-rc.2` web profile, `ctx.connection.rpc.handle` could not own the route because its owner context lacked the required `webServer` injection. v0.12 therefore uses a guarded fallback that mounts the same authenticated request envelope on the Host web server seam, applying Connection admission/trust rules. Headless/no-webServer profiles degrade without crashing the notifier runtime.

This is a host-integration fact, not a reason to expose the loopback Admin API to Native.

### Client dependency set

v0.12 Native client metadata depends on these DSH client packages:

```text
@deepseek-ai/dsh-client-connection
@deepseek-ai/dsh-client-locale
@deepseek-ai/dsh-client-ui-renderer
@deepseek-ai/dsh-client-ui-layout
@deepseek-ai/dsh-client-ui-sidebar
@deepseek-ai/dsh-client-ui-plugin-manager
```

They are Host-provided client dependencies, not npm runtime dependencies of dsh-notifier.

## DSH host seam audit (v0.14 S14)

This section audits, target by target, whether *the seam dsh-notifier believes exists* matches
the official host source/shape for the declared supported hosts. It is deliberately an **audit
first** artifact: the current carrier is kept unless a new carrier is evidenced for every
declared host *and* the migration benefit is clear. A `fixtureCovered: true` row means an
automated test drives the real module (not a re-description); a row that is only source/artifact
verified is marked so.

| Seam target | Official/source evidence | Current notifier path | Probe | Fixture-covered | Known fallback | Risk |
|---|---|---|---|---|---|---|
| `connection.rpc.handle` | connection service exposes `rpc.handle(channel, handler)` on its owner ctx | `src/control-surface/rpc.mjs` primary branch | `test/control-surface-rpc-v012.test.mjs` | yes | webServer prefix mount | rc.2 owner ctx lacks `webServer` injection → throws; guarded |
| `connection.fetch.register` | `connection.fetch.register` mounts routes under the shared `/api` prefix | **not adopted** (carrier decision) | `test/host-seam-audit.test.mjs` | yes | n/a — deliberately not adopted | browser carrier uses `<channel>/<endpoint>` relative paths; `dsh-im` usage alone is not a reason to rewrite |
| `webServer.fallback` | `webServer.register({ kind:'prefix', path, handler })` + `connection.admit()` | `src/control-surface/rpc.mjs::mountOnWebServer` | `test/control-surface-rpc-v012.test.mjs` | yes | none — undefined seam → Standalone degrade (`null`) | `webServer` only exists in the web profile; headless degrades |
| `client.slots` | client `slots.register/inject`; `locale`; `layout.selectPanel`; plugin-manager bundle slots | `client.js` slots `main` / `sidebar.panellist` / `plugins.bundle.config` / `plugins.bundle.activation` | `test/client-module.test.mjs` | yes | slot error boundary keeps the host slot alive | `label` must be a thunk (real rc.2 sidebar crash reproduced); slot names are host-owned |
| `user-questions.waterfall` | `UserQuestionService.ask()` → `ctx.waterfall('user-questions/request', req, next)` | `src/host/native-questions.mjs` waterfall interceptor | `test/native-questions.test.mjs`, `test/issue38-host-compat.test.mjs` | yes | `registerProvider` (future/legacy) else `unsupported` + plugin `ask_user` tool | after interception the host `ask()` does not abort its signal → orphan GUI card (host-side) |
| `agents.sessions` | `ctx.agents.list()/get()/roots()` | `src/routing/agent-router.mjs`, `src/routing/session-registry.mjs`, `src/inbound/conversation.mjs`, `src/host/capability.mjs` | `test/host-seam-audit.test.mjs`, `test/host-capability.test.mjs` | yes | throwing/missing → `[]` / `unknown`; never false-`available` | `ctx.agents.get` availability varies by host; conversation mode stays conservative |
| `attachments` | cordis Service `'attachments'`; `saveImage`/`saveFile` → `AttachmentRef` | `src/host/messages.mjs` `readAttachments` / `admitInboundImage` / `admitInboundFile` | `test/host-seam-audit.test.mjs`, `test/attachments-bounds-v0121.test.mjs` | yes | missing service / non-whitelisted mediaType / reject → `null`; never a remote URL into the Session | a host that exposes the service but not `saveFile` is outside the file-inbound boundary (fail closed) |
| `client.services` | host injects the declared client package set into the client bundle | `package.json` `dsh.client.inject` (6 packages) | `test/host-seam-audit.test.mjs`, `test/client-module.test.mjs` | yes | none — declared host-provided, not npm runtime deps | a host release renaming/removing a client package breaks the bundle inject list |

Machine-readable block (locks the audit; verified by `test/host-seam-audit.test.mjs`):

```json dsh-host-seam-matrix
{
  "auditedHosts": ["0.1.7-alpha.1", "0.1.7-alpha.2", "0.1.7-rc.1", "0.1.7-rc.2"],
  "seams": [
    {
      "id": "connection.rpc.handle",
      "official": "connection service exposes rpc.handle(channel, handler) on its owner ctx",
      "notifierPath": "src/control-surface/rpc.mjs",
      "probe": "test/control-surface-rpc-v012.test.mjs",
      "fixtureCovered": true,
      "fallback": "webServer prefix mount",
      "risk": "rc.2 owner ctx lacks webServer injection and throws; guarded, falls back"
    },
    {
      "id": "connection.fetch.register",
      "official": "connection.fetch.register mounts routes under the shared /api prefix",
      "notifierPath": "src/control-surface/rpc.mjs",
      "probe": "test/host-seam-audit.test.mjs",
      "fixtureCovered": true,
      "fallback": "n/a - deliberately not adopted",
      "risk": "browser carrier uses <channel>/<endpoint> relative paths; dsh-im usage is not a reason to rewrite"
    },
    {
      "id": "webServer.fallback",
      "official": "webServer.register({kind:'prefix',path,handler}) plus connection.admit()",
      "notifierPath": "src/control-surface/rpc.mjs",
      "probe": "test/control-surface-rpc-v012.test.mjs",
      "fixtureCovered": true,
      "fallback": "none - undefined seam degrades to Standalone (null)",
      "risk": "webServer exists only in the web profile; headless degrades without crashing"
    },
    {
      "id": "client.slots",
      "official": "client slots.register/inject, locale, layout.selectPanel, plugin-manager bundle slots",
      "notifierPath": "client.js",
      "probe": "test/client-module.test.mjs",
      "fixtureCovered": true,
      "fallback": "slot error boundary keeps the host slot alive",
      "risk": "label must be a thunk (real rc.2 sidebar crash); slot names are host-owned"
    },
    {
      "id": "user-questions.waterfall",
      "official": "UserQuestionService.ask() calls ctx.waterfall('user-questions/request', req, next)",
      "notifierPath": "src/host/native-questions.mjs",
      "probe": "test/native-questions.test.mjs",
      "fixtureCovered": true,
      "fallback": "registerProvider (future/legacy) else unsupported + plugin ask_user tool",
      "risk": "after interception the host ask() does not abort its signal, leaving an orphan GUI card (host-side)"
    },
    {
      "id": "agents.sessions",
      "official": "ctx.agents.list()/get()/roots()",
      "notifierPath": "src/routing/agent-router.mjs",
      "probe": "test/host-seam-audit.test.mjs",
      "fixtureCovered": true,
      "fallback": "throwing/missing maps to [] or unknown, never false-available",
      "risk": "ctx.agents.get availability varies by host; conversation mode stays conservative"
    },
    {
      "id": "attachments",
      "official": "cordis Service 'attachments'; saveImage/saveFile return an AttachmentRef",
      "notifierPath": "src/host/messages.mjs",
      "probe": "test/host-seam-audit.test.mjs",
      "fixtureCovered": true,
      "fallback": "missing service / non-whitelisted mediaType / reject maps to null; never a remote URL into the Session",
      "risk": "a host exposing the service without saveFile is outside the file-inbound boundary (fail closed)"
    },
    {
      "id": "client.services",
      "official": "host injects the declared client package set into the client bundle",
      "notifierPath": "package.json",
      "probe": "test/host-seam-audit.test.mjs",
      "fixtureCovered": true,
      "fallback": "none - declared host-provided, not npm runtime dependencies",
      "risk": "a host release renaming or removing a client package breaks the bundle inject list"
    }
  ]
}
```

Evidence pending (non-blocking): a real DSH visual walkthrough of the Native slots on every declared
host, and an end-to-end image/file admission run on a real host, are still external evidence and are
not claimed by this audit. The audit asserts the automated-fixture column only.

## Provider/device scope

The v0.12 real-host gate verifies DSH integration. It does **not** automatically certify every Telegram/Feishu/QQ/DingTalk/WeChat/WxPusher provider payload, button ACK, media limit or reconnect condition.

Standing provider-level gaps remain documented in `docs/developer/memory/risks.md`.

## dsh-im experiment boundary (2026-10-01)

The reviewed upstream xmanrui/dsh-im exposes `dshImClient` for client-panel embedding.
No current upstream contract was found for the experimental notifier bridge's
`ctx.dshIm.send/listBots/listTargets`, nor for its assumed export formats. These
modules remain internal experiments. Their fixture tests are not interoperability
or migration evidence; neither feature is advertised in user instructions.

## Cloud deployment checks

Local workerd executes the actual Bark D1 migrations and validates the APNs request
signature using Bark's officially published self-hosting key. Telegram streaming and
429 behavior are checked in the same runtime. Real React checks exercise one-click
deploy, automatic fill/save, custom address entry and unbind. See [cloudflare.md](cloudflare.md)
for production-account/device evidence boundaries.
