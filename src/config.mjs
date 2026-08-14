// dsh-notifier config.mjs
// channels[] 配置解析 + 密钥脱敏。
// 设计要点：
//  - 配置来源：profile cordis.patch.yml 中 dsh-notifier 行的 config（cordis 原样传入 apply）。
//  - 每个渠道一行 { type, enabled?, ...字段 }，未配置渠道静默跳过（加载期仅 warn，绝不弄崩启动，学 dsh-email）。
//  - 密钥字段不落日志：SECRET_FIELDS 声明每渠道的 secret 键，诊断日志只回「已配置」事实与末 4 位。

import { NotifyError, ERROR_CODES } from './adapters/_shared.mjs'
import * as telegram from './adapters/telegram.mjs'
import * as dingtalk from './adapters/dingtalk.mjs'
import * as feishu from './adapters/feishu.mjs'
import * as wxpusher from './adapters/wxpusher.mjs'
import * as pushplus from './adapters/pushplus.mjs'
import * as serverchan from './adapters/serverchan.mjs'
import * as bark from './adapters/bark.mjs'
import * as webhook from './adapters/webhook.mjs'

/** adapter 注册表：type -> { type, resolve, send }。 */
export const ADAPTERS = Object.freeze({
  telegram,
  dingtalk,
  feishu,
  wxpusher,
  pushplus,
  serverchan,
  bark,
  webhook,
})

export const CHANNEL_TYPES = Object.freeze(Object.keys(ADAPTERS))

/** 每渠道的 secret 键：这些字段在日志/诊断里必须脱敏。 */
const SECRET_FIELDS = {
  telegram: ['botToken'],
  dingtalk: ['webhook', 'secret'],
  feishu: ['webhook', 'secret'],
  wxpusher: ['appToken', 'uids', 'topicIds'],
  pushplus: ['token'],
  serverchan: ['sct', 'sendKey', 'sctKey'],
  bark: ['key', 'barkUrl'],
  webhook: ['url', 'headers'],
}

/** 取某渠道的 secret 键列表（未知渠道返回空数组）。 */
export function secretFieldsOf(type) {
  return SECRET_FIELDS[type] ?? []
}

/** 归一化一条通知消息：确保 title/content 为字符串，补齐 level/group。 */
export function normalizeMessage(msg = {}) {
  const raw = msg ?? {}
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  const level = typeof raw.level === 'string' ? raw.level : undefined
  const group = typeof raw.group === 'string' ? raw.group : undefined
  return { title, content, level, group }
}

/** 递归脱敏单个值：字符串只留末 4 位，对象/数组递归处理。 */
function maskValue(value) {
  if (typeof value === 'string') return value.length > 0 ? `••••••••${value.slice(-4)}` : value
  if (Array.isArray(value)) return value.map(maskValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = maskValue(item)
    return out
  }
  return value
}

/** 把某渠道配置脱敏成可安全打印的摘要（只回「是否配置」+ 末 4 位）。 */
export function maskChannelConfig(type, cfg) {
  const secrets = new Set(secretFieldsOf(type))
  const masked = {}
  for (const [key, value] of Object.entries(cfg ?? {})) {
    masked[key] = secrets.has(key) ? maskValue(value) : value
  }
  return masked
}

/**
 * 解析并归一化 channels[] 配置。
 * 返回 { enabled, debounceMs, summaryMaxChars, titlePrefix, channels }：
 *   channels = [{ type, config }] 已 resolve 的可发送渠道；
 *   skipped   = [{ type, reason }] 未配置/禁用/未知类型的渠道（调用方负责 warn）。
 * 绝不 throw：任何单渠道问题都只是跳过，不弄崩启动。
 */
export function resolveConfig(config = {}) {
  const raw = config ?? {}
  const enabled = raw.enabled !== false
  const debounceMs = typeof raw.debounceMs === 'number' && Number.isFinite(raw.debounceMs)
    ? Math.max(0, Math.trunc(raw.debounceMs))
    : 10000
  const summaryMaxChars = typeof raw.summaryMaxChars === 'number' && Number.isFinite(raw.summaryMaxChars)
    ? Math.max(0, Math.trunc(raw.summaryMaxChars))
    : 500
  const titlePrefix = typeof raw.titlePrefix === 'string' ? raw.titlePrefix.trim() : ''

  const channels = []
  const skipped = []
  const rawChannels = Array.isArray(raw.channels) ? raw.channels : []

  for (const row of rawChannels) {
    if (row === null || typeof row !== 'object') {
      skipped.push({ type: '(未知)', reason: '渠道行不是对象' })
      continue
    }
    if (row.enabled === false) {
      skipped.push({ type: String(row.type ?? '(未知)'), reason: 'disabled' })
      continue
    }
    const type = typeof row.type === 'string' ? row.type.trim() : ''
    const adapter = ADAPTERS[type]
    if (adapter === undefined) {
      skipped.push({ type: type || '(空)', reason: `未知渠道类型（可用：${CHANNEL_TYPES.join('/')}）` })
      continue
    }
    try {
      const resolved = adapter.resolve(row)
      channels.push({ type, config: resolved })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      skipped.push({ type, reason })
    }
  }

  return { enabled, debounceMs, summaryMaxChars, titlePrefix, channels, skipped }
}

/** 单渠道发送结果（供 notify()/notifyAll() 与工具渲染）。 */
export function channelResult(channel, outcome, error) {
  if (outcome === 'sent') return { channel, ok: true, skipped: false, error: undefined }
  if (outcome === 'skipped') return { channel, ok: false, skipped: true, error: undefined }
  return { channel, ok: false, skipped: false, error }
}

export { NotifyError, ERROR_CODES }
