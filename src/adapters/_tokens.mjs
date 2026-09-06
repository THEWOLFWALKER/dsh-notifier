// dsh-notifier adapters/_tokens.mjs
// 共用 token 管理器：「换 token → 缓存 → 过期前刷新 → 失效作废」。
// QQ 官方机器人（getAppAccessToken）与企微应用消息（gettoken）共用此逻辑（约 40 行）。
// 零运行时依赖；fetchToken 由各渠道适配器提供。

import { NotifyError, ERROR_CODES } from './_shared.mjs'

const TTL_MIN_MS = 1000
const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000

/**
 * G-55：token TTL 归一化单一实现。异常值（非有限数/≤0）不再各处自行兜底——
 * 0 在旧代码里会变成「1 秒 TTL」或「活 7200 秒」或「立即超时」四种互相矛盾的走向。
 * 对端返回非法 TTL = 上游响应损坏，直接抛错让投递失败并计入日志（fail-closed），
 * 不拿默认值掩盖。正数钳制 [1s, 7d]。
 * @param {number} value - 上游/配置给的 TTL（毫秒）。
 * @param {string} [what] - 字段名（错误指引用）。
 * @returns {number} 归一后的 TTL 毫秒。
 */
export function normalizeTtlMs(value, what = 'expiresInMs') {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new NotifyError(`上游返回的 token TTL 非法（${what}=${String(value)}，需为正数毫秒）`, ERROR_CODES.API_ERROR)
  }
  return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Math.round(n)))
}

/**
 * 创建 token 管理器。
 * @param {() => Promise<{ token: string, expiresInMs: number }>} fetchToken - 换取新 token（抛错则向上传播）
 * @param {object} [options]
 * @param {number} [options.refreshMarginMs=60000] - 提前刷新余量（到期前这么多毫秒就重新换）；
 *   G-29：与剩余寿命比较时动态钳制为 min(配置值, 剩余寿命的 20%)——TTL 短于余量的
 *   渠道不再「永判不新鲜」死循环刷新。
 * @returns {{ get: (force?: boolean) => Promise<string>, invalidate: () => void }}
 */
export function createTokenManager(fetchToken, { refreshMarginMs = 60000 } = {}) {
  let cached = null // { token, expiresAt }
  let inflight = null
  // G-11：代际计数。invalidate() 递增；在飞任务完成写回前比对——旧代际任务
  // 不得覆盖新缓存（旧任务可能携带着失效前换到的旧 token）。
  let generation = 0

  function marginFor(entry) {
    const remaining = entry.expiresAt - Date.now()
    return Math.min(Math.max(0, refreshMarginMs), Math.max(1, remaining * 0.2))
  }

  async function get(force = false) {
    const fresh = cached !== null && Date.now() < cached.expiresAt - marginFor(cached)
    if (!force && fresh) return cached.token
    if (!force && inflight !== null) return inflight
    const myGeneration = generation
    inflight = (async () => {
      const { token, expiresInMs } = await fetchToken()
      const entry = { token, expiresAt: Date.now() + normalizeTtlMs(expiresInMs, 'expiresInMs') }
      // G-11：写回前比对代际；invalidate() 之后完成的旧任务丢弃结果不覆盖缓存。
      if (myGeneration === generation) cached = entry
      return token
    })()
    try {
      return await inflight
    } finally {
      if (myGeneration === generation) inflight = null
    }
  }

  function invalidate() {
    // G-11：同时清 inflight——invalidate 后的新 get() 必须发起新换取，
    // 不再复用失效前发起的旧任务（旧任务返回的 token 正是被作废的那个）。
    generation += 1
    cached = null
    inflight = null
  }

  return { get, invalidate }
}

/**
 * 带本地限速的顺序发送门（QQ 官方 Bot 维度 60qpm ≈ 1 条/秒，超限会被服务端拒绝）。
 * @param {number} minIntervalMs - 两次发送的最小间隔
 */
export function createRateGate(minIntervalMs) {
  let last = 0
  let chain = Promise.resolve()
  const gate = () => {
    const run = async () => {
      const wait = last + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      last = Date.now()
    }
    chain = chain.then(run, run)
    return chain
  }
  return { gate }
}
