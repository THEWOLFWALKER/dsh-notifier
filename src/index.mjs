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
import { createFeishuInbound, resolveFeishuInboundConfig } from './inbound/feishu-bot.mjs'
import { createQqInbound, resolveQqInboundConfig } from './inbound/qq-gw.mjs'
import { createWxpusherInbound, resolveWxpusherInboundConfig } from './inbound/wxpusher-callback.mjs'
import { createWechatIlinkInbound, resolveWechatInboundConfig, ACCOUNT_KEY } from './inbound/wechat-ilink.mjs'
import { createDingtalkInbound, resolveDingtalkInboundConfig } from './inbound/dingtalk-stream.mjs'
import { registerApprovalHandler } from './approval/router.mjs'
import { registerConversationRouter } from './inbound/conversation.mjs'
// v0.3.2：路由引擎（双向解析链 + 会话台账，src/routing/*.mjs）
import { createAgentRouter } from './routing/agent-router.mjs'
import { createSessionRegistry } from './routing/session-registry.mjs'

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

  // 阶段 4/5：inbound 回传栈。白名单（inbound.allowUsers）为空 = 整栈不启动（默认全拒）。
  const inboundRaw = resolved.inbound ?? {}
  const approvalRaw = resolved.approval ?? {}
  // v0.3.1：state store 提前创建（只读加载，无写副作用）——qq/feishu/dingtalk 的
  // 扫码凭证回退在 resolve 阶段就要读 store；必须先于下方各通道的 resolve 块
  // （TDZ：声明前引用会 ReferenceError，v0.3.1 首版曾把创建放在 resolve 之后，已修）。
  // v0.3.2：进一步前移到事件监听/工具注册之前——路由引擎（router/registry）也以它为持久层。
  const stateDir = typeof inboundRaw.stateDir === 'string' && inboundRaw.stateDir.trim() !== ''
    ? inboundRaw.stateDir.trim()
    : defaultStateDir()
  const store = createStore(`${stateDir}/state.json`)

  // v0.3.2 路由引擎装配（设计稿 §7）：store 之后、inbound 白名单块之前创建，
  // 注入四条触发线（事件推送 / notify 工具 / 审批 / 会话路由）。
  // route 原值直取（config.route 为对象时；sessionTtlHours 由 registry 自行归一，缺省 24h）。
  // 未配置任何 route:* 的存量用户：解析链全程回落全局渠道池，行为零感知（§6 兼容红线）。
  const routeRaw = (config.route !== null && typeof config.route === 'object') ? config.route : {}
  const registry = createSessionRegistry({ ctx, store, ttlHours: routeRaw.sessionTtlHours, logger })
  const router = createAgentRouter({
    store,
    agentsList: () => { try { return ctx.agents.list() } catch { return [] } },
  })
  try {
    const migrated = registry.migrateLegacyBinds()
    if (migrated > 0) warn(`route:sessions 迁移：为旧 bind 绑定补建 ${migrated} 条会话记录`)
  } catch { /* 迁移失败静默：绝不弄崩启动 */ }
  disposers.push(() => registry.dispose())

  disposers.push(createEventListener(ctx, notifier, resolved, { router, registry }))
  const disposeTool = registerNotifyTool(ctx, notifier, {
    rateLimitPerMinute: resolved.toolRateLimitPerMinute,
    router,
    channelTypes: () => resolved.channels.map((entry) => entry.type),
  })
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

  // 阶段 4：inbound 白名单（allowUsers 为空 = 整栈不启动，默认全拒）。
  // inboundRaw / approvalRaw / store 已随 v0.3.2 路由装配前移到 notifier 之后创建。
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

  // 飞书 inbound：显式配置 inbound.feishu（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 配置不全只在加载期 warn 跳过（与其他渠道同规矩，绝不弄崩启动）。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 feishu:account（config 显式配置优先）。
  // 注意门槛是「显式提供了对象」而非「对象非空」——扫码授权的承诺就是 inbound.feishu: {} 即启用。
  const fsWanted = inboundRaw.feishu !== null && typeof inboundRaw.feishu === 'object'
  const fsRaw = fsWanted ? inboundRaw.feishu : {}
  const feishuResolved = fsWanted
    ? resolveFeishuInboundConfig(fsRaw, { credentials: store.get('feishu:account') })
    : null
  if (feishuResolved !== null && !feishuResolved.ok) warn(`inbound.feishu 跳过: ${feishuResolved.reason}`)
  const feishuOk = feishuResolved?.ok === true

  // QQ 官方机器人 inbound：显式配置 inbound.qq（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 裸协议实现（WS 网关 + REST），无 SDK 依赖。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 qq:account（config 显式配置优先）。
  const qqWanted = inboundRaw.qq !== null && typeof inboundRaw.qq === 'object'
  const qqRaw = qqWanted ? inboundRaw.qq : {}
  const qqResolved = qqWanted
    ? resolveQqInboundConfig(qqRaw, { credentials: store.get('qq:account') })
    : null
  if (qqResolved !== null && !qqResolved.ok) warn(`inbound.qq 跳过: ${qqResolved.reason}`)
  const qqOk = qqResolved?.ok === true

  // 钉钉 Stream inbound（v0.3.1 新增）：显式配置 inbound.dingtalk（appKey + appSecret，
  // 或空对象走扫码落盘凭证）时启用；Stream 裸协议长连接，审批走编号回复。
  const dtWanted = inboundRaw.dingtalk !== null && typeof inboundRaw.dingtalk === 'object'
  const dtRaw = dtWanted ? inboundRaw.dingtalk : {}
  const dingtalkResolved = dtWanted
    ? resolveDingtalkInboundConfig(dtRaw, { credentials: store.get('dingtalk:account') })
    : null
  if (dingtalkResolved !== null && !dingtalkResolved.ok) warn(`inbound.dingtalk 跳过: ${dingtalkResolved.reason}`)
  const dingtalkOk = dingtalkResolved?.ok === true

  // WxPusher inbound：显式配置 inbound.wxpusher（appToken）时启用；
  // 回调需公网可达（frp/反代由用户解决），密径即凭证。
  const wxRaw = (inboundRaw.wxpusher !== null && typeof inboundRaw.wxpusher === 'object') ? inboundRaw.wxpusher : {}
  const wxResolved = Object.keys(wxRaw).length > 0 ? resolveWxpusherInboundConfig(wxRaw) : null
  if (wxResolved !== null && !wxResolved.ok) warn(`inbound.wxpusher 跳过: ${wxResolved.reason}`)
  const wxOk = wxResolved?.ok === true

  // 微信 iLink inbound：显式配置 inbound.wechat（可为空对象）时启用；
  // 凭证优先取登录 CLI 落盘的 wechat:account（需先执行 node scripts/wechat-login.mjs）。
  const wechatWanted = inboundRaw.wechat !== null && typeof inboundRaw.wechat === 'object'
  const wechatRaw = wechatWanted ? inboundRaw.wechat : {}

  if (allowUsers.length > 0 && (approvalWanted || inboundBotToken !== '' || feishuOk || qqOk || wxOk || wechatWanted || dingtalkOk)) {
    const vault = createTokenVault({
      secret: typeof inboundRaw.tokenSecret === 'string' && inboundRaw.tokenSecret !== ''
        ? inboundRaw.tokenSecret
        : undefined,
    })
    const bus = createInboundBus({ allowUsers, store, vault, logger })

    // v0.3.0 多通道装配：交互渠道实例（统一契约，approval 卡片推送用）与回执通道表。
    // telegram 为 v0.2.0 旧形状（notifyChatIds），经 _contract.normalizeInbound 归一；
    // 后续通道（feishu/qq/wxpusher/wechat）按统一契约逐个挂进这两个容器。
    const interactiveInstances = []
    const replyTargets = new Map()

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
      interactiveInstances.push(telegramInbound)
      replyTargets.set('telegram', telegramInbound)
      disposers.push(() => telegramInbound.stop())
      warn(`inbound 已启动：telegram 长轮询（白名单 ${allowUsers.length} 人；审批模式 ${approvalRaw.mode === 'answer' ? 'answer（远程可决）' : approvalWanted ? 'observe（只旁观）' : '未配置'}）`)
    }

    // 飞书 inbound：WS 长连接（免公网）。SDK 懒加载——未安装 optionalDependencies
    // 时 start() 内部中文指引后静默不可用，不影响其他通道。
    if (feishuOk) {
      const feishuInbound = createFeishuInbound({
        config: feishuResolved.config,
        bus,
        fallbackTargets: allowUsers,
        logger,
      })
      feishuInbound.start()
      interactiveInstances.push(feishuInbound)
      replyTargets.set('feishu', feishuInbound)
      disposers.push(() => feishuInbound.stop())
      warn(`inbound 已启动：feishu WebSocket 长连接（卡片审批 + 命令回执）`)
    }

    // QQ 官方机器人 inbound：WS 网关 + REST 裸协议。审批无按钮卡片，
    // 靠「回复 1 批准 / 2 拒绝」降级（router 已按 capabilities 分流文案）。
    if (qqOk) {
      const qqInbound = createQqInbound({
        config: qqResolved.config,
        bus,
        fallbackTargets: allowUsers,
        logger,
      })
      qqInbound.start()
      interactiveInstances.push(qqInbound)
      replyTargets.set('qq', qqInbound)
      disposers.push(() => qqInbound.stop())
      warn(`inbound 已启动：qq WebSocket 网关（文本审批通知 + 编号回复裁决）`)
    }

    // WxPusher inbound：HTTP 回调（send_up_cmd 上行）+ appToken 定向推送回执。
    if (wxOk) {
      const wxInbound = createWxpusherInbound({
        config: wxResolved.config,
        bus,
        store,
        fallbackTargets: allowUsers,
        logger,
      })
      wxInbound.start()
      interactiveInstances.push(wxInbound)
      replyTargets.set('wxpusher', wxInbound)
      disposers.push(() => wxInbound.stop())
      warn(`inbound 已启动：wxpusher HTTP 回调（密径鉴权 + 编号回复裁决）`)
    }
    // 微信 iLink inbound：getupdates 长轮询 + sendmessage 回执（裸协议，零依赖）。
    // 凭证缺省回落登录 CLI 落盘的 wechat:account；审批无按钮，靠编号回复裁决。
    if (wechatWanted) {
      const wechatResolved = resolveWechatInboundConfig(wechatRaw, { credentials: store.get(ACCOUNT_KEY) })
      if (!wechatResolved.ok) {
        warn(`inbound.wechat 跳过: ${wechatResolved.reason}`)
      } else {
        const wechatInbound = createWechatIlinkInbound({
          config: wechatResolved.config,
          bus,
          store,
          fallbackTargets: allowUsers,
          logger,
        })
        wechatInbound.start()
        interactiveInstances.push(wechatInbound)
        replyTargets.set('wechat', wechatInbound)
        disposers.push(() => wechatInbound.stop())
        warn(`inbound 已启动：wechat iLink 长轮询（文本审批通知 + 编号回复裁决）`)
      }
    }

    // 钉钉 Stream inbound（v0.3.1）：官方 Stream 长连接裸协议（免公网）。
    // 审批无按钮卡片，靠「回复 1 批准 / 2 拒绝」降级（router 按 capabilities 分流文案）。
    if (dingtalkOk) {
      const dingtalkInbound = createDingtalkInbound({
        config: dingtalkResolved.config,
        bus,
        store,
        fallbackTargets: allowUsers,
        logger,
      })
      dingtalkInbound.start()
      interactiveInstances.push(dingtalkInbound)
      replyTargets.set('dingtalk', dingtalkInbound)
      disposers.push(() => dingtalkInbound.stop())
      warn(`inbound 已启动：dingtalk Stream 长连接（文本审批通知 + 编号回复裁决）`)
    }

    const disposeApproval = registerApprovalHandler({
      ctx,
      notifier,
      bus,
      vault,
      store,
      interactive: interactiveInstances,
      approvalConfig: approvalRaw,
      router, // v0.3.2 审批分流：request.agent 可解析时只发绑定通道（quiet 对审批不生效）
      logger,
    })
    disposers.push(disposeApproval)

    // 阶段 5：会话路由——白名单用户的文本按 idle/busy 语义投进 agent（followup/inject/steer）
    const replyViaChannel = async (channel, chatId, text) => {
      const target = replyTargets.get(channel)
      if (target !== undefined) {
        await target.sendText(chatId, text)
        return
      }
      const known = [...replyTargets.keys()].join('、')
      warn(`回执无可用通道：${channel}（已启用回执通道：${known !== '' ? known : '无'}）`)
    }
    const disposeConversation = registerConversationRouter({
      ctx,
      bus,
      store,
      reply: replyViaChannel,
      config: inboundRaw.conversation,
      router, // v0.3.2 入站解析链（bind > 通道默认 > 单 agent > 最近活跃）
      registry, // 会话台账（/agent 命令族数据源、活跃信号、入站对话挂钩）
      channelTypes: () => resolved.channels.map((entry) => entry.type), // 全局渠道池快照（分流过滤白名单）
      logger,
    })
    disposers.push(disposeConversation)
  } else if (approvalWanted && allowUsers.length === 0) {
    warn('approval 已配置但 inbound.allowUsers 为空：远程审批未启动（白名单默认全拒）。请在 inbound.allowUsers 填入你的 telegram user id 或飞书 open_id')
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
export { createFeishuInbound, resolveFeishuInboundConfig } from './inbound/feishu-bot.mjs'
export { createQqInbound, resolveQqInboundConfig } from './inbound/qq-gw.mjs'
export { createWxpusherInbound, resolveWxpusherInboundConfig } from './inbound/wxpusher-callback.mjs'
export { createWechatIlinkInbound, resolveWechatInboundConfig } from './inbound/wechat-ilink.mjs'
export { registerApprovalHandler } from './approval/router.mjs'
export { createEscalationChain } from './approval/escalation.mjs'
export { registerConversationRouter } from './inbound/conversation.mjs'
export { segmentText, countCodepoints, sendSegmented } from './inbound/segment.mjs'
// 阶段 6：账本 / 健康自检 / 限流（供测试与其它插件复用）
export { createLedger, yesterdayWindow, classifyTitle, composeDigest } from './ledger.mjs'
export { runChannelTest, TEST_MESSAGE } from './health.mjs'
export { createRateLimiter } from './tool-register.mjs'
// v0.3.2：路由引擎（双向解析链 + 会话台账；供测试、CLI 与其它插件复用）
export { createAgentRouter } from './routing/agent-router.mjs'
export { createSessionRegistry, workspaceOf } from './routing/session-registry.mjs'
