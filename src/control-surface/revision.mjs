// dsh-notifier v0.12 — process-local revision stream for Native Control Surface.
// It is intentionally transport-agnostic. Connection RPC consumes wait().

export function createSurfaceRevision({ now = Date.now } = {}) {
  let revision = 1
  let disposed = false
  let last = Object.freeze({ revision, topic: 'boot', at: now() })
  const waiters = new Set()

  const settleWaiter = (waiter, value) => {
    if (!waiters.delete(waiter)) return
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort)
    try { waiter.resolve(value) } catch { /* promise resolver cannot alter revision state */ }
  }

  const touch = (topic = 'unknown') => {
    if (disposed) return last
    revision += 1
    last = Object.freeze({ revision, topic: String(topic || 'unknown'), at: now() })
    for (const waiter of [...waiters]) settleWaiter(waiter, last)
    return last
  }

  const wait = ({ after = 0, timeoutMs = 25_000, signal } = {}) => {
    const cursor = Number.isFinite(Number(after)) ? Number(after) : 0
    if (disposed || revision > cursor) return Promise.resolve(last)
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: null, onAbort: null }
      waiter.onAbort = () => {
        if (!waiters.delete(waiter)) return
        clearTimeout(waiter.timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      waiter.timer = setTimeout(() => settleWaiter(waiter, Object.freeze({
        revision,
        topic: 'timeout',
        at: now(),
      })), Math.max(1_000, Math.min(30_000, Number(timeoutMs) || 25_000)))
      waiter.timer.unref?.()
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true })
      waiters.add(waiter)
    })
  }

  return {
    current: () => last,
    touch,
    wait,
    dispose() {
      if (disposed) return
      disposed = true
      for (const waiter of [...waiters]) settleWaiter(waiter, Object.freeze({
        revision,
        topic: 'disposed',
        at: now(),
      }))
    },
  }
}
