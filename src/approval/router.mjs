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
import { normalizeInbound } from '../inbound/_contract.mjs'

const OUTCOME_ALLOWED = 'allowed-once'
const OUTCOME_REJECTED = 'rejected'

// 通道名 → 用户可读名（广播文案用；telegram 显示名保持 v0.2.0 原样，测试契约不破）
const DISPLAY_NAMES = {
  telegram: 'Telegram',
  feishu: '飞书',
  qq: 'QQ',
  wxpusher: 'WxPusher',
  wechat: '微信',
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
 * @returns {() => void} 反注册函数
 */
export function registerApprovalHandler(deps) {
  const { ctx, notifier, bus, vault, store } = deps
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

  let counter = 0
  // 交互渠道列表（统一契约）：deps.interactive 优先；未提供时回退 v0.2.0 的单 telegram 入口
  const rawInteractive = Array.isArray(deps.interactive)
    ? deps.interactive
    : (deps.telegram !== null && deps.telegram !== undefined ? [deps.telegram] : [])
  const interactive = rawInteractive
    .map((raw) => normalizeInbound(raw))
    .filter((entry) => entry !== null && entry.channel !== '')
  const interactiveByChannel = new Map(interactive.map((entry) => [entry.channel, entry]))
  // 升级提醒里的按钮渠道提示（无交互渠道时退化为纯编号回复话术）
  const cardChannelNames = interactive
    .map((entry) => DISPLAY_NAMES[entry.channel] ?? entry.channel)
    .join('/')

  const ledger = {
    add(key, row) {
      store.set(key, { ...row, status: 'pending', createdAt: Date.now() })
    },
    get(key) {
      return store.get(key)
    },
    resolve(key, decision) {
      const row = store.get(key)
      if (row === undefined) return false
      store.set(key, { ...row, status: 'resolved', decision, resolvedAt: Date.now() })
      return true
    },
    /**
     * 最近一条待决审批（编号回复降级用）。优先取推给该 (channel,userId) 的；
     * 没有精确匹配时回退到全局最近一条（广播渠道没进 pushedTo，但信任已由
     * 白名单 + 去重建立，且首达采纳约束仍然生效）。
     */
    latestPendingFor(channel, userId) {
      let exact = null
      let any = null
      for (const key of store.keys('ap:')) {
        const row = store.get(key)
        if (row?.status !== 'pending') continue
        if (any === null || row.createdAt > any.row.createdAt) any = { key, row }
        if (row.pushedTo?.some((target) => target.channel === channel && String(target.userId) === String(userId))) {
          if (exact === null || row.createdAt > exact.row.createdAt) exact = { key, row }
        }
      }
      return exact ?? any
    },
  }

  async function pushApproval(key, token, request) {
    const title = `需要批准：${request.toolName}`
    const content = `${request.reason ?? 'agent 请求执行一个需要授权的操作'}\n\n批准将仅对本次调用生效（token 单次核销）。`
    const pushedTo = []
    const buttonChannels = []
    const textChannels = []
    // 交互渠道：带按钮卡片（逐通道逐目标推送；单渠道失败降级为纯通知）
    for (const inbound of interactive) {
      let anySuccess = false
      for (const target of inbound.notifyTargets()) {
        const card = await inbound.sendApprovalCard({
          chatId: target.chatId,
          title,
          content,
          approvalKey: key,
          token,
        })
        if (card !== null) {
          anySuccess = true
          pushedTo.push({ channel: inbound.channel, chatId: target.chatId, userId: target.userId, messageId: card.messageId })
        }
      }
      if (anySuccess) {
        const name = DISPLAY_NAMES[inbound.channel] ?? inbound.channel
        if (inbound.capabilities?.buttons !== false) buttonChannels.push(name)
        else textChannels.push(name)
      }
    }
    // 全渠道通知（含单向渠道；无按钮渠道靠编号回复降级）
    // 按钮渠道提示可点；无按钮渠道提示编号回复——单向广播渠道（bark 等）同样
    // 依赖「回复 1 批准 / 2 拒绝」兜底，因此按钮场景也保留该提示（v0.2.0 文案契约）。
    const channelNotes = []
    if (buttonChannels.length > 0) channelNotes.push(`${buttonChannels.join('、')} 已发可点按钮`)
    if (textChannels.length > 0) channelNotes.push(`${textChannels.join('、')} 已发审批通知`)
    await notifier.notifyAll({
      title,
      content: channelNotes.length > 0
        ? `${content}\n\n（${channelNotes.join('；')}；无按钮渠道可回复 1 批准 / 2 拒绝）`
        : `${content}\n\n（本渠道无按钮：回复 1 批准 / 2 拒绝）`,
      level: 'timeSensitive',
    }).catch(() => {})
    return pushedTo
  }

  async function markRemoteResolved(pushedTo, text) {
    for (const target of pushedTo ?? []) {
      const inbound = interactiveByChannel.get(target.channel)
      if (inbound === undefined) continue
      await inbound.editTarget(target, text)
    }
  }

  // 编号回复降级（无按钮渠道）：白名单用户回复 1/2 核销最近一条待决审批
  function handleNumberedReply(envelope) {
    if (approvalConfig.numberedReply === false) return
    const choice = String(envelope.text ?? '').trim()
    if (choice !== '1' && choice !== '2') return
    const pending = ledger.latestPendingFor(envelope.channel, envelope.userId)
    if (pending === null) return
    const decision = choice === '1' ? OUTCOME_ALLOWED : OUTCOME_REJECTED
    const verdict = bus.decideTrusted({
      approvalKey: pending.key,
      decision,
      via: `${envelope.channel}:reply`,
      userId: envelope.userId,
    })
    if (verdict.ok) {
      warn(`编号回复裁决 ${pending.key} → ${decision}（user ${envelope.userId}）`)
    }
  }

  const disposeMessage = bus.onMessage(handleNumberedReply)

  const handler = async (request, next) => {
    const key = `ap:${request?.callId ?? request?.toolName ?? 'unknown'}:${(counter += 1)}`
    try {
      const token = vault.mint(key)
      ledger.add(key, {
        toolName: request?.toolName ?? '(unknown)',
        agentId: request?.agent?.id ?? null,
        pushedTo: [],
      })
      const pushedTo = await pushApproval(key, token, request)
      const row = ledger.get(key)
      if (row !== undefined) store.set(key, { ...row, pushedTo })

      if (mode !== 'answer') {
        return next() // observe：只旁观，桌面照常决定
      }

      // 升级链与 wait 并行：每到一个 stage 再推一轮更高 level 提醒
      const startedAt = Date.now()
      escalation.start(key, (_key, stage) => {
        notifier.notifyAll({
          title: `${request?.toolName ?? '操作'} 仍在等待批准`,
          content: `${stage.note ?? '仍在等待批准'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）。\n回复 1 批准 / 2 拒绝${cardChannelNames !== '' ? `，或点击 ${cardChannelNames} 卡片按钮` : ''}。`,
          level: stage.level ?? 'timeSensitive',
        }).catch(() => {})
      })

      const decision = await bus.wait(key, timeoutMs)
      escalation.stop(key)
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
    disposeMessage?.()
    escalation.dispose()
  }
}
