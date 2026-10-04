# Architecture

## Product and trust boundary

The plugin is private-chat only and Native-first. The standalone Admin Console, its HTTP API, browser UI, SSE event hub, scan handlers and recovery server have been removed. Native access is admitted by the DSH Host connection and restricted to an exact method allowlist. When Native is unavailable, operators use Host logs or offline state recovery; the plugin does not start an alternate listener.

Inbound business handling requires provider evidence for a private chat, a stable account ID and a complete `(channel, accountId, userId)` principal. Missing or unknown values fail closed. Pairing establishes identity; transport credentials and legacy YAML `allowUsers` do not grant access. Outbound private targets are account-scoped and provider-checked. Group sources and targets are rejected.

## Runtime assembly

`src/index.mjs` is the Cordis plugin assembly root. It resolves configuration, initializes the fresh-schema state store, loads canonical channel configuration, builds the notifier and wires optional services. Important authorities have one owner:

- `src/inbound/store.mjs` owns durable state and the one-time v0.15 offline backup/reset.
- `src/inbound/identity.mjs` owns paired principal identity.
- `src/inbound/bus.mjs` performs private admission, deduplication and inbound dispatch.
- `src/interaction/ledger.mjs` owns approval, action and question lifecycle transitions.
- `src/routing/current-task.mjs` owns explicit private-user task selection.
- `src/control-plane/` owns canonical channel, member, routing, question, portability and checked dsh-im operations.
- `src/native/` projects safe read models and exposes narrow Native actions.

Provider modules normalize events and implement transport-specific private-chat proof. Optional SDKs load only when their provider is explicitly enabled. Disposal is collected in reverse assembly order.

```text
DSH Host context
  -> config and fresh-schema store
  -> canonical channel sources and outbound notifier
  -> inbound provider transports
  -> private admission and identity
  -> approval / question / action / conversation consumers
  -> Native read model and narrow actions through Host RPC
```

## Delivery evidence

Public notification results distinguish provider acceptance, explicit confirmation, unknown outcomes, failures and skipped targets. `accepted` does not mean delivered. Unknown results are not retried automatically. Activity records contain metadata only and label uncertain outcomes clearly.

Cloud deployment restart reads and reconciles durable job state; it does not repeat external writes. A retry is an explicit user action. Failures before an external request are definite failures; failures after it starts may require recovery because the remote outcome can be unknown.

## Private-chat lifecycle

```text
provider event
  -> authenticate and establish private chat type
  -> require enabled channel, current generation and stable account identity
  -> resolve complete paired principal
  -> deduplicate and dispatch commands / approvals / questions / conversation
  -> recheck current generation before external actions
```

The fresh state begins in guided setup. Registration commands remain available in an explicitly enabled private chat; normal business messages remain denied until pairing succeeds. Pairing codes are hashed, short-lived, rate-limited and auditable. The bootstrap code is delivered through `<stateDir>/bootstrap-paircode.txt` with mode `0600`; logs carry only the path.

Callback and action tokens are single-use and source-scoped. Missing account, user, chat type or source evidence is a rejection; it does not consume a token or settle a waiter. Numbered question replies must match the target channel, account, user and private chat. Channel-wide delivery results do not prove a particular recipient received a message.

## Routing

Outbound resolution layers are session diff, exact agent ID, workspace entry and global enabled channel pool. `channels` and `quiet` resolve independently. Inbound resolution requires an explicit conversation binding, channel default or an unambiguous active workspace selection; an implicit latest-session fallback is not used for private task selection.

Persistent routing state is keyed by `route:agents`, `route:channels`, `route:sessions` and account-scoped `bind:*` records. Missing-account legacy records do not participate in the current principal model.

## Native control services

Native actions call shared control-plane authorities. They do not write state directly, and no legacy Admin adapter or second authorization path remains.

| Domain | Authority | Responsibility |
| --- | --- | --- |
| Outbound channels | `createChannelControlService` and `createOutboundConfigService` | Validate, durably save and apply canonical channel settings |
| Inbound credentials | inbound config port | Merge secret patches in one store transaction |
| Members and pairing | `createMembersControlService` | Pairing, member status and user removal |
| Routing | `createRoutingControlService` | Account-scoped route and binding state |
| Questions | `createQuestionsControlService` | Delegate settlement to Control Core |
| Diagnostics | `createDiagnosticsService` | Return a read-only, redacted support snapshot |
| Cloud deployment | `createCloudflareDeploymentService` | Persist jobs and require explicit retries after uncertain external effects |

The optional dsh-im bridge uses checked delivery interfaces from the fixed upstream contract. The dsh-im one-click config importer is intentionally out of scope for this rebuild.

## State and files

The shared state file is `<stateDir>/state.json` (default `$DSH_HOME/dsh-notifier/state.json`, then `~/.dsh/dsh-notifier/state.json`). The store uses detached reads, transactional writes, file and directory sync, bounded locks and corruption backups. A rename followed by failed directory sync is reported as an unknown commit outcome; callers must not blindly repeat external side effects.

On the first v0.15 startup, a mode-0600 offline backup is created before old keys are cleared and the fresh schema is committed. Backup or transaction failure fences access to the old state. Startup does not migrate old credentials, identities, private-chat permissions or routes into runtime.

Durable families have bounded retention or a reclamation path. In-process provider maps are capped and evict old observations. Eviction must fail closed for authorization and private target proofs.

## Extension boundaries

- Add fixed HTTP notification channels to `src/adapters/spec-channels.mjs` with a fixture; use a code adapter only for token exchange or multi-step control flow.
- Keep the adapter contract `resolve(cfg) -> resolved` and `send(resolved, msg) -> Promise`.
- Inbound providers must expose and validate private-chat evidence before dispatch. Unknown/group chat types and targets are rejected.
- Approval and question decisions stay in the shared Control Core. Notifications retain truthful text fallbacks where the provider supports them.
- Consumers use the injected `notifier` service and metadata-only `dsh-notifier/sent` event; they must not push from a sent-event handler.
- External SDKs remain optional and lazy-loaded; provider contract tests do not certify real-device behavior.
