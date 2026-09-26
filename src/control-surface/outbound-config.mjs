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
import { deleteDurable, setDurable, transactDurable } from '../inbound/store.mjs'

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
  resolvedRows = null,
  source,
  adminEnabled = false,
  allowLegacy = true,
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

  const overlayOf = (type) => allowLegacy === true
    ? legacyOverlay(store, type, adminEnabled)
    : (plain(safeGet(store, canonicalKey(type))) ?? {})
  const baseRawOf = (type) => ({
    ...rawYaml(yamlRows, type),
    ...(yamlRows instanceof Map && yamlRows.has(type)
      ? {}
      : (plain(resolvedRows instanceof Map ? resolvedRows.get(type) : undefined) ?? {})),
  })
  const rawOf = (type) => ({ ...baseRawOf(type), ...overlayOf(type) })
  const applyState = new Map()

  const applyRuntime = (type, resolved) => {
    try {
      source.replace(type, resolved)
      applyState.set(type, { state: 'online', applyMode: 'hot' })
      return null
    } catch (error) {
      // Desired state is already durable.  A failed live swap is a runtime
      // failure/restart-pending, never a false storage failure.
      applyState.set(type, { state: 'failed', applyMode: 'restart-pending', error: error?.message ?? String(error) })
      return error
    }
  }

  const removeDurable = (keys) => {
    const unique = [...new Set(keys)]
    if (typeof store?.transact === 'function') {
      return transactDurable(store, (draft) => {
        const existed = unique.some((key) => Object.prototype.hasOwnProperty.call(draft, key))
        for (const key of unique) delete draft[key]
        return existed
      })
    }
    let durable = true
    let existed = false
    for (const key of unique) {
      const result = deleteDurable(store, key)
      existed = existed || result.existed === true
      durable = durable && result.durable === true
    }
    return { ok: durable, committed: durable, durable, value: existed }
  }

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
      const nextRaw = { ...baseRawOf(key), ...nextCanonical }

      // Phase 1 — resolve before mutation.
      const resolved = resolveCandidate(key, nextRaw)

      // Phase 2 — canonical persistence is the commit point.
      // v0.12.1（P0-01）：store.set 失败时返回 false 而不抛，必须显式消费 durable 判据。
      if (setDurable(store, canonicalKey(key), nextCanonical) !== true) {
        // store.set 可能已经改了内存但没有落盘，回滚内存，避免 runtime/disk 分裂。
        if (currentCanonical === null) deleteDurable(store, canonicalKey(key))
        else setDurable(store, canonicalKey(key), currentCanonical)
        const error = new Error('出站配置写入失败：未落盘，已放弃本次变更')
        error.code = 'storage-failed'
        throw error
      }

      // Phase 3 — synchronous live swap.  Durable desired state remains truth
      // even if the runtime adapter rejects the hot apply.
      const applyError = applyRuntime(key, resolved)
      const result = applyError === null
        ? { type: key, saved: true, applied: true, applyMode: 'hot', configRevision: source.version }
        : { type: key, saved: true, applied: false, applyMode: 'restart-pending', runtimeState: 'failed', configRevision: source.version }
      emit('channel-saved', result)
      return result
    },

    /**
     * 删除 canonical 出站配置。
     * mode='fallback'（缺省）保留既有 legacy/YAML 回退；mode='revoke' 同时删除可删的
     * legacy 覆盖源，使凭证不会在下次启动时从旧覆盖域复活。YAML bootstrap 仍不可删除。
     */
    remove(type, options = {}) {
      const key = String(type ?? '').trim()
      if (!OUTBOUND.has(key)) throw Object.assign(new Error(`未知出站通道类型 "${key}"`), { code: 'bad-request' })
      const existing = plain(safeGet(store, canonicalKey(key)))
      if (existing === null) throw Object.assign(new Error(`出站配置不存在：${key}`), { code: 'not-found' })

      // Pre-resolve fallback only for pre-v0.13 compatibility callers.  The
      // production service is canonical-only, so revoke can never be blocked by
      // malformed legacy data.
      const fallbackRaw = { ...baseRawOf(key) }
      if (allowLegacy === true && adminEnabled === true) {
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

      // v0.12.1（P0-02）：delete() 返回 existed，不表达 durable 结果；删除未落盘时
      // 禁止切换 live source，否则重启后配置会复活。
      const removal = options?.mode === 'revoke'
        ? removeDurable([
          canonicalKey(key),
          oldAdminKey(key),
          ...(!DUAL_INBOUND_DOMAIN.has(key) ? [`${key}:account`] : []),
        ])
        : removeDurable([canonicalKey(key)])
      if (removal.durable !== true) {
        setDurable(store, canonicalKey(key), existing)
        const error = new Error('出站配置删除失败：未落盘，已放弃本次变更')
        error.code = 'storage-failed'
        throw error
      }

      if (options?.mode === 'revoke') {
        // Legacy keys are removed in the same transaction above.  No read or
        // resolve of those keys occurs, so malformed leftovers cannot block revoke.
        try {
          source.remove(key)
          applyState.set(key, { state: 'stopped', applyMode: 'hot' })
        } catch (error) {
          applyState.set(key, { state: 'failed', applyMode: 'restart-pending', error: error?.message ?? String(error) })
        }
      } else if (fallback === null) source.remove(key)
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
        runtime: applyState.get(key) ?? { state: source.has(key) ? 'online' : 'stopped', applyMode: 'hot' },
        configRevision: source.version,
      }
    },
  }
}
