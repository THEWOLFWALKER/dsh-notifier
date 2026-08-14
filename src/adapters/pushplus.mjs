// dsh-notifier adapter: pushplus
// POST https://www.pushplus.plus/send（扫码关注公众号获取 token，免费；code 200 表示已接收，异步投递）。
// 配置：token（secret）+ template（可选：html/txt/json/markdown，默认 markdown）+ topic（可选）。
// 微信渠道则用 channel: 'wechat'（需先关注推推公众号并绑定）。

import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'pushplus'

const ENDPOINT = 'https://www.pushplus.plus/send'

const TEMPLATES = new Set(['html', 'txt', 'json', 'markdown'])

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const token = str(cfg.token)
  if (token === '') {
    throw new NotifyError('pushplus 未配置：token（扫码关注推推公众号获取，见 https://www.pushplus.plus）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  const template = str(cfg.template) || 'markdown'
  return {
    token,
    template: TEMPLATES.has(template) ? template : 'markdown',
    topic: str(cfg.topic),
    channel: str(cfg.channel),
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 发送消息；pushplus code !== 200 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const body = {
    token: resolved.token,
    title: msg.title,
    content: msg.content,
    template: resolved.template,
  }
  if (resolved.topic !== '') body.topic = resolved.topic
  if (resolved.channel !== '') body.channel = resolved.channel
  const response = await postJson(ENDPOINT, body, { timeoutMs: resolved.timeoutMs, channel: 'pushplus' })
  const payload = await responseJson(response, 'pushplus')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('pushplus 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 200) {
    const detail = payload.msg ?? '未知错误'
    throw new NotifyError(`pushplus 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
