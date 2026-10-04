> Historical review baseline. The S1/S2 entries below are reconciled to the v0.15 source tree; this document is an inventory, while current implementation and tests are authoritative.

# State writer registry (v0.15 / T07)

Authority map for every persistent store key: who may write it, through which entry point, and the
current convergence verdict. Companion to `docs/developer/behavior-contract.md` and the T01 inventory in
`docs/developer/rebuild-v015/PLAN.md`.

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
| `inbound:bindings` | identity | identity: `writeBindings`, `mutateBinding` (add/remove/update), `confirmPending`, `startupCleanup` | **single** |
| `inbound:pending` | identity | identity: `addPending`, `dismissPending`, `confirmPending`, `readPending` sweep | **single** |

| `inbound:pairing` | pairing | pairing: `mint`, `revoke`, `redeem`, `redeemAndBind`, `sweep` | **single** (see deferral) |
| `inbound:pairing:lockout` | pairing | pairing: redeem failure recorder, `clearLockout` | **single** |
| `route:agents` | agent-router | `setAgentBinding` (CLI/Admin/router) | **single** |
| `route:channels` | agent-router | `setChannelDefault` | **single** |
| `route:sessions` | session-registry **and** agent-router (both inside one `store.transact()` draft) | `agent-router.commitSessions` + `session-registry.persist` (each reads the fresh base inside the same key transaction) | **single** (converged at T14: no writer commits a base read outside the transaction) |
| `channel:<type>:outbound` | outbound-config | `outbound-config` `save`/`remove` (single in-transaction merge) | **single** |
| `channel:<type>:inbound` / `<type>:account` | channel-config | `channel-config.mergeAccount` (in-transaction) + scan onboarding `_feishu-register` / `_qq-scan` (`mergeDurable`, in-transaction field merge) | **single** (converged at T11) |
| `aq:<id>` | questions router (business owner) | `interaction/ledger.mjs` on behalf of `questions/router.mjs` (narrow `add`/`settle`/`patchMetadata`) | single |
| approval rows | approval router (business owner) | `interaction/ledger.mjs` on behalf of `approval/router.mjs` | single |
| action rows | actions (business owner) | `interaction/ledger.mjs` on behalf of `actions.mjs` | single |
| interaction ledger rows | interaction ledger | `interaction/ledger.mjs` | single |
| inbound dedup rows | inbound bus | `inbound/bus.mjs` (fail-closed on durable failure) | single |
| conversation bindings (`bind:<channel>:<accountId>:<userId>`) | routing current-task | `routing/current-task.mjs` (conversation `/bind`, `/use`, `/agent use` all route through it) | single |
| `cloud:job:<id>` | Cloud deployment | `cloudflare/deployment.mjs` durable claim, checkpoint, receipt, completion and startup sweep | single; no secret values |
| `cloudflare:deployment:<type>` | Cloud deployment | `cloudflare/deployment.mjs`; references canonical channel secret | single |
| `taskselect:*` | routing | `task-selection.mjs` | single |
| `tg:offset` | telegram-bot | `inbound/telegram-bot.mjs` | single |
| `wechat:sync_buf` / ctx token | wechat legacy-core | `channels/wechat-ilink/legacy-core.mjs` | single |
| `dingtalk:robot-code` | dingtalk-stream | `inbound/dingtalk-stream.mjs` | single |
| `wxpusher:webhookPath` | assembly | `assembly/inbound-signals.mjs` | single |
| `wxpusher:bind:<uid>` | wxpusher-callback | `inbound/wxpusher-callback.mjs` | single |


| `portability:staged:<direction>:<type>` | config-portability | `config-portability.mjs` `commitImport` (new channels only, in one transaction) | **single** (inert: assembly never reads this key domain; a staged entry is never active) |

### Hidden / secondary writers (registered, not a separate authority)

- **startup cleanup** — `identity.startupCleanup` rewrites `inbound:bindings` to drop dead keys;
  only on dead-key presence (zero write amplification otherwise). YAML and legacy binds never seed identities.
- **read-path sweep** — `identity.readPending` and `pairing.sweep` prune expired entries on read and
  write back; bounded, idempotent.
- **CLI** — `scripts/route.mjs` (`route.mjs set`, `... forget`) reaches `route:agents` /
  `route:channels` / `route:sessions` **through agent-router**, never via a raw key write.
- **Native adapter** — Native RPC mutates members/pairing/sessions through shared control-plane services.
- **dispose / teardown** — no key is written on dispose; teardown only releases listeners and locks.

## Deferrals recorded at T07

| Item | Why deferred | Risk | Next action |
|---|---|---|---|
| `inbound:pairing` `mint` / `revoke` still read-modify-write via `writeCodes` (two writes; `sweep` itself nests a `writeCodes`) | inlining `sweep` into one transaction without a nested `transact` needs a non-writing `sweepInTable` variant first | concurrent admin mint/revoke can lose one code entry; redeem path is already atomic | T06 follow-up: extract `sweepInTable` (no write) and run mint/revoke under `transactOutcome` |
| `route:sessions` multi-writer (router ↔ session-registry) | assigned to T14 | same-key lost update across the two writers | **resolved at T14**: `session-registry.persist` now reads the fresh base inside the same `store.transact()` mutator as `agent-router.commitSessions`, so the two writers serialize on the store lock and preserve each other's sibling fields |
| inbound `<type>:account` scan onboarding (`_feishu-register` / `_qq-scan`) wrote a whole object via `setDurable` while the port merged in-transaction | assigned to T11 | concurrent scan + manual `put` could drop a sibling field (feishu/qq write the same two fields today; low blast radius) | **resolved at T11**: scan commits now go through `mergeDurable` (in-transaction field merge); see the T11 row in `core-distillation-v015.md` |

## Outbound config layers (T08)

`channel:<type>:outbound` has exactly three layers, and only the first is persisted:

| Layer | What | Where | Mutability |
|---|---|---|---|
| **desired** | YAML base + canonical overlay (`rawOf`) | store key `channel:<type>:outbound` + YAML rows | persisted; returned by `raw()` as a deep clone |
| **resolved** | `adapter.resolve(desired)` output | live entry in `OutboundSource` | adapter owns it; **not** frozen (legal lazy caches) |
| **resources** | adapter-private `_`/`__` runtime fields (`_tokenManager`, `_msgSeq`, …) | on the live resolved object | Mutable, kept across sends; **stripped** from every projection |
| projection | `snapshot()` / `get()` copy | external observers (Native, Support Report) | deep-frozen, no reference sharing with live |

Precedence (outbound): `channel:<type>:outbound` canonical overlay → YAML base. Admin-legacy tiers and migration reads were retired. Secrets: patch keeps existing unless replaced; explicit `clear`/`null` removes and is rejected for public fields. Remove deletes the canonical overlay; YAML bootstrap is not deletable.

Runtime truth has one owner (`RuntimeChannelManager`). Its lifecycle updates carry a **monotonic revision fence**: a stale (older `source.version`) apply result can never override a newer runtime state (T08 / C03).

The **resources** layer has one lifecycle owner too (T10): the per-`resolved` sender runtime
(`src/adapters/sender.mjs`). It is created single-owner (concurrent `send` reuse one runtime), epoch-guarded
(a `retire()` during an in-flight `send` discards the late result — no delivery is published), and bounded
(a `retire()` runs `stop()`+`dispose()` once and drops the reference). `OutboundSource` reports every
discarded config through `onRetire`, which `src/index.mjs` wires to `retireSenderRuntime`, so remove /
hot-replace releases the channel's token cache via the adapter's `disposeRuntime(resolved)` — no second copy
of the config, no leaked credential.

## Writer fitness allowlist (T17)

This block *is* the machine-checked allowlist consumed by
`test/v015-stage-s11-writer-fitness.test.mjs`. Every module that touches the durable-store write
surface (`setDurable` / `mergeDurable` / `transactDurable` / `deleteDurable` / `transactOutcome` /
`store.transact` / `store.sweepPrefix`) must appear here, and no row may linger after its writer is
removed. `src/inbound/store.mjs` is the only module allowed to call the raw `store.set` /
`store.delete`.

<!-- writer-fitness:allowlist -->
| Module | Owns |
|---|---|
| `src/inbound/store.mjs` | store primitives |
| `src/index.mjs` | composition root / reset |
| `src/assembly/inbound-signals.mjs` | wxpusher webhook path |
| `src/channels/wechat-ilink/index.mjs` | legacy-core composition |
| `src/channels/wechat-ilink/legacy-core.mjs` | wechat sync buffer/context token |
| `src/control-surface/outbound-config.mjs` | canonical outbound config |
| `src/cloudflare/tunnel.mjs` | Cloudflare tunnel config |
| `src/cloudflare/deployment.mjs` | Cloudflare deployment state |
| `src/control-plane/config-portability.mjs` | inert staged imports |
| `src/inbound/_feishu-register.mjs` | Feishu scan account merge |
| `src/inbound/_qq-scan.mjs` | QQ scan account merge |
| `src/inbound/bus.mjs` | inbound dedup |
| `src/inbound/channel-config.mjs` | inbound/account channel config |
| `src/inbound/dingtalk-stream.mjs` | DingTalk robot code |
| `src/inbound/identity.mjs` | identity bindings and pending |
| `src/inbound/pairing.mjs` | pairing and lockout |
| `src/inbound/telegram-bot.mjs` | Telegram offset |
| `src/inbound/wxpusher-callback.mjs` | WxPusher learned binding |
| `src/interaction/ledger.mjs` | interaction ledger rows |
| `src/routing/agent-router.mjs` | route agents/channels/sessions |
| `src/routing/current-task.mjs` | account-scoped conversation bindings |
| `src/routing/session-registry.mjs` | route sessions |
| `src/routing/task-selection.mjs` | task selection |
<!-- /writer-fitness:allowlist -->

## Convergence status

Done in S1: `inbound:bindings` and `inbound:pending` (identity is the single in-lock authority; last-owner enforced in-lock). Done in S2: `channel:<type>:outbound` (outbound-config is the only in-transaction authority; YAML authorization migration and legacy overlays are retired).
Done in S5 (T11): inbound `<type>:account` scan onboarding now merges in-transaction
(`mergeDurable`), so the credential domain has one merge authority.
Done in S3 (T14): `route:sessions` — the session-registry lifecycle write and the agent-router
outbound/control override write both read the fresh base inside the same `store.transact()` mutator,
so the two writers serialize on the store lock and preserve each other's sibling fields (no writer
commits a base read taken outside the transaction).
All registered multi-owner keys are now converged; the remaining `inbound:pairing` `mint`/`revoke`
deferral is a pending follow-up, not a second authority.
