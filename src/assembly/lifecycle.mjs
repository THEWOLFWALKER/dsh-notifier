// Runtime lifecycle helpers shared by the plugin assembly.
//
// The host calls an effect disposer synchronously, while individual runtime
// components may return promises (long-pollers, HTTP servers, or event flushes).
// Keep that contract in one small defensive boundary: every disposer is best
// effort, and asynchronous cleanup is awaited without allowing one failure to
// block the remaining components.

/**
 * Dispose a collection of runtime resources using the host's effect contract.
 * @param {Iterable<() => unknown>} disposers
 * @returns {Promise<void>}
 */
export function disposeAll(disposers) {
  const cleanups = []
  for (const dispose of disposers ?? []) {
    try {
      const result = typeof dispose === 'function' ? dispose() : undefined
      if (result !== null && typeof result?.then === 'function') cleanups.push(result)
    } catch { /* 卸载失败不致命，其余资源继续收场 */ }
  }
  return Promise.allSettled(cleanups).then(() => undefined)
}
