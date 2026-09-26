// v0.12.1（P1-03 / D-01 第一步）：入站通道配置读写的独立能力。
// Native Control Surface 与 Admin 共用此端口，避免 Native 依赖 admin.enabled 的装配生命周期。

import { INBOUND_CHANNELS, INBOUND_CHANNEL_SET } from './channels-registry.mjs'
import { toInboundChannelName } from './capability-matrix.mjs'
import { deleteDurable, setDurable } from './store.mjs'
import { isPublicExposure } from '../security/exposure.mjs'

/** 入站通道的凭证字段表（与 Admin 既有表一致；wechat 为扫码产物，不手填）。 */
export const INBOUND_FIELDS = Object.freeze({
  telegram: { botToken: { required: true, desc: 'Telegram Bot Token（与出站同域）' } },
  feishu: {
    appId: { required: true, desc: '飞书自建应用 App ID（扫码授权自动写入）' },
    appSecret: { required: true, desc: '飞书自建应用 App Secret（扫码授权自动写入）' },
  },
  qq: {
    appId: { required: true, desc: 'QQ 机器人 AppID（扫码授权自动写入）' },
    appSecret: { required: true, desc: 'QQ 机器人 AppSecret（扫码授权自动写入）' },
  },
  wxpusher: {
    appToken: { required: true, desc: 'WxPusher 应用 APP_TOKEN（回调鉴权即凭证）' },
    accountId: { required: false, secret: false, exposure: 'public', desc: '本地账号标识（多账号/多应用时建议填写；不要填 APP_TOKEN）' },
  },
  wechat: {},
  dingtalk: {
    appKey: { required: true, desc: '钉钉企业内部应用 AppKey（扫码授权自动写入）' },
    appSecret: { required: true, desc: '钉钉企业内部应用 AppSecret（扫码授权自动写入）' },
  },
})

const MAX_CHANNEL_KEYS = 64
const MAX_VALUE_BYTES = 8 * 1024
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const clone = (value) => JSON.parse(JSON.stringify(value))

export function inboundKeyWhitelist(type) {
  return new Set(Object.keys(INBOUND_FIELDS[type] ?? {}))
}

const valueBytes = (value) => {
  try { return Buffer.byteLength(value, 'utf8') } catch { return Infinity }
}

/** 递归值形态校验，与 Admin 原入站写入规则一致。 */
export function describeBadChannelValue(key, value) {
  if (typeof value === 'string') {
    if (valueBytes(value) > MAX_VALUE_BYTES) return `"${key}" 超过 ${MAX_VALUE_BYTES} 字节上限`
    return null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : `"${key}" 必须是有限数字`
  if (typeof value === 'boolean') return null
  if (Array.isArray(value)) {
    if (value.length > MAX_CHANNEL_KEYS) return `"${key}" 数组超过 ${MAX_CHANNEL_KEYS} 项上限`
    for (const item of value) {
      const bad = describeBadChannelValue(key, item)
      if (bad !== null) return bad
    }
    return null
  }
  const obj = plain(value)
  if (obj !== null) {
    const entries = Object.entries(obj)
    if (entries.length > MAX_CHANNEL_KEYS) return `"${key}" 对象超过 ${MAX_CHANNEL_KEYS} 键上限`
    for (const [subKey, item] of entries) {
      if (DANGEROUS_KEYS.has(subKey)) return `"${key}" 内含保留键 "${subKey}"`
      const bad = describeBadChannelValue(`${key}.${subKey}`, item)
      if (bad !== null) return bad
    }
    return null
  }
  return `"${key}" 的值必须是字符串/数字/布尔/数组/对象`
}

export function createInboundChannelConfigPort({ store, warn = () => {}, audit = () => {} } = {}) {
  let version = 0
  const read = (key) => {
    try { return store?.get?.(key) } catch { return undefined }
  }

  function rows() {
    return INBOUND_CHANNELS.map((type) => {
      const config = plain(read(`${type}:account`)) ?? {}
      return {
        type,
        direction: 'inbound',
        configured: Object.keys(config).length > 0,
        enabled: Object.keys(config).length > 0,
        editable: true,
        restartRequired: false,
        config: maskSecrets(config, inboundKeyWhitelist(type), type),
        fields: { ...(INBOUND_FIELDS[type] ?? {}) },
      }
    })
  }

  function put(type, config) {
    const normalized = toInboundChannelName(type)
    if (typeof type !== 'string' || !INBOUND_CHANNEL_SET.has(normalized)) {
      throw Object.assign(new Error(`未知入站通道类型 "${String(type)}"（可用：${INBOUND_CHANNELS.join('/')}）`), { status: 422 })
    }
    const obj = plain(config)
    if (obj === null || Object.keys(obj).length === 0) {
      throw Object.assign(new Error('config 必须是非空对象'), { status: 422 })
    }
    const allowed = inboundKeyWhitelist(normalized)
    if (allowed.size === 0) {
      throw Object.assign(new Error(`${normalized} 凭证由扫码登录自动写入，不支持手工配置`), { status: 422 })
    }
    if (Object.keys(obj).length > MAX_CHANNEL_KEYS) {
      throw Object.assign(new Error(`字段数超过上限（最多 ${MAX_CHANNEL_KEYS} 个）`), { status: 422 })
    }
    for (const [key, value] of Object.entries(obj)) {
      if (DANGEROUS_KEYS.has(key)) throw Object.assign(new Error(`保留键 "${key}" 不可写入`), { status: 422 })
      if (!allowed.has(key)) throw Object.assign(new Error(`未知字段 "${key}"（${normalized} 可用字段：${[...allowed].join('/')}）`), { status: 422 })
      const bad = describeBadChannelValue(key, value)
      if (bad !== null) throw Object.assign(new Error(bad), { status: 422 })
    }
    const existing = plain(read(`${normalized}:account`)) ?? {}
    const okSaved = setDurable(store, `${normalized}:account`, clone({ ...existing, ...obj }))
    if (okSaved !== true) {
      warn(`入站通道配置写入失败: ${normalized}`)
      return { type: normalized, saved: false, direction: 'inbound' }
    }
    version += 1
    audit('putInboundChannel', { type: normalized })
    return { type: normalized, saved: true, direction: 'inbound', configRevision: version }
  }

  function remove(type) {
    const normalized = toInboundChannelName(type)
    if (typeof type !== 'string' || !INBOUND_CHANNEL_SET.has(normalized)) {
      throw Object.assign(new Error(`未知入站通道类型 "${String(type)}"`), { status: 422 })
    }
    const key = `${normalized}:account`
    if (plain(read(key)) === null) throw Object.assign(new Error(`入站配置不存在：${normalized}`), { status: 404 })
    const removal = deleteDurable(store, key)
    if (removal.durable !== true) {
      warn(`入站通道配置删除失败: ${normalized}`)
      throw Object.assign(new Error('入站配置删除失败'), { status: 500 })
    }
    version += 1
    audit('deleteInboundChannel', { type: normalized })
    return { type: normalized, deleted: true, direction: 'inbound', configRevision: version }
  }

  return { rows, put, remove, get version() { return version } }
}

function maskSecrets(config, allowed, type) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) continue
    const meta = INBOUND_FIELDS[type]?.[key]
    out[key] = isPublicExposure(meta) ? value : maskValue(value)
  }
  return out
}

function maskValue(value) {
  if (typeof value === 'string') return '***'
  if (Array.isArray(value)) return value.map(maskValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = maskValue(item)
    return out
  }
  return value
}
