// dsh-notifier approval/router.mjs
// approval/request 瀑布流处理器（远程审批，阶段 4 核心）。
// 宿主事实（已核对 user-approval 源码）：ApprovalRequest = { agent, toolName, callId?, reason?, signal? }
// ——没有 id 字段，审批 id 由 service 内部签发。因此本模块自行铸 key：
//   key = ap:<callId ?? toolName>:<单调计数>，并把 agent/session 一起入账。
// 安全红线：
//  - 静默永不批准：超时/无响应/解析失败/异常一律 return next() 交还桌面
//  - 一次点击只授权一次操作：token 单次核销 + 账本状态机（首达采纳）
//  - A listener never throws：整个 handler 包 try/catch，任何异常退回 next()
//  - observe 模式只旁观：推完卡片立即 next()，桌面照常决定

import { createEscalationChain } from './escalation.mjs'
import { normalizeInbound, parseApprovalAction } from '../inbound/_contract.mjs'
import { guardTargets } from '../inbound/target-guard.mjs'
import { createInteractionLedger } from '../interaction/ledger.mjs'
import { workspaceOf } from '../routing/session-registry.mjs'
// 维护批 6 前置：跨渠道能力矩阵作为单一事实来源
import { displayNameOf } from '../inbound/capability-matrix.mjs'

const OUTCOME_ALLOWED = 'allowed-once'
const OUTCOME_REJECTED = 'rejected'
const INTERACTIVE_ALIASES = Object.freeze({ 'qq-bot': 'qq' })

// 通道名 → 用户可读名（广播文案用；统一从 capability-matrix.mjs 读取，单一事实来源）
const DISPLAY_NAMES = {
  get telegram() { return displayNameOf('telegram') },
  get feishu() { return displayNameOf('feishu') },
  get qq() { return displayNameOf('qq') },
  get wxpusher() { return displayNameOf('wxpusher') },
  get wechat() { return displayNameOf('wechat') },
  get dingtalk() { return displayNameOf('dingtalk') },
}

// 升级链默认节奏：30s / 60s 各再提醒一轮（timeoutMs 默认 120s 内完成两轮升级）
const DEFAULT_ESCALATION_STAGES = [
  { afterMs: 30_000, level: 'timeSensitive', note: '第 1 次升级提醒' },
  { afterMs: 60_000, level: 'timeSensitive', note: '第 2 次升级提醒' },
]

/**
 * 注册 approval/request 处理器。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（ctx.on）
 * @param {object} deps.notifier - createNotifier 实例（升级链推送用）
 * @param {ReturnType<typeof import('../inbound/bus.mjs').createInboundBus>} deps.bus
 * @param {ReturnType<typeof import('../inbound/tokens.mjs').createTokenVault>} deps.vault
 * @param {import('../inbound/store.mjs').store} deps.store - pending 账本持久化
 * @param {object} deps.telegram - （旧入口，v0.2.0 兼容）createTelegramInbound 实例；可为 null
 * @param {object[]} [deps.interactive] - 交互渠道实例列表（v0.3.0 多通道入口；提供时优先于 deps.telegram）。
 *   每项实现统一契约（channel/notifyTargets/sendApprovalCard/editResolved/sendText，
 *   见 inbound/_contract.mjs）；telegram 旧形状（notifyChatIds/editResolved(chatId,messageId,text)）也接受
 * @param {{ mode?: 'observe'|'answer', timeoutMs?: number, numberedReply?: boolean,
 *           escalation?: { enabled?: boolean, stages?: Array<object> } }} [deps.approvalConfig]
 * @param {object} [deps.logger]
 * @param {number} [deps.counterStart=随机] - 审批 key 计数器起点。生产随机化（v0.6.4：
 *   重启后 counter 归零 + 同 callId 复现会让旧卡片 token 撞新审批的 key，在 tokenSecret
 *   持久化 + 10min TTL 内可被旧卡误裁决——随机起点把撞 key 概率压到 1e-6 级）；测试传 0
 *   保住 `ap:<callId>:<n>` 的确定性断言。
 * @param {ReturnType<typeof import('../routing/agent-router.mjs').createAgentRouter>} [deps.router]
 *   - v0.3.2 审批分流：request.agent 可解析时，审批只发该 agent 绑定的通道（替代全局广播）。
 *     审批不受 quiet 影响——静音审批 = 审批永远超时回落桌面，违背「沉默永不批准」的可预期性。
 * @returns {() => void} 反注册函数
 */
export function registerApprovalHandler(deps) {
  const { ctx, notifier, bus, vault, store, identity } = deps
  const router = deps.router ?? null
  const approvalConfig = deps.approvalConfig ?? {}
  const mode = approvalConfig.mode === 'answer' ? 'answer' : 'observe'
  const timeoutMs = Math.max(1000, Number(approvalConfig.timeoutMs) || 120000)
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/approval]', message) } catch { /* 日志失败绝不致命 */ }
  }

  // 升级链：主推送无人响应时按 stages 节奏再提醒（answer 模式下与 wait 并行）
  const escalationCfg = (approvalConfig.escalation !== null && typeof approvalConfig.escalation === 'object')
    ? approvalConfig.escalation
    : {}
  const escalationStages = Array.isArray(escalationCfg.stages) && escalationCfg.stages.length > 0
    ? escalationCfg.stages
    : DEFAULT_ESCALATION_STAGES
  const escalation = createEscalationChain({
    stages: escalationCfg.enabled === false ? [] : escalationStages,
    logger: deps.logger,
  })

  let counter = Number.isFinite(deps.counterStart) ? deps.counterStart : Math.floor(Math.random() * 1_000_000)
  // 交互渠道列表（统一契约）：deps.interactive 优先；未提供时回退 v0.2.0 的单 telegram 入口
  const rawInteractive = Array.isArray(deps.interactive)
    ? deps.interactive
    : (deps.telegram !== null && deps.telegram !== undefined ? [deps.telegram] : [])
  const interactive = rawInteractive
    .map((raw) => normalizeInbound(raw))
    .filter((entry) => entry !== null && entry.channel !== '')
  const interactiveByChannel = new Map(interactive.map((entry) => [entry.channel, entry]))
  // v0.6.4：交互渠道名集合（编号回复 intended 兜底用——真实装配里能回话到 bus 的
  // 通道必然在此集合内，广播也必然覆盖它们）
  const interactiveChannels = new Set(interactive.map((entry) => entry.channel))
  // C2（P1-5）：本 router 实例中仍有存活 waiter 的审批 key 集合。
  // 崩溃/写盘失败会留下 status=pending 但 waiter 已死的僵尸行；latestPendingFor
  // 只放行 liveWaiters 中仍存在的 key，防止僵尸行吞掉后续编号回复并误导回执。
  const liveWaiters = new Set()
  // 升级提醒里的按钮渠道提示（无交互渠道时退化为纯编号回复话术）
  const cardChannelNames = interactive
    .map((entry) => DISPLAY_NAMES[entry.channel] ?? entry.channel)
    .join('/')

  // Interaction Core：ap: 行统一状态机（pending→resolved，decision 终态裁决）。
  // latestPendingFor 归属/兜底启发式（exact/onChannel/intended + liveWaiters 僵尸过滤）
  // 是审批特有语义，保留在链内——核心只提供原子账本操作（见 interaction/ledger.mjs）。
  const core = createInteractionLedger({ keyPrefix: 'ap:', store })
  /**
   * 最近一条待决审批（编号回复降级用）。匹配优先级：
   *  1) 精确：卡片实际送达过该 (channel,userId)；
   *  2) 同渠道：卡片送达过该 channel（他人代决兜底）；
   *  3) v0.6.4 intended 兜底：该 channel 属于本审批的意图送达渠道（分流解析结果；
   *     全局广播时 = 全部交互渠道）——堵住「卡片发送失败但广播文案教用户回复 1」的死路
   *     （审查 R1-P2-1）。注意 intended 只做 channel 级（广播无用户定向），跨渠道的
   *     非意图渠道（如分流只发 feishu 时 telegram 的日常裸 1）仍拒绝——收紧价值保留。
   * CRACK-003：返回值带 evidence（exact|onChannel|intended）——编号回复归属闸据此区分
   * 「卡片发本人」与「同渠道他人卡片/广播兜底」，后者仅 owner 可代决（fail-closed）。
   */
  const deliveryTargets = (row) => [
    ...(Array.isArray(row?.pushedTo) ? row.pushedTo : []),
    ...(Array.isArray(row?.hintTargets) ? row.hintTargets : []),
  ]

  const latestPendingFor = (channel, userId, accountId = undefined) => {
    let exact = null
    let onChannel = null
    let intended = null
    for (const key of core.scanKeys()) {
      const row = core.get(key)
      // C2（P1-5）：无存活 waiter 的 pending 行不参与编号回复匹配。
      // 进程崩溃、重启或 ledger.resolve 写盘失败会留下 pending 僵尸行；跳过它们
      // 让后续真实待决审批仍有机会被裁决，也避免「已被处理」误导回执。
      if (!core.isPending(row) || !liveWaiters.has(key)) continue
      const pushed = deliveryTargets(row)
      const accountMatches = (target) => target.accountId === undefined || String(target.accountId) === String(accountId ?? '')
      if (pushed.some((target) => target.channel === channel && accountMatches(target))) {
        if (onChannel === null || row.createdAt > onChannel.row.createdAt) onChannel = { key, row, evidence: 'onChannel' }
        if (pushed.some((target) => target.channel === channel && accountMatches(target) && String(target.userId) === String(userId))) {
          if (exact === null || row.createdAt > exact.row.createdAt) exact = { key, row, evidence: 'exact' }
        }
      }
      if (intended === null && isIntendedChannel(row, channel)) intended = { key, row, evidence: 'intended' }
    }
    return exact ?? onChannel ?? intended
  }
  // 核心账本 + 审批专用归属启发式合成同一 ledger 面（其余调用点零改动）。
  const ledger = { ...core, latestPendingFor }

  if (deps.control !== null && deps.control !== undefined) {
    deps.control.register('approval', {
      getPending: (input) => ledger.get(input.approvalKey ?? input.key),
      buildEvent: (input, row, policy, now) => {
        const channel = String(input.channel ?? String(input.via ?? '').split(':')[0] ?? '')
        const chatId = String(input.chatId ?? '')
        const candidates = String(input.via ?? '').endsWith(':button')
          ? (Array.isArray(row.pushedTo) ? row.pushedTo : [])
          : deliveryTargets(row)
        const exact = candidates.find((target) => String(target.channel) === channel && String(target.chatId) === chatId && (target.accountId === undefined || String(target.accountId) === String(input.accountId ?? '')))
        return {
          eventId: input.eventId,
          sessionId: String(row.agentId ?? input.approvalKey ?? input.key), source: 'mobile', channel,
          accountId: String(exact?.accountId ?? input.accountId ?? ''), userId: String(exact?.userId ?? input.userId ?? ''), chatId,
          policyVersion: String(row.policyVersion ?? policy.policyVersion ?? '1'), command: 'approval',
          chatType: input.chatType, createdAt: Number(row.createdAt ?? now - 1),
          expiresAt: Number(row.expiresAt ?? now + timeoutMs),
        }
      },
      authorize: (input, row, event) => {
        const candidates = String(input.via ?? '').endsWith(':button')
          ? (Array.isArray(row.pushedTo) ? row.pushedTo : [])
          : deliveryTargets(row)
        const exact = candidates.some((target) => (
          String(target.channel) === event.channel
          && String(target.chatId) === event.chatId
          && (target.accountId === undefined || String(target.accountId) === event.accountId)
          && (target.userId === undefined || String(target.userId) === event.userId)
        ))
        if (input.trusted !== true) return exact
        return exact || isAuthorizedDecider(identity, event.channel, event.userId)
      },
      settle: (input) => input.trusted === true
        ? bus.decideTrusted({ approvalKey: input.approvalKey ?? input.key, decision: input.decision, via: input.via, userId: input.userId })
        : bus.decide({ approvalKey: input.approvalKey ?? input.key, decision: input.decision, token: input.token, via: input.via, userId: input.userId, chatId: input.chatId }),
    })
  }

  /** v0.6.4：row 的意图渠道判定——intended 数组含该渠道，或 null（全局广播）时任意交互渠道。 */
  function isIntendedChannel(row, channel) {
    if (Array.isArray(row.intendedChannels)) return row.intendedChannels.includes(channel)
    if (row.intendedChannels === null) return interactiveChannels.has(channel)
    return false // 旧版行无此字段：不兜底（从严，升级瞬间的在途审批最多超时回退）
  }

  /**
   * v0.3.2 审批分流：request.agent 有 id 时按 agent 解析链算目标通道集合。
   * 返回 null = 不分流（全局广播，向后兼容）；解析异常同样回落 null。
   */
  function resolveApprovalChannels(request) {
    if (router === null) return null
    const agentId = request?.agent?.id ?? request?.agent?.session?.id ?? null
    if (agentId === null) return null
    try {
      const globalTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
      const { channelTypes } = router.resolveOutbound(String(agentId), workspaceOf(request.agent), globalTypes)
      if (!Array.isArray(channelTypes)) return channelTypes
      const merged = new Set(channelTypes)
      for (const type of channelTypes) {
        const alias = INTERACTIVE_ALIASES[String(type)]
        if (alias !== undefined) merged.add(alias)
      }
      return [...merged]
    } catch (error) {
      // P1-2 错误可见性（2026-08-20，Trae1）：路由解析异常与「空集」同样回落全局广播
      // （fail-safe 投递语义不变），但异常路径原先零日志——同函数的空集回落自 v0.6.5
      // 起就有 warn，异常反而静默，路由子系统坏了会无声地把审批卡广播到全渠道。
      warn(`审批分流解析异常，回落全局广播（路由引擎报错: ${error instanceof Error ? error.message : String(error)}）`)
      return null
    }
  }

  /**
   * v0.8.3 SEC-1：规划本次审批的卡片目标（与推送共用同一份结果，避免 wait 的
   * allowChats 与 pushApproval 各自解析导致的不一致）。返回 Map<channel, kept[]>。
   */
  function planApprovalTargets(channelTypes) {
    const targets = new Map()
    for (const inbound of interactive) {
      if (channelTypes !== null && !channelTypes.includes(inbound.channel)) continue
      // v0.7 形状守卫（计划书 §3.5）：目标进发送前按渠道校验 id 形态——TG 数字 id 混进
      // 飞书目标位这类跨渠道串门在此拦截（warn + skip，不中断其余目标）。
      const { kept, skipped } = guardTargets(inbound.channel, inbound.notifyTargets(), warn)
      if (skipped.length > 0) warn(`形状守卫跳过 ${skipped.length} 个目标（${inbound.channel}）`)
      targets.set(inbound.channel, kept)
    }
    return targets
  }

  async function pushApproval(key, token, request, channelTypes, targetsByChannel) {
    const title = `需要批准：${request.toolName}`
    const content = `${request.reason ?? 'agent 请求执行一个需要授权的操作'}\n\n批准将仅对本次调用生效（token 单次核销）。`
    const pushedTo = []
    const hintTargets = []
    const buttonChannels = []
    const textChannels = []
    // 交互渠道：带按钮卡片（逐通道逐目标推送；单渠道失败降级为纯通知）。
    // v0.3.2 分流：channelTypes 非空时只推解析出的通道（审批不广播到无关 agent 的通道）。
    // v0.6.4 增量落账（审查 R1-P1-1）：pushedTo 原来要等整轮推送（多通道限速门下数秒）
    // 完成才写账——窗口内早到的编号回复读不到送达渠道，裁决落空且裸「1」漏进会话
    // 路由。现在每张卡送达立刻落账，窗口收敛到单卡发送耗时。
    const persistPushed = () => {
      try {
        const row = ledger.get(key)
        if (row !== undefined) store.set(key, { ...row, pushedTo: [...pushedTo], hintTargets: [...hintTargets] })
      } catch { /* 增量落账失败不致命，末尾还有一次整体落账兜底 */ }
    }
    const fallbackText = `${title}\n${content}\n\n回复 1 批准 / 2 拒绝`
    for (const [channel, kept] of targetsByChannel) {
      const inbound = interactiveByChannel.get(channel)
      if (inbound === undefined) continue
      let anySuccess = false
      for (const target of kept) {
        const card = await inbound.sendApprovalCard({
          chatId: target.chatId,
          title,
          content,
          approvalKey: key,
          token,
        })
        // Provider-level group downgrade is deliberately not delivery evidence:
        // no native button exists and the target must not become a pushedTo
        // authorization source. A downgraded result also suppresses the
        // generic numbered-text fallback, which would otherwise leak context.
        if (card !== null && card?.downgraded !== true) {
          anySuccess = true
          pushedTo.push({ channel, ...(inbound.accountId === undefined ? {} : { accountId: String(inbound.accountId ?? '') }), chatId: target.chatId, userId: target.userId, messageId: card.messageId })
          persistPushed()
        } else if (card?.downgraded !== true && await inbound.sendText(target.chatId, fallbackText)) {
          // Native renderer failure gets a direct per-chat text fallback. This target is
          // authorization evidence; channel-level notifier broadcasts are never evidence.
          hintTargets.push({ channel, ...(inbound.accountId === undefined ? {} : { accountId: String(inbound.accountId ?? '') }), chatId: target.chatId, userId: target.userId })
          persistPushed()
        }
      }
      if (anySuccess) {
        const name = DISPLAY_NAMES[channel] ?? channel
        if (inbound.capabilities?.buttons !== false) buttonChannels.push(name)
        else textChannels.push(name)
      }
    }
    // 全渠道通知（含单向渠道；无按钮渠道靠编号回复降级）。原生卡失败时已先尝试
    // 直接 sendText 到同一 chat，并将成功目标写入 hintTargets；广播本身不提供授权证据。
    // 按钮渠道提示可点；无按钮渠道提示编号回复——单向广播渠道（bark 等）同样
    // 依赖「回复 1 批准 / 2 拒绝」兜底，因此按钮场景也保留该提示（v0.2.0 文案契约）。
    const channelNotes = []
    if (buttonChannels.length > 0) channelNotes.push(`${buttonChannels.join('、')} 已发可点按钮`)
    if (textChannels.length > 0) channelNotes.push(`${textChannels.join('、')} 已发审批通知`)
    const outbound = new Set(Array.isArray(notifier?.channels) ? notifier.channels : [])
    const carded = new Set(pushedTo.map((target) => String(target.channel)))
    const broadcastTypes = channelTypes === null
      ? null
      : channelTypes.filter((type) => {
        const alias = INTERACTIVE_ALIASES[String(type)]
        return alias === undefined || !carded.has(alias)
      }).filter((type) => outbound.size === 0 || outbound.has(type))
    if (broadcastTypes !== null && broadcastTypes.length === 0) return { pushedTo, hintTargets }
    await notifier.notifyAll({
      title,
      content: channelNotes.length > 0
        ? `${content}\n\n（${channelNotes.join('；')}；无按钮渠道可回复 1 批准 / 2 拒绝）`
        : `${content}\n\n（本渠道无按钮：回复 1 批准 / 2 拒绝）`,
      level: 'timeSensitive',
    }, broadcastTypes !== null ? { channelTypes: broadcastTypes } : {}).catch(() => {})
    return { pushedTo, hintTargets }
  }

  async function markRemoteResolved(pushedTo, text) {
    for (const target of pushedTo ?? []) {
      const inbound = interactiveByChannel.get(target.channel)
      if (inbound === undefined) continue
      await inbound.editTarget(target, text)
    }
  }

  // Explicit button action path. The payload is bound to its original key and
  // token; no "latest pending" heuristic is used, including for group chats.
  function handleApprovalAction(envelope) {
    let action = envelope?.approvalAction
    if (action === null || action === undefined) {
      const text = String(envelope?.text ?? '').trim()
      if (!text.startsWith('ap:')) return false
      const parsed = parseApprovalAction(text)
      if (parsed === null) return false
      action = parsed
    }
    if (action === null || typeof action !== 'object') return false
    const key = String(action.approvalKey ?? '')
    const decision = action.decision === OUTCOME_ALLOWED || action.decision === OUTCOME_REJECTED ? action.decision : null
    if (key === '' || decision === null) return false
    const row = ledger.get(key)
    const reply = (message) => {
      const inbound = interactiveByChannel.get(envelope.channel)
      if (inbound !== undefined) void inbound.sendText(envelope.chatId, message).catch(() => {})
    }
    if (row === undefined || row.status !== 'pending') {
      reply('该审批已被处理或已失效，此次点击无效')
      return true
    }
    const targets = (Array.isArray(row.pushedTo) ? row.pushedTo : []).filter((target) => String(target.channel) === String(envelope.channel) && (target.accountId === undefined || String(target.accountId) === String(envelope.accountId ?? '')))
    if (targets.length > 0 && !targets.some((target) => String(target.userId) === String(envelope.userId))) {
      reply('仅审批接收人可点击裁决')
      return true
    }
    // v0.8.7：accountId 缺失时不得用 channel 名伪造——fail-closed 交还桌面。
    // 旧客户端回调可能不含 accountId，此时无法证明来源账号，不能放行。
    if (envelope.accountId === undefined || envelope.accountId === null || String(envelope.accountId) === '') {
      reply('审批回调缺少账号来源，无法裁决（请升级客户端）')
      return true
    }
    const verdict = deps.control !== null && deps.control !== undefined
      ? deps.control.handle({
        eventId: String(envelope.messageId ?? ''), command: 'approval', approvalKey: key, decision,
        token: typeof action.token === 'string' ? action.token : undefined,
        via: `${envelope.channel}:button`, channel: envelope.channel,
        accountId: String(envelope.accountId), userId: envelope.userId,
        chatId: envelope.chatId, chatType: envelope.chatType,
      })
      : { ok: false, message: 'Control Core 未接线，审批不可用' }
    if (!(verdict.ok === true || verdict.status === 'accepted')) reply(verdict.message ?? '该审批已被处理或已失效，此次点击无效')
    return true
  }

  const disposeApprovalAction = bus.onMessage(handleApprovalAction)

  // 编号回复降级（无按钮渠道）：白名单用户回复 1/2 核销最近一条待决审批。
  // v0.6.3 返回 true = 消息已被审批消费——bus 据此停止扇出，同一消息不再进对话路由
  // （原实现「1」既批准审批又被当作用户消息 inject 进 agent 会话，消息污染）。
  function handleNumberedReply(envelope) {
    if (approvalConfig.numberedReply === false) return false
    const choice = String(envelope.text ?? '').trim()
    if (choice !== '1' && choice !== '2') return false
    const pending = ledger.latestPendingFor(envelope.channel, envelope.userId, envelope.accountId)
    if (pending === null) return false
    // CRACK-003 归属闸：exact（卡片发本人）直接放行；onChannel/intended 属他人卡片或
    // 广播兜底——仅 owner 可代决。identity 缺失/异常一律 fail-closed 拒绝。
    const allowed = pending.evidence === 'exact' || isAuthorizedDecider(identity, envelope.channel, envelope.userId)
    if (!allowed) {
      warn(`编号回复归属拒绝 ${pending.key}（evidence=${pending.evidence}，user ${envelope.userId} 非 owner）`)
      const inbound = interactiveByChannel.get(envelope.channel)
      if (inbound !== undefined) {
        void inbound.sendText(envelope.chatId, '此审批不是发给你的(无权裁决)').catch(() => {})
      }
      return true
    }
    const decision = choice === '1' ? OUTCOME_ALLOWED : OUTCOME_REJECTED
    // v0.8.7：编号回复同样要求 accountId 来源——缺失时 fail-closed。
    if (envelope.accountId === undefined || envelope.accountId === null || String(envelope.accountId) === '') {
      const inbound = interactiveByChannel.get(envelope.channel)
      if (inbound !== undefined) void inbound.sendText(envelope.chatId, '审批回复缺少账号来源，无法裁决').catch(() => {})
      return true
    }
    const verdict = deps.control !== null && deps.control !== undefined
      ? deps.control.handle({ eventId: String(envelope.messageId ?? ''), command: 'approval', approvalKey: pending.key, channel: envelope.channel, accountId: String(envelope.accountId), chatId: envelope.chatId, chatType: envelope.chatType, userId: envelope.userId, via: `${envelope.channel}:reply`, decision, trusted: true })
      : { ok: false, message: 'Control Core 未接线，审批不可用' }
    if (verdict.ok === true || verdict.status === 'accepted') {
      warn(`编号回复裁决 ${pending.key} → ${decision}（user ${envelope.userId}）`)
      return true
    }
    // v0.8.3 E-2：已决竞态（首达采纳/超时已 settle，账本暂未翻终态）——消费 + 回执，
    // 不把裸 '1'/'2' 漏进对话路由（对齐 questions/router.mjs:316-318 既有姿态）。
    const inbound = interactiveByChannel.get(envelope.channel)
    if (inbound !== undefined) {
      void inbound.sendText(envelope.chatId, '该审批已被处理（首达采纳，此次回复无效）').catch(() => {})
    }
    warn(`编号回复落空 ${pending.key}（已决竞态，user ${envelope.userId}）`)
    return true
  }

  const disposeMessage = bus.onMessage(handleNumberedReply)

  /** CRACK-003：编号回复代决资格——仅该渠道绑定的 owner 可代决他人卡片；identity 缺失/异常 fail-closed。 */
  function isAuthorizedDecider(identity, channel, userId) {
    if (!identity) return false
    try { return identity.list(channel).some((r) => String(r.userId) === String(userId) && r.role === 'owner') } catch { return false }
  }

  const handler = async (request, next) => {
    const key = `ap:${request?.callId ?? request?.toolName ?? 'unknown'}:${(counter += 1)}`
    try {
      const token = vault.mint(key)
      // 分流一次解析、全程复用（v0.6.4：pushApproval 落账与升级链共用同一份结果，
      // 原二处各自 resolve 在 agent 绑定轮转瞬间可能不一致）。
      const resolved = resolveApprovalChannels(request)
      // v0.6.5（审查 R4-1-P3-5）：空集回落全局广播——agent 显式绑定空集或绑定渠道
      // 全被全局池剔除时，原实现零卡零广播，审批 120s 无感知超时（安全侧自洽但用户
      // 完全不知道为何「卡死」）。intendedChannels 同步记 null，与实际广播语义一致。
      const channelTypes = Array.isArray(resolved) && resolved.length > 0 ? resolved : null
      if (channelTypes === null && resolved !== null) {
        warn('审批分流解析为空集，回落全局广播（检查该 agent 的路由绑定与全局渠道池）')
      }
      ledger.add(key, {
        mode,
        toolName: request?.toolName ?? '(unknown)',
        agentId: request?.agent?.id ?? request?.agent?.session?.id ?? null,
        pushedTo: [],
        // v0.6.4（审查 R1-P2-1）：意图渠道入账——null = 全局广播（= 全部交互渠道），
        // 数组 = 分流结果。编号回复 intended 兜底据此判定「广播教了回复 1 但卡片没送达」。
        intendedChannels: channelTypes,
        expiresAt: Date.now() + timeoutMs,
      })
      // v0.6.3 waiter 预注册（审查 R2 P1-1）：原实现先 await pushApproval（逐通道逐目标
      // 发卡 + 广播，限速门下数秒级）再 bus.wait——窗口内用户点按钮/回复 1/2 会命中
      // already-resolved 被静默丢弃，此后永远无人能裁决 → 超时回落桌面。先注册 waiter
      // 再推卡，早到的裁决由 waiter 承接（超时计时从推卡开始，含推送耗时，语义可接受）。
      // v0.8.3 SEC-1：wait 同时登记允许会话范围（allowChats），bus.decide 据此校验按钮来源。
      const targetsByChannel = planApprovalTargets(channelTypes)
      const allowChats = new Map()
      for (const [channel, kept] of targetsByChannel) {
        if (kept.length === 0) continue
        allowChats.set(channel, new Set(kept.map((target) => String(target.chatId))))
      }
      const waitOptions = {
        agentId: request?.agent?.id ?? request?.agent?.session?.id ?? null,
        onAbandon: () => { try { ledger.terminate(key) } catch { } },
        allowChats,
      }
      const decisionPromise = mode === 'answer'
        ? Promise.resolve().then(() => bus.wait(key, timeoutMs, waitOptions)).catch((error) => {
          warn(`远程审批等待异常，按超时交还桌面: ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        : null
      if (decisionPromise !== null) {
        liveWaiters.add(key)
        decisionPromise.then(
          () => { liveWaiters.delete(key) },
          () => { liveWaiters.delete(key) },
        )
      }
      const delivery = await pushApproval(key, token, request, channelTypes, targetsByChannel)
      const pushedTo = delivery.pushedTo
      const row = ledger.get(key)
      if (row !== undefined && row.status === 'pending') {
        store.set(key, { ...row, pushedTo, hintTargets: delivery.hintTargets })
      }
      if (ledger.get(key)?.decision === 'terminated') {
        await markRemoteResolved(pushedTo, '⏹ 已终止：agent 会话已结束，审批取消')
        return next()
      }

      if (mode !== 'answer') {
        return next() // observe：只旁观，桌面照常决定
      }

      // Explicit opt-in only. The default remains exclusive desktop-first
      // waiting; this branch never changes permissions or token semantics.
      if (approvalConfig.parallel === true) {
        const desktopAsk = Promise.resolve().then(() => next())
        desktopAsk.catch(() => {})
        const race = await new Promise((resolve) => {
          let settled = false
          const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
          decisionPromise.then((decision) => {
            if (decision !== null) finish({ kind: 'remote', decision })
            else {
              ledger.resolve(key, ledger.get(key)?.decision === 'terminated' ? 'terminated' : 'timeout')
              void markRemoteResolved(pushedTo, '⏱ 手机端等待结束：请到桌面处理（按钮已失效）').catch(() => {})
            }
          }).catch(() => {})
          desktopAsk.then((result) => finish({ kind: 'desktop', result }), () => finish({ kind: 'desktop', result: undefined }))
        })
        if (race.kind === 'remote') {
          ledger.resolve(key, race.decision.decision)
          await markRemoteResolved(pushedTo, race.decision.decision === OUTCOME_ALLOWED ? '✅ 已远程批准（本次）' : '❌ 已远程拒绝')
          return race.decision.decision
        }
        try { bus.abandon?.(key, 'desktop-first') } catch { }
        try { ledger.terminate(key) } catch { }
        await markRemoteResolved(pushedTo, '🖥️ 已在桌面处理（手机按钮已失效）')
        return race.result
      }

      // 升级链与 wait 并行：每到一个 stage 再推一轮更高 level 提醒
      const startedAt = Date.now()
      escalation.start(key, (_key, stage) => {
        notifier.notifyAll({
          title: `${request?.toolName ?? '操作'} 仍在等待批准`,
          content: `${stage.note ?? '仍在等待批准'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）。\n回复 1 批准 / 2 拒绝${cardChannelNames !== '' ? `，或点击 ${cardChannelNames} 卡片按钮` : ''}。`,
          level: stage.level ?? 'timeSensitive',
        }, channelTypes !== null ? { channelTypes } : {}).catch(() => {})
      })

      const decision = await decisionPromise
      escalation.stop(key)
      if (ledger.get(key)?.decision === 'terminated') {
        await markRemoteResolved(pushedTo, '⏹ 已终止：agent 会话已结束，审批取消')
        return next()
      }
      if (decision === null) {
        ledger.resolve(key, 'timeout')
        await markRemoteResolved(pushedTo, '⏱ 超时未响应：已交还桌面处理（按钮失效）')
        return next() // 静默永不批准
      }
      ledger.resolve(key, decision.decision)
      await markRemoteResolved(pushedTo, decision.decision === OUTCOME_ALLOWED ? '✅ 已远程批准（本次）' : '❌ 已远程拒绝')
      warn(`${key} 裁决：${decision.decision}（via ${decision.via}）`)
      return decision.decision
    } catch (error) {
      // A listener never throws：任何异常交还桌面
      warn(`处理器异常，交还桌面: ${error instanceof Error ? error.message : String(error)}`)
      try { escalation.stop(key) } catch { /* 升级链清理不致命 */ }
      try { ledger.resolve(key, 'error') } catch { /* 账本失败不致命 */ }
      return next()
    }
  }

  const disposeApproval = ctx.on('approval/request', handler)
  return () => {
    disposeApproval?.()
    disposeApprovalAction?.()
    disposeMessage?.()
    escalation.dispose()
  }
}
