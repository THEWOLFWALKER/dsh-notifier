// Single Host transport with method-level authority.
//
// Stage 4（S402/S405）：daily control-surface 现在有**显式方法白名单**——Native 窄动作表走 Native
// service，允许的 secondary 用户功能走 secondary service，其余（旧 sessions.*/bindings.*/members.*/
// pairing.*/channels.*/tasks.list/questions.*/surface.home 等）一律 `not-supported`。
// 不再存在「巨型 compatibility switch 的默认分支」把 legacy endpoint 泄漏给已 admitted 客户端。
import { createSecondarySurfaceService } from './secondary-service.mjs'
import { isDailyAllowedMethod } from './surface-allowlist.mjs'

const notSupported = (message) => ({
  ok: false,
  error: { code: 'dsh-notifier/not-supported', message, details: {} },
})

export function createControlSurfaceService(options = {}) {
  const secondary = createSecondarySurfaceService(options)
  return {
    async call(method, payload = {}, signal) {
      const name = String(method)
      if (name.startsWith('native.')) {
        if (!options.native?.call) return notSupported('暂时无法操作，请重试')
        return options.native.call(name, payload, signal)
      }
      // method-level authority：不在 daily allowlist 的方法直接判定为「能力不存在」，
      // 绝不触达任何 legacy 写入实现。
      if (!isDailyAllowedMethod(name)) return notSupported(`不支持的方法 "${name}"`)
      return secondary.call(name, payload, signal)
    },
  }
}
