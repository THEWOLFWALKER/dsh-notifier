// dsh-notifier adapter: feishu
// 飞书自定义机器人：POST https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>。
// 可选「加签」模式：飞书官方算法——HMAC key 取 stringToSign = timestamp + "\n" + secret，
// data 为空字符串，base64 后随请求 JSON body 的 timestamp/sign 字段一起发送（不放 URL，issue #8）。
// 用 interactive 卡片展示 title + markdown 正文。
// 配置：webhook（完整地址，secret）+ secret（可选加签密钥）。

import { createHmac } from 'node:crypto'
import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'feishu'

/**
 * 飞书官方加签：#8 修正。stringToSign = timestamp + "\n" + secret 是 HMAC 的 key（不是 message），
 * data 为空字符串；sign = base64(HmacSHA256)，秒级时间戳。与钉钉算法（secret 当 key、stringToSign 当 message）不同。
 */
export function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

/** 秒级时间戳（字符串）。 */
export function feishuTimestamp(now = Date.now()) {
  return String(Math.floor(now / 1000))
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
  // #8：飞书要求 timestamp/sign 随 JSON body 发送（不放 URL）；secret 为空时不加签名字段。
  if (resolved.secret) {
    const timestamp = feishuTimestamp()
    body.timestamp = timestamp
    body.sign = feishuSign(resolved.secret, timestamp)
  }
  const response = await postJson(resolved.webhook, body, { timeoutMs: resolved.timeoutMs, channel: 'feishu' })
  const payload = await responseJson(response, 'feishu')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('feishu 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 0) {
    const detail = payload.msg ?? '未知错误'
    throw new NotifyError(`feishu 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
