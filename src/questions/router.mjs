// dsh-notifier questions/router.mjs
// v0.8 远程提问桥（issue #3/#5，规划书《选项卡通知》M1）：
// agent 调用 ask_user 工具 → 问题与选项推到手机（飞书选项卡片 / Telegram 按钮 /
// 无按钮通道编号回复）→ 用户作答 → 答案作为工具结果回传给 agent。
//
// 设计原则（规划书 P1–P7，全部复用审批桥接栈既有设施）：
//  - P1 双端并存首达采纳：bus.settle 天然键值泛化，谁先答谁赢，后到者 already-resolved
//  - P2 超时永不代答：超时 answered=false，静默交还桌面，绝不编造默认答案
//  - P3 选项集封闭：只接受提问时声明过的选项（下标越界/伪造负载一律拒绝）
//  - P4 卡片为主、编号兜底：选项卡片是主交互；编号文案只发卡片未送达的渠道
//    （无按钮通道 / 卡片投递失败 / 多选暂无卡片形态）。发错编号不作废问题：
//    回执提示 + 重发选项，保持待决可再答
//  - P5 裁决后终态化：作答/超时后卡片 patch 终态（去按钮、显结果）
//  - P7 回调载荷永不携带选项文本：aq:<qKey>:<optIdx>:<token>（下标引用）
//
// 账本：store 键空间 'aq:'（与审批 'ap:' 隔离），行 = {
//   question, options: [label], multiSelect, status: 'pending'|'resolved',
//   pushedTo: [{channel, chatId, userId, messageId, kind:'aq'}], createdAt,
//   hintTargets?: [{channel, chatId, userId}]（Control Core Step 1：per-chat 编号话术送达证据，
//     替代旧 hintChannels 字符串数组；旧行无此字段 → fail-closed 不匹配），
//   hintChannels?: string[]（旧格式只保留读取兼容；不再作为任何授权证据），
//   decision?: 'answered'|'timeout'|'error',
//   answers?: [label]（重复点击回显用）
// }
// 军规：任何异常只丢当次提问（工具返回明确失败对象），绝不弄崩宿主。

import { createHash, randomBytes } from 'node:crypto'
import { normalizeInbound } from '../inbound/_contract.mjs'
import { MESSAGE_PRIORITY } from '../inbound/bus.mjs'
import { guardTargets } from '../inbound/target-guard.mjs'
import { createEscalationChain } from '../approval/escalation.mjs'
import { createInteractionLedger } from '../interaction/ledger.mjs'
import { createRateLimiter, compileParameters } from '../tool-register.mjs'
// 维护批 6 前置：跨渠道能力矩阵作为单一事实来源
import { isCoveredByOutbound } from '../inbound/capability-matrix.mjs'

const KEY_PREFIX = 'aq:'

// ---- S-07（CWE-74）ask_user 回答内容边界 ----
// 身份校验链（token/来源/Control Core）管的是「谁答的」，不管「答了什么」——回答文本
// 经校验后直接进宿主 agent 会话，无长度上限、无控制字符过滤。这里补的是与身份正交的
// 内容边界：超长回答拒绝（fail-closed，绝不静默截断——半句话的回答比没有回答更危险），
// 控制/零宽/bidi 字符过滤（它们对人类不可见，却是注入载体）。
/** 自定义回答长度上限（Unicode 码点，非 UTF-16 单元——emoji/中文按人类感知计数）。 */
export const ANSWER_MAX_CODEPOINTS = 2000
/** 控制字符（保留 \n\t\r）、DEL、零宽/双向覆盖/字间隐藏类不可见字符。 */
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/**
 * 归一化远程回答文本：过滤不可见字符，统计码点长度。
 * @param {string} text
 * @returns {{ text: string, removed: number, tooLong: boolean }}
 */
export function sanitizeAnswerText(text) {
  const raw = String(text ?? '')
  const stripped = raw.replace(INVISIBLE_CHARS, '')
  const removed = raw.length - stripped.length
  const codePoints = [...stripped].length
  return { text: stripped, removed, tooLong: codePoints > ANSWER_MAX_CODEPOINTS }
}

// 升级链默认节奏（与审批一致：30s / 60s 各再提醒一轮）
const DEFAULT_ESCALATION_STAGES = [
  { afterMs: 30_000, level: 'timeSensitive', note: '提问仍在等待作答' },
  { afterMs: 60_000, level: 'timeSensitive', note: '提问仍在等待作答（第 2 次提醒）' },
]

/** 组装编号回复文案（P4：按钮渠道也保留——卡片发送失败时文字路径仍在）。 */
function numberedHint(options, multiSelect) {
  const lines = options.map((label, idx) => `${idx + 1}. ${label}`)
  const how = multiSelect ? '回复编号（多选逗号分隔，如 1,3）' : '回复编号'
  return `${lines.join('\n')}\n（${how}）`
}

/**
 * 创建远程提问桥。
 * @param {object} deps
 * @param {ReturnType<typeof import('../inbound/bus.mjs').createInboundBus>} deps.bus
 * @param {ReturnType<typeof import('../inbound/tokens.mjs').createTokenVault>} deps.vault
 * @param {import('../inbound/store.mjs').store} deps.store
 * @param {object} deps.notifier - createNotifier 实例（广播编号文案用）
 * @param {() => object[]} deps.interactive - 交互通道实例列表（惰性 getter，装配期后解引用）
 * @param {object} [deps.identity] - 身份注册表（CRACK-004：hint 兜底编号回复仅该渠道绑定的
 *   owner 可代答；缺失/异常 fail-closed。exact/onChannel 属当事人级命中，不查 identity）
 * @param {object} [deps.logger]
 * @param {{ timeoutMs?: number, escalation?: { enabled?: boolean, stages?: object[] } }} [deps.config]
 */
export function createQuestionBridge(deps) {
  const { bus, vault, store, notifier, identity } = deps
  const logger = deps.logger ?? null
  const config = deps.config ?? {}
  const defaultTimeoutMs = Math.max(1000, Number(config.timeoutMs) || 300000)
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/questions]', message) } catch { /* 日志失败绝不致命 */ }
  }

  const escalationCfg = (config.escalation !== null && typeof config.escalation === 'object') ? config.escalation : {}
  // v0.10 Web-first 远程升级（任务书 3.3）：webFirstMs 控制 Stage 0（pending 立账、Web
  // 管理台立即可见）到 Stage 1（推送主绑定 IM）的延迟；remoteEnabled=false 时永不推 IM，
  // 只保留 Web 可见（任务书「关闭远程推送不破坏原生 Web 提问」）。模块级默认 0 = 立即推送，
  // 保持 createQuestionBridge 直调（存量测试/消费方）行为逐字节不变；Web-first 默认值由
  // config.mjs 的 resolveConfig 注入（20s）。
  const webFirstMsNumber = Number(config.webFirstMs)
  const webFirstMs = Number.isFinite(webFirstMsNumber) ? Math.max(0, Math.trunc(webFirstMsNumber)) : 0
  const remoteEnabled = config.remoteEnabled !== false
  // reminderMs（Stage 2 备用目标提醒，从 t=0 起算）：提供且 > webFirstMs 时，把升级链
  // 推导为单次「push 后 reminderMs - webFirstMs」提醒；否则用默认 30s/60s 两段节奏。
  const reminderMsNumber = Number(config.reminderMs)
  const reminderMs = Number.isFinite(reminderMsNumber) ? Math.max(webFirstMs, Math.trunc(reminderMsNumber)) : null
  const escalationStages = Array.isArray(escalationCfg.stages) && escalationCfg.stages.length > 0
    ? escalationCfg.stages
    : (reminderMs !== null && reminderMs > webFirstMs
      ? [{ afterMs: reminderMs - webFirstMs, level: 'timeSensitive', note: '提问仍在等待作答（备用目标提醒）' }]
      : DEFAULT_ESCALATION_STAGES)
  const escalation = createEscalationChain({
    stages: escalationCfg.enabled === false ? [] : escalationStages,
    logger,
  })

  // Interaction Core：aq: 行统一状态机（pending→resolved，decision 终态裁决）。
  // latestPendingFor 归属/兜底启发式（exact/onChannel/hint）是提问特有语义，保留在
  // 链内——核心只提供原子账本操作（见 interaction/ledger.mjs）。
  const core = createInteractionLedger({ keyPrefix: KEY_PREFIX, store })
  /**
   * 最近一条待决提问（编号回复降级）。匹配优先级：
   * 当 chatId 提供时（Control Core Step 1）：
   *   1) exact (channel, userId, chatId) 精确匹配 pushedTo；
   *   2) onChannel (channel, userId) 匹配 pushedTo 但 chatId 不匹配（错误 chat）；
   *   3) hint (channel, userId, chatId) 匹配 hintTargets（per-chat 编号话术证据）。
   * 当 chatId 缺失时：仅用于识别并消费同用户的待决行，永不裁决；旧 hintChannels
   * 渠道级证据不再匹配。
   * CRACK-004：返回值带 evidence（exact|onChannel|hint）——handleNumberedReply 的
   * 归属闸据此放行当事人级命中、对 hint 要求 owner。onChannel 证据在 chatId 提供时
   * 表示「同用户错误 chat」→ handleNumberedReply 消费消息但不裁决。
   */
  const latestPendingFor = (channel, userId, chatId, accountId = undefined) => {
    let exact = null
    let onChannel = null
    let hint = null
    const newer = (current, candidate) => current === null || Number(candidate.row.createdAt ?? 0) > Number(current.row.createdAt ?? 0)
    const hasChatId = chatId !== undefined && chatId !== null && String(chatId) !== ''

    for (const key of core.scanKeys()) {
      const row = core.get(key)
      if (!core.isPending(row)) continue
      const pushed = Array.isArray(row.pushedTo) ? row.pushedTo : []

      if (hasChatId) {
        // Control Core Step 1：chat 级匹配
        const accountMatches = (target) => target.accountId === undefined || String(target.accountId) === String(accountId ?? '')
        const userMatch = pushed.some((target) => target.channel === channel && accountMatches(target) && String(target.userId) === String(userId))
        if (userMatch) {
          const chatMatch = pushed.some((target) => target.channel === channel && accountMatches(target) && String(target.userId) === String(userId) && String(target.chatId) === String(chatId))
          if (chatMatch) {
            const candidate = { key, row, evidence: 'exact' }
            if (newer(exact, candidate)) exact = candidate
          } else {
            const candidate = { key, row, evidence: 'onChannel' }
            if (newer(onChannel, candidate)) onChannel = candidate
          }
        }
        // hintTargets：per-chat 编号话术证据（旧 hintChannels 字符串数组不匹配——fail-closed）
        if (isHintedTarget(row, channel, userId, chatId, accountId)) {
          const candidate = { key, row, evidence: 'hint' }
          if (newer(hint, candidate)) hint = candidate
        }
        // hintTargets 渠道匹配但 chatId 不匹配 → 错误 chat（用 onChannel 证据触发回原会话提示）
        const hinted = Array.isArray(row.hintTargets) ? row.hintTargets : []
        if (hinted.some((t) => t.channel === channel && (t.accountId === undefined || String(t.accountId) === String(accountId ?? '')) && String(t.userId) === String(userId) && String(t.chatId) !== String(chatId))) {
          const candidate = { key, row, evidence: 'onChannel' }
          if (newer(onChannel, candidate)) onChannel = candidate
        }
      } else {
        // 无 chatId：仅按 (channel,userId) 识别待决行，绝不使用旧渠道级 hintChannels。
        if (pushed.some((target) => target.channel === channel && (target.accountId === undefined || String(target.accountId) === String(accountId ?? '')) && String(target.userId) === String(userId))) {
          const candidate = { key, row, evidence: 'exact' }
          if (newer(exact, candidate)) exact = candidate
          const channelCandidate = { key, row, evidence: 'onChannel' }
          if (newer(onChannel, channelCandidate)) onChannel = channelCandidate
        }
        // 缺 chatId 仍可消费已绑定用户收到过的 target-scoped 提示，但绝不裁决。
        // 仅按 (channel,userId) 识别待决行；旧 hintChannels 渠道级证据不再使用。
        if (Array.isArray(row.hintTargets) && row.hintTargets.some((t) => t.channel === channel && (t.accountId === undefined || String(t.accountId) === String(accountId ?? '')) && String(t.userId) === String(userId))) {
          const candidate = { key, row, evidence: 'hint' }
          if (newer(hint, candidate)) hint = candidate
        }
      }
    }
    // A matching chat is always preferred over a wrong-chat guard from another
    // pending row; only when no exact/hint evidence exists do we consume with
    // the "return to original chat" feedback.
    return exact ?? hint ?? onChannel
  }
  // 核心账本 + 提问专用归属启发式合成同一 ledger 面（其余调用点零改动）。
  const ledger = { ...core, latestPendingFor }

  /** Control Core Step 1：per-chat hint 证据匹配（=aq 行 hintTargets）。无该字段的旧行不匹配（fail-closed）。 */
  function isHintedTarget(row, channel, userId, chatId, accountId = undefined) {
    if (Array.isArray(row.hintTargets)) {
      return row.hintTargets.some((t) => t.channel === channel && (t.accountId === undefined || String(t.accountId) === String(accountId ?? '')) && String(t.userId) === String(userId) && String(t.chatId) === String(chatId))
    }
    return false
  }

  // All question callbacks use the shared Control Core when available. The
  // question-specific chat/hint matching above remains the source of truth for
  // numbered replies; this registration only supplies canonical event
  // construction, authorization, and settlement for callback ingress.
  if (deps.control !== null && deps.control !== undefined) {
    deps.control.register('question-answer', {
      getPending: (input) => ledger.get(input.qKey ?? input.key),
      buildEvent: (input, row, policy, now) => {
        const channel = String(input.channel ?? String(input.via ?? '').split(':')[0] ?? '')
        const chatId = String(input.chatId ?? '')
        const exact = (Array.isArray(row.pushedTo) ? row.pushedTo : []).find((target) => String(target.channel) === channel && String(target.chatId) === chatId && (target.accountId === undefined || String(target.accountId) === String(input.accountId ?? '')))
        return {
          eventId: input.eventId, sessionId: String(row.agentId ?? input.qKey ?? input.key), source: 'mobile', channel,
          accountId: exact?.accountId ?? input.accountId, userId: String(exact?.userId ?? input.userId ?? ''), chatId,
          policyVersion: String(row.policyVersion ?? policy.policyVersion ?? '1'), command: 'question-answer',
          chatType: input.chatType, createdAt: Number(row.createdAt ?? now - 1),
          expiresAt: Number(row.expiresAt ?? now + defaultTimeoutMs),
        }
      },
      authorize: (input, row, event) => {
        const targets = Array.isArray(row.pushedTo) ? row.pushedTo : []
        // 同 channel/chat/user 是否存在带 accountId 的推送目标。存在时来源必须精确落到该账号：
        // 同一用户可能控制多个 bot 账号，token/回调仍须绑定原始账号；缺失/错误 accountId 一律
        // fail-closed，不得凭 trusted owner 兜底放开到另一账号（CRACK-004 只豁免无账号绑定的行）。
        const bound = targets.filter((target) => String(target.channel) === event.channel && String(target.chatId) === event.chatId && (target.userId === undefined || String(target.userId) === event.userId))
        const accountBound = bound.some((t) => t.accountId !== undefined && String(t.accountId) !== '')
        const exact = targets.some((target) => (
          String(target.channel) === event.channel
          && String(target.chatId) === event.chatId
          && (target.accountId === undefined || String(target.accountId) === event.accountId)
          && (target.userId === undefined || String(target.userId) === event.userId)
        ))
        if (input.trusted !== true) return exact
        if (accountBound) return exact
        return exact || isAuthorizedDeciderQ(identity, event.channel, event.userId)
      },
      settle: (input) => input.trusted === true
        ? settle(input.qKey ?? input.key, ledger.get(input.qKey ?? input.key), input.optIdxes, input.via, input.userId)
        : decide({ qKey: input.qKey ?? input.key, optIdx: input.optIdx, values: input.values, token: input.token, via: input.via, userId: input.userId, chatId: input.chatId }),
    })
  }

  /** 交互通道列表（归一 + 防御；getter 失败按空处理）。 */
  function interactiveEntries() {
    try {
      const raw = typeof deps.interactive === 'function' ? deps.interactive() : []
      return (Array.isArray(raw) ? raw : [])
        .map((entry) => normalizeInbound(entry))
        .filter((entry) => entry !== null && entry.channel !== '')
    } catch {
      return []
    }
  }

  /** 推一个问题：选项卡片为主（单选按钮），编号文案只发卡片未送达的渠道（兜底）。 */
  async function pushQuestion(qKey, token, question, allowChats = null) {
    const title = `提问：${String(question.question).slice(0, 60)}`
    const context = String(question.context ?? '').trim()
    const content = [
      context !== '' ? context : 'agent 需要你做一个选择',
      question.multiSelect === true ? '（多选）' : '（单选）',
    ].join('\n')
    const options = question.options.map((option) => option.label)
    const isMulti = question.multiSelect === true
    const pushedTo = []
    const escalationTargets = []
    const escalationTargetKeys = new Set()
    const deliveredTypes = new Set() // 卡片已送达的通道类型：这些渠道不再重复教编号
    // issue #11：卡片未送达、但该问题目标用户已绑定此交互入站通道（kept 非空）的条目。
    // 这些通道的编号回复必须能命中（qq-bot 出站 ↔ qq 入站异名、wechat iLink 纯入站无出站都靠它）。
    const hintedInbound = []
    const persistPushed = () => {
      try {
        const row = ledger.get(qKey)
        if (row !== undefined) store.set(qKey, { ...row, pushedTo: [...pushedTo] })
      } catch { /* 增量落账失败不致命，末尾整体落账兜底 */ }
    }
    for (const inbound of interactiveEntries()) {
      const { kept } = guardTargets(inbound.channel, inbound.notifyTargets(), warn)
      for (const target of kept) {
        // 多选暂无卡片形态（飞书表单回调未实测，规划书风险项）：通道返回 null → 编号兜底
        const card = await inbound.sendQuestionCard({
          chatId: target.chatId,
          title,
          content,
          qKey,
          token,
          options,
          multiSelect: isMulti,
        })
        if (card !== null) {
          pushedTo.push({ channel: inbound.channel, ...(inbound.accountId === undefined ? {} : { accountId: String(inbound.accountId ?? '') }), chatId: target.chatId, userId: target.userId, messageId: card.messageId, kind: 'aq' })
          const targetKey = `${inbound.channel}\u0000${target.chatId}\u0000${target.userId}`
          if (!escalationTargetKeys.has(targetKey)) {
            escalationTargetKeys.add(targetKey)
            escalationTargets.push({ inbound, target })
          }
          if (allowChats !== null) {
            let chatSet = allowChats.get(inbound.channel)
            if (chatSet === undefined) {
              chatSet = new Set()
              allowChats.set(inbound.channel, chatSet)
            }
            chatSet.add(String(target.chatId))
          }
          deliveredTypes.add(inbound.channel)
          persistPushed()
        }
      }
      // issue #11：卡片未送达 + 目标用户已绑定 → 记录为待补编号话术的入站通道
      // （sendText 送达 + 目标补进 hintTargets）。只记 kept 非空的绑定通道，
      // 未绑定用户的通道不进（SEC-2 fail-closed）。
      if (kept.length > 0 && !deliveredTypes.has(inbound.channel)) {
        hintedInbound.push({ channel: inbound.channel, targets: kept, inbound })
      }
    }
    // 编号文案只发卡片未送达的渠道（P4 文字路径兜底）：卡片已到手的用户不再收
    // 一条冗余的「回复编号」广播——选项卡是主交互，编号是无卡片/投递失败时的降级。
    const allTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
    const textTypes = allTypes.filter((type) => !deliveredTypes.has(type))
    let deliveredTextTypes = []
    if (textTypes.length > 0) {
      const outcome = await notifier.notifyAll({
        title,
        content: `${content}\n\n${numberedHint(options, isMulti)}`,
        level: 'timeSensitive',
      }, { channelTypes: textTypes }).catch(() => null)
      // notifyAll 的 ok=true 也可能代表空目标/静音；只有返回 delivered 中的
      // 渠道才算真正留下编号兜底证据，失败或未知返回一律 fail-closed。
      if (outcome !== null && Array.isArray(outcome.delivered)) {
        const delivered = new Set(outcome.delivered.map((type) => String(type)))
        deliveredTextTypes = textTypes.filter((type) => delivered.has(String(type)))
      }
    }
    // issue #11：把「目标用户已绑定、卡片未送达」的交互入站通道补进编号话术覆盖范围。
    // 编号话术经入站 sendText 送达（纯入站通道如 wechat iLink 没有出站文本可走）；
    // 已由出站文本送达的通道（同名 type，或别名对如 qq-bot↔qq）不再经入站重发；
    // 但渠道级 delivered 不能证明具体 chat 收到，因此不登记 hintTargets。
    const hintText = `${title}\n${content}\n\n${numberedHint(options, isMulti)}`
    const hintedTargets = []
    for (const entry of hintedInbound) {
      const coveredByOutbound = isCoveredByOutbound(entry.channel, deliveredTextTypes)
      const hintSends = []
      for (const target of entry.targets) {
        const targetKey = `${entry.channel}\u0000${target.chatId}\u0000${target.userId}`
        if (!escalationTargetKeys.has(targetKey)) {
          escalationTargetKeys.add(targetKey)
          escalationTargets.push({ inbound: entry.inbound, target })
        }
        if (!coveredByOutbound) {
          hintSends.push(entry.inbound.sendText(target.chatId, hintText).then((ok) => ok === true).catch(() => false))
        }
      }
      if (!coveredByOutbound) {
        const outcomes = await Promise.all(hintSends)
        // 只记录 sendText 成功的目标（per-chat 送达证据，Control Core Step 1）
        for (let i = 0; i < entry.targets.length; i++) {
          if (outcomes[i] === true) {
            hintedTargets.push({ channel: entry.channel, ...(entry.inbound.accountId === undefined ? {} : { accountId: String(entry.inbound.accountId ?? '') }), chatId: entry.targets[i].chatId, userId: entry.targets[i].userId })
          }
        }
      }
    }
    // Control Core Step 1：hintTargets 是 per-chat 送达证据，替代旧渠道级 hintChannels。
    // 只有送达确认的 (channel, chatId, userId) 才能通过编号回复命中兜底路径。
    // 旧 hintChannels 字符串数组不再写入新行；旧行无 hintTargets 字段 → fail-closed。
    return { pushedTo, hintTargets: hintedTargets, escalationTargets }
  }

  /** 把送达过的卡片全部改成终态（超时/已答；editTarget 按 pushedTo 行的 kind 选卡片形态）。 */
  async function markResolved(pushedTo, text) {
    const byChannel = new Map(interactiveEntries().map((entry) => [entry.channel, entry]))
    for (const target of pushedTo ?? []) {
      const inbound = byChannel.get(target.channel)
      if (inbound === undefined) continue
      await inbound.editTarget(target, text)
    }
  }

  /** 下标集校验与去重（P3 封闭集）：越界/重复归一/单选多项一律 null。返回去重后的下标数组。 */
  function resolveIdxs(row, optIdxes) {
    if (!Array.isArray(optIdxes) || optIdxes.length === 0) return null
    if (row.multiSelect !== true && optIdxes.length !== 1) return null
    const seen = new Set()
    const idxs = []
    for (const rawIdx of optIdxes) {
      const idx = Number(rawIdx)
      if (!Number.isInteger(idx) || idx < 0 || idx >= row.options.length) return null
      if (seen.has(idx)) continue // 容忍重复（卡片表单可能回带重复值），去重即可
      seen.add(idx)
      idxs.push(idx)
    }
    return idxs
  }

  /** 统一裁决入口（token 路径）。返回 { ok, message, answers? }。 */
  function decide({ qKey, optIdx, values, token, via = 'unknown', userId = '(unknown)', chatId = undefined }) {
    const row = ledger.get(qKey)
    if (row === undefined || row.status !== 'pending') {
      return { ok: false, message: '该提问已回答或已过期' }
    }
    const verdict = vault.verify(token)
    if (!verdict.ok) {
      return { ok: false, message: `作答被拒绝（${verdict.reason === 'expired' ? '已过期' : '校验失败'}）` }
    }
    if (verdict.key !== qKey) return { ok: false, message: '作答被拒绝（问题不匹配）' }
    if (chatId !== undefined && chatId !== null && String(chatId) !== '') {
      const pushedTo = Array.isArray(row.pushedTo) ? row.pushedTo : []
      // v0.8.3 SEC-1：来源会话校验把通道一并纳入——only 比对 chatId 不够，跨通道
      // 同 chatId（如不同渠道恰好同值）要视为不同来源，避免误命中。
      const clickVia = String(via ?? '').split(':')[0]
      if (!pushedTo.some((target) => String(target?.channel ?? '') === clickVia && String(target?.chatId ?? '') === String(chatId))) {
        return { ok: false, message: '请到原会话操作' }
      }
    }
    const optIdxes = optIdx === 'm' ? values : [optIdx]
    return settle(qKey, row, optIdxes, via, userId)
  }

  /** 可信裁决（编号回复：白名单已由 bus.accept 建立，跳 token，仍受首达采纳约束）。 */
  function decideTrusted({ qKey, optIdxes, via = 'unknown', userId = '(unknown)' }) {
    const row = ledger.get(qKey)
    if (row === undefined || row.status !== 'pending') {
      return { ok: false, message: '该提问已回答或已过期' }
    }
    return settle(qKey, row, optIdxes, via, userId)
  }

  // Button callbacks carry an explicit qKey/token. They never use the
  // "latest pending" fallback, so concurrent questions cannot cross-talk.
  function handleCardAction(envelope) {
    const action = envelope?.questionAction
    if (action === null || typeof action !== 'object') return false
    const qKey = String(action.qKey ?? '')
    const optIdx = String(action.optIdx ?? '')
    const inbound = interactiveEntries().find((entry) => entry.channel === envelope.channel)
    const feedback = (text) => { if (inbound !== undefined) void inbound.sendText(envelope.chatId, text).catch(() => {}) }
    // PR #22：自定义回答与跳过按钮必须校验 token、ledger 与原始来源，
    // 否则过期/错 key/旧卡/错误聊天点击会误导用户或造成越权。
    if (optIdx === 'c' || optIdx === 'custom' || optIdx === 's' || optIdx === 'skip') {
      const isCustom = optIdx === 'c' || optIdx === 'custom'
      const tokenVerdict = vault.verify(String(action.token ?? ''))
      if (!tokenVerdict.ok) {
        feedback(`作答被拒绝（${tokenVerdict.reason === 'expired' ? '已过期' : '校验失败'}）`)
        return true
      }
      if (tokenVerdict.key !== qKey) { feedback('作答被拒绝（问题不匹配）'); return true }
      const row = ledger.get(qKey)
      if (row === undefined || row.status !== 'pending') { feedback('该提问已回答或已过期'); return true }
      const sourceChat = envelope.chatId !== undefined && envelope.chatId !== null ? String(envelope.chatId) : ''
      // 来源精确匹配：channel / chatId / userId，存在 accountId 时也必须匹配。
      // 多账号同聊天场景不得凭 userId 单独命中——pushedTo 只计与事件账号一致的目标。
      const target = Array.isArray(row.pushedTo) ? row.pushedTo.find((item) => String(item.channel) === String(envelope.channel) && String(item.chatId) === sourceChat && (item.accountId === undefined || String(item.accountId) === String(envelope.accountId ?? '')) && String(item.userId) === String(envelope.userId)) : null
      if (target === null || target === undefined || sourceChat === '') { feedback('请到原会话操作'); return true }
      // 自定义回答只展示指引，不直接结算；真正文本回答继续走 settleText / Control Core / bus.settle。
      if (isCustom) {
        feedback('✍️ 自定义回答：直接回复「答：<你的回答>」')
        return true
      }
      // 跳过一律经共享 Control Core 的 question-answer 契约裁决（授权/来源/策略/群聊 fail-closed），
      // 结算走 settleSkip（仍以 bus.settle 首达采纳为唯一落账点）。控制缺失 → fail-closed：
      // 绝不直结（不再回退 bus.settle），防止无授权即放行跳过。
      if (deps.control === null || deps.control === undefined) {
        feedback('该提问已被作答（首达采纳）')
        return true
      }
      const verdict = deps.control.handle({
        eventId: String(envelope.messageId ?? ''),
        command: 'question-answer',
        qKey,
        channel: envelope.channel,
        accountId: envelope.accountId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
        userId: envelope.userId,
        via: `${envelope.channel}:button`,
        trusted: true,
        settle: () => settleSkip(qKey, envelope),
      })
      if (verdict.ok === true || verdict.status === 'accepted') {
        feedback('⏭ 已跳过该提问：交还桌面处理')
      } else {
        // 已决/组聊/来源不满足 → fail-closed：消费回调、提示不可再跳，绝不放行词条
        feedback(verdict.message ?? '该提问已被作答（首达采纳）')
      }
      return true
    }
    const sourceRow = ledger.get(qKey)
    const sourceChat = envelope.chatId !== undefined && envelope.chatId !== null && String(envelope.chatId) !== '' ? String(envelope.chatId) : null
    if (sourceRow === undefined || sourceChat === null) { feedback('请到原会话操作'); return true }
    const sourceTargets = Array.isArray(sourceRow.pushedTo) ? sourceRow.pushedTo.filter((target) => String(target.channel) === String(envelope.channel) && String(target.chatId) === sourceChat && (target.accountId === undefined || String(target.accountId) === String(envelope.accountId ?? ''))) : []
    if (sourceTargets.length === 0 || !sourceTargets.some((target) => String(target.userId) === String(envelope.userId))) { feedback('请到原会话操作'); return true }
    // v0.8.7：Control Core 缺失时 fail-closed，不直结——防止无授权即放行按钮作答。
    if (deps.control === null || deps.control === undefined) {
      feedback('该提问已被作答（首达采纳）')
      return true
    }
    const verdict = deps.control.handle({ eventId: String(envelope.messageId ?? ''), command: 'question-answer', qKey, optIdx, token: String(action.token ?? ''), via: `${envelope.channel}:button`, channel: envelope.channel, accountId: envelope.accountId, userId: envelope.userId, chatId: envelope.chatId, chatType: envelope.chatType })
    feedback(verdict.message ?? '该提问已回答或已过期')
    return true
  }

  function settle(qKey, row, optIdxes, via, userId) {
    const idxs = resolveIdxs(row, optIdxes)
    if (idxs === null) {
      return { ok: false, message: '无效选项（只接受提问时给出的编号）' }
    }
    const verdict = bus.settle(qKey, { kind: 'aq', idxs }, via, userId)
    if (!verdict.ok) return { ok: false, message: '该提问已被作答（首达采纳）' }
    const labels = idxs.map((idx) => row.options[idx])
    ledger.resolve(qKey, 'answered', { answers: labels, via: String(via), userId: String(userId) })
    warn(`${qKey} 作答：${labels.join('、')}（via ${via}）`)
    return { ok: true, message: `✅ 已作答：${labels.join('、')}`, answers: labels }
  }

  /** 自定义文本作答（'答：...'）：与 settle 共享 bus.settle 首达采纳 + ledger.resolve 落账。
   *  只在 Control Core 已放行（或控制不可用时的精确来源兜底）后才被调用——它不是新的直通后门。
   *  S-07：入口处过内容边界（超长拒绝、不可见字符过滤），身份链不动。 */
  function settleText(qKey, answer, envelope) {
    const safe = sanitizeAnswerText(answer)
    if (safe.removed > 0) {
      warn(`${qKey} 自定义作答含 ${safe.removed} 个控制/零宽字符，已过滤（S-07 注入边界）`)
    }
    if (safe.tooLong) {
      return { ok: false, message: `回答过长（超过 ${ANSWER_MAX_CODEPOINTS} 字符），已拒绝；请精简后重发或在桌面端直接回答` }
    }
    const verdict = bus.settle(qKey, { kind: 'aq-text', idxs: [], text: safe.text }, `${envelope.channel}:text`, envelope.userId)
    if (!verdict.ok) return { ok: false, message: '该提问已被作答（首达采纳）' }
    ledger.resolve(qKey, 'answered', { answers: [safe.text], via: `${envelope.channel}:text`, userId: String(envelope.userId) })
    warn(`${qKey} 自定义作答（via ${envelope.channel}:text）`)
    return { ok: true, message: `✅ 已作答（自定义）：${safe.text}`, answers: [safe.text] }
  }

  /** 跳过（aq-skip）：与 admin decline 同语义（交还桌面、绝不编造答案），但来自手机端按钮。 */
  function settleSkip(qKey, envelope) {
    const verdict = bus.settle(qKey, { kind: 'aq-skip', idxs: [] }, `${envelope.channel}:button`, envelope.userId)
    if (!verdict.ok) return { ok: false, message: '该提问已被作答（首达采纳）' }
    ledger.resolve(qKey, 'skipped', { via: `${envelope.channel}:button`, userId: String(envelope.userId) })
    warn(`${qKey} 已跳过（via ${envelope.channel}:button）`)
    return { ok: true, message: '⏭ 已跳过该提问：交还桌面处理' }
  }

  // ———————————————— 管理台待决问题 facade（路线图阶段 2A，2026-08-26） ————————————————
  // 本块是 admin/UI 与问题桥之间的最小兼容门面：`adminPending()` 只做脱敏只读快照，
  // `adminSettle()` 把裁决一律经注入的 Control Core `deps.control.handle()` 路由——
  // 授权（配对/source/policy/首达采纳）与单次结算语义全部由 Control Core 承接，本块
  // **绝不**在门口复制 ledger 结算或直接写状态；对已待决之外的任何输入 fail-closed。
  // 红线：快照与审计里绝不出现 token / 凭证 / 完整聊天或 agent 标识 / 答案隐私。
  let adminSettleSeq = 0 // 每次 admin 结算给唯一 eventId（缺 eventId 会被 normalize 拒绝）
  const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
  /** 待决问题键的不可逆短引用（避免把 `aq:<随机>` 原键散进 UI/日志；解析按哈希回扫）。 */
  const questionRefOf = (key) => sha256(key).slice(0, 12)
  /** 脱敏标识：sha256 前缀短段 —— 绝不回放完整 session/agent/chat/user 值。 */
  const maskedId = (value, prefix, len = 6) => {
    if (value === undefined || value === null || String(value) === '') return null
    return `${prefix}${sha256(value).slice(0, len)}`
  }
  /**
   * 解析 admin 提交的 ref → 真实 `aq:` 键。只在当前 store 的 aq 待决键中哈希匹配，
   * 命中即该键（48-bit 前缀碰撞在并发待决里概率可忽略，最坏影响是一次错误结算被
   * 首达采纳挡掉——fail-closed）。未知 ref 返回 null。
   */
  const resolveQuestionRef = (ref) => {
    const target = String(ref ?? '').trim()
    if (target === '') return null
    for (const key of core.scanKeys()) if (questionRefOf(key) === target) return key
    return null
  }
  /** 单条待决问题 → 脱敏快照行（只含 UI 渲染所需：文本/选项/脱敏来源/时间/状态）。 */
  const sanitizeQuestion = (key, row) => {
    const sources = Array.isArray(row.pushedTo)
      ? row.pushedTo.map((target) => ({
          channel: String(target?.channel ?? ''),
          chat: maskedId(target?.chatId, 'chat-'),
          user: maskedId(target?.userId, 'user-'),
        }))
      : []
    return {
      ref: questionRefOf(key),
      question: String(row.question ?? ''),
      options: (Array.isArray(row.options) ? row.options : []).map(String),
      multiSelect: row.multiSelect === true,
      status: 'pending',
      agent: maskedId(row.agentId, 'agent-'),
      source: sources,
      createdAt: Number.isFinite(Number(row.createdAt)) ? Number(row.createdAt) : null,
      expiresAt: Number.isFinite(Number(row.expiresAt)) ? Number(row.expiresAt) : null,
    }
  }
  /** admin 驳回：复用手机端「跳过」的语义（`aq-skip` + ledger.resolve 'skipped'），交还桌面、
   *  绝不编造答案；bus.settle 首达采纳保证与作答互斥（单次结算）。 */
  function decline(key, row, via, userId) {
    const verdict = bus.settle(key, { kind: 'aq-skip', idxs: [] }, via, userId)
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? 'already-resolved' }
    ledger.resolve(key, 'skipped', { via, userId })
    return { ok: true, message: '已驳回该提问：交还桌面处理', answers: [] }
  }
  /** 当前待决问题归属的 agentId 集合（供任务投影 attention 与装配层判定「待关注」；
   *  只用于装配-内部同进程判定，绝不进入 admin/UI/日志快照——raw agentId 不外泄）。 */
  function pendingAgentIds() {
    const ids = new Set()
    for (const key of core.scanKeys()) {
      if (!key.startsWith(KEY_PREFIX)) continue
      const row = core.get(key)
      if (!core.isPending(row)) continue
      const agentId = String(row?.agentId ?? '')
      if (agentId !== '') ids.add(agentId)
    }
    return ids
  }
  /** 当前待决问题汇总（读快照，绝不抛）。无任何待决返回空数组。 */
  function adminPending() {
    const rows = []
    for (const key of core.scanKeys()) {
      if (!key.startsWith(KEY_PREFIX)) continue // scanKeys 已按前缀过滤，双保险
      const row = core.get(key)
      if (!core.isPending(row)) continue
      rows.push(sanitizeQuestion(key, row))
    }
    // 新在前，稳定排序（createdAt 同值按 ref 中止，避免排序不稳定）
    rows.sort((a, b) => (Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    return rows
  }
  /**
   * 管理台裁决入口（单一入口，只对当前待决问题生效）：
   * action 'choose' 携带 options（0 基下标数组）切到指定选项；action 'reject' 驳回交还桌面。
   * 授权与单次结算全部经 `deps.control.handle`（pairing/source/policy/首达采纳）；
   * 本块通过 `input.settle` 直连 Control Core 的 onSettle 并捕获真实 settle/decline 结果，
   * 以便区分「本侧胜出」与「手机端已先答」（后者返回 handled:true，不重复结算）。
   * 任何无法确证来源目标 / 越权 / 过期 / 未知 ref / 非法 option / 异常 → fail-closed 安全错误。
   * @returns {{ ok: boolean, handled?: boolean, reason?: string, message?: string, optionLabels?: string[] }}
   */
  function adminSettle(input = {}) {
    const ref = String(input?.ref ?? '').trim()
    const action = String(input?.action ?? '').trim().toLowerCase()
    if (action !== 'choose' && action !== 'reject') {
      return { ok: false, handled: false, reason: 'invalid_action', message: 'action 只能是 choose 或 reject' }
    }
    const key = resolveQuestionRef(ref)
    if (key === null) {
      return { ok: false, handled: false, reason: 'unknown_question', message: '未找到该待决问题' }
    }
    const row = core.get(key)
    if (!core.isPending(row)) {
      // 已决（作答/超时/跳过）或缺失 → already-handled；绝不二次结算
      return { ok: false, handled: true, reason: 'already_handled', message: '该问题已被裁决（作答/过期/驳回）' }
    }
    // 选项封闭集预检（越界/重复/单选多项 → fail-closed），复用 resolveIdxs 语义
    let optIdxs = null
    if (action === 'choose') {
      optIdxs = resolveIdxs(row, Array.isArray(input.options) ? input.options : [])
      if (optIdxs === null) {
        return { ok: false, handled: false, reason: 'invalid_option', message: '无效选项：只接受该问题给出的编号（越界/重复/单选不可多项）' }
      }
    }
    // 只能在一个确凿的来源目标上结算（事件绑定 pushedTo，配以 event.channel/chatId 等）。
    // 无目标即无法安全按当事人来源路由 → fail-closed，绝不凭空编造 channel/chat。
    const pushed = Array.isArray(row.pushedTo) ? row.pushedTo : []
    const target = pushed.find((t) => t && t.channel !== '' && t.chatId !== undefined && t.chatId !== null && String(t.chatId) !== '')
      ?? (pushed.length > 0 ? pushed[0] : null)
    if (target === null) {
      return { ok: false, handled: false, reason: 'no_target', message: '该问题没有可用的来源目标，无法安全裁决' }
    }

    const outcome = { ok: false, handled: false, reason: null, message: '', answers: null }
    // 结算一律经 Control Core 的 question-answer 注册 spec 裁决（buildEvent/authorize/
    // canAcceptCommand 全跑）；事件身份 = 该待决问题的确凿来源目标（pushedTo 精确命中的
    // channel/chatId/accountId），由 spec.buildEvent 据此回填 bound userId —— 管理台操作者
    // 绝不冒充目标用户身份，操作者来源只经 via='admin:web' 与 admin 审计带出（不落 ledger）。
    const receipt = deps.control?.handle({
      command: 'question-answer',
      eventId: `admin-settle:${key}:${++adminSettleSeq}`,
      qKey: key,
      trusted: true,
      via: 'admin:web',
      channel: String(target.channel ?? ''),
      accountId: String(target.accountId ?? ''),
      chatId: String(target.chatId ?? ''),
      // 终端动作仍走问题桥既有裁决核心（settle/decline），由 Control Core onSettle 调起；
      // 捕获真实首达结果供下面区分 already-handled 与「本侧胜出」。
      settle: () => {
        const res = action === 'choose'
          ? settle(key, row, optIdxs, 'admin:web', 'admin:web')
          : decline(key, row, 'admin:web', 'admin:web')
        outcome.ok = res?.ok === true
        outcome.handled = outcome.handled || res?.ok !== true
        outcome.reason = res?.reason ?? null
        outcome.message = res?.message ?? ''
        outcome.answers = res?.answers ?? null
        return res === null || res === undefined ? false : res
      },
    })
    // 无 Control Core（未接线）→ receipt 为空 → 落到最末 not_available，fail-closed：
    // 结算绝不跳过控制核心直接落库（本端点不留直通后门）。
    const status = receipt?.status
    if (status === 'accepted') {
      // spec 的 safest settle 已真实执行；outcome 捕获到的是首达采纳的真实结果。
      if (outcome.ok === true) return { ok: true, handled: false, reason: null, message: outcome.message, optionLabels: outcome.answers }
      // 手机端先答夺标：本次未重复结算，明确 already-handled
      return { ok: false, handled: true, reason: 'already_handled', message: outcome.message || '该问题已被作答（首达采纳），本次未生效' }
    }
    if (status === 'already_handled') return { ok: false, handled: true, reason: 'already_handled', message: '该问题已被裁决（首达采纳），本次未生效' }
    if (status === 'expired') return { ok: false, handled: false, reason: 'expired', message: '该问题已过期' }
    // rejected / desktop_fallback → fail-closed，按原因细分（绝不假造放行）
    const reason = receipt?.reason
    if (reason === 'expired') return { ok: false, handled: false, reason: 'expired', message: '该问题已过期' }
    if (reason === 'not_pending' || reason === 'duplicate_event') {
      return { ok: false, handled: true, reason: 'already_handled', message: '该问题已被裁决（作答/过期/驳回）' }
    }
    if (reason === 'source_mismatch_channel' || reason === 'source_mismatch_chatId' || reason === 'source_mismatch_accountId'
      || reason === 'source_mismatch_userId' || reason === 'not_paired' || reason === 'source_policy_rejected' || reason === 'owner_only') {
      return { ok: false, handled: false, reason: 'unauthorized', message: '管理台不满足该问题的来源/身份授权（无法确证 owner/admin）' }
    }
    return { ok: false, handled: false, reason: 'not_available', message: '该问题结算当前不可用（Control Core 未接线或已拒绝）' }
  }

  /**
   * 编号回复兜底（P4）：白名单用户回复 '2' / '1,3' 作答最近一条待决提问。
   * G-52：分隔符宽容化——{, ， 、 ; ； 空白} 任意混用（'1, 3' '1、3' '1 3' 均按多选），
   * 重复编号去重；任一词非 1-2 位数字仍整条不认（fail-closed 落回对话路由）。
   * 发错了不作废——无效编号：消费该消息（不进对话路由）+ 回执提示 + 把选项重发一遍，
   * 问题保持待决，用户直接再答即可；有效作答后回执确认。
   * 消费语义与审批一致：返回 true = bus 停止扇出（不进对话路由）。
   * 注意：审批的编号处理器先注册（'1'/'2' 且有待决审批时审批优先消费）。
   *
   * Control Core Step 1：chat 来源隔离
   *  - 缺 chatId → fail-closed：消费消息但不裁决（不落回对话路由）；G-43 补指路回执
   *  - onChannel 证据（同用户错误 chat）→ 消费 + 回执「请到原会话操作」+ 不裁决
   *  - exact/hint 证据（chat 匹配）→ 正常作答流程
   */
  function handleNumberedReply(envelope) {
    const text = String(envelope.text ?? '').trim()
    if (/^答[:：]/.test(text)) {
      const chatId = envelope.chatId !== undefined && envelope.chatId !== null ? String(envelope.chatId) : null
      // accountId 一并参与归属匹配：自定义作答不得凭 (channel,userId) 命中另一账号的待决行
      const pending = ledger.latestPendingFor(envelope.channel, envelope.userId, chatId, envelope.accountId)
      if (pending === null) return false
      if (chatId === null || pending.evidence !== 'exact' && pending.evidence !== 'hint') return true
      const answer = text.replace(/^答[:：]\s*/, '').trim()
      const inbound = interactiveEntries().find((entry) => entry.channel === envelope.channel)
      if (answer === '') { if (inbound !== undefined) void inbound.sendText(envelope.chatId, '请在「答：」后面写回答').catch(() => {}); return true }
      // S-07 内容边界前置检查：超长直接拒收并回执指引（不进 Control Core 白跑一轮；
      // settleText 内还有同一道闸兜底，双覆盖只花几行）
      const precheck = sanitizeAnswerText(answer)
      if (precheck.tooLong) {
        if (inbound !== undefined) void inbound.sendText(envelope.chatId, `回答过长（超过 ${ANSWER_MAX_CODEPOINTS} 字符），已拒绝；请精简后重发或在桌面端直接回答`).catch(() => {})
        return true
      }
      // 自定义作答也经共享 Control Core 的 question-answer 契约裁决（授权/来源/策略/群聊 fail-closed）；
      // 结算走 settleText（仍以 bus.settle 首达采纳为唯一落账点）。控制缺失 → fail-closed：绝不直结
      // （不再回退 bus.settle），防止无授权即落账。
      if (deps.control === null || deps.control === undefined) {
        if (inbound !== undefined) void inbound.sendText(envelope.chatId, '该提问已被作答（首达采纳）').catch(() => {})
        return true
      }
      const verdict = deps.control.handle({
        eventId: String(envelope.messageId ?? ''),
        command: 'question-answer',
        qKey: pending.key,
        channel: envelope.channel,
        accountId: envelope.accountId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
        userId: envelope.userId,
        via: `${envelope.channel}:text`,
        trusted: true,
        settle: () => settleText(pending.key, answer, envelope),
      })
      if (verdict.ok === true || verdict.status === 'accepted') {
        if (inbound !== undefined) void inbound.sendText(envelope.chatId, `✅ 已作答（自定义）：${answer}`).catch(() => {})
      } else {
        // 已决/来源不满足 → fail-closed：消费消息、提示不可再答
        if (inbound !== undefined) void inbound.sendText(envelope.chatId, verdict.message ?? '该提问已被作答（首达采纳）').catch(() => {})
      }
      return true
    }
    // G-52：分词式裸编号识别。旧整条正则 ^\d{1,2}([,，]\d{1,2})*$ 只认「紧邻的中/英文逗号」，
    // '1, 3'（逗号后空格）、'1、3'（顿号）、'1 3'（纯空格）全部不匹配 → return false 落回
    // 对话路由——用户明明在作答，裸编号却被当普通文本喂给 agent，等到超时才发现没生效。
    // 改为按多分隔符分词后逐词校验：分隔符集 {, ， 、 ; ； 空白} 任意混用均可；任一词不是
    // 1-2 位数字即整条不认。fail-closed 语义不变——不匹配仍 return false 落回对话路由，
    // 越界号校验维持既有回执（下方 outOfRange 分支）。
    const tokens = text.split(/[,，、;；\s]+/).filter(Boolean)
    if (tokens.length === 0 || tokens.some((t) => !/^\d{1,2}$/.test(t))) return false
    // 去重：'1, 1' 与 '1' 同义（重复勾选同一项不二次落账）；Set 保序去重
    const nums = [...new Set(tokens.map(Number))]

    const chatId = envelope.chatId !== undefined && envelope.chatId !== null && String(envelope.chatId) !== ''
      ? String(envelope.chatId) : null

    const sendFeedback = (message) => {
      const inbound = interactiveEntries().find((entry) => entry.channel === envelope.channel)
      if (inbound !== undefined) void inbound.sendText(envelope.chatId, message)
    }

    // 缺 chatId：fail-closed——消费裸编号但不裁决，不落回对话路由
    if (chatId === null) {
      // v0.8.7：accountId 一并传入——pushedTo/hintTargets 现携带本地 accountId（真实适配器
      // 恒提供），裸用 (channel,userId) 会因 accountMatches 恒 false 漏过已绑定用户的回复，
      // 使「缺 chatId → 消费但不裁决」的 fail-closed 语义失效（泄露进对话路由）。
      const anyPending = ledger.latestPendingFor(envelope.channel, envelope.userId, null, envelope.accountId)
      if (anyPending === null) return false
      // G-43：消费黑洞补回执。此前该路径吃掉裸编号后静默 return true——消息被消费（不进
      // 对话路由）、问题不裁决，用户端零反馈，要等超时才知道作答没生效。补一条指路回执，
      // 裁决结果不受影响（仍不落账、问题保持待决），仅消除黑洞。回执走该渠道普通回复路径
      // （best-effort：chatId 本就缺失，适配器 sendText 拿不到有效目标时自行失败吞掉，
      // 不影响消费语义）。
      sendFeedback('该回复未能定位到提问卡片（缺少会话上下文），请回到原卡片回复或使用管理台裁决')
      return true
    }

    const pending = ledger.latestPendingFor(envelope.channel, envelope.userId, chatId, envelope.accountId)
    if (pending === null) return false

    const row = pending.row
    const max = row.options.length

    // 错误 chat（同用户同渠道但 chatId 不匹配）：消费 + 回执 + 不裁决
    if (pending.evidence === 'onChannel') {
      sendFeedback('请到原会话操作')
      return true
    }

    // CRACK-004 归属闸：exact 已是当事人级命中（同 user 同 chat），直接放行；
    // hint 属广播兜底——仅该渠道绑定的 owner 可代答。identity 缺失/异常一律 fail-closed。
    // 拒绝语义：消费裸编号（不进对话路由）+ 回执提示，问题保持待决，原提问者仍可作答。
    const allowed = pending.evidence === 'exact' || isAuthorizedDeciderQ(identity, envelope.channel, envelope.userId)
    if (!allowed) {
      warn(`提问编号越权拒绝 ${pending.key}（evidence=${pending.evidence}，user ${envelope.userId} 非 owner）`)
      sendFeedback('此提问不是你作答的（无权回答）')
      return true
    }
    const optIdxes = nums.map((num) => num - 1) // 展示 1 基 → 存储 0 基
    const outOfRange = optIdxes.some((idx) => idx < 0 || idx >= max)
    const wrongMultiplicity = row.multiSelect !== true && nums.length !== 1
    if (outOfRange || wrongMultiplicity) {
      const why = wrongMultiplicity
        ? '本题是单选，请只回复一个编号'
        : `编号需在 1-${max} 之间${row.multiSelect === true ? '，多选用逗号分隔（如 1,3）' : ''}`
      sendFeedback(`❓ ${why}\n${numberedHint(row.options, row.multiSelect === true)}`)
      return true // 发错了可以再发：问题保持待决，上面的选项已重发
    }
    // v0.8.7：Control Core 缺失时 fail-closed，不直结——防止无授权即放行编号作答。
    if (deps.control === null || deps.control === undefined) {
      sendFeedback('该提问已被作答（首达采纳）')
      return true
    }
    const verdict = deps.control.handle({ eventId: String(envelope.messageId ?? ''), command: 'question-answer', qKey: pending.key, channel: envelope.channel, accountId: envelope.accountId, chatId: envelope.chatId, chatType: envelope.chatType, userId: envelope.userId, via: `${envelope.channel}:reply`, optIdxes, trusted: true })
    if (verdict.ok === true || verdict.status === 'accepted') {
      // v0.8.7：Control Core 回执是通用形状，不携带结算明细——答案标签从已结算的账本行回读
      //（settle → ledger.resolve 同步写入 answers），避免主数据回执出现「✅ 已作答：」空标签。
      const row = ledger.get(pending.key)
      const answers = Array.isArray(row?.answers) ? row.answers : []
      sendFeedback(`✅ 已作答：${answers.join('、')}`)
      return true
    }
    // 罕见竞态（作答瞬间恰好超时）：回执说明，同样消费避免把裸编号漏进对话路由
    sendFeedback(verdict.message ?? '该提问已回答或已过期')
    return true
  }

  /** CRACK-004：hint 编号兜底代答资格——仅该渠道绑定的 owner 可代答；identity 缺失/异常 fail-closed。 */
  function isAuthorizedDeciderQ(identity, channel, userId) {
    if (!identity) return false
    try { return identity.list(channel).some((r) => String(r.userId) === String(userId) && r.role === 'owner') } catch { return false }
  }

  let disposeMessage = null
  let disposeCardAction = null
  let disposed = false

  /**
   * 挂载编号回复处理器。G-31 起消费优先级由 bus.onMessage 的显式 priority 声明
   * （卡片动作 10 / 编号回复 20），不再依赖「先于审批路由注册」的调用次序——
   * 审批与提问同为 numberedReply 时按注册序稳定排序，审批仍先裁决（歧义时
   * 提问不抢走审批的 '1'/'2' 回复）。
   */
  function attach() {
    if (disposed) return
    if (disposeCardAction === null) disposeCardAction = bus.onMessage(handleCardAction, { priority: MESSAGE_PRIORITY.cardAction })
    if (disposeMessage === null) disposeMessage = bus.onMessage(handleNumberedReply, { priority: MESSAGE_PRIORITY.numberedReply })
  }

  /**
   * 执行一次远程提问（ask_user 工具核心；多问逐问推送、逐问独立作答）。
   * @param {{ questions: { question: string, options: { label: string }[], multiSelect?: boolean }[],
   *           timeoutMs?: number, context?: string }} payload
   * @returns {Promise<{ ok: boolean, answered: boolean, results: object[], reason?: string }>}
   */
  async function askQuestions(payload, execContext = {}) {
    const questions = Array.isArray(payload?.questions) ? payload.questions : []
    const timeoutMs = Math.max(1000, Number(payload?.timeoutMs) || defaultTimeoutMs)
    if (questions.length === 0) return { ok: false, answered: false, results: [], reason: 'questions 不能为空' }
    const results = []
    let allAnswered = true
    const agentId = execContext?.agent?.id ?? execContext?.agent?.session?.id ?? execContext?.session?.id ?? null
    for (const question of questions) {
      if (disposed) {
        results.push({ question: String(question?.question ?? ''), answered: false, reason: 'stopped' })
        allAnswered = false
        continue
      }
      const qKey = `${KEY_PREFIX}${randomBytes(4).toString('hex')}`
      let outcome = null
      // v0.10 Web-first 分级状态机（提升到 try 外，catch 分支也能统一清理）：
      // pushTimer = Stage 0→1 延迟推卡定时器；deliverySettled = 终态已到（answer/skip/
      // timeout/error/host-disposed 任一），后续不再启动 Stage 2 升级。
      let pushTimer = null
      let deliverySettled = false
      const cancelDelivery = () => {
        deliverySettled = true
        if (pushTimer !== null) { clearTimeout(pushTimer); pushTimer = null }
        try { escalation.stop(qKey) } catch { /* 清理不致命 */ }
      }
      try {
        const token = vault.mint(qKey)
        ledger.add(qKey, {
          question: String(question.question ?? ''),
          options: question.options.map((option) => String(option.label)),
          multiSelect: question.multiSelect === true,
          context: String(payload?.context ?? ''),
          agentId: agentId !== null && String(agentId) !== '' ? String(agentId) : null,
          pushedTo: [],
          expiresAt: Date.now() + timeoutMs,
        })
        // waiter 预注册先于推卡（v0.6.3 审批时序同款：早到作答不被丢）。
        // AUTH-1：wait 登记允许会话范围（allowChats）；pushQuestion 每送达一张卡片即
        // 把它对应的 chatId 并入 allowChats（空目标 = 空 Map，不放行任意 chat）。
        const allowChats = new Map()
        const waitPromise = bus.wait(qKey, timeoutMs, {
          agentId: agentId !== null ? String(agentId) : '',
          onAbandon: () => { try { ledger.terminate(qKey) } catch { } },
          allowChats,
        })
        // v0.10 Stage 0→Stage 1 投递。Stage 0 已立账（pending，Web 管理台立即可见）。
        // remoteEnabled=false 永不推 IM（纯 Web 作答/超时）；webFirstMs>0 延迟推送主绑定 IM；
        // webFirstMs=0 立即推送（存量直调行为）。
        let pushedTo = []
        let hintTargets = []
        let escalationTargets = []
        const runPush = async () => {
          const pushResult = await pushQuestion(qKey, token, question, allowChats)
          // 临界窗口：终态先到（用户在 webFirstMs 边缘作答）——pushedTo 仍落账，供
          // markResolved 更新已推卡片；但不再启动 Stage 2 升级。
          pushedTo = pushResult.pushedTo
          hintTargets = pushResult.hintTargets
          const rowNow = ledger.get(qKey)
          if (rowNow !== undefined) store.set(qKey, { ...rowNow, pushedTo, hintTargets })
          if (deliverySettled) return
          escalationTargets = pushResult.escalationTargets
          const startedAt = Date.now()
          escalation.start(qKey, (_key, stage) => {
            const text = `提问仍在等待作答：${String(question.question ?? '').slice(0, 40)}\n${stage.note ?? '仍在等待作答'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）。请点击选项卡片按钮作答；无卡片渠道可回复选项编号。`
            // 升级提醒必须逐目标发送。按 channelTypes 调 notifyAll 仍会覆盖同渠道的
            // 其他 chat/user；没有精确目标时 fail-closed，不向全局渠道广播。
            const sends = Array.isArray(escalationTargets) ? escalationTargets.map(async ({ inbound, target }) => {
              try { await inbound.sendText(target.chatId, text) } catch { /* 单目标失败不影响其他目标 */ }
            }) : []
            Promise.all(sends).catch(() => {})
          })
        }
        if (remoteEnabled) {
          if (webFirstMs > 0) {
            pushTimer = setTimeout(() => {
              runPush().catch((error) => warn(`Stage 1 推送异常: ${error instanceof Error ? error.message : String(error)}`))
            }, webFirstMs)
          } else {
            await runPush()
          }
        }
        outcome = await waitPromise
        cancelDelivery()
        const rowAfterWait = ledger.get(qKey)
        if (rowAfterWait?.decision === 'terminated') {
          await markResolved(rowAfterWait?.pushedTo ?? pushedTo ?? [], '⏹ 已终止：agent 会话已结束，提问取消')
          results.push({ question: String(question.question ?? ''), answered: false, reason: 'terminated' })
          allAnswered = false
          continue
        }
        if (outcome?.decision?.kind === 'aq-skip') {
          await markResolved(ledger.get(qKey)?.pushedTo ?? [], '⏭ 已跳过：交还桌面处理')
          results.push({ question: String(question.question ?? ''), answered: false, reason: 'skipped-by-user' })
          allAnswered = false
          continue
        }
        if (outcome?.decision?.kind === 'aq-text') {
          const answer = String(outcome.decision.text ?? '')
          await markResolved(ledger.get(qKey)?.pushedTo ?? [], `✅ 已作答（自定义）：${answer}`)
          results.push({ question: String(question.question ?? ''), answered: true, answers: [answer], via: outcome.via })
          continue
        }
      } catch (error) {
        warn(`提问推送/等待异常（交还桌面语义）: ${error instanceof Error ? error.message : String(error)}`)
        cancelDelivery()
        try { bus.abandon(qKey) } catch { /* 清理不致命 */ }
        try { ledger.resolve(qKey, 'error') } catch { /* 账本失败不致命 */ }
        outcome = { __error: true }
      }
      if (outcome === null) {
        // P2 超时永不代答：唯一产物是 answered=false
        ledger.resolve(qKey, 'timeout')
        await markResolved(ledger.get(qKey)?.pushedTo ?? [], '⏱ 超时未作答：已交还桌面（按钮失效）')
        results.push({ question: String(question.question ?? ''), answered: false })
        allAnswered = false
        continue
      }
      if (outcome.__error === true) {
        results.push({ question: String(question.question ?? ''), answered: false, reason: 'error' })
        allAnswered = false
        continue
      }
      // outcome = bus.wait 的裁决信封 { decision: settle 载荷 {kind:'aq', idxs}, via, userId }
      const row = ledger.get(qKey)
      const idxs = Array.isArray(outcome?.decision?.idxs) ? outcome.decision.idxs : []
      const answers = idxs.map((idx) => row?.options?.[idx]).filter((label) => label !== undefined)
      await markResolved(row?.pushedTo ?? [], `✅ 已作答：${answers.join('、')}（来源 ${outcome?.via ?? 'unknown'}）`)
      results.push({ question: String(question.question ?? ''), answered: true, answers, via: outcome?.via })
    }
    return { ok: true, answered: allAnswered, results }
  }

  function dispose() {
    disposed = true
    try { disposeCardAction?.() } catch { }
    try { disposeMessage?.() } catch { /* 反注册失败不致命 */ }
    disposeCardAction = null
    disposeMessage = null
    escalation.dispose()
  }

  return { askQuestions, decide, decideTrusted, adminPending, adminSettle, pendingAgentIds, attach, dispose, handleCardAction }
}

/** 校验并归一 ask_user 工具参数；违规返回 { ok:false, reason }。 */
export function validateAskArgs(rawArgs, { minTimeoutMs = 30_000, maxTimeoutMs = 30 * 60_000, defaultTimeoutMs = 300_000 } = {}) {
  const args = rawArgs ?? {}
  const questionsRaw = Array.isArray(args.questions) ? args.questions : null
  if (questionsRaw === null || questionsRaw.length === 0 || questionsRaw.length > 4) {
    return { ok: false, reason: 'questions 必须是 1 到 4 个问题的数组' }
  }
  const questions = []
  for (const item of questionsRaw) {
    const question = String(item?.question ?? '').trim()
    if (question === '' || question.length > 600) {
      return { ok: false, reason: '每个问题的 question 必须是 1-600 字符' }
    }
    const optionsRaw = Array.isArray(item?.options) ? item.options : null
    if (optionsRaw === null || optionsRaw.length < 2 || optionsRaw.length > 5) {
      return { ok: false, reason: `问题「${question.slice(0, 20)}」的 options 必须是 2 到 5 项` }
    }
    const options = []
    for (const option of optionsRaw) {
      const label = String(option?.label ?? '').trim()
      if (label === '' || label.length > 60) {
        return { ok: false, reason: `问题「${question.slice(0, 20)}」的选项 label 必须是 1-60 字符` }
      }
      options.push({ label })
    }
    questions.push({ question, options, multiSelect: item?.multiSelect === true })
  }
  const timeoutRaw = Number(args.timeoutMs)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(maxTimeoutMs, Math.max(minTimeoutMs, Math.trunc(timeoutRaw)))
    : defaultTimeoutMs
  const context = String(args.context ?? '').slice(0, 300)
  return { ok: true, questions, timeoutMs, context }
}

/**
 * 注册 ask_user 工具（v0.8 远程提问）。
 * @param ctx - cordis 上下文（ctx.tools；宿主没有 tools 服务时静默跳过）
 * @param {ReturnType<typeof createQuestionBridge>} bridge
 * @param {{ rateLimitPerMinute?: number, defaultTimeoutMs?: number }} [options]
 */
export function registerAskUserTool(ctx, bridge, options = {}) {
  if (ctx?.tools?.register === undefined) {
    // 宿主没有 tools 服务时静默跳过工具注册，绝不弄崩启动（与 notify 工具同规矩）
    return null
  }
  const limiter = createRateLimiter({ limitPerMinute: options.rateLimitPerMinute ?? 6 })
  return ctx.tools.register({
    name: 'ask_user',
    description: '向用户提出选择题并等待作答（推送到用户手机：飞书选项卡片 / Telegram 按钮 / 其他渠道回复编号）。适合方案抉择、环境选择等需要用户拍板的分叉决策；用户装了 dsh-notifier 手机桥接时优先用本工具而不是 ask_user_question。超时不会代答——用户未作答时返回 answered=false，请改用桌面确认或调整方案继续。',
    parameters: compileParameters({
      questions: {
        type: 'array',
        required: true,
        description: '1-4 个问题，每项 { question: 问题正文, options: [{ label: 选项 }](2-5 项), multiSelect?: 是否多选（默认 false） }',
      },
      timeoutMs: { type: 'number', description: '作答时限毫秒（默认 300000，范围 30s-30min）；超时不代答' },
      context: { type: 'string', description: '为什么问（卡片引言，可选，300 字内）' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          answered: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.rateLimited === true) {
          return [{ type: 'text', text: `已限流：ask_user 每分钟调用已达上限（${value.rateLimit ?? ''} 次/分钟）。请稍后再试，或改用一次提问合并多个问题。` }]
        }
        if (value.ok !== true) {
          return [{ type: 'text', text: `提问未发出：${value.reason ?? '参数无效'}。请检查 questions 结构（1-4 问，每问 2-5 个选项）。` }]
        }
        if (value.answered !== true) {
          const lines = (value.results ?? []).map((item, idx) =>
            `${idx + 1}. ${item.question} → ${item.answered === true ? `已答：${(item.answers ?? []).join('、')}` : '未作答'}`)
          return [{ type: 'text', text: `用户未在时限内完成全部作答（超时不代答）：\n${lines.join('\n')}\n请改用桌面确认、缩小问题范围，或基于默认方案继续并说明假设。` }]
        }
        const lines = (value.results ?? []).map((item, idx) =>
          `${idx + 1}. ${item.question} → ${(item.answers ?? []).join('、')}`)
        return [{ type: 'text', text: `用户已作答：\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs, execContext) {
      if (!limiter.allow()) {
        return { ok: false, rateLimited: true, rateLimit: limiter.limit, answered: false, results: [] }
      }
      const validated = validateAskArgs(rawArgs, { defaultTimeoutMs: options.defaultTimeoutMs })
      if (!validated.ok) {
        return { ok: false, answered: false, results: [], reason: validated.reason }
      }
      try {
        return await bridge.askQuestions(validated, execContext)
      } catch (error) {
        return { ok: false, answered: false, results: [], reason: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
