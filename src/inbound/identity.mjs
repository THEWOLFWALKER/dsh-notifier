// dsh-notifier v0.7 inbound/identity.mjs
// 身份绑定层（v0.7 计划书 §3.1）：把「谁是家里人」从 YAML 不透明字符串提升为运行时对象。
// 键设计：
//  - inbound:bindings  → { "<channel>:<userId>": {channel,userId,label,role,pairedAt,lastSeenAt,origin} }
//  - inbound:pending   → { "<channel>:<userId>": {channel,userId,origin,at,extra} } 待确认绑定（扫码/订阅学习）
//  - inbound:migrated  → true（一次性迁移标记，防止 YAML 每次启动复活管理台已删成员）
// 与会话路由键 bind:<channel>:<userId>（conversation.mjs，「这条消息交给哪个 agent」）语义不同，
// 两键并存互不合并：身份绑定放行，会话绑定才可能被消费。
// 军规：读失败回退空对象（fail-open 读），写失败由 store 保留 dirty 重试；绝不覆写损坏现场。

import { isValidTargetId } from './target-guard.mjs'

const KEY_BINDINGS = 'inbound:bindings'
const KEY_PENDING = 'inbound:pending'
/** 一次性迁移标记（R5 审查 R5-1-P1-1：无标记则每次启动重播撒，管理台删除的成员被 YAML 复活）。 */
const KEY_MIGRATED = 'inbound:migrated'
/** lastSeenAt 更新节流：每用户每小时最多一次落盘（避免每条入站消息都全量重写 state.json）。 */
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000
const VALID_CHANNELS = new Set(['telegram', 'feishu', 'qq', 'wxpusher', 'wechat', 'dingtalk'])
const VALID_ROLES = new Set(['owner', 'member'])
const VALID_ORIGINS = new Set(['migrated', 'paired', 'learned', 'confirmed'])

/** 归一化单条绑定记录（读盘防御：坏字段回退默认，坏形状整条丢弃）。 */
function normalizeBinding(raw, fallbackKey) {
  if (raw === null || typeof raw !== 'object') return null
  const [channel, userId] = String(fallbackKey ?? '').split(':')
  const record = {
    channel: typeof raw.channel === 'string' && raw.channel !== '' ? raw.channel : (VALID_CHANNELS.has(channel) ? channel : ''),
    userId: typeof raw.userId === 'string' && raw.userId !== '' ? raw.userId : (userId ?? ''),
    label: typeof raw.label === 'string' ? raw.label.slice(0, 64) : '',
    role: VALID_ROLES.has(raw.role) ? raw.role : 'member',
    pairedAt: typeof raw.pairedAt === 'number' ? raw.pairedAt : 0,
    lastSeenAt: typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : 0,
    origin: VALID_ORIGINS.has(raw.origin) ? raw.origin : 'paired',
  }
  if (!VALID_CHANNELS.has(record.channel) || record.userId === '') return null
  return record
}

/** 待确认绑定保留 7 天（R5 审查 R5-3-P3-7：陌生人扫码/订阅写入后无人确认，
 * 待确认表只增不减——读路径顺手清扫，有变更才写回）。 */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 创建身份绑定层。
 * @param {object} options
 * @param {import('./store.mjs').store} [options.store] - 持久化 store（跨进程读收敛由 store 自带）
 * @param {object} [options.logger] - cordis logger
 */
export function createIdentity(options = {}) {
  const store = options.store ?? null
  const warn = (message) => {
    try { options.logger?.warn?.('[dsh-notifier/identity]', message) } catch { /* 日志失败绝不致命 */ }
    try { console.error('[dsh-notifier/identity]', message) } catch { /* 控制台不可用不致命 */ }
  }

  /** 读绑定表（store 读收敛让宿主进程半秒内看到 CLI/管理台写入）。 */
  function readBindings() {
    if (store === null) return {}
    const raw = store.get(KEY_BINDINGS, {})
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeBinding(value, key)
      if (record !== null) out[`${record.channel}:${record.userId}`] = record
    }
    return out
  }

  function writeBindings(table) {
    if (store === null) return
    store.set(KEY_BINDINGS, table)
  }

  function readPending() {
    if (store === null) return {}
    const raw = store.get(KEY_PENDING, {})
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    let expired = 0
    const now = Date.now()
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object') continue
      // TTL 清扫：超期条目跳过（下面统一写回，避免逐条写盘）
      if (typeof value.at === 'number' && now - value.at > PENDING_TTL_MS) { expired += 1; continue }
      const [channel, userId] = key.split(':')
      if (!VALID_CHANNELS.has(channel) || userId === undefined || userId === '') continue
      out[key] = {
        channel,
        userId,
        origin: VALID_ORIGINS.has(value.origin) ? value.origin : 'learned',
        at: typeof value.at === 'number' ? value.at : 0,
        extra: value.extra !== null && typeof value.extra === 'object' ? value.extra : {},
      }
    }
    // 顺带剔除形状损坏的键（value 非对象/渠道非法）：与过期清扫一起写回，零额外写放大
    if (expired > 0 || Object.keys(out).length !== Object.keys(raw).length) {
      try {
        store.set(KEY_PENDING, out)
        warn(`待确认绑定清扫：${expired} 条过期、${Object.keys(raw).length - Object.keys(out).length - expired} 条坏形状被移除`)
      } catch (error) {
        warn(`待确认绑定清扫写回失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out
  }

  return {
    /** 复合键准入（v0.7 计划书 §3.1：准入带渠道维度，修跨渠道串扰）。 */
    allows(channel, userId) {
      if (typeof channel !== 'string' || typeof userId !== 'string') return false
      const table = readBindings()
      const record = table[`${channel}:${String(userId)}`]
      if (record === undefined) return false
      // lastSeenAt 节流更新（内存判定 + 稀疏落盘，不放大写放大）
      if (Date.now() - record.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
        try {
          record.lastSeenAt = Date.now()
          writeBindings({ ...table, [`${channel}:${record.userId}`]: record })
        } catch (error) {
          warn(`lastSeenAt 更新失败（不致命）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return true
    },

    /** 绑定表是否为空（空 = 引导态判定输入之一，v0.7 计划书 §3.2）。 */
    isEmpty() {
      return Object.keys(readBindings()).length === 0
    },

    /** 绑定数（启动日志/管理台总览用）。 */
    size() {
      return Object.keys(readBindings()).length
    },

    /** 全量绑定列表（可选按渠道过滤；管理台成员页/目标解析用）。 */
    list(channel = '') {
      const table = readBindings()
      const records = Object.values(table)
      return channel === '' ? records : records.filter((record) => record.channel === channel)
    },

    /** owner 数量（末位 owner 守卫用）。 */
    ownerCount() {
      return this.list().filter((record) => record.role === 'owner').length
    },

    /**
     * v0.7 迁移（计划书 §3.1）：YAML allowUsers 播撒为绑定记录。
     * **一次性**（R5 审查 R5-1-P1-1）：落 `inbound:migrated` 标记后永不再播撒——否则每次
     * 启动重跑「只增不减」，管理台删除的成员（origin=migrated）下次重启被 YAML 静默复活，
     * 删减权收归管理台单一入口的契约被推翻。副作用：首启时未就绪的通道不补播（用 /pair 或
     * 管理台补齐），复活已删成员的风险远大于补播便利。
     * 播撒按渠道 id 形态过滤（R5 审查 R5-3-P1-3）：TG 数字 id 不播给飞书（异形状占据一级
     * 解析后遮蔽通道自己的配置清单）。
     * 绑定表为空时首条播撒记录置 owner（R5 审查 R5-1-P2-2：迁移实例 ownerCount 恒 0，
     * 违反「首位成员即 owner」契约且 bootstrap 永不铸造）。
     * @param {string[]} allowUsers - YAML 白名单（裸字符串，无法反查渠道 → 对每个已启用通道各播一条）
     * @param {string[]} enabledChannels - 本次启动实际启用的入站通道
     */
    migrate(allowUsers, enabledChannels) {
      const ids = (Array.isArray(allowUsers) ? allowUsers : []).map((id) => String(id).trim()).filter((id) => id !== '')
      const channels = (Array.isArray(enabledChannels) ? enabledChannels : []).filter((channel) => VALID_CHANNELS.has(channel))
      if (ids.length === 0 || channels.length === 0) return { added: 0, skipped: false }
      if (store !== null && store.get(KEY_MIGRATED, false) === true) return { added: 0, skipped: true }
      const table = readBindings()
      const now = Date.now()
      const wasEmpty = Object.keys(table).length === 0
      let ownerAssigned = false
      let added = 0
      for (const userId of ids) {
        for (const channel of channels) {
          // 渠道形态过滤：该渠道显然不接受的 id 不播（如 feishu 不吃裸数字、TG 不吃 UID_）
          if (!isValidTargetId(channel, userId)) continue
          const key = `${channel}:${userId}`
          if (table[key] !== undefined) continue
          // 空表首条（跨通道也只此一条）置 owner——「首位成员即 owner」契约
          const role = wasEmpty && !ownerAssigned ? 'owner' : 'member'
          if (role === 'owner') ownerAssigned = true
          table[key] = { channel, userId, label: '', role, pairedAt: now, lastSeenAt: 0, origin: 'migrated' }
          added += 1
        }
      }
      if (store !== null) store.set(KEY_MIGRATED, true)
      if (added > 0) {
        writeBindings(table)
        warn(`白名单迁移：${added} 条绑定落盘（一次性导入完成，此后增删以管理台为准）`)
      }
      return { added }
    },

    /**
     * 新增绑定（配对核销/待确认转正）。首条绑定为 owner（配对语义：bootstrap 单胜也走这里）。
     * @returns {{ ok: boolean, record?: object, reason?: string }}
     */
    addBinding({ channel, userId, label = '', origin = 'paired' }) {
      if (!VALID_CHANNELS.has(channel)) return { ok: false, reason: 'invalid-channel' }
      const uid = String(userId ?? '').trim()
      if (uid === '' || uid.length > 128) return { ok: false, reason: 'invalid-user' }
      const table = readBindings()
      const key = `${channel}:${uid}`
      const existing = table[key]
      if (existing !== undefined) return { ok: false, reason: 'already-bound' }
      const isFirst = Object.keys(table).length === 0
      const record = {
        channel,
        userId: uid,
        label: String(label ?? '').slice(0, 64),
        role: isFirst ? 'owner' : 'member',
        pairedAt: Date.now(),
        lastSeenAt: 0,
        origin: VALID_ORIGINS.has(origin) ? origin : 'paired',
      }
      table[key] = record
      writeBindings(table)
      return { ok: true, record }
    },

    /** 移除绑定；末位 owner 不可删（守卫在调用方 admin/命令层，这里只做数据操作）。 */
    removeBinding(channel, userId) {
      const table = readBindings()
      const key = `${channel}:${String(userId ?? '')}`
      if (table[key] === undefined) return { ok: false, reason: 'not-found' }
      delete table[key]
      writeBindings(table)
      return { ok: true }
    },

    /** 改 label/role（末位 owner 降级守卫由调用方做）。 */
    updateBinding(channel, userId, diff = {}) {
      const table = readBindings()
      const key = `${channel}:${String(userId ?? '')}`
      const record = table[key]
      if (record === undefined) return { ok: false, reason: 'not-found' }
      if (typeof diff.label === 'string') record.label = diff.label.slice(0, 64)
      if (VALID_ROLES.has(diff.role)) record.role = diff.role
      table[key] = record
      writeBindings(table)
      return { ok: true, record }
    },

    // ———————— 待确认绑定（学习键汇流，v0.7 计划书 §3.6） ————————

    /** 记录待确认身份（飞书扫码 openId / wxpusher 订阅 uid）。幂等：已存在刷新 at。 */
    addPending({ channel, userId, origin = 'learned', extra = {} }) {
      if (!VALID_CHANNELS.has(channel)) return { ok: false, reason: 'invalid-channel' }
      const uid = String(userId ?? '').trim()
      if (uid === '' || uid.length > 128) return { ok: false, reason: 'invalid-user' }
      const table = readBindings()
      if (table[`${channel}:${uid}`] !== undefined) return { ok: false, reason: 'already-bound' }
      const pending = readPending()
      pending[`${channel}:${uid}`] = { channel, userId: uid, origin, at: Date.now(), extra }
      if (store !== null) store.set(KEY_PENDING, pending)
      return { ok: true }
    },

    listPending() {
      return Object.values(readPending())
    },

    /** 确认待确认绑定 → 转正为正式成员。 */
    confirmPending(channel, userId) {
      const pending = readPending()
      const key = `${channel}:${String(userId ?? '')}`
      const entry = pending[key]
      if (entry === undefined) return { ok: false, reason: 'not-found' }
      delete pending[key]
      if (store !== null) store.set(KEY_PENDING, pending)
      return this.addBinding({ channel, userId: entry.userId, origin: 'confirmed' })
    },

    dismissPending(channel, userId) {
      const pending = readPending()
      const key = `${channel}:${String(userId ?? '')}`
      if (pending[key] === undefined) return { ok: false, reason: 'not-found' }
      delete pending[key]
      if (store !== null) store.set(KEY_PENDING, pending)
      return { ok: true }
    },
  }
}

/** 渠道合法性集合（commands/admin 层复用）。 */
export const IDENTITY_CHANNELS = VALID_CHANNELS
