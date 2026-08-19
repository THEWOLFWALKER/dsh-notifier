// dsh-notifier approval/escalation.mjs
// 审批升级链状态机：主渠道超时 → 第二渠道 + 更高打扰级别 → … → 交还桌面。
// 每个审批 key 一条链；任何裁决/放弃立即停止后续升级。
// 「语音终章」不自行实现：把最后一环配置为 webhook 渠道指向 /call-me 的 ring API 即可（生态互哺）。

/**
 * 创建升级链管理器。
 * @param {object} options
 * @param {Array<{ afterMs: number, level?: string, note?: string }>} [options.stages]
 *   - afterMs 相对上一阶段（第一阶段相对起点）的延迟
 *   - onStage(key, stage) 触发时的升级动作由调用方决定（如再推一轮更高 level 的通知）
 * @param {object} [options.logger]
 */
export function createEscalationChain({ stages = [], logger = null } = {}) {
  const chains = new Map() // key -> { timers: [], stage: number }
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/escalation]', message) } catch { /* 日志失败绝不致命 */ }
  }

  function clear(key) {
    const chain = chains.get(key)
    if (chain === undefined) return
    for (const timer of chain.timers) clearTimeout(timer)
    chains.delete(key)
  }

  return {
    /**
     * 启动一条升级链。
     * @param {string} key - 审批 key
     * @param {(key: string, stage: object, index: number) => void} onStage - 升级回调（异常被吞，绝不致命）
     */
    start(key, onStage) {
      this.stop(key)
      if (!Array.isArray(stages) || stages.length === 0) return
      const chain = { timers: [], stage: 0 }
      chains.set(key, chain)
      let elapsed = 0
      stages.forEach((stage, index) => {
        elapsed += Math.max(0, Number(stage.afterMs) || 0)
        chain.timers.push(setTimeout(() => {
          const current = chains.get(key)
          if (current === undefined || current !== chain) return // 已停止
          current.stage = index + 1
          try {
            onStage(key, stage, index)
          } catch (error) {
            warn(`升级阶段 ${index + 1} 执行异常: ${error instanceof Error ? error.message : String(error)}`)
          }
        }, elapsed))
      })
    },

    /** 停止一条链（裁决到达 / 交还桌面时调用）。 */
    stop(key) {
      clear(key)
    },

    stageOf(key) {
      return chains.get(key)?.stage ?? 0
    },

    /** 停止所有链（插件卸载）。 */
    dispose() {
      for (const key of [...chains.keys()]) clear(key)
    },
  }
}
