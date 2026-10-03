// Single Host transport. Native daily actions are independent of the compatibility adapter.
import { createCompatibilityAdapter } from './compatibility-adapter.mjs'
export function createControlSurfaceService(options = {}) {
  const compatibility = createCompatibilityAdapter(options)
  return {
    async call(method, payload = {}, signal) {
      if (String(method).startsWith('native.')) {
        if (!options.native?.call) return { ok: false, error: { code: 'dsh-notifier/not-supported', message: '暂时无法操作，请重试', details: {} } }
        return options.native.call(method, payload, signal)
      }
      return compatibility.call(method, payload, signal)
    },
  }
}
