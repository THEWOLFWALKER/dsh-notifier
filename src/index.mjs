// dsh-notifier index.mjs
// cordis 插件入口：组装配置解析、adapter 注册表、两条触发线（事件自动推送 + notify 工具）。
// 空配置绝不弄崩启动：任何渠道解析问题只 warn + 跳过（学 dsh-email）。

import { resolveConfig } from './config.mjs'
import { createNotifier } from './notify.mjs'
import { createEventListener } from './event-listener.mjs'
import { registerNotifyTool, registerNotifyTestTool } from './tool-register.mjs'
import { createLedger, yesterdayWindow } from './ledger.mjs'
// 阶段 4/5：inbound 回传栈（远程审批 + 会话路由）
import { createStore, defaultStateDir } from './inbound/store.mjs'
import { createTokenVault } from './inbound/tokens.mjs'
import { createInboundBus } from './inbound/bus.mjs'
import { createTelegramInbound } from './inbound/telegram-bot.mjs'
import { registerApprovalHandler } from './approval/router.mjs'
import { registerConversationRouter } from './inbound/conversation.mjs'

export const name = 'dsh-notifier'
export const inject = ['tools', 'agents']

/** 返回已解析配置（供测试与其它插件复用）。 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = ctx?.logger
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }

  if (!resolved.enabled) {
    warn('已禁用（enabled: false），不注册事件监听与工具')
    return
  }

  // 加载期仅提示：每个被跳过的渠道一条 warn，绝不弄崩启动
  for (const entry of resolved.skipped) {
    warn(`渠道 "${entry.type}" 跳过: ${entry.reason}`)
  }

  // 阶段 6：通知账本（可选晨报）。digest.enabled 开启后每次广播落账 JSONL，
  // 启动时对「昨日」窗口汇总推送一次摘要（同日重启不重发；账本失败绝不影响推送）。
  const digestRaw = (resolved.digest !== null && typeof resolved.digest === 'object') ? resolved.digest : {}
  const ledgerEnabled = digestRaw.enabled === true
  let ledger = null
  let onSend = undefined
  if (ledgerEnabled) {
    const inboundRawForDir = (resolved.inbound !== null && typeof resolved.inbound === 'object') ? resolved.inbound : {}
    const ledgerDir = typeof inboundRawForDir.stateDir === 'string' && inboundRawForDir.stateDir.trim() !== ''
      ? inboundRawForDir.stateDir.trim()
      : defaultStateDir()
    ledger = createLedger({ dir: ledgerDir, maxEntries: digestRaw.maxEntries })
    onSend = (record) => ledger.append(record)
  }

  const notifier = createNotifier(ctx, resolved.channels, { segment: resolved.segment, routing: resolved.routing, onSend })

  const disposers = []
  disposers.push(createEventListener(ctx, notifier, resolved))
  const disposeTool = registerNotifyTool(ctx, notifier, { rateLimitPerMinute: resolved.toolRateLimitPerMinute })
  if (disposeTool != null) disposers.push(disposeTool)
  const disposeTestTool = registerNotifyTestTool(ctx, notifier, { rateLimitPerMinute: resolved.toolRateLimitPerMinute })
  if (disposeTestTool != null) disposers.push(disposeTestTool)

  // 启动期晨报：昨日有记录且今天还没发过 → 推一次摘要（passive 级，走正常路由）。
  if (ledger !== null) {
    try {
      const window = yesterdayWindow()
      if (ledger.lastDigestDate() !== window.dateStr) {
        const summary = ledger.summarize(window.fromMs, window.toMs, { fromLabel: window.fromLabel, toLabel: window.toLabel })
        if (summary.counts.total > 0) {
          notifier.notifyAll({ title: '📊 通知摘要', content: ledger.compose(summary), level: 'passive' })
            .catch(() => { /* 摘要推送失败不影响启动 */ })
          ledger.markDigestDone(window.dateStr)
        }
      }
    } catch { /* 晨报任何异常静默：账本绝不拖累启动 */ }
  }

  // 阶段 4：inbound 回传栈。白名单（inbound.allowUsers）为空 = 整栈不启动（默认全拒）。
  const inboundRaw = resolved.inbound ?? {}
  const approvalRaw = resolved.approval ?? {}
  const allowUsers = (Array.isArray(inboundRaw.allowUsers) ? inboundRaw.allowUsers : [])
    .map((id) => String(id).trim())
    .filter((id) => id !== '')
  const tgRaw = (inboundRaw.telegram !== null && typeof inboundRaw.telegram === 'object') ? inboundRaw.telegram : {}
  // 便捷回退：未显式配置 inbound.telegram 时，复用出站 telegram 渠道的 botToken/chatId
  const tgOutbound = resolved.channels.find((entry) => entry.type === 'telegram')
  const inboundBotToken = String(tgRaw.botToken ?? tgOutbound?.config?.botToken ?? '').trim()
  const notifyChatIds = Array.isArray(tgRaw.notifyChatIds) && tgRaw.notifyChatIds.length > 0
    ? tgRaw.notifyChatIds.map(String)
    : (tgOutbound != null && String(tgOutbound.config.chatId ?? '') !== '' ? [String(tgOutbound.config.chatId)] : [])
  const approvalWanted = approvalRaw.mode === 'answer' || approvalRaw.mode === 'observe'

  if (allowUsers.length > 0 && (approvalWanted || inboundBotToken !== '')) {
    const stateDir = typeof inboundRaw.stateDir === 'string' && inboundRaw.stateDir.trim() !== ''
      ? inboundRaw.stateDir.trim()
      : defaultStateDir()
    const store = createStore(`${stateDir}/state.json`)
    const vault = createTokenVault({
      secret: typeof inboundRaw.tokenSecret === 'string' && inboundRaw.tokenSecret !== ''
        ? inboundRaw.tokenSecret
        : undefined,
    })
    const bus = createInboundBus({ allowUsers, store, vault, logger })

    let telegramInbound = null
    if (inboundBotToken !== '') {
      telegramInbound = createTelegramInbound({
        config: { botToken: inboundBotToken, apiBase: tgRaw.apiBase, notifyChatIds },
        bus,
        vault,
        store,
        logger,
      })
      telegramInbound.start()
      disposers.push(() => telegramInbound.stop())
      warn(`inbound 已启动：telegram 长轮询（白名单 ${allowUsers.length} 人；审批模式 ${approvalRaw.mode === 'answer' ? 'answer（远程可决）' : approvalWanted ? 'observe（只旁观）' : '未配置'}）`)
    }
    const disposeApproval = registerApprovalHandler({
      ctx,
      notifier,
      bus,
      vault,
      store,
      telegram: telegramInbound,
      approvalConfig: approvalRaw,
      logger,
    })
    disposers.push(disposeApproval)

    // 阶段 5：会话路由——白名单用户的文本按 idle/busy 语义投进 agent（followup/inject/steer）
    const replyViaTelegram = async (channel, chatId, text) => {
      if (channel === 'telegram' && telegramInbound !== null) {
        await telegramInbound.sendText(chatId, text)
        return
      }
      warn(`回执无可用通道：${channel}（仅支持 telegram 回执）`)
    }
    const disposeConversation = registerConversationRouter({
      ctx,
      bus,
      store,
      reply: replyViaTelegram,
      config: inboundRaw.conversation,
      logger,
    })
    disposers.push(disposeConversation)
  } else if (approvalWanted && allowUsers.length === 0) {
    warn('approval 已配置但 inbound.allowUsers 为空：远程审批未启动（白名单默认全拒）。请在 inbound.allowUsers 填入你的 telegram user id')
  }

  ctx.effect(() => () => {
    // 聚合可 await 的清理（事件监听的 flush 会等待在途推送完成），
    // 让 cordis 在关闭窗口内等它们 settle（headless 一次性运行退出前送达）。
    const cleanups = []
    for (const dispose of disposers) {
      try {
        const result = dispose()
        if (result instanceof Promise) cleanups.push(result)
      } catch { /* 卸载失败不致命 */ }
    }
    return Promise.allSettled(cleanups).then(() => undefined)
  })

  if (resolved.channels.length === 0) {
    warn(`未配置任何可用渠道（已跳过 ${resolved.skipped.length} 个配置项），事件推送与 notify 工具将无操作；请在 profile 的 cordis.patch.yml 配置 channels`)
  } else {
    warn(`已启用渠道：${resolved.channels.map((entry) => entry.type).join('、')}`)
  }

  return resolved
}

export { resolveConfig, createNotifier, createEventListener, registerNotifyTool }
export { maskChannelConfig, CHANNEL_TYPES } from './config.mjs'
export { NotifyError, ERROR_CODES } from './adapters/_shared.mjs'
// 阶段 4/5：inbound 回传栈（供测试与其它插件复用）
export { createStore, defaultStateDir } from './inbound/store.mjs'
export { createTokenVault } from './inbound/tokens.mjs'
export { createInboundBus } from './inbound/bus.mjs'
export { createTelegramInbound } from './inbound/telegram-bot.mjs'
export { registerApprovalHandler } from './approval/router.mjs'
export { createEscalationChain } from './approval/escalation.mjs'
export { registerConversationRouter } from './inbound/conversation.mjs'
export { segmentText, countCodepoints, sendSegmented } from './inbound/segment.mjs'
// 阶段 6：账本 / 健康自检 / 限流（供测试与其它插件复用）
export { createLedger, yesterdayWindow, classifyTitle, composeDigest } from './ledger.mjs'
export { runChannelTest, TEST_MESSAGE } from './health.mjs'
export { createRateLimiter } from './tool-register.mjs'
