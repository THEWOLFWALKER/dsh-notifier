// dsh-notifier inbound/segment.mjs
// 出站收敛分段：手机渠道对长文本有截断（Telegram 4096、多数 IM 2000+ 但推送缩略更短），
// 超预算文本按 1200 Unicode 码点切成多段，每段带 `（i/n）` 前缀；前缀长度计入预算
// （递归收敛：先估 n → 算前缀 → 切分 → 段数若涨再重切，两轮内必收敛）。
// 切分偏好：段预算内的最后一个换行 > 最后一个空格 > 硬切。

/** Unicode 码点计数（代理对算 1）。 */
export function countCodepoints(text) {
  return Array.from(String(text ?? '')).length
}

/** 在 budget 码点内找最佳切点：换行 > 空格 > 硬切。返回 [head, rest]。 */
function splitOnce(chars, budget) {
  const head = chars.slice(0, budget)
  const hardCut = () => [head, chars.slice(budget)]
  if (chars.length <= budget) return [chars, []]
  let at = -1
  for (let i = head.length - 1; i > 0; i -= 1) {
    if (head[i] === '\n') { at = i + 1; break }
  }
  if (at === -1) {
    for (let i = head.length - 1; i > 0; i -= 1) {
      if (head[i] === ' ') { at = i + 1; break }
    }
  }
  if (at <= 0) return hardCut()
  return [head.slice(0, at), chars.slice(at)]
}

/**
 * 把长文本切成 ≤ maxCodepoints（含前缀）的多段。
 * @returns {string[]} 段数组；空文本返回 ['']；预算装不下前缀时退化为整段不切（渠道自己截断）。
 */
export function segmentText(text, { maxCodepoints = 1200 } = {}) {
  const raw = String(text ?? '')
  const chars = Array.from(raw)
  if (chars.length === 0) return ['']
  if (chars.length <= maxCodepoints) return [raw] // 短文本不加前缀，零开销
  let n = Math.max(1, Math.ceil(chars.length / maxCodepoints))
  for (let round = 0; round < 8; round += 1) {
    // 前缀按最长形式（n 为最大段号）估算，所有段同长前缀，预算保守
    const prefixLen = Array.from(`（${n}/${n}）`).length
    const budget = maxCodepoints - prefixLen
    if (budget <= 0) return [raw] // 上限过小（装不下前缀），退化为整段
    const parts = []
    let rest = chars
    while (rest.length > 0) {
      const [head, tail] = splitOnce(rest, budget)
      parts.push(head.join(''))
      rest = tail
    }
    if (parts.length <= n) {
      return parts.map((part, i) => `（${i + 1}/${parts.length}）${part}`)
    }
    n = parts.length // 前缀挤占预算导致段数变多：用新段数重算前缀再切（收敛）
  }
  return [raw] // 8 轮仍不收敛（数学上不会发生）：宁可整段也不死循环
}

/**
 * 分段发送一条消息到某渠道：预算内一次发送；超预算按 segmentText 切段顺序发送。
 * title 只出现在第一段；任何一段失败即整体失败（部分送达会在返回值中说明）。
 * @returns {{ sent: number, total: number, error?: Error }} sent = 成功段数
 */
export async function sendSegmented(send, msg, { maxCodepoints = 1200 } = {}) {
  const title = typeof msg?.title === 'string' ? msg.title : ''
  const content = typeof msg?.content === 'string' ? msg.content : ''
  const merged = title.length > 0 && content.length > 0 ? `${title}\n\n${content}` : (title || content)
  const segments = segmentText(merged, { maxCodepoints })
  let sent = 0
  let lastError = null
  for (let i = 0; i < segments.length; i += 1) {
    const piece = {
      ...msg,
      // 单段：title/content 原样透传（零开销）；多段：title 已并入首段文本，不再重复渲染
      title: segments.length === 1 ? title : '',
      content: segments.length === 1 ? content : segments[i],
    }
    try {
      await send(piece)
      sent += 1
    } catch (error) {
      lastError = error
      break // 顺序送达：前段失败即停（后段失去上下文意义）
    }
  }
  return { sent, total: segments.length, error: lastError }
}
