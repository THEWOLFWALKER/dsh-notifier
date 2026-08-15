// dsh-notifier health.mjs
// 渠道健康自检核心（阶段 6）：真机验证一个渠道的「resolve → send」全链路。
// scripts/test-channel.mjs 是它的 CLI 壳；notify_test agent 工具走 notifier（带路由），
// 这里走裸 adapter——配置错了能拿到最原始的中文错误（去哪里拿凭证）。

import { ADAPTERS, CHANNEL_TYPES, resolveEnvRefs } from './config.mjs'

export const TEST_MESSAGE = 'dsh-notifier 渠道自检：这是一条测试消息，收到即说明该渠道配置正确。'

/**
 * 真机验证单个渠道。
 * @param {object} params
 * @param {string} params.type - 渠道类型（ADAPTERS 键）。
 * @param {object} params.rawConfig - 原始渠道配置（支持 ${ENV:NAME} 引用，发送前解析）。
 * @param {string} [params.message] - 自定义测试正文。
 * @returns {Promise<{ ok: boolean, channel: string, detail: string }>}
 */
export async function runChannelTest({ type, rawConfig, message } = {}) {
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
      title: 'dsh-notifier 自检',
      content: typeof message === 'string' && message !== '' ? message : TEST_MESSAGE,
      level: 'active',
    })
    return { ok: true, channel, detail: '已发送测试消息，请到客户端确认收到' }
  } catch (error) {
    return { ok: false, channel, detail: `发送失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
