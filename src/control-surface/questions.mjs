// dsh-notifier control-surface/questions.mjs
// v0.14（S04）：Native `questions.list` / `questions.settle` 的 RPC 投影适配器。
//
// 本层只做「传输形态映射」：把共享 `QuestionsControlService` 的脱敏待决快照映射成 Native
// RPC 契约形状（{ multiple, options: [{value, label}] }），把结算结果映射成
// `{ settled, alreadyHandled }` 或带 code 的错误。读取 / 结算 / 归一化本身都在共享服务里，
// 本层不再自行触达问题桥（消除重复投影 / 校验入口，I9）。

/** 结算结果 → RPC 语义（首达胜出 = settled；已被他人裁决 = alreadyHandled；其余按 reason 分码）。 */
function settleView(result) {
  if (result?.ok === true || result?.settled === true) {
    return { settled: true, alreadyHandled: false }
  }
  if (result?.handled === true || result?.alreadyHandled === true) {
    return { settled: false, alreadyHandled: true }
  }
  const error = new Error(String(result?.message ?? '结算未生效'))
  if (result?.reason === 'expired') error.code = 'conflict'
  else if (result?.reason === 'unknown_question' || result?.reason === 'no_target') error.code = 'not-found'
  else if (result?.reason === 'invalid_action' || result?.reason === 'invalid_option') error.code = 'bad-request'
  else if (result?.reason === 'not_available') error.code = 'not-supported'
  // 桥内异常 / 不可解释返回 → RPC internal（绝不假成功，不降级成 conflict）
  else if (result?.reason === 'settle_failed' || result?.reason === 'no_result') error.code = 'internal'
  else error.code = 'conflict'
  throw error
}

/**
 * 从共享提问控制服务构造 Native RPC 投影。
 * @param {object} [deps]
 * @param {ReturnType<typeof import('../control-plane/questions.mjs').createQuestionsControlService>} [deps.service]
 *   - 共享提问控制服务（Native / 宿主桥共用同一实例）；缺失时按空表 / 不可用降级
 */
export function createQuestionProjection({ service = null } = {}) {
  const source = service ?? { pending: () => [], settle: () => ({ ok: false, handled: false, reason: 'not_available', message: '问题服务未装配' }) }
  return {
    list() {
      const rows = source.pending()
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        ref: String(row?.ref ?? ''),
        question: String(row?.question ?? ''),
        multiple: row?.multiSelect === true,
        options: (Array.isArray(row?.options) ? row.options : []).map((label, index) => ({
          value: String(index),
          label: String(label),
        })),
        status: 'pending',
        ...(Number.isFinite(Number(row?.expiresAt)) ? { expiresAt: new Date(Number(row.expiresAt)).toISOString() } : {}),
      }))
    },

    settle(payload = {}) {
      return settleView(source.settle(payload))
    },
  }
}
