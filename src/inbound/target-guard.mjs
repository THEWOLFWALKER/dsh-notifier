// Private target admission is fail-closed. Provider-specific code supplies explicit private
// user targets or a provider-confirmed P2P chat; this module checks account ownership and ID shape.

/**
 * 各渠道 id 形态（null = 无已知形态，一律放行）。
 */
import { INBOUND_CHANNELS, INBOUND_CHANNEL_SET } from './channels-registry.mjs'

const CHANNEL_ID_PATTERNS = {
  telegram: /^-?\d{1,16}$/,
  feishu: /^(ou|oc|on)_[A-Za-z0-9]+$/,
  qq: /^[A-Za-z0-9_-]{8,64}$/,
  wxpusher: /^(UID_)?[A-Za-z0-9_-]{1,64}$/,
  wechat: /^[A-Za-z0-9_-]{4,64}$/,
  dingtalk: /^[A-Za-z0-9._-]{4,64}$/,
}

/** 渠道 id 形态是否可信（S-12：未知渠道 fail-closed 拒绝——枚举收敛到 channels-registry 后，未知渠道只剩拼写错误或上游漂移两种来源，都不该放行）。 */
export function isValidTargetId(channel, id) {
  if (!INBOUND_CHANNEL_SET.has(String(channel ?? ''))) return false
  const pattern = CHANNEL_ID_PATTERNS[String(channel ?? '')]
  if (pattern === undefined) return true // 已登记渠道暂无形态表：宁放过不错杀（错杀真成员是 P1）
  return pattern.test(String(id ?? ''))
}

/**
 * Feishu 用户 open_id 形态（ou_*，私聊投递目标；P0-Feishu-P2P #20）。
 * 私聊发送用 receive_id_type=open_id，账本/pushedTo/卡片 srcChat 记的都是 ou_*；
 * 而点击/回复事件的会话 id 是 P2P 会话 chat_id（oc_*）——来源身份（ou_）与投递
 * 寻址（oc_）是两套 id 空间，判定归属时不可直接字符串比对。
 */
export function isOpenIdTarget(channel, id) {
  return String(channel ?? '') === 'feishu' && /^ou_[A-Za-z0-9]+$/.test(String(id ?? ''))
}

/** Feishu identity and P2P routing use different provider IDs; require P2P + same user. */
export function feishuP2pEquivalent(channel, a, b, { userId, targetUserId, chatType } = {}) {
  const A = String(a ?? '')
  const B = String(b ?? '')
  if (A !== '' && A === B) return true
  if (String(channel ?? '') !== 'feishu') return false
  if (!A.startsWith('ou_') || !B.startsWith('oc_')) return false
  if (String(chatType ?? '') !== 'p2p') return false
  if (userId === undefined || targetUserId === undefined) return false
  return String(userId) === String(targetUserId)
}

/**
 * 形状守卫：过滤掉形态不符的目标（发送前最后一道防线）。
 * S-12：未知渠道的目标整体拒绝 + warn——拼写错误的渠道键曾因 fail-open 静默放行，
 * 目标可能被投到根本不是该平台的会话 id 上。
 * @param {string} channel - 渠道键（telegram/feishu/qq/wxpusher/wechat/dingtalk）
 * @param {{ chatId: string, userId?: string }[]} targets - 待发送目标
 * @param {(message: string) => void} [warn] - 跳过时的告警回调（缺省静默）
 * @returns {{ kept: object[], skipped: object[] }}
 */
export function guardTargets(channel, targets, warn = null) {
  const list = Array.isArray(targets) ? targets : []
  const kept = []
  const skipped = []
  if (!INBOUND_CHANNEL_SET.has(String(channel ?? ''))) {
    if (warn !== null) {
      try { warn(`目标形状守卫拦截（未知渠道 "${channel}"，全部跳过；合法渠道：${INBOUND_CHANNELS.join('/')}）`) } catch { /* 告警失败不致命 */ }
    }
    return { kept, skipped: [...list] }
  }
  for (const target of list) {
    const chatId = String(target?.chatId ?? '')
    if (chatId === '') {
      skipped.push(target)
      continue
    }
    if (isValidTargetId(channel, chatId)) {
      kept.push(target)
      continue
    }
    skipped.push(target)
    if (warn !== null) {
      try { warn(`目标形状守卫拦截（${channel} 不接受 "${chatId.slice(0, 24)}"，已跳过）`) } catch { /* 告警失败不致命 */ }
    }
  }
  return { kept, skipped }
}

/**
 * Resolve private recipients from account-scoped paired identities or explicit channel targets.
 * No global allow-list or extra-target fallback is accepted.
 * @param {object} options
 * @param {object|null} options.identity - 身份绑定层实例（可空）
 * @param {string} options.channel - 渠道键
 * @param {object[]} [options.configTargets] - 通道配置清单（已是 {chatId,userId} 形态）
 * @returns {{ chatId: string, userId: string }[]}
 */
export function resolveNotifyTargets({ identity = null, channel, accountId = '', configTargets = [] }) {
  const asPair = (item) => {
    if (item === null || item === undefined) return { chatId: '', userId: '' }
    if (typeof item === 'string' || typeof item === 'number') {
      const id = String(item).trim()
      return { chatId: id, userId: id }
    }
    return { chatId: String(item.chatId ?? '').trim(), userId: String(item.userId ?? item.chatId ?? '').trim() }
  }
  const configured = (Array.isArray(configTargets) ? configTargets : []).map(asPair)
    .filter((target) => target.chatId !== '')
  let targets = configured
  if (identity !== null && typeof identity.list === 'function') {
    try {
      const account = String(accountId ?? '').trim()
      const bound = account === '' ? [] : identity.list(channel)
        .filter((row) => String(row?.accountId ?? '').trim() === account)
        .map((row) => ({ chatId: String(row.userId ?? ''), userId: String(row.userId ?? '') }))
      if (bound.length > 0) targets = bound
    } catch { targets = configured }
  }
  const seen = new Set()
  return targets.filter((target) => {
    const id = String(target.chatId ?? '').trim()
    if (id === '' || seen.has(id) || !isValidTargetId(channel, id)) return false
    // Telegram negative chat ids are groups. Feishu open_id is the only unambiguous
    // configured private recipient; oc_ is accepted only after a provider P2P event.
    if (channel === 'telegram' && !/^\d{1,16}$/.test(id)) return false
    if (channel === 'feishu' && !/^ou_[A-Za-z0-9]+$/.test(id)) return false
    seen.add(id)
    return true
  })
}
