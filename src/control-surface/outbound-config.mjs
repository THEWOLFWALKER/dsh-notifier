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
import { diagnosticErrorMessage } from '../security/diagnostic.mjs'
import { isPublicExposure } from '../security/exposure.mjs'
import { splitSecretPatch } from '../security/secret-patch.mjs'

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

function validatePatch(type, patch, clear = []) {
  if (!OUTBOUND.has(type)) throw Object.assign(new Error(`未知出站通道类型 "${type}"`), { code: 'bad-request' })
  const obj = plain(patch)
  if (obj === null || (Object.keys(obj).length === 0 && clear.length === 0)) {
    throw Object.assign(new Error('patch 必须是非空对象'), { code: 'bad-request' })
  }
  if (Object.keys(obj).length + clear.length > MAX_KEYS) {
    throw Object.assign(new Error(`字段数超过上限（最多 ${MAX_KEYS} 个）`), { code: 'bad-request' })
  }
  const allowed = allowedKeys(type)
  const fields = channelFieldsOf(type)
  for (const key of clear) {
    if (RESERVED.has(key) || !allowed.has(key)) {
      throw Object.assign(new Error(`未知或保留字段 "${key}"`), { code: 'bad-request' })
    }
    if (isPublicExposure(fields[key])) {
      throw Object.assign(new Error(`公共字段 "${key}" 不支持清除`), { code: 'bad-request' })
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED.has(key) || !allowed.has(key)) {
      throw Object.assign(new Error(`未知或保留字段 "${key}"`), { code: 'bad-request' })
    }
    if (value === null) {
      if (isPublicExposure(fields[key])) {
        throw Object.assign(new Error(`公共字段 "${key}" 不支持清除`), { code: 'bad-request' })
      }
      continue
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
    const error = new Error(diagnosticErrorMessage(cause, raw))
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
  const runtimeOf = (type) => {
    try {
      if (typeof source.runtimeState === 'function') return source.runtimeState(type)
    } catch {}
    return applyState.get(type) ?? { state: source.has(type) ? 'online' : 'stopped', restartPending: false }
  }

  const applyRuntime = (type, resolved) => {
    try {
      source.replace(type, resolved)
      applyState.set(type, { state: 'online', applyMode: 'hot' })
      return null
    } catch (error) {
      // Desired state is already durable.  A failed live swap is a runtime
      // failure/restart-pending, never a false storage failure.
      applyState.set(type, { state: 'failed', applyMode: 'restart-pending', error: diagnosticErrorMessage(error, resolved) })
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
      const split = splitSecretPatch(patch)
      const clear = new Set(split.clear)
      const actualPatch = { ...(split.patch ?? {}) }
      const allowed = allowedKeys(key)
      const inputKeys = Object.keys(actualPatch)
      const allKnownBlank = inputKeys.length > 0
        && inputKeys.every((field) => allowed.has(field) && typeof actualPatch[field] === 'string' && actualPatch[field].trim() === '')
      for (const field of inputKeys) {
        if (allowed.has(field) && typeof actualPatch[field] === 'string' && actualPatch[field].trim() === '') delete actualPatch[field]
      }
      const fields = channelFieldsOf(key)
      for (const [field, value] of Object.entries(actualPatch)) {
        if (value === null) {
          if (isPublicExposure(fields[field])) {
            throw Object.assign(new Error(`公共字段 "${field}" 不支持清除`), { code: 'bad-request' })
          }
          clear.add(field)
          delete actualPatch[field]
        }
      }
      if (allKnownBlank && clear.size === 0) {
        if (!OUTBOUND.has(key)) validatePatch(key, split.patch, split.clear)
        const result = { type: key, saved: true, applied: true, applyMode: 'hot', unchanged: true, configRevision: source.version }
        emit('channel-saved', result)
        return result
      }
      validatePatch(key, actualPatch, [...clear])

      const currentCanonical = plain(safeGet(store, canonicalKey(key)))
      const seed = currentCanonical ?? overlayOf(key)
      const nextCanonical = { ...seed, ...clone(actualPatch) }
      for (const field of clear) delete nextCanonical[field]
      const nextRaw = { ...baseRawOf(key), ...nextCanonical }

      // Phase 1 — resolve before mutation.
      let resolved = null
      let resolveError = null
      try {
        resolved = resolveCandidate(key, nextRaw)
      } catch (error) {
        // Explicit secret clearing is allowed to leave the desired state
        // temporarily unconfigured. Persist the deletion and keep the live
        // source unchanged until a valid replacement or restart is available.
        if (clear.size === 0) throw error
        resolveError = error
      }

      // Phase 2 — canonical persistence is the commit point.
      // v0.12.1（P0-01）：store.set 失败时返回 false 而不抛，必须显式消费 durable 判据。
      if (setDurable(store, canonicalKey(key), nextCanonical) !== true) {
        // v0.13（C11.5 / R1）：transactional store 的契约是「commit 失败 ⇒ 内存与磁盘都不变」，
        // 所以这里绝不能再写「旧值」回滚——并发下那会覆盖别处刚成功提交的新值：
        //   A 读 old=v1 → A 提交 v2 失败 → B 成功提交 v3 → A 回滚写 v1 → B 的 v3 被抹掉（lost update）。
        // 只有不具备事务语义的遗留 store（set() 先改内存再宣告失败）才需要调用方补回滚，
        // 否则会留下「内存新值 / 磁盘旧值」分裂。判据即 store 是否提供 transact。
        if (typeof store?.transact !== 'function') {
          if (currentCanonical === null) deleteDurable(store, canonicalKey(key))
          else setDurable(store, canonicalKey(key), currentCanonical)
        }
        const error = new Error('出站配置写入失败：未落盘，已放弃本次变更')
        error.code = 'storage-failed'
        throw error
      }

      // Phase 3 — synchronous live swap.  Durable desired state remains truth
      // even if the runtime adapter rejects the hot apply.
      const applyError = resolveError === null ? applyRuntime(key, resolved) : resolveError
      const result = applyError === null
        ? { type: key, saved: true, applied: true, applyMode: 'hot', configRevision: source.version }
        : { type: key, saved: true, applied: false, applyMode: 'restart-pending', runtimeState: 'failed', configRevision: source.version }
      if (clear.size > 0) result.cleared = [...clear]
      if (resolveError !== null) {
        applyState.set(key, {
          state: 'failed',
          applyMode: 'restart-pending',
          error: diagnosticErrorMessage(resolveError, nextRaw),
        })
      }
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
        // v0.13（C11.5 / R1）：同 save —— transactional store 失败即未提交，回写旧值只会
        // 制造 lost update；仅遗留 store 需要补回滚，避免内存/磁盘分裂。
        if (typeof store?.transact !== 'function') setDurable(store, canonicalKey(key), existing)
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
          applyState.set(key, { state: 'failed', applyMode: 'restart-pending', error: diagnosticErrorMessage(error, existing) })
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
        valid: (() => {
          try { resolveCandidate(key, raw); return true } catch { return false }
        })(),
        active: runtimeOf(key).state === 'online',
        fields: channelFieldsOf(key),
        docUrl: channelDocUrlOf(key),
        applyMode: 'hot',
        restartPending: runtimeOf(key).restartPending === true,
        runtime: { ...runtimeOf(key), applyMode: runtimeOf(key).state === 'failed' ? 'restart-pending' : 'hot' },
        configRevision: source.version,
      }
    },
  }
}
