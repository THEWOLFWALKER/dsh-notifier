// dsh-notifier adapter: feishu
// 飞书自定义机器人：POST https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>。
// 可选「加签」模式：timestamp + "\n" + secret 做 HMAC-SHA256 后 base64（与钉钉算法相同，
// 但飞书不 URL 编码、timestamp 用秒）。用 interactive 卡片展示 title + markdown 正文。
// 配置：webhook（完整地址，secret）+ secret（可选加签密钥）。

import { createHmac } from 'node:crypto'
import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'feishu'

/** 飞书官方加签：stringToSign = timestamp + "\n" + secret；sign = base64(HmacSHA256)，秒级时间戳。 */
export function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64')
}

/** 秒级时间戳（字符串）。 */
export function feishuTimestamp(now = Date.now()) {
  return String(Math.floor(now / 1000))
}

/** 在 webhook 上追加 timestamp 与 sign（secret 为空则原样返回）。 */
export function signedUrl(webhook, secret, timestamp = feishuTimestamp()) {
  if (!secret) return webhook
  const sign = feishuSign(secret, timestamp)
  const sep = webhook.includes('?') ? '&' : '?'
  return `${webhook}${sep}timestamp=${timestamp}&sign=${sign}`
}

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const webhook = str(cfg.webhook)
  if (webhook === '') {
    throw new NotifyError('feishu 未配置：webhook（飞书机器人完整地址）未填写。可在飞书群 → 设置 → 群机器人 → 添加自定义机器人获取', ERROR_CODES.NOT_CONFIGURED)
  }
  return {
    webhook,
    secret: str(cfg.secret),
    // 分级语义对接（阶段 3）：timeSensitive 消息 @指定成员（open_id，需在飞书后台可查；默认关）
    atOpenId: str(cfg.atOpenId),
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 发送 interactive 卡片；飞书 code !== 0 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const url = signedUrl(resolved.webhook, resolved.secret || undefined)
  const atPrefix = resolved.atOpenId !== '' && msg.level === 'timeSensitive'
    ? `<at user_id="${resolved.atOpenId}"></at>\n`
    : ''
  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: msg.title } },
      elements: [{ tag: 'markdown', content: `${atPrefix}${msg.content}` }],
    },
  }
  const response = await postJson(url, body, { timeoutMs: resolved.timeoutMs, channel: 'feishu' })
  const payload = await responseJson(response, 'feishu')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('feishu 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 0) {
    const detail = payload.msg ?? '未知错误'
    throw new NotifyError(`feishu 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
