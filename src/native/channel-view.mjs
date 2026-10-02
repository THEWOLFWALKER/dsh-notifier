// dsh-notifier v0.15 Stage 1 — 渠道用户视图（把出站 + 入站能力折叠成「一个渠道」）。
//
// 职责（03_ARCHITECTURE_REWRITE_PLAN）：
//  - 只表达四种状态：还没设置 / 正在连接 / 可以使用 / 需要处理；
//  - 「测试已发出」与「已确认收到」分开（accepted ≠ confirmed）；
//  - 账号卡的 id 保留真实 accountId（禁止拿 channel 顶替账号）；
//  - secret 只暴露「有没有填」，**值永不返回浏览器**。
//
// 本模块是**纯投影**：读上游已脱敏的渠道行（createChannelProjection 的产物）与成员视图，
// 不写 store、不触达 provider、不持有第二套状态机。所有上限与截断语义由 read-model 负责。
//
// 内部状态名（configured / active / healthy / restart-pending / degraded …）绝不外泄，
// 一律经 vocabulary 翻成用户词。

import { toInboundChannelName } from '../inbound/capability-matrix.mjs'
import { isPublicExposure } from '../security/exposure.mjs'
import {
  STATE_ACTION,
  STATE_TEXT,
  RECEIPT_TEXT,
  channelBrandOf,
  channelGroupOf,
  channelNameOf,
  channelUsageOf,
  fieldLabel,
  maskIdentity,
  pick,
} from './vocabulary.mjs'

/** 测试结果四态（契约封闭集）。 */
export const RECEIPT_KINDS = Object.freeze(['sent', 'confirmed', 'unknown', 'failed'])

/** 账号键：无显式 accountId 时归入 default 账号（与 identity 复合键语义一致）。 */
const DEFAULT_ACCOUNT = 'default'

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)

/**
 * 内部渠道行 → 用户状态（契约封闭四态）。
 *
 * 判定顺序即优先级，绝不出现第五种状态：
 *  1. 出站与入站都没配置            → not-set
 *  2. 宿主不支持 / 有明确失败证据 / 已保存但没生效 → needs-attention
 *  3. 已配置但还没跑起来            → connecting
 *  4. 跑起来且无失败证据            → ready
 */
export function channelState(row) {
  const notifyConfigured = row?.notify?.configured === true
  const controlConfigured = row?.control?.configured === true
  if (!notifyConfigured && !controlConfigured) return 'not-set'
  const healthState = String(row?.health?.state ?? '')
  if (healthState === 'unsupported') return 'needs-attention'
  if (healthState === 'degraded') return 'needs-attention'
  const restartPending = row?.notify?.restartPending === true || row?.control?.restartPending === true
  if (restartPending) return 'needs-attention'
  const active = (notifyConfigured && row?.notify?.active === true)
    || (controlConfigured && row?.control?.active === true)
  if (!active) return 'connecting'
  if (healthState === 'unavailable') return 'connecting'
  return 'ready'
}

/** 状态 → 用户词（字符串）。 */
export function stateText(state, lang = 'zh') {
  return pick(STATE_TEXT[state] ?? STATE_TEXT['needs-attention'], lang)
}

/**
 * 测试结果 → 用户话术（契约 TestReceipt）。
 *
 * 映射（07_BACKEND_CONTRACTS）：
 *   accepted（provider 接受请求）      → sent
 *   confirmed（显式回执）              → confirmed
 *   timeout / uncertain（结果不确定）  → unknown
 *   确定性错误（认证/网络/提供方拒绝） → failed
 *
 * 绝不因为 `ok === true` 就宣称「已送达」。
 * @param {object} result - 归一化测试结果（service.testResult 形状）或 provider 原始结果
 * @param {{ lang?: string, reason?: object|string }} [options]
 */
export function testReceipt(result = {}, options = {}) {
  const lang = options.lang ?? 'zh'
  const kind = receiptKind(result)
  const text = RECEIPT_TEXT[kind]
  const base = pick(text.message, lang)
  const reason = options.reason ?? null
  const message = reason === null || reason === ''
    ? base
    : `${base}（${pick(reason, lang)}）`
  return { kind, title: pick(text.title, lang), message }
}

/** 结果 → 四态 kind（幂等：已是四态则原样返回）。 */
export function receiptKind(result = {}) {
  if (RECEIPT_KINDS.includes(result?.kind)) return result.kind
  const status = String(result?.status ?? '')
  if (status === 'delivered') return 'confirmed'
  if (status === 'accepted') return 'sent'
  if (status === 'unknown') {
    // 归一化失败行统一是 status:'unknown'，靠 reasonCode 区分「结果不确定」与「确定性失败」。
    return String(result?.reasonCode ?? '') === 'timeout' ? 'unknown' : 'failed'
  }
  // provider 原始结果（未经 service.testResult 归一化）。
  if (result?.ok === true) return result?.confirmed === true || result?.receipt === true ? 'confirmed' : 'sent'
  if (result?.uncertain === true) return 'unknown'
  if (result?.ok === false) return 'failed'
  return 'unknown'
}

/** 渠道 id：出站 type 与入站名统一用出站代表名，保证同一渠道只有一行。 */
export function channelIdOf(row) {
  return String(row?.type ?? '')
}

/** 渠道用户可见名（品牌名，不是内部 type；同一渠道出站/入站同名）。 */
function channelName(row, lang) {
  return channelNameOf(channelIdOf(row), lang)
}

/** 出站与入站能力折叠成一条渠道摘要（契约 ChannelSummary）。 */
function channelSummary(row, lang) {
  const id = channelIdOf(row)
  const state = channelState(row)
  const inbound = toInboundChannelName(id)
  const action = STATE_ACTION[state]
  return {
    id,
    name: channelName(row, lang),
    usage: channelUsageOf(id, lang),
    // brand 是**品牌标识键**，不是 URL：客户端按渠道渲染真实 Logo（禁用点状图标）。
    brand: channelBrandOf(id),
    group: channelGroupOf(id),
    ...(inbound !== id ? { alias: inbound } : {}),
    canNotify: row?.capabilities?.notify === true,
    canPrivateChat: row?.capabilities?.control === true,
    notifyEnabled: row?.notify?.configured === true,
    privateChatEnabled: row?.control?.configured === true,
    state,
    stateText: stateText(state, lang),
    ...(action ? { nextAction: { id: action.id, label: pick(action.label, lang) } } : {}),
  }
}

/**
 * 设置字段投影：只给「有没有填」与用户文案，**绝不返回值**。
 * secret 字段与公共字段在这里一视同仁——只有 presence，没有 value。
 * 出站（notify）与入站（control）共用同一形状，账号卡才能把两个方向画成同样的控件。
 */
function fieldList(fieldsMap, lang) {
  const fields = fieldsMap ?? {}
  const out = []
  for (const [key, meta] of Object.entries(fields)) {
    const label = fieldLabel(key)
    out.push({
      key,
      label: pick(label, lang),
      ...(meta?.description ? { help: pick(meta.description, lang) } : {}),
      required: meta?.required === true,
      secret: meta?.secret === true,
      // presence 来自投影的 configured（对 secret 字段同样成立），不是值本身。
      present: meta?.configured === true,
      type: String(meta?.type ?? 'string'),
      ...(Array.isArray(meta?.options) ? { options: meta.options.map(String) } : {}),
    })
  }
  return out
}

/** 公共字段的已填值（投影已按 exposure 白名单过滤，secret 结构上不可能在此出现）。 */
function publicValuesOf(fieldsMap, editableValues) {
  const raw = editableValues
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const fields = fieldsMap ?? {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    // 纵深防御：即便上游投影出问题，这里再按 exposure 拒一次 secret。
    if (!hasOwn(fields, key)) continue
    if (!isPublicExposure(fields[key])) continue
    out[key] = value
  }
  return out
}

/**
 * 账号卡：一个渠道下的一个机器人/账号。
 * id 由 `<channel>:<accountId>` 组成——accountId 是真实来源，禁止拿 channel 顶替。
 *
 * 字段按「必填 = 基础设置 / 选填 = 更多设置」分组（NATIVE_UX_V2：复杂设置默认收起），
 * 出站与入站各给一份**同形状**的字段清单与已填公共值，账号卡用同一套控件渲染。
 */
function accountView(row, accountId, memberRows, lang) {
  const id = channelIdOf(row)
  const state = channelState(row)
  const identity = memberRows.find((member) => member?.role === 'owner') ?? memberRows[0] ?? null
  const notifyFields = fieldList(row?.notify?.fields, lang)
  const controlFields = row?.control ? fieldList(row.control.fields, lang) : []
  const notifyEnabled = row?.notify?.configured === true
  return {
    id: `${id}:${accountId}`,
    accountId,
    displayName: accountId === DEFAULT_ACCOUNT ? channelName(row, lang) : accountId,
    ...(identity ? { maskedIdentity: maskIdentity(identity.userId) } : {}),
    state,
    stateText: stateText(state, lang),
    notify: {
      enabled: notifyEnabled,
      canTest: notifyEnabled,
      values: publicValuesOf(row?.notify?.fields, row?.notify?.editableValues),
    },
    ...(row?.control
      ? {
          privateChat: {
            enabled: row.control.configured === true,
            canTest: row.control.configured === true,
            users: memberRows.length,
            fields: controlFields,
            values: publicValuesOf(row.control.fields, row.control.editableValues),
          },
        }
      : {}),
    // 完整出站字段清单（契约字段）；账号卡按 required 拆成基础/更多两段。
    setupFields: notifyFields,
    basicFields: notifyFields.filter((field) => field.required === true),
    moreFields: notifyFields.filter((field) => field.required !== true),
    // 复杂设置默认收起：有非必填字段就说明「还有更多」。
    moreAvailable: notifyFields.some((field) => field.required !== true),
  }
}

/**
 * @param {object} deps
 * @param {{ list: () => object[], get: (type: string) => object|null }} deps.channels - 已脱敏渠道投影
 * @param {{ list: () => object[] }} [deps.members] - 成员投影（提供 accountId 与掩码身份）
 */
export function createChannelView({ channels = null, members = null } = {}) {
  const rows = () => {
    try {
      const list = typeof channels?.list === 'function' ? channels.list() : []
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }
  const memberRows = () => {
    try {
      const list = typeof members?.list === 'function' ? members.list() : []
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  /** 某渠道下出现过的 accountId 集合（无成员时至少一个 default 账号）。 */
  const accountIdsOf = (type) => {
    const ids = new Set()
    for (const member of memberRows()) {
      if (String(member?.channel ?? '') !== type) continue
      const accountId = member?.accountId === undefined || String(member.accountId) === ''
        ? DEFAULT_ACCOUNT
        : String(member.accountId)
      ids.add(accountId)
    }
    if (ids.size === 0) ids.add(DEFAULT_ACCOUNT)
    return [...ids]
  }

  return {
    /** 全部渠道摘要（含未设置；调用方决定 rail / picker 截断）。 */
    list(lang = 'zh') {
      return rows().map((row) => channelSummary(row, lang))
    },

    /** 单渠道详情；未知渠道返回 null（绝不编造）。 */
    detail(type, lang = 'zh') {
      const key = String(type ?? '')
      const row = rows().find((candidate) => channelIdOf(candidate) === key) ?? null
      if (row === null) return null
      return {
        channel: channelSummary(row, lang),
        accounts: accountIdsOf(key).map((accountId) => accountView(
          row,
          accountId,
          memberRows().filter((member) => String(member?.channel ?? '') === key
            && (member?.accountId === undefined || String(member.accountId) === ''
              ? DEFAULT_ACCOUNT
              : String(member.accountId)) === accountId),
          lang,
        )),
      }
    },
  }
}
