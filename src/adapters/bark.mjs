// dsh-notifier adapter: bark
// Bark V2 JSON POST：endpoint = <server>/<key>，body { title, body, group?, level? }。
// 配置：key（设备 key，secret）+ server（可选，默认 https://api.day.app）。endpoint 整体视为秘密。
// 兼容直接给完整 endpoint（barkUrl）的写法。

import { postJson, responseJson, str, num, NotifyError, ERROR_CODES } from './_shared.mjs'

export const type = 'bark'

const DEFAULT_SERVER = 'https://api.day.app'

const LEVELS = new Set(['passive', 'active', 'timeSensitive', 'critical'])

/** 拼接并归一化 Bark endpoint：trim、去尾斜杠；key 缺失返回空串。 */
export function barkEndpoint({ server, key, barkUrl }) {
  const full = str(barkUrl)
  if (full !== '') return full.replace(/\/+$/, '')
  const keyPart = str(key)
  if (keyPart === '') return ''
  const serverPart = (str(server) || DEFAULT_SERVER).replace(/\/+$/, '')
  return `${serverPart}/${keyPart}`
}

/** 校验并归一化配置；缺失抛中文指引。 */
export function resolve(cfg = {}) {
  const endpoint = barkEndpoint(cfg)
  if (endpoint === '') {
    throw new NotifyError('bark 未配置：key（Bark 设备 key，App 内获取）未填写', ERROR_CODES.NOT_CONFIGURED)
  }
  return { endpoint, timeoutMs: num(cfg.timeoutMs, 5000, 1000, 60000) }
}

/** 发送通知；Bark 返回 code !== 200 时抛带中文指引的错误。endpoint 不写进错误信息（携带 key）。 */
export async function send(resolved, msg) {
  const body = { title: msg.title, body: msg.content }
  if (msg.group !== undefined) body.group = msg.group
  if (msg.level !== undefined && LEVELS.has(msg.level)) body.level = msg.level
  const response = await postJson(resolved.endpoint, body, { timeoutMs: resolved.timeoutMs, channel: 'bark' })
  const payload = await responseJson(response, 'bark')
  if (typeof payload?.code !== 'number') {
    throw new NotifyError('bark 返回格式异常：缺少 code', ERROR_CODES.API_ERROR)
  }
  if (payload.code !== 200) {
    const detail = payload.message ?? '未知错误'
    throw new NotifyError(`bark 返回错误 ${payload.code}: ${detail}`, ERROR_CODES.API_ERROR)
  }
}

/** 脱敏显示：endpoint 携带 key，只回「已配置」事实 + 末 4 位。 */
export function maskEndpoint(endpoint) {
  const normalized = str(endpoint)
  if (normalized === '') return { configured: false, masked: '' }
  return { configured: true, masked: `••••••••${normalized.slice(-4)}` }
}
