// dsh-notifier adapter: wxpusher
// POST https://wxpusher.zjiecode.com/api/send/message（永久免费，扫码关注获取 appToken 与 UID）。
// 配置：appToken（secret）+ uids（接收者 UID 数组，至少一个）+ topicIds（可选主题）。text 发送最稳。

import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'wxpusher'

const ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message'

/** 归一化字符串数组：去空白、去空项。 */
function strArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const appToken = str(cfg.appToken)
  const uids = strArray(cfg.uids)
  const topicIds = strArray(cfg.topicIds)
  if (appToken === '') {
    throw new NotifyError('wxpusher 未配置：appToken（扫码关注 WxPusher 后获取，见 https://wxpusher.zjiecode.com）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  if (uids.length === 0 && topicIds.length === 0) {
    throw new NotifyError('wxpusher 未配置：uids（接收者 UID，至少一个）与 topicIds 均为空', ERROR_CODES.NOT_CONFIGURED)
  }
  return { appToken, uids, topicIds, timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000) }
}

/** 发送消息；wxpusher code !== 1000 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const body = {
    appToken: resolved.appToken,
    content: msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content,
    summary: msg.title,
    contentType: 1,
    uids: resolved.uids,
    topicIds: resolved.topicIds,
  }
  const response = await postJson(ENDPOINT, body, { timeoutMs: resolved.timeoutMs, channel: 'wxpusher' })
  const payload = await responseJson(response, 'wxpusher')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('wxpusher 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 1000) {
    const detail = payload.msg ?? '未知错误'
    throw new NotifyError(`wxpusher 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
