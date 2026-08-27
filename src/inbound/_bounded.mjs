// dsh-notifier inbound/_bounded.mjs
// v0.8.7 P1-7（宪法#4「状态必须有界」）：入站通道进程内「学习表」的统一上界工具。
//
// 背景：钉钉 sessionWebhooks/chatSenders、QQ targetKinds/msgSeqs 等表以 chatId 为键
// 只增不减——群/单聊数量由外部决定，长跑进程（或被陌生会话灌水）内存单调膨胀。
// 既有先例：bus.mjs 的 fifo/replyThrottle（cap + 淘汰最旧）、callback-refs.mjs 的
// DEFAULT_MAX、turn-tracker 的 MAX_TRACKED。本文件把同一模式收成一处，避免各通道抄歪。
//
// 语义：Map 迭代序 = 插入序 ⇒ 「最旧」= 迭代首个。写已存在的键先 delete 再 set
// （更新即刷新新鲜度 = LRU 触摸），确保活跃会话不会因为「首次学习早」被优先淘汰。
// 军规：淘汰是可观测的降级（宪法#3），调用方传 onEvict 落 warn（自行节流，防日志洪水）。

export const DEFAULT_MAP_MAX = 1024

/**
 * 有界写入：超上限即从最旧一端淘汰，保证写后 size <= max。
 * @param {Map} map - 目标表
 * @param {*} key
 * @param {*} value
 * @param {number} [max=1024] - 容量上限（非法值回落默认；下限 1）
 * @param {(evictedKey: *, evictedValue: *) => void} [onEvict] - 淘汰回调（异常被吞）
 * @returns {number} 本次淘汰的条目数
 */
export function setBounded(map, key, value, max = DEFAULT_MAP_MAX, onEvict = undefined) {
  const cap = Math.max(1, Math.trunc(Number(max)) || DEFAULT_MAP_MAX)
  let evicted = 0
  if (map.has(key)) {
    map.delete(key) // LRU 触摸：更新过的键移到最新一端
  } else {
    // while 而非 if：上限被调小 / 历史遗留超量时也能收敛到 cap
    while (map.size + 1 > cap) {
      // 空转护栏走迭代器的 done 而非「值 === undefined」：后者会把**键本身就是
      // `undefined`** 的表当成空表 break 掉，淘汰停摆、表越过 cap 无界涨——正是本
      // 模块要防的事（自审发现；当前调用方全部 String() 归一故未触发，但护栏不能
      // 自带漏洞）。cap >= 1 时 size+1 > cap ⇒ size >= 1，done 只在真空表为真。
      const oldest = map.keys().next()
      if (oldest.done === true) break
      const oldestKey = oldest.value
      const oldestValue = map.get(oldestKey)
      map.delete(oldestKey)
      evicted += 1
      if (typeof onEvict === 'function') {
        try { onEvict(oldestKey, oldestValue) } catch { /* 淘汰回调异常绝不致命 */ }
      }
    }
  }
  map.set(key, value)
  return evicted
}

/**
 * 造一个按时间节流的 warn（淘汰/拒绝这类高频降级用；窗口内累计次数随下次 warn 一并报出）。
 * @param {(message: string) => void} warn - 底层 warn（通道自带的双写 stderr 版）
 * @param {object} [options]
 * @param {number} [options.intervalMs=60000] - 最小 warn 间隔
 * @param {() => number} [options.now=Date.now] - 时钟注入（测试）
 * @returns {(compose: (count: number) => string) => void}
 */
export function createThrottledWarn(warn, { intervalMs = 60000, now = Date.now } = {}) {
  const gap = Math.max(0, Number(intervalMs) || 0)
  let pending = 0
  let lastAt = -Infinity
  return (compose) => {
    pending += 1
    const at = now()
    if (at - lastAt < gap) return
    lastAt = at
    const count = pending
    pending = 0
    try { warn(compose(count)) } catch { /* 日志失败绝不致命 */ }
  }
}
