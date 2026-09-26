// v0.13 runtime truth for outbound channels.
// Desired configuration is persisted by ChannelConfigService; this manager
// owns only the live apply/lifecycle state consumed by the Control Surface.

const STATES = new Set(['starting', 'online', 'degraded', 'failed', 'stopped'])
const copy = (value) => ({ ...(value ?? {}) })

export const RUNTIME_CHANNEL_STATES = Object.freeze([...STATES])

export function createRuntimeChannelManager({ source, initial = [] } = {}) {
  if (source === null || typeof source?.snapshot !== 'function') {
    throw new TypeError('runtime channel source is required')
  }
  const runtime = new Map()
  const listeners = new Set()
  const publish = (event) => {
    for (const listener of [...listeners]) {
      try { listener(Object.freeze({ ...event })) } catch { /* observer failures never alter runtime truth */ }
    }
  }
  for (const entry of source.snapshot()) {
    if (typeof entry?.type === 'string' && entry.type !== '') runtime.set(entry.type, { state: 'online', restartPending: false })
  }
  for (const entry of initial) {
    if (typeof entry?.type === 'string' && entry.type !== '' && !runtime.has(entry.type)) {
      runtime.set(entry.type, { state: 'stopped', restartPending: false })
    }
  }

  const stateOf = (type) => runtime.get(String(type ?? '').trim()) ?? { state: 'stopped', restartPending: false }
  const update = (type, state, detail = {}) => {
    const key = String(type ?? '').trim()
    const next = { state: STATES.has(state) ? state : 'failed', restartPending: state === 'failed', ...detail }
    runtime.set(key, next)
    publish({ topic: 'runtime', type: key, state: next.state, restartPending: next.restartPending })
    return next
  }

  return {
    snapshot: () => source.snapshot(),
    types: () => source.types(),
    has: (type) => stateOf(type).state === 'online' && source.has(type),
    get: (type) => source.get(type),
    replace(type, config) {
      update(type, 'starting', { restartPending: false })
      try {
        const value = source.replace(type, config)
        update(type, 'online', { restartPending: false })
        return value
      } catch (error) {
        update(type, 'failed', { error: error?.message ?? String(error) })
        throw error
      }
    },
    remove(type) {
      const removed = source.remove(type)
      update(type, 'stopped', { restartPending: false })
      return removed
    },
    replaceAll(entries) {
      const value = source.replaceAll(entries)
      const live = new Set(value.map((entry) => entry.type))
      for (const type of live) update(type, 'online', { restartPending: false })
      for (const type of runtime.keys()) if (!live.has(type)) update(type, 'stopped', { restartPending: false })
      return value
    },
    runtimeState(type) {
      return copy(stateOf(type))
    },
    setState(type, state, detail = {}) {
      return copy(update(type, state, detail))
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      const stopSource = source.subscribe(listener)
      return () => { listeners.delete(listener); stopSource() }
    },
    get version() { return source.version },
  }
}
