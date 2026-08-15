// dsh-notifier rules.mjs
// host 侧规则引擎（阶段 2）：关键词 include/exclude + 空闲宽限窗。
// 纯函数 / 可注入时钟：不做 IO、不碰宿主 API，全部语义可单测。
// 设计对标 Codex 的 notification_condition（unfocused 才提醒）——host 半能观测的
// 「人在键盘」信号是 user/* 会话事件，由 event-listener 喂给宽限窗。

/** 字符串数组化：非数组/空串项丢弃，trim 后去重，保持顺序。 */
function toStringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 编译单个关键词条目为匹配函数。
 * - regex: true → 按 RegExp source 编译；非法正则降级为字面量匹配（宁可漏拦不炸启动）。
 * - 大小写：字面量统一 toLowerCase 比较；regex 用 'i' flag（caseSensitive 时都不做）。
 */
function compileEntry(entry, { regex, caseSensitive }) {
  if (regex) {
    try {
      const flags = caseSensitive ? '' : 'i'
      const pattern = new RegExp(entry, flags)
      return (text) => pattern.test(text)
    } catch {
      return (text) => containsLiteral(text, entry, caseSensitive)
    }
  }
  return (text) => containsLiteral(text, entry, caseSensitive)
}

function containsLiteral(text, needle, caseSensitive) {
  if (needle === '') return true
  if (caseSensitive) return text.includes(needle)
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * 创建关键词过滤器。
 * @param {object} rawKeywords - { include?: string[], exclude?: string[], regex?: boolean, caseSensitive?: boolean }
 *   include 非空时：文本必须命中至少一条才放行（白名单模式）。
 *   exclude 非空时：命中任意一条即拦截（黑名单优先于 include）。
 * @returns {{ test: (text: string) => boolean, why: (text: string) => string|undefined }}
 *   test 放行 true；why 返回拦截原因（放行时 undefined），供日志与测试。
 */
export function createKeywordFilter(rawKeywords) {
  const raw = (rawKeywords !== null && typeof rawKeywords === 'object') ? rawKeywords : {}
  const include = toStringList(raw.include)
  const exclude = toStringList(raw.exclude)
  const regex = raw.regex === true
  const caseSensitive = raw.caseSensitive === true

  const includeMatchers = include.map((entry) => compileEntry(entry, { regex, caseSensitive }))
  const excludeMatchers = exclude.map((entry) => compileEntry(entry, { regex, caseSensitive }))

  const test = (text) => why(text) === undefined
  const why = (text) => {
    const value = typeof text === 'string' ? text : ''
    for (let index = 0; index < excludeMatchers.length; index += 1) {
      if (excludeMatchers[index](value)) return `exclude:${exclude[index]}`
    }
    if (includeMatchers.length > 0) {
      for (let index = 0; index < includeMatchers.length; index += 1) {
        if (includeMatchers[index](value)) return undefined
      }
      return 'include:none'
    }
    return undefined
  }
  return { test, why }
}

/**
 * 创建空闲宽限窗队列：任务延迟 seconds 秒执行，期间用户活动（activity()）即全部取消。
 * 「turn 结束后等 N 秒，人在键盘就不打扰」：调度的是打扰（推送），取消的是打扰，不是任务。
 * @param {object} [options]
 * @param {number} [options.seconds=0] - 宽限秒数；0 = 不等待（调度即执行）。
 * @param {() => number} [options.now] - 可注入时钟（测试用）。
 * @param {Function} [options.setTimeoutFn] - 可注入定时器（测试用）。
 * @param {Function} [options.clearTimeoutFn] - 可注入定时器（测试用）。
 */
export function createGraceQueue(options = {}) {
  const seconds = Math.max(0, Number(options.seconds) || 0)
  const setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout?.bind(globalThis)
  const clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout?.bind(globalThis)
  const pending = new Map() // key -> { task, timer }
  const fire = (key) => {
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    entry.task()
  }
  const cancel = (key) => {
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    try { clearTimeoutFn(entry.timer) } catch { /* 定时器清理失败不致命 */ }
  }

  return {
    /** 调度：同 key 重复调度替换旧任务（后到者赢，同会话新状态覆盖旧状态）。seconds=0 立即执行。 */
    schedule(key, task) {
      cancel(key)
      if (seconds <= 0 || setTimeoutFn === undefined) {
        task()
        return
      }
      pending.set(key, { task, timer: setTimeoutFn(() => fire(key), seconds * 1000) })
    },
    /** 用户活动信号：人在键盘，取消全部待发打扰（已取消的不再送达）。 */
    activity() {
      for (const key of [...pending.keys()]) cancel(key)
    },
    /** 立即触发全部待发任务（进程退出 / 插件卸载前 flush，headless 一次性运行靠它送达）。 */
    flush() {
      const triggered = []
      for (const [key, entry] of [...pending.entries()]) {
        pending.delete(key)
        try { clearTimeoutFn(entry.timer) } catch { /* 同上 */ }
        triggered.push(typeof entry.task === 'function' ? entry.task() : undefined)
      }
      return triggered
    },
    pendingCount() {
      return pending.size
    },
    /** 清空全部待发（不触发）。 */
    dispose() {
      for (const key of [...pending.keys()]) cancel(key)
    },
  }
}
