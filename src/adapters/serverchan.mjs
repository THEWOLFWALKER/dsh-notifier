// dsh-notifier adapter: serverchan
// Server酱（方糖）：POST https://sctapi.ftqq.com/<SENDKEY>.send，form 表单 title + desp(markdown)。
// 配置：sct（SENDKEY，扫码关注获取；兼容 sendKey/sctKey 别名）。响应 code 0 表示成功。

import { postForm, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'serverchan'

const ENDPOINT_BASE = 'https://sctapi.ftqq.com'

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const sct = str(cfg.sct) || str(cfg.sendKey) || str(cfg.sctKey)
  if (sct === '') {
    throw new NotifyError('serverchan 未配置：sct（Server酱 SENDKEY，扫码关注获取，见 https://sct.ftqq.com）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  return { sct, timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000) }
}

/** 发送消息；serverchan code !== 0 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  const url = `${ENDPOINT_BASE}/${resolved.sct}.send`
  const form = { title: msg.title, desp: msg.content }
  const response = await postForm(url, form, { timeoutMs: resolved.timeoutMs, channel: 'serverchan' })
  const payload = await responseJson(response, 'serverchan')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('serverchan 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 0) {
    const detail = payload.message ?? '未知错误'
    throw new NotifyError(`serverchan 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}
