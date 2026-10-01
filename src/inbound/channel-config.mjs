// v0.12.1（P1-03 / D-01 第一步）：入站通道配置读写的独立能力。
// Native Control Surface 与 Admin 共用此端口，避免 Native 依赖 admin.enabled 的装配生命周期。

import { INBOUND_CHANNELS, INBOUND_CHANNEL_SET } from './channels-registry.mjs'
import { toInboundChannelName } from './capability-matrix.mjs'
import { deleteDurable, setDurable, transactDurable } from './store.mjs'
import { isPublicExposure } from '../security/exposure.mjs'
import { splitSecretPatch } from '../security/secret-patch.mjs'
import { inboundApplyMode, isHotApplied } from '../control-surface/apply-mode.mjs'

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

/**
 * v0.15（Gate 2B）：入站 put 归一化——SECRET split、空白剔除、`null` → clear、字段校验。
 * 纯函数，`put()` 与窄 seam `planPut()` 共用，保证两条路径对同一输入得到相同字段集合。
 */
function normalizePutInput(type, config) {
  const normalized = toInboundChannelName(type)
  if (typeof type !== 'string' || !INBOUND_CHANNEL_SET.has(normalized)) {
    throw Object.assign(new Error(`未知入站通道类型 "${String(type)}"（可用：${INBOUND_CHANNELS.join('/')}）`), { status: 422 })
  }
  let split
  try {
    split = splitSecretPatch(config)
  } catch (error) {
    error.status = 422
    throw error
  }
  const clear = new Set(split.clear)
  const obj = { ...(split.patch ?? {}) }
  if (plain(config) === null || (Object.keys(obj).length === 0 && clear.size === 0)) {
    throw Object.assign(new Error('config 必须是非空对象'), { status: 422 })
  }
  const allowed = inboundKeyWhitelist(normalized)
  if (allowed.size === 0) {
    throw Object.assign(new Error(`${normalized} 凭证由扫码登录自动写入，不支持手工配置`), { status: 422 })
  }
  if (Object.keys(obj).length + clear.size > MAX_CHANNEL_KEYS) {
    throw Object.assign(new Error(`字段数超过上限（最多 ${MAX_CHANNEL_KEYS} 个）`), { status: 422 })
  }
  const fields = INBOUND_FIELDS[normalized] ?? {}
  const inputKeys = Object.keys(obj)
  const allKnownBlank = inputKeys.length > 0
    && inputKeys.every((key) => allowed.has(key) && typeof obj[key] === 'string' && obj[key].trim() === '')
  for (const key of inputKeys) {
    if (allowed.has(key) && typeof obj[key] === 'string' && obj[key].trim() === '') delete obj[key]
  }
  for (const key of clear) {
    if (DANGEROUS_KEYS.has(key) || !allowed.has(key)) {
      throw Object.assign(new Error(`未知字段 "${key}"（${normalized} 可用字段：${[...allowed].join('/')}）`), { status: 422 })
    }
    if (isPublicExposure(fields[key])) {
      throw Object.assign(new Error(`公共字段 "${key}" 不支持清除`), { status: 422 })
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) throw Object.assign(new Error(`保留键 "${key}" 不可写入`), { status: 422 })
    if (!allowed.has(key)) throw Object.assign(new Error(`未知字段 "${key}"（${normalized} 可用字段：${[...allowed].join('/')}）`), { status: 422 })
    if (value === null) {
      if (isPublicExposure(fields[key])) {
        throw Object.assign(new Error(`公共字段 "${key}" 不支持清除`), { status: 422 })
      }
      clear.add(key)
      delete obj[key]
      continue
    }
    const bad = describeBadChannelValue(key, value)
    if (bad !== null) throw Object.assign(new Error(bad), { status: 422 })
  }
  return { normalized, obj, clear, allKnownBlank }
}

export function createInboundChannelConfigPort({ store, warn = () => {}, audit = () => {}, runtime = null } = {}) {
  let version = 0
  const read = (key) => {
    try { return store?.get?.(key) } catch { return undefined }
  }
  // v0.13（C11.5 / R6）：运行时真值查询（装配层注入薄聚合）。缺省 unknown——
  // 绝不用 persisted 配置冒充「已在线」。
  const runtimeOf = (type) => {
    try {
      const value = typeof runtime === 'function' ? runtime(type) : null
      return plain(value) ?? null
    } catch { return null }
  }

  function rows() {
    return INBOUND_CHANNELS.map((type) => {
      const config = plain(read(`${type}:account`)) ?? {}
      const configured = Object.keys(config).length > 0
      const runtimeState = runtimeOf(type)
      // desired（configured）与 runtime（active）分层：configured=true 绝不推 active=true。
      // 拿不到真实 lifecycle → active=false、restartPending=true（入站保存后需重启并入 transport）。
      const active = runtimeState?.active === true
      return {
        type,
        direction: 'inbound',
        configured,
        enabled: configured,
        active,
        applyMode: inboundApplyMode(),
        restartPending: configured && !active,
        restartRequired: !isHotApplied('inbound'),
        editable: true,
        config: maskSecrets(config, inboundKeyWhitelist(type), type),
        fields: { ...(INBOUND_FIELDS[type] ?? {}) },
      }
    })
  }

  function put(type, config) {
    const { normalized, obj, clear, allKnownBlank } = normalizePutInput(type, config)
    if (allKnownBlank && clear.size === 0) {
      return { type: normalized, saved: true, direction: 'inbound', unchanged: true, configRevision: version }
    }
    const key = `${normalized}:account`
    // v0.14（P1-05）：read/merge/clear/write 全部放进一次 store.transact——并发 patch 同一
    // `<type>:account` 的不同字段时，后提交者以 draft 最新值为基底合并，绝不覆盖前一提交的
    // 兄弟字段（事务外读 existing 再整对象写的读-改-写窗口即 sibling lost update 的来源）。
    // 校验已在上文事务外完成（本方法只做持久化原语）。
    let okSaved
    if (typeof store?.transact === 'function') {
      const result = transactDurable(store, (draft) => {
        const existing = plain(draft[key]) ?? {}
        const next = { ...existing, ...clone(obj) }
        for (const field of clear) delete next[field]
        draft[key] = next
        return true
      })
      okSaved = result.committed === true
    } else {
      const existing = plain(read(key)) ?? {}
      const next = { ...existing, ...obj }
      for (const field of clear) delete next[field]
      okSaved = setDurable(store, key, clone(next)) === true
    }
    if (okSaved !== true) {
      warn(`入站通道配置写入失败: ${normalized}`)
      return { type: normalized, saved: false, direction: 'inbound' }
    }
    version += 1
    audit('putInboundChannel', { type: normalized })
    return {
      type: normalized,
      saved: true,
      direction: 'inbound',
      configRevision: version,
      ...(clear.size > 0 ? { cleared: [...clear] } : {}),
    }
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

  /**
   * v0.14（S12）：凭证域（`<type>:account`）的事务化字段级合并写。
   * 供共享 ChannelControlService 的 legacy 兼容路由（Admin `PUT /api/channels/:type`）调用——
   * Admin 适配器不再直接写 store（I9）。合并与落盘在同一事务内完成，并发写兄弟字段不会被
   * 读-改-写窗口静默覆盖（I10）；落盘失败时内存与磁盘都不变（I2/I16）。字段校验由调用方在
   * 调用前完成（本方法是持久化原语，不做形态校验，也不归一化 type——legacy 路由按原 key 落盘）。
   * @param {string} type - 通道类型（原样用作 `<type>:account` 键）
   * @param {object} patch - 已校验的字段补丁（非空普通对象）
   * @returns {{ saved: boolean, unchanged?: boolean }}
   */
  function mergeAccount(type, patch) {
    const key = `${String(type)}:account`
    const obj = plain(patch)
    if (obj === null || Object.keys(obj).length === 0) return { saved: true, unchanged: true }
    let committed
    if (typeof store?.transact === 'function') {
      const result = transactDurable(store, (draft) => {
        const existing = plain(draft[key]) ?? {}
        draft[key] = { ...existing, ...clone(obj) }
        return true
      })
      committed = result.committed === true
    } else {
      const existing = plain(read(key)) ?? {}
      committed = setDurable(store, key, clone({ ...existing, ...obj })) === true
    }
    if (committed !== true) {
      warn(`通道凭证写入失败（未落盘，已保留当前状态）: ${String(type)}`)
      return { saved: false }
    }
    version += 1
    return { saved: true }
  }

  /**
   * v0.15（Gate 2B）窄 seam 1/2：**只规划、不落盘**。校验 + 归一化，返回带 `key` 与
   * `mergeInto(draft)` 的计划，供调用方在单一事务里与出站/staged 行一起原子写入。
   */
  function planPut(type, config) {
    const { normalized, obj, clear, allKnownBlank } = normalizePutInput(type, config)
    const key = `${normalized}:account`
    if (allKnownBlank && clear.size === 0) return { type: normalized, key, unchanged: true }
    return {
      type: normalized,
      key,
      unchanged: false,
      mergeInto(draft) {
        const existing = plain(draft[key]) ?? {}
        const next = { ...existing, ...clone(obj) }
        for (const field of clear) delete next[field]
        draft[key] = next
        return next
      },
    }
  }

  /**
   * v0.15（Gate 2B）窄 seam 2/2：desired 已提交后的 runtime reconcile。
   * 入站默认非热生效——返回 `restart-pending`，绝不谎报已生效。
   */
  function applyCommitted(type) {
    const normalized = toInboundChannelName(type)
    version += 1
    audit('putInboundChannel', { type: normalized })
    const hot = isHotApplied('inbound')
    return {
      type: normalized,
      saved: true,
      direction: 'inbound',
      applied: hot,
      applyMode: hot ? 'hot' : 'restart-pending',
      restartPending: !hot,
      configRevision: version,
    }
  }

  return { rows, put, remove, mergeAccount, planPut, applyCommitted, get version() { return version } }
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
