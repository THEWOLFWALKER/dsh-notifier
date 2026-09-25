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

## Provider/device scope

The v0.12 real-host gate verifies DSH integration. It does **not** automatically certify every Telegram/Feishu/QQ/DingTalk/WeChat/WxPusher provider payload, button ACK, media limit or reconnect condition.

Standing provider-level gaps remain documented in `docs/memory/risks.md`.
