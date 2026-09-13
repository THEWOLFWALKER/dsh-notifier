// dsh-notifier verdict-text.mjs
// G-54（J 轮审查）：按钮/回执失败话术按裁决原因分层。此前 TG 与飞书把 N 种校验失败
// 折叠成一句「该审批已处理或已过期（token 单次核销）」——用户以为 token 过期或已被
// 裁决，排障方向被带偏（实际可能是来源会话不符、凭证缺失、key 不匹配）。
// 消费 bus.decide / control.handle 返回的 reason 枚举，不改动枚举本身（W7 纪律）。
// 文案约束：面向最终用户，不含内部标识符（token/approvalKey/eventId）、不含渠道键拼句。
//
// lang: 'zh' | 'en'：手机可见文案来自 strings 表 `verdict` 节（event-listener.mjs 同法，
// strings 全表经末位可选参数传入）。zh 兜底取 stringsOf()（单一事实源，无内联副本）
// 与 strings.mjs 的 zh 逐字节一致；调用方未传 strings（既有适配器/测试）时保持 zh 不变。

import { stringsOf } from '../strings.mjs'

/** zh 兜底：strings.verdict（单一事实源；调用方未传 strings 时使用）。 */
const ZH_VERDICT = stringsOf().verdict

/**
 * 按裁决失败原因取用户话术。
 * @param {string|null|undefined} reason - bus.decide / control.handle 的失败 reason。
 * @param {string} [kind] - 'approval'（默认）| 'question'——两类卡片措辞略不同。
 * @param {string} [fallback] - reason 缺失/未登记时的兜底文案。
 * @param {object} [strings] - stringsOf(lang) 全文案表（读 `verdict` 节；缺省 zh 兜底）。
 * @returns {string} 用户可读话术。
 */
export function verdictFailureText(reason, kind = 'approval', fallback, strings = null) {
  const t = strings?.verdict ?? ZH_VERDICT
  const noun = kind === 'question' ? t.nounQuestion : t.nounApproval
  switch (reason) {
    case 'token-required':
      return t.tokenRequired
    case 'key-mismatch':
      return t.keyMismatch
    case 'source-chat-mismatch':
      return t.sourceChatMismatch
    case 'already-resolved':
      return t.alreadyResolved(noun)
    case 'expired':
      return t.expired(noun)
    case 'invalid-decision':
      return t.invalidDecision
    default:
      return fallback ?? t.notFound(noun)
  }
}

/**
 * 卡片承载缺失时的专用话术（G-54：TG query.message 缺失 = 原卡片消息被删，
 * 旧实现落进「请到原会话操作」误导用户去找一个不存在的会话）。
 * @param {object} [strings] - stringsOf(lang) 全文案表（读 `verdict` 节；缺省 zh 兜底）。
 */
export function cardMissingText(strings = null) {
  const t = strings?.verdict ?? ZH_VERDICT
  return t.cardMissing
}
