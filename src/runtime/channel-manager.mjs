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
  // v0.15（T08 / C03）：runtime truth 的**单调栅栏**。每个 lifecycle 更新可带一个 config
  // revision（`channel:<type>:outbound` 的 `source.version`）。同一 type 上，携带更旧 revision
  // 的迟到 apply 结果绝不允许覆盖已更新的 runtime 状态——否则一次被 N+1 超越的旧 apply 迟到
  // 落地，会把已经生效的新配置在观察面上打回旧态。栅栏只比较 revision，不写进状态对象
  // （runtimeState 形状保持 `{state, restartPending, ...detail}` 不变）。
  const appliedRevision = new Map()
  // v0.15（Gate 2C）：每 type 的 runtime **实例世代**。发送开始时 `capture()` 的 epoch 随
  // audit record 交给健康面；换实例后旧 epoch 的迟到观察一律不计入当前健康（但账本/调用
  // 结果本身保留）。与 publish 一一对应，故与 surfaceHealth 的 markEpoch 保持同步。
  const epochs = new Map()
  const epochOf = (type) => epochs.get(String(type ?? '').trim()) ?? 0
  const update = (type, state, detail = {}) => {
    const key = String(type ?? '').trim()
    const { revision, ...rest } = detail
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
      const removed = source.remove(type)
      // Retirement invalidates in-flight results even before another instance is created.
      epochs.set(type, epochOf(type) + 1)
      update(type, 'stopped', { restartPending: false })
      return removed
    },
    replaceAll(entries) {
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
      listeners.add(listener)
      const stopSource = source.subscribe(listener)
      return () => { listeners.delete(listener); stopSource() }
    },
    get version() { return source.version },
  }
}
