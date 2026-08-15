// dsh-notifier adapter: wecom-app（企业微信应用消息）
// 两步式：GET gettoken（corpid+secret）→ POST message/send（touser + agentid）。
// token 经 createTokenManager 缓存并在到期前刷新；40014/42001 失效时作废重试一次。
// 端点/body/成功判定语义移植自 push-all-in-one（MIT）src/push/wechat-app.ts，改写为零依赖 fetch。

import { postJson, getJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'
import { createTokenManager } from './_tokens.mjs'

export const type = 'wecom-app'

const TOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
const SEND_URL = 'https://qyapi.weixin.qq.com/cgi-bin/message/send'
const INVALID_TOKEN_CODES = new Set([40014, 42001])

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const corpid = str(cfg.corpid)
  const secret = str(cfg.secret)
  const agentId = cfg.agentId
  const missing = []
  if (corpid === '') missing.push('corpid（企业 ID，企业微信管理后台「我的企业」页）')
  if (secret === '') missing.push('secret（应用 Secret，管理后台「应用管理」→ 对应应用页）')
  if (agentId === undefined || !Number.isFinite(Number(agentId))) missing.push('agentId（应用 AgentId，同一页面顶部，数字）')
  if (missing.length > 0) {
    throw new NotifyError(`wecom-app 未配置：${missing.join('、')} 未填写`, ERROR_CODES.NOT_CONFIGURED)
  }
  return {
    corpid,
    secret,
    agentId: Number(agentId),
    touser: str(cfg.touser) || '@all',
    msgtype: str(cfg.msgtype) === 'markdown' ? 'markdown' : 'text',
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
  }
}

/** 发送文本/markdown 应用消息；errcode !== 0 抛中文指引，token 失效自动换新重试一次。 */
export async function send(resolved, msg) {
  // 每条 resolved 配置独立 token 管理器（resolve 一次、send 多次，缓存随 resolved 存活）
  resolved._tokenManager ??= createTokenManager(async () => {
    const url = `${TOKEN_URL}?corpid=${encodeURIComponent(resolved.corpid)}&corpsecret=${encodeURIComponent(resolved.secret)}`
    const response = await getJson(url, { timeoutMs: resolved.timeoutMs, channel: 'wecom-app' })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new NotifyError('wecom-app 换取 access_token 失败：返回非 JSON', ERROR_CODES.API_ERROR)
    }
    if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new NotifyError(`wecom-app 换取 access_token 失败（${payload?.errcode ?? '无码'}）: ${payload?.errmsg ?? '检查 corpid 与 secret 是否匹配'}`, ERROR_CODES.API_ERROR)
    }
    return { token: payload.access_token, expiresInMs: (payload.expires_in ?? 7200) * 1000 }
  })

  const body = {
    touser: resolved.touser,
    msgtype: resolved.msgtype,
    agentid: resolved.agentId,
    [resolved.msgtype]: { content: msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content },
  }

  const attempt = async (token) => {
    const url = `${SEND_URL}?access_token=${encodeURIComponent(token)}`
    const response = await postJson(url, body, { timeoutMs: resolved.timeoutMs, channel: 'wecom-app' })
    try {
      return await response.json()
    } catch {
      throw new NotifyError(`wecom-app 返回非 JSON 响应（HTTP ${response.status}）`, ERROR_CODES.API_ERROR)
    }
  }

  let payload = await attempt(await resolved._tokenManager.get())
  if (payload?.errcode !== 0 && INVALID_TOKEN_CODES.has(payload?.errcode)) {
    payload = await attempt(await resolved._tokenManager.get(true))
  }
  if (payload?.errcode !== 0) {
    const hint = payload?.errcode === 40056 ? '（agentid 不匹配：确认 AgentId 属于该 Secret 对应的应用）' : ''
    throw new NotifyError(`wecom-app 返回错误 ${payload?.errcode ?? '(无码)'}: ${payload?.errmsg ?? '未知错误'}${hint}`, ERROR_CODES.API_ERROR)
  }
}
