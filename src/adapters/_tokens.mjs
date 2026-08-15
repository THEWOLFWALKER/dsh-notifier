// dsh-notifier adapters/_tokens.mjs
// 共用 token 管理器：「换 token → 缓存 → 过期前刷新 → 失效作废」。
// QQ 官方机器人（getAppAccessToken）与企微应用消息（gettoken）共用此逻辑（约 40 行）。
// 零运行时依赖；fetchToken 由各渠道适配器提供。

/**
 * 创建 token 管理器。
 * @param {() => Promise<{ token: string, expiresInMs: number }>} fetchToken - 换取新 token（抛错则向上传播）
 * @param {object} [options]
 * @param {number} [options.refreshMarginMs=60000] - 提前刷新余量（到期前这么多毫秒就重新换）
 * @returns {{ get: (force?: boolean) => Promise<string>, invalidate: () => void }}
 */
export function createTokenManager(fetchToken, { refreshMarginMs = 60000 } = {}) {
  let cached = null // { token, expiresAt }
  let inflight = null

  async function get(force = false) {
    const fresh = cached !== null && Date.now() < cached.expiresAt - refreshMarginMs
    if (!force && fresh) return cached.token
    if (!force && inflight !== null) return inflight
    inflight = (async () => {
      const { token, expiresInMs } = await fetchToken()
      cached = { token, expiresAt: Date.now() + Math.max(1000, expiresInMs) }
      return token
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function invalidate() {
    cached = null
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
