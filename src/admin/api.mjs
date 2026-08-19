// dsh-notifier admin/api.mjs
// v0.3.3 Web 管理台 API 函数层（设计稿 §5「UI 与 CLI 走同一套 API 函数」）。
// HTTP 层（server.mjs，并行开发）只做「token 鉴权 + 路由分发 + JSON 序列化」，按方法名调用
// 本层；单文件 UI（ui.mjs）与 CLI（scripts/route.mjs 等）经同一批函数读写——不存在第二套业务逻辑。
//
// 配置写入原则（§5「消除改 YAML 反人类」）：YAML 只做 bootstrap，一切运行时可变状态写
// state.json——
//   - 通道凭证：`<type>:account` 键（与扫码 CLI 落盘同域；UI 表单 → putChannel）；
//   - 路由矩阵：route:agents / route:channels / route:sessions，一律经 agent-router 的
//     setter 落盘（putBindings 整表替换 = clear + set 逐键重建），本层不绕开 router 直写路由表。
//
// 防御红线（对齐 src/routing/*.mjs 的防御壳 + 普通对象校验风格）：
//   - 查询方法（overview/getBindings/getSessions/getChannels/getAudit）绝不抛：依赖缺失、
//     store 抛错、数据损坏一律按空数据/未配置降级；
//   - 写方法（putBindings/patchSession/putChannel）入参校验失败抛 ApiError(422, 中文消息)、
//     目标不存在抛 ApiError(404)、存储写入失败抛 ApiError(500) 或降级 saved:false——
//     绝不让底层异常裸穿到 HTTP 层；
//   - 动作方法（testChannel/scanChannel）能力不可用抛 ApiError(501)，可用则结果原样透传；
//   - 审计（<stateDir>/admin-audit.jsonl，append-only，§5「谁改了什么」）失败只 warn，
//     绝不影响主流程。

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CHANNEL_TYPES, channelFieldsOf } from '../config.mjs'

/**
 * 入站通道全集（与 inbound 装配一一对应；出站全集 = config.mjs 的 CHANNEL_TYPES）。
 * 逐字契约：server.mjs / ui.mjs 按此并行开发，勿改顺序与成员。
 */
export const INBOUND_CHANNELS = ['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk']

/**
 * 双域冲突通道：既是出站 webhook 渠道（webhook/secret）又是入站机器人渠道
 * （appId/appSecret 或 appKey/appSecret），且两边共用同一个 `<type>:account` 键。
 * 键域裁定：`<type>:account` 归入站机器人凭证（v0.3.1 扫码 CLI 既有语义，不动）；
 * 这两类的**出站** webhook 凭证只走 YAML bootstrap——UI 表单对出站行只读，
 * putChannel 拒绝含 webhook 键的写入（防 UI 一键抹掉入站扫码凭证）。
 * telegram/wxpusher 虽也双向，但凭证形状同域（botToken+chatId / appToken），不冲突。
 */
const DUAL_INBOUND_DOMAIN = new Set(['feishu', 'dingtalk'])

/**
 * HTTP 语义的业务错误：server.mjs 捕获后把 status 映射为响应码、message 原样返回给 UI。
 * 422 = 入参校验失败；404 = 目标（会话）不存在；500 = 存储写入失败；501 = 能力不可用。
 */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP 状态码语义（422/404/500/501）。
   * @param {string} message - 面向用户的中文错误消息。
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** state.json 路由表键（与 agent-router.mjs 同名常量；本层只读原始表，写经 router）。 */
const KEY_AGENTS = 'route:agents'
const KEY_CHANNELS = 'route:channels'
const KEY_SESSIONS = 'route:sessions'

/** 审计文件名（<stateDir>/admin-audit.jsonl，每行 { time, action, detail }）。 */
const AUDIT_FILENAME = 'admin-audit.jsonl'
/** stateDir 缺省回落 './state'（与 store.mjs 的默认数据目录约定一致）。 */
const DEFAULT_STATE_DIR = './state'

/** 出站/入站通道集合（includes 判定用 Set，避免每行 O(n) 扫描）。 */
const OUTBOUND_SET = new Set(CHANNEL_TYPES)
const INBOUND_SET = new Set(INBOUND_CHANNELS)

/** 取「普通对象」：null / 数组 / 标量一律视为无条目（手工编辑或损坏数据防御）。 */
function plainObjectOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

/** 深拷贝纯 JSON 值（表拷贝语义：外部修改返回值不污染 store）；不可序列化时原样返回兜底。 */
function deepCopyPlain(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return value
  }
}

/**
 * v0.7 成员复合键 "<channel>:<userId>" 解析（管理台路由用）。
 * userId 内含冒号也容忍（只按第一个冒号切）；渠道必须属六入站通道，userId 非空且 ≤128。
 * @returns {{ channel: string, userId: string, raw: string } | null} 非法形状返回 null
 */
const MEMBER_KEY_HINT = '成员键形状：<channel>:<userId>（channel ∈ telegram/feishu/qq/wxpusher/wechat/dingtalk）'
function parseMemberKey(key) {
  const raw = String(key ?? '').trim()
  const colon = raw.indexOf(':')
  if (colon <= 0) return null
  const channel = raw.slice(0, colon)
  const userId = raw.slice(colon + 1)
  if (!INBOUND_SET.has(channel)) return null
  if (userId === '' || userId.length > 128) return null
  return { channel, userId, raw }
}

/** 错误 → 可读消息（日志与审计用）。 */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 深遍历脱敏（getChannels 用；比 config.mjs 的 maskChannelConfig 更激进——管理台凭证表单
 * 不区分 secret 字段，凡字符串值一律不可回显）：字符串值（含嵌套对象/数组里的）替换为
 * '***'，键名与非字符串值（数字/布尔/null）原样保留。
 */
function maskSecrets(value) {
  if (typeof value === 'string') return '***'
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (plainObjectOf(value) !== null) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = maskSecrets(item)
    return out
  }
  return value
}

/** lastActiveAt → 毫秒时间戳（数字/ISO 字符串；缺失或非法视为 0，排序兜底）。 */
function lastActiveMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/** 入站通道的凭证字段表（管理台表单渲染用；wechat 为 iLink 登录态扫码产物，不手填）。 */
const INBOUND_FIELDS = {
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
  },
  wechat: {},
  dingtalk: {
    appKey: { required: true, desc: '钉钉企业内部应用 AppKey（扫码授权自动写入）' },
    appSecret: { required: true, desc: '钉钉企业内部应用 AppSecret（扫码授权自动写入）' },
  },
}

/**
 * v0.6.5（审查 R4-2-P2-1）putChannel 防线常量：
 * 原实现只校验「非空普通对象」，持 token 客户端可写任意键 + 近 1MB 垃圾值污染
 * <type>:account schema 并使 state.json 膨胀；__proto__ 等保留键虽是数据属性
 * （spread/JSON.parse 不触发原型污染）但会永久残留。改为键白名单 + 值形态上限。
 */
/** 单次写入字段数上限。 */
const MAX_CHANNEL_KEYS = 64
/** 单个字符串值字节上限（凭证/URL 远够用，垃圾值止步）。 */
const MAX_VALUE_BYTES = 8 * 1024
/** resolve 层真实消费的全渠道公共端点键（非凭证字段，显式放行）。 */
const COMMON_ENDPOINT_KEYS = ['timeoutMs', 'apiBase']
/** 保留键：自有键经 next[key]=v 赋值语义会触达原型链，且无任何字段表收录。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 某通道 putChannel 可写的键白名单：
 * 双域通道（feishu/dingtalk）= 入站字段表（键域归入站，webhook/secret 等出站字段不放行）；
 * 双向同域通道（telegram/wxpusher）= 出站字段表 ∪ 入站字段表 ∪ 公共端点键；
 * 其余出站 = 出站字段表 ∪ 公共端点键。wechat 返回空集（iLink 登录态只能扫码写入）。
 * @param {string} type
 * @returns {Set<string>}
 */
function channelKeyWhitelist(type) {
  const keys = new Set()
  if (DUAL_INBOUND_DOMAIN.has(type)) {
    for (const key of Object.keys(INBOUND_FIELDS[type] ?? {})) keys.add(key)
    return keys
  }
  if (OUTBOUND_SET.has(type)) {
    for (const key of Object.keys(channelFieldsOf(type))) keys.add(key)
    for (const key of COMMON_ENDPOINT_KEYS) keys.add(key)
  }
  if (INBOUND_SET.has(type)) {
    for (const key of Object.keys(INBOUND_FIELDS[type] ?? {})) keys.add(key)
  }
  return keys
}

/** 单值字节数（字符串按 UTF-8 计）。 */
const valueBytes = (value) => {
  try { return Buffer.byteLength(value, 'utf8') } catch { return Infinity }
}

/**
 * 递归校验凭证值形态（putChannel 用）：string（≤8KB）/ number / boolean /
 * 原始值数组（≤64 项）/ 原始值普通对象（≤64 键，如 webhook.headers）。
 * @param {string} key - 字段名（错误消息用）。
 * @param {unknown} value
 * @returns {string | null} 首个违规的中文错误消息；合法返回 null。
 */
function describeBadChannelValue(key, value) {
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
  const obj = plainObjectOf(value)
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
 * 创建 Web 管理台 API 实例（server.mjs 按方法名调用；全部依赖可缺省）。
 *
 * @param {object} [options]
 * @param {object} [options.router] - agent-router 实例（路由表唯一写入口 + 出站解析链）；
 *   缺失时查询按无路由配置降级、写方法按存储失败处理
 * @param {object} [options.registry] - session-registry 实例（isActive/getSession）；
 *   缺失时活跃判定一律 false、建档判定只看 store
 * @param {object} [options.store] - 键值存储（src/inbound/store.mjs 形态）；
 *   缺失/抛错一律按「无此数据」降级，绝不外泄
 * @param {object} [options.notifier] - notify.mjs 实例（channels 属性 = 已启用出站渠道）；
 *   仅作为 channelsEnabled 缺省时的回落来源
 * @param {() => string[]} [options.channelsEnabled] - 已启用出站渠道类型列表；
 *   缺省/抛错回落 notifier.channels，再缺省回落 []
 * @param {() => Record<string, object>} [options.outboundConfigs] - YAML bootstrap 解析出的
 *   出站渠道配置表（type → resolved config，装配层注入 resolved.channels 快照）；
 *   getChannels 出站行展示「YAML ⊕ store 账号」合并视图（store 字段覆盖同名 YAML 字段）；
 *   缺省/抛错按无 YAML 配置降级（store 账号独立成视图）
 * @param {(type: string) => Promise<object>} [options.channelTest] - 单渠道连通性自检
 *   （装配层注入，如 health/self-check 包装）；缺省时 testChannel 抛 501
 * @param {Record<string, () => Promise<{qrContent, done, saved?}>>} [options.scanHandlers] -
 *   各入站通道的网页扫码处理器（装配层保证形状）；无对应通道处理器时 scanChannel 抛 501
 * @param {object} [options.identity] - v0.7 身份绑定层实例（src/inbound/identity.mjs）；
 *   与宿主 inbound 共用同一实例（store 读收敛让管理台写入半秒内对运行中宿主生效）；
 *   缺失时成员查询按空表降级、成员写方法抛 501（能力不可用）
 * @param {object} [options.pairing] - v0.7 配对码状态机实例（src/inbound/pairing.mjs）；
 *   缺失时配对码查询按空表降级、铸造/撤销抛 501
 * @param {() => boolean} [options.guidedProbe] - v0.7 引导态探针（与 bus.isGuided 同口径：
 *   绑定表空 + allowUsers 空）；缺省按非引导态展示
 * @param {string} [options.stateDir] - 审计文件目录（缺省回落 './state'；测试注入临时目录）
 * @param {object} [options.logger] - cordis logger（warn 用）；缺省静默
 * @returns {object} API 实例：overview/getBindings/putBindings/getSessions/patchSession/
 *   getChannels/putChannel/testChannel/scanChannel/getMembers/putMember/deleteMember/
 *   confirmPendingMember/dismissPendingMember/mintPairingCode/revokePairingCode/getAudit
 *   （appendAudit 为内部函数不外露）
 */
export function createAdminApi(options = {}) {
  const {
    router, registry, store, notifier, channelsEnabled, outboundConfigs, channelTest, scanHandlers,
    identity, pairing, guidedProbe = null, stateDir, logger,
  } = options ?? {}

  const warn = (message) => {
    // stderr 双写（R5 审查 R5-2-P1-2：v0.6.1 可见性事故后 inbound 全家已双写，admin 层漏跟——
    // dsh web profile 下 logger 不落 stdout，成员读失败降级/mint 500 兜底全部零可见）
    try { logger?.warn?.('[dsh-notifier/admin-api]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/admin-api]', message) } catch { /* 控制台不可用不致命 */ }
  }

  // ---- store 防御壳：方法缺失/抛错一律按「无此数据」处理，绝不外泄 ----
  const safeGet = (key, fallback = undefined) => {
    try {
      const value = typeof store?.get === 'function' ? store.get(key, fallback) : undefined
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  /** 读路由原始表：表级损坏（非普通对象）回退 {}（下次写入顺带修复）。 */
  const readTable = (key) => plainObjectOf(safeGet(key)) ?? {}
  /** `<type>:account` 凭证键是否存在（出站/入站同域）。 */
  const hasAccount = (type) => safeGet(`${type}:account`) !== undefined

  /** 已启用出站渠道：channelsEnabled() → notifier.channels → []（层层防御，绝不抛）。 */
  const enabledTypes = () => {
    let list = null
    if (typeof channelsEnabled === 'function') {
      try { list = channelsEnabled() } catch { list = null }
    }
    if (list === null) list = Array.isArray(notifier?.channels) ? notifier.channels : null
    if (!Array.isArray(list)) return []
    return list.filter((type) => typeof type === 'string' && type !== '')
  }

  /** YAML bootstrap 出站配置表（type → config）：outboundConfigs() 缺省/抛错按 {} 降级。 */
  const yamlOutboundOf = () => {
    try {
      const table = typeof outboundConfigs === 'function' ? outboundConfigs() : null
      return plainObjectOf(table) ?? {}
    } catch {
      return {}
    }
  }

  /** registry.isActive 防御包装：缺失/抛错一律 false。 */
  const isActiveOf = (id) => {
    try { return typeof registry?.isActive === 'function' ? registry.isActive(id) === true : false } catch { return false }
  }
  /** registry.getSession 防御包装：缺失/抛错一律 undefined。 */
  const registrySessionOf = (id) => {
    try { return typeof registry?.getSession === 'function' ? registry.getSession(id) : undefined } catch { return undefined }
  }

  /**
   * 内部审计（append-only JSONL，§5「谁改了什么」）：appendFileSync 到
   * <stateDir>/admin-audit.jsonl，每行 { time, action, detail }。失败只 warn 绝不影响主流程。
   * v0.6.5（审查 R4-2-P3-5）有界轮转：超 1MB 转存 .1（只保一代，总占用 ~2MB 封顶）——
   * append-only 无上限会让长期运行把 state 目录撑爆；getAudit 并读两代保持时间线连续。
   */
  const AUDIT_MAX_BYTES = 1024 * 1024
  const auditDir = typeof stateDir === 'string' && stateDir.trim() !== '' ? stateDir : DEFAULT_STATE_DIR
  const auditFile = join(auditDir, AUDIT_FILENAME)
  function appendAudit(action, detail) {
    try {
      mkdirSync(dirname(auditFile), { recursive: true })
      try {
        if (statSync(auditFile).size > AUDIT_MAX_BYTES) {
          try { unlinkSync(`${auditFile}.1`) } catch { /* 上一代不存在：直接转存 */ }
          renameSync(auditFile, `${auditFile}.1`)
        }
      } catch { /* stat 失败（文件尚不存在等）：跳过轮转直接 append */ }
      appendFileSync(auditFile, `${JSON.stringify({ time: new Date().toISOString(), action, detail })}\n`, 'utf8')
      // v0.6.3：对齐 store 的 0600 军规（审查 R3 P2-2）——审计含 session id 与绑定键。
      try { chmodSync(auditFile, 0o600) } catch { /* Windows/受限环境无 chmod */ }
    } catch (error) {
      warn(`审计写入失败: ${errorMessage(error)}`)
    }
  }

  /**
   * 通道行全集（overview 与 getChannels 共用）：出站 = CHANNEL_TYPES 全量 + 入站 =
   * INBOUND_CHANNELS 全量（telegram/feishu 等双向通道各出一行，direction 区分）。
   * 出行 enabled = channelsEnabled() 含 type；configured = enabled 或 store 有
   * `<type>:account`（YAML 未配但 store 账号在也叫已配置——下次启动 overlay 即生效）；
   * 但双域通道（feishu/dingtalk）的 `<type>:account` 是入站机器人凭证，出站行只认
   * YAML（configured = enabled），且 editable=false（出站 webhook 走 YAML bootstrap）。
   * 入行 configured = store 有 `<channel>:account`（v0.3.1 扫码落盘域），editable 恒 true。
   */
  function channelRows() {
    const enabled = new Set(enabledTypes())
    const rows = []
    for (const type of CHANNEL_TYPES) {
      const isEnabled = enabled.has(type)
      const dual = DUAL_INBOUND_DOMAIN.has(type)
      rows.push({
        type,
        direction: 'outbound',
        configured: dual ? isEnabled : (hasAccount(type) || isEnabled),
        enabled: isEnabled,
        editable: !dual,
      })
    }
    for (const channel of INBOUND_CHANNELS) {
      const configured = hasAccount(channel)
      rows.push({ type: channel, direction: 'inbound', configured, enabled: configured, editable: true })
    }
    return rows
  }

  /** router setter 防御包装：非函数/抛错/返回非 true 一律视为写入失败。 */
  const callSetter = (setter, ...args) => {
    try {
      return typeof setter === 'function' ? setter(...args) === true : false
    } catch (error) {
      warn(`路由写入失败: ${errorMessage(error)}`)
      return false
    }
  }

  // 方法集：先落 `api` 变量再返回——overview/putBindings 需按名复用同对象的
  // getAudit()/getBindings()（与 CLI/HTTP 层走完全相同的读取路径）。
  const api = {
    /**
     * Dashboard 总览：通道健康矩阵（出站 + 入站全量行）+ 会话计数 + agent 路由键数 + 最近审计。
     * @returns {{ channels: Array<{type: string, direction: 'outbound'|'inbound',
     *   configured: boolean, enabled: boolean}>,
     *   sessions: { active: number, total: number }, agents: { keys: number },
     *   audit: Array<{time: string, action: string, detail: object}> }}
     *   sessions.total = route:sessions 表条目数（含已 dispose 未回收）；active = registry
     *   判活跃数；audit = 最近 20 条新在前。
     */
    overview() {
      const sessionIds = Object.keys(readTable(KEY_SESSIONS))
      let active = 0
      for (const id of sessionIds) {
        if (isActiveOf(id)) active += 1
      }
      let agentKeys = 0
      try { agentKeys = typeof router?.listAgentKeys === 'function' ? router.listAgentKeys().length : 0 } catch { agentKeys = 0 }
      return {
        channels: channelRows(),
        sessions: { active, total: sessionIds.length },
        agents: { keys: agentKeys },
        audit: api.getAudit().slice(0, 20),
      }
    },

    /**
     * 读双向绑定矩阵（route:agents / route:channels 原始表拷贝；外部修改不污染 store）。
     * @returns {{ agents: object, channels: object }} 表级损坏数据回退空表。
     */
    getBindings() {
      return {
        agents: deepCopyPlain(readTable(KEY_AGENTS)),
        channels: deepCopyPlain(readTable(KEY_CHANNELS)),
      }
    },

    /**
     * 写双向绑定矩阵（整表替换语义）：patch.agents / patch.channels **只出现者替换**，
     * 未出现者不动；被替换表内未出现的键整键消失、条目内未出现的字段清除。
     *
     * 校验（失败抛 ApiError(422)，零写入）：
     *   - agents 值必须是普通对象；其 channels 若出现必须是 string[] 且 ⊆ CHANNEL_TYPES；
     *     quiet 若出现必须是 boolean；
     *   - channels 表键必须 ∈ INBOUND_CHANNELS；值对象的 defaultAgent 必须是非空字符串。
     *
     * 落盘经 router 逐键重建（与 CLI 同路径，不绕开 router）：旧键集合中不在新表的用
     * setAgentBinding(key, {})（空条目即回收）/ clearChannelDefault 清除，新表逐键
     * setAgentBinding / setChannelDefault 写入（未出现字段显式传 null = 删除，保证替换语义）。
     * 任一写入失败抛 ApiError(500)（多键重建非事务，尽力而为；单键写本身是 store 的原子整文件写）。
     *
     * @param {{ agents?: object, channels?: object }} patch - 见整表替换语义。
     * @returns {{ agents: object, channels: object }} 成功后的新完整 getBindings() 结果。
     * @throws {ApiError} 422 校验失败 / 500 存储写入失败。
     */
    putBindings(patch) {
      if (plainObjectOf(patch) === null) throw new ApiError(422, '请求体必须是对象（{ agents?, channels? }）')

      let nextAgents = null
      let nextChannels = null
      if (patch.agents !== undefined) {
        const table = patch.agents
        if (plainObjectOf(table) === null) {
          throw new ApiError(422, 'agents 必须是对象表（键 → { channels?: string[], quiet?: boolean }）')
        }
        for (const [key, entry] of Object.entries(table)) {
          if (typeof key !== 'string' || key.trim() === '') throw new ApiError(422, 'agents 的键必须是非空字符串')
          // v0.6.5（审查 R4-2-P2-4）：保留键经 next[key]=v 赋值语义触达原型链
          // （setAgentBinding 的整表重建、store.set 的合并写都会中招），入口即拒。
          if (DANGEROUS_KEYS.has(key)) {
            throw new ApiError(422, `agents 的键 "${key}" 是保留键，不可用作绑定键（${[...DANGEROUS_KEYS].join('/')}）`)
          }
          if (plainObjectOf(entry) === null) {
            throw new ApiError(422, `agents["${key}"] 必须是对象（{ channels?, quiet? }）`)
          }
          if (entry.channels !== undefined) {
            if (!Array.isArray(entry.channels)) {
              throw new ApiError(422, `agents["${key}"].channels 必须是字符串数组`)
            }
            for (const type of entry.channels) {
              if (typeof type !== 'string') throw new ApiError(422, `agents["${key}"].channels 必须是字符串数组`)
              if (!OUTBOUND_SET.has(type)) {
                throw new ApiError(422, `agents["${key}"].channels 含未知出站渠道 "${String(type)}"（可用：${CHANNEL_TYPES.join('/')}）`)
              }
            }
          }
          if (entry.quiet !== undefined && typeof entry.quiet !== 'boolean') {
            throw new ApiError(422, `agents["${key}"].quiet 必须是布尔值`)
          }
        }
        nextAgents = table
      }
      if (patch.channels !== undefined) {
        const table = patch.channels
        if (plainObjectOf(table) === null) {
          throw new ApiError(422, 'channels 必须是对象表（入站通道 → { defaultAgent: string }）')
        }
        for (const [channel, entry] of Object.entries(table)) {
          if (!INBOUND_SET.has(channel)) {
            throw new ApiError(422, `channels 键 "${channel}" 不是合法入站通道（可用：${INBOUND_CHANNELS.join('/')}）`)
          }
          if (plainObjectOf(entry) === null) {
            throw new ApiError(422, `channels["${channel}"] 必须是对象（{ defaultAgent }）`)
          }
          if (typeof entry.defaultAgent !== 'string' || entry.defaultAgent.trim() === '') {
            throw new ApiError(422, `channels["${channel}"].defaultAgent 必须是非空字符串`)
          }
        }
        nextChannels = table
      }

      // 逐键重建（替换语义）：先清旧表里不在新表的键，再写新表全部键。
      // v0.6.5（审查 R4-2-P2-2）：router 提供 replaceAgentBindings/replaceChannelDefaults
      // 时走整表单次落盘（一次锁周期 + 一次整文件写）；旧 router 契约/测试桩回退逐键路径。
      if (nextAgents !== null) {
        if (typeof router?.replaceAgentBindings === 'function') {
          let written = false
          try { written = router.replaceAgentBindings(nextAgents) } catch (error) {
            throw new ApiError(422, `绑定表校验失败：${errorMessage(error)}`)
          }
          if (!written) throw new ApiError(500, '绑定写入存储失败')
        } else {
          let currentKeys = []
          try { currentKeys = typeof router?.listAgentKeys === 'function' ? router.listAgentKeys() : [] } catch { currentKeys = [] }
          const wanted = new Set(Object.keys(nextAgents))
          for (const key of currentKeys) {
            if (wanted.has(key)) continue
            // 不在新表的旧键：两字段显式 null = 从条目删除，条目清空即整键回收
            // （agent-router 语义：空条目无覆盖语义，不留无意义键；走 setAgentBinding 契约）
            if (!callSetter(router?.setAgentBinding, key, { channels: null, quiet: null })) {
              throw new ApiError(500, '绑定写入存储失败')
            }
          }
          for (const [key, entry] of Object.entries(nextAgents)) {
            // 未出现字段显式 null = 从条目删除（agent-router 字段级语义），保证整表替换不残留旧值
            const entryPatch = {
              channels: entry.channels === undefined ? null : entry.channels,
              quiet: entry.quiet === undefined ? null : entry.quiet,
            }
            if (!callSetter(router?.setAgentBinding, key, entryPatch)) throw new ApiError(500, '绑定写入存储失败')
          }
        }
      }
      if (nextChannels !== null) {
        if (typeof router?.replaceChannelDefaults === 'function') {
          let written = false
          try { written = router.replaceChannelDefaults(nextChannels) } catch (error) {
            throw new ApiError(422, `绑定表校验失败：${errorMessage(error)}`)
          }
          if (!written) throw new ApiError(500, '绑定写入存储失败')
        } else {
          const currentKeys = Object.keys(readTable(KEY_CHANNELS))
          const wanted = new Set(Object.keys(nextChannels))
          for (const channel of currentKeys) {
            if (wanted.has(channel)) continue
            if (!callSetter(router?.clearChannelDefault, channel)) throw new ApiError(500, '绑定写入存储失败')
          }
          for (const [channel, entry] of Object.entries(nextChannels)) {
            if (!callSetter(router?.setChannelDefault, channel, entry.defaultAgent)) throw new ApiError(500, '绑定写入存储失败')
          }
        }
      }

      appendAudit('putBindings', {
        agents: nextAgents === null ? null : Object.keys(nextAgents),
        channels: nextChannels === null ? null : Object.keys(nextChannels),
      })
      return api.getBindings()
    },

    /**
     * 会话列表（route:sessions 全量）：每行附出站解析结果 resolved（实时解析，非快照）。
     * 排序：活跃在前、同组 lastActiveAt 降序；损坏条目（非普通对象）跳过。
     * @returns {Array<{ id: string, workspace: string, inherit: string, active: boolean,
     *   lastActiveAt: *, disposedAt?: *, outbound?: object, inbound?: Array<object>,
     *   resolved: { channelTypes: string[], quiet: boolean, source: string } }>}
     *   resolved = router.resolveOutbound(id, workspace, channelsEnabled())；router 缺失/抛错
     *   时回落「无路由配置」的等价解析（全局渠道池、quiet=false、source='global'），绝不抛。
     */
    getSessions() {
      const enabled = enabledTypes()
      const fallbackResolved = { channelTypes: [...enabled], quiet: false, source: 'global' }
      const rows = []
      for (const [id, record] of Object.entries(readTable(KEY_SESSIONS))) {
        const rec = plainObjectOf(record)
        if (rec === null) continue // 损坏条目（手工编辑/半截写入）：跳过，不弄崩列表
        const workspace = typeof rec.workspace === 'string' ? rec.workspace : undefined
        let resolved = fallbackResolved
        try {
          if (typeof router?.resolveOutbound === 'function') {
            resolved = router.resolveOutbound(id, workspace, enabled)
          }
        } catch {
          resolved = fallbackResolved
        }
        const row = {
          id,
          workspace: rec.workspace,
          inherit: rec.inherit,
          active: isActiveOf(id),
          lastActiveAt: rec.lastActiveAt,
          resolved,
        }
        if (rec.disposedAt !== undefined) row.disposedAt = rec.disposedAt
        if (rec.outbound !== undefined) row.outbound = deepCopyPlain(rec.outbound)
        if (rec.inbound !== undefined) row.inbound = deepCopyPlain(rec.inbound)
        rows.push(row)
      }
      rows.sort((a, b) => (a.active === b.active
        ? lastActiveMs(b.lastActiveAt) - lastActiveMs(a.lastActiveAt)
        : (a.active ? -1 : 1)))
      return rows
    },

    /**
     * 编辑会话出站覆盖层（diff 合并，非快照——未覆盖项实时跟随上游）。
     *
     * @param {string} id - 会话 id（=== agent.id）。
     * @param {{ channels?: string[]|null, quiet?: boolean|null }} diff - 只出现者写入；
     *   值为 null = 从 diff 删除该覆盖键（回落上游实时解析）。
     * @returns {{ id: string, outbound: object|undefined }} outbound = 写入后的新 diff
     *   （diff 清空时 outbound 键被移除，返回 undefined）。
     * @throws {ApiError} 422 入参校验失败（id 空串/diff 非对象/channels 非 string[] 或含
     *   未知出站渠道/quiet 非布尔）；404 会话从未建档（store 无记录且 registry 无记录）；
     *   500 存储写入失败。
     */
    patchSession(id, diff) {
      if (typeof id !== 'string' || id.trim() === '') throw new ApiError(422, '会话 id 必须是非空字符串')
      if (plainObjectOf(diff) === null) throw new ApiError(422, 'diff 必须是对象（{ channels?: string[]|null, quiet?: boolean|null }）')

      const normalized = {}
      if (Object.prototype.hasOwnProperty.call(diff, 'channels')) {
        if (diff.channels === null) {
          normalized.channels = null
        } else {
          if (!Array.isArray(diff.channels)) throw new ApiError(422, 'channels 必须是字符串数组或 null')
          for (const type of diff.channels) {
            if (typeof type !== 'string') throw new ApiError(422, 'channels 必须是字符串数组或 null')
            if (!OUTBOUND_SET.has(type)) {
              throw new ApiError(422, `channels 含未知出站渠道 "${String(type)}"（可用：${CHANNEL_TYPES.join('/')}）`)
            }
          }
          normalized.channels = [...diff.channels]
        }
      }
      if (Object.prototype.hasOwnProperty.call(diff, 'quiet')) {
        if (diff.quiet === null) normalized.quiet = null
        else if (typeof diff.quiet !== 'boolean') throw new ApiError(422, 'quiet 必须是布尔值或 null')
        else normalized.quiet = diff.quiet
      }

      // 从未建档判定：store 无记录且 registry 无记录（registry 内存态可能领先盘上）
      const stored = plainObjectOf(readTable(KEY_SESSIONS)[id])
      if (stored === null && registrySessionOf(id) === undefined) {
        throw new ApiError(404, `会话 "${id}" 不存在`)
      }

      if (!callSetter(router?.setSessionOutbound, id, normalized)) {
        throw new ApiError(500, '会话覆盖写入存储失败')
      }
      appendAudit('patchSession', { id, diff: normalized })
      const outbound = plainObjectOf(plainObjectOf(readTable(KEY_SESSIONS)[id])?.outbound)
      return { id, outbound: outbound === null ? undefined : deepCopyPlain(outbound) }
    },

    /**
     * 全量通道凭证视图（脱敏返回）：config 深遍历脱敏——凡字符串值（含嵌套对象/数组里的）
     * 替换为 '***'，保留键名与非字符串值。
     * 出站行 config = 「YAML bootstrap ⊕ store 账号」合并视图（store 字段覆盖同名 YAML
     * 字段——UI 改过哪个字段哪个就以 store 为准）；双域通道（feishu/dingtalk）出站行
     * 只展示 YAML（editable=false）。入站行 config = store `<channel>:account`。
     * fields = 该通道的凭证字段表（{ [key]: { required?, secret?, desc } }，spec 渠道读
     * 声明表、手写渠道读 FIELD_HINTS、入站通道读 INBOUND_FIELDS）——空 config 的通道
     * 也能渲染表单从零新建（§9-2「UI 建通道凭证」零 YAML）。
     * @returns {Array<{ type: string, direction: 'outbound'|'inbound', configured: boolean,
     *   enabled: boolean, editable: boolean, config: object, fields: object }>}
     *   行集合与 overview().channels 同构同序，多 config/fields/editable 字段。
     */
    getChannels() {
      const yamlTable = yamlOutboundOf()
      return channelRows().map((row) => {
        if (row.direction === 'inbound') {
          return {
            ...row,
            config: maskSecrets(plainObjectOf(safeGet(`${row.type}:account`)) ?? {}),
            fields: { ...(INBOUND_FIELDS[row.type] ?? {}) },
          }
        }
        const yamlConfig = plainObjectOf(yamlTable[row.type]) ?? {}
        const account = DUAL_INBOUND_DOMAIN.has(row.type)
          ? {}
          : plainObjectOf(safeGet(`${row.type}:account`)) ?? {}
        return {
          ...row,
          // store 字段覆盖同名 YAML 字段（字段级浅合并；数组值整体替换，如 uids）
          config: maskSecrets({ ...yamlConfig, ...account }),
          fields: channelFieldsOf(row.type),
        }
      })
    },

    /**
     * 写通道凭证（UI 表单落 `<type>:account`，YAML 只做首次 bootstrap，§5）。
     * **字段级合并**（patch 语义）：新 config 覆盖 store 既有账号的同名键，其余键原样保留——
     * 兑现 UI「值为 *** 的字段视为未修改（自动剔除）」的承诺；整体替换会让未提交字段
     * 静默丢失（改 botToken 丢 chatId 之类）。删除字段请直接编辑 state.json。
     * 双域通道（feishu/dingtalk）的键域归入站机器人凭证：写入含 `webhook` 键的配置会
     * 破坏出站/入站的键域边界（更会抹掉扫码凭证）——422 指引走 YAML bootstrap。
     * v0.6.5（审查 R4-2-P2-1）：键白名单 + 值形态上限——未知键 422（防 schema 污染与
     * __proto__ 残留）、字段数 ≤64、单字符串值 ≤8KB、值域限字符串/数字/布尔/原始值
     * 数组/原始值对象（webhook.headers、wxpusher.uids 等真实形态）。
     * @param {string} type - 通道类型，必须 ∈ CHANNEL_TYPES ∪ INBOUND_CHANNELS。
     * @param {object} config - 非空普通对象，键必须在该通道字段白名单内。
     * @returns {{ type: string, saved: boolean }} saved=false = 存储不可用/写入失败降级（不抛）。
     * @throws {ApiError} 422 type 非法、config 非非空普通对象、含 webhook/未知/保留键、
     *   或字段数/值形态超限。
     */
    putChannel(type, config) {
      if (typeof type !== 'string' || (!OUTBOUND_SET.has(type) && !INBOUND_SET.has(type))) {
        throw new ApiError(422, `未知通道类型 "${String(type)}"（出站：${CHANNEL_TYPES.join('/')}；入站：${INBOUND_CHANNELS.join('/')}）`)
      }
      if (plainObjectOf(config) === null || Object.keys(config).length === 0) {
        throw new ApiError(422, 'config 必须是非空对象')
      }
      if (DUAL_INBOUND_DOMAIN.has(type) && Object.prototype.hasOwnProperty.call(config, 'webhook')) {
        throw new ApiError(422, `${type} 的 <type>:account 键域归入站机器人凭证（appId/appKey），写入 webhook 会抹掉扫码凭证；${type} 出站 webhook 请走 YAML bootstrap（cordis.patch.yml channels）`)
      }
      const allowed = channelKeyWhitelist(type)
      if (allowed.size === 0) {
        throw new ApiError(422, `${type} 凭证由扫码登录自动写入，不支持手工配置（可用 scripts/channel-login.mjs）`)
      }
      if (Object.keys(config).length > MAX_CHANNEL_KEYS) {
        throw new ApiError(422, `字段数超过上限（最多 ${MAX_CHANNEL_KEYS} 个）`)
      }
      for (const [key, value] of Object.entries(config)) {
        if (DANGEROUS_KEYS.has(key)) {
          throw new ApiError(422, `保留键 "${key}" 不可写入（${[...DANGEROUS_KEYS].join('/')}）`)
        }
        if (!allowed.has(key)) {
          throw new ApiError(422, `未知字段 "${key}"（${type} 可用字段：${[...allowed].join('/')}）`)
        }
        const bad = describeBadChannelValue(key, value)
        if (bad !== null) throw new ApiError(422, bad)
      }
      try {
        if (typeof store?.set !== 'function') throw new Error('store 不可用')
        const existing = plainObjectOf(safeGet(`${type}:account`)) ?? {}
        store.set(`${type}:account`, deepCopyPlain({ ...existing, ...config }))
      } catch (error) {
        warn(`通道凭证写入失败: ${errorMessage(error)}`)
        return { type, saved: false }
      }
      appendAudit('putChannel', { type }) // 审计只记通道名，绝不落凭证内容
      return { type, saved: true }
    },

    /**
     * 单渠道连通性测试（装配层注入 channelTest，如 health/self-check 包装）。
     * @param {string} type - 通道类型。
     * @returns {Promise<object>} channelTest(type) 的结果原样透传。
     * @throws {ApiError} 501 channelTest 未注入或该渠道未启用（不在 channelsEnabled() 中）。
     */
    async testChannel(type) {
      if (typeof channelTest !== 'function') {
        throw new ApiError(501, '连通性测试不可用（未装配 channelTest）')
      }
      const enabled = enabledTypes()
      if (typeof type !== 'string' || !enabled.includes(type)) {
        throw new ApiError(501, `渠道 "${String(type)}" 未启用，无法测试（已启用：${enabled.length > 0 ? enabled.join('/') : '无'}）`)
      }
      return await channelTest(type)
    },

    /**
     * 触发网页扫码授权流（v0.3.1 扫码能力的 UI 入口；handler 状态机：
     * 首调发起并尽快带回二维码内容，后续调用为轮询步进，终态返回 done:true，
     * 落盘成功附 saved:true；失败以 error 字段带回中文原因——handler 绝不 throw）。
     * @param {string} channel - 入站通道类型（telegram/feishu/qq/wxpusher/wechat/dingtalk）。
     * @returns {Promise<{ qrContent: string, done: boolean, saved?: boolean, error?: string }>}
     *   handler 结果原样透传；saved:true 时追加审计（扫码即凭证写入）。
     * @throws {ApiError} 501 该通道无网页扫码处理器（可用 scripts/channel-login.mjs CLI）。
     */
    async scanChannel(channel) {
      // v0.6.5（审查 R4-2-P2-3）：自有键判定——channel='constructor' 等原型链成员经
      // scanHandlers[channel] 取到继承函数（如 Object 构造器）会被当 handler 调用。
      const handler = Object.prototype.hasOwnProperty.call(scanHandlers ?? {}, channel)
        ? scanHandlers[channel]
        : undefined
      if (typeof handler !== 'function') {
        throw new ApiError(501, '该通道暂不支持网页扫码（可用 scripts/channel-login.mjs CLI）')
      }
      const result = await handler()
      if (plainObjectOf(result) !== null && result.saved === true) {
        appendAudit('scanChannel', { channel }) // 只记通道名，绝不落凭证内容
      }
      return result
    },

    // ———————————————— v0.7 成员与配对码（计划书 §3.4/§3.5） ————————————————

    /**
     * 成员总览（只读，绝不抛）：成员绑定表 + 待确认绑定 + 在铸配对码（脱敏——只有
     * 哈希前缀 id 与状态，绝无码面）+ 引导态标记。identity/pairing 未装配按空表降级。
     * @returns {{ guided: boolean, members: object[], pending: object[], pairingCodes: object[] }}
     */
    getMembers() {
      const readSafe = (fn, fallback) => {
        try { return fn() } catch (error) { warn(`成员数据读取失败: ${errorMessage(error)}`); return fallback }
      }
      const members = identity === null ? [] : readSafe(() => identity.list().map((record) => ({
        key: `${record.channel}:${record.userId}`,
        channel: record.channel,
        userId: record.userId,
        label: record.label,
        role: record.role,
        origin: record.origin,
        pairedAt: record.pairedAt,
        lastSeenAt: record.lastSeenAt,
      })), [])
      const pending = identity === null ? [] : readSafe(() => identity.listPending().map((entry) => ({
        key: `${entry.channel}:${entry.userId}`,
        channel: entry.channel,
        userId: entry.userId,
        origin: entry.origin,
        at: entry.at,
      })), [])
      const pairingCodes = pairing === null ? [] : readSafe(() => pairing.listActive(), [])
      // 引导态口径与 bus.isGuided 一致（R5 审查 R5-2-P2-2：只判 identity.isEmpty() 时，
      // allowUsers 非空但无通道凭证/整栈未启动的实例也亮「stderr 有引导码」——用户按提示
      // 翻日志永远翻不到。引导码只在「绑定表空 + allowUsers 空 + 凭证就绪」时铸造）
      const guided = guidedProbe === null ? false : readSafe(() => guidedProbe(), false)
      return { guided, members, pending, pairingCodes }
    },

    /**
     * 改成员 label / role。末位 owner 不可降级（守卫在此层，identity 只做数据操作）。
     * @param {string} key - 复合键 "<channel>:<userId>"
     * @param {{ label?: string, role?: string }} diff
     * @throws {ApiError} 501 identity 未装配；422 键形状/字段校验失败或末位 owner 降级；404 成员不存在
     */
    putMember(key, diff) {
      if (identity === null || typeof identity.updateBinding !== 'function') {
        throw new ApiError(501, '身份绑定层未装配（宿主未启用 inbound）')
      }
      const parsed = parseMemberKey(key)
      if (parsed === null) throw new ApiError(422, MEMBER_KEY_HINT)
      const body = plainObjectOf(diff)
      if (body === null) throw new ApiError(422, '请求体必须是 { label?, role? } 对象')
      const normalized = {}
      for (const [field, value] of Object.entries(body)) {
        if (field === 'label') {
          if (typeof value !== 'string') throw new ApiError(422, 'label 必须是字符串')
          normalized.label = value.slice(0, 64)
        } else if (field === 'role') {
          if (value !== 'owner' && value !== 'member') throw new ApiError(422, 'role 只能是 owner 或 member')
          normalized.role = value
        } else {
          throw new ApiError(422, `未知字段 "${field}"（可用：label/role）`)
        }
      }
      if (Object.keys(normalized).length === 0) throw new ApiError(422, '至少提供 label 或 role 之一')
      const current = identity.list(parsed.channel).find((record) => record.userId === parsed.userId)
      if (current === undefined) throw new ApiError(404, `成员不存在：${parsed.raw}`)
      if (normalized.role === 'member' && current.role === 'owner') {
        let owners = 0
        try { owners = identity.ownerCount() } catch { owners = 1 }
        if (owners <= 1) {
          throw new ApiError(422, '末位 owner 不可降级（否则实例将无人可管理）；请先在成员页提升另一位 owner')
        }
      }
      const result = identity.updateBinding(parsed.channel, parsed.userId, normalized)
      if (result.ok !== true) throw new ApiError(404, `成员不存在：${parsed.raw}`)
      appendAudit('putMember', { key: parsed.raw, diff: normalized })
      return { key: parsed.raw, saved: true, record: result.record }
    },

    /**
     * 移除成员（末位 owner 不可删）。审计记录键与角色。
     * @param {string} key - 复合键 "<channel>:<userId>"
     * @throws {ApiError} 501 identity 未装配；422 键形状非法或末位 owner；404 成员不存在
     */
    deleteMember(key) {
      if (identity === null || typeof identity.removeBinding !== 'function') {
        throw new ApiError(501, '身份绑定层未装配（宿主未启用 inbound）')
      }
      const parsed = parseMemberKey(key)
      if (parsed === null) throw new ApiError(422, MEMBER_KEY_HINT)
      const current = identity.list(parsed.channel).find((record) => record.userId === parsed.userId)
      if (current === undefined) throw new ApiError(404, `成员不存在：${parsed.raw}`)
      if (current.role === 'owner') {
        let owners = 0
        try { owners = identity.ownerCount() } catch { owners = 1 }
        if (owners <= 1) {
          throw new ApiError(422, '末位 owner 不可删除（否则实例将无人可管理）；请先转移角色或添加成员')
        }
      }
      const result = identity.removeBinding(parsed.channel, parsed.userId)
      if (result.ok !== true) throw new ApiError(404, `成员不存在：${parsed.raw}`)
      appendAudit('deleteMember', { key: parsed.raw, role: current.role })
      return { key: parsed.raw, deleted: true }
    },

    /**
     * 确认待确认绑定 → 转正为正式成员（扫码/订阅学习链的收口动作）。
     * @param {string} key - 复合键 "<channel>:<userId>"
     * @throws {ApiError} 501 identity 未装配；422 键形状非法；404 待确认条目不存在；409 已是成员
     */
    confirmPendingMember(key) {
      if (identity === null || typeof identity.confirmPending !== 'function') {
        throw new ApiError(501, '身份绑定层未装配（宿主未启用 inbound）')
      }
      const parsed = parseMemberKey(key)
      if (parsed === null) throw new ApiError(422, MEMBER_KEY_HINT)
      const result = identity.confirmPending(parsed.channel, parsed.userId)
      if (result.ok !== true) {
        if (result.reason === 'already-bound') throw new ApiError(409, `该身份已是成员：${parsed.raw}`)
        throw new ApiError(404, `待确认绑定不存在：${parsed.raw}`)
      }
      appendAudit('confirmPending', { key: parsed.raw })
      return { key: parsed.raw, confirmed: true, record: result.record }
    },

    /**
     * 忽略待确认绑定（不转正、条目清除）。
     * @param {string} key - 复合键 "<channel>:<userId>"
     * @throws {ApiError} 501 identity 未装配；422 键形状非法；404 条目不存在
     */
    dismissPendingMember(key) {
      if (identity === null || typeof identity.dismissPending !== 'function') {
        throw new ApiError(501, '身份绑定层未装配（宿主未启用 inbound）')
      }
      const parsed = parseMemberKey(key)
      if (parsed === null) throw new ApiError(422, MEMBER_KEY_HINT)
      const result = identity.dismissPending(parsed.channel, parsed.userId)
      if (result.ok !== true) throw new ApiError(404, `待确认绑定不存在：${parsed.raw}`)
      appendAudit('dismissPending', { key: parsed.raw })
      return { key: parsed.raw, dismissed: true }
    },

    /**
     * 铸造配对码（v0.7 计划书 §3.4）。码面只在本次响应出现一次——刷新成员列表只见
     * id 与状态；审计经 pairing.onAudit 回调流入 admin-audit.jsonl（此处不重复记）。
     * @param {{ ttlMin?: number, label?: string }} [body]
     * @returns {{ id: string, code: string, expiresAt: number }}
     * @throws {ApiError} 501 pairing 未装配；422 ttlMin/label 校验失败
     */
    mintPairingCode(body = {}) {
      if (pairing === null || typeof pairing.mint !== 'function') {
        throw new ApiError(501, '配对码状态机未装配（宿主未启用 inbound）')
      }
      const input = plainObjectOf(body) ?? {}
      let ttlMs
      if (input.ttlMin !== undefined && input.ttlMin !== null) {
        // typeof 守卫在前：Number(true)===1、Number(null)===0 会把布尔/空值溜成合法分钟数
        if (typeof input.ttlMin !== 'number' || !Number.isInteger(input.ttlMin) || input.ttlMin < 1 || input.ttlMin > 1440) {
          throw new ApiError(422, 'ttlMin 必须是 1-1440 的整数（分钟）')
        }
        ttlMs = input.ttlMin * 60 * 1000
      }
      const label = typeof input.label === 'string' ? input.label.slice(0, 64) : ''
      const result = pairing.mint({ origin: 'admin', mintedBy: 'admin:web', ttlMs, label })
      if (result.ok !== true) throw new ApiError(500, `配对码铸造失败：${String(result.reason ?? '未知')}`)
      return { id: result.id, code: result.code, expiresAt: result.expiresAt }
    },

    /**
     * 撤销在铸配对码（审计经 pairing.onAudit 流入，此处不重复记）。
     * @param {string} id - 配对码 id（哈希前 8 位）
     * @throws {ApiError} 501 pairing 未装配；422 id 形状非法；404 不存在或已终态
     */
    revokePairingCode(id) {
      if (pairing === null || typeof pairing.revoke !== 'function') {
        throw new ApiError(501, '配对码状态机未装配（宿主未启用 inbound）')
      }
      const normalized = String(id ?? '').trim()
      if (normalized === '' || normalized.length > 32) throw new ApiError(422, '配对码 id 非法')
      const result = pairing.revoke(normalized, { by: 'admin:web' })
      if (result.ok !== true) {
        throw new ApiError(404, `配对码不存在或已终态（${String(result.reason ?? 'not-found')}）`)
      }
      return { id: normalized, revoked: true }
    },

    /**
     * 读审计日志（<stateDir>/admin-audit.jsonl，每行 { time, action, detail }）：
     * 全量、新在前；文件不存在/读取失败/损坏行一律按可读部分返回，绝不抛。
     * v0.6.5（审查 R4-2-P3-5）：轮转后并读 .1 与当前文件（时间线连续，旧在前）。
     * @returns {Array<{ time: string, action: string, detail: object }>}
     */
    getAudit() {
      const readRaw = (file) => {
        try { return readFileSync(file, 'utf8') } catch { return '' }
      }
      const raw = `${readRaw(`${auditFile}.1`)}\n${readRaw(auditFile)}`
      const records = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let parsed
        try { parsed = JSON.parse(trimmed) } catch { continue } // 损坏行跳过，不弄崩列表
        if (plainObjectOf(parsed) !== null) records.push(parsed)
      }
      records.reverse() // 文件内旧→新，返回新→旧
      return records
    },

    /**
     * v0.7：外部子系统（配对码状态机等）追加审计行。action 前缀约定「子系统:事件」
     * （如 pairing:mint）；detail 必须可 JSON 序列化，失败只 warn 不上抛（与内部审计同纪律）。
     */
    appendAudit(action, detail) {
      appendAudit(String(action ?? 'unknown'), detail)
    },
  }
  return api
}
