import { createCloudflareDeploymentService } from './cloudflare/deployment.mjs'
// dsh-notifier index.mjs
// cordis 插件入口：组装配置解析、adapter 注册表、两条触发线（事件自动推送 + notify 工具）。
// 空配置绝不弄崩启动：任何渠道解析问题只 warn + 跳过（学 dsh-email）。

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { CHANNEL_TYPES, resolveConfig } from './config.mjs'
import { composeOutboundChannels, accountOf } from './assembly/outbound.mjs'
import { resolveInboundSignals } from './assembly/inbound-signals.mjs'
import { createNotifier } from './notify.mjs'
import { createEventListener } from './event-listener.mjs'
import { registerNotifyTool, registerNotifyTestTool } from './tool-register.mjs'
import { createLedger, yesterdayWindow } from './ledger.mjs'
// 阶段 4/5：inbound 回传栈（远程审批 + 会话路由）
import { createStore, defaultStateDir } from './inbound/store.mjs'
import { createInboundChannelConfigPort } from './inbound/channel-config.mjs'
import { createTokenVault } from './inbound/tokens.mjs'
import { createIdentity } from './inbound/identity.mjs'
import { createPairing } from './inbound/pairing.mjs'
import { createInboundBus } from './inbound/bus.mjs'
import { createInboundChannelRegistry } from './assembly/inbound-channels.mjs'
import { disposeAll } from './assembly/lifecycle.mjs'
import { registerApprovalHandler } from './approval/router.mjs'
import { createQuestionBridge, registerAskUserTool } from './questions/router.mjs'
import { createNativeQuestionBridge } from './host/native-questions.mjs'
// v0.15（T13）官方 Host seam：集中 optional-dependency（late inject / replacement / dispose）。
import { createHostLifetime } from './host/seam.mjs'
import { registerConversationRouter } from './inbound/conversation.mjs'
// v0.5：动作闭环（通知按钮 → 内置处置动作）
import { createActionDispatcher } from './actions.mjs'
import { createControlEntry } from './control/entry.mjs'
// v0.6：开放事件源（ctx.notifier 服务注入 + dsh-notifier/sent 事件）
import { createPublicFacade, composeOnSend, deepFreeze, redactAuditRecord } from './public.mjs'
// v0.3.2：路由引擎（双向解析链 + 会话台账，src/routing/*.mjs）
import { createAgentRouter } from './routing/agent-router.mjs'
import { createSessionRegistry } from './routing/session-registry.mjs'
// v0.15 Stage 2（R1）：当前任务选择 authority——私聊投递目标的唯一写入者与读投影。
import { createCurrentTaskAuthority } from './routing/current-task.mjs'
// v0.10 移动任务选择（歧义前置）：多活跃任务无绑定先下发选择卡；待决状态经 store 持久化
import { createTaskSelection } from './routing/task-selection.mjs'
import { runChannelTest } from './health.mjs'
import { createOutboundSource } from './runtime/outbound-source.mjs'
import { createRuntimeChannelManager } from './runtime/channel-manager.mjs'
// v0.15（T10）：渠道被移除/热替换时释放其 sender runtime（token 缓存等有限 dispose）
import { retireSenderRuntime } from './adapters/senders.mjs'
import { createSurfaceRevision } from './control-surface/revision.mjs'
import { createSurfaceActivity } from './control-surface/activity.mjs'
import { createSurfaceHealth } from './control-surface/health.mjs'
import { createOutboundConfigService } from './control-surface/outbound-config.mjs'
import { createChannelProjection } from './control-surface/channels.mjs'
import { createTaskProjection } from './control-surface/tasks.mjs'
import { createQuestionProjection } from './control-surface/questions.mjs'
import { createMembersProjection } from './control-surface/members.mjs'
import { createSessionsProjection } from './control-surface/sessions.mjs'
import { createBindingsProjection } from './control-surface/bindings.mjs'
import { createDiagnosticsService } from './control-surface/diagnostics.mjs'
import { createHostCapabilitySnapshot } from './host/capability.mjs'
import { createControlSurfaceService } from './control-surface/service.mjs'
// v0.15（Stage 1 / S1–S2）：Native v2 用户边界——只读 read model + 窄动作表，经同一路由委派。
import { createNativeReadModel } from './native/read-model.mjs'
import { createNativeActions } from './native/actions.mjs'
import { createNativeSurfaceService } from './native/register.mjs'
import { createChannelControlService } from './control-plane/channels.mjs'
import { createConfigPortabilityService } from './control-plane/config-portability.mjs'
import { createDshImBridge } from './control-plane/dsh-im-bridge.mjs'
import { createMembersControlService } from './control-plane/members.mjs'
import { createRoutingControlService } from './control-plane/sessions.mjs'
import { createQuestionsControlService } from './control-plane/questions.mjs'
import { registerControlSurfaceRpc } from './control-surface/rpc.mjs'
// lang 文案表：入站回执 / 晨报标题等手机可见文案取词（未知 lang 已在 resolveConfig 归一回落 zh）
import { stringsOf } from './strings.mjs'

export const name = 'dsh-notifier'
export const inject = ['tools', 'agents', 'connection']

/** 返回已解析配置（供测试与其它插件复用）。 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const strings = stringsOf(resolved.lang)
  const logger = ctx?.logger
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 真机可诊断性：部分宿主形态（dsh web profile）cordis logger 不落 stdout，
    // 装配/轮询类告警只走 logger = 部署问题零可见（2026-08-16 TG inbound 装配事故：
    // 出站正常 + inbound 全死 + 错误不可见，排查数轮才定位）。对齐探针「console 与
    // logger 双写」做法，warn 必须双写 stderr——宁可测试输出多几行，不可部署黑盒。
    try { console.error('[dsh-notifier]', message) } catch { /* 控制台不可用（极少数宿主）不致命 */ }
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
          ctx.emit('dsh-notifier/sent', deepFreeze(redactAuditRecord(record)))
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
    registerNotifierService(createPublicFacade({
      notifier: null,
      config: resolved.public,
      logger,
      onDispose: (dispose) => stubDisposers.push(dispose),
    }), stubDisposers)
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
  // Commit20：remoteLog.enabled 也要求账本存在——/log 的唯一数据源是 ledger.recent()。
  // 账本创建因此不与「晨报」耦合：remoteLog 单独开启时也建账本（否则 /log 恒不可用），
  // 但**晨报推送仍只由 digest.enabled 决定**（下方 if (ledgerEnabled && ...) 守卫），
  // 打开 /log 不会顺带开始发晨报。
  const remoteLogEnabled = resolved.remoteLog?.enabled === true
  let ledger = null
  if (ledgerEnabled || remoteLogEnabled) {
    const inboundRawForDir = (resolved.inbound !== null && typeof resolved.inbound === 'object') ? resolved.inbound : {}
    const ledgerDir = typeof inboundRawForDir.stateDir === 'string' && inboundRawForDir.stateDir.trim() !== ''
      ? inboundRawForDir.stateDir.trim()
      : defaultStateDir()
    ledger = createLedger({ dir: ledgerDir, maxEntries: digestRaw.maxEntries })
  }

  // 阶段 4/5：inbound 回传栈。旧 allowUsers 不授予身份或投递目标。
  // inboundRaw / approvalRaw / store 已随 v0.3.3 出站凭证回退前移到 notifier 之前。
  const inboundRaw = resolved.inbound ?? {}
  const approvalRaw = resolved.approval ?? {}
  // v0.3.1：state store 提前创建（只读加载，无写副作用）——qq/feishu/dingtalk 的
  // 扫码凭证回退在 resolve 阶段就要读 store；必须先于下方各通道的 resolve 块
  // （TDZ：声明前引用会 ReferenceError，v0.3.1 首版曾把创建放在 resolve 之后，已修）。
  // v0.3.2：进一步前移到事件监听/工具注册之前——路由引擎（router/registry）也以它为持久层。
  // Initialize the fresh outbound schema before notifier assembly.
  // createNotifier 前合并完成（§5「YAML 只做 bootstrap，运行时可变状态写 state」）。
  const stateDir = typeof inboundRaw.stateDir === 'string' && inboundRaw.stateDir.trim() !== ''
    ? inboundRaw.stateDir.trim()
    : defaultStateDir()
  const store = createStore(`${stateDir}/state.json`)
  const freshState = store.initializeFreshSchema()
  if (freshState.ok !== true) {
    warn(`v0.15 新状态初始化未完成（${freshState.reason ?? 'unknown'}），旧状态已隔离，本次启动按无持久状态运行`)
  } else if (freshState.hadLegacyState === true) {
    warn(`已备份旧状态并建立全新 v0.15 状态。首次打开 Native 时，请重新设置渠道凭证、私聊身份与任务选择；旧资料仅可离线手工查看${freshState.backupPath ? `：${freshState.backupPath}` : ''}`)
  }
  // v0.15 Stage 2（R1）：当前任务 authority 实例。conversation 与 Native 读模型共用同一实例，
  // 保证「显式选择」这一事实只有一个写入者、一个读投影，杜绝多源写入与隐式推导。
  const currentTaskAuthority = createCurrentTaskAuthority({ store, logger })
  // v0.8.7 引导码文件交付（LEAK-2）：码面写本机 0600 文件，stderr 只印路径——
  // 日志聚合（journald/Loki/ELK）不再承载 owner 级凭证。
  const BOOTSTRAP_CODE_FILE = `${stateDir}/bootstrap-paircode.txt`

  // v0.15 reads only the fresh canonical outbound schema. Legacy state has
  // already been backed up and isolated by initializeFreshSchema().
  const yamlRowOf = new Map()
  for (const row of (Array.isArray(config.channels) ? config.channels : [])) {
    if (row === null || typeof row !== 'object' || row.enabled === false) continue // 显式禁用是用户意图，不回退
    const type = typeof row.type === 'string' ? row.type.trim() : ''
    if (type !== '' && !yamlRowOf.has(type)) yamlRowOf.set(type, row)
  }
  const overlay = composeOutboundChannels({
    channels: resolved.channels,
    yamlRows: yamlRowOf,
    store,
    warn,
  })
  const outboundSource = createRuntimeChannelManager({
    source: createOutboundSource(overlay.channels, {
      onRetire: (type, config) => { retireSenderRuntime(type, config) },
    }),
    initial: overlay.channels,
  })
  resolved.channels = outboundSource.snapshot()
  const resolvedOutboundRows = new Map(overlay.channels.map((entry) => [entry.type, entry.config]))

  const surfaceRevision = createSurfaceRevision()
  const surfaceActivity = createSurfaceActivity()
  const surfaceHealth = createSurfaceHealth()
  // Inbound channel projection reads canonical configuration directly.
  // v0.13（C11.5 / R6）：运行时真值查询在 channelRegistry 装配完成后注入（惰性闭包），
  // 未装配/未启动时返回 null → active=false / restartPending=true（绝不冒充已在线）。
  let inboundRuntimeOf = null
  const inboundConfigPort = createInboundChannelConfigPort({
    store,
    warn: (message) => warn(`[dsh-notifier/inbound-config] ${message}`),
    runtime: (type) => (inboundRuntimeOf === null ? null : inboundRuntimeOf(type)),
    yamlConfigOf: (type) => inboundRaw?.[type],
  })
  const inboundProjectionApi = { getChannels: () => inboundConfigPort.rows() }

  const outboundConfigService = createOutboundConfigService({
    store,
    yamlRows: yamlRowOf,
    resolvedRows: resolvedOutboundRows,
    source: outboundSource,
    onChange: (topic) => surfaceRevision.touch(topic),
    onAudit: (topic, detail) => surfaceActivity.record('configuration', topic, {
      channel: detail?.type,
      saved: detail?.saved === true,
      deleted: detail?.deleted === true,
      hotApplied: detail?.applied === true,
    }),
  })

  const onSend = composeOnSend([
    ledger === null ? null : (record) => ledger.append(record),
    (record) => {
      surfaceHealth.recordSend(record)
      surfaceActivity.recordDelivery(record)
      surfaceRevision.touch('delivery')
    },
    emitSend,
  ])

  const notifier = createNotifier(ctx, outboundSource, { segment: resolved.segment, routing: resolved.routing, onSend })

  const disposers = []
  disposers.push(() => outboundSource.dispose())
  // v0.15（T13）：宿主可选依赖的单一生命周期入口。装配层不再裸调 ctx.inject——late inject
  // （服务晚出现）、replacement（服务重建后子插件重放）与 dispose（插件卸载释放全部登记）
  // 都经此收敛；无 ctx.inject 的宿主/测试桩立即以根 ctx 直连（局部降级，绝不阻断装配）。
  const hostLifetime = createHostLifetime(ctx, { warn })
  disposers.push(() => hostLifetime.dispose())
  // Runtime lifecycle changes are revision-visible without conflating them
  // with desired config changes.  Consumers still read the live manager.
  disposers.push(outboundSource.subscribe((event) => {
    surfaceRevision.touch(event?.topic === 'runtime' ? 'runtime' : 'channels')
    // v0.15（T12）：runtime 实例世代前进（replace/remove/replaceAll）→ 旧实例的迟到健康
    // 观察一律作废，绝不污染新实例的观察面（「断线旧 epoch 观察不污染新实例」）。
    if (event?.topic === 'runtime' && typeof event.type === 'string' && event.type !== '') {
      surfaceHealth.markEpoch(event.type, event.generation)
    }
  }))

  // v0.6 公共面装配（设计稿 §2.5）：notifier 之后创建 facade 并注册服务。public.enabled:false
  // → stub 形态（push 返回 skipped:(disabled)），服务照常提供（消费插件的启动依赖不能断）。
  // sink = 限流拦截的直落点：限流记录照进账本 + 照发 sent 事件（静音不等于没发生，§3.3）。
  const publicFacade = createPublicFacade({
    notifier: resolved.public?.enabled !== false ? notifier : null,
    config: resolved.public,
    logger,
    onSend,
    onDispose: (dispose) => disposers.push(dispose),
  })
  registerNotifierService(publicFacade, disposers)

  // v0.6.3 state 瘦身（审查 R2 P1-4）：dedup:*/ap:*/act:* 历史上只增不删（bus 每条
  // 入站消息落一个 dedup 键、审批/动作核销后账本行永留），长跑进程 state.json 单调
  // 膨胀且全量重写随之变慢。定期清扫：dedup 窗口 24h（留 1h 余量防时钟回拨），已决
  // 审批/动作保留 24h 供审计，超期即删（首启 + 每 6h；sweepPrefix 走脏键合并写，
  // 与 CLI/他进程并发写互不覆盖）。pending 行仅在超过活 waiter 合法寿命后清扫，
  // observe 审批与无法分类的旧行保留。
  // v0.6.4：dedup 清扫线联动 bus 窗口（窗口可配时硬编码 25h 会误清未过期键或漏清）;
  // bus 在白名单块才创建（可能不创建），sweep 注册在前——用外层惰性引用兜住。
  let sweepBusRef = null
  {
    const approvalTimeoutMs = Math.max(1000, Number(approvalRaw.timeoutMs) || 120000)
    const questionTimeoutMs = Math.max(1000, Number(resolved.questions?.timeoutMs) || 300000)
    const orphanHorizonMs = Math.max(2 * 60 * 60 * 1000, approvalTimeoutMs * 2, questionTimeoutMs * 2)
    const sweepOnce = () => {
      try {
        const windowMs = sweepBusRef?.dedupWindowMs ?? 24 * 60 * 60 * 1000
        const horizon = Date.now() - windowMs - 60 * 60 * 1000 // 窗口 + 1h 时钟回拨余量
        store.sweepPrefix('dedup:', (_key, seenAt) => typeof seenAt !== 'number' || seenAt < horizon)
        const resolvedHorizon = Date.now() - 24 * 60 * 60 * 1000
        const expiredRow = (_key, row) => row?.status === 'resolved'
          && typeof row.resolvedAt === 'number' && row.resolvedAt < resolvedHorizon
        const orphanPending = (_key, row) => row?.status === 'pending'
          && typeof row.createdAt === 'number' && row.createdAt < Date.now() - orphanHorizonMs
        const apExpired = (_key, row) => expiredRow(_key, row)
          || (orphanPending(_key, row) && row?.mode === 'answer')
        store.sweepPrefix('ap:', apExpired)
        store.sweepPrefix('act:', (_key, row) => expiredRow(_key, row) || orphanPending(_key, row))
        store.sweepPrefix('aq:', (_key, row) => expiredRow(_key, row) || orphanPending(_key, row))
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
    currentTask: currentTaskAuthority,
    agentsList: () => { try { return ctx.agents.list() } catch { return [] } },
  })
  disposers.push(() => registry.dispose())
  // v0.10 任务选择状态机（歧义前置）：候选惰性过滤为「仍活跃会话」，待决经 store 持久化
  // （taskselect:* 键域，重启不丢）。dispose 只清内存态（盘上待决由 TTL 惰性回收）。
  const taskSelection = createTaskSelection({
    store,
    isActive: ({ sessionId }) => { try { return registry.isActive(sessionId) === true } catch { return false } },
    logger,
  })
  // v0.10 待关注事项判定器（任务投影 attention + /tasks ⚠ 标记）：question 待决即标 attention。
  // questionsBridge 晚装配（questions.enabled 块），本闭包惰性读取，装配前恒 false。
  const attentionOf = (taskRef) => {
    try {
      const ids = questionsBridge?.pendingAgentIds?.()
      return ids instanceof Set && ids.has(String(taskRef))
    } catch { return false }
  }

  // v0.5 动作闭环的装配时序（架构审查修正，设计稿 §6）：eventListener 装配早于
  // inbound 白名单块（vault/store/通道在其后才创建），直传实例不可行——用惰性
  // getter（先例 = 下方 registerNotifyTool 的 channelTypes: () => ...）。
  // 未配置任何 inbound（白名单空）→ actions 永不创建 → getter 恒 null → 通知文本
  // hint「回复 /stop 取消」仍全通道可达，动作卡片自然缺席——兼容红线自洽。
  let actionsRef = null
  let interactiveRaw = []
  let busRef = null
  let questionsBridge = null
  let nativeBridge = null
  // v0.14（S04）：远程提问结算契约由 Native RPC 与宿主原生桥共用。
  // 桥未装配时为「无桥」服务（待决空表 / 结算 fail-closed）；桥装配后重新绑定同一实例。
  let questionsControl = createQuestionsControlService()
  // v0.10 提交7：宿主事件 registrar 快照（管理台 /host 的 events.received 视图）
  // 与图片入站能力标记（会话路由装配成功即 available）。惰性读取，装配前为 null/false。
  let hostEventsRegistrar = null
  let conversationRouterActive = false
  const questionsForChannels = {
    decide: (payload) => questionsBridge?.decide(payload) ?? { ok: false, message: strings.index.questionsNotReady },
  }
  disposers.push(createEventListener(ctx, notifier, resolved, {
    router,
    registry,
    bus: () => busRef,
    actions: () => actionsRef,
    interactive: () => interactiveRaw,
    onHostEvents: (registrar) => { hostEventsRegistrar = registrar }, // 诊断快照外泄（提交7）
  }))
  const disposeTool = registerNotifyTool(ctx, notifier, {
    rateLimitPerMinute: resolved.toolRateLimitPerMinute,
    router,
    channelTypes: () => outboundSource.types(),
  })
  if (disposeTool != null) disposers.push(disposeTool)
  const disposeTestTool = registerNotifyTestTool(ctx, notifier, { rateLimitPerMinute: resolved.toolRateLimitPerMinute, strings })
  if (disposeTestTool != null) disposers.push(disposeTestTool)

  // 启动期晨报：昨日有记录且今天还没发过 → 推一次摘要（passive 级，走正常路由）。
  // Commit20：守卫必须看 **digest.enabled**（ledgerEnabled），而非「账本存在」——账本现在
  // 也可能仅因 remoteLog.enabled 而建（/log 数据源），此时绝不该顺带发晨报。
  if (ledgerEnabled && ledger !== null) {
    try {
      const window = yesterdayWindow()
      if (ledger.lastDigestDate() !== window.dateStr) {
        const summary = ledger.summarize(window.fromMs, window.toMs, { fromLabel: window.fromLabel, toLabel: window.toLabel })
        if (summary.counts.total > 0) {
          notifier.notifyAll({ title: strings.digest.title, content: ledger.compose(summary, strings), level: 'passive' })
            .catch(() => { /* 摘要推送失败不影响启动 */ })
          ledger.markDigestDone(window.dateStr)
        }
      }
    } catch { /* 晨报任何异常静默：账本绝不拖累启动 */ }
  }

  // 阶段 4：inbound 通道 resolve/启用信号（六个通道的显式配置/store 凭证即启用判定 +
  // tg 便捷回退 + wxpusher 密径持久化）。维护批 3 阶段 3 抽到
  // src/assembly/inbound-signals.mjs resolveInboundSignals（原样搬移，行为零变；
  // 详注随模块走）。inboundRaw / approvalRaw / store 已随 v0.3.2 路由装配前移到 notifier 之后创建。
  const {
    tgRaw, // 入站 telegram 原始行（装载块 config.apiBase 晚用）
    inboundBotToken,
    notifyChatIds,
    approvalWanted,
    feishuResolved, feishuOk,
    qqResolved, qqOk,
    dingtalkResolved, dingtalkOk,
    wxResolved, wxOk,
    wechatWanted, wechatRaw, // 微信 resolve 在 guided 装配块内晚绑定 resolveWechatInboundConfig
  } = resolveInboundSignals({
    inboundRaw, approvalRaw, resolved, store, warn,
    privateChatEnabled: (type) => inboundConfigPort.privateChatAllowed(type)
      && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.[type]?.enabled === true),
  })
  const privateChatRuntimeEnabled = (type) => {
    if (inboundConfigPort.privateChatAllowed(type) !== true) return false
    return ({
      telegram: String(inboundBotToken ?? '').trim() !== ''
        && String(inboundRaw?.telegram?.accountId ?? '').trim() !== ''
        && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.telegram?.enabled === true),
      feishu: feishuOk && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.feishu?.enabled === true),
      qq: qqOk && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.qq?.enabled === true),
      dingtalk: dingtalkOk && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.dingtalk?.enabled === true),
      wxpusher: wxOk && String(inboundRaw?.wxpusher?.accountId ?? '').trim() !== ''
        && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.wxpusher?.enabled === true),
      wechat: wechatWanted && (inboundConfigPort.privateChatEnabled(type) || inboundRaw?.wechat?.enabled === true),
    })[type] === true
  }

  // v0.15: identity rows are created only by an explicit private pairing action.
  // Legacy YAML allowUsers is not migrated into authorization state.
  // Identity and pairing authorities are shared by private admission and Native controls.

  // v0.8.7 引导码文件写入辅助（方案A）：码面写本机 0600 文件，不流经 warn/stderr。
  const writeBootstrapCodeFile = (code) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      // 写前先删：已存在的 symlink 会被 writeFileSync 跟随写穿到目标（本地提权面）
      try { unlinkSync(BOOTSTRAP_CODE_FILE) } catch { /* 不存在即已达目的 */ }
      writeFileSync(BOOTSTRAP_CODE_FILE, `${code}\n`, { encoding: 'utf8', mode: 0o600 })
      // mode 只在新建时生效，既有文件（如 umask 异常）补一刀
      try { chmodSync(BOOTSTRAP_CODE_FILE, 0o600) } catch { /* 权限收紧失败不致命，下方仍有码文件 */ }
      return true
    } catch (error) {
      // 失败只报路径与原因，绝不回退把码面印进日志（LEAK-2 的修复点就在这）
      warn(`引导码文件写入失败: ${error instanceof Error ? error.message : String(error)}（引导码无法文件交付，请到宿主 Native 界面的「成员」页铸码）`)
      return false
    }
  }
  const clearBootstrapCodeFile = () => {
    try { unlinkSync(BOOTSTRAP_CODE_FILE) } catch { /* 不存在即已达目的（幂等） */ }
  }
  const identity = createIdentity({ store, logger })
  // Control Core：所有远程控制回调共用一个入口；personal 默认只允许已配对私聊，
  // converse/group control 必须由显式 policy 开启。
  // Session control overlays are read through the registry's defensive
  // copy-on-read API.  The resolver is intentionally fail-closed at the
  // integration boundary: a missing session, malformed store row, or registry
  // exception returns null, preserving the static policy and all existing
  // source-binding checks in Control Core.  The overlay itself can never add
  // channel/account/user/chat/session fields (session-arbiter owns that shape).
  const control = createControlEntry({
    policy: inboundRaw.control ?? {},
    identity,
    logger,
    privateChatEnabled: privateChatRuntimeEnabled,
    policyForSession: (sessionId) => {
      try { return registry?.getControl?.(sessionId) ?? null } catch { return null }
    },
  })
  disposers.push(() => control.dispose())
  const pairing = createPairing({
    store,
    logger,
    onAudit: (event, detail) => {
      // v0.8.7 (A2)：bootstrap 码进终态即删码文件（核销/过期/撤销含 re-mint 替换旧码）。
      if (detail?.origin === 'bootstrap' && (event === 'redeem' || event === 'expire' || event === 'revoke')) {
        clearBootstrapCodeFile()
      }
      try {
        surfaceActivity.record('pairing', `pairing:${event}`, { channel: detail?.channel })
      } catch { /* 审计失败不致命 */ }
    },
  })
  const guidedBoot = identity.isEmpty()
  // v0.8.7 (A2)：非引导态清理陈旧引导码文件（重启后引导态已结束，旧码面不该残留）。
  if (!guidedBoot) clearBootstrapCodeFile()

  // Transport credentials and legacy allowUsers never create a principal. The guided
  // private pairing command is the only path that grants an identity row.
  const anyChannelReady = ['telegram', 'feishu', 'qq', 'dingtalk', 'wxpusher', 'wechat']
    .some((type) => privateChatRuntimeEnabled(type))
  const inboundReady = anyChannelReady
  if (inboundReady) {
    // v0.8.7 引导码文件交付（LEAK-2）：码面写本机 0600 文件，stderr 只印路径+ID——
    // 日志聚合不再承载 owner 级凭证。绑定表非空后不再铸造。
    const showBootstrap = (minted) => {
      if (minted?.ok !== true) {
        if (minted?.reason === 'storage-failed') {
          // 配对码未持久化时绝不展示码面；仍给出与文件交付失败一致的可操作指引。
          warn('引导码文件写入失败（配对码未持久化，请勿使用未落盘码面）')
          warn('【引导配对码】文件写入失败，请到宿主 Native 界面的「成员」页铸码')
        }
        return
      }
      const minutes = Math.max(1, Math.round((minted.expiresAt - Date.now()) / 60000))
      if (writeBootstrapCodeFile(minted.code)) {
        warn(`【引导配对码】已写入 ${BOOTSTRAP_CODE_FILE}（${minutes} 分钟内有效，仅本机用户可读）\n  在任意已启用通道私聊机器人发送：/pair <配对码>\n  查看配对码：cat ${BOOTSTRAP_CODE_FILE}`)
      } else {
        warn(`【引导配对码】文件写入失败，请到宿主 Native 界面的「成员」页铸码（${minutes} 分钟内有效）`)
      }
    }
    if (guidedBoot) {
      try {
        showBootstrap(pairing.mint({ origin: 'bootstrap', mintedBy: 'system:boot' }))
      } catch (error) {
        warn(`bootstrap 引导码铸造失败（注册面仍可用，可到宿主 Native 界面的「成员」页补铸）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const vault = createTokenVault({
      secret: typeof inboundRaw.tokenSecret === 'string' && inboundRaw.tokenSecret !== ''
        ? inboundRaw.tokenSecret
        : undefined,
    })
    const bus = createInboundBus({
      identity,
      pairing,
      store,
      vault,
      logger,
      privateChatEnabled: privateChatRuntimeEnabled,
      strings, // lang 文案表：身份命令回执（/pair /whoami /unpair）经 bus 传入 commandHandler
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
    const actions = createActionDispatcher({ vault, store, logger, control }, strings)
    actions.register('turn/cancel', ({ payload }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (sessionId === '') return { ok: false, message: strings.stop.invalidSession }
      let agent = null
      try { agent = ctx.agents.get(sessionId) } catch { return { ok: false, message: strings.stop.queryFailed } }
      if (agent === undefined || agent === null) {
        return { ok: false, message: strings.stop.notFound }
      }
      try {
        agent.cancel({ kind: 'user' }) // Host P0-B：structured AgentCancelCause（远程手机用户 = {kind:'user'}）
        return { ok: true, message: strings.stop.stopped }
      } catch {
        return { ok: false, message: strings.stop.cancelFailed }
      }
    })
    actionsRef = actions
    disposers.push(() => actions.dispose())

    // v0.3.0 多通道装配：registry 只负责 transport 实例、回执目标与停机；
    // Control Core、审批、提问和会话语义仍由各自模块持有。
    const channelRegistry = createInboundChannelRegistry({
      inboundBotToken,
      tgRaw,
      notifyChatIds,
      feishuOk,
      feishuResolved,
      qqOk,
      qqResolved,
      wxOk,
      wxResolved,
      wechatWanted,
      wechatRaw,
      dingtalkOk,
      dingtalkResolved,
      bus,
      vault,
      store,
      identity,
      actions,
      questions: questionsForChannels,
      control,
      strings, // lang 文案表：透传给各渠道适配器（回执/卡片文案随 lang）
      guidedBoot,
      telegramReadyMessage: () => `inbound 已启动：telegram 长轮询（绑定 ${identity.size()} 人${guidedBoot ? '，引导态：等待 /pair 配对' : ''}；审批模式 ${approvalRaw.mode === 'answer' ? 'answer（远程可决）' : approvalWanted ? 'observe（只旁观）' : '未配置'}）`,
      logger,
      warn,
    })
    const { interactiveInstances, replyTargets, runtimeOf } = channelRegistry
    // v0.13（C11.5 / R6）：入站 transport 装配成功后把运行时真值查询接进配置端口。
    inboundRuntimeOf = runtimeOf
    disposers.push(() => channelRegistry.dispose())

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
        identity, // CRACK-003 编号回复归属校验：owner 才能代决非本人卡片
        control,
        interactive: interactiveInstances,
        approvalConfig: approvalRaw,
        router, // v0.3.2 审批分流：request.agent 可解析时只发绑定通道（quiet 对审批不生效）
        redaction: resolved.redaction, // S-05：审批推送 reason 按 minimal/extended 决定是否打码
        logger,
      }, strings)
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
          identity, // CRACK-004 hint 兜底编号回复归属闸：仅该渠道 owner 可代答，缺失 fail-closed
          control,
          interactive: () => interactiveRaw, // 惰性 getter：桥体每次裁决取最新实例表
          logger,
          config: resolved.questions,
        }, strings)
        // v0.14（S04）：把共享提问控制服务绑定到刚装配的桥。
        questionsControl = createQuestionsControlService({ bridge: questionsBridge })
        const disposeAskTool = registerAskUserTool(ctx, questionsBridge, {
          rateLimitPerMinute: resolved.questions.rateLimitPerMinute,
          defaultTimeoutMs: resolved.questions.timeoutMs,
        })
        if (disposeAskTool !== null) disposers.push(disposeAskTool)
        questionsBridge.attach()
        disposers.push(() => questionsBridge.dispose())
        // v0.10 宿主原生提问桥（任务书 3.2）：经宿主公开 seam 桥接原生 ask_user_question；
        // 当前 DSH rc.1 的正式 seam 是 `user-questions/request` waterfall（registerProvider
        // 仅 future/legacy feature probe）；seam 缺失/被占用时安全降级（nativeBridge.capabilities()
        // 反映降级，管理台据此展示）。绝不伪造原生桥。
        // #27：(a) 服务读取改为防御式（ctx.get 非抛错，见 host/capability.mjs），探测不再
        // 炸装配；(b) attach 不再依赖静态 inject 声明（cordis 4.0.2 required-inject 会在
        // 宿主缺 userQuestions 服务时让整插件拒绝加载、通知全哑），改用 ctx.inject 运行时
        // 可选依赖——服务就绪才激活，宿主无该服务时桥静默 unsupported、其余能力照常。
        // canDeliver：入站交互通道空表时拦截器不截流（GUI-only 行为与未装插件一致）。
        nativeBridge = createNativeQuestionBridge({
          ctx,
          questionBridge: questionsBridge,
          questionsControl, // Pending questions and settlement share one entry point
          logger,
          canDeliver: () => Array.isArray(interactiveRaw) && interactiveRaw.length > 0,
        })
        disposers.push(() => nativeBridge.dispose())
        const reportNativeBridge = () => {
          const caps = nativeBridge.capabilities()
          warn(`宿主原生提问桥 ${caps.attached ? `已 attach（${caps.mode}）` : `未 attach（seam=${caps.seam}${caps.error !== null ? `, error=${caps.error}` : ''}，降级 unsupported）`}`)
        }
        // v0.15（T13）：optional-dependency 生命周期走 hostLifetime（捕获撤销句柄、随插件
        // dispose 释放），不再裸调 ctx.inject。子插件回调第一参数 = 可选依赖子上下文：
        // waterfall 监听器注册在它上面，随 userQuestions 服务的 fiber 生命周期自动撤销/重放
        // （服务替换后自动重挂）；无 ctx.inject 的宿主/测试桩由 hostLifetime 直连 attach。
        hostLifetime.inject(['userQuestions'], (subCtx) => { nativeBridge.attach(subCtx); reportNativeBridge() }, { label: 'userQuestions' })
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
        control,
        channelTypes: () => outboundSource.types(), // 全局渠道池动态白名单（分流过滤随热应用收敛）
        // v0.10 移动任务路由（任务书提交5）：歧义前置选择卡 + /tasks ⚠ 待关注标记
        taskSelection,
        attentionOf,
        // Commit20：/log 三重依赖——identity（owner 判定，channel-scoped）、ledger（只读
        // recent() 数据源）、remoteLog（开关与上限）。三者任一缺失即 fail-closed。
        identity,
        ledger,
        remoteLog: resolved.remoteLog,
        // R1：任务选择唯一写入者（与 Native 读模型同实例）。
        currentTask: currentTaskAuthority,
        logger,
      }, strings)
      disposers.push(disposeConversation)
      conversationRouterActive = true // 提交7：会话路由（含图片投递）已装配 → 管理台图片入站标 available
    } catch (error) {
      warn(`会话路由装配失败，已跳过（inbound 通道与审批不受影响）: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (approvalWanted) {
    // v0.7：无任何入站通道凭证时不启动（无回传通道可承载裁决）；有凭证即进入引导态。
    warn('approval 已配置但没有任何入站通道凭证：远程审批未启动。请先配置任一通道（如 inbound.telegram.botToken 或扫码落盘凭证），启动后经 /pair 配对即可使用')
  }

  // v0.12 Native Control Surface. Existing projections remain the only authorities.
  const surfaceTasks = createTaskProjection({
    getTasks: () => {
      try {
        return tasksSnapshot({ ctx, registry, router, channelTypes: outboundSource.types(), attentionOf })
      } catch {
        return { count: 0, activitySorted: false, tasks: [] }
      }
    },
  })
  // v0.14（S04）：Native `questions.list`/`questions.settle` 走共享提问控制服务
  // Shared question settlement; this layer only maps RPC shapes.
  const surfaceQuestions = createQuestionProjection({ service: questionsControl })
  const surfaceChannels = {
    list: () => createChannelProjection({
      outboundSource,
      outboundConfig: outboundConfigService,
      inboundConfig: inboundConfigPort,
      adminApi: inboundProjectionApi,
      health: surfaceHealth,
    }).list(),
    get: (type) => createChannelProjection({
      outboundSource,
      outboundConfig: outboundConfigService,
      inboundConfig: inboundConfigPort,
      adminApi: inboundProjectionApi,
      health: surfaceHealth,
    }).get(type),
  }
  // v0.14（S01）：Native channel write orchestration。
  // 两个适配器都只调用它，谁都不再持有第二套写入/测试编排逻辑（I1 / I9）。
  const channelControl = createChannelControlService({
    outboundConfig: outboundConfigService,
    inboundConfig: inboundConfigPort,
    channelTest: (type, raw) => runChannelTest({ type, rawConfig: raw, strings }),
  })
  // v0.14（S02）：Native membership and pairing orchestration。
  // 谁都不再直接持有成员/配对写入编排（I1 / I9）；实例在装配处创建，非 admin 私有，
  // 后续 S06/S07 Native surface 可直接复用同一实例。
  const membersControl = createMembersControlService({ identity, pairing })
  // v0.14（S06）：Native member view uses the shared MembersControlService（S02）实例；
  // 本层只做 `members.*` 的 RPC 形态映射。
  const surfaceMembers = createMembersProjection({ service: membersControl })
  // v0.14（S03/S08）：Native session and routing orchestration. The adapter calls this service,
  // 谁都不再持有第二套会话投影 / 路由覆盖写入编排（I1 / I9）。
  const routingControl = createRoutingControlService({ router, registry, store, warn })
  const surfaceSessions = createSessionsProjection({
    service: routingControl,
    enabledTypes: () => { try { return outboundSource.types() } catch { return [] } },
  })
  // v0.14（S09）：Native 高级绑定面，与 Sessions 共用同一路由控制单例（同一 canonical 事实）。
  const surfaceBindings = createBindingsProjection({ service: routingControl })
  // v0.14（S10）：只读 canonical 诊断快照。只观察，不写状态、不自动修复；版本取自 package.json。
  const pluginVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'
    } catch { return 'unknown' }
  })()
  const surfaceDiagnostics = createDiagnosticsService({
    version: pluginVersion,
    revision: surfaceRevision,
    hostCapabilities: () => {
      try {
        return createHostCapabilitySnapshot({
          ctx,
          events: hostEventsRegistrar !== null ? hostEventsRegistrar.snapshot() : null,
          questionsFallbackEnabled: questionsBridge !== null,
          webLocal: 'available',
          imageInput: conversationRouterActive ? 'available' : 'unknown',
        })
      } catch {
        return createHostCapabilitySnapshot({ ctx: {}, events: null })
      }
    },
    storage: () => store.bootStatus?.() ?? { readFailed: false },
    channels: surfaceChannels,
    questions: surfaceQuestions,
    sessions: surfaceSessions,
    bindings: surfaceBindings,
    members: surfaceMembers,
    activity: surfaceActivity,
  })
  // v0.15（T21）：本地配置导出 / 导入。导入走 canonical 权威（outboundConfig / inboundConfigPort），
  // 新渠道只落 disabled 暂存（装配永不读取该键域），绝不自动启用或发测试。
  const surfacePortability = createConfigPortabilityService({
    store,
    outboundConfig: outboundConfigService,
    inboundConfig: inboundConfigPort,
    version: pluginVersion,
  })
  // v0.15（T22）：可选 dsh-im 投递桥接。它是唯一触碰 ctx.dshIm 的模块，不持有任何持久键——
  // 不透明 (botId, targetId) 引用由 Native 客户端持于其 desired；这里只把桥接注入控制面。
  // 每次操作都重新防御读取 ctx.dshIm，故服务晚注入/撤销/重建天然可见（D01/D02）。
  const surfaceDshIm = createDshImBridge({ ctx, warn })
  const surfaceCloudflare = createCloudflareDeploymentService({ store, root: `${stateDir}/cloudflare`, outboundConfig: outboundConfigService, inboundConfig: inboundConfigPort })
  disposers.push(() => surfaceCloudflare.dispose())
  // v0.15（Stage 1 / S1–S2）：Native v2 边界实例。只读 read model 组合既有已脱敏投影；
  // 写动作每个只调一个既有 authority（channelControl / questionsControl / membersControl）。
  // 记账归属与旧 service 逐条一致，绝不双记。
  const nativeReadModel = createNativeReadModel({
    channels: surfaceChannels,
    members: surfaceMembers,
    questions: surfaceQuestions,
    tasks: surfaceTasks,
    // R1：当前任务读投影——只回显用户显式选择（owner 维度的 bind 键），绝不从投影推导。
    selectedTaskRef: (owner) => currentTaskAuthority.get(owner),
    revision: surfaceRevision,
    storageStatus: () => {
      const boot = typeof store.bootStatus === 'function' ? store.bootStatus() : { readFailed: false }
      return boot
    },
    setupStatus: () => store.get('state:setup', null),
  })
  const nativeActions = createNativeActions({
    currentTask: currentTaskAuthority,
    tasks: surfaceTasks,
    channelControl,
    health: surfaceHealth,
    revision: surfaceRevision,
    activity: surfaceActivity,
    questions: surfaceQuestions,
    members: surfaceMembers,
    // 用户动作给的是不透明 id（read-model 产出），在此解析回内部成员键——键形状永不进浏览器。
    resolveUserId: (id) => nativeReadModel.memberKeyOf(id),
  })
  const nativeService = createNativeSurfaceService({ readModel: nativeReadModel, actions: nativeActions })
  // Stage 4（S405）：daily surface 只装配 Native 窄动作表 + 显式 secondary allowlist 所需的依赖。
  // 旧 compatibility switch 已删除——通道/成员/会话/路由的写入权威只剩 Native 动作表。
  const surfaceService = createControlSurfaceService({
    native: nativeService,
    cloudflare: surfaceCloudflare,
    revision: surfaceRevision,
    diagnostics: surfaceDiagnostics,
    portability: surfacePortability,
    dshIm: surfaceDshIm,
    activity: surfaceActivity,
  })
  // v0.12：Native 通道挂在宿主 HTTP server 上（`/dsh-notifier` prefix 路由），与宿主 connection
  // 插件挂 `/api` 同款，故注册方必须能同时访问 connection（准入）与 webServer（挂路由）。
  // 真机 0.1.7-rc.2 已复现：宿主 `connection.rpc.handle` 自身不可用（owner ctx 未声明 webServer），
  // 详见 src/control-surface/rpc.mjs 文件头。webServer 只在 web profile 存在，故走条件注入；
  // tui/headless 等无 webServer 的 profile 不装配、静默降级为 Standalone。
  const mountSurfaceRpc = (rpcCtx) => {
    try {
      const disposeSurfaceRpc = registerControlSurfaceRpc(rpcCtx, surfaceService)
      if (typeof disposeSurfaceRpc === 'function') disposers.push(() => { try { disposeSurfaceRpc() } catch {} })
      else warn('Native Control Surface 无可用宿主接缝，已降级为 Standalone')
    } catch (error) {
      warn('Native Control Surface RPC 装配失败，已降级为 Standalone: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  // v0.15（T13）：同一 hostLifetime 收敛 optional-dependency（late inject / replacement / dispose）。
  hostLifetime.inject(['connection', 'webServer'], (webCtx) => mountSurfaceRpc(webCtx), { label: 'connection,webServer' })
  disposers.push(() => {
    surfaceRevision.dispose()
  })



  ctx.effect(() => () => {
    // 聚合可 await 的清理（事件监听的 flush、通道和管理台 stop 都在此收敛）。
    return disposeAll(disposers)
  })

  if (outboundSource.types().length === 0) {
    warn(`未配置任何可用渠道（已跳过 ${resolved.skipped.length} 个配置项），事件推送与 notify 工具将无操作；可在 DSH Native Control Surface 或 profile 配置 channels`)
  } else {
    warn(`已启用渠道：${outboundSource.types().join('、')}`)
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
// Provider facades: transport-specific entry points with capability evidence.
export { createTelegramTransport, TELEGRAM_CAPABILITIES, normalizeTelegramCallback } from './channels/telegram/index.mjs'
export { createFeishuTransport, resolveFeishuInboundConfig as resolveFeishuTransportConfig, FEISHU_CAPABILITIES, normalizeFeishuCallback } from './channels/feishu/index.mjs'
export { createQqInbound, resolveQqInboundConfig } from './inbound/qq-gw.mjs'
export { createWxpusherInbound, resolveWxpusherInboundConfig } from './inbound/wxpusher-callback.mjs'
export { createWechatIlinkInbound, resolveWechatInboundConfig } from './channels/wechat-ilink/index.mjs'
export { registerApprovalHandler } from './approval/router.mjs'
export { createEscalationChain } from './approval/escalation.mjs'
export { createQuestionBridge, registerAskUserTool } from './questions/router.mjs'
export { createNativeQuestionBridge } from './host/native-questions.mjs'
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
