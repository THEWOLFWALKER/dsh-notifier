// dsh-notifier index.mjs
// cordis 插件入口：组装配置解析、adapter 注册表、两条触发线（事件自动推送 + notify 工具）。
// 空配置绝不弄崩启动：任何渠道解析问题只 warn + 跳过（学 dsh-email）。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ADAPTERS, resolveConfig, resolveEnvRefs, CHANNEL_TYPES } from './config.mjs'
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
// v0.3.3：Web 管理台（HTTP 壳 + API 函数层 + 单文件 UI + 扫码流机 + 连通性自检）
import { createAdminApi, INBOUND_CHANNELS } from './admin/api.mjs'
// v0.4.0：通知事件 hub（SSE 数据源）
import { createEventHub } from './admin/events.mjs'
import { createAdminServer } from './admin/server.mjs'
import { ADMIN_UI_HTML } from './admin/ui.mjs'
import { createScanHandlers } from './admin/scan.mjs'
import { runChannelTest } from './health.mjs'

export const name = 'dsh-notifier'
export const inject = ['tools', 'agents']

/** 返回已解析配置（供测试与其它插件复用）。 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = ctx?.logger
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }
  // v0.3.3：info 级输出（admin token/管理台地址）。宿主 logger 缺 .info 时回落
  // console——token 明文只在首启打印一次，绝不能因日志通道缺失而静默丢失。
  const info = (message) => {
    const viaLogger = typeof logger?.info === 'function'
    if (viaLogger) {
      try { logger.info('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
    } else {
      try { console.info('[dsh-notifier]', message) } catch { /* 控制台不可用（极少数宿主）不致命 */ }
    }
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
  if (ledgerEnabled) {
    const inboundRawForDir = (resolved.inbound !== null && typeof resolved.inbound === 'object') ? resolved.inbound : {}
    const ledgerDir = typeof inboundRawForDir.stateDir === 'string' && inboundRawForDir.stateDir.trim() !== ''
      ? inboundRawForDir.stateDir.trim()
      : defaultStateDir()
    ledger = createLedger({ dir: ledgerDir, maxEntries: digestRaw.maxEntries })
  }

  // 阶段 4/5：inbound 回传栈。白名单（inbound.allowUsers）为空 = 整栈不启动（默认全拒）。
  // inboundRaw / approvalRaw / store 已随 v0.3.3 出站凭证回退前移到 notifier 之前。
  const inboundRaw = resolved.inbound ?? {}
  const approvalRaw = resolved.approval ?? {}
  // v0.3.1：state store 提前创建（只读加载，无写副作用）——qq/feishu/dingtalk 的
  // 扫码凭证回退在 resolve 阶段就要读 store；必须先于下方各通道的 resolve 块
  // （TDZ：声明前引用会 ReferenceError，v0.3.1 首版曾把创建放在 resolve 之后，已修）。
  // v0.3.2：进一步前移到事件监听/工具注册之前——路由引擎（router/registry）也以它为持久层。
  // v0.3.3：再前移到 notifier 之前——出站凭证 state 回退（admin.enabled 时）要在
  // createNotifier 前合并完成（§5「YAML 只做 bootstrap，运行时可变状态写 state」）。
  const stateDir = typeof inboundRaw.stateDir === 'string' && inboundRaw.stateDir.trim() !== ''
    ? inboundRaw.stateDir.trim()
    : defaultStateDir()
  const store = createStore(`${stateDir}/state.json`)

  // v0.3.3 出站凭证 state 回退（设计稿 §5）：admin.enabled 开启时，store 里每个非双域出站
  // 类型的 `<type>:account`（UI putChannel / 手写产物）与 YAML 行字段级合并（store 字段
  // 覆盖同名 YAML 字段——UI 改过的即为准），重新过 adapter.resolve 后替换/追加
  // resolved.channels；admin 关闭时零执行——存量用户行为逐字节不变（§6 兼容红线）。
  // 双域通道（feishu/dingtalk）不回退：其 `<type>:account` 键域归入站机器人凭证
  // （v0.3.1 扫码落盘语义），出站 webhook 只走 YAML bootstrap（与 admin/api.mjs 同款裁定）。
  const adminEnabled = resolved.admin?.enabled === true
  const yamlRowOf = new Map()
  for (const row of (Array.isArray(config.channels) ? config.channels : [])) {
    if (row === null || typeof row !== 'object' || row.enabled === false) continue // 显式禁用是用户意图，不回退
    const type = typeof row.type === 'string' ? row.type.trim() : ''
    if (type !== '' && !yamlRowOf.has(type)) yamlRowOf.set(type, row)
  }
  /** store 账号防御读取：非普通对象（null/数组/标量/损坏）一律按无账号。 */
  const accountOf = (key) => {
    try {
      const value = store.get(key)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      return null
    }
  }
  const DUAL_INBOUND_DOMAIN_TYPES = new Set(['feishu', 'dingtalk'])
  const mergedRowOf = new Map() // type → 合并后的原始行（channelTest 的 rawConfig 来源）
  if (adminEnabled) {
    const byType = new Map(resolved.channels.map((entry) => [entry.type, entry]))
    for (const type of CHANNEL_TYPES) {
      if (DUAL_INBOUND_DOMAIN_TYPES.has(type)) continue
      const account = accountOf(`${type}:account`)
      if (account === null) continue
      const merged = { ...yamlRowOf.get(type) ?? {}, ...account, type }
      try {
        byType.set(type, { type, config: ADAPTERS[type].resolve(resolveEnvRefs(merged)) })
        mergedRowOf.set(type, merged)
      } catch (error) {
        // resolve 失败：YAML 条目原样保留（未破坏 byType），只记原因；store-only 类型即「暂不启用」
        const reason = error instanceof Error ? error.message : String(error)
        if (byType.has(type)) warn(`渠道 "${type}" state 凭证合并失败，沿用 YAML 配置: ${reason}`)
        else warn(`渠道 "${type}" 跳过（state 凭证不完整）: ${reason}`)
      }
    }
    resolved.channels = [...byType.values()]
  }
  /** 连通性测试的 rawConfig（合并行优先，回落 YAML 行；ENV 引用由 runChannelTest 自行解析）。 */
  const testRawConfigOf = (type) => {
    const row = mergedRowOf.get(type) ?? yamlRowOf.get(type)
    if (row === undefined) return null
    const { type: _drop, ...rest } = row
    return rest
  }

  // v0.4.0 通知事件 hub（A 路线「管理台通知页」）：admin 开启时 notifier.onSend 旁路进
  // hub，GET /api/events 以 SSE 实时推给浏览器（系统通知数据源）。admin 关闭零开销——
  // hub 不创建、onSend 维持 v0.3.3 的账本单挂语义（存量行为逐字节不变）。
  // notify.mjs 已把 onSend 调用包在 try/catch：账本/hub 任一异常绝不影响推送主链路。
  const eventHub = adminEnabled ? createEventHub() : null
  const onSend = eventHub === null
    ? (ledger === null ? undefined : (record) => ledger.append(record))
    : (record) => {
        if (ledger !== null) ledger.append(record)
        eventHub.publish(record)
      }

  const notifier = createNotifier(ctx, resolved.channels, { segment: resolved.segment, routing: resolved.routing, onSend })

  const disposers = []

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
  // 便捷回退：未显式配置 inbound.telegram 时，复用出站 telegram 渠道的 botToken/chatId；
  // v0.3.3：admin 下再回落 store 的 telegram:account（UI/手写产物；出站 overlay 已含同源凭证，
  // 这里是 overlay resolve 失败时的兜底链尾）。
  const tgOutbound = resolved.channels.find((entry) => entry.type === 'telegram')
  const tgAccount = adminEnabled ? accountOf('telegram:account') : null
  const inboundBotToken = String(tgRaw.botToken ?? tgOutbound?.config?.botToken ?? tgAccount?.botToken ?? '').trim()
  const notifyChatIds = Array.isArray(tgRaw.notifyChatIds) && tgRaw.notifyChatIds.length > 0
    ? tgRaw.notifyChatIds.map(String)
    : (tgOutbound != null && String(tgOutbound.config.chatId ?? '') !== ''
        ? [String(tgOutbound.config.chatId)]
        : (tgAccount !== null && String(tgAccount.chatId ?? '') !== '' ? [String(tgAccount.chatId)] : []))
  const approvalWanted = approvalRaw.mode === 'answer' || approvalRaw.mode === 'observe'

  // 飞书 inbound：显式配置 inbound.feishu（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 配置不全只在加载期 warn 跳过（与其他渠道同规矩，绝不弄崩启动）。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 feishu:account（config 显式配置优先）。
  // v0.3.3：admin 开启时，store 存在 feishu:account（扫码/UI 产物）本身即启用信号——
  // 网页扫码授权后无需再改 YAML（inbound.feishu: {} 语义的自然延伸）。
  // 注意门槛是「显式提供了对象」而非「对象非空」——扫码授权的承诺就是 inbound.feishu: {} 即启用。
  const fsExplicit = inboundRaw.feishu !== null && typeof inboundRaw.feishu === 'object'
  const fsWanted = fsExplicit || (adminEnabled && accountOf('feishu:account') !== null)
  const fsRaw = fsExplicit ? inboundRaw.feishu : {}
  const feishuResolved = fsWanted
    ? resolveFeishuInboundConfig(fsRaw, { credentials: store.get('feishu:account') })
    : null
  if (feishuResolved !== null && !feishuResolved.ok) warn(`inbound.feishu 跳过: ${feishuResolved.reason}`)
  const feishuOk = feishuResolved?.ok === true

  // QQ 官方机器人 inbound：显式配置 inbound.qq（可为空对象——空 = 走扫码 CLI 落盘凭证）时启用；
  // 裸协议实现（WS 网关 + REST），无 SDK 依赖。
  // v0.3.1：凭证缺省回落扫码 CLI 落盘的 qq:account（config 显式配置优先）。
  // v0.3.3：admin 开启时，store 存在 qq:account 本身即启用信号（同 feishu）。
  const qqExplicit = inboundRaw.qq !== null && typeof inboundRaw.qq === 'object'
  const qqWanted = qqExplicit || (adminEnabled && accountOf('qq:account') !== null)
  const qqRaw = qqExplicit ? inboundRaw.qq : {}
  const qqResolved = qqWanted
    ? resolveQqInboundConfig(qqRaw, { credentials: store.get('qq:account') })
    : null
  if (qqResolved !== null && !qqResolved.ok) warn(`inbound.qq 跳过: ${qqResolved.reason}`)
  const qqOk = qqResolved?.ok === true

  // 钉钉 Stream inbound（v0.3.1 新增）：显式配置 inbound.dingtalk（appKey + appSecret，
  // 或空对象走扫码落盘凭证）时启用；Stream 裸协议长连接，审批走编号回复。
  // v0.3.3：admin 开启时，store 存在 dingtalk:account 本身即启用信号（同 feishu）。
  const dtExplicit = inboundRaw.dingtalk !== null && typeof inboundRaw.dingtalk === 'object'
  const dtWanted = dtExplicit || (adminEnabled && accountOf('dingtalk:account') !== null)
  const dtRaw = dtExplicit ? inboundRaw.dingtalk : {}
  const dingtalkResolved = dtWanted
    ? resolveDingtalkInboundConfig(dtRaw, { credentials: store.get('dingtalk:account') })
    : null
  if (dingtalkResolved !== null && !dingtalkResolved.ok) warn(`inbound.dingtalk 跳过: ${dingtalkResolved.reason}`)
  const dingtalkOk = dingtalkResolved?.ok === true

  // WxPusher inbound：显式配置 inbound.wxpusher（appToken）时启用；
  // 回调需公网可达（frp/反代由用户解决），密径即凭证。
  // v0.3.3：admin 开启时，store 的 wxpusher:account（UI 保存产物）为启用信号 +
  // appToken 链尾兜底——resolveWxpusherInboundConfig 不收 credentials 参数，
  // 在装配层做字段级合并（YAML 显式键优先覆盖 store）。
  const wxExplicit = (inboundRaw.wxpusher !== null && typeof inboundRaw.wxpusher === 'object')
    ? inboundRaw.wxpusher : {}
  const wxAccount = adminEnabled ? accountOf('wxpusher:account') : null
  const wxMerged = { ...wxAccount, ...wxExplicit }
  const wxResolved = (Object.keys(wxExplicit).length > 0 || wxAccount !== null)
    ? resolveWxpusherInboundConfig(wxMerged)
    : null
  if (wxResolved !== null && !wxResolved.ok) warn(`inbound.wxpusher 跳过: ${wxResolved.reason}`)
  const wxOk = wxResolved?.ok === true

  // 微信 iLink inbound：显式配置 inbound.wechat（可为空对象）时启用；
  // 凭证优先取登录 CLI 落盘的 wechat:account（需先执行 node scripts/wechat-login.mjs）。
  // v0.3.3：admin 开启时，store 的 wechat:account 本身即启用信号（同 feishu；
  // 凭证链不变——resolve 内部已回落 credentials）。
  const wechatExplicit = inboundRaw.wechat !== null && typeof inboundRaw.wechat === 'object'
  const wechatWanted = wechatExplicit || (adminEnabled && accountOf('wechat:account') !== null)
  const wechatRaw = wechatExplicit ? inboundRaw.wechat : {}

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

  // v0.3.3 Web 管理台装配（设计稿 §5 + §0.5-6）：admin.enabled 开启时起 HTTP 壳 + API
  // 函数层 + 扫码流机。admin 缺省 false → 整块零执行，存量用户行为逐字节不变（§6 兼容红线）。
  // 军规：管理台起不来只 warn 绝不弄崩宿主插件（对齐「空配置绝不弄崩启动」家训）。
  // apply() 保持同步（全部既有测试与宿主按同步签名调用）：server.start() 即发即忘，
  // 失败走 catch warn；stop() 已进 disposers（内部等待未完成的 listen 后再关，天然收敛）。
  if (adminEnabled) {
    try {
      // token 策略（§0.5-6）：YAML 显式 token 以其为准（哈希同步 state）；否则首启生成
      // base64url 随机串并打印一次——此后重启凭既有哈希校验（明文只在首启日志出现，不重发）。
      // state 只存 SHA-256 哈希（admin:token-hash 键，64 位 hex），明文绝不落盘；
      // 比对先比长度再 timingSafeEqual（两串长度不等时它会抛）。
      const sha256HexOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
      const HEX_64 = /^[0-9a-f]{64}$/
      const explicitToken = typeof resolved.admin.token === 'string' ? resolved.admin.token : ''
      let storedHash = null
      try { storedHash = store.get('admin:token-hash') } catch { storedHash = null }
      const storedHashOk = typeof storedHash === 'string' && HEX_64.test(storedHash)

      let activeHash = '' // 生效哈希（verifyToken 比对基准；明文无需保留在内存外）
      if (explicitToken !== '') {
        activeHash = sha256HexOf(explicitToken)
        if (storedHash !== activeHash) store.set('admin:token-hash', activeHash) // 同步到 state
      } else if (storedHashOk) {
        activeHash = storedHash // 沿用首启打印过的 token（校验靠哈希，不重发明文）
      } else {
        // 首次生成（或既有哈希损坏视为无）：打印一次 + 落哈希。打印先于 server 启动——
        // 端口被占等启动失败时 token 已可知，重启成功后凭哈希继续有效。
        const generated = randomBytes(24).toString('base64url')
        activeHash = sha256HexOf(generated)
        store.set('admin:token-hash', activeHash)
        info(`admin token（仅此一次打印，请妥善保存）: ${generated}`)
        info('忘记 token 时：删除 state.json 的 admin:token-hash 键（或在配置写 admin.token）后重启即重新生成')
      }
      /** Bearer 校验：candidate 的 SHA-256 与生效哈希恒时比对；任何异常一律 false。 */
      const verifyToken = (candidate) => {
        try {
          if (typeof candidate !== 'string' || candidate === '') return false
          const candidateHash = sha256HexOf(candidate)
          if (candidateHash.length !== activeHash.length) return false
          return timingSafeEqual(Buffer.from(candidateHash, 'utf8'), Buffer.from(activeHash, 'utf8'))
        } catch {
          return false
        }
      }

      // API 函数层（UI/CLI 共用）：注入 v0.3.2 的 router/registry、store、notifier 与
      // 出站渠道快照（outboundConfigs 取 resolved.channels——含 store overlay 后的最终态；
      // putChannel 运行时新写的 store 字段要到下次启动才进快照，即「重启生效」语义）。
      const scanHandlers = createScanHandlers({ store, logger })
      const adminApi = createAdminApi({
        router,
        registry,
        store,
        notifier,
        channelsEnabled: () => resolved.channels.map((entry) => entry.type),
        outboundConfigs: () => Object.fromEntries(resolved.channels.map((entry) => [entry.type, entry.config])),
        channelTest: (type) => runChannelTest({ type, rawConfig: testRawConfigOf(type) }),
        scanHandlers,
        stateDir,
        logger,
      })
      const adminServer = createAdminServer({
        api: adminApi,
        verifyToken,
        host: '127.0.0.1', // 红线：永不绑公网（§0.5-6，config.mjs 已写死不可配）
        port: resolved.admin.port,
        ui: ADMIN_UI_HTML,
        events: eventHub, // v0.4.0 通知事件流（GET /api/events，SSE）
        logger,
      })
      adminServer.start()
        .then(({ port, address }) => {
          info(`Web 管理台已就绪: http://${address}:${port}（仅本机回环${explicitToken !== '' ? '；token 用 YAML 显式配置的 admin.token' : ''}）`)
        })
        .catch((error) => {
          const detail = error?.code === 'EADDRINUSE'
            ? `端口 ${resolved.admin.port} 已被占用（调整 admin.port 或释放占用进程后重启）`
            : (error instanceof Error ? error.message : String(error))
          warn(`Web 管理台启动失败，已跳过（插件其余功能不受影响）: ${detail}`)
        })
      disposers.push(() => adminServer.stop())
    } catch (error) {
      warn(`Web 管理台装配失败，已跳过（插件其余功能不受影响）: ${error instanceof Error ? error.message : String(error)}`)
    }
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
