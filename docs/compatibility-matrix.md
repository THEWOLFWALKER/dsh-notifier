# Optional SDK and legacy compatibility matrix

Snapshot: 2026-08-27. This matrix records repository seam/contract evidence only; it is not provider or real-device certification.

| Surface | Optional dependency | Supported seam | Missing/old shape | Lifecycle evidence | Capability status |
|---|---|---|---|---|---|
| Feishu QR login | `@larksuiteoapi/node-sdk` `>=1.61.1` | lazy `registerApp` loader; named and `default.registerApp` exports | `missing-sdk` with install/version guidance | timeout, denied, expired, malformed credentials, QR callback failure are normalized and never persist partial credentials | contract-tested; provider validation pending |
| QQ QR login | `@tencent-connect/qqbot-connector` `^1.2.0` | lazy `startQrConnect`; named and `default.startQrConnect` exports; session/promise/result wait shapes | `missing-sdk` or incompatible export result, never throws | timeout, SDK error, invalid credential list, QR callback failure are normalized and never persist partial credentials | contract-tested; provider validation pending |
| Feishu inbound WS | `@larksuiteoapi/node-sdk` | lazy `Client`/`WSClient`/`EventDispatcher`; defensive SDK logger | missing/incomplete SDK reports unavailable/error without affecting other channels | idempotent start, reconnect owned by SDK, stop waits startup and closes/stops/terminates underlying socket; lifecycle is observable | contract-tested; long-connection real validation pending |
| QQ inbound gateway | none (native `fetch` + WebSocket) | protocol implementation with bounded heartbeat, reconnect backoff, stop/restart | transport errors are isolated and retried with finite backoff | stop clears reconnect/heartbeat state; restart is covered by tests | contract-tested; gateway/device validation pending |
| QR terminal rendering | `qrcode-terminal` | loaded only by login CLI when available | missing renderer does not change credential/login result | callback failures are absorbed | optional convenience only |

Legacy YAML `inbound.allowUsers` remains a one-time migration input. On first startup it is copied into composite `(channel,userId)` bindings for currently enabled inbound channels and marked `inbound:migrated`; subsequent starts do not re-seed deleted members. Runtime membership is managed by pairing/admin APIs. Removing this compatibility path is deferred until an upgrade/migration procedure and impact evidence exist.

WxPusher inbound now carries an explicit local `accountId`, defaulting to the literal `default` when omitted. The value is never derived from callback `data.appId`. Two WxPusher applications that both omit `accountId` therefore share the same channel-local source namespace and cannot be distinguished for source binding; configure distinct `accountId` values before operating multiple apps. This is a documented residual, not a reason to weaken fail-closed checks.

No optional SDK is a runtime dependency, and no matrix row implies `real-device-verified` or formal provider support.

---

# DSH host compatibility matrix

Snapshot: 2026-09-25. Records which **DeepSeek Harness** runtimes the dsh-notifier host seams
were verified against, from official source/artifact evidence only. Runtime
`detectHostVersion()` output is a diagnostic, never evidence (Issue #38 saw it disagree with the
reporter's actual install), so rows are keyed by release tag and `app-boot` `package.json` version.

The compatibility marker is `@deepseek-ai/dsh-session` — a real public `@deepseek-ai/dsh-*`
package that also owns the Session/Message host contract this plugin consumes. `dsh-notifier`
never imports it at runtime; it exists so the DSH boot preflight
(`packages/boot/app-boot/src/plugin-compatibility.ts`: `getDshRuntimeVersion()` +
`evaluatePluginCompatibility()`, which runs `semver.satisfies(runtimeVersion, range,
{ includePrerelease: true })` over every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer) can
check the running host. That evaluator reads `peerDependencies` only and ignores
`peerDependenciesMeta`, so the marker is declared `optional` to keep ordinary npm installs
unblocked without weakening the DSH check.

| Version | Source tag | Message V4 producer source | Attachments `saveImage`/`saveFile` | Cancel `{kind:'user'}` | Event `global` | Questions seam | `ctx.inject` | `session.events` | Result | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.1.7-alpha.1 | `dsh-v0.1.7-alpha.1` | yes | yes | yes | yes | `user-questions/request` waterfall | optional `ctx.inject(['userQuestions'])` | absent | verified | all six seam files byte-identical to `0.1.7-rc.1`; Issue #38 reporter environment |
| 0.1.7-alpha.2 | `dsh-v0.1.7-alpha.2` | yes | yes | yes | yes | `user-questions/request` waterfall | optional `ctx.inject(['userQuestions'])` | absent | verified | all six seam files byte-identical to `0.1.7-rc.1` |
| 0.1.7-rc.1 | `dsh-v0.1.7-rc.1` | yes | yes | yes | yes | `user-questions/request` waterfall | optional `ctx.inject(['userQuestions'])` | absent | verified | current source contract baseline (`packages/llm/llm/src/message.ts`, `packages/attachment/attachment/src/index.ts`, `packages/core/session/src/types.ts`, `vendor/cordis/src/{events,context}.ts`, `packages/interaction/user-questions/src/index.ts`) |
| 0.1.7-rc.2 | `dsh-v0.1.7-rc.2` | yes | yes | yes | yes | `user-questions/request` waterfall | optional `ctx.inject(['userQuestions'])` | absent | verified | five seam files byte-identical to `0.1.7-rc.1`; `packages/core/session/src/types.ts` differs only in doc comments (no structural change) |
| 0.1.0-rc.6 | none (tag unavailable) | — | — | — | — | — | — | — | unverified | historical `dshWorkshop.compatibility` claim; no public `dsh-v0.1.0-rc.6` tag/artifact exists to re-verify, so it is not covered by the peer range |

Peer range: `0.1.7-alpha.1 || 0.1.7-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2`.

No row is `real-device-verified`; every row is source/artifact contract evidence.

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
