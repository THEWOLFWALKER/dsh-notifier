// dsh-notifier routing/task-selection.mjs
// v0.10 移动任务选择（任务书提交5「歧义前置」）：多活跃任务且无绑定时，不先投最近活跃
// 再补提示，而是先下发任务选择卡（编号回复或 /use），用户选定后才把原消息投一次。
//
// 本模块只做**有界待决状态**（谁在选、候选是谁、原消息是什么、何时过期），不含任何
// 投递/结算逻辑——投递由 conversation 路由在选择命中后按既有 followup/inject/steer 语义
// 执行，本模块只负责记住与核销。持久层键 `taskselect:<channel>:<userId>:<chatId>`，
// 与 bind:* 同域（state.json 一并落盘，重启不丢）。
//
// 形状：
// ```json
// "taskselect:telegram:u11:u11": {
//   "candidates": ["sid-a", "sid-b"],
//   "originalText": "帮我看看构建",
//   "image": { "url": "https://media.example/img.png" },
//   "createdAt": 1720000000000,
//   "expiresAt": 1720000600000
// }
// ```
//
// 军规：store 故障全防御（读按无待决、写返回 false、不抛）；候选只存字符串并去重保序；
// 过期惰性回收（read/resolve/has 内联摊销），任何一步异常都等价「无待决」，绝不弄崩上游。

const KEY_PREFIX = 'taskselect:'
const DEFAULT_TTL_MS = 10 * 60 * 1000 // 待决选择 10 分钟过期（对齐审批 qa 窗语义）
const SWEEP_EVERY_MS = 60000 // 内联过期回收摊销间隔（60s 至多一次真扫）

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 图片附件的脱敏归一（待决选择伴生的图片段）：只保留 url 与有界宽高，未知字段不透传，
 * 免得上游门面/存储混入控制字段。非记录或缺 url 一律 null（图片不进待决态）。
 */
function sanitizeImage(value) {
  if (!isRecord(value)) return null
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  if (url === '') return null
  const image = { url }
  for (const key of ['width', 'height']) {
    const num = Number(value[key])
    if (Number.isFinite(num) && num > 0) image[key] = num
  }
  return image
}

/** 非负毫秒数归一（0 回退默认；NaN/负数/缺省回退默认）。 */
function nonNegativeMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 创建任务选择状态机。
 * @param {object} options
 * @param {import('../inbound/store.mjs').store} [options.store] - 键值存储；缺失/失败退化为内存态
 * @param {number} [options.ttlMs=600000] - 待决选择过期窗口（毫秒）
 * @param {() => number} [options.now=Date.now] - 时钟注入（测试可变时钟）
 * @param {(payload: { sessionId: string }) => boolean} [options.isActive] - 候选是否仍为活跃会话
 *   （惰性过滤已退出的候选）；缺省恒 true
 */
export function createTaskSelection(options = {}) {
  const store = options.store ?? null
  const ttlMs = nonNegativeMs(options.ttlMs, DEFAULT_TTL_MS)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true

  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/task-selection]', message) } catch { /* 日志失败不致命 */ }
  }

  // —— store 防御壳：方法缺失/抛错一律按无数据/写失败处理 ——
  const safeGet = (key) => {
    try {
      if (typeof store?.get !== 'function') return undefined
      return store.get(key)
    } catch { return undefined }
  }
  const safeSet = (key, value) => {
    try {
      if (typeof store?.set !== 'function') return false
      return store.set(key, value) !== false
    } catch { return false }
  }
  const safeDelete = (key) => {
    try {
      if (typeof store?.delete !== 'function') return false
      return store.delete(key) === true
    } catch { return false }
  }
  const safeKeys = () => {
    try {
      if (typeof store?.keys !== 'function') return []
      const keys = store.keys(KEY_PREFIX)
      return Array.isArray(keys) ? keys : []
    } catch { return [] }
  }

  // 内存态（store 不可用时兜底；store 可用时同步读写，内存仅作开销优化不必需）。
  const memory = new Map()

  /** 待决键：channel 小写 + userId trim + chatId 字符串，三个分量齐备才构成有效键。 */
  function keyOf(envelope) {
    const channel = String(envelope?.channel ?? '').trim().toLowerCase()
    const userId = String(envelope?.userId ?? '').trim()
    const chatId = String(envelope?.chatId ?? '')
    if (channel === '' || userId === '') return null
    return `${KEY_PREFIX}${channel}:${userId}:${chatId}`
  }

  /** 归一候选：只留非空字符串，去重保序。 */
  function normalizeCandidates(candidates) {
    const seen = new Set()
    const out = []
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (typeof candidate !== 'string' || candidate === '') continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      out.push(candidate)
    }
    return out
  }

  /** 从任意来源读一条待决（内存优先：单进程内内存态恒为最新；盘上作持久兜底）。 */
  function readEntry(key) {
    const raw = memory.get(key) ?? safeGet(key)
    if (!isRecord(raw)) return undefined
    const candidates = normalizeCandidates(raw.candidates)
    if (candidates.length === 0) return undefined
    const originalText = typeof raw.originalText === 'string' ? raw.originalText : ''
    if (originalText === '') return undefined
    const image = sanitizeImage(raw.image)
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : now()
    const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : createdAt + ttlMs
    return { candidates, originalText, image, createdAt, expiresAt }
  }

  /** 过滤仍活跃的候选；全灭返回空数组。 */
  function liveCandidates(candidates) {
    return candidates.filter((id) => {
      try { return isActive({ sessionId: id }) === true } catch { return true }
    })
  }

  // 内联过期摊销（60s 至多一次真扫）。
  let lastSweepMs = -Infinity
  function prune() {
    if (now() - lastSweepMs < SWEEP_EVERY_MS) return
    lastSweepMs = now()
    try { sweep() } catch (error) {
      warn(`taskselect 惰性回收失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 显式真扫：删除过期待决与损坏/空条目。 */
  function sweep() {
    const nowMs = now()
    let removed = 0
    for (const key of safeKeys()) {
      const entry = readEntry(key)
      if (entry === undefined || entry.expiresAt < nowMs) {
        if (safeDelete(key)) removed += 1
        memory.delete(key)
      }
    }
    return removed
  }

  return {
    /**
     * 开启一次待决选择（歧义前置）。候选为空时不进入待决（返回 null）。
     * @param {object} envelope - { channel, userId, chatId? }
     * @param {string[]} candidates - 候选会话 id（去重保序）
     * @param {string} originalText - 触发的原消息（选定后投一次）
     * @param {object} [image] - 伴生图片附件（可选，选定后随原消息一起投）
     * @returns {{ candidates: string[], originalText: string, image: object|null } | null}
     *   写入成功返回待决条目；失败返回 null（调用方回退旧行为）
     */
    begin(envelope, candidates, originalText, image) {
      prune()
      const key = keyOf(envelope)
      if (key === null) return null
      const live = liveCandidates(normalizeCandidates(candidates))
      const text = String(originalText ?? '')
      if (live.length === 0 || text === '') return null
      const imagePart = sanitizeImage(image)
      const nowMs = now()
      const entry = { candidates: live, originalText: text, createdAt: nowMs, expiresAt: nowMs + ttlMs }
      if (imagePart !== null) entry.image = imagePart
      // 尽力持久化；durable 失败也照常降级内存态（本模块是单进程暂态，内存态即可闭环）。
      safeSet(key, entry)
      memory.set(key, entry)
      return { candidates: live, originalText: text, image: imagePart }
    },

    /** 是否对该信封存在有效待决选择。 */
    has(envelope) {
      prune()
      const key = keyOf(envelope)
      if (key === null) return false
      return readEntry(key) !== undefined
    },

    /** 读当前待决选择（深拷贝，不含任何敏感字段）。 */
    get(envelope) {
      prune()
      const key = keyOf(envelope)
      if (key === null) return undefined
      const entry = readEntry(key)
      if (entry === undefined) return undefined
      return { candidates: [...entry.candidates], originalText: entry.originalText, image: entry.image ?? null }
    },

    /**
     * 用编号回复消解待决选择：`text` 为 1..candidates.length 的整数即命中。
     * @param {object} envelope
     * @param {string} text - 用户原样回复（如 '2'）
     * @returns {{ ok: true, sessionId: string, originalText: string, image: object|null }
     *   | { ok: false, reason: 'invalid'|'no-pending', candidates: string[] }}
     *   命中后清掉待决（原消息投递由调用方负责，恰好一次）。
     */
    resolve(envelope, text) {
      prune()
      const key = keyOf(envelope)
      if (key === null) return { ok: false, reason: 'no-pending', candidates: [] }
      const entry = readEntry(key)
      if (entry === undefined) return { ok: false, reason: 'no-pending', candidates: [] }
      const index = Number(String(text ?? '').trim())
      if (!Number.isInteger(index) || index < 1 || index > entry.candidates.length) {
        return { ok: false, reason: 'invalid', candidates: [...entry.candidates] }
      }
      // 命中：清待决（先删后读，防重入二次命中原消息）。
      if (safeDelete(key)) memory.delete(key)
      else memory.delete(key)
      return { ok: true, sessionId: entry.candidates[index - 1], originalText: entry.originalText, image: entry.image ?? null }
    },

    /** 撤销当前待决（envelope 维度）。 */
    cancel(envelope) {
      const key = keyOf(envelope)
      if (key === null) return false
      memory.delete(key)
      return safeDelete(key)
    },

    /** 待决选择清理（供停机/测试显式调用）。 */
    sweep,

    /**
     * 待决选择脱敏视图（管理台任务页）。绝不外泄 originalText 正文——只给
     * channel/userId/chatId、候选与创建时间。
     * @returns {Array<{ channel: string, userId: string, chatId: string,
     *   candidates: string[], createdAt: number, expiresAt: number }>}
     */
    pending() {
      prune()
      const rows = []
      for (const key of safeKeys()) {
        const entry = readEntry(key)
        if (entry === undefined) continue
        const rest = key.slice(KEY_PREFIX.length)
        const [channel, userId, chatId] = rest.split(':')
        rows.push({
          channel: channel ?? '',
          userId: userId ?? '',
          chatId: chatId ?? '',
          candidates: [...entry.candidates],
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        })
      }
      return rows
    },

    /** 释放（本实现无定时器持有，幂等空操作——保留接口对齐其它 assembly）。 */
    dispose() {
      memory.clear()
    },
  }
}