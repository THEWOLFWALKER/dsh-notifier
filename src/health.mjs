// dsh-notifier health.mjs
// 渠道健康自检核心（阶段 6）：真机验证一个渠道的「resolve → send」全链路。
// scripts/channel-selfcheck.mjs（G-57：原 test-channel.mjs 重命名）是它的 CLI 壳；notify_test agent 工具走 notifier（带路由），
// 这里走裸 adapter——配置错了能拿到最原始的中文错误（去哪里拿凭证）。

import { ADAPTERS, CHANNEL_TYPES, resolveEnvRefs } from './config.mjs'
// lang 文案表：自检推送的 title/正文取词（zh 兜底，既有调用方零感知）
import { stringsOf } from './strings.mjs'

export const TEST_MESSAGE = stringsOf().health.testMessage

/**
 * 真机验证单个渠道。
 * @param {object} params
 * @param {string} params.type - 渠道类型（ADAPTERS 键）。
 * @param {object} params.rawConfig - 原始渠道配置（支持 ${ENV:NAME} 引用，发送前解析）。
 * @param {string} [params.message] - 自定义测试正文。
 * @param {object} [params.strings] - stringsOf(lang) 全文案表（读 health 节；缺省 zh）。
 * @returns {Promise<{ ok: boolean, channel: string, detail: string }>}
 */
export async function runChannelTest({ type, rawConfig, message, strings = null } = {}) {
  const h = strings?.health ?? stringsOf().health
  const channel = typeof type === 'string' ? type.trim() : ''
  if (channel === '' || ADAPTERS[channel] === undefined) {
    return { ok: false, channel, detail: `未知渠道 "${channel || '(空)'}"（可用：${CHANNEL_TYPES.join('/')}）` }
  }
  let resolved
  try {
    resolved = ADAPTERS[channel].resolve(resolveEnvRefs(rawConfig ?? {}))
  } catch (error) {
    return { ok: false, channel, detail: `配置校验失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await ADAPTERS[channel].send(resolved, {
      title: h.title,
      content: typeof message === 'string' && message !== '' ? message : h.testMessage,
      level: 'active',
    })
    return { ok: true, channel, detail: '已发送测试消息，请到客户端确认收到' }
  } catch (error) {
    // G-53 分层：admin UI / 工具反馈只见公开文案；完整内部细节（响应体/网络原文）
    // 双写 stderr，运维排障不丢信息。公开文案不含 HTTP 原文与底层 message。
    const publicText = error instanceof Error ? (error.publicMessage ?? error.message) : String(error)
    const internalDetail = error instanceof Error ? (error.detail ?? error.message) : String(error)
    try {
      console.error(`[dsh-notifier/health] 渠道 "${channel}" 自检失败详情: ${internalDetail}`)
    } catch { /* stderr 不可用不致命 */ }
    return { ok: false, channel, detail: `发送失败：${publicText}` }
  }
}
