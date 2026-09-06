// dsh-notifier interaction/ledger.mjs
// Interaction Core —— 三条交互链（动作 actions / 审批 approval / 提问 questions）
// 共用的统一状态账本。把散落在三处的账本状态机收敛成一份：
//   status: 'pending' → 'resolved'（decisionField 承载终态裁决：
//     actions → outcome；approval/questions → decision，字段名由各链声明）
// 生命周期军规（与三条链旧实现逐字节行为等价，迁移时逐一核对过）：
//  - add 总是覆写为 { ...row, status:'pending', createdAt}——旧行/僵尸行按
//    「非 pending」判非待决，与三条链既有语义一致；
//  - resolve 已终态不翻转（S-14，W12）：已决行二次 resolve 返回 'already-resolved'，
//    内部 API 误用/迟到 settle/竞态双 resolve 不再覆写既有终态裁决（approval/questions
//    单次裁决不受影响；主链路 bus settle 本就有防线）。actions 的
//    「首达采纳 → 执行 → 终局多步落地」用 opts.claimedSettle 显式逃生门：'executing'
//    是执行中占位声明（并发双击/崩溃中段的消费护栏），同一执行在终局允许落定终态裁决；
//  - terminate 仅 pending 可翻：防已决行被 onAbandon 二次改写（C2/P1-5 僵尸守卫）；
//  - get 不做投影：行原样返回，上游按 status/decision 自己裁决；
//  - 过期不设独立 status：token TTL + decision 'timeout' 表达（与三条链现状一致）。
// 对外接口：只暴露 statuses/add/get/isPending/resolve/terminate/scanKeys 六个原子操作。
// 各链的 latestPendingFor 归属/兜底启发式留在链内——匹配语义（exact/onChannel/
// intended/hint + liveWaiters 僵尸行过滤）差异太大，强行统一会引入行为漂移（批 4 决策）。

/**
 * 创建统一交互状态账本。
 * @param {object} [options]
 * @param {string} [options.keyPrefix=''] - 行键前缀（'act:'/'ap:'/'aq:'，scanKeys 过滤用）
 * @param {import('../inbound/store.mjs').store} [options.store=null] - 持久化 store；缺省空账本（
 *   actions 可 null 构造，add/get 安全 no-op，resolve/terminate 返回 false）
 * @param {string} [options.decisionField='decision'] - 终态裁决字段名：actions 声明 'outcome'
 *   （act: 行历史形状），approval/questions 保持默认 'decision'——state key 格式不破
 * @param {() => number} [options.now=Date.now] - 时间源（测试注入）
 */
export function createInteractionLedger(options = {}) {
  const { keyPrefix = '', store = null, decisionField = 'decision', now = Date.now } = options
  const statuses = Object.freeze({ pending: 'pending', resolved: 'resolved' })

  const isPending = (row) => row !== null && row !== undefined
    && typeof row === 'object' && row.status === statuses.pending

  /** 终态行投影：status/resolvedAt/decisionField 恒由决议覆盖，extra 只并入旁注字段。 */
  const resolvedRowOf = (row, decision, extra = {}) => ({
    ...row,
    ...extra,
    status: statuses.resolved,
    [decisionField]: decision,
    resolvedAt: now(),
  })

  return {
    statuses,
    /** 铸新行：覆写为 pending + createdAt。写入抛错不吞——由调用方决策
     *  （actions 降级不发卡 / approval 交还桌面 / questions 交还桌面）。 */
    add(key, row) {
      store?.set(key, { ...row, status: statuses.pending, createdAt: now() })
    },
    get(key) {
      return store?.get(key)
    },
    /** 待决判定：非对象/非 pending（含旧行、僵尸行）一律视为已决（fail-closed）。 */
    isPending,
    /** 行缺失返回 false；已终态（status='resolved'）返回 'already-resolved' 不再翻转
     *  （S-14，W12：内部 API 误用/迟到 settle/竞态双 resolve 不覆写既有终态裁决）。
     *  actions 的「首达采纳后多步落地」（'executing' 占位 → 'done' 终局）是同一执行的
     *  显式逃生门：传 opts={claimedSettle:true} 放行已占位行的终局落定；除此之外任何
     *  已决行二次 resolve 一律拒绝。extra 不能覆盖 status/decision/resolvedAt。
     * @param {object} [opts.claimedSettle] - 仅 actions 用：放行对已终态行的终局落地 */
    resolve(key, decision, extra = {}, opts = {}) {
      const row = store?.get(key)
      if (row === undefined) return false
      if (row.status === statuses.resolved && opts.claimedSettle !== true) {
        return 'already-resolved'
      }
      store.set(key, resolvedRowOf(row, decision, extra))
      return true
    },
    /** 仅 pending 行可终止为 'terminated'（C2/P1-5 僵尸守卫）：已决/缺失行返回
     *  false，绝不改写。onAbandon / 会话销毁路径专用。 */
    terminate(key, extra = {}) {
      const row = store?.get(key)
      if (row === undefined || !isPending(row)) return false
      store.set(key, resolvedRowOf(row, 'terminated', extra))
      return true
    },
    /** 按前缀扫描行键（latestPendingFor 遍历用；store 缺失返回空数组）。 */
    scanKeys() {
      return store?.keys(keyPrefix) ?? []
    },
  }
}