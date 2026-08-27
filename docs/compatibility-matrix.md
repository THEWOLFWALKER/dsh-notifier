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
