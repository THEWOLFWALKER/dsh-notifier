// dsh-notifier control-plane/questions.mjs
// v0.14（S04）：远程提问结算契约的共享应用服务（Native / 宿主原生桥共用单点）。
//
// 职责（编排 / 投影，不是权威）：
//  - pending()  当前待决问题的脱敏快照（唯一投影源；脱敏语义在桥内，本层不重做）
//  - settle()   唯一结算入口：委托问题桥 `adminSettle()`——授权 / 来源 / 策略 / 首达采纳 /
//               单次结算全部由桥 + Control Core 承接，本层绝不复制 ledger 结算、绝不直写状态
//
// 权威不变（I1）：`aq:` 账本与结算语义仍在 `src/questions/router.mjs` 的桥 + Control Core。
// 本模块把此前 Native（control-surface 投影）与 已退役的 HTTP 适配器各自持有的
// 「读待决 / 结算 / 归一化」重复编排收敛到一个入口（I9）。
//
// 失败语义：桥缺失或异常一律 fail-closed——pending 降级空表、settle 返回 not_available /
// settle_failed，绝不伪造成功（I2 / I16）。

const isRecord = (value) => typeof value === 'object' && value !== null

/**
 * 创建远程提问结算契约共享服务。
 * @param {object} [deps]
 * @param {object} [deps.bridge] - 问题桥（`src/questions/router.mjs` 的 createQuestionBridge
 *   返回面）带 `adminPending()` / `adminSettle()` facade；缺失时待决按空表降级、结算 fail-closed
 */
export function createQuestionsControlService({ bridge = null } = {}) {
  const hasBridge = isRecord(bridge)
  const canList = hasBridge && typeof bridge.adminPending === 'function'
  const canSettle = hasBridge && typeof bridge.adminSettle === 'function'

  /** 当前待决问题脱敏快照（读快照，绝不抛；无桥/异常返回空表）。 */
  function pending() {
    if (!canList) return []
    try {
      const rows = bridge.adminPending()
      return Array.isArray(rows) ? rows : []
    } catch { return [] }
  }

  /**
   * 唯一结算入口：归一化输入后委托桥 `adminSettle()`（首达采纳 / 单次结算由 Control Core 承接）。
   * 输入归一化只做「取字段 + options 归一为数组」，语义校验（ref/action/选项封闭集/来源目标）
   * 全部由桥内 adminSettle 承接，本层绝不重复校验或直写状态。
   * @returns {{ ok: boolean, handled?: boolean, reason?: string|null, message?: string, optionLabels?: string[], answers?: string[] }}
   */
  function settle(input = {}) {
    if (!canSettle) {
      return { ok: false, handled: false, reason: 'not_available', message: '问题桥未装配，无法结算远程提问' }
    }
    try {
      const result = bridge.adminSettle({
        ref: input?.ref,
        action: input?.action,
        options: Array.isArray(input?.options) ? input.options : [],
      })
      if (!isRecord(result)) {
        return { ok: false, handled: false, reason: 'no_result', message: '结算未返回可解释结果' }
      }
      return result
    } catch (error) {
      return { ok: false, handled: false, reason: 'settle_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  return { hasBridge, canList, canSettle, pending, settle }
}