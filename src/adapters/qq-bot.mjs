// dsh-notifier adapter: qq-bot（QQ 官方机器人）
// 两步式：POST getAppAccessToken（appId+clientSecret）→ POST /v2/groups|users/<id>/messages。
// 鉴权头 `Authorization: QQBot <access_token>`；msg_seq 每条递增（服务端按 seq 去重）。
// Bot 维度 60qpm ≈ 1 条/秒：内置限速门；单群主动消息 1000 条/日（2026-06-22 官方文档确认开放）。
// 换 token 流程移植自 all-pusher-api（Apache-2.0）src/QQBot.ts，改写为零依赖 fetch。
// 注意：群/单聊「主动消息」需在 QQ 开放平台为机器人开启相应场景权限。

import { postJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'
import { createTokenManager, createRateGate } from './_tokens.mjs'

export const type = 'qq-bot'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const appId = str(cfg.appId)
  const appSecret = str(cfg.appSecret)
  const targetType = str(cfg.targetType) === 'user' ? 'user' : 'group'
  const targetId = str(targetType === 'user' ? cfg.userId : cfg.groupId)
  const missing = []
  if (appId === '') missing.push('appId（QQ 开放平台 q.qq.com → 机器人开发设置 → 开发者 ID/密钥）')
  if (appSecret === '') missing.push('appSecret（同一页面 AppSecret，secret 不落日志）')
  if (targetId === '') missing.push(targetType === 'user' ? 'userId（单聊目标用户的 openid）' : 'groupId（群 open id，机器人入群后在事件里获取）')
  if (missing.length > 0) {
    throw new NotifyError(`qq-bot 未配置：${missing.join('、')} 未填写`, ERROR_CODES.NOT_CONFIGURED)
  }
  return {
    appId,
    appSecret,
    targetType,
    targetId,
    apiBase: (str(cfg.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, ''),
    timeoutMs: num(cfg.timeoutMs, 10000, 1000, 60000),
    rateMs: num(cfg.rateMs, 1050, 0, 60000),
    // 运行态（不序列化）：token 管理器 / 限速门 / msg_seq 计数
    _tokenManager: undefined,
    _rateGate: undefined,
    _msgSeq: 0,
  }
}

/** 发送主动消息（msg_type 0 纯文本）。2xx 即成功；4xx 带 {code,message} 抛中文指引。 */
export async function send(resolved, msg) {
  resolved._tokenManager ??= createTokenManager(async () => {
    const response = await postJson(TOKEN_URL, { appId: resolved.appId, clientSecret: resolved.appSecret }, {
      timeoutMs: resolved.timeoutMs, channel: 'qq-bot',
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new NotifyError('qq-bot 换取 access_token 失败：返回非 JSON', ERROR_CODES.API_ERROR)
    }
    if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new NotifyError(`qq-bot 换取 access_token 失败：检查 appId/appSecret 是否正确（q.qq.com 开发设置页）`, ERROR_CODES.API_ERROR)
    }
    return { token: payload.access_token, expiresInMs: (Number(payload.expires_in) || 7200) * 1000 }
  })
  resolved._rateGate ??= createRateGate(resolved.rateMs)

  const token = await resolved._tokenManager.get()
  await resolved._rateGate.gate()
  // v0.6.5（审查 R4-3-P3-4）：msg_seq 是服务端去重键。原实现每次尝试自增——重试时
  // seq 变化 = 服务端视为新消息，「第一次超时但实际已投递」的消息会被重复投递。
  // 改为尝试期间 seq 冻结（计数器不动），成功后才推进；下一条内容不同，
  // 即使撞 seq 也不会被服务端误去重（QQ 去重需 seq+内容双匹配）。
  const seq = (resolved._msgSeq + 1) % 1000000
  const url = resolved.targetType === 'user'
    ? `${resolved.apiBase}/v2/users/${resolved.targetId}/messages`
    : `${resolved.apiBase}/v2/groups/${resolved.targetId}/messages`
  const response = await postJson(url, {
    content: msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content,
    msg_type: 0,
    msg_seq: seq,
  }, {
    headers: { authorization: `QQBot ${token}` },
    timeoutMs: resolved.timeoutMs,
    channel: 'qq-bot',
  })
  // v2 接口成功返回 2xx JSON {id, timestamp}；错误码在 HTTP 4xx body {code, message}
  let payload = null
  try { payload = await response.json() } catch { /* 2xx 非 JSON 也视为成功 */ }
  if (payload !== null && typeof payload?.code === 'string' && payload.code !== '') {
    throw new NotifyError(`qq-bot 返回错误 ${payload.code}: ${payload.message ?? '未知错误'}（确认机器人已开启${resolved.targetType === 'user' ? '单聊主动消息' : '群主动消息'}权限）`, ERROR_CODES.API_ERROR)
  }
  resolved._msgSeq = seq // 成功才推进：失败/超时重试沿用同一 seq，幂等语义生效
}
