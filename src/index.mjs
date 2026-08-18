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
import { createIdentity } from './inbound/identity.mjs'
import { createPairing } from './inbound/pairing.mjs'
import { createInboundBus } from './inbound/bus.mjs'
import { createTelegramInbound } from './inbound/telegram-bot.mjs'
import { createFeishuInbound, resolveFeishuInboundConfig } from './inbound/feishu-bot.mjs'
import { createQqInbound, resolveQqInboundConfig } from './inbound/qq-gw.mjs'
import { createWxpusherInbound, resolveWxpusherInboundConfig } from './inbound/wxpusher-callback.mjs'
import { createWechatIlinkInbound, resolveWechatInboundConfig, ACCOUNT_KEY } from './inbound/wechat-ilink.mjs'
import { createDingtalkInbound, resolveDingtalkInboundConfig } from './inbound/dingtalk-stream.mjs'
import { registerApprovalHandler } from './approval/router.mjs'
import { createQuestionBridge, registerAskUserTool } from './questions/router.mjs'
import { registerConversationRouter } from './inbound/conversation.mjs'
// v0.5：动作闭环（通知按钮 → 内置处置动作）
import { createActionDispatcher } from './actions.mjs'
// v0.6：开放事件源（ctx.notifier 服务注入 + dsh-notifier/sent 事件）
import { createPublicFacade, composeOnSend, deepFreeze } from './public.mjs'
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
    // v0.6.1 真机可诊断性：部分宿主形态（dsh web profile）cordis logger 不落 stdout，
    // 装配/轮询类告警只走 logger = 部署问题零可见（2026-08-16 TG inbound 装配事故：
    // 出站正常 + inbound 全死 + 错误不可见，排查数轮才定位）。对齐探针「console 与
    // logger 双写」做法，warn 必须双写 stderr——宁可测试输出多几行，不可部署黑盒。
    try { console.error('[dsh-notifier]', message) } catch { /* 控制台不可用（极少数宿主）不致命 */ }
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

  // v0.6 服务注入（spike 验证 2026-08-16，DSH 0.1.0-rc.6）：宿主为 cordis 强制契约，
  // 直接 ctx.notifier = facade 会被拦截（cannot set property "notifier" without provide），
  // 必须 ctx.provide('notifier', facade)（返回注销器）。无 provide（测试桩 / 非 cordis 宿主）
  // 回退直接赋值 + 引用比对清除（不误伤他人后注册的同名服务，审查 S4）。
  const registerNotifierService = (facade, disposers) => {
    if (typeof ctx?.provide === 'function') {
      try {
        const unprovide = ctx.provide('notifier', facade)
        if (typeof unprovide === 'function') disposers.push(unprovide)
      } catch (error) {
        warn(`notifier 服务注册失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    try { ctx.notifier = facade } catch { warn('notifier 服务注册失败（宿主拦截属性赋值）') }
    disposers.push(() => {
      try { if (ctx.notifier === facade) ctx.notifier = undefined } catch { /* 清除失败不致命 */ }
    })
  }

  // v0.6 sent 事件发射（设计稿 §3）：emit 失败绝不影响账本/hub/推送主链路；宿主无 ctx.emit
  // 时 warn 一次后静默（可观测，审查 R6）。public.emit:false = 整链不挂（零开销家训）。
  const publicEmit = resolved.public?.emit !== false
  let emitWarned = false
  const emitSend = publicEmit
    ? (record) => {
        if (typeof ctx?.emit !== 'function') {
          // 可选链会静默吞掉缺失——违背 R6 可观测性：缺 emit 必须让用户看得见（warn 一次）
          if (!emitWarned) {
            emitWarned = true
            warn('宿主不支持 ctx.emit，dsh-notifier/sent 事件不可用（后续静默）')
          }
          return
        }
        try {
          ctx.emit('dsh-notifier/sent', deepFreeze(record))
        } catch {
          if (!emitWarned) {
            emitWarned = true
            warn('dsh-notifier/sent 发射失败（宿主可能不支持 ctx.emit），后续失败静默')
          }
        }
      }
    : null

  if (!resolved.enabled) {
    // v0.6（spike 裁定）：禁用时仍必须提供 no-op stub 服务——消费插件以 inject:['notifier']
    // 声明依赖，服务缺失会阻塞宿主启动（真机验证：pending → 启动 abort）。stub 让消费方
    // 拿到「push 返回 skipped:(disabled)」而非整个宿主起不来。
    warn('已禁用（enabled: false），不注册事件监听与工具；notifier 服务以 no-op 形态照常提供')
    const stubDisposers = []
    registerNotifierService(createPublicFacade({ notifier: null, config: resolved.public, logger }), stubDisposers)
    ctx.effect(() => () => {
      for (const dispose of stubDisposers) {
        try { dispose()?.catch?.(() => {}) } catch { /* 卸载失败不致命 */ }
      }
    })
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
  // v0.6 组合器化（设计稿 §3.4）：账本/hub/emit 三挂逐项隔离——甲抛错乙照跑（结构保证，
  // 取代旧 if/else 依赖「append 与 publish 各自永不抛」的碰巧等价）。全空 → undefined，
  // 保持 v0.5「digest 关 + admin 关 + emit 关 → onSend=undefined」边界语义不变。
  const onSend = composeOnSend([
    ledger === null ? null : (record) => ledger.append(record),
    eventHub === null ? null : (record) => eventHub.publish(record),
    emitSend,
  ])

  const notifier = createNotifier(ctx, resolved.channels, { segment: resolved.segment, routing: resolved.routing, onSend })

  const disposers = []

  // v0.6 公共面装配（设计稿 §2.5）：notifier 之后创建 facade 并注册服务。public.enabled:false
  // → stub 形态（push 返回 skipped:(disabled)），服务照常提供（消费插件的启动依赖不能断）。
  // sink = 限流拦截的直落点：限流记录照进账本 + 照发 sent 事件（静音不等于没发生，§3.3）。
  const publicFacade = createPublicFacade({
    notifier: resolved.public?.enabled !== false ? notifier : null,
    config: resolved.public,
    logger,
    sink: (record) => {
      try { ledger?.append?.(record) } catch { /* 限流落账失败不致命 */ }
      if (typeof emitSend === 'function') {
        try { emitSend(record) } catch { /* emit 失败不拖累 */ }
      }
    },
  })
  registerNotifierService(publicFacade, disposers)
  disposers.push(() => publicFacade.dispose())

  // v0.6.3 state 瘦身（审查 R2 P1-4）：dedup:*/ap:*/act:* 历史上只增不删（bus 每条
  // 入站消息落一个 dedup 键、审批/动作核销后账本行永留），长跑进程 state.json 单调
  // 膨胀且全量重写随之变慢。定期清扫：dedup 窗口 24h（留 1h 余量防时钟回拨），已决
  // 审批/动作保留 24h 供审计，超期即删（首启 + 每 6h；sweepPrefix 走脏键合并写，
  // 与 CLI/他进程并发写互不覆盖）。pending 行不清（在等裁决，宁可多留一行）。
  // v0.6.4：dedup 清扫线联动 bus 窗口（窗口可配时硬编码 25h 会误清未过期键或漏清）；
  // bus 在白名单块才创建（可能不创建），sweep 注册在前——用外层惰性引用兜住。
  let sweepBusRef = null
  {
    const sweepOnce = () => {
      try {
        const windowMs = sweepBusRef?.dedupWindowMs ?? 24 * 60 * 60 * 1000
        const horizon = Date.now() - windowMs - 60 * 60 * 1000 // 窗口 + 1h 时钟回拨余量
        store.sweepPrefix('dedup:', (_key, seenAt) => typeof seenAt !== 'number' || seenAt < horizon)
        const resolvedHorizon = Date.now() - 24 * 60 * 60 * 1000
        const expiredRow = (_key, row) => row?.status === 'resolved'
          && typeof row.resolvedAt === 'number' && row.resolvedAt < resolvedHorizon
        store.sweepPrefix('ap:', expiredRow)
        store.sweepPrefix('act:', expiredRow)
      } catch { /* 清扫失败不致命，下轮再试 */ }
    }
    sweepOnce()
    const sweepTimer = setInterval(sweepOnce, 6 * 60 * 60 * 1000)
    sweepTimer.unref?.()
    disposers.push(() => clearInterval(sweepTimer))
  }

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

  // v0.5 动作闭环的装配时序（架构审查修正，设计稿 §6）：eventListener 装配早于
  // inbound 白名单块（vault/store/通道在其后才创建），直传实例不可行——用惰性
  // getter（先例 = 下方 registerNotifyTool 的 channelTypes: () => ...）。
  // 未配置任何 inbound（白名单空）→ actions 永不创建 → getter 恒 null → 通知文本
  // hint「回复 /stop 取消」仍全通道可达，动作卡片自然缺席——兼容红线自洽。
  let actionsRef = null
  let interactiveRaw = []
  let busRef = null
  let questionsBridge = null
  const questionsForChannels = {
    decide: (payload) => questionsBridge?.decide(payload) ?? { ok: false, message: '提问服务未就绪' },
  }
  disposers.push(createEventListener(ctx, notifier, resolved, {
    router,
    registry,
    bus: () => busRef,
    actions: () => actionsRef,
    interactive: () => interactiveRaw,
  }))
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
    ? resolveFeishuInboundConfig(resolveEnvRefs(fsRaw), { credentials: store.get('feishu:account') })
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
    ? resolveQqInboundConfig(resolveEnvRefs(qqRaw), { credentials: store.get('qq:account') })
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
    ? resolveDingtalkInboundConfig(resolveEnvRefs(dtRaw), { credentials: store.get('dingtalk:account') })
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
  // v0.7 密径持久化：webhookPath 未显式配置时复用 store 首铸密径——缺省每次启动
  // 随机换路径，用户已填进 WxPusher 控制台的回调 URL 立即失效（真机事故：每次
  // 重启都要去控制台改地址）。首铸落盘 wxpusher:webhookPath；显式配置仍是用户意志。
  let wxPathPersistNeeded = false
  if (String(wxMerged.webhookPath ?? '').trim() === '') {
    const persistedPath = store.get('wxpusher:webhookPath')
    if (typeof persistedPath === 'string' && persistedPath.startsWith('/') && persistedPath.length > 1) {
      wxMerged.webhookPath = persistedPath
    } else {
      wxPathPersistNeeded = true // 本次 resolve 生成新随机密径，成功后落盘复用
    }
  }
  const wxResolved = (Object.keys(wxExplicit).length > 0 || wxAccount !== null)
    ? resolveWxpusherInboundConfig(resolveEnvRefs(wxMerged))
    : null
  if (wxResolved !== null && !wxResolved.ok) warn(`inbound.wxpusher 跳过: ${wxResolved.reason}`)
  const wxOk = wxResolved?.ok === true
  if (wxOk && wxPathPersistNeeded) {
    try { store.set('wxpusher:webhookPath', wxResolved.config.webhookPath) } catch (error) {
      warn(`wxpusher 密径持久化失败（下次重启将重新生成，需重填回调地址）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 微信 iLink inbound：显式配置 inbound.wechat（可为空对象）时启用；
  // 凭证优先取登录 CLI 落盘的 wechat:account（需先执行 node scripts/wechat-login.mjs）。
  // v0.3.3：admin 开启时，store 的 wechat:account 本身即启用信号（同 feishu；
  // 凭证链不变——resolve 内部已回落 credentials）。
  const wechatExplicit = inboundRaw.wechat !== null && typeof inboundRaw.wechat === 'object'
  const wechatWanted = wechatExplicit || (adminEnabled && accountOf('wechat:account') !== null)
  const wechatRaw = wechatExplicit ? inboundRaw.wechat : {}

  // v0.7 身份层（计划书 §3.1/§3.2）：绑定表一等公民。YAML allowUsers 启动播撒为
  // 绑定记录（origin:'migrated'，幂等、只增不减——删减权收归管理台单一入口）；
  // 绑定表与 YAML 均空 = 引导态：六通道凭证就绪即启动，仅开放注册面（/pair 等）。
  // identity/pairing 提升到外层作用域：admin（成员页/配对码）与 inbound 共用同一实例。
  // 配对审计晚绑定：管理台在 inbound 之后装配，先入内存队（有界），装配后转发 admin-audit.jsonl；
  // admin 未启用则排队丢弃（审计文件属管理台，不存在静默丢审记的口径问题）。
  let pairingAuditSink = null
  const pairingAuditBacklog = []
  const identity = createIdentity({ store, logger })
  const pairing = createPairing({
    store,
    logger,
    onAudit: (event, detail) => {
      try {
        if (pairingAuditSink !== null) pairingAuditSink(`pairing:${event}`, detail)
        else if (pairingAuditBacklog.length < 200) pairingAuditBacklog.push([`pairing:${event}`, detail])
      } catch { /* 审计失败不致命 */ }
    },
  })
  // wechat 不进迁移通道表：其凭证 resolve 在 inbound 块内才做（首启播撒到死通道会产生
  // 永不生效的成员行；一次性迁移下首启正是唯一播撒机会——宁可少播，/pair 补齐）
  const enabledInboundChannels = [
    inboundBotToken !== '' ? 'telegram' : '',
    feishuOk ? 'feishu' : '',
    qqOk ? 'qq' : '',
    wxOk ? 'wxpusher' : '',
    dingtalkOk ? 'dingtalk' : '',
  ].filter((name) => name !== '')
  try {
    const migrated = identity.migrate(allowUsers, enabledInboundChannels)
    // info 助手带 console 回落（R5 审查 R5-2-P3-6：裸 logger?.info?. 在无 info 通道的宿主零可见）
    if (migrated.added > 0) info(`白名单迁移：${migrated.added} 条绑定落盘（渠道：${enabledInboundChannels.join('/') || '无'}）`)
    else if (migrated.skipped === true) info('白名单迁移：已标记完成（YAML 不再播撒，增删以管理台为准）')
  } catch (error) {
    warn(`身份绑定迁移失败（继续以既有绑定表运行）: ${error instanceof Error ? error.message : String(error)}`)
  }
  const guidedBoot = identity.isEmpty() && allowUsers.length === 0

  // v0.7 启动门（修审查 #1）：通道凭证就绪即启动——白名单不再拦启动；空名单进入引导态
  // （业务面照旧全拒，仅注册面开放，红线不降级）。v0.6 兼容分支：无通道凭证但
  // approval 已配且名单非空时照旧注册（裁决无人应答超时回落桌面，行为与 0.6 一致）；
  // 名单与绑定表全空且无通道 → 不启动（引导提示）。
  const anyChannelReady = inboundBotToken !== '' || feishuOk || qqOk || wxOk || wechatWanted || dingtalkOk
  const inboundReady = anyChannelReady
    || (approvalWanted && (allowUsers.length > 0 || identity.size() > 0))
  if (inboundReady) {
    // 引导态铸造 bootstrap 码：仅 stderr（warn 双写）与管理台两个出口，不出网不落明文。
    // 绑定表非空后不再铸造（常规配对码走管理台/owner）。
    let bootstrapCode = null
    const showBootstrap = (minted) => {
      if (minted?.ok !== true) return
      const minutes = Math.max(1, Math.round((minted.expiresAt - Date.now()) / 60000))
      // 码面只在此处出现一次（R5 审查 R5-2-P3-5：指令行重复印码面，审计口径双计）
      warn(`【引导配对码】${minted.code}（${minutes} 分钟内有效，首位 /pair 成功者成为 owner）\n` +
        '在任意已启用通道私聊机器人发送：/pair <上方配对码>')
    }
    if (guidedBoot) {
      try {
        bootstrapCode = pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot' })
        showBootstrap(bootstrapCode)
      } catch (error) {
        warn(`bootstrap 引导码铸造失败（注册面仍可用，管理台可补铸）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const vault = createTokenVault({
      secret: typeof inboundRaw.tokenSecret === 'string' && inboundRaw.tokenSecret !== ''
        ? inboundRaw.tokenSecret
        : undefined,
    })
    const bus = createInboundBus({
      allowUsers,
      identity,
      pairing,
      store,
      vault,
      logger,
      // 引导码过期后首个 /pair 触发重铸（自愈：用户迟到不必重启宿主），stderr 再展示
      onBootstrapRemint: showBootstrap,
    })
    // v0.6.4（审查 R2-P2-5）：停机时总线整体收场——在途 waiter 以 null 结束（= 超时
    // 回退桌面语义）、消息处理器全摘；dedup 清扫线联动其窗口。
    sweepBusRef = bus
    busRef = bus
    disposers.push(() => bus.dispose())

    // v0.5 动作分发器：vault/store 之后创建（无环），telegram/feishu 按钮回调消费。
    // 内置白名单仅 turn/cancel——权限面与 /stop 命令完全等价（永无任意代码执行）。
    const actions = createActionDispatcher({ vault, store, logger })
    actions.register('turn/cancel', ({ payload }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId === '') return { ok: false, message: '无效会话' }
      let agent = null
      try { agent = ctx.agents.get(sessionId) } catch { return { ok: false, message: '会话查询失败' } }
      if (agent === undefined || agent === null) {
        return { ok: false, message: '会话不存在（任务可能已结束）' }
      }
      try {
        agent.cancel('remote-action')
        return { ok: true, message: '✅ 已停止任务' }
      } catch {
        return { ok: false, message: '取消失败（agent 可能已空闲）' }
      }
    })
    actionsRef = actions
    disposers.push(() => actions.dispose())

    // v0.3.0 多通道装配：交互渠道实例（统一契约，approval 卡片推送用）与回执通道表。
    // telegram 为 v0.2.0 旧形状（notifyChatIds），经 _contract.normalizeInbound 归一；
    // 后续通道（feishu/qq/wxpusher/wechat）按统一契约逐个挂进这两个容器。
    const interactiveInstances = []
    const replyTargets = new Map()

    // v0.6.1 逐通道装配隔离（真机事故复盘）：装配段此前的同步抛错会直接冒出 apply，
    // 被 cordis 吃掉（web profile 下零可见）→ 出站正常（notifier 先建好）+ inbound
    // 全死 + 无任何线索。现在每条通道独立守护：炸了点名 warn（warn 已双写 stderr）
    // 并跳过该通道，其余通道与审批/会话路由照常装配——真正兑现「绝不弄崩宿主」。
    const startInboundChannel = (name, boot) => {
      try {
        return boot()
      } catch (error) {
        warn(`inbound:${name} 装配失败，已跳过（其余通道不受影响）: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }

    let telegramInbound = null
    if (inboundBotToken !== '') {
      telegramInbound = startInboundChannel('telegram', () => {
        const instance = createTelegramInbound({
          config: { botToken: inboundBotToken, apiBase: tgRaw.apiBase, notifyChatIds },
          bus,
          vault,
          store,
          logger,
          identity, // v0.7 三级目标解析：绑定成员优先
          actions, // v0.5 动作按钮（ac: 回调 → turn/cancel）
          questions: questionsForChannels, // v0.8 提问作答按钮（aq: 回调 → questions.decide）
        })
        instance.start()
        interactiveInstances.push(instance)
        replyTargets.set('telegram', instance)
        disposers.push(() => instance.stop())
        warn(`inbound 已启动：telegram 长轮询（绑定 ${identity.size()} 人${guidedBoot ? '，引导态：等待 /pair 配对' : ''}；审批模式 ${approvalRaw.mode === 'answer' ? 'answer（远程可决）' : approvalWanted ? 'observe（只旁观）' : '未配置'}）`)
        return instance
      })
    }

    // 飞书 inbound：WS 长连接（免公网）。SDK 懒加载——未安装 optionalDependencies
    // 时 start() 内部中文指引后静默不可用，不影响其他通道。
    if (feishuOk) {
      startInboundChannel('feishu', () => {
        const instance = createFeishuInbound({
          config: feishuResolved.config,
          bus,
          fallbackTargets: allowUsers,
          identity, // v0.7 三级目标解析：绑定成员优先
          logger,
          actions, // v0.5 动作按钮（ac: 回调 → turn/cancel）
          questions: questionsForChannels, // v0.8 提问作答按钮（aq: 回调 → questions.decide）
        })
        instance.start()
        interactiveInstances.push(instance)
        replyTargets.set('feishu', instance)
        disposers.push(() => instance.stop())
        warn(`inbound 已启动：feishu WebSocket 长连接（卡片审批 + 命令回执）`)
        return instance
      })
    }

    // QQ 官方机器人 inbound：WS 网关 + REST 裸协议。审批无按钮卡片，
    // 靠「回复 1 批准 / 2 拒绝」降级（router 已按 capabilities 分流文案）。
    if (qqOk) {
      startInboundChannel('qq', () => {
        const instance = createQqInbound({
          config: qqResolved.config,
          bus,
          fallbackTargets: allowUsers,
          identity, // v0.7 三级目标解析：绑定成员优先（群目标无条件保留）
          logger,
        })
        instance.start()
        interactiveInstances.push(instance)
        replyTargets.set('qq', instance)
        disposers.push(() => instance.stop())
        warn(`inbound 已启动：qq WebSocket 网关（文本审批通知 + 编号回复裁决）`)
        return instance
      })
    }

    // WxPusher inbound：HTTP 回调（send_up_cmd 上行）+ appToken 定向推送回执。
    if (wxOk) {
      startInboundChannel('wxpusher', () => {
        const instance = createWxpusherInbound({
          config: wxResolved.config,
          bus,
          store,
          fallbackTargets: allowUsers,
          identity, // v0.7 三级目标解析：绑定成员优先
          logger,
        })
        instance.start()
        interactiveInstances.push(instance)
        replyTargets.set('wxpusher', instance)
        disposers.push(() => instance.stop())
        warn(`inbound 已启动：wxpusher HTTP 回调（密径鉴权 + 编号回复裁决）`)
        return instance
      })
    }
    // 微信 iLink inbound：getupdates 长轮询 + sendmessage 回执（裸协议，零依赖）。
    // 凭证缺省回落登录 CLI 落盘的 wechat:account；审批无按钮，靠编号回复裁决。
    if (wechatWanted) {
      const wechatResolved = resolveWechatInboundConfig(wechatRaw, { credentials: store.get(ACCOUNT_KEY) })
      if (!wechatResolved.ok) {
        warn(`inbound.wechat 跳过: ${wechatResolved.reason}`)
      } else {
        startInboundChannel('wechat', () => {
          const instance = createWechatIlinkInbound({
            config: wechatResolved.config,
            bus,
            store,
            fallbackTargets: allowUsers,
            identity, // v0.7 三级目标解析：绑定成员优先
            logger,
          })
          instance.start()
          interactiveInstances.push(instance)
          replyTargets.set('wechat', instance)
          disposers.push(() => instance.stop())
          warn(`inbound 已启动：wechat iLink 长轮询（文本审批通知 + 编号回复裁决）`)
          return instance
        })
      }
    }

    // 钉钉 Stream inbound（v0.3.1）：官方 Stream 长连接裸协议（免公网）。
    // 审批无按钮卡片，靠「回复 1 批准 / 2 拒绝」降级（router 按 capabilities 分流文案）。
    if (dingtalkOk) {
      startInboundChannel('dingtalk', () => {
        const instance = createDingtalkInbound({
          config: dingtalkResolved.config,
          bus,
          store,
          fallbackTargets: allowUsers,
          identity, // v0.7 三级目标解析：绑定成员优先
          logger,
        })
        instance.start()
        interactiveInstances.push(instance)
        replyTargets.set('dingtalk', instance)
        disposers.push(() => instance.stop())
        warn(`inbound 已启动：dingtalk Stream 长连接（文本审批通知 + 编号回复裁决）`)
        return instance
      })
    }

    // v0.6.1：路由注册同样逐个守护——审批/会话路由炸了只丢对应能力，
    // 不能拖垮整块 inbound 栈（interactiveRaw 赋值移进 try 之前保持语义）。
    let disposeApproval = () => {}
    try {
      disposeApproval = registerApprovalHandler({
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
    } catch (error) {
      warn(`approval 路由装配失败，已跳过（inbound 通道不受影响）: ${error instanceof Error ? error.message : String(error)}`)
    }

    // v0.5：通道全部挂载后才暴露交互实例列表（eventListener 的 pushActionCard 每次
    // 经 normalizeInbound 防御归一，这里的赋值只发生在装配期一次）
    interactiveRaw = interactiveInstances

    // v0.8 远程提问桥（ask_user 工具 + aq: 账本 + 编号回复兜底）。桥体在审批路由
    // 之后创建并 attach——bus.onMessage 的插入序即消费优先级：'1'/'2' 在有待决
    // 审批时由审批先消费，提问编号（含 1,3 多选）随后接管；questions.enabled=false
    // 整体关闭（不注册工具、不挂编号处理器，行为与 v0.7 逐字节一致）。
    if (resolved.questions.enabled) {
      try {
        questionsBridge = createQuestionBridge({
          bus,
          vault,
          store,
          notifier,
          interactive: () => interactiveRaw, // 惰性 getter：桥体每次裁决取最新实例表
          logger,
          config: resolved.questions,
        })
        const disposeAskTool = registerAskUserTool(ctx, questionsBridge, {
          rateLimitPerMinute: resolved.questions.rateLimitPerMinute,
          defaultTimeoutMs: resolved.questions.timeoutMs,
        })
        if (disposeAskTool !== null) disposers.push(disposeAskTool)
        questionsBridge.attach()
        disposers.push(() => questionsBridge.dispose())
        warn(`远程提问已启用：ask_user 工具（限流 ${resolved.questions.rateLimitPerMinute} 次/分钟，超时 ${Math.round(resolved.questions.timeoutMs / 1000)}s 不代答）；飞书/Telegram 单选选项卡 + 全渠道编号兜底`)
      } catch (error) {
        warn(`questions 桥装配失败，已跳过（其余能力不受影响）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

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
    try {
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
    } catch (error) {
      warn(`会话路由装配失败，已跳过（inbound 通道与审批不受影响）: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (approvalWanted) {
    // v0.7：无任何入站通道凭证时不启动（无回传通道可承载裁决）；有凭证即进入引导态。
    warn('approval 已配置但没有任何入站通道凭证：远程审批未启动。请先配置任一通道（如 inbound.telegram.botToken 或扫码落盘凭证），启动后经 /pair 配对即可使用')
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
        identity, // v0.7 成员页：与 inbound 共用同一实例（store 读收敛 → 写入半秒内热生效）
        pairing, // v0.7 配对码铸造/撤销
        guidedProbe: () => identity.isEmpty() && allowUsers.length === 0, // 与 bus.isGuided 同口径（R5-2-P2-2）
        stateDir,
        logger,
      })
      // v0.7：接通配对审计晚绑定（inbound 阶段积压的事件此刻转发 admin-audit.jsonl）
      try {
        pairingAuditSink = (action, detail) => adminApi.appendAudit(action, detail)
        for (const [action, detail] of pairingAuditBacklog.splice(0)) adminApi.appendAudit(action, detail)
      } catch { /* 审计接线失败不致命（配对功能不受影响） */ }
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
export { createQuestionBridge, registerAskUserTool } from './questions/router.mjs'
export { registerConversationRouter } from './inbound/conversation.mjs'
export { segmentText, countCodepoints, sendSegmented } from './inbound/segment.mjs'
// v0.6：开放事件源（供测试与其它插件复用）
export { PUBLIC_API_VERSION, createPublicFacade, composeOnSend, deepFreeze } from './public.mjs'
// 阶段 6：账本 / 健康自检 / 限流（供测试与其它插件复用）
export { createLedger, yesterdayWindow, classifyTitle, composeDigest } from './ledger.mjs'
export { runChannelTest, TEST_MESSAGE } from './health.mjs'
export { createRateLimiter } from './tool-register.mjs'
// v0.3.2：路由引擎（双向解析链 + 会话台账；供测试、CLI 与其它插件复用）
export { createAgentRouter } from './routing/agent-router.mjs'
export { createSessionRegistry, workspaceOf } from './routing/session-registry.mjs'
