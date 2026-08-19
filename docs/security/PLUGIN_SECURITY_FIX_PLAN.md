# DSH Plugin Security Fix Plan

Date: 2026-08-19
Objective: remove confidentiality, authorization, audit, and denial-of-service defects that can be fixed inside `dsh-notifier`, without adding user-facing features or modifying DeepSeek Harness.

## Decision Rules

- Preserve the zero-runtime-dependency design and existing fail-closed approval behavior.
- Prefer a smaller public contract over compatibility shims that cannot enforce policy.
- Never treat `sourceName`, an event name, a Cordis fiber, or a manifest field as authenticated identity.
- Every behavior change gets focused adversarial tests, a CHANGELOG security note, and the full project validation suite.
- Do not claim credential isolation until the host supplies a process boundary and a secret broker.

## In-Scope Fixes

## Terra Implementation Slice 1: A1 + A2

This is the first coding slice. It is intentionally limited to event confidentiality and audit consistency; do not implement A3-A6 in the same commit.

Owned files:

- `src/index.mjs`: build and emit a redacted cross-plugin event record.
- `src/notify.mjs`: invoke the existing `onSend` hook for directed sends as well as broadcasts, after the operation has a final outcome.
- `src/public.mjs`: preserve the caller result while ensuring directed sends pass the same audit callback; do not expose raw internal records through the event path.
- `test/public.test.mjs` and `test/notify.test.mjs`: update old directed-send expectations and add adversarial coverage.
- `PLUGINS.md` and `CHANGELOG.md`: document the breaking public event contract and security reason.

Required data contract:

- `dsh-notifier/sent` remains a frozen object with delivery metadata, `time`, `ok`, `delivered`, `skipped`, `failed` (with error text removed or normalized), `source`, and non-content message metadata such as `titleLength`, `contentLength`, and `hasContent`.
- The event MUST NOT contain `message.title`, `message.content`, approval rationale, user text, raw adapter response text, or a reversible encoding of any of them.
- The direct `notifier.push()` return value remains backward-compatible for the caller in this slice; only the cross-plugin event is redacted.
- A directed public send emits exactly one audit/event record after the final outcome, with its target channel included in metadata. A broadcast emits exactly one record through the existing callback. Rate-limit and malformed outcomes keep their existing fail-closed semantics and are not duplicated.
- Callback failures remain isolated: ledger/event sinks must not alter the caller result or break unrelated channels.

Negative tests required before handoff:

1. A listener receiving `dsh-notifier/sent` cannot find `message`, title, content, approval text, or adapter error body.
2. Unicode and multibyte content is represented by correct code-point/byte metadata without exposing the content.
3. Directed success, directed failure, unconfigured channel, and rate-limited calls each produce the documented single audit record.
4. Broadcast behavior and existing caller result deep-equality remain stable except for the documented event redaction.
5. A throwing audit sink does not reject `push()` or suppress another sink.

Do not add a new configuration flag or high-risk content opt-in in this slice. The existing `public.emit` switch still disables event work entirely.

### A1. Make cross-plugin events metadata-only by default

Change `dsh-notifier/sent` to emit delivery metadata, status, lengths, and channel names. Do not include title/content, approval rationale, user text, raw adapter error bodies, or a reversible encoding of message content. Do not add a content opt-in during the maintenance cycle.

Compatibility: bump the public event contract, update `PLUGINS.md`, and provide a migration note for consumers that currently read `record.message`. The notifier delivery result returned to the direct caller remains unchanged.

Tests: assert default redaction, digest stability, no sensitive fields in ledger/admin event payloads, and that an event listener cannot recover the original content from metadata.

### A2. Unify audit for broadcast and directed sends

Route every public send through one `onSend`/ledger/event policy. A directed send must carry its target channel in the audit record and be subject to the same redaction and failure accounting as broadcast sends.

Tests: fake one channel, call directed and broadcast paths, and assert exactly one consistent audit record per attempted operation, including failures and rate-limit denials.

### A3. Replace self-reported identity with bounded instance controls

Treat `sourceName` as an untrusted display label: trim, length-limit, and encode control characters. Add facade-instance global budgets for calls, bytes, concurrent sends, and queued work. Keep per-label limits only as an observability aid, never as the primary security control.

Tests: rotate labels, inject newlines/ANSI controls, flood concurrent calls, and verify hard rejection without affecting unrelated channels.

### A4. Freeze and narrow the public facade

Return a frozen object with only stable consumer operations. Remove consumer access to `dispose`; retain teardown in a private closure owned by the provider. Do not expose mutable implementation references through `enabled`, `version`, or nested results.

Tests: `Object.isFrozen(facade)`, attempted mutation in strict mode, no consumer teardown, idempotent provider disposal, and no cross-instance interference.

### A5. Validate stateful inbound paths and resource bounds

Add explicit envelope length and field limits, bounded dedup retention, callback freshness/nonce checks where the provider protocol permits them, HTTP request/keep-alive timeouts, and a concurrent callback limit. Change callback-ref capacity behavior to reject new refs when full rather than evicting live references. Key reply throttling by `(channel,userId)`.

Tests: oversized JSON, unique-ID floods, slow connections, stale/replayed callbacks, capacity-full refs, and equal user IDs on two channels.

### A6. Reduce accidental attack surface in package exports

Keep the root entry focused on the plugin contract and publish internal constructors only through an explicitly internal test/build path. Update tests and documentation together; do not pretend this is an OS security boundary.

Tests: package export smoke test, public API snapshot, and a source check that credentials/store constructors are not reachable from the normal consumer path.

## Out-Of-Scope Residual Risks

The following controls cannot be implemented by this repository. They are recorded only so our changes are not misrepresented as plugin isolation:

1. A same-process hostile Node plugin can bypass our facade and read process-accessible files, environment, memory, or globals.
2. `dsh-notifier` cannot create an unforgeable plugin identity, enforce host-wide event/service ownership, or impose OS isolation on another plugin.
3. Our local controls therefore reduce disclosure, misuse, audit gaps, and resource abuse through supported notifier paths; they do not make hostile installed plugins safe.

No DSH host source change, host pull request, or host feature implementation belongs to this plan.

## Phase C: Delivery Order

1. Land A1 and A2 first because they reduce confidentiality and audit impact without changing channel protocols.
2. Land A3 and A4 with a public API contract/version review.
3. Land A5 in provider-focused slices, each with protocol-level or real-device validation where mocks are insufficient.
4. Land A6 only after consumer usage is inventoried and the release artifact export map is tested.

## Adversarial Review Checklist

- Can a caller bypass the proposed limit through a second facade, direct root import, or a directed channel?
- Does any event still contain recoverable user content by default?
- Can a failed sink, logger, adapter, or teardown break another channel or the host?
- Are limits measured on complete bytes/items and enforced before allocation or fan-out?
- Does a malformed, stale, wrong-channel, or replayed callback fail closed without consuming a valid pending action?
- Does the change preserve state merge/locking and avoid credential/log exposure?
- Is the claimed control enforced at the real runtime boundary, or only by a wrapper that hostile same-process code can bypass?

## Exit Criteria

- Focused tests cover every A-phase denial and compatibility path.
- `npm test`, `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, and `git diff --check` pass.
- `CHANGELOG.md`, `docs/memory/risks.md`, and `docs/KNOWLEDGE_BASE.md` identify the new contract and remaining host dependency.
- The final release note states plainly that same-process hostile plugins remain a residual trusted-code risk outside this repository's repair scope.
