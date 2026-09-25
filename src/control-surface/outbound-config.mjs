// dsh-notifier v0.12 — canonical outbound configuration transaction.
// Resolve first -> persist canonical overlay -> synchronously swap the one live OutboundSource.
// Failed validation/resolve/persist never changes the live runtime source.

import {
  ADAPTERS,
  CHANNEL_TYPES,
  channelDocUrlOf,
  channelFieldsOf,
  channelFixedOptions,
  resolveEnvRefs,
} from '../config.mjs'

const OUTBOUND = new Set(CHANNEL_TYPES)
const DUAL_INBOUND_DOMAIN = new Set(['feishu', 'dingtalk'])
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_KEYS = 64
const MAX_STRING_BYTES = 8 * 1024

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const clone = (value) => JSON.parse(JSON.stringify(value))
const canonicalKey = (type) => `channel:${type}:outbound`
const oldAdminKey = (type) => `admin:channel:${type}:outbound`

function safeGet(store, key) {
  try { return typeof store?.get === 'function' ? store.get(key) : undefined } catch { return undefined }
}

function rawYaml(yamlRows, type) {
  const row = yamlRows instanceof Map ? yamlRows.get(type) : undefined
  const obj = plain(row) ?? {}
  const { type: _type, enabled: _enabled, ...raw } = obj
  return raw
}

function legacyOverlay(store, type, adminEnabled) {
  const canonical = plain(safeGet(store, canonicalKey(type)))
  if (canonical !== null) return canonical

  // v0.11 Admin-owned overlays (`admin:channel:<type>:outbound` and legacy `<type>:account`)
  // are compatibility-only. Do not revive them when the user explicitly disabled Admin,
  // so projection/raw/test/remove stay consistent with the runtime OutboundSource.
  if (adminEnabled !== true) return {}

  const oldAdmin = plain(safeGet(store, oldAdminKey(type)))
  if (oldAdmin !== null) return oldAdmin

  if (!DUAL_INBOUND_DOMAIN.has(type)) {
    return plain(safeGet(store, `${type}:account`)) ?? {}
  }
  return {}
}

function allowedKeys(type) {
  const keys = new Set(Object.keys(channelFieldsOf(type)))
  if (!channelFixedOptions(type)) {
    keys.add('timeoutMs')
    keys.add('apiBase')
  }
  return keys
}

function valueError(path, value) {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES ? null : `${path} 超过 ${MAX_STRING_BYTES} 字节上限`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} 必须是有限数字`
  if (typeof value === 'boolean') return null
  if (Array.isArray(value)) {
    if (value.length > MAX_KEYS) return `${path} 数组超过 ${MAX_KEYS} 项上限`
    for (const item of value) {
      const bad = valueError(path, item)
      if (bad !== null) return bad
    }
    return null
  }
  const obj = plain(value)
  if (obj !== null) {
    const entries = Object.entries(obj)
    if (entries.length > MAX_KEYS) return `${path} 对象超过 ${MAX_KEYS} 键上限`
    for (const [key, item] of entries) {
      if (RESERVED.has(key)) return `${path} 内含保留键 "${key}"`
      const bad = valueError(`${path}.${key}`, item)
      if (bad !== null) return bad
    }
    return null
  }
  return `${path} 的值必须是字符串/数字/布尔/数组/对象`
}

function validatePatch(type, patch) {
  if (!OUTBOUND.has(type)) throw Object.assign(new Error(`未知出站通道类型 "${type}"`), { code: 'bad-request' })
  const obj = plain(patch)
  if (obj === null || Object.keys(obj).length === 0) {
    throw Object.assign(new Error('patch 必须是非空对象'), { code: 'bad-request' })
  }
  if (Object.keys(obj).length > MAX_KEYS) {
    throw Object.assign(new Error(`字段数超过上限（最多 ${MAX_KEYS} 个）`), { code: 'bad-request' })
  }
  const allowed = allowedKeys(type)
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED.has(key) || !allowed.has(key)) {
      throw Object.assign(new Error(`未知或保留字段 "${key}"`), { code: 'bad-request' })
    }
    const bad = valueError(key, value)
    if (bad !== null) throw Object.assign(new Error(bad), { code: 'bad-request' })
  }
}

function resolveCandidate(type, raw) {
  const adapter = ADAPTERS[type]
  if (adapter === undefined) throw Object.assign(new Error(`未知出站通道类型 "${type}"`), { code: 'bad-request' })
  try {
    return adapter.resolve(resolveEnvRefs(raw))
  } catch (cause) {
    const error = new Error(cause instanceof Error ? cause.message : String(cause))
    error.code = 'not-configured'
    error.cause = cause
    throw error
  }
}

export function createOutboundConfigService({
  store,
  yamlRows,
  source,
  adminEnabled = false,
  onChange = null,
  onAudit = null,
} = {}) {
  if (source === null || typeof source?.replace !== 'function' || typeof source?.remove !== 'function') {
    throw new TypeError('outbound runtime source is required')
  }

  const emit = (topic, detail) => {
    try { onAudit?.(topic, detail) } catch {}
    try { onChange?.(topic, detail) } catch {}
  }

  const overlayOf = (type) => legacyOverlay(store, type, adminEnabled)
  const rawOf = (type) => ({ ...rawYaml(yamlRows, type), ...overlayOf(type) })

  return {
    raw(type) {
      const key = String(type ?? '').trim()
      if (!OUTBOUND.has(key)) return null
      return clone(rawOf(key))
    },

    save(type, patch) {
      const key = String(type ?? '').trim()
      validatePatch(key, patch)

      const currentCanonical = plain(safeGet(store, canonicalKey(key)))
      const seed = currentCanonical ?? overlayOf(key)
      const nextCanonical = { ...seed, ...clone(patch) }
      const nextRaw = { ...rawYaml(yamlRows, key), ...nextCanonical }

      // Phase 1 — resolve before mutation.
      const resolved = resolveCandidate(key, nextRaw)

      // Phase 2 — canonical persistence is the commit point.
      try {
        if (typeof store?.set !== 'function') throw new Error('store 不可用')
        store.set(canonicalKey(key), nextCanonical)
      } catch (cause) {
        const error = new Error('出站配置写入失败')
        error.code = 'storage-failed'
        error.cause = cause
        throw error
      }

      // Phase 3 — synchronous live swap.
      source.replace(key, resolved)
      const result = { type: key, saved: true, applied: true, applyMode: 'hot', configRevision: source.version }
      emit('channel-saved', result)
      return result
    },

    remove(type) {
      const key = String(type ?? '').trim()
      if (!OUTBOUND.has(key)) throw Object.assign(new Error(`未知出站通道类型 "${key}"`), { code: 'bad-request' })
      const existing = plain(safeGet(store, canonicalKey(key)))
      if (existing === null) throw Object.assign(new Error(`出站配置不存在：${key}`), { code: 'not-found' })

      // Pre-resolve fallback before deleting canonical state. Admin-owned overlays are
      // only reused when Admin is enabled (never revived for a user who disabled it).
      const fallbackRaw = { ...rawYaml(yamlRows, key) }
      if (adminEnabled === true) {
        const oldAdmin = plain(safeGet(store, oldAdminKey(key)))
        if (oldAdmin !== null) {
          Object.assign(fallbackRaw, oldAdmin)
        } else if (!DUAL_INBOUND_DOMAIN.has(key)) {
          const account = plain(safeGet(store, `${key}:account`))
          if (account !== null) Object.assign(fallbackRaw, account)
        }
      }

      let fallback = null
      if (Object.keys(fallbackRaw).length > 0) fallback = resolveCandidate(key, fallbackRaw)

      try {
        if (typeof store?.delete !== 'function') throw new Error('store 不可用')
        store.delete(canonicalKey(key))
      } catch (cause) {
        const error = new Error('出站配置删除失败')
        error.code = 'storage-failed'
        error.cause = cause
        throw error
      }

      if (fallback === null) source.remove(key)
      else source.replace(key, fallback)
      const result = { type: key, deleted: true, applied: true, applyMode: 'hot', configRevision: source.version }
      emit('channel-removed', result)
      return result
    },

    describe(type) {
      const key = String(type ?? '').trim()
      const raw = rawOf(key)
      return {
        type: key,
        configured: Object.keys(raw).length > 0,
        active: source.has(key),
        fields: channelFieldsOf(key),
        docUrl: channelDocUrlOf(key),
        applyMode: 'hot',
        configRevision: source.version,
      }
    },
  }
}
