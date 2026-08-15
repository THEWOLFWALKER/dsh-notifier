// dsh-notifier inbound/_breaker.mjs
// 通用限流熔断器（v0.3.0 阶段 4）：计数窗口 + 开路时长，时钟可注入（测试零等待）。
// 语义（对照 Hermes weixin.py 2026-08-06 生产调优参数移植）：
//  - trip()：在 windowMs 滑动窗口内记录一次失败；累计 ≥ threshold → 开路 openMs
//    （开路期间所有发送短路失败，避免长任务最终回复被静默吞掉的那类连锁风暴）
//  - reset()：任一成功（或收到任一入站消息——新消息即解锁配额）清零并合闸
//  - isOpen()：开路剩余时间内 true；到期自动半开（放行下一次真实请求）
// 零依赖红线：只有注入的 now()，默认 Date.now。

/** 数值选项：undefined/null 回落默认，其余 Number 化后夹到下限（显式 0 不被吞）。 */
function clampOption(value, fallback, min) {
  if (value === undefined || value === null) return fallback
  const num = Number(value)
  return Math.max(min, Number.isFinite(num) ? num : fallback)
}

/**
 * @param {object} [options]
 * @param {number} [options.threshold=3] - 窗口内失败几次开路
 * @param {number} [options.windowMs=60000] - 计数滑动窗口
 * @param {number} [options.openMs=15000] - 开路时长（到点自动放行试探）
 * @param {() => number} [options.now] - 时钟注入（测试用，默认 Date.now）
 */
export function createBreaker(options = {}) {
  const threshold = clampOption(options.threshold, 3, 1)
  const windowMs = clampOption(options.windowMs, 60000, 1000)
  const openMs = clampOption(options.openMs, 15000, 0)
  const now = typeof options.now === 'function' ? options.now : Date.now

  let events = []
  let openUntil = 0

  return {
    /** 记录一次失败；返回 true = 本次调用后处于开路状态。 */
    trip() {
      const at = now()
      events = events.filter((ts) => ts >= at - windowMs)
      events.push(at)
      if (events.length >= threshold) {
        openUntil = Math.max(openUntil, at + openMs)
        return true
      }
      return false
    },

    /** 清零并合闸（发送成功 / 收到入站消息时调用）。 */
    reset() {
      events = []
      openUntil = 0
    },

    /** 是否开路（开路期满自动回落 false = 半开放行试探）。 */
    isOpen() {
      return now() < openUntil
    },

    /** 开路剩余毫秒（合闸为 0；诊断用）。 */
    remainingMs() {
      return Math.max(0, openUntil - now())
    },

    /** 当前窗口内失败次数（诊断用）。 */
    failures() {
      const at = now()
      return events.filter((ts) => ts >= at - windowMs).length
    },
  }
}
