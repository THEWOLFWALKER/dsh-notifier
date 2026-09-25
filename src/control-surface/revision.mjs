// dsh-notifier v0.12 — process-local revision stream for Native Control Surface.
// It is intentionally transport-agnostic. Connection RPC consumes wait().

// v0.12.1（P1-16）：waiter 全局上限。对齐 Admin SSE 的 64 口径，超限立即返回
// capacity，让客户端退避重试，而不是继续堆积 Promise、timer 与 abort listener。
const DEFAULT_MAX_WAITERS = 64

export function createSurfaceRevision({ now = Date.now, maxWaiters = DEFAULT_MAX_WAITERS } = {}) {
  const rawCap = Number(maxWaiters)
  const waiterCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.trunc(rawCap) : DEFAULT_MAX_WAITERS
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
    if (waiters.size >= waiterCap) {
      return Promise.resolve(Object.freeze({ revision, topic: 'capacity', at: now() }))
    }

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
    waiterCount: () => waiters.size,
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
