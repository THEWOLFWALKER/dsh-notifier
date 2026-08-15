// dsh-notifier adapter: telegram
// POST https://api.telegram.org/bot<TOKEN>/sendMessage，纯文本发送（不设 parse_mode，
// 对任意 markdown/普通文本最稳）。配置：botToken（@BotFather 获取，secret）+ chatId。

import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'telegram'

const DEFAULT_API_BASE = 'https://api.telegram.org'

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const botToken = str(cfg.botToken)
  const chatId = str(cfg.chatId)
  const missing = []
  if (botToken === '') missing.push('botToken（Telegram Bot Token，@BotFather 获取）')
  if (chatId === '') missing.push('chatId（接收者的 chat id，可向 @userinfobot 查询）')
  if (missing.length > 0) {
    throw new NotifyError(`telegram 未配置：${missing.join('、')} 未填写`, ERROR_CODES.NOT_CONFIGURED)
  }
  const apiBase = (str(cfg.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, '')
  return { botToken, chatId, apiBase, timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000) }
}

/** 发送一条通知到指定 chat。msg.silent（路由覆盖）映射为原生 disable_notification：静默送达不响铃。 */
export async function send(resolved, msg) {
  const url = `${resolved.apiBase}/bot${resolved.botToken}/sendMessage`
  const body = {
    chat_id: resolved.chatId,
    text: msg.title.length > 0 ? `${msg.title}\n\n${msg.content}` : msg.content,
    disable_web_page_preview: true,
    ...(msg.silent === true ? { disable_notification: true } : {}),
  }
  const response = await postJson(url, body, { timeoutMs: resolved.timeoutMs, channel: 'telegram' })
  const payload = await responseJson(response, 'telegram', { requireKey: 'ok', successValue: true })
  if (payload?.result === undefined) {
    throw new NotifyError('telegram 返回格式异常：缺少 result', ERROR_CODES.API_ERROR)
  }
}
