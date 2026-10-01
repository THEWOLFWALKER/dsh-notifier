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

/**
 * v0.15（Gate 2B）：patch 归一化——SECRET split、空白字段剔除、`null` → clear。
 * 纯函数，`save()` 与窄 seam `planPatch()` 共用，保证「保存」与「导入计划」对同一输入
 * 得到完全一致的字段集合（绝不让 portability 走第二条归一化路径）。
 */
function normalizePatchInput(key, patch) {
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
  return { actualPatch, clear, allKnownBlank, raw: { patch: split.patch, clear: split.clear } }
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
    // v0.14（P1-07 / Stage C）：runtime truth 的唯一 owner 是 RuntimeChannelManager——
    // 它存在时读侧一律走它，绝不与本服务的 applyState 形成第二个竞争状态机。
    try {
      if (typeof source.runtimeState === 'function') return source.runtimeState(type)
    } catch {}
    return applyState.get(type) ?? { state: source.has(type) ? 'online' : 'stopped', restartPending: false }
  }

  /**
   * v0.14（Stage C）：写 runtime lifecycle。优先驱动 RuntimeChannelManager 的 setState；
   * 缺省退回本服务内的 applyState 兜底（纯 OutboundSource / 测试桩没有 setState）。
   * 显式给出的 `restartPending` 以它为准——divergence 场景（旧 runtime 仍在跑但 desired
   * 未收敛）需要 state=online 与 restartPending=true 并存。
   */
  const markRuntime = (type, state, detail = {}) => {
    // revision 只服务 manager 的单调栅栏，不进 runtimeState 形状（describe/投影契约不变）。
    const { revision, ...rest } = detail
    const next = { state, restartPending: state === 'failed', ...rest }
    applyState.set(type, next)
    if (typeof source.setState === 'function') {
      try { source.setState(type, state, detail) } catch { /* manager 不可用：applyState 兜底已写 */ }
    }
    return next
  }

  const applyRuntime = (type, resolved, wasLive = false) => {
    try {
      source.replace(type, resolved)
      markRuntime(type, 'online', { restartPending: false, revision: source.version })
      return null
    } catch (error) {
      // v0.15（T08 / C02）：hot apply 失败 ≠ 配置失败——desired 已落盘。若旧 runtime 仍在
      // 跑（wasLive），观察面必须同时显示**新 desired + 旧 active**（online + restartPending
      // → diverged），绝不把仍在服务旧配置的渠道谎报成 failed/未运行；只有确实没有旧
      // runtime 可留时才标记 failed。
      markRuntime(type, wasLive === true ? 'online' : 'failed', {
        restartPending: true,
        revision: source.version,
        error: diagnosticErrorMessage(error, resolved),
      })
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
      const { actualPatch, clear, allKnownBlank, raw } = normalizePatchInput(key, patch)
      if (allKnownBlank && clear.size === 0) {
        if (!OUTBOUND.has(key)) validatePatch(key, raw.patch, raw.clear)
        const result = { type: key, saved: true, applied: true, applyMode: 'hot', unchanged: true, configRevision: source.version }
        emit('channel-saved', result)
        return result
      }
      validatePatch(key, actualPatch, [...clear])

      const canonicalKeyOf = canonicalKey(key)
      const currentCanonical = plain(safeGet(store, canonicalKeyOf))
      const seed = currentCanonical ?? overlayOf(key)
      // Pre-merge view used only for an early, side-effect-free resolve: a non-clear patch
      // that cannot resolve must be rejected *before* it is committed.
      const preCanonical = { ...seed, ...clone(actualPatch) }
      for (const field of clear) delete preCanonical[field]
      if (clear.size === 0) resolveCandidate(key, { ...baseRawOf(key), ...preCanonical })

      // Phase 1 — canonical merge + commit happen in one transaction (v0.14 / P1-06).
      // Concurrent sibling patches to the same channel:<type>:outbound key merge against
      // the draft at commit time, so a later writer never clobbers an earlier writer's
      // other fields (the read-outside-then-write-whole-object window is the lost update).
      let committedCanonical = preCanonical
      const mergeDraft = (draft) => {
        const base = plain(draft[canonicalKeyOf]) ?? overlayOf(key)
        const next = { ...base, ...clone(actualPatch) }
        for (const field of clear) delete next[field]
        draft[canonicalKeyOf] = next
        delete draft[`portability:staged:outbound:${key}`]
        return next
      }
      if (typeof store?.transact === 'function') {
        const committed = transactDurable(store, mergeDraft)
        if (committed.committed !== true) {
          const error = new Error('出站配置写入失败：未落盘，已放弃本次变更')
          error.code = 'storage-failed'
          throw error
        }
        if (plain(committed.value) !== null) committedCanonical = committed.value
      } else if (setDurable(store, canonicalKeyOf, mergeDraft({ [canonicalKeyOf]: currentCanonical })) !== true) {
        // v0.13（C11.5 / R1）：遗留 store 的 set() 先改内存再宣告失败，需调用方补回滚，避免
        // 内存/磁盘分裂；具备事务语义的 store 绝不回滚（那会制造 lost update）。
        if (currentCanonical === null) deleteDurable(store, canonicalKeyOf)
        else setDurable(store, canonicalKeyOf, currentCanonical)
        const error = new Error('出站配置写入失败：未落盘，已放弃本次变更')
        error.code = 'storage-failed'
        throw error
      }

      // Phase 2 — resolve the *committed* authoritative desired state, then hot-apply.
      const nextRaw = { ...baseRawOf(key), ...committedCanonical }
      let resolved = null
      let resolveError = null
      try {
        resolved = resolveCandidate(key, nextRaw)
      } catch (error) {
        // A non-clear patch was already resolved against the pre-merge view above; reaching
        // here means a concurrent sibling patch made the merged state unresolvable.  The
        // desired state stays durable; runtime convergence is deferred to restart.
        resolveError = error
      }

      // Phase 3 — synchronous live swap.  Durable desired state remains truth
      // even if the runtime adapter rejects the hot apply.
      const wasLive = source.has(key)
      const applyError = resolveError === null ? applyRuntime(key, resolved, wasLive) : resolveError
      const result = applyError === null
        ? { type: key, saved: true, applied: true, applyMode: 'hot', configRevision: source.version }
        : { type: key, saved: true, applied: false, applyMode: 'restart-pending', runtimeState: 'failed', configRevision: source.version }
      if (clear.size > 0) result.cleared = [...clear]
      if (resolveError !== null) {
        // v0.14（Stage C）：desired 已落盘但 resolve 失败（典型：清掉 required secret）。
        // 旧 runtime 仍在跑 → 报 online + restartPending=true（active 保持 true，但明确
        // 表示「尚未收敛到 desired」）；没有旧 runtime 可留时才标 failed。
        const stillLive = wasLive === true || source.has(key)
        markRuntime(key, stillLive ? 'online' : 'failed', {
          restartPending: true,
          revision: source.version,
          error: diagnosticErrorMessage(resolveError, nextRaw),
        })
      }
      emit('channel-saved', result)
      return result
    },

    /**
     * v0.15（Gate 2B）窄 seam 1/2：**只规划、不落盘、不 apply**。
     * 校验 + 归一化 + 对 fresh canonical 预解析（不可解析的 patch 必须在提交前被拒）。
     * 返回的计划暴露 `key` 与 `mergeInto(draft)`——调用方可在自己的单一事务里写多个渠道，
     * 且每个渠道以 draft 最新值为基底做字段级合并（绝不整表覆写）。
     */
    planPatch(type, patch) {
      const key = String(type ?? '').trim()
      const { actualPatch, clear, allKnownBlank, raw } = normalizePatchInput(key, patch)
      if (allKnownBlank && clear.size === 0) {
        if (!OUTBOUND.has(key)) validatePatch(key, raw.patch, raw.clear)
        return { type: key, key: canonicalKey(key), unchanged: true }
      }
      validatePatch(key, actualPatch, [...clear])
      const canonicalKeyOf = canonicalKey(key)
      const currentCanonical = plain(safeGet(store, canonicalKeyOf))
      const seed = currentCanonical ?? overlayOf(key)
      const preCanonical = { ...seed, ...clone(actualPatch) }
      for (const field of clear) delete preCanonical[field]
      if (clear.size === 0) resolveCandidate(key, { ...baseRawOf(key), ...preCanonical })
      return {
        type: key,
        key: canonicalKeyOf,
        unchanged: false,
        nextCanonical: preCanonical,
        clear: [...clear],
        mergeInto(draft) {
          const base = plain(draft[canonicalKeyOf]) ?? overlayOf(key)
          const next = { ...base, ...clone(actualPatch) }
          for (const field of clear) delete next[field]
          draft[canonicalKeyOf] = next
          return next
        },
      }
    },

    /**
     * v0.15（Gate 2B）窄 seam 2/2：desired 已提交后的 runtime reconcile。
     * 只 resolve + 热切换 + 标记 runtime 状态，**绝不回滚 desired**；resolve/apply 失败返回
     * `applied:false / restart-pending`，由调用方原样上报。
     */
    applyCommitted(type, committedConfig = null) {
      const key = String(type ?? '').trim()
      if (!OUTBOUND.has(key)) throw Object.assign(new Error(`未知出站通道类型 "${key}"`), { code: 'bad-request' })
      const canonical = plain(committedConfig) ?? plain(safeGet(store, canonicalKey(key))) ?? {}
      const nextRaw = { ...baseRawOf(key), ...canonical }
      const wasLive = source.has(key)
      let resolved = null
      let resolveError = null
      try { resolved = resolveCandidate(key, nextRaw) } catch (error) { resolveError = error }
      if (resolveError !== null) {
        const stillLive = wasLive === true || source.has(key)
        markRuntime(key, stillLive ? 'online' : 'failed', {
          restartPending: true, revision: source.version, error: diagnosticErrorMessage(resolveError, nextRaw),
        })
        const result = { type: key, saved: true, applied: false, applyMode: 'restart-pending', runtimeState: stillLive ? 'online' : 'failed', configRevision: source.version }
        emit('channel-saved', result)
        return result
      }
      const applyError = applyRuntime(key, resolved, wasLive)
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
        // v0.13（C11.5 / R1）：同 save —— transactional store 失败即未提交，回写旧值只会
        // 制造 lost update；仅遗留 store 需要补回滚，避免内存/磁盘分裂。
        if (typeof store?.transact !== 'function') setDurable(store, canonicalKey(key), existing)
        const error = new Error('出站配置删除失败：未落盘，已放弃本次变更')
        error.code = 'storage-failed'
        throw error
      }

      // v0.13（C11.5 / R7）：desired delete 已提交后，运行时 remove/replace 失败绝不能被
      // 说成「配置提交失败」（那会诱导调用方回滚 desired）。分层返回：deleted=true 表示
      // 期望态已落盘；applied=false / runtimeState=failed / applyMode=restart-pending 表示
      // 运行时尚未跟上，等重启收敛。绝不 rollback desired state。
      let applyError = null
      if (options?.mode === 'revoke') {
        // Legacy keys are removed in the same transaction above.  No read or
        // resolve of those keys occurs, so malformed leftovers cannot block revoke.
        try {
          source.remove(key)
          markRuntime(key, 'stopped', { restartPending: false, revision: source.version })
        } catch (error) {
          applyError = error
          markRuntime(key, 'failed', { revision: source.version, error: diagnosticErrorMessage(error, existing) })
        }
      } else {
        try {
          if (fallback === null) {
            source.remove(key)
            markRuntime(key, 'stopped', { restartPending: false, revision: source.version })
          } else {
            source.replace(key, fallback)
            markRuntime(key, 'online', { restartPending: false, revision: source.version })
          }
        } catch (error) {
          applyError = error
          markRuntime(key, 'failed', { revision: source.version, error: diagnosticErrorMessage(error, existing) })
        }
      }
      const result = applyError === null
        ? { type: key, deleted: true, applied: true, applyMode: 'hot', configRevision: source.version }
        : { type: key, deleted: true, applied: false, applyMode: 'restart-pending', runtimeState: 'failed', configRevision: source.version }
      emit('channel-removed', result)
      return result
    },

    describe(type) {
      const key = String(type ?? '').trim()
      const raw = rawOf(key)
      const rt = runtimeOf(key)
      return {
        type: key,
        configured: Object.keys(raw).length > 0,
        valid: (() => {
          try { resolveCandidate(key, raw); return true } catch { return false }
        })(),
        active: rt.state === 'online',
        fields: channelFieldsOf(key),
        docUrl: channelDocUrlOf(key),
        applyMode: 'hot',
        restartPending: rt.restartPending === true,
        // v0.14（Stage C）：显式 divergence —— desired 与 live runtime 尚未收敛（旧 runtime
        // 仍在跑但 restartPending=true），供 diagnostics 明确区分「未收敛」与「未配置」。
        diverged: rt.restartPending === true && rt.state === 'online',
        runtime: { ...rt, applyMode: rt.state === 'failed' ? 'restart-pending' : 'hot' },
        configRevision: source.version,
      }
    },
  }
}
