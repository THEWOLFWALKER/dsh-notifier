// dsh-notifier host-events.mjs
// Narrow host-event compatibility boundary. DSH scopes event listeners by the
// context that registered them; host event subscriptions may therefore need the
// documented Cordis root context. This module never changes host filtering.

const MAX_COUNTER = 1_000_000_000

const isRecord = (value) => typeof value === 'object' && value !== null

const increment = (value) => value < MAX_COUNTER ? value + 1 : MAX_COUNTER

const safeRead = (object, key) => {
  try { return object?.[key] } catch { return undefined }
}

/**
 * Return an opaque scope-tag state without reading or logging the tag itself.
 * dsh-scope stores its inherited tag at Symbol('dsh.scope'); the symbol name is
 * public host implementation evidence while the tag is deliberately opaque.
 */
export function scopeDiagnosticOf(ctx) {
  let cursor = ctx
  const seen = new Set()
  for (let depth = 0; isRecord(cursor) && depth < 32 && !seen.has(cursor); depth += 1) {
    seen.add(cursor)
    let symbols
    try { symbols = Object.getOwnPropertySymbols(cursor) } catch { return 'uninspectable' }
    for (const symbol of symbols) {
      if (symbol.description !== 'dsh.scope') continue
      return safeRead(cursor, symbol) === undefined ? 'untagged' : 'tagged'
    }
    try { cursor = Object.getPrototypeOf(cursor) } catch { return 'uninspectable' }
  }
  return 'untagged'
}

/** Wrap one subscribable context; returns null when it cannot register. */
function contextCandidate(value, source) {
  if (!isRecord(value)) return null
  if (typeof safeRead(value, 'on') !== 'function') return null
  return { ctx: value, source, scope: scopeDiagnosticOf(value) }
}

/**
 * Preferred host-event subscription contexts. The plugin's *current* ctx is the
 * primary target (its own scope tag is the documented Cordis registration
 * identity); the self-referential Cordis `ctx.root` is only a fallback for a
 * current ctx that cannot register. Never both at once — a dual subscription
 * would deliver the same host event twice.
 */
function hostEventContexts(ctx) {
  const current = contextCandidate(ctx, 'current')
  const rootValue = safeRead(ctx, 'root')
  const validRoot =
    isRecord(rootValue)
    && rootValue !== ctx
    && safeRead(rootValue, 'root') === rootValue
  const root = validRoot ? contextCandidate(rootValue, 'root') : null
  return { current, root }
}

/**
 * Describe the *preferred* subscription target (current ctx, else documented
 * root ctx). This helper is diagnostics/back-compat only: it does not model the
 * registrar's sticky one-shot fallback, which is applied inside
 * `createHostEventRegistrar`.
 */
export function selectHostEventContext(ctx) {
  const { current, root } = hostEventContexts(ctx)
  return current ?? root ?? {
    ctx,
    source: 'current',
    scope: scopeDiagnosticOf(ctx),
  }
}

/** Normalizes only the documented tuple and one explicit envelope fallback. */
export function normalizeSessionEventArgs(args) {
  if (!Array.isArray(args)) return undefined
  const [first, second] = args
  if (args.length === 2 && isRecord(first) && isRecord(second) && typeof second.type === 'string') {
    return { session: first, event: second, shape: 'tuple' }
  }
  if (args.length === 1 && isRecord(first) && isRecord(first.session) && isRecord(first.event) && typeof first.event.type === 'string') {
    return { session: first.session, event: first.event, shape: 'envelope' }
  }
  return undefined
}

/** DSH documents lifecycle payloads as { agent }; direct agent is legacy-only. */
export function normalizeAgentLifecyclePayload(payload) {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.agent)) return payload.agent
  if (payload.id !== undefined || isRecord(payload.session)) return payload
  return undefined
}

/**
 * Safe, bounded host-event registration diagnostics. Snapshot values contain
 * counts and context states only; no session content, identifiers, or secrets.
 *
 * Subscription target is sticky: the registrar starts on the current ctx and,
 * if that ctx's FIRST registration throws, falls back once to the documented
 * self-referential `ctx.root` and uses it for every later event too. One
 * registrar therefore never mixes targets per event, so the top-level snapshot
 * `context` always names the context that actually registered. (`failures`
 * counts failed registration attempts, not a final failed state: a current
 * throw followed by a root success reports attempts=1, registered=1, failures=1.)
 */
export function createHostEventRegistrar(ctx, warn = () => {}, now = Date.now) {
  const contexts = hostEventContexts(ctx)
  let activeTarget = contexts.current ?? contexts.root ?? {
    ctx,
    source: 'current',
    scope: scopeDiagnosticOf(ctx),
  }
  const stats = new Map()
  const rowOf = (event) => {
    let row = stats.get(event)
    if (row === undefined) {
      row = { attempts: 0, registered: 0, failures: 0, received: 0 }
      stats.set(event, row)
    }
    return row
  }
  const report = (message) => {
    try { warn(message) } catch { /* diagnostics must not affect startup */ }
  }

  const subscribe = (candidate, event, wrapped, row) => {
    if (candidate === null || typeof safeRead(candidate.ctx, 'on') !== 'function') {
      row.failures = increment(row.failures)
      report(`宿主事件订阅失败: ${event}（无 ctx.on；context=${candidate?.source ?? 'none'}，scope=${candidate?.scope ?? 'unknown'}）`)
      return { ok: false, disposer: undefined }
    }
    try {
      // DSH publishes `session/event` through a scope carrier (dsh-scope
      // `scopeTarget`): an untagged listener is admitted globally, but a
      // TAGGED one only for the dispatch key or its ancestors. Registering on
      // the current ctx keeps this plugin's own scope identity, so a session
      // whose owner scope is unrelated to it silently loses every event — the
      // observable symptom is turn/start arriving while turn/end never does,
      // leaving `sessions.total` at 0 and sending no "task finished"
      // notification (upstream issue #16). `global: true` is the documented
      // Cordis option for "receive the event regardless of context filter
      // checks"; dsh-im subscribes to `session/event` the same way.
      const disposer = candidate.ctx.on(event, wrapped, { global: true })
      row.registered = increment(row.registered)
      report(`宿主事件订阅已注册: ${event}（context=${candidate.source}，scope=${candidate.scope}，global=true）`)
      return { ok: true, disposer: typeof disposer === 'function' ? disposer : undefined }
    } catch (error) {
      row.failures = increment(row.failures)
      report(`宿主事件订阅失败: ${event}（${error instanceof Error ? error.name : 'unknown'}；context=${candidate.source}，scope=${candidate.scope}）`)
      return { ok: false, disposer: undefined }
    }
  }

  return {
    on(event, listener) {
      const row = rowOf(event)
      row.attempts = increment(row.attempts)
      const wrapped = (...args) => {
        row.received = increment(row.received)
        try { row.lastAt = now() } catch { /* 时间源异常不吞宿主回调 */ }
        try { return listener(...args) } catch (error) {
          report(`宿主事件处理失败: ${event}（${error instanceof Error ? error.name : 'unknown'}）`)
          return undefined
        }
      }

      let result = subscribe(activeTarget, event, wrapped, row)
      if (!result.ok && activeTarget.source === 'current') {
        const fallback = contexts.root
        if (fallback !== null && fallback.ctx !== activeTarget.ctx) {
          const rootResult = subscribe(fallback, event, wrapped, row)
          if (rootResult.ok) {
            activeTarget = fallback
            result = rootResult
          }
        }
      }
      return result.disposer
    },
    snapshot() {
      const events = {}
      for (const [event, row] of stats) events[event] = { ...row }
      return { context: activeTarget.source, scope: activeTarget.scope, events }
    },
    reportZeroEvents() {
      for (const [event, row] of stats) {
        if (row.registered > 0 && row.received === 0) {
          report(`宿主事件未收到载荷: ${event}（attempts=${row.attempts}；context=${activeTarget.source}，scope=${activeTarget.scope}）`)
        }
      }
    },
  }
}
