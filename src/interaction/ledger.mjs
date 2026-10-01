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

import { setDurable, transactDurable, transactOutcome } from '../inbound/store.mjs'

/**
 * 账本行的 metadata 白名单（RC Gate 2A）。这些是**旁注字段**：它们可以从原始行
 * 之外独立更新（送达证据、来源会话、提示目标），而绝不参与生命周期裁决。
 * 任何白名单外的键都会被 `patchMetadata` 丢弃——status / decision / outcome /
 * claim 字段 / 终态时间戳因此**永远**来自事务内的 fresh row，不可能被 metadata
 * patch 回退。
 */
const METADATA_FIELDS = Object.freeze(['srcChats', 'pushedTo', 'hintTargets', 'deliveryEvidence'])

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

  const isRowLike = (row) => row !== null && row !== undefined && typeof row === 'object' && !Array.isArray(row)

  const cloneJson = (value) => {
    if (value === null || value === undefined || typeof value !== 'object') return value
    try { return JSON.parse(JSON.stringify(value)) } catch { return Array.isArray(value) ? [...value] : { ...value } }
  }

  /** 只读 metadata 视图：只含白名单字段，深拷贝 + 冻结——patcher 拿不到生命周期字段，
   *  也不可能顺手改到 fresh row。 */
  const metadataView = (row) => {
    const view = {}
    for (const field of METADATA_FIELDS) {
      if (row[field] !== undefined) view[field] = cloneJson(row[field])
    }
    return Object.freeze(view)
  }

  /**
   * 白名单化 patcher 的返回值。
   * @returns {object|null} 只含白名单键的补丁对象；无任何白名单键时返回 null（零变更）。
   *   补丁值为 null 表示**删除**该 metadata 键。
   */
  const sanitizePatch = (patch) => {
    if (!isRowLike(patch)) return null
    const out = {}
    let hasField = false
    for (const field of METADATA_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
      hasField = true
      out[field] = patch[field]
    }
    return hasField ? out : null
  }

  /** 把白名单补丁并入 fresh row：生命周期字段原样保留，null 值删除对应 metadata 键。 */
  const applyPatch = (row, patch) => {
    const next = { ...row }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete next[field]
      else next[field] = cloneJson(value)
    }
    return next
  }

  /** 终态行投影：status/resolvedAt/decisionField 恒由决议覆盖，extra 只并入旁注字段。 */
  const resolvedRowOf = (row, decision, extra = {}) => ({
    ...row,
    ...extra,
    status: statuses.resolved,
    [decisionField]: decision,
    resolvedAt: now(),
  })

  const claimedRowOf = (row, extra = {}) => ({
    ...row,
    ...extra,
    status: 'claimed',
    [decisionField]: 'claimed',
    claimedAt: now(),
  })

  /**
   * Apply a state transition against the freshest transaction draft.  Legacy
   * test doubles still get the old single-key fallback; the production store
   * always takes the atomic path.
   */
  const transition = (key, decide, write) => {
    if (typeof store?.transact === 'function') {
      let outcome = { kind: 'missing' }
      const result = transactDurable(store, (draft) => {
        const row = draft[key]
        outcome = decide(row)
        if (outcome.kind === 'write') draft[key] = write(row, outcome)
        return outcome.kind
      })
      if (result.committed !== true) return { ok: false, reason: 'storage-failed' }
      return { ok: true, ...outcome }
    }
    const row = store?.get(key)
    const outcome = decide(row)
    if (outcome.kind !== 'write') return { ok: true, ...outcome }
    if (setDurable(store, key, write(row, outcome)) !== true) return { ok: false, reason: 'storage-failed' }
    return { ok: true, ...outcome }
  }

  return {
    statuses,
    /** 铸新行：覆写为 pending + createdAt。写入抛错不吞——由调用方决策
     *  （actions 降级不发卡 / approval 交还桌面 / questions 交还桌面）。 */
    add(key, row) {
      return setDurable(store, key, { ...row, status: statuses.pending, createdAt: now() })
    },
    get(key) {
      return store?.get(key)
    },
    /**
     * RC Gate 2A：**窄** metadata mutation。三条交互链不再整行覆写自己的账本键
     * （`setDurable(store, key, { ...row, ... })` 的读-改-写窗口会在并发 claim/settle
     * 时把终态回退成 pending）。
     *
     * 契约：
     *  - row 只在 `store.transact()` 的 **fresh draft** 里读取；
     *  - `patcher(metadata)` 只拿白名单 metadata 视图（已深拷贝 + 冻结），拿不到
     *    lifecycle writer，也无法读到 status/decision/claimedAt 等字段；
     *  - 白名单：srcChats / pushedTo / hintTargets / deliveryEvidence；补丁值为 null
     *    表示删除该键，其余键一律**丢弃**；
     *  - status、decision/outcome、claim 字段、终态时间戳**永远**从 fresh row 保留。
     * @param {string} key
     * @param {(metadata: object) => object|null} patcher
     * @param {object} [opts]
     * @param {boolean} [opts.requirePending=false] - true 时仅 pending 行可改（actions 来源登记语义）
     * @returns {{ ok: boolean, changed?: boolean, reason?: 'not-found'|'not-pending'|'storage-failed' }}
     */
    patchMetadata(key, patcher, opts = {}) {
      if (typeof key !== 'string' || key === '' || typeof patcher !== 'function') {
        return { ok: false, reason: 'not-found' }
      }
      const requirePending = opts.requirePending === true
      if (typeof store?.transact === 'function') {
        let changed = false
        const result = transactOutcome(store, (draft, control) => {
          const row = draft[key]
          if (!isRowLike(row)) return control.abort('not-found')
          if (requirePending && !isPending(row)) return control.abort('not-pending')
          const patch = sanitizePatch(patcher(metadataView(row)))
          if (patch === null) return control.abort('no-change')
          draft[key] = applyPatch(row, patch)
          changed = true
          return true
        })
        if (result.aborted) {
          const reason = String(result.reason ?? '')
          if (reason === 'no-change') return { ok: true, changed: false }
          return { ok: false, reason: reason === 'not-pending' ? 'not-pending' : 'not-found' }
        }
        if (result.committed !== true) return { ok: false, reason: 'storage-failed' }
        return { ok: true, changed }
      }
      const row = store?.get(key)
      if (!isRowLike(row)) return { ok: false, reason: 'not-found' }
      if (requirePending && !isPending(row)) return { ok: false, reason: 'not-pending' }
      const patch = sanitizePatch(patcher(metadataView(row)))
      if (patch === null) return { ok: true, changed: false }
      if (setDurable(store, key, applyPatch(row, patch)) !== true) return { ok: false, reason: 'storage-failed' }
      return { ok: true, changed: true }
    },
    /** 待决判定：非对象/非 pending（含旧行、僵尸行）一律视为已决（fail-closed）。 */
    isPending,
    /**
     * Durable first-winner claim for actions.  A claimed row is intentionally
     * not pending and is never auto-executed again after a restart.
     */
    claim(key, extra = {}) {
      const result = transition(
        key,
        (row) => {
          if (row === undefined) return { kind: 'missing' }
          if (row.status === 'claimed') return { kind: 'uncertain' }
          if (row.status !== statuses.pending) return { kind: 'already-resolved' }
          return { kind: 'write' }
        },
        (row) => claimedRowOf(row, extra),
      )
      if (!result.ok) return { ok: false, reason: result.reason }
      if (result.kind === 'write') return { ok: true, claimed: true }
      return { ok: false, reason: result.kind === 'uncertain' ? 'uncertain' : result.kind === 'already-resolved' ? 'already-resolved' : 'unknown' }
    },
    /** 行缺失返回 false；已终态（status='resolved'）返回 'already-resolved' 不再翻转
     *  （S-14，W12：内部 API 误用/迟到 settle/竞态双 resolve 不覆写既有终态裁决）。
     *  actions 的「首达采纳后多步落地」（'executing' 占位 → 'done' 终局）是同一执行的
     *  显式逃生门：传 opts={claimedSettle:true} 放行已占位行的终局落定；除此之外任何
     *  已决行二次 resolve 一律拒绝。extra 不能覆盖 status/decision/resolvedAt。
     * @param {object} [opts.claimedSettle] - 仅 actions 用：放行对已终态行的终局落地 */
    resolve(key, decision, extra = {}, opts = {}) {
      const result = transition(
        key,
        (row) => {
          if (row === undefined) return { kind: 'missing' }
          if (row.status === statuses.resolved && opts.claimedSettle !== true) return { kind: 'already-resolved' }
          if (row.status === 'claimed' && opts.claimedSettle !== true) return { kind: 'already-claimed' }
          if (row.status !== statuses.pending && row.status !== 'claimed') return { kind: 'already-resolved' }
          return { kind: 'write' }
        },
        (row) => resolvedRowOf(row, decision, extra),
      )
      if (!result.ok) return 'storage-failed'
      if (result.kind === 'write') return true
      if (result.kind === 'already-claimed') return 'already-claimed'
      if (result.kind === 'already-resolved') return 'already-resolved'
      return false
    },
    /** 仅 pending 行可终止为 'terminated'（C2/P1-5 僵尸守卫）：已决/缺失行返回
     *  false，绝不改写。onAbandon / 会话销毁路径专用。 */
    terminate(key, extra = {}) {
      const row = store?.get(key)
      if (row === undefined || !isPending(row)) return false
      if (setDurable(store, key, resolvedRowOf(row, 'terminated', extra)) !== true) return 'storage-failed'
      return true
    },
    /**
     * v0.13（C11.5 / R5）：终态落地失败后的恢复标记（durable-first 的诚实退路）。
     * live 超时/错误已发生，但 durable 终态写入失败——绝不能伪装成已落盘的终态：
     * 尽力把行标成 `status:'uncertain'`（isPending 为假 → 重启/编号回复/自动重跑都不会
     * 再把它当作正常 live pending 消费），并附 reason/时间戳供诊断。
     * @returns {boolean} 标记是否真正落盘（false = 连恢复标记也失败，需上层告警）
     */
    markUncertain(key, reason = 'terminal-persist-failed', extra = {}) {
      const row = store?.get(key)
      if (row === undefined) return false
      return setDurable(store, key, {
        ...row,
        ...extra,
        status: 'uncertain',
        [decisionField]: 'uncertain',
        uncertainReason: String(reason),
        uncertainAt: now(),
      }) === true
    },
    /**
     * v0.13（C11.5 / R5）：终态清理的唯一收口（durable-first，绝不伪装成功）。
     * 先尝试 durable 终态写入；失败则尽力写恢复标记（markUncertain），使重启后不再
     * 把该行当作正常 live pending 消费。调用方据返回的 ok/uncertain 决定对外话术。
     * @returns {{ ok: boolean, uncertain: boolean, reason: string }}
     *   ok=true                       → durable 终态已落盘（含 already-resolved/already-claimed/missing 的无害情况）
     *   ok=false, uncertain=true      → 终态未落盘，行已标记 uncertain
     *   ok=false, uncertain=false     → 终态与恢复标记皆未落盘（上层必须告警）
     */
    settle(key, decision, extra = {}, opts = {}) {
      const result = this.resolve(key, decision, extra, opts)
      if (result === true) return { ok: true, uncertain: false, reason: 'resolved' }
      if (result === 'already-resolved' || result === 'already-claimed') return { ok: true, uncertain: false, reason: result }
      if (result === false) return { ok: true, uncertain: false, reason: 'missing' }
      const marked = this.markUncertain(key, 'terminal-persist-failed', extra)
      return { ok: false, uncertain: marked, reason: 'storage-failed' }
    },
    /** 按前缀扫描行键（latestPendingFor 遍历用；store 缺失返回空数组）。 */
    scanKeys() {
      return store?.keys(keyPrefix) ?? []
    },
  }
}
