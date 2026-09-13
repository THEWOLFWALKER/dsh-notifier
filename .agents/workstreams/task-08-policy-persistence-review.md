# Workstream: task-08-policy-persistence-review

_Authored before implementation (plan first). Adversarial-review fix round for Stage 4 (commit `69ad33f`). No Stage 5._

- Agent identity: `claude_fable_5 | claude-code | Windows 11 desktop`
- Branch: `codex/stage3-team-policy`
- Status: complete (all P1 + P2 fixed; code/contract-tested; no real-device validation, no public push)
- Commit: `5c6b4fc` (feature + tests + CHANGELOG/risks/workstreams) + handoff-pin commit after it.
- Start: `2026-08-26`
- Upstream: Stage 4 `69ad33f` (`task-07-policy-persistence.md`) — persisted session control overlay via registry + loopback admin API; `normalizeControlOverlay` single-spec; already reviewed.
- Mandate: fix adversarial-review P1s + low-risk P2s; provider-neutral Stage-4 files/tests/docs only. No adapters, UI redesign, real-device validation, approval.parallel, version bump, or public push.

## Plan

### P1-1 — split writers on `route:sessions` (lifecycle erase / cross-session clobber)

**Defect.** `src/routing/session-registry.mjs` keeps a whole in-memory cache of `route:sessions` and `persist()` writes it verbatim via `store.set(SESSIONS_KEY, sessions)`. `src/routing/agent-router.mjs` `setSessionControl` (and `setSessionOutbound`) read the whole table from the store and write it back whole. The registry's cache is loaded once at construction and never sees a control the router later wrote, so a lifecycle write (ensure/touch/markDisposed) **erases a freshly admin-set control** and can drop unrelated/cross-session updates the registry's stale cache never contained.

**Fix (record-level re-read/merge — the review's allowed alternative).** Change `persist()` to:
1. re-read the store's current `route:sessions` fresh as the merge base (read-convergence gives the router/admin side),
2. delete tombstone ids tracked during sweep, then merge each in-memory record ONTO its disk record via `{ ...base[id], ...record }` — a disk-only subkey like `control` survives because the cache never owns it; a router-created session the cache never saw is preserved as-is,
3. canonicalize/remove a malformed `control` subkey on the way out (`normalizeControlOverlay`) — also the P2 lifecycle-write canonicalization,
4. write the merged table — the same single `route:sessions` key, so the store lock/lock-merge semantics are unchanged.

Track swept deletions in a `removedIds` set so a sweep removal isn't resurrected by the fresh base; clear only on a successful persist (mirroring dirty retention on failure).

**Tests (cross-component router -> registry):** with registry + router sharing one store —
- `touch` after `router.setSessionControl` must not erase the control;
- `ensureSession` after `router.setSessionControl` must preserve the control and unrelated session;
- fresh-registry `restart` after a router control write must still read the control from store;
- a swept (expired) disposed session must actually be removed from the persisted store.

### P1-2 — durable write errors are swallowed (store -> router -> admin)

**Defect.** `src/inbound/store.mjs` `save()` catches every disk failure in a bare `catch {}` and returns nothing; `createStore.set()` returns nothing. `src/routing/agent-router.mjs` `safeSet` treats non-throw as success, so `setSessionControl`/`setSessionOutbound` return true and `PATCH /api/sessions/:id/control` returns 200 although the write was lost on restart.

**Fix (explicit durable success propagation, preserving existing callers).**
- `store.save()` returns a boolean: `true` only after the durable `rename` completes; `false` on the disk-failure catch and on the corrupt-rename-failure abort. `store.set()` returns that boolean. (Callers that ignore the return value are unaffected.)
- `router.safeSet` treats a returned `false` as failure while still treating `undefined` (legacy fake stores that never introduced a failure signal) as success — backward compatible.
- admin already maps `setSessionControl() !== true` to `ApiError(500)`, so a real durable failure now surfaces as 500 end-to-end.

**Tests.** New `test/store.test.mjs` using the **real** `createStore` save-failure path: parent path is a regular file so the durable write fails deterministically; assert `set` returns `false` (and `true` on a writable path). In `test/admin-api.test.mjs`, wire a real failing `createStore` (+ real router) and assert `patchSessionControl` throws `ApiError(500)` — not only the existing fake-throwing-setter test.

### P2 — registry public records alias internal control

`getSession`/`setControl`/`clearControl`/`setOutbound`/etc. return `{ ...record }` shallow copies, so a caller mutating `record.control.approvalMembers` (= the nested `approvalMembers` array) mutates registry internal state. Fix: a `recordCopy(record)` helper that deep-copies `control`/`outbound`/`inbound` subkeys, used on all public record returns.

## Files

- `src/inbound/store.mjs` — `save()`/`set()` durable success boolean.
- `src/routing/agent-router.mjs` — `safeSet` treats `=== false` as failure.
- `src/routing/session-registry.mjs` — record-level merge `persist()`, sweep tombstones, canonicalize control, `recordCopy` on public returns.
- New `test/store.test.mjs`; extend `test/session-registry.test.mjs`, `test/agent-router.test.mjs`, `test/admin-api.test.mjs`.
- `CHANGELOG.md`, `docs/memory/risks.md`, `HANDOFF.md`, this workstream, `task-07-policy-persistence.md` (status pointer).

## Risk / adversarial notes

- **Existing callers preserved**: `createStore.set`/`delete` return-value contracts only gain a durable signal; `delete` keeps returning `existed`; `router.safeSet` keeps `undefined` = success for legacy fakes; registry public record returns still deepEqual the same structure.
- **Boundaries kept**: no new writer to `route:sessions`; the store lock/merge is unchanged; admin owns control validation; the overlay is still not wired into `createControlEntry` (explicit deferred next hook, no Stage 5).
- **Known residual (documented, not expanded)**: `createStore` has no transaction primitive, so a router read-merge-write still reads-fresh-then-writes whole; the dominant erasing source (registry whole-cache persist) is eliminated and covered by regression tests. The outbound dual-path clobber is pre-existing and out of Stage-4 scope.

## Validation

`node --test test/store.test.mjs test/session-registry.test.mjs test/agent-router.test.mjs test/admin-api.test.mjs test/admin-server.test.mjs` focused = **156, all green** (150 prior + 6 new: 2 `store.test.mjs`, 1 real-createStore admin 500, 4 cross-component router→registry). Full `npm test` = **1230 (1229 pass + 1 skip)**; `node scripts/verify-release.mjs` (`0.8.6`/909), `node scripts/gen-channel-matrix.mjs --check`, `node --check` on the changed Stage-4 files, `git diff --check` all green. Two pre-existing session-registry tests were corrected off the mock-store's reference aliasing (registry cache === store object, which my by-value `persist()` no longer produces — matching the real `createStore`'s value semantics) onto the durable value-semantics the store actually guarantees. Package/version unchanged at `0.8.6`; no public push; private push only if configured and reachable.