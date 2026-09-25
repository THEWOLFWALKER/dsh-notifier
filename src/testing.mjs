// dsh-notifier/testing（v0.11 W1；公共面版本 0.7）
// 消费方插件单测用的 fake notifier：行为与公共面（`src/public.mjs` / PLUGINS.md「push API」）
// 逐项对齐，让声明 `inject: ['notifier']` 的消费方不必手写 stub 就能测自己的推送分支。
//
// 军规：
//  - **独立**：不 import 任何内部实现（createNotifier / router / adapters / public.mjs）。
//    fake 一旦跟着内部架构漂移就失去意义——本文件只依赖语言内建。
//  - **never-reject**：push 内部任何异常都吞掉并返回 `failed: [{ channel: 'fake', reason: 'internal' }]`，
//    与真 facade 的 never-reject 军规同口径，消费方测试不必写 try-catch。
//  - **输入防御**：message/options 是消费方可控对象，可能带 Proxy/getter（读取即抛）。
//    只按已知键提取 primitive，**绝不** `structuredClone`。
//  - **calls 隔离**：copy-on-write + copy-on-read，内部绝不保留消费方对象引用。
//  - **不发 sent 事件**：事件面不在本工具内（事件走 `ctx.on`）。消费方自测事件侧请用自有 `ctx` stub。
//
// 与公共面的两处刻意差异（不是缺陷）：
//  - `enabled()` 属于宿主诊断面，fake 不提供；消费方按能力探测（`typeof notifier?.push === 'function'`），
//    见 PLUGINS.md「版本与兼容」。
//  - 不做长度钳制/限流/预算记账——fake 只回放三态形状，真实资源语义由真 facade 的契约测试覆盖。

const FAKE_API_VERSION = '0.7'
const FAKE_CHANNEL = 'fake'
/** 与 `src/public.mjs` 的 LEVELS 同集合（非法值丢弃，与真服务一致）。 */
const LEVELS = new Set(['timeSensitive', 'active', 'passive'])
/** `options.simulate` 支持的失败分支（未知值按正常成功，见 ROADMAP W1）。 */
const SIMULATIONS = new Set(['rate-limited', 'disabled', 'budget', 'busy'])

/** 防御读取：holder 可能不是对象、可能是 getter 会抛的 Proxy——任何异常一律 `undefined`。 */
function readField(holder, key) {
  if (holder === null || (typeof holder !== 'object' && typeof holder !== 'function')) return undefined
  try { return holder[key] } catch { return undefined }
}

function readString(holder, key) {
  const value = readField(holder, key)
  return typeof value === 'string' ? value : ''
}

/** 与真 facade 的 `normalizeSourceName` 同口径：缺省/非字符串/空 → fallback；trim、64 码点、控制字符替换。 */
function normalizeSourceName(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f\u001b]/g, '\uFFFD')
  return trimmed === '' ? fallback : trimmed.slice(0, 64)
}

/** 只提取已知 message 字段的 primitive（title/content 非字符串按空，level 非法丢弃，group 仅字符串）。 */
function normalizeMessage(rawMessage) {
  const message = {
    title: readString(rawMessage, 'title'),
    content: readString(rawMessage, 'content'),
  }
  const level = readField(rawMessage, 'level')
  if (typeof level === 'string' && LEVELS.has(level)) message.level = level
  const group = readField(rawMessage, 'group')
  if (typeof group === 'string') message.group = group
  return message
}

/** 只提取已知 options 字段的 primitive（sourceName 归一化、channel 同真 facade 的 trim 语义）。 */
function normalizeOptions(rawOptions, defaultSourceName) {
  const options = { sourceName: normalizeSourceName(readField(rawOptions, 'sourceName'), defaultSourceName) }
  const channel = readField(rawOptions, 'channel')
  if (typeof channel === 'string' && channel.trim() !== '') options.channel = channel.trim()
  const simulate = readField(rawOptions, 'simulate')
  if (typeof simulate === 'string' && simulate !== '') options.simulate = simulate
  return options
}

/**
 * 创建消费方测试用 fake notifier（ROADMAP W1 行为规格）。
 *
 * @param {object} [options]
 * @param {string} [options.sourceName] - 缺省来源标注（每次 push 的 `options.sourceName` 覆盖它）；缺省 `anonymous`。
 * @param {() => number} [options.now] - 时钟注入，决定 `calls[].at`（缺省 `Date.now`）。
 * @returns {{
 *   version: '0.7',
 *   push: (message?: object, options?: object) => Promise<object>,
 *   flush: () => Promise<undefined>,
 *   readonly calls: Array<{ message: object, options: object, at: unknown }>,
 * }}
 */
export function createFakeNotifier(options = {}) {
  const defaultSourceName = normalizeSourceName(readField(options, 'sourceName'), 'anonymous')
  const nowOption = readField(options, 'now')
  const now = typeof nowOption === 'function' ? nowOption : Date.now
  const calls = []
  // ROADMAP 要求「flush 记录调用」；plan §6.13 裁定不新增公开 flushCount（避免扩张 surface），
  // 故只保留内部计数，消费方观察 flush 的渠道是「resolve undefined」这一行为本身。
  let flushCount = 0

  const at = () => {
    try { return now() } catch { return undefined }
  }
  const outcome = (sourceName, { delivered = [], skipped = [], failed = [], ok = true } = {}) => ({
    ok,
    delivered,
    skipped,
    failed,
    source: { kind: 'plugin', name: sourceName },
  })

  return {
    version: FAKE_API_VERSION,

    async push(rawMessage = {}, rawOptions = {}) {
      const source = { kind: 'plugin', name: defaultSourceName }
      try {
        const message = normalizeMessage(rawMessage)
        const normalized = normalizeOptions(rawOptions, defaultSourceName)
        source.name = normalized.sourceName
        // 每一次 push 都记录（含 malformed/失败分支）；只存 primitive 拷贝。
        calls.push({ message, options: normalized, at: at() })
        if (message.title === '' && message.content === '') {
          // 双空 = 调用方错误：与真服务一致返回 skipped:['(malformed)']，且 ok 仍为 true。
          return outcome(source.name, { skipped: ['(malformed)'] })
        }
        const simulate = normalized.simulate
        if (simulate !== undefined && SIMULATIONS.has(simulate)) {
          return outcome(source.name, { skipped: [`(${simulate})`] })
        }
        return outcome(source.name, { delivered: [FAKE_CHANNEL] })
      } catch {
        return outcome(source.name, { ok: false, failed: [{ channel: FAKE_CHANNEL, reason: 'internal' }] })
      }
    },

    async flush() {
      flushCount += 1
      return undefined
    },

    /** copy-on-read：每次返回新数组与新内层对象，改返回值绝不影响内部记录。 */
    get calls() {
      return calls.map((entry) => ({
        message: { ...entry.message },
        options: { ...entry.options },
        at: entry.at,
      }))
    },
  }
}