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
| `channel:<type>:outbound` | ⚠️ outbound-config **and** migration | `outbound-config` (save/apply) + `channel-config-migration` | **MULTI — T08 target** |
| `channel:<type>:inbound` / account keys | ⚠️ channel-config + channel adapters | `channel-config.mergeAccount` + `_feishu-register` + `_qq-scan` | **MULTI — T08 target** |
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
| outbound / inbound channel-config multi-writer | assigned to T08 | desired-vs-resolved divergence, lost sibling patch | T08 |

## Convergence status

Done in S1: `inbound:bindings`, `inbound:pending`, `inbound:migrated` (identity is the single
in-lock authority; last-owner enforced in-lock). Not yet converged: the three `MULTI` rows above.