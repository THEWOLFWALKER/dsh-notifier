// dsh-notifier delivery-evidence.mjs
// v0.13（C11.5 / R4）：投递证据的唯一权威词汇。
//
// 背景：旧实现把「发送未抛错（provider 接受了请求）」直接标成「已送达」。
// 这只证明请求被提供方接收，没有任何端到端送达证据。本模块把两级证据固定下来：
//   accepted  —— provider 接受了请求（正常成功，无送达证据）
//   confirmed —— provider 返回了显式回执（唯一可称「已确认送达」的依据）
// notify / control-surface health / activity / admin UI 全部消费同一词汇，
// 不得再用 legacy `delivered` 推断真正送达（I1：一个事实一个权威）。

/**
 * 适配器返回值是否携带显式回执。
 * 约定：send() resolve 出 { confirmed: true } 或 { receipt: true } 即视为确认送达；
 * 其余（含 resolve undefined / 普通响应对象）一律只是 provider accepted。
 */
export function isConfirmedReceipt(value) {
  return value?.confirmed === true || value?.receipt === true
}

/**
 * 把投递记录/发送结果归一为两级证据。
 * - 显式 accepted/confirmed 优先；
 * - legacy 记录只有 delivered（旧语义 = 发送 resolve）——按 accepted 归类，绝不是 confirmed；
 * - 缺省返回空数组（不抛错，消费方安全）。
 * @returns {{ accepted: string[], confirmed: string[] }}
 */
export function normalizeDeliveryEvidence(record = {}) {
  const accepted = Array.isArray(record?.accepted)
    ? record.accepted
    : (Array.isArray(record?.delivered) ? record.delivered : [])
  const confirmed = Array.isArray(record?.confirmed) ? record.confirmed : []
  return { accepted, confirmed }
}