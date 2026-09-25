# PLUGINS.en.md — Calling dsh-notifier from your plugin

> 中文: [PLUGINS.md](PLUGINS.md)
> Since dsh-notifier v0.6 there are two surfaces: **outbound** — the injected `ctx.notifier` service (push), and **inbound** — the `dsh-notifier/sent` event (subscribe).
> This document is for **consumer plugin authors**. Public API version: `0.7` (`ctx.notifier.version`; bumped only on a public-surface break, independent of the package version).

## 30-second quick start

```js
// your plugin src/index.mjs
export const inject = ['notifier']

export function apply(ctx) {
  // After the static declaration, the service is ready when apply runs
  // (the host guarantees the wait) — use it directly.
  ctx.notifier.push({ title: '📧 New mail', content: 'From x@y.z: weekly draft', level: 'active' }, { sourceName: 'my-email-plugin' })
    .then((result) => { if (!result.ok) ctx.logger.warn('push failed', result.failed) })
}
```

## Getting the service: static declaration is the only working form (verified on device)

> Decided by on-device verification on 2026-08-16 (DSH 0.1.0-rc.6 / Node 24): the host cordis **only honors a static `inject` declaration**. The two alternative forms below were measured as unusable on rc.6.

| Form | On-device result | Notes |
|---|---|---|
| ✅ Static `export const inject = ['notifier']` | **Works (the only usable form)** | The service is ready when apply runs; the probe resolved a real service with `version=0.6` |
| ❌ Callback-style `ctx.inject(['notifier'], cb)` | **Callback never fires** | The API exists but the callback never runs and the waiting branch hangs — do not use |
| ❌ Probe-style `typeof ctx.notifier?.push === 'function'` | **Throws immediately** | Without a declared inject, accessing the service property is blocked by the host: `cannot get property "notifier" without inject` |

**Why the static declaration is safe**: dsh-notifier v0.6 promises to `ctx.provide` the service in every shape (including `enabled: false`, zero channels, top-level disable — as a no-op stub when disabled). As long as dsh-notifier is **installed**, the static declaration can never stall startup. The reverse is also true: if you declare it statically while dsh-notifier is **not installed**, the host will wait for the service and stay pending (blocking startup) — list dsh-notifier as an install prerequisite of your plugin and state that in your docs.

**Likewise**: to register tools you must declare `inject: ['tools']` (rc.6 requires a static declaration for `ctx.tools` too; accessing it without one throws). `ctx.on` (event subscription) needs no declaration.

Importing from the package root only guarantees the DSH plugin contract `{ name, inject, apply }`. Internal constructors (the store, the token vault, the public facade) are not consumer API; they are exposed only through the explicit `dsh-notifier/internal` subpath for local tests and build tooling.

## push API

```js
const result = await notifier.push(message, options)
```

- `message: { title?, content?, level?, group? }`
  - `level`: `timeSensitive` / `active` / `passive` (default `active`; invalid values are dropped)
  - `title`/`content` are treated as empty when not strings; **both empty** → `skipped: ['(malformed)']` (no push, no ledger entry, no rate-limit slot consumed)
  - Length clamping: 20000 code points each; over-length text is truncated with a warn (preventing a segmentation storm)
- `options: { sourceName?, channel? }`
  - `sourceName`: source label (goes into the ledger and the sent event, for auditing and future per-source muting); missing/non-string = `anonymous` (shares a single rate-limit window with other anonymous calls)
- `channel`: target a single channel type (e.g. `'telegram'`); omit it to broadcast to every configured channel through level-based routing

The public surface also applies a bounded resource budget per underlying notifier instance (overridable in `public`): `maxCalls` default 10000, `maxBytes` default 10 MiB, `maxConcurrent` default 16, `maxQueue` default 64. The budget is shared by the instance and is not reset by rotating `sourceName` or creating a second facade; exceeding it returns `skipped: ['(budget)']`, and a full concurrency/queue returns `skipped: ['(busy)']`. `sourceName` is only a redacted audit display label (trimmed, 64 code points, control characters replaced) — not an identity credential.

**Return value (never rejects — internal errors return `failed: [{ reason: 'internal' }]`, so you never need try-catch):**

```js
const result = { ok: true, delivered: ['telegram'], skipped: [], failed: [], source: { kind: 'plugin', name: 'my-email-plugin' } }
```

- Common `skipped` values: `(malformed)` both empty / `(disabled)` service off / `(rate-limited)` over quota / `(quiet)` conversation muted / `(channel name)` targeted channel not configured
- A targeted push (`channel` present) takes the single-channel path; like a broadcast it writes one audit record and emits one `sent` event, and the outcome is still read only from the return value

## Rate limiting

Each source has its own sliding window, default 10 calls/minute (the host can adjust it with `public.limitPerMinutePerSource`; 0 = unlimited). Over quota returns `skipped: ['(rate-limited)']` — **still recorded, still emits the event** (muted does not mean it did not happen), so you can tell you were limited.

The public surface also carries an instance budget independent of `sourceName`: `maxCalls` (default 10000), `maxBytes` (default 10 MiB, by UTF-8), `maxConcurrent` (default 16) and `maxQueue` (default 64). The budget is reserved before dispatch; exceeding it rejects only the current call with `skipped: ['(budget)']` or `['(busy)']`, and changing the source label or creating a second facade cannot bypass the total budget of the same notifier instance.

## Subscribing to the sent event

```js
ctx.on?.('dsh-notifier/sent', (record) => {
  // record: { time, ok, delivered[], skipped[], failed[], source?, channel?,
  //   titleLength, contentLength, titleBytes, contentBytes, hasContent }
  // The sent event never contains title/content, approval text, user body text
  // or adapter error text.
})
```

- The payload is **deep-frozen and read-only**: mutating it throws `TypeError`; to change it, copy first with `{ ...record }`
- Not emitted when the host disables `public.emit` (on by default)
- **Listener rule**: it must return immediately in O(1) (emit is a synchronous call — offload heavy work to your own queue); **never push inside the listener** (it causes a push loop; rate limiting backstops it, but it should not happen)

## flush (wait for in-flight delivery before unload)

```js
export const inject = ['notifier']

export function apply(ctx) {
  const notifier = ctx.notifier // ready at apply time; capture the reference directly
  ctx.on?.('dispose', () => { notifier?.flush?.() })
}
```

flush is idempotent and can be called repeatedly.

The public facade itself is a frozen object exposing only `version`, `enabled()`, `push()` and `flush()`; consumers cannot call `dispose()`. On unload the host cleans up facade resources through a private disposer, and repeated unloads are safe.

## Three-state semantics (what you actually get)

| Host state | What you get | push behavior |
|---|---|---|
| Normal | Full facade | Real delivery |
| `public.enabled: false` / top-level `enabled: false` | no-op stub | `skipped: ['(disabled)']` |
| Zero channels configured | Full facade | `ok: false` + three empty arrays (honest empty delivery — no ledger entry, no event; matches on-device verification and the zero-channel exit in `notify.mjs`) |

## Version and compatibility

- **Prefer capability detection**: `typeof notifier?.push === 'function'`; do not compare versions for equality
- `notifier.version` is for display/logging only
- Since 0.7 the sent event is a metadata-only breaking contract; consumers of the old `record.message` must migrate to the length/status fields
- The facade return value is a frozen, stable public surface (`version`, `enabled()`, `push()`, `flush()`); unload is managed internally by the host, and consumers must not call `dispose`
- Only a public-surface break bumps `version` and announces it at the top of the CHANGELOG

## Full example (defensive recipe)

```js
export const name = 'my-plugin'
export const inject = ['notifier']

export function apply(ctx) {
  const notifier = ctx.notifier
  const log = (...args) => { try { ctx.logger?.info?.(...args) } catch { /* a missing logger is not fatal */ } }

  // Outbound: push (use directly after the static declaration; never-reject, no .catch needed)
  notifier.push(
    { title: '⏰ Reminder', content: 'Time to review', level: 'timeSensitive' },
    { sourceName: 'my-plugin' },
  ).then((result) => log('push result', result.ok, result.delivered))

  // Inbound: subscribe to broadcast results (no inject needed; read-only + O(1) + no push)
  ctx.on?.('dsh-notifier/sent', (record) => {
    log('sent', record.source?.name ?? '(internal)', record.ok ? 'ok' : 'failed')
  })

  // Unload: flush in-flight delivery
  ctx.on?.('dispose', () => { notifier?.flush?.() })
}
```

## Unit testing: `dsh-notifier/testing`

Consumer plugin tests do not need a hand-written stub:

```js
import { createFakeNotifier } from 'dsh-notifier/testing'

const fake = createFakeNotifier({ sourceName: 'my-plugin', now: () => 0 })
// Inject the fake as ctx.notifier into your apply()
const result = await fake.push({ title: 'T', content: 'C' }, { sourceName: 'my-plugin' })

fake.version        // '0.7', the same public-surface version as the real facade
fake.calls          // [{ message, options, at }], a read-only array (each read returns a deep copy)
await fake.flush()  // resolves undefined
```

The behavior spec mirrors the real facade item by item: `push` **never rejects**; it returns `{ ok, delivered, skipped, failed, source }` (`source.kind` is always `'plugin'`, and `delivered: ['fake']` on success); non-string `title`/`content` count as empty, and both empty → `skipped: ['(malformed)']`; `options.simulate: 'rate-limited' | 'disabled' | 'budget' | 'busy'` replays the matching `skipped`, and unknown values succeed normally — use it to test your failure branches without touching host config.

Two deliberate differences (not defects): the fake does no length clamping, rate limiting or budget accounting (the real resource semantics are covered by the real facade contract tests), and it does not provide `enabled()` (a host diagnostics surface; detect capability with `typeof notifier?.push === 'function'`). The fake **does not emit** the `sent` event — the event surface is not part of this tool; test the event side with your own `ctx` stub.

## TypeScript: `dsh-notifier/types`

When writing a consumer plugin in TS, take the types from the type-only subpath:

```ts
import type { NotifierFacade, NotifyMessage, PushResult } from 'dsh-notifier/types'
```

It exports `NotifyLevel` / `NotifyMessage` / `NotifyOptions` / `PushResult` / `PushFailure` / `NotifierSource` / `NotifierFacade` / `SentEventRecord` / `FakeNotifier` and more, aligned item by item with the runtime public surface (only real fields are declared; internal options are not exposed). `NotifierFacade.version` is the literal `'0.7'`, from the same source as `ctx.notifier.version`. `SentEventRecord` stays metadata-only — **without** `title`/`content`/raw error text.

This is an explicit type-only subpath: the package root (`dsh-notifier`) is the DSH plugin contract itself and has **no** root `"types"` field (the root JS export surface is far larger than the notifier public surface). Always import `from 'dsh-notifier/types'`.

## On-device verification record

- **2026-08-16 · DSH 0.1.0-rc.6 (web profile, Node 24)**: features A/B both confirmed — a static-inject consumer resolved a real service with `version=0.6` (not a stub); the `dsh-notifier/sent` event was visible across plugins (15/15, complete payload shape); the zero-channel semantics matched the design (`ok:false` with three empty arrays; no crash, no startup block). It also settled that the callback-style `ctx.inject` never fires and that accessing a service property without a declaration throws — every recipe in this document was therefore finalized on the static declaration. Install note: when the host manages dependencies with pnpm, manually overwriting `node_modules/dsh-notifier` is rolled back; upgrade with `dsh plugin add file:<path>` instead.

## FAQ

**Q: Why not `import dsh-notifier` directly?**
What you import is the constructor — you would have to parse config and build your own instance: two configs, two ledgers, separate rate limiting. Service injection shares all of dsh-notifier's infrastructure (channel config, routing, ledger, rate limiting, flush).

**Q: Can my plugin receive the sent event for its own push?**
Yes (broadcast is unfiltered). So pushing inside the listener = an infinite loop, which the listener rule forbids.

**Q: Can sourceName be anything?**
It goes into the notification ledger for the user to audit; using your plugin name is recommended. Maliciously forging another sourceName is an in-process trust-domain issue (the same level as inject), and is not signed.

**Q: Can I import the package root to get a constructor?**
The package root exports only the DSH plugin entry (`name`, `inject`, `apply`). If a test or build tool genuinely needs an internal constructor, use the explicit `dsh-notifier/internal` path; this is not OS-level isolation, and a malicious in-process plugin is still inside the host trust boundary.