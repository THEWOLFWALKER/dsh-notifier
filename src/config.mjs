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
import * as bell from './adapters/bell.mjs'
// 阶段 1 新增：spec 引擎吃声明表产出 adapter + token 型代码适配器。
import { SPEC_CHANNELS } from './adapters/spec-channels.mjs'
import { makeSpecAdapters, secretFieldsOfTable } from './adapters/_engine.mjs'
import * as qqBot from './adapters/qq-bot.mjs'
import * as wecomApp from './adapters/wecom-app.mjs'

const SPEC_ADAPTERS = makeSpecAdapters(SPEC_CHANNELS)

/** adapter 注册表：type -> { type, resolve, send }。既有 8 个零改动；spec 渠道由引擎产出。 */
export const ADAPTERS = Object.freeze({
  telegram,
  dingtalk,
  feishu,
  wxpusher,
  pushplus,
  serverchan,
  bark,
  webhook,
  bell,
  ...SPEC_ADAPTERS,
  'qq-bot': qqBot,
  'wecom-app': wecomApp,
})

export const CHANNEL_TYPES = Object.freeze(Object.keys(ADAPTERS))

/** 每渠道的 secret 键：这些字段在日志/诊断里必须脱敏。spec 渠道由声明表自动登记。 */
const SECRET_FIELDS = {
  telegram: ['botToken'],
  dingtalk: ['webhook', 'secret'],
  feishu: ['webhook', 'secret'],
  wxpusher: ['appToken', 'uids', 'topicIds'],
  pushplus: ['token'],
  serverchan: ['sct', 'sendKey', 'sctKey'],
  bark: ['key', 'barkUrl'],
  webhook: ['url', 'headers'],
  ...secretFieldsOfTable(SPEC_CHANNELS),
  'qq-bot': ['appId', 'appSecret'],
  'wecom-app': ['corpid', 'secret'],
}

/** 取某渠道的 secret 键列表（未知渠道返回空数组）。 */
export function secretFieldsOf(type) {
  return SECRET_FIELDS[type] ?? []
}

/**
 * 解析 ${ENV:NAME} 式环境变量引用（全值替换）。
 * 「通知器是密钥集中器」：让密钥可以不落 profile 明文；缺失环境变量返回空串
 * （渠道会因校验失败被跳过，reason 里带字段名与来源指引）。
 */
const ENV_REF = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/

export function resolveEnvRef(value) {
  if (typeof value !== 'string') return value
  const match = ENV_REF.exec(value.trim())
  if (match === null) return value
  return process.env[match[1]] ?? ''
}

/** 递归把配置对象里的 ${ENV:NAME} 字符串值替换为环境变量值。 */
export function resolveEnvRefs(value) {
  if (typeof value === 'string') return resolveEnvRef(value)
  if (Array.isArray(value)) return value.map(resolveEnvRefs)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = resolveEnvRefs(item)
    return out
  }
  return value
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

  // 事件粒度开关（阶段 2 规则引擎）：默认全开。turnEnd 支持两种写法：
  //   turnEnd: false                     → 整类关闭
  //   turnEnd: { completed: false, ... } → 按结束原因分控（未知原因键默认放行，不吞新事件）
  const rawEvents = (raw.events !== null && typeof raw.events === 'object') ? raw.events : {}
  const rawTurnEnd = rawEvents.turnEnd
  const turnEndKinds = (kindMap) => {
    const defaults = { completed: true, error: true, blocked: true, aborted: true, 'max-tokens': true, interrupted: true }
    if (kindMap === null || typeof kindMap !== 'object' || Array.isArray(kindMap)) return defaults
    const out = { ...defaults }
    for (const [kind, enabled] of Object.entries(kindMap)) {
      if (typeof enabled === 'boolean') out[kind] = enabled
    }
    return out
  }
  const events = {
    turnEnd: {
      enabled: rawTurnEnd !== false,
      kinds: turnEndKinds(rawTurnEnd),
    },
    approval: rawEvents.approval !== false,
    agentError: rawEvents.agentError !== false,
  }

  // agent 工具滑动窗口调用上限（阶段 6）：防 prompt injection 把用户渠道刷成垃圾出口；0 = 不限。
  const toolRateLimitPerMinute = typeof raw.toolRateLimitPerMinute === 'number' && Number.isFinite(raw.toolRateLimitPerMinute)
    ? Math.max(0, Math.trunc(raw.toolRateLimitPerMinute))
    : 10

  // 空闲宽限窗（阶段 2 规则引擎）：turn 结束后等 N 秒，期间用户在页面/终端输入即取消打扰。
  const graceSeconds = typeof raw.graceSeconds === 'number' && Number.isFinite(raw.graceSeconds)
    ? Math.max(0, Math.trunc(raw.graceSeconds))
    : 0

  // 出站收敛分段（阶段 5）：超预算长文本按 Unicode 码点切段（含（i/n）前缀）顺序送达。
  const rawSegment = (raw.segment !== null && typeof raw.segment === 'object') ? raw.segment : {}
  const segment = {
    enabled: rawSegment.enabled !== false,
    maxCodepoints: typeof rawSegment.maxCodepoints === 'number' && Number.isFinite(rawSegment.maxCodepoints)
      ? Math.max(60, Math.trunc(rawSegment.maxCodepoints))
      : 1200,
  }

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
      // 密钥环境变量引用（${ENV:NAME}）先于校验解析，密钥可不落 profile 明文
      const resolved = adapter.resolve(resolveEnvRefs(row))
      channels.push({ type, config: resolved })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      skipped.push({ type, reason })
    }
  }

  return {
    enabled,
    debounceMs,
    summaryMaxChars,
    titlePrefix,
    events,
    toolRateLimitPerMinute,
    graceSeconds,
    routing: (raw.routing !== null && typeof raw.routing === 'object') ? raw.routing : {},
    inbound: (raw.inbound !== null && typeof raw.inbound === 'object') ? raw.inbound : {},
    approval: (raw.approval !== null && typeof raw.approval === 'object') ? raw.approval : {},
    segment,
    digest: (raw.digest !== null && typeof raw.digest === 'object') ? raw.digest : {},
    keywords: (raw.keywords !== null && typeof raw.keywords === 'object') ? raw.keywords : {},
    channels,
    skipped,
  }
}

/** 单渠道发送结果（供 notify()/notifyAll() 与工具渲染）。 */
export function channelResult(channel, outcome, error) {
  if (outcome === 'sent') return { channel, ok: true, skipped: false, error: undefined }
  if (outcome === 'skipped') return { channel, ok: false, skipped: true, error: undefined }
  return { channel, ok: false, skipped: false, error }
}

export { NotifyError, ERROR_CODES }
