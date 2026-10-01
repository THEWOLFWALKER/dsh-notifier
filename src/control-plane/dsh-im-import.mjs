// EXPERIMENTAL: simulated service/export contract, not verified against current dsh-im.
// dsh-notifier v0.15 (T23) — dsh-im known-format migration importer.
//
// Reads a user-provided dsh-im bot export in one of the *locked* known formats
// (feishu-legacy / feishu-v2 / qq / dingtalk / telegram) and turns it into a
// dry-run mapping onto the notifier's existing outbound channels. It is a pure
// translator + planner: it owns NO store key and performs NO durable write of its
// own — commit delegates to the canonical portability / outbound-config authority.
//
// Why a translator instead of a second importer: the T21 portability service is
// already the single authority for "move committed channel config between
// environments" (strict parse, dry-run, disabled staging, one-transaction commit,
// secret-keep semantics). This module only normalizes a *foreign* dsh-im document
// into that v1 document shape, so every safety rule stays single-sourced.
//
// Safety rules (06-INTEGRATIONS §已知格式导入 / T23 边界):
//   * unknown / future formats fail closed (never guessed, never half-parsed);
//   * credentials are never bulk-scanned, never copied as plaintext: a secret
//     field is reported with its *source* (inline / env ref / opaque host ref /
//     masked) and a requirement (supply / reference), never written as a value;
//   * owner / approvedSenders / session / offset / loginContext / pendingAction /
//     tempWebhook are dropped on sight — a live waiter or membership fact must
//     never be migrated (D08);
//   * multiple bots for one slot are never silently merged into a multi-account
//     model — exactly one candidate per notifier channel, the rest are
//     "alternatives" to review (D09);
//   * the source string is read-only (detected + parsed, never mutated).

import { CHANNEL_TYPES, channelFieldsOf } from '../config.mjs'
import { isPublicExposure } from '../security/exposure.mjs'

const SOURCE_TYPE = 'dsh-im-bots'
const PORTABILITY_TYPE = 'dsh-notifier-config'
const PORTABILITY_VERSION = 1
const MAX_BYTES = 1024 * 1024
const MAX_BOTS = 200
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ENV_REF = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/
const OPAQUE_REF = /^(?:hs|credential|vault|secret):\/\//i
const MASKED = /^(?:\*+|•+|••+)/
const OUTBOUND = new Set(CHANNEL_TYPES)

// Locked format descriptors. `targetType: null` + `equivalent:false` marks a
// dsh-im bot that has no notifier outbound equivalent (→ skip + bridge hint).
const FORMATS = Object.freeze({
  'feishu-legacy': { targetType: 'feishu', version: 1, description: '飞书群自定义机器人（单 bot）' },
  'feishu-v2': { targetType: null, version: 2, equivalent: false, bridge: true, description: '飞书应用机器人（app 凭证，无出站等价渠道）' },
  qq: { targetType: 'qq-bot', version: 1, description: 'QQ 开放平台机器人' },
  dingtalk: { targetType: 'dingtalk', version: 1, description: '钉钉群自定义机器人' },
  telegram: { targetType: 'telegram', version: 1, description: 'Telegram Bot' },
})

const FORMAT_IDS = Object.freeze(Object.keys(FORMATS))

const DROPPED_ROOT = new Set([
  'owner', 'approvedSenders', 'session', 'offset',
  'loginContext', 'pendingAction', 'tempWebhook',
  'idempotencyKey', 'chatRef', 'sessionId', 'platformRoute',
])

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const clone = (value) => JSON.parse(JSON.stringify(value))
const bad = (message) => Object.assign(new Error(message), { code: 'bad-request' })

function byteLength(text) {
  try { return Buffer.byteLength(String(text), 'utf8') } catch { return Infinity }
}

function assertNoDangerousKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${path}[${index}]`))
    return
  }
  const obj = plain(value)
  if (obj === null) return
  for (const [key, item] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) throw bad(`文件包含保留键 "${key}"（${path}）`)
    assertNoDangerousKeys(item, `${path}.${key}`)
  }
}

/** Classify one credential field's source + requirement (D07). Never its value. */
function classifySecret(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return { source: 'missing', requirement: 'supply', writable: false, name: null }
  const env = ENV_REF.exec(text)
  if (env !== null) return { source: 'env', requirement: 'reference', writable: true, name: env[1] }
  if (OPAQUE_REF.test(text)) return { source: 'opaque', requirement: 'supply', writable: false, name: null }
  if (MASKED.test(text)) return { source: 'masked', requirement: 'supply', writable: false, name: null }
  return { source: 'inline', requirement: 'supply', writable: false, name: null }
}

/** The notifier public field names for one outbound channel type. */
function publicFieldsOf(type) {
  const keys = new Set()
  for (const [key, meta] of Object.entries(channelFieldsOf(type))) if (isPublicExposure(meta)) keys.add(key)
  return keys
}

/**
 * Parse + detect a source string into `{ format, formatVersion, descriptor, root, bots }`.
 * Fail-closed on unknown source type / format / version (D06).
 */
function detect(text) {
  const size = byteLength(text)
  if (size > MAX_BYTES) throw bad(`文件超过 ${MAX_BYTES} 字节上限（${size}）`)
  let parsed
  try { parsed = JSON.parse(typeof text === 'string' ? text : String(text)) } catch { throw bad('文件不是合法 JSON') }
  const root = plain(parsed)
  if (root === null) throw bad('文件顶层必须是对象')
  assertNoDangerousKeys(root)
  if (root.sourceType !== SOURCE_TYPE) throw bad(`不支持的 sourceType "${String(root.sourceType)}"（期望 ${SOURCE_TYPE}）`)
  const format = String(root.format ?? '').trim()
  if (!FORMAT_IDS.includes(format)) throw bad(`未知或不支持的 dsh-im 格式 "${format}"（支持：${FORMAT_IDS.join(' / ')}）`)
  const descriptor = FORMATS[format]
  const formatVersion = Number(root.formatVersion)
  if (!Number.isInteger(formatVersion) || formatVersion !== descriptor.version) {
    throw bad(`格式 "${format}" 仅支持 formatVersion ${descriptor.version}，收到 ${String(root.formatVersion)}`)
  }
  const rawBots = root.bots
  if (!Array.isArray(rawBots)) throw bad('bots 必须是数组')
  if (rawBots.length > MAX_BOTS) throw bad(`bots 超过 ${MAX_BOTS} 条上限`)
  return { format, formatVersion, descriptor, root, bots: rawBots }
}

const IDENTITY_KEYS = new Set(['name', 'label', 'title', 'botId', 'id'])

/** Map one dsh-im bot into a candidate for one notifier outbound channel. */
function mapBot(descriptor, bot, index, currentStateOf) {
  const object = plain(bot)
  if (object === null) throw bad(`bots[${index}] 必须是对象`)
  const targetType = descriptor.targetType

  // No outbound equivalent → skip + bridge hint (never a bot-prefix guess).
  if (targetType === null || descriptor.equivalent === false) {
    return { index, targetType: null, decision: 'skip', reason: 'no-equivalent', bridge: descriptor.bridge === true, label: null }
  }

  const fields = channelFieldsOf(targetType)
  const publicKeys = publicFieldsOf(targetType)
  const dropped = []
  const public_ = {}
  const secrets = []
  let label = null

  for (const [key, value] of Object.entries(object)) {
    if (DANGEROUS_KEYS.has(key)) throw bad(`bots[${index}] 含保留键 "${key}"`)
    if (IDENTITY_KEYS.has(key)) {
      if (typeof value === 'string' && value.trim() !== '') label ??= value.trim()
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(fields, key)) { dropped.push(key); continue }
    if (!isPublicExposure(fields[key])) {
      secrets.push({ field: key, ...classifySecret(value) })
      continue
    }
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (publicKeys.has(key)) public_[key] = clone(value)
  }

  const current = currentStateOf(targetType)
  const hasPublic = Object.keys(public_).length > 0
  let decision
  if (!current.configured) decision = 'add'
  else if (!hasPublic) decision = 'skip'
  else if (JSON.stringify(current.config) === JSON.stringify(public_)) decision = 'skip'
  else decision = 'patch'

  return { index, targetType, decision, public: public_, secrets, dropped, label }
}

/** Compute the current public state of one outbound channel (read-only). */
function readCurrentPublic(outboundConfig, type) {
  try {
    const raw = plain(outboundConfig?.raw?.(type)) ?? {}
    const publicKeys = publicFieldsOf(type)
    const config = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!publicKeys.has(key)) continue
      if (typeof value === 'string' && ENV_REF.test(value.trim())) continue
      config[key] = value
    }
    return { config, configured: Object.keys(raw).length > 0 }
  } catch { return { config: {}, configured: false } }
}

/**
 * @param {object} deps
 * @param {object} deps.portability - createConfigPortabilityService() instance (canonical authority)
 * @param {object} [deps.outboundConfig] - createOutboundConfigService() instance (for slot-state reads)
 */
export function createDshImImportService({ portability, outboundConfig = null } = {}) {
  if (portability === null || typeof portability?.previewImport !== 'function'
    || typeof portability?.commitImport !== 'function') {
    throw new TypeError('dsh-im importer requires the portability service')
  }

  const currentStateOf = (type) => readCurrentPublic(outboundConfig, type)

  /** Map a source into a full plan (no write). */
  function plan(text) {
    const detected = detect(text)
    const { root } = detected
    const droppedRoot = []
    for (const key of Object.keys(root)) if (DROPPED_ROOT.has(key)) droppedRoot.push(key)
    const bots = detected.bots.map((bot, index) => mapBot(detected.descriptor, bot, index, currentStateOf))
    return {
      format: detected.format,
      formatVersion: detected.formatVersion,
      description: detected.descriptor.description,
      botCount: detected.bots.length,
      droppedRoot,
      bots,
    }
  }

  /**
   * Translate the eligible candidates into a portability v1 document (public
   * fields only; secrets are never inlined). At most one candidate per notifier
   * channel — extra bots become `alternatives` and are never imported (D09).
   */
  function translate(bots) {
    const channels = []
    const credentialDescriptors = []
    const externalReferences = []
    const alternatives = []
    const seen = new Set()
    for (const bot of bots) {
      if (bot.targetType === null) continue // no-equivalent: reported in bots, never imported
      if (seen.has(bot.targetType)) { alternatives.push(bot); continue }
      seen.add(bot.targetType)
      channels.push({ direction: 'outbound', type: bot.targetType, enabled: false, config: bot.public })
      for (const secret of bot.secrets) {
        if (secret.source === 'env') {
          externalReferences.push({ direction: 'outbound', type: bot.targetType, field: secret.field, kind: 'env', name: secret.name })
          credentialDescriptors.push({ direction: 'outbound', type: bot.targetType, field: secret.field, requirement: 'reference' })
        } else {
          credentialDescriptors.push({ direction: 'outbound', type: bot.targetType, field: secret.field, requirement: 'supply', source: secret.source })
        }
      }
    }
    const document = {
      documentType: PORTABILITY_TYPE,
      formatVersion: PORTABILITY_VERSION,
      sourcePluginVersion: 'dsh-im-import',
      createdAt: new Date().toISOString(),
      scopes: ['channels'],
      channels,
      notificationPreferences: {},
      credentialDescriptors,
      externalReferences,
    }
    return { document, alternatives }
  }

  /** Dry-run: map + translate, then delegate to the portability authority. */
  function preview({ text } = {}) {
    const detected = detect(text ?? '')
    const planed = plan(text ?? '')
    const { document, alternatives } = translate(planed.bots)
    const portabilityResult = portability.previewImport({ text: JSON.stringify(document) })
    return {
      ...portabilityResult,
      dshIm: {
        format: planed.format,
        formatVersion: planed.formatVersion,
        description: planed.description,
        botCount: planed.botCount,
        droppedRoot: planed.droppedRoot,
        bots: planed.bots.map((bot) => ({
          index: bot.index,
          targetType: bot.targetType,
          decision: bot.decision,
          reason: bot.reason ?? null,
          bridge: bot.bridge === true,
          label: bot.label ?? null,
          public: bot.public ?? {},
          secrets: bot.secrets ?? [],
          dropped: bot.dropped ?? [],
        })),
        alternatives: alternatives.map((bot) => ({
          index: bot.index,
          targetType: bot.targetType,
          reason: 'duplicate-slot',
          label: bot.label ?? null,
        })),
      },
    }
  }

  /** Commit delegates verbatim to the portability authority (single writer). */
  function commit({ token, selections } = {}) {
    return portability.commitImport({ token, selections })
  }

  function cancel({ token } = {}) {
    return portability.cancelImport({ token })
  }

  return Object.freeze({ detect, plan, preview, commit, cancel, sourceType: SOURCE_TYPE, formats: FORMAT_IDS })
}