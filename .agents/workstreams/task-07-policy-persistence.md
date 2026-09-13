# Workstream: task-07-policy-persistence

_Authored before implementation. Contract / affected files / risk / next hook written up front._

- Agent identity: `claude_fable_5 | claude-code | Windows 11 desktop`
- Agent: `claude_fable_5`
- Branch: `codex/stage3-team-policy`
- Status: complete (code/contract-tested; no real-device validation, no public push)
- Start/end: `2026-08-26 -> 2026-08-26`
- Validation: `npm test` = **1223 (1222 pass + 1 skip)**; release guard (`0.8.6`/909), `gen-channel-matrix --check`, `node --check` × 5, `git diff --check` all green. Persistence/API-only; runtime authorization wiring intentionally deferred (see Next Hook).
- Scope: **Stage 4 — persist the already-reviewed session control policy (owner / approvalOwnerOnly / approvalMembers) as an addressable bounded overlay on each `route:sessions` record, exposed through the defensive session-registry API and the loopback Bearer-protected admin HTTP surface.** Persistence/API-only. No runtime authorization path is wired in this slice (see Next Hook). Does not touch any IM transport, adapter, release version, real-device work, approval.parallel, or Stage 5.

## Contract — persisted overlay shape

Per-session `control` subkey under `route:sessions[<sessionId>]`:

```
{ mode?: 'team'|'personal', owner?: string, approvalOwnerOnly?: boolean,
  approvalMembers?: [ { channel, accountId, userId } ] }
```

- **Minimal overlay only** — stores exactly what the operator set, never normalized defaults
  (so a future layered merge keeps personal defaults: observe/approve on, converse/group-control off).
- **Source fields are never allowed**: `channel/accountId/userId/chatId/sessionId/policyVersion/
  expiresAt/revoked` are rejected in the admin payload. An admin payload must never manufacture the
  channel/account/user/chat that authorization compares against — those derive from the session's real
  source. Fail-closed (constraint 2).
- **Bounds and rejections** reuse the arbiter's existing rules: approvalMembers capped at 64, deduped,
  exact `(channel,accountId,userId)` triples; wildcard/global/empty (`*`,`all`,`everyone`,`anyone`,
  contains `*`) rejected; owner/member strings trimmed, non-empty, ≤128 chars.
- `approvalOwnerOnly=true` + owner stays the only owner-only authorization; `mode='team'` + non-empty
  members + owner enables team membership; personal / no-list keeps personal default behavior.
- **Personal defaults safe**: the overlay carries only the four approved fields, so it can never flip
  `converse` or `groupChatControl` on. Those remain separate gates.

## Files

- `src/control/session-arbiter.mjs` — add pure `normalizeControlOverlay(input)` + exported limits
  (`MAX_APPROVAL_MEMBERS`, `MAX_OVERLAY_STRING`). Single source of truth for "what is a valid overlay";
  ignores unknown/source fields, never throws, caps/dedups members exactly like `normalizeApprovalMembers`.
- `src/routing/session-registry.mjs` — add defensive `getControl` / `setControl` / `clearControl`
  (copy-on-read; normalize-before-write via `normalizeControlOverlay`; preserve unrelated keys;
  corrupted overlay treated as absent; never throw into host). Registry stays the session-lifecycle
  write owner, mirroring the existing `getSession`/`setOutbound` shape.
- `src/routing/agent-router.mjs` — add `setSessionControl(sessionId, diff)` mirroring
  `setSessionOutbound`: field-level diff via `route:sessions[id].control`, canonicalized by
  `normalizeControlOverlay`, returns boolean from `writeMap` (so the admin layer can surface 500).
  Preserves outbound-patch semantics and unrelated fields.
- `src/admin/api.mjs` — add `patchSessionControl(id, diff)` with strict validation (unknown/source
  fields 422, malformed/bounds/global 422, null-clear, 404 missing session, 500 storage failure) and
  audit `setSessionControl`; extend `getSessions()` rows with a **safe redacted** `control` summary
  (mode / approvalOwnerOnly / ownerHint prefix / approvalMembersCount — never raw identifiers).
- `src/admin/server.mjs` — add `PATCH /api/sessions/:id/control` route (Bearer-gated, 127.0.0.1).
- `test/session-arbiter.test.mjs`, `test/session-registry.test.mjs`, `test/agent-router.test.mjs`,
  `test/admin-api.test.mjs`, `test/admin-server.test.mjs` — focused tests.

## Risks / adversarial notes

- **Two write paths to `route:sessions[id].control`** (registry in-memory + router store map) mirror the
  existing outbound dual-path; both canonicalize via `normalizeControlOverlay`, so they cannot drift on
  shape. Documented, not redesigned in this slice.
- **Admin never fabricates source** — the overlay cannot carry channel/account/user/chat; a hostile
  payload setting them gets 422, and even a direct store edit with them is dropped by
  `normalizeControlOverlay` on next read/write (fail-closed).
- **No second authorization system** — this slice adds persistence + addressability only. `canSettleApproval`
  / `canAcceptCommand` / Control Core are not duplicated or bypassed.
- **Restart/store round-trip + corrupted store**: registry `loadSessions` and router `readMap` already
  tolerate a non-plain-object table; a corrupted `.control` subkey is treated as absent by readers and
  overwritten cleanly by writers; `getSessions` masks only plain-object control.
- **No real-device/provider claim** — persistence and admin round-trip are code + mock-tested only.

## Next hook (runtime wiring) — explicitly deferred, not started

Wiring the persisted overlay into authorization requires touching the just-reviewed
`createControlEntry` source-binding hot path (`src/control/entry.mjs`) and every approval/question
adapter's session lookup — an invasive refactor with regression risk to rounds 2-4 adversarial fixes.
This slice therefore stays persistence/API-only per the mandate "never invent a parallel authorization
path". The exact next hook, when a review gates it:

1. `createControlEntry({ policy, policyForSession })` accepts an optional async/regular resolver
   `(sessionId) => normalizedOverlayOrNull`.
2. In `handle()`, after `pendingMeta`/`buildEvent` resolves the event's real `sessionId`, merge
   `normalizeSessionPolicy({ ...basePolicy, ...overlayOf(sessionId) })` before the existing
   source/authorization checks — the overlay carries no source fields, so the reviewed
   source-binding / conflict-consistency logic is unchanged and still authoritative.
3. Adapters (approval/question) resolve the session id from the pending row's `sessionId`/`agentId`
   and hand it to the entry; no second arbiter, no admin/adapter permission re-implementation.
4. Keep personal defaults: overlay absence → base policy unchanged.

## Validation

`node --test test/session-arbiter.test.mjs test/session-registry.test.mjs test/agent-router.test.mjs test/admin-api.test.mjs test/admin-server.test.mjs` (163 focused, all green) then `npm test` = **1223 (1222 pass + 1 skip)**, `node scripts/verify-release.mjs` (`0.8.6`/909), `node scripts/gen-channel-matrix.mjs --check`, `node --check src/control/session-arbiter.mjs src/routing/session-registry.mjs src/routing/agent-router.mjs src/admin/api.mjs src/admin/server.mjs`, `git diff --check`. Updated CHANGELOG / risks / HANDOFF / this workstream with real totals (1223/1222/1) + the real-device gap. Commits on `codex/stage3-team-policy`: `69ad33f` (feature) + `815d50f` (handoff pin). Push to private remote attempted once and failed — `git push private codex/stage3-team-policy` → `fatal: unable to access 'https://github.com/THEWOLFWALKER/dsh-notifier-dev.git/': Failed to connect to github.com port 443 after 21058 ms: Could not connect to server` (exit 128). No GitHub connectivity on this host; commits kept locally, no public push. Real-device gap: no operator ever patched a real session overlay through the admin API, no host restarted against a persisted overlay, and the persisted overlay is not yet wired into authorization — so this slice is code/contract-tested only, never `real-device-verified`.

### Follow-up adversarial review (`task-08-policy-persistence-review.md`, complete)

A subsequent adversarial review (Stage-4 reserve workstream) fixed the split-writer `route:sessions` lifecycle erase/clobber (record-level re-read/merge `persist()` + sweep tombstones), the swallowed durable-write failures (`store.save/set` boolean → `router.safeSet` `false`-as-failure → admin 500), and the shallow-copy control alias (deep-copy-on-read). 6 new focused tests (real-store save failure, real-createStore admin 500, 4 cross-component router→registry) + 2 pre-existing test corrections off mock aliasing. Full `npm test` = **1230 (1229 pass + 1 skip)**; version still `0.8.6`.