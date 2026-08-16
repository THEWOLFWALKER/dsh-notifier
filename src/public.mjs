// dsh-notifier public.mjs（v0.6 设计稿 §2/§3）
// 开放事件源的双面：出向 ctx.notifier 服务注入（facade）+ 入向 dsh-notifier/sent 事件装配件。
//
// 军规（设计稿附录审查记录）：
//  - never-reject：push 内部任何异常都吞掉并返回 failed:[{reason:'internal'}]，消费方不写 try-catch 也不崩。
//  - no-op stub：notifier=null（public.enabled:false / 顶层禁用）时 push 返回 skipped:['(disabled)']。
//  - 长度钳制：title/content 各 20000 码点，超出截断 + warn（防消费方 bug 推超长文本引发分段风暴）。
//  - 限流淘汰即窗口归零：被逐源必须 warn（轮换 sourceName 绕限流的成本显性化）。
// 宿主语义依据：2026-08-16 真机 spike（DSH 0.1.0-rc.6 / cordis）——服务注册必须 ctx.provide()，
// 直接赋值被宿主拦截；消费方 inject 声明在服务缺失时会阻塞宿主启动 → 我们任何形态下都提供（stub 兜底）。

import { createRateLimiter } from './tool-register.mjs'

/** 公共面版本。只在公共面 breaking 时 bump，不与包版本联动（审查 D2：消费方做能力探测，不做相等比较）。 */
export const PUBLIC_API_VERSION = '0.6'

/** title/content 各自的码点上限（v0.6 设计稿 §2.2：防分段风暴）。 */
const CLAMP_CODEPOINTS = 20_000
/** 按源限流表容量：超限淘汰最旧源（防表泄漏；淘汰会 warn——窗口归零是安全代价）。 */
const MAX_SOURCES = 32
/** 合法分级（非法值丢弃，交给 normalizeMessage 兜底 active）。 */
const LEVELS = new Set(['timeSensitive', 'active', 'passive'])

/**
 * 递归冻结纯 JSON 形状的值（record/message/数组及元素逐层冻结，审查 D1）。
 * 防御：非普通对象/函数不动，环引用走 WeakSet 短路；任何异常原值返回（冻结失败不致命）。
 */
export function deepFreeze(value, seen = new WeakSet()) {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return typeof value === 'function' ? value : Object.freeze(value)
    }
    if (seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item, seen)
      return Object.freeze(value)
    }
    if (typeof value === 'function') return value
    // 宿主对象（Date 等）只浅冻结键位，不递归原型链
    for (const key of Object.keys(value)) deepFreeze(value[key], seen)
    return Object.freeze(value)
  } catch {
    return value
  }
}

/**
 * onSend 组合器（设计稿 §3.4）：过滤空项后逐个 try-catch 调用——任一挂载点（账本/hub/emit）
 * 异常不拖累其余。全空返回 undefined，保持 v0.5「digest 关 + admin 关 → onSend=undefined」
 * 的边界语义（notify.mjs 的 typeof 守卫无感，存量行为等价）。
 * @returns {((record: object) => void) | undefined}
 */
export function composeOnSend(fns) {
  const handlers = (Array.isArray(fns) ? fns : []).filter((fn) => typeof fn === 'function')
  if (handlers.length === 0) return undefined
  return (record) => {
    for (const handler of handlers) {
      try { handler(record) } catch { /* 单挂载点失败不拖累其余（结构保证，不靠实现细节） */ }
    }
  }
}

/** 码点安全的截断（slice 按码点而非 UTF-16 单元，防表情符号被拦腰截断）。 */
function clampText(value, warn) {
  if (typeof value !== 'string') return ''
  const chars = Array.from(value)
  if (chars.length <= CLAMP_CODEPOINTS) return value
  warn(`公共面推送文本超长（${chars.length} 码点 > ${CLAMP_CODEPOINTS}），已截断`)
  return chars.slice(0, CLAMP_CODEPOINTS).join('')
}

/**
 * 创建对外开放面（设计稿 §2.2）。
 * @param {object} [options]
 * @param {object|null} [options.notifier] - createNotifier 实例；null = no-op stub。
 * @param {object} [options.config] - resolved.public（enabled/limitPerMinutePerSource/emit）。
 * @param {object|null} [options.logger] - 宿主 logger（缺省静默）。
 * @param {(record: object) => void} [options.sink] - 限流拦截时的直落点（index 装配：账本 + emit）。
 * @param {() => number} [options.now] - 时钟注入（测试用）。
 */
export function createPublicFacade({ notifier = null, config = {}, logger = null, sink = null, now = Date.now } = {}) {
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }
  const limitPerMinute = Number.isFinite(Number(config?.limitPerMinutePerSource)) && Number(config.limitPerMinutePerSource) >= 0
    ? Math.trunc(Number(config.limitPerMinutePerSource))
    : 10
  const limiters = new Map() // sourceName → limiter（anonymous 表外常驻，见 limiterOf）
  let anonymousLimiter = null

  const limiterOf = (sourceName) => {
    if (sourceName === 'anonymous') {
      // anonymous 常驻表外：不参与 LRU 淘汰（审查 S5），所有匿名调用共享单窗
      anonymousLimiter ??= createRateLimiter({ limitPerMinute, now })
      return anonymousLimiter
    }
    let limiter = limiters.get(sourceName)
    if (limiter !== undefined) return limiter
    if (limiters.size >= MAX_SOURCES) {
      const oldest = limiters.keys().next().value
      limiters.delete(oldest)
      warn(`按源限流表已满（${MAX_SOURCES}），淘汰最旧源 "${oldest}"（其限流窗口归零）`)
    }
    limiter = createRateLimiter({ limitPerMinute, now })
    limiters.set(sourceName, limiter)
    return limiter
  }

  const normalizeSourceName = (value) => {
    if (typeof value !== 'string') return 'anonymous'
    const trimmed = value.trim()
    return trimmed === '' ? 'anonymous' : trimmed.slice(0, 64)
  }

  const adaptSingle = (result, source) => {
    // 单渠道路径形状适配（设计稿 §2.2 第 5 步）：channelResult → outcome 形状。
    // 注意（§3.3 矩阵）：单渠道不进账本、不发 sent 事件——定向推送仅凭返回值知晓结果。
    if (result?.skipped === true) {
      return { ok: false, delivered: [], skipped: [`(${result.channel ?? 'channel'})`], failed: [], source }
    }
    if (result?.ok === true) {
      return { ok: true, delivered: [result.channel], skipped: [], failed: [], source }
    }
    return {
      ok: false,
      delivered: [],
      skipped: [],
      failed: [{ channel: result?.channel, error: result?.error instanceof Error ? result.error.message : String(result?.error ?? 'unknown') }],
      source,
    }
  }

  return {
    version: PUBLIC_API_VERSION,

    /** 服务可用性：notifier 存在且 public 未显式关闭（stub 形态恒 false）。 */
    enabled: () => notifier !== null && notifier !== undefined,

    /** 广播 / 定向推送。永不 reject（never-reject 军规）。 */
    async push(rawMsg = {}, rawOptions = {}) {
      const msg = (rawMsg !== null && typeof rawMsg === 'object') ? rawMsg : {}
      const options = (rawOptions !== null && typeof rawOptions === 'object') ? rawOptions : {}
      const sourceName = normalizeSourceName(options.sourceName)
      const source = { kind: 'plugin', name: sourceName }
      try {
        const title = clampText(msg.title, warn)
        const content = clampText(msg.content, warn)
        if (title === '' && content === '') {
          // 双空 = 调用方错误：不推、不记账、不 emit、不占限流名额（返回值可见）
          return { ok: false, delivered: [], skipped: ['(malformed)'], failed: [], source }
        }
        if (notifier === null || notifier === undefined) {
          return { ok: false, delivered: [], skipped: ['(disabled)'], failed: [], source }
        }
        if (limitPerMinute > 0 && !limiterOf(sourceName).allow()) {
          // 静音不等于没发生：限流拦截照落账 + 照 emit（消费方能感知自己被限，设计稿 §3.3）
          const record = {
            time: new Date(now()).toISOString(),
            message: { title, content, level: typeof msg.level === 'string' && LEVELS.has(msg.level) ? msg.level : undefined },
            ok: false,
            delivered: [],
            skipped: ['(rate-limited)'],
            failed: [],
            source,
          }
          try { sink?.(record) } catch { /* sink 失败不致命 */ }
          return { ...record }
        }
        const normalized = {
          title,
          content,
          level: typeof msg.level === 'string' && LEVELS.has(msg.level) ? msg.level : undefined,
          group: typeof msg.group === 'string' ? msg.group : undefined,
        }
        if (typeof options.channel === 'string' && options.channel.trim() !== '') {
          return adaptSingle(await notifier.notify(options.channel.trim(), normalized), source)
        }
        const outcome = await notifier.notifyAll(normalized, { source })
        return { ...outcome, source }
      } catch (error) {
        // never-reject（审查 S3）：内部异常吞掉，消费方无 try-catch 也不崩
        warn(`公共面 push 内部异常: ${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, delivered: [], skipped: [], failed: [{ reason: 'internal' }], source }
      }
    },

    /** 等待在途送达（幂等；stub 形态即 resolve）。消费方 dispose 前调用。 */
    async flush() {
      try { await notifier?.flush?.() } catch { /* flush 失败不致命 */ }
      return { ok: true }
    },

    dispose() {
      limiters.clear()
      anonymousLimiter = null
    },
  }
}
