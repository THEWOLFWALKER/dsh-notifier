# State writer registry (v0.15 / T07)

Authority map for every persistent store key: who may write it, through which entry point, and the
current convergence verdict. Companion to `docs/behavior-contract.md` and the T01 inventory in
`.agents/workstreams/core-distillation-v015.md`.

**Rule.** One business fact → one authority → one fresh transaction. A key with more than one
production writer is a defect unless the extra writer is a projection/observation that never claims
to own the fact.

## Store primitive

`src/inbound/store.mjs`

| API | Contract |
|---|---|
| `transact(mutator)` | lock → fresh read → detached draft → `mutator(draft)` → atomic rename → publish memory. Returns `{ ok, committed, durable, code, value }`. `false`/`undefined` are **not** aborts. |
| `transactOutcome(store, mutator)` | narrow variant; mutator gets `(draft, control)` and `control.abort(reason)` = business rejection with **zero write / zero publish**; returns `aborted` + taxonomy `code`. |
| `setDurable` / `deleteDurable` / `sweepPrefix` | single-key helpers; `committed===true` is the truth test. |
| `mergeDurable(store, key, patch)` | single-key **field-merge** in one transaction (T11); preserves concurrent sibling writes on `<type>:account`. |
| `transactDurable` | cross-key transaction; no real `transact` → `TRANSACTION_UNAVAILABLE` (never fakes atomicity). |

## Registry

| Key | Authority (owner) | Production writers | Verdict |
|---|---|---|---|
| `inbound:bindings` | identity | identity: `writeBindings`, `mutateBinding` (add/remove/update), `confirmPending`, `migrate`, `startupCleanup` | **single** |
| `inbound:pending` | identity | identity: `addPending`, `dismissPending`, `confirmPending`, `readPending` sweep | **single** |
| `inbound:migrated` | identity | identity: `migrate` (same transaction as bindings) | **single** |
| `inbound:pairing` | pairing | pairing: `mint`, `revoke`, `redeem`, `redeemAndBind`, `sweep` | **single** (see deferral) |
| `inbound:pairing:lockout` | pairing | pairing: redeem failure recorder, `clearLockout` | **single** |
| `route:agents` | agent-router | `setAgentBinding` (CLI/Admin/router) | **single** |
| `route:channels` | agent-router | `setChannelDefault` | **single** |
| `route:sessions` | ⚠️ router **and** session-registry | `agent-router.commitSessions` + `session-registry.persist` | **MULTI — T14 target** |
| `channel:<type>:outbound` | outbound-config | `outbound-config` `save`/`remove` (single in-transaction merge); `channel-config-migration` is a **one-shot, marker-guarded** projection | **single** (converged at T08) |
| `channel:<type>:inbound` / `<type>:account` | channel-config | `channel-config.mergeAccount` (in-transaction) + scan onboarding `_feishu-register` / `_qq-scan` (`mergeDurable`, in-transaction field merge) | **single** (converged at T11) |
| `aq:<id>` | questions router | `questions/router.mjs` | single |
| approval rows | approval router | `approval/router.mjs` | single |
| action rows | actions | `actions.mjs` | single |
| interaction ledger rows | interaction ledger | `interaction/ledger.mjs` | single |
| inbound dedup rows | inbound bus | `inbound/bus.mjs` (fail-closed on durable failure) | single |
| conversation bindings | inbound conversation | `inbound/conversation.mjs` | single |
| `taskselect:*` | routing | `task-selection.mjs` | single |
| `tg:offset` | telegram-bot | `inbound/telegram-bot.mjs` | single |
| `wechat:sync_buf` / ctx token | wechat legacy-core | `channels/wechat-ilink/legacy-core.mjs` | single |
| `dingtalk:robot-code` | dingtalk-stream | `inbound/dingtalk-stream.mjs` | single |
| `wxpusher:webhookPath` | assembly | `assembly/inbound-signals.mjs` | single |
| `wxpusher:bind:<uid>` | wxpusher-callback | `inbound/wxpusher-callback.mjs` | single |
| `admin:token-hash` | assembly | `assembly/admin-token.mjs` | single |
| `state:schema-version` | channel-config-migration | `channel-config-migration.mjs` | single |

### Hidden / secondary writers (registered, not a separate authority)

- **bootstrap seeding** — `identity.migrate` (first-boot owner promotion) writes `inbound:bindings`
  in the same transaction as `inbound:migrated`; one-shot, guarded by the migrated flag.
- **startup cleanup** — `identity.startupCleanup` rewrites `inbound:bindings` to drop dead keys;
  only on dead-key presence (zero write amplification otherwise); never touches `inbound:migrated`.
- **read-path sweep** — `identity.readPending` and `pairing.sweep` prune expired entries on read and
  write back; bounded, idempotent.
- **CLI** — `scripts/route.mjs` (`route.mjs set`, `... forget`) reaches `route:agents` /
  `route:channels` / `route:sessions` **through agent-router**, never via a raw key write.
- **Admin adapter** — `src/admin/api.mjs` mutates members/pairing/sessions **through the shared
  control-plane services** (identity / pairing / members / sessions), not directly.
- **dispose / teardown** — no key is written on dispose; teardown only releases listeners and locks.

## Deferrals recorded at T07

| Item | Why deferred | Risk | Next action |
|---|---|---|---|
| `inbound:pairing` `mint` / `revoke` still read-modify-write via `writeCodes` (two writes; `sweep` itself nests a `writeCodes`) | inlining `sweep` into one transaction without a nested `transact` needs a non-writing `sweepInTable` variant first | concurrent admin mint/revoke can lose one code entry; redeem path is already atomic | T06 follow-up: extract `sweepInTable` (no write) and run mint/revoke under `transactOutcome` |
| `route:sessions` multi-writer (router ↔ session-registry) | assigned to T14 | same-key lost update across the two writers | T14 |
| inbound `<type>:account` scan onboarding (`_feishu-register` / `_qq-scan`) wrote a whole object via `setDurable` while the port merged in-transaction | assigned to T11 | concurrent scan + manual `put` could drop a sibling field (feishu/qq write the same two fields today; low blast radius) | **resolved at T11**: scan commits now go through `mergeDurable` (in-transaction field merge); see the T11 row in `core-distillation-v015.md` |

## Outbound config layers (T08)

`channel:<type>:outbound` has exactly three layers, and only the first is persisted:

| Layer | What | Where | Mutability |
|---|---|---|---|
| **desired** | YAML base + canonical overlay (`rawOf`) | store key `channel:<type>:outbound` + YAML rows | persisted; returned by `raw()` as a deep clone |
| **resolved** | `adapter.resolve(desired)` output | live entry in `OutboundSource` | adapter owns it; **not** frozen (legal lazy caches) |
| **resources** | adapter-private `_`/`__` runtime fields (`_tokenManager`, `_msgSeq`, …) | on the live resolved object | Mutable, kept across sends; **stripped** from every projection |
| projection | `snapshot()` / `get()` copy | external observers (Native, Support Report) | deep-frozen, no reference sharing with live |

Precedence (outbound): `channel:<type>:outbound` (canonical) → `admin:channel:<type>:outbound` → non-dual `<type>:account` → YAML; the two Admin-legacy tiers are read only when `admin.enabled === true` and `allowLegacy !== false`. Secrets: patch keeps existing unless replaced; explicit `clear`/`null` removes and is rejected for public fields. Disable is explicit (`remove` with `mode:'revoke'` deletes canonical + legacy overlay sources; YAML bootstrap is not deletable).

Runtime truth has one owner (`RuntimeChannelManager`). Its lifecycle updates carry a **monotonic revision fence**: a stale (older `source.version`) apply result can never override a newer runtime state (T08 / C03).

The **resources** layer has one lifecycle owner too (T10): the per-`resolved` sender runtime
(`src/adapters/sender.mjs`). It is created single-owner (concurrent `send` reuse one runtime), epoch-guarded
(a `retire()` during an in-flight `send` discards the late result — no delivery is published), and bounded
(a `retire()` runs `stop()`+`dispose()` once and drops the reference). `OutboundSource` reports every
discarded config through `onRetire`, which `src/index.mjs` wires to `retireSenderRuntime`, so remove /
hot-replace releases the channel's token cache via the adapter's `disposeRuntime(resolved)` — no second copy
of the config, no leaked credential.

## Convergence status

Done in S1: `inbound:bindings`, `inbound:pending`, `inbound:migrated` (identity is the single
in-lock authority; last-owner enforced in-lock). Done in S2: `channel:<type>:outbound`
(outbound-config is the single in-transaction authority; migration is a one-shot projection).
Done in S5 (T11): inbound `<type>:account` scan onboarding now merges in-transaction
(`mergeDurable`), so the credential domain has one merge authority.
Not yet converged: `route:sessions` (T14).