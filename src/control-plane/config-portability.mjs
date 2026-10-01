// dsh-notifier v0.15 (T21) — local configuration export / import application service.
//
// Single orchestration entry for moving *committed* channel configuration between
// environments. Shared by the Native control surface (src/control-surface/service.mjs).
//
// It owns only orchestration:
//   - build a whitelisted, versioned export document (public fields only);
//   - strictly parse + validate an uploaded document into a dry-run plan;
//   - commit a *selected* subset of that plan through the canonical authorities.
//
// It deliberately does NOT own:
//   - provider adapters / runtime apply (the outbound-config authority does that);
//   - plaintext credentials — secrets are never exported and never become an
//     import value (a masked string can never be written back);
//   - the store primitive (it uses the durable helpers).
//
// Safety rules (06-INTEGRATIONS §配置文件v1):
//   * ordinary export is NOT a disaster-recovery snapshot: member permissions,
//     pairing plaintext, admin token / launch tickets, claims/uncertain, dedup
//     cursors, SDK resources and health are all excluded by construction;
//   * new channels are imported **disabled** (staged, inert) — import never
//     activates a channel or sends a test;
//   * existing channels keep their current enable state; only an explicitly
//     selected patch is applied, and existing secrets are kept by default;
//   * cancel writes nothing; a rejected file writes nothing and fetches nothing.

import {
  CHANNEL_TYPES,
  channelFieldsOf,
  channelFixedOptions,
} from '../config.mjs'
import { INBOUND_FIELDS } from '../inbound/channel-config.mjs'
import { INBOUND_CHANNELS, INBOUND_CHANNEL_SET } from '../inbound/channels-registry.mjs'
import { toInboundChannelName } from '../inbound/capability-matrix.mjs'
import { transactDurable } from '../inbound/store.mjs'
import { isPublicExposure } from '../security/exposure.mjs'
import { splitSecretPatch } from '../security/secret-patch.mjs'

const DOCUMENT_TYPE = 'dsh-notifier-config'
const FORMAT_VERSION = 1
const MAX_BYTES = 1024 * 1024
const MAX_ITEMS = 200
const MAX_VALUE_BYTES = 8 * 1024
const MAX_KEYS = 64
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const PREVIEW_TTL_MS = 5 * 60 * 1000
const MAX_PREVIEWS = 10
const STAGED_PREFIX = 'portability:staged:'
const ENGINE_KEYS = ['timeoutMs', 'apiBase']
const ENV_REF = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/
// token-bearing URL: remove embedded userinfo and any secret-shaped query param.
const SECRET_QUERY = /^(?:token|key|secret|password|passwd|access[_-]?token|auth|authorization|sig|signature|api[_-]?key)$/i

const OUTBOUND = new Set(CHANNEL_TYPES)
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const clone = (value) => JSON.parse(JSON.stringify(value))
const bad = (message) => Object.assign(new Error(message), { code: 'bad-request' })

function byteLength(text) {
  try { return Buffer.byteLength(String(text), 'utf8') } catch { return Infinity }
}

/** Rejecting dangerous keys is a parse-time gate (E03), before any plan/write. */
function assertNoDangerousKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${path}[${index}]`))
    return
  }
  const obj = plain(value)
  if (obj === null) return
  for (const [key, item] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) throw bad(`文档包含保留键 "${key}"（${path}）`)
    assertNoDangerousKeys(item, `${path}.${key}`)
  }
}

/** Value shape check for import — mirrors the canonical outbound/inbound contracts. */
function describeBadValue(key, value) {
  if (typeof value === 'string') {
    return byteLength(value) <= MAX_VALUE_BYTES ? null : `"${key}" 超过 ${MAX_VALUE_BYTES} 字节上限`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : `"${key}" 必须是有限数字`
  if (typeof value === 'boolean') return null
  if (Array.isArray(value)) {
    if (value.length > MAX_KEYS) return `"${key}" 数组超过 ${MAX_KEYS} 项上限`
    for (const item of value) {
      const bad_ = describeBadValue(key, item)
      if (bad_ !== null) return bad_
    }
    return null
  }
  const obj = plain(value)
  if (obj !== null) {
    const entries = Object.entries(obj)
    if (entries.length > MAX_KEYS) return `"${key}" 对象超过 ${MAX_KEYS} 键上限`
    for (const [sub, item] of entries) {
      if (DANGEROUS_KEYS.has(sub)) return `"${key}" 内含保留键 "${sub}"`
      const bad_ = describeBadValue(`${key}.${sub}`, item)
      if (bad_ !== null) return bad_
    }
    return null
  }
  return `"${key}" 的值必须是字符串/数字/布尔/数组/对象`
}

/** Public (exportable) field names for one outbound channel type. */
function outboundPublicKeys(type) {
  const keys = new Set()
  const fields = channelFieldsOf(type)
  for (const [key, meta] of Object.entries(fields)) if (isPublicExposure(meta)) keys.add(key)
  if (!channelFixedOptions(type)) for (const key of ENGINE_KEYS) keys.add(key)
  return keys
}

/** Secret (credential) field names for one channel direction. */
function outboundSecretKeys(type) {
  const keys = []
  for (const [key, meta] of Object.entries(channelFieldsOf(type))) if (!isPublicExposure(meta)) keys.push(key)
  return keys
}

function inboundPublicKeys(type) {
  const keys = new Set()
  for (const [key, meta] of Object.entries(INBOUND_FIELDS[type] ?? {})) if (isPublicExposure(meta)) keys.add(key)
  return keys
}

function inboundSecretKeys(type) {
  const keys = []
  for (const [key, meta] of Object.entries(INBOUND_FIELDS[type] ?? {})) if (!isPublicExposure(meta)) keys.push(key)
  return keys
}

/**
 * Public string sanitisation (E01): an env reference becomes an external reference
 * (omitted from config, listed separately); a token-bearing URL loses its whole
 * secret part (userinfo + secret-shaped query params). Plain strings pass through.
 * @returns {{ value?: string, reference?: { kind: string, name: string } }}
 */
function sanitizePublicString(value) {
  const match = ENV_REF.exec(value.trim())
  if (match !== null) return { reference: { kind: 'env', name: match[1] } }
  let url
  try { url = new URL(value) } catch { return { value } }
  if (!/^https?:$/.test(url.protocol)) return { value }
  let changed = false
  if (url.username !== '' || url.password !== '') {
    url.username = ''
    url.password = ''
    changed = true
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(name)) {
      url.searchParams.delete(name)
      changed = true
    }
  }
  return { value: changed ? url.toString() : value }
}

/**
 * @param {object} deps
 * @param {object} deps.store - durable store
 * @param {object} deps.outboundConfig - createOutboundConfigService() instance (canonical authority)
 * @param {object} [deps.inboundConfig] - createInboundChannelConfigPort() instance (canonical authority)
 * @param {string} [deps.version] - source plugin version recorded in the document
 * @param {() => Date} [deps.now] - injectable clock (frozen in tests)
 */
export function createConfigPortabilityService({
  store,
  outboundConfig,
  inboundConfig = null,
  version = 'unknown',
  now = () => new Date(),
} = {}) {
  const previews = new Map()
  let tokenSeq = 0

  const isoNow = () => {
    try { return now().toISOString() } catch { return new Date().toISOString() }
  }
  // Preview TTL uses the same injectable clock as `createdAt` so a frozen-clock
  // test cannot expire a freshly-created preview (real clock in production).
  const clockMs = () => {
    try { return now().getTime() } catch { return Date.now() }
  }

  const inboundRowOf = (type) => {
    try {
      const rows = typeof inboundConfig?.rows === 'function' ? inboundConfig.rows() : []
      return rows.find((row) => row.type === type) ?? null
    } catch { return null }
  }
  const inboundRawOf = (type) => {
    try { return plain(store?.get?.(`${type}:account`)) ?? {} } catch { return {} }
  }

  // ---------------------------------------------------------------- export

  function buildChannel(type, direction) {
    if (direction === 'outbound') {
      const raw = plain(outboundConfig?.raw?.(type)) ?? {}
      if (Object.keys(raw).length === 0) return null
      const publicKeys = outboundPublicKeys(type)
      const secretKeys = outboundSecretKeys(type)
      const config = {}
      const externalReferences = []
      const warnings = []
      for (const [key, value] of Object.entries(raw)) {
        if (!publicKeys.has(key)) continue
        if (typeof value === 'string') {
          const safe = sanitizePublicString(value)
          if (safe.reference !== undefined) {
            externalReferences.push({ direction, type, field: key, ...safe.reference })
            continue
          }
          config[key] = safe.value
        } else {
          config[key] = value
        }
      }
      const descriptors = []
      let active = false
      try { active = outboundConfig?.describe?.(type)?.active === true } catch { active = false }
      for (const field of secretKeys) {
        const current = raw[field]
        const ref = typeof current === 'string' ? ENV_REF.exec(current.trim()) : null
        if (ref !== null) {
          externalReferences.push({ direction, type, field, kind: 'env', name: ref[1] })
          descriptors.push({ direction, type, field, requirement: 'reference' })
        } else {
          descriptors.push({ direction, type, field, requirement: 'supply' })
        }
      }
      return { entry: { direction, type, enabled: active, config }, descriptors, externalReferences, warnings }
    }
    // inbound
    const normalized = toInboundChannelName(type)
    const raw = inboundRawOf(normalized)
    if (Object.keys(raw).length === 0) return null
    const publicKeys = inboundPublicKeys(normalized)
    const config = {}
    const externalReferences = []
    for (const [key, value] of Object.entries(raw)) {
      if (!publicKeys.has(key)) continue
      if (typeof value === 'string') {
        const safe = sanitizePublicString(value)
        if (safe.reference !== undefined) {
          externalReferences.push({ direction, type: normalized, field: key, ...safe.reference })
          continue
        }
        config[key] = safe.value
      } else {
        config[key] = value
      }
    }
    const descriptors = []
    for (const field of inboundSecretKeys(normalized)) {
      const current = raw[field]
      const ref = typeof current === 'string' ? ENV_REF.exec(current.trim()) : null
      if (ref !== null) {
        externalReferences.push({ direction: 'inbound', type: normalized, field, kind: 'env', name: ref[1] })
        descriptors.push({ direction: 'inbound', type: normalized, field, requirement: 'reference' })
      } else {
        descriptors.push({ direction: 'inbound', type: normalized, field, requirement: 'supply' })
      }
    }
    const row = inboundRowOf(normalized)
    return {
      entry: { direction: 'inbound', type: normalized, enabled: row?.active === true, config },
      descriptors,
      externalReferences,
      warnings: [],
    }
  }

  function normalizeScopes(scopes) {
    const wanted = Array.isArray(scopes) && scopes.length > 0 ? scopes : ['channels', 'notificationPreferences']
    const out = []
    for (const scope of wanted) if (scope === 'channels' && !out.includes('channels')) out.push('channels')
    return out.length > 0 ? out : ['channels']
  }

  /**
   * Build the export document. Only committed canonical configuration is read;
   * drafts, members, claims, cursors, credentials and health are never touched.
   */
  function exportConfig({ scopes } = {}) {
    const normalizedScopes = normalizeScopes(scopes)
    const channels = []
    const credentialDescriptors = []
    const externalReferences = []
    for (const type of CHANNEL_TYPES) {
      const view = buildChannel(type, 'outbound')
      if (view === null) continue
      channels.push(view.entry)
      credentialDescriptors.push(...view.descriptors)
      externalReferences.push(...view.externalReferences)
    }
    for (const type of INBOUND_CHANNELS) {
      const view = buildChannel(type, 'inbound')
      if (view === null) continue
      channels.push(view.entry)
      credentialDescriptors.push(...view.descriptors)
      externalReferences.push(...view.externalReferences)
    }
    const document = {
      documentType: DOCUMENT_TYPE,
      formatVersion: FORMAT_VERSION,
      sourcePluginVersion: String(version ?? 'unknown'),
      createdAt: isoNow(),
      scopes: normalizedScopes,
      channels,
      notificationPreferences: {},
      credentialDescriptors,
      externalReferences,
    }
    const date = isoNow().slice(0, 10)
    return {
      document,
      filename: `dsh-notifier-config-${date}.json`,
      counts: { channels: channels.length, credentialDescriptors: credentialDescriptors.length, externalReferences: externalReferences.length },
    }
  }

  // ---------------------------------------------------------------- parse

  function parseChannelEntry(rawEntry, index) {
    const object = plain(rawEntry)
    if (object === null) throw bad(`channels[${index}] 必须是对象`)
    const direction = String(object.direction ?? '')
    if (direction !== 'outbound' && direction !== 'inbound') throw bad(`channels[${index}].direction 非法`)
    const type = String(object.type ?? '').trim()
    if (type === '') throw bad(`channels[${index}].type 缺失`)
    const normalized = direction === 'outbound' ? type : toInboundChannelName(type)
    const known = direction === 'outbound' ? OUTBOUND.has(normalized) : INBOUND_CHANNEL_SET.has(normalized)
    const rawConfig = object.config === undefined ? {} : object.config
    if (plain(rawConfig) === null) throw bad(`channels[${index}].config 必须是对象`)
    const publicKeys = direction === 'outbound' ? outboundPublicKeys(normalized) : inboundPublicKeys(normalized)
    const config = {}
    const dropped = []
    for (const [key, value] of Object.entries(rawConfig)) {
      if (DANGEROUS_KEYS.has(key)) throw bad(`channels[${index}].config 含保留键 "${key}"`)
      if (!known || !publicKeys.has(key)) { dropped.push(key); continue }
      if (value === null) continue
      const shape = describeBadValue(key, value)
      if (shape !== null) throw bad(shape)
      // A masked credential must never become an import value (06 §配置文件v1).
      if (typeof value === 'string' && /^(?:\*+|••+|•+)/.test(value.trim())) throw bad(`channels[${index}].config."${key}" 是掩码字符串，不能作为导入值`)
      config[key] = value
    }
    const enabled = object.enabled === true
    return { direction, type: normalized, enabled, config, dropped, known }
  }

  function parseDocument(text) {
    const size = byteLength(text)
    if (size > MAX_BYTES) throw bad(`文件超过 ${MAX_BYTES} 字节上限（${size}）`)
    let parsed
    try { parsed = JSON.parse(typeof text === 'string' ? text : String(text)) } catch { throw bad('文件不是合法 JSON') }
    const root = plain(parsed)
    if (root === null) throw bad('文件顶层必须是对象')
    assertNoDangerousKeys(root)
    if (root.documentType !== DOCUMENT_TYPE) throw bad(`不支持的 documentType "${String(root.documentType)}"`)
    if (root.formatVersion !== FORMAT_VERSION) throw bad(`不支持的 formatVersion ${String(root.formatVersion)}`)
    const rawChannels = root.channels
    if (!Array.isArray(rawChannels)) throw bad('channels 必须是数组')
    if (rawChannels.length > MAX_ITEMS) throw bad(`channels 超过 ${MAX_ITEMS} 条上限`)
    const entries = []
    const seen = new Set()
    for (let index = 0; index < rawChannels.length; index += 1) {
      const entry = parseChannelEntry(rawChannels[index], index)
      const identity = `${entry.direction}:${entry.type}`
      if (seen.has(identity)) throw bad(`channels 存在重复项 ${identity}`)
      seen.add(identity)
      entries.push(entry)
    }
    return {
      source: {
        documentType: DOCUMENT_TYPE,
        formatVersion: FORMAT_VERSION,
        sourcePluginVersion: typeof root.sourcePluginVersion === 'string' ? root.sourcePluginVersion : 'unknown',
        createdAt: typeof root.createdAt === 'string' ? root.createdAt : null,
        scopes: normalizeScopes(root.scopes),
      },
      entries,
      credentialDescriptors: Array.isArray(root.credentialDescriptors) ? clone(root.credentialDescriptors) : [],
      externalReferences: Array.isArray(root.externalReferences) ? clone(root.externalReferences) : [],
    }
  }

  // ---------------------------------------------------------------- plan

  function currentPublicOf(direction, type) {
    if (direction === 'outbound') {
      const raw = plain(outboundConfig?.raw?.(type)) ?? {}
      const publicKeys = outboundPublicKeys(type)
      const out = {}
      for (const [key, value] of Object.entries(raw)) {
        if (!publicKeys.has(key)) continue
        if (typeof value === 'string' && ENV_REF.test(value.trim())) continue
        out[key] = value
      }
      return { config: out, configured: Object.keys(raw).length > 0, enabled: outboundConfig?.describe?.(type)?.active === true }
    }
    const raw = inboundRawOf(type)
    const publicKeys = inboundPublicKeys(type)
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!publicKeys.has(key)) continue
      if (typeof value === 'string' && ENV_REF.test(value.trim())) continue
      out[key] = value
    }
    const row = inboundRowOf(type)
    return { config: out, configured: Object.keys(raw).length > 0, enabled: row?.active === true }
  }

  function secretStateOf(direction, type) {
    const raw = direction === 'outbound' ? (plain(outboundConfig?.raw?.(type)) ?? {}) : inboundRawOf(type)
    const secretKeys = direction === 'outbound' ? outboundSecretKeys(type) : inboundSecretKeys(type)
    const missing = []
    const present = []
    for (const field of secretKeys) {
      const value = raw[field]
      if (value === undefined || value === null || value === '') missing.push(field)
      else present.push(field)
    }
    return { missing, present }
  }

  function planFor(entry, index, externalReferences = []) {
    const current = currentPublicOf(entry.direction, entry.type)
    const secrets = secretStateOf(entry.direction, entry.type)
    // External (machine-specific) references cannot be rebound by import; the user
    // must re-point them in the target environment (T21 / 06 §配置文件v1).
    const machineSpecific = externalReferences
      .filter((ref) => plain(ref) !== null && ref.direction === entry.direction && ref.type === entry.type)
      .map((ref) => ({ field: String(ref.field ?? ''), kind: String(ref.kind ?? 'unknown'), name: String(ref.name ?? '') }))
    const changes = { added: [], changed: [], kept: [] }
    for (const [key, value] of Object.entries(entry.config)) {
      if (!Object.prototype.hasOwnProperty.call(current.config, key)) changes.added.push(key)
      else if (JSON.stringify(current.config[key]) !== JSON.stringify(value)) changes.changed.push(key)
      else changes.kept.push(key)
    }
    const warnings = []
    if (entry.dropped.length > 0) warnings.push({ en: `Unsupported fields ignored: ${entry.dropped.join(', ')}`, zh: `已忽略不支持的字段：${entry.dropped.join(', ')}` })
    let decision
    if (!entry.known) decision = 'unsupported'
    else if (!current.configured) decision = 'add'
    else if (changes.added.length === 0 && changes.changed.length === 0) decision = 'skip'
    else if (changes.changed.length > 0) decision = 'conflict'
    else decision = 'patch'
    const selectedDefault = decision === 'add'
    return {
      index,
      direction: entry.direction,
      type: entry.type,
      decision,
      // internal: the parsed public config of the source document (never projected
      // into the preview response — the projection picks fields explicitly).
      config: entry.config,
      dropped: entry.dropped,
      currentEnabled: current.enabled === true,
      // Gate 2B：预览时点基线——commit 时只比较「本次 selection 涉及的字段」，
      // 判断目标是否在预览后被并发改动（stale-preview）。绝不放进预览响应投影。
      baseline: { config: clone(current.config), configured: current.configured === true, enabled: current.enabled === true },
      importEnabled: entry.enabled === true,
      importEnabledEffect: decision === 'add' ? false : current.enabled === true,
      changes,
      missingCredentials: secrets.missing,
      keptCredentials: secrets.present,
      machineSpecific,
      unsupported: entry.known ? [] : [`未知${entry.direction === 'outbound' ? '出站' : '入站'}渠道类型 "${entry.type}"`],
      warnings,
      selectedDefault,
    }
  }

  /**
   * Dry-run: strictly parse + validate, then return a plan. Never writes, never
   * fetches. The plan is cached behind a short-lived token (TTL 5 min, max 10).
   */
  function previewImport({ text } = {}) {
    const parsed = parseDocument(text)
    const entries = parsed.entries.map((entry, index) => planFor(entry, index, parsed.externalReferences))
    const summary = {
      add: entries.filter((e) => e.decision === 'add').length,
      patch: entries.filter((e) => e.decision === 'patch').length,
      conflict: entries.filter((e) => e.decision === 'conflict').length,
      skip: entries.filter((e) => e.decision === 'skip').length,
      unsupported: entries.filter((e) => e.decision === 'unsupported').length,
    }
    evictPreviews()
    tokenSeq += 1
    const token = `pv_${clockMs().toString(36)}_${tokenSeq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const createdAt = clockMs()
    const record = { parsed, entries, createdAt, expiresAt: createdAt + PREVIEW_TTL_MS }
    previews.set(token, record)
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value)
    return {
      token,
      expiresAt: new Date(record.expiresAt).toISOString(),
      source: parsed.source,
      summary,
      entries: entries.map((entry) => ({
        direction: entry.direction,
        type: entry.type,
        decision: entry.decision,
        currentEnabled: entry.currentEnabled,
        importEnabledEffect: entry.importEnabledEffect,
        changes: entry.changes,
        missingCredentials: entry.missingCredentials,
        keptCredentials: entry.keptCredentials,
        machineSpecific: entry.machineSpecific,
        unsupported: entry.unsupported,
        warnings: entry.warnings,
        selectedDefault: entry.selectedDefault,
      })),
      credentialDescriptors: parsed.credentialDescriptors,
      externalReferences: parsed.externalReferences,
    }
  }

  function evictPreviews() {
    const at = clockMs()
    for (const [token, record] of previews) if (record.expiresAt <= at) previews.delete(token)
  }

  function takePreview(token) {
    evictPreviews()
    const key = String(token ?? '')
    const record = previews.get(key)
    if (record === undefined) throw Object.assign(new Error('预览不存在或已过期，请重新导入'), { code: 'not-found' })
    return record
  }

  /** Cancel a preview: drops the cached plan and writes nothing (E04). */
  function cancelImport({ token } = {}) {
    const key = String(token ?? '')
    const existed = previews.delete(key)
    return { cancelled: true, existed }
  }

  // ---------------------------------------------------------------- commit

  /**
   * Resolve the *document-originated* patch for one selection. The caller can only
   * pick which imported public fields to apply (plus an explicit credential clear) —
   * it can never smuggle a field that was not in the uploaded document.
   */
  function resolveSelection(entry, selection) {
    const documented = plain(entry.config) ?? {}
    const permitted = entry.direction === 'outbound' ? outboundPublicKeys(entry.type) : inboundPublicKeys(entry.type)
    const secretKeys = new Set(entry.direction === 'outbound' ? outboundSecretKeys(entry.type) : inboundSecretKeys(entry.type))
    const picked = Array.isArray(selection?.fields)
      ? [...new Set(selection.fields.filter((field) => typeof field === 'string'))]
      : Object.keys(documented)
    for (const key of picked) {
      if (!Object.prototype.hasOwnProperty.call(documented, key) || !permitted.has(key)) throw bad(`提交含非文档字段 "${key}"`)
    }
    const clear = Array.isArray(selection?.clear)
      ? [...new Set(selection.clear.filter((field) => typeof field === 'string'))]
      : []
    for (const key of clear) if (!secretKeys.has(key)) throw bad(`仅可显式清除凭据字段 "${key}"`)
    const patch = {}
    for (const key of picked) patch[key] = clone(documented[key])
    return { patch, clear }
  }

  /**
   * New channels are staged **disabled** and inert: the assembly never reads these
   * keys, so an imported channel can never silently start sending (E05). The user
   * still has to supply credentials and explicitly enable it in the channel screen.
   */
  function stagedRecord(entry, config) {
    const secrets = secretStateOf(entry.direction, entry.type)
    return {
      direction: entry.direction,
      type: entry.type,
      enabled: false,
      config: clone(config),
      missingCredentials: secrets.missing,
      stagedAt: isoNow(),
      source: { documentType: DOCUMENT_TYPE, formatVersion: FORMAT_VERSION },
    }
  }

  /**
   * Stale-preview guard (Gate 2B). Re-read the current state and compare **only the
   * fields this selection touches** against the baseline captured at preview time.
   * A mismatch means a concurrent write changed the target since the preview; the
   * commit is refused with zero writes and the token is kept for a fresh preview.
   */
  function staleFieldOf(entry, patch) {
    const current = currentPublicOf(entry.direction, entry.type)
    if (entry.decision === 'add') return current.configured ? 'configured' : null
    for (const key of Object.keys(patch)) {
      const before = entry.baseline?.config?.[key]
      const now = current.config[key]
      if (JSON.stringify(before) !== JSON.stringify(now)) return key
    }
    return null
  }

  /**
   * Commit a preview. `selections` is `[{ direction, type, action: 'apply'|'skip', clear? }]`.
   *
   * Gate 2B selection semantics:
   *   * `selections === undefined` — internal/legacy callers may fall back to the preview
   *     defaults (`selectedDefault`); the Native UI never relies on this.
   *   * `selections: []` — an explicit empty selection: zero business mutation.
   *   * otherwise a full, explicit selection list is required (absent entry = deselected).
   *
   * Three phases — never Promise.all, never compensation writes, never a second authority:
   *   1. plan   — pure: validate + stale check + build the per-entry writes.
   *   2. commit — one `store.transact()` writes every canonical desired + staged row.
   *   3. apply  — post-commit runtime reconcile, per entry; a partial apply failure is
   *               reported (`applied:false` / `restart-pending`) without rolling desired back.
   */
  function commitImport({ token, selections } = {}) {
    const record = takePreview(token)
    const explicit = Array.isArray(selections)
    const picked = new Map()
    if (explicit) {
      for (const selection of selections) {
        const object = plain(selection)
        if (object === null) continue
        const direction = object.direction === 'inbound' ? 'inbound' : 'outbound'
        picked.set(`${direction}:${String(object.type ?? '')}`, object)
      }
    }

    // ── Phase 1: plan (pure; zero writes) ────────────────────────────────
    const writes = [] // { entry, plan } — canonical desired
    const staged = [] // { entry, record } — new channels, staged disabled
    const results = []
    for (const entry of record.entries) {
      const selection = picked.get(`${entry.direction}:${entry.type}`)
      const wantsApply = explicit
        ? (selection !== undefined && selection.action === 'apply')
        : entry.selectedDefault
      if (!wantsApply) {
        results.push({ direction: entry.direction, type: entry.type, action: 'skipped', reason: 'deselected' })
        continue
      }
      if (entry.decision === 'unsupported') {
        results.push({ direction: entry.direction, type: entry.type, action: 'skipped', reason: 'unsupported' })
        continue
      }
      const { patch, clear } = resolveSelection(entry, selection)
      const stale = staleFieldOf(entry, patch)
      if (stale !== null) {
        // Zero writes; the token stays cached so the caller can re-preview or cancel.
        const error = new Error(`预览已过期：${entry.direction}:${entry.type} 的 "${stale}" 在预览后被改动，请重新导入`)
        error.code = 'stale-preview'
        error.entry = { direction: entry.direction, type: entry.type, field: stale }
        throw error
      }
      if (entry.decision === 'add') {
        staged.push({ entry, record: stagedRecord(entry, patch) })
        continue
      }
      if (Object.keys(patch).length === 0 && clear.length === 0) {
        results.push({ direction: entry.direction, type: entry.type, action: 'skipped', reason: 'no-changes' })
        continue
      }
      const payload = clear.length > 0 ? { ...patch, clear } : patch
      if (entry.direction === 'outbound') {
        if (typeof outboundConfig?.planPatch !== 'function') throw Object.assign(new Error('出站配置写入能力不可用'), { code: 'not-supported' })
        writes.push({ entry, plan: outboundConfig.planPatch(entry.type, payload) })
      } else {
        if (inboundConfig === null || typeof inboundConfig.planPut !== 'function') throw Object.assign(new Error('入站配置写入能力不可用'), { code: 'not-supported' })
        writes.push({ entry, plan: inboundConfig.planPut(entry.type, payload) })
      }
    }

    const stagedRows = staged.map(({ entry, record: row }) => ({ entry, key: `${STAGED_PREFIX}${entry.direction}:${entry.type}`, row }))
    const activeWrites = writes.filter(({ plan }) => plan.unchanged !== true)

    if (activeWrites.length === 0 && stagedRows.length === 0) {
      // Explicit zero selection (or nothing to do): consume the token, write nothing.
      previews.delete(String(token ?? ''))
      return {
        committed: true,
        results,
        staged: listStaged(),
        externalReferences: record.parsed.externalReferences,
        credentialDescriptors: record.parsed.credentialDescriptors,
      }
    }

    // ── Phase 2: commit desired (one transaction) ────────────────────────
    const committedCanonical = new Map()
    const committed = transactDurable(store, (draft) => {
      for (const { entry, plan } of activeWrites) {
        committedCanonical.set(`${entry.direction}:${entry.type}`, plan.mergeInto(draft))
      }
      for (const { key, row } of stagedRows) draft[key] = clone(row)
      return true
    })
    if (committed.committed !== true) {
      const error = new Error('导入提交失败：未落盘，已保留当前状态')
      error.code = 'storage-failed'
      throw error
    }

    // ── Phase 3: post-commit apply (never rolls back desired) ────────────
    for (const { entry, plan } of writes) {
      if (plan.unchanged === true) {
        results.push({ direction: entry.direction, type: entry.type, action: 'skipped', reason: 'no-changes' })
        continue
      }
      if (entry.direction === 'outbound') {
        const applied = outboundConfig.applyCommitted(entry.type, committedCanonical.get(`${entry.direction}:${entry.type}`))
        results.push({
          direction: 'outbound',
          type: entry.type,
          action: 'patched',
          applied: applied?.applied === true,
          applyMode: applied?.applyMode ?? 'unknown',
          enabled: currentPublicOf('outbound', entry.type).enabled === true,
        })
      } else {
        const applied = inboundConfig.applyCommitted(entry.type)
        results.push({
          direction: 'inbound',
          type: entry.type,
          action: 'patched',
          applied: applied?.applied === true,
          applyMode: applied?.applyMode ?? 'unknown',
          enabled: currentPublicOf('inbound', entry.type).enabled === true,
        })
      }
    }
    for (const { entry, record: row } of staged) {
      results.push({ direction: entry.direction, type: entry.type, action: 'staged', enabled: false, missingCredentials: row.missingCredentials })
    }

    previews.delete(String(token ?? ''))
    return {
      committed: true,
      results,
      staged: listStaged(),
      externalReferences: record.parsed.externalReferences,
      credentialDescriptors: record.parsed.credentialDescriptors,
    }
  }

  function listStaged() {
    const out = []
    try {
      const keys = typeof store?.keys === 'function' ? store.keys(STAGED_PREFIX) : []
      for (const key of keys) {
        const record = plain(store.get(key))
        if (record !== null) out.push(clone(record))
      }
    } catch { /* 读取失败按无暂存处理：读路径不谎报暂存存在 */ }
    return out
  }

  /** Read back the canonical public config (post-commit verification). */
  function readBack() {
    const channels = []
    for (const type of CHANNEL_TYPES) {
      const current = currentPublicOf('outbound', type)
      if (current.configured) channels.push({ direction: 'outbound', type, enabled: current.enabled, config: current.config })
    }
    for (const type of INBOUND_CHANNELS) {
      const current = currentPublicOf('inbound', type)
      if (current.configured) channels.push({ direction: 'inbound', type, enabled: current.enabled, config: current.config })
    }
    return { channels, staged: listStaged() }
  }

  return { exportConfig, previewImport, cancelImport, commitImport, readBack, listStaged, documentType: DOCUMENT_TYPE, formatVersion: FORMAT_VERSION }
}