// dsh-notifier admin/events.mjs
// v0.4.0 通知事件 hub（A 路线「管理台页 + SSE → 浏览器系统通知」的函数层）：
// notifier.onSend 的旁路广播——账本（ledger.jsonl 落盘）管「事后查」，hub 管「实时看」。
//
// 设计（对齐参考成品 dsh-notification 的取舍并补其短板）：
//   - 环形缓冲（默认 50 条）：SSE 连接建立时按 replay 语义重放，页面重开后漏掉的事件
//     进页面日志但不重弹系统通知（参考成品明确「断线期间完成的不补弹」，我们补日志不补弹）；
//   - 订阅者异常隔离：任一订阅者 throw 绝不影响其他订阅者与发布方（防御壳同 store/api 层）；
//   - 发布即深拷贝：订阅者与缓冲互不污染（后续 mutate 不回写）；
//   - 事件负载 = onSend 的 record（{ time, message, ok, delivered, skipped, failed }），
//     不含任何凭证（message 是归一化后的出站消息），SSE 直出安全。
// 军规：本文件零 IO、零依赖、绝不抛——hub 任何故障只影响「实时看」，绝不影响推送主链路。

/** 默认环形缓冲容量（页面日志上限，超过丢弃最旧）。 */
const DEFAULT_CAPACITY = 50

/**
 * 创建通知事件 hub。
 * @param {object} [options]
 * @param {number} [options.capacity=50] - 环形缓冲容量（钳制 1-500）。
 * @returns {{
 *   publish: (payload: object) => void,
 *   subscribe: (listener: (event: object) => void) => () => void,
 *   snapshot: () => object[],
 *   size: () => number,
 *   listenerCount: () => number,
 * }}
 */
export function createEventHub({ capacity } = {}) {
  const cap = typeof capacity === 'number' && Number.isFinite(capacity)
    ? Math.min(500, Math.max(1, Math.trunc(capacity)))
    : DEFAULT_CAPACITY
  const buffer = [] // 环形缓冲（朴素数组 + 超容 shift：50 条量级无需真环形）
  const listeners = new Set()
  let seq = 0

  /** 深拷贝纯 JSON 值（订阅者 mutate 不污染缓冲；不可序列化兜底原值）。 */
  const clone = (value) => {
    try { return JSON.parse(JSON.stringify(value ?? null)) } catch { return value }
  }

  return {
    /**
     * 发布一条通知事件（onSend 旁路调用）：入环形缓冲 + 广播全部订阅者。
     * 任何异常（含订阅者 throw / payload 非法）一律吞掉——绝不影响推送主链路。
     */
    publish(payload) {
      let event
      try {
        seq += 1
        event = { seq, time: new Date().toISOString(), payload: clone(payload) }
        buffer.push(event)
        if (buffer.length > cap) buffer.splice(0, buffer.length - cap)
      } catch { return }
      for (const listener of [...listeners]) {
        // 逐订阅者深拷贝交付：订阅者 mutate 嵌套字段（payload.delivered.push 之类）不污染缓冲
        try { listener({ seq: event.seq, time: event.time, payload: clone(event.payload), replay: false }) } catch { /* 单个订阅者异常不殃及其他 */ }
      }
    },

    /**
     * 订阅实时事件；可选重放缓冲（{ replay: true } 逐条补发，标记 replay: true）。
     * @returns {() => void} 退订函数（幂等）。
     */
    subscribe(listener, { replay = false } = {}) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      if (replay) {
        for (const item of [...buffer]) {
          try { listener({ seq: item.seq, time: item.time, payload: clone(item.payload), replay: true }) } catch { /* 重放异常同隔离 */ }
        }
      }
      return () => { listeners.delete(listener) }
    },

    /** 缓冲快照（浅拷贝数组；元素为内部对象，调用方勿 mutate）。 */
    snapshot() {
      return [...buffer]
    },

    /** 当前缓冲条数（测试/诊断用）。 */
    size() {
      return buffer.length
    },

    /** 当前订阅者数（SSE 断连清理的验证点）。 */
    listenerCount() {
      return listeners.size
    },
  }
}
