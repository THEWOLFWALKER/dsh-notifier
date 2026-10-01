// Shared endpoint/header contract for every Telegram RPC, including long polling.
import { NotifyError, ERROR_CODES } from '../adapters/_shared.mjs'
export function telegramRequest(config, method) {
  const base = String(config.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')
  const key = String(config.gatewayKey ?? '').trim()
  if (!key) return { url: `${base}/bot${config.botToken}/${method}`, headers: {} }
  if (key !== String(config.botToken ?? '').trim()) throw new NotifyError('机器人凭证已更换，请重新开启网关', ERROR_CODES.NOT_CONFIGURED)
  let endpoint
  try { endpoint = new URL(base) } catch { throw new NotifyError('Telegram 网关地址无效', ERROR_CODES.NOT_CONFIGURED) }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.origin === 'https://api.telegram.org') {
    throw new NotifyError('Telegram 网关必须使用独立 HTTPS 地址', ERROR_CODES.NOT_CONFIGURED)
  }
  return { url: `${base}/api/${method}`, headers: { 'x-notifier-gateway-key': key } }
}
export function gatewayAuthFailed(response) { return response?.headers?.get?.('x-notifier-gateway-error') === 'auth' }
