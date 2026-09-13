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

/**
 * Use Cordis' documented root context for host-event subscriptions when the
 * plugin was mounted under a scoped child. This is a subscription-local
 * fallback, not a global listener option and not a host scope mutation.
 */
export function selectHostEventContext(ctx) {
  const root = safeRead(ctx, 'root')
  if (isRecord(root) && root !== ctx && safeRead(root, 'root') === root && typeof safeRead(root, 'on') === 'function') {
    return { ctx: root, source: 'root', scope: scopeDiagnosticOf(root) }
  }
  return { ctx, source: 'current', scope: scopeDiagnosticOf(ctx) }
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
 */
export function createHostEventRegistrar(ctx, warn = () => {}, now = Date.now) {
  const target = selectHostEventContext(ctx)
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

  return {
    on(event, listener) {
      const row = rowOf(event)
      row.attempts = increment(row.attempts)
      if (typeof safeRead(target.ctx, 'on') !== 'function') {
        row.failures = increment(row.failures)
        report(`宿主事件订阅失败: ${event}（无 ctx.on；context=${target.source}，scope=${target.scope}）`)
        return undefined
      }
      try {
        const disposer = target.ctx.on(event, (...args) => {
          row.received = increment(row.received)
          try { row.lastAt = now() } catch { /* 时间源异常不吞宿主回调 */ }
          try { return listener(...args) } catch (error) {
            report(`宿主事件处理失败: ${event}（${error instanceof Error ? error.name : 'unknown'}）`)
            return undefined
          }
        })
        row.registered = increment(row.registered)
        report(`宿主事件订阅已注册: ${event}（context=${target.source}，scope=${target.scope}）`)
        return typeof disposer === 'function' ? disposer : undefined
      } catch (error) {
        row.failures = increment(row.failures)
        report(`宿主事件订阅失败: ${event}（${error instanceof Error ? error.name : 'unknown'}；context=${target.source}，scope=${target.scope}）`)
        return undefined
      }
    },
    snapshot() {
      const events = {}
      for (const [event, row] of stats) events[event] = { ...row }
      return { context: target.source, scope: target.scope, events }
    },
    reportZeroEvents() {
      for (const [event, row] of stats) {
        if (row.registered > 0 && row.received === 0) {
          report(`宿主事件未收到载荷: ${event}（attempts=${row.attempts}；context=${target.source}，scope=${target.scope}）`)
        }
      }
    },
  }
}
