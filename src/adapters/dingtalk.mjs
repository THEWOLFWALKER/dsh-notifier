// dsh-notifier adapter: dingtalk
// 钉钉自定义机器人：POST https://oapi.dingtalk.com/robot/send?access_token=<TOKEN>。
// 可选「加签」模式（HMAC-SHA256，算法见下方 computeDingTalkSign）。markdown 消息。
// 配置：webhook（完整地址，secret）+ secret（可选加签密钥）。

import { createHmac } from 'node:crypto'
import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'dingtalk'

/** 钉钉官方加签：stringToSign = timestamp + "\n" + secret；sign = urlencode(base64(HmacSHA256))。 */
export function computeDingTalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = createHmac('sha256', secret).update(stringToSign, 'utf8').digest()
  return encodeURIComponent(hmac.toString('base64'))
}

/** 当前毫秒时间戳（字符串）。 */
export function dingTalkTimestamp(now = Date.now()) {
  return String(Math.floor(now))
}

/** 在 webhook 上追加 timestamp 与 sign（secret 为空则原样返回）。 */
export function signedUrl(webhook, secret, timestamp = dingTalkTimestamp()) {
  if (!secret) return webhook
  const sign = computeDingTalkSign(secret, timestamp)
  const sep = webhook.includes('?') ? '&' : '?'
  return `${webhook}${sep}timestamp=${timestamp}&sign=${sign}`
}

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const webhook = str(cfg.webhook)
  if (webhook === '') {
    throw new NotifyError('dingtalk 未配置：webhook（钉钉机器人完整地址）未填写。可在钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义获取', ERROR_CODES.NOT_CONFIGURED)
  }
  return {
    webhook,
    secret: str(cfg.secret),
    // 分级语义对接（阶段 3）：timeSensitive 消息 @所有人（默认关，不改变基线行为）
    atAllOnTimeSensitive: cfg.atAllOnTimeSensitive === true,
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 发送 markdown 消息；钉钉 errcode !== 0 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const url = signedUrl(resolved.webhook, resolved.secret || undefined)
  const body = { msgtype: 'markdown', markdown: { title: msg.title, text: msg.content } }
  if (resolved.atAllOnTimeSensitive && msg.level === 'timeSensitive') {
    body.at = { isAtAll: true }
  }
  const response = await postJson(url, body, { timeoutMs: resolved.timeoutMs, channel: 'dingtalk' })
  const payload = await responseJson(response, 'dingtalk')
  if (typeof payload?.errcode !== 'number') {
    throw new NotifyError('dingtalk 返回格式异常：缺少 errcode', ERROR_CODES.API_ERROR)
  }
  if (payload.errcode !== 0) {
    const detail = payload.errmsg ?? '未知错误'
    if (payload.errcode === 310000) {
      throw new NotifyError('dingtalk 返回 310000（加签校验失败）：请检查 secret 是否与机器人「安全设置-加签」一致，或消息是否包含自定义关键词', ERROR_CODES.API_ERROR)
    }
    if (payload.errcode === 120001) {
      throw new NotifyError('dingtalk 返回 120001（access_token 失效）：webhook 里的 token 已过期或被重置，请到钉钉群重新复制机器人 webhook', ERROR_CODES.API_ERROR)
    }
    throw new NotifyError(`dingtalk 返回错误 ${payload.errcode}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
