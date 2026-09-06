// dsh-notifier verdict-text.mjs
// G-54（J 轮审查）：按钮/回执失败话术按裁决原因分层。此前 TG 与飞书把 N 种校验失败
// 折叠成一句「该审批已处理或已过期（token 单次核销）」——用户以为 token 过期或已被
// 裁决，排障方向被带偏（实际可能是来源会话不符、凭证缺失、key 不匹配）。
// 消费 bus.decide / control.handle 返回的 reason 枚举，不改动枚举本身（W7 纪律）。
// 文案约束：面向最终用户，不含内部标识符（token/approvalKey/eventId）、不含渠道键拼句。

/**
 * 按裁决失败原因取用户话术。
 * @param {string|null|undefined} reason - bus.decide / control.handle 的失败 reason。
 * @param {string} [kind] - 'approval'（默认）| 'question'——两类卡片措辞略不同。
 * @param {string} [fallback] - reason 缺失/未登记时的兜底文案。
 * @returns {string} 用户可读话术。
 */
export function verdictFailureText(reason, kind = 'approval', fallback) {
  const noun = kind === 'question' ? '该提问' : '该审批'
  switch (reason) {
    case 'token-required':
      return '本次操作缺少有效凭证，请回到发起操作的会话重新点击'
    case 'key-mismatch':
      return '操作与目标不匹配，请回到原卡片操作'
    case 'source-chat-mismatch':
      return '请到原会话操作'
    case 'already-resolved':
      return `${noun}已处理，无需重复操作`
    case 'expired':
      return `${noun}已过期，请重新发起`
    case 'invalid-decision':
      return '无效的操作类型'
    default:
      return fallback ?? `${noun}已处理或已过期`
  }
}

/**
 * 卡片承载缺失时的专用话术（G-54：TG query.message 缺失 = 原卡片消息被删，
 * 旧实现落进「请到原会话操作」误导用户去找一个不存在的会话）。
 */
export function cardMissingText() {
  return '原消息可能已被删除，无法在此展示结果；操作结果以台账为准'
}
