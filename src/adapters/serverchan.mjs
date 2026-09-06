// dsh-notifier adapter: serverchan
// Server酱（方糖）：POST <BASE>/<SENDKEY>.send，form 表单 title + desp(markdown)。
// 配置：sct（SENDKEY，扫码关注获取；兼容 sendKey/sctKey 别名）。响应 code 0 表示成功。
// G-09：SC3 企业版 SENDKEY 以 sctp 前缀区分，走 https://sctp.ftqq.com 域名；
// Turbo 版（SCT 前缀）维持 https://sctapi.ftqq.com。三别名同时配置时按
// sct > sendKey > sctKey 优先级取值并在 stderr 出声一次指明生效者。

import { postForm, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'serverchan'

const TURBO_BASE = 'https://sctapi.ftqq.com'
const SC3_BASE = 'https://sctp.ftqq.com'

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const sct = str(cfg.sct) || str(cfg.sendKey) || str(cfg.sctKey)
  if (sct === '') {
    throw new NotifyError('serverchan 未配置：sct（Server酱 SENDKEY，扫码关注获取，见 https://sct.ftqq.com）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  // SC3 企业版 key 以 sctp 开头（官方区分规则）；Turbo 版走 sctapi 域名
  const endpointBase = /^sctp/i.test(sct) ? SC3_BASE : TURBO_BASE
  // 别名冲突检测：多个别名同时配置且至少一个非空 → send() 首次调用 stderr 出声
  const present = []
  if (str(cfg.sct) !== '') present.push('sct')
  if (str(cfg.sendKey) !== '') present.push('sendKey')
  if (str(cfg.sctKey) !== '') present.push('sctKey')
  return {
    sct,
    endpointBase,
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
    // 运行态（不序列化）：待出声的别名冲突信息
    _aliasConflict: present.length > 1 ? present : null,
  }
}

/** 发送消息；serverchan code !== 0 时抛带中文指引的错误。 */
export async function send(resolved, msg) {
  if (resolved._aliasConflict !== null) {
    try {
      console.error(`[dsh-notifier/adapter:serverchan] sct/sendKey/sctKey 同时配置了多个（${resolved._aliasConflict.join('、')}），按 sct > sendKey > sctKey 优先级取 ${resolved._aliasConflict[0]}——请清理冗余配置避免认知分叉`)
    } catch { /* stderr 不可用不致命 */ }
    resolved._aliasConflict = null
  }
  const url = `${resolved.endpointBase}/${resolved.sct}.send`
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
