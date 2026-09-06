// dsh-notifier adapter: webhook
// 通用自定义 webhook 兜底：POST JSON { title, content, timestamp, level?, group? }。
// 配置：url（必填）+ headers（可选，自定义鉴权头，整体视为 secret 不落日志）
//     + allowPrivateNetwork（可选，默认 false；内网/本机接收端需显式开启，见 _urlguard.mjs）。
// S-02（CWE-918）：url 是全项目用户自由度最大的出站目标（任意 scheme 之外的任意主机），
// 发送前强制走 SSRF 校验；重定向面由 _shared.mjs 的 redirect:'manual' 关闭。

import { postJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'
import { assertPublicHttpUrl } from './_urlguard.mjs'

export const type = 'webhook'

function warn(message) {
  try { console.error('[dsh-notifier/webhook]', message) } catch { /* 控制台不可用不致命 */ }
}

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const url = str(cfg.url)
  if (url === '') {
    throw new NotifyError('webhook 未配置：url（接收 POST JSON 的 webhook 地址）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  // G-63：headers 值归一 String——YAML 里 `port: 8080` 这类裸数字会被 fetch Headers
  // 构造器直接抛 TypeError（整条通知炸在半路），归一后仍保持用户声明的键名与文本语义；
  // 值是对象/数组的头没有合理文本形态，warn 后丢弃（绝不可能"猜"出一个值发出去）。
  const rawHeaders = cfg.headers !== null && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)
    ? cfg.headers
    : {}
  const headers = {}
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key === '') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      headers[key] = String(value)
      if (typeof value !== 'string') {
        warn(`webhook headers.${key} 是 ${typeof value}，已转字符串 "${String(value)}" 发送`)
      }
    } else {
      warn(`webhook headers.${key} 不是标量（${typeof value}），已丢弃`)
    }
  }
  return {
    url,
    headers,
    // S-02 逃生口：内网自托管接收端显式声明（布尔，非字符串宽进）
    allowPrivateNetwork: cfg.allowPrivateNetwork === true,
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 发送 JSON；发送前过 SSRF 闸；非 2xx 抛带中文指引的错误。 */
export async function send(resolved, msg) {
  await assertPublicHttpUrl(resolved.url, { allowPrivate: resolved.allowPrivateNetwork === true, channel: 'webhook' })
  const body = {
    title: msg.title,
    content: msg.content,
    timestamp: new Date().toISOString(),
  }
  if (msg.level !== undefined) body.level = msg.level
  if (msg.group !== undefined) body.group = msg.group
  await postJson(resolved.url, body, { headers: resolved.headers, timeoutMs: resolved.timeoutMs, channel: 'webhook' })
}
