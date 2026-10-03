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
  const listeners = new Map()
  let disposed = false
  const admit = type => {
    if (disposed) throw new Error("runtime manager disposed")
    if (!runtime.has(type) && runtime.size >= 128) throw new RangeError("runtime channel capacity reached")
  }
  const publish = (event) => {
    for (const listener of [...listeners.keys()]) {
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
  // Older configuration applies cannot overwrite newer revisions.
  const appliedRevision = new Map()
  // Only instance creation/replacement/retirement advances this fence.
  const epochs = new Map()
  const epochOf = (type) => epochs.get(String(type ?? '').trim()) ?? 0
  const update = (type, state, detail = {}) => {
    const key = String(type ?? '').trim()
    if (disposed) return copy(stateOf(key))
    admit(key)
    const { revision, generation, ...rest } = detail
    if (Number.isFinite(generation) && generation !== epochOf(key)) return copy(stateOf(key))
    const incoming = Number.isFinite(revision) ? Number(revision) : null
    if (incoming !== null) {
      const known = appliedRevision.get(key)
      if (known !== undefined && incoming < known) return copy(stateOf(key))
      appliedRevision.set(key, incoming)
    }
    const next = { generation: epochOf(key), state: STATES.has(state) ? state : 'failed', restartPending: state === 'failed', ...rest }
    runtime.set(key, next)
    publish({ topic: 'runtime', type: key, generation: epochOf(key), state: next.state, restartPending: next.restartPending })
    return next
  }

  return {
    // v0.14（P0-01）：snapshot()/get() 是给外部观察方的冻结投影；传输路径必须走
    // live()/liveEntries() 拿 adapter 私有运行时对象（可变，允许合法惰性缓存）。
    snapshot: () => source.snapshot(),
    liveEntries: () => (typeof source.liveEntries === 'function' ? source.liveEntries() : source.snapshot()),
    live: (type) => (typeof source.live === 'function' ? source.live(type) : source.get(type)),
    types: () => source.types(),
    has: (type) => stateOf(type).state === 'online' && source.has(type),
    get: (type) => source.get(type),
    replace(type, config) {
      type = String(type ?? "").trim(); admit(type)
      epochs.set(type, epochOf(type) + 1)
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
      type = String(type ?? "").trim(); admit(type)
      const removed = source.remove(type)
      // Retirement invalidates in-flight results even before another instance is created.
      epochs.set(type, epochOf(type) + 1)
      update(type, 'stopped', { restartPending: false })
      return removed
    },
    replaceAll(entries) {
      const keys = new Set([...runtime.keys(), ...entries.map(e => e.type)])
      if (disposed || keys.size > 128) throw new RangeError("runtime channel capacity reached")
      const value = source.replaceAll(entries)
      const live = new Set(value.map((entry) => entry.type))
      for (const type of live) { epochs.set(type, epochOf(type) + 1); update(type, 'online', { restartPending: false }) }
      for (const type of runtime.keys()) if (!live.has(type)) { epochs.set(type, epochOf(type) + 1); update(type, 'stopped', { restartPending: false }) }
      return value
    },
    runtimeState(type) {
      return copy(stateOf(type))
    },
    /** v0.15（Gate 2C）：发送开始时捕获不可变的 runtime 世代（不在结束时查询「当前」）。 */
    epochOf,
    capture(type) {
      const key = String(type ?? '').trim()
      const entry = typeof source.live === 'function' ? source.live(key) : source.get(key)
      return { entry, epoch: epochOf(key) }
    },
    setState(type, state, detail = {}) {
      return copy(update(type, state, detail))
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      if (disposed) return () => {}
      if (listeners.size >= 256) throw new RangeError("runtime observer capacity reached")
      if (listeners.has(listener)) return () => {}
      const stopSource = source.subscribe(event => { if (!disposed) listener(event) })
      listeners.set(listener, stopSource)
      return () => { const stop = listeners.get(listener); listeners.delete(listener); stop?.() }
    },
    dispose() {
      if (disposed) return
      for (const type of source.types()) this.remove(type)
      disposed = true
      for (const stop of listeners.values()) stop()
      listeners.clear()
    },
    get version() { return source.version },
  }
}
