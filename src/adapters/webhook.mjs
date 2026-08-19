// dsh-notifier adapter: webhook
// 通用自定义 webhook 兜底：POST JSON { title, content, timestamp, level?, group? }。
// 配置：url（必填）+ headers（可选，自定义鉴权头，整体视为 secret 不落日志）。

import { postJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'webhook'

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const url = str(cfg.url)
  if (url === '') {
    throw new NotifyError('webhook 未配置：url（接收 POST JSON 的 webhook 地址）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  const headers = cfg.headers !== null && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)
    ? cfg.headers
    : {}
  return { url, headers, timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000) }
}

/** 发送 JSON；非 2xx 抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const body = {
    title: msg.title,
    content: msg.content,
    timestamp: new Date().toISOString(),
  }
  if (msg.level !== undefined) body.level = msg.level
  if (msg.group !== undefined) body.group = msg.group
  await postJson(resolved.url, body, { headers: resolved.headers, timeoutMs: resolved.timeoutMs, channel: 'webhook' })
}
