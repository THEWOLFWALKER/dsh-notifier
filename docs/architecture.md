# Architecture

## Runtime Shape

`src/index.mjs` is the Cordis plugin assembly root. It resolves configuration, creates the shared state store, overlays admin-managed credentials when enabled, builds the notifier, and then wires optional services. Disposal is collected and executed in reverse assembly order.

```text
Cordis context
  -> config.mjs
  -> store / ledger / routing registry
  -> createNotifier (adapters + level routing + segmentation + retry)
  -> event-listener (automatic events + turn tracker)
  -> tools (notify, notify_test, ask_user)
  -> inbound identity/pairing/bus/token stack
  -> approval/actions/questions/conversation bridges
  -> admin API/UI/SSE and scan handlers
```

## Outbound Flow

1. `resolveConfig()` validates rows, resolves `${ENV:NAME}`, and skips invalid channels without aborting startup.
2. `createNotifier()` normalizes messages and resolves level routing.
3. `routeTargets()` selects enabled channel instances; optional agent/session routing filters the result.
4. `sendSegmented()` splits long Unicode text. A partial segmented failure is marked `noRetry` so already delivered pieces are not replayed.
5. Retry policy is level-dependent: time-sensitive retries most, active retries once, passive does not retry by default.
6. Broadcast outcomes feed the ledger, admin event hub, and optional `dsh-notifier/sent` emission independently.

## Inbound Trust Flow

```text
provider payload
  -> normalizeInbound / channel-specific authentication
  -> inbound bus deduplication
  -> identity allows(channel, userId)
  -> command / approval / question / conversation consumer
  -> token or trusted reply validation
  -> first-arrival settlement
  -> agent action or desktop fallback
```

The empty identity table is a guided bootstrap state: registration commands remain available, while normal business messages remain denied until pairing succeeds. Pairing codes are hashed, short-lived, rate-limited, and auditable. Callback/action/question tokens are single-use and source-scoped when a source chat is recorded.

## Routing

Outbound resolution layers are, in order: session diff, exact agent id, workspace entry, global enabled channel pool. `channels` and `quiet` are resolved independently. Inbound resolution uses explicit conversation binding, channel default, unique active agent, then latest active session.

Persistent route keys are `route:agents`, `route:channels`, `route:sessions`, and `bind:*` compatibility records. The route CLI and admin API use the same router setters; they must not write these tables directly.

## State And Files

The shared file is `<stateDir>/state.json` (default `$DSH_HOME/dsh-notifier/state.json`, then `~/.dsh/dsh-notifier/state.json`). The store uses dirty-key merge, a lock file, mtime convergence reads, 0600 best effort permissions, and corruption backup before self-healing.

Other durable files include `ledger.jsonl`, `ledger-state.json`, and `admin-audit.jsonl` in the same state directory when those features are enabled. Credentials are masked in admin responses and must never be copied into docs, tests, or logs.

## Admin Boundary

The server is a zero-dependency `node:http` wrapper around `admin/api.mjs`. It is loopback-only, requires `Authorization: Bearer`, caps request bodies at 1 MiB, caps SSE connections, and maps business errors to safe status/message responses. The UI is embedded in `src/admin/ui.mjs`; the API and CLI share the same router/store semantics.

## Extension Boundaries

- Add fixed HTTP notification channels to `src/adapters/spec-channels.mjs` plus a fixture; use a code adapter only for token exchange or multi-step control flow.
- Keep the adapter contract `resolve(cfg) -> resolved` and `send(resolved, msg) -> Promise`.
- Inbound channels implement the shared contract and may expose optional action/question card methods; callers must always retain text/number fallbacks.
- Other plugins consume the injected `notifier` service and `dsh-notifier/sent` event; they must declare static injection and must not push from a sent-event handler.
