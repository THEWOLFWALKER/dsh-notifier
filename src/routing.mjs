// dsh-notifier routing.mjs
// 分级路由矩阵（阶段 3）：把 intentToMessage 产出的 level（active / timeSensitive / passive）
// 接到渠道语义上。routing 配置形如：
//   routing:
//     timeSensitive:
//       - { channel: telegram, sound: true }
//       - { channel: bark, level: critical }
//     active:
//       - { channel: ntfy }
//     passive:
//       - { channel: ntfy, silent: true }
// 规则：
//  - 未配置 routing（或某 level 未配置）→ 该 level 广播全部已启用渠道（向后兼容）。
//  - entry 里除 channel 外的字段是「渠道语义覆盖」，浅合并进该渠道的消息
//    （如 silent: true → telegram disable_notification / ntfy 低优先级）。
//  - timeSensitive 分档重试（指数退避 2 次）；active 重试 1 次；passive 不重试。
//    现有 24h 去重账本天然防重发刷屏。

export const LEVELS = Object.freeze(['timeSensitive', 'active', 'passive'])

/** 归一化 level：未知值归入 active。 */
export function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'active'
}

/**
 * 解析 routing 配置为 { configured, byLevel }。
 * byLevel[level] = [{ channel, ...overrides }]（channel 必须是字符串，其余原样保留）。
 */
export function resolveRouting(raw = {}) {
  const byLevel = { timeSensitive: [], active: [], passive: [] }
  let configured = false
  for (const level of LEVELS) {
    const rows = raw?.[level]
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const channel = typeof row.channel === 'string' ? row.channel.trim() : ''
      if (channel === '') continue
      const { channel: _drop, ...overrides } = row
      byLevel[level].push({ channel, overrides })
      configured = true
    }
  }
  return { configured, byLevel }
}

/** level → 重试策略（attempts 含首发；backoffMs 为首次退避基数，指数翻倍）。 */
export function retryPolicyOf(level, retry = {}) {
  const table = {
    timeSensitive: { attempts: 3, backoffMs: 2000 },
    active: { attempts: 2, backoffMs: 2000 },
    passive: { attempts: 1, backoffMs: 0 },
  }
  const policy = table[normalizeLevel(level)] ?? table.active
  if (retry.enabled === false) return { attempts: 1, backoffMs: 0 }
  return {
    attempts: Math.max(1, Math.min(5, retry.attempts ?? policy.attempts)),
    backoffMs: Math.max(0, retry.backoffMs ?? policy.backoffMs),
  }
}

/**
 * 计算一条消息的发送目标列表。
 * @param routing - resolveRouting 的返回值
 * @param channels - 已启用渠道 [{ type, config }]
 * @param msg - normalizeMessage 归一化后的消息（含 level）
 * @returns [{ entry, type, message, overrides }] 目标渠道实例与修订后的消息
 *   （同类型多实例时，路由命中该类型则全部实例都收到——实例身份由 entry 携带）
 */
export function routeTargets(routing, channels, msg) {
  const level = normalizeLevel(msg.level)
  const entries = routing.byLevel[level]
  if (!routing.configured || entries.length === 0) {
    // 未配置（或该 level 未配置）：广播全部渠道，消息原样（向后兼容基线行为）
    return channels.map((entry) => ({ entry, type: entry.type, message: msg, overrides: {} }))
  }
  const targets = []
  for (const entry of entries) {
    for (const channel of channels) {
      if (channel.type !== entry.channel) continue
      targets.push({
        entry: channel,
        type: entry.channel,
        message: { ...msg, ...entry.overrides },
        overrides: entry.overrides,
      })
    }
  }
  return targets
}

/** 指数退避 sleep（可注入时钟，供测试）。 */
function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * 带重试的发送：attempts 次尝试，退避 backoffMs * 2^(n-1)。最后一次失败把错误抛出。
 * v0.6.3：error.noRetry === true 时立即抛出（分段已部分送达时重试会重发全部段，
 * 造成重复通知轰炸——见 notify.mjs sendOne 的 PARTIAL 标记）。
 * @param {(message) => Promise<void>} sendFn
 */
export async function sendWithRetry(sendFn, { attempts = 1, backoffMs = 0, onRetry } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendFn()
      return
    } catch (error) {
      lastError = error
      if (error?.noRetry === true) throw error
      if (attempt < attempts) {
        if (typeof onRetry === 'function') onRetry(attempt, error)
        await sleep(backoffMs * 2 ** (attempt - 1))
      }
    }
  }
  throw lastError
}
