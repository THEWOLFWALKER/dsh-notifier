// dsh-notifier inbound/conversation.mjs
// 会话路由器（阶段 5 + v0.3.2 路由引擎）：手机回复 → 送进正在跑的 agent。
// 三个投递语义（对齐宿主 Agent API，见 docs/subsystems/core.md）：
//  - followup：agent 空闲 → 作为下一轮输入并唤醒（「任务做完了，再做一件」）
//  - inject：  agent 忙碌 → 排队到下一步边界，不唤醒不打断（排队补料）
//  - steer：   `!` 前缀 → 就近纠偏；空闲时等价 followup（「马上改，别跑偏」）
// 命令集：/help /status /bind <sessionId> /unbind /stop /agent [/agent use|back] /route
//         /quiet <workspace|sid> /unquiet <workspace|sid>（v0.5 特性 C：静默/恢复会话出站推送）
// v0.3.2 入站去向（注入 router 时，设计稿 §3）：
//   显式 bind > 通道默认 agent（workspace 多活跃会话投最近活跃 + 消歧回执）
//   > 唯一 agent 兜底 > 最近活跃（现状）。router 缺省时保持 v0.3.1 旧行为（bind > latest）。
// 军规：入站文本只能以 dsh-notifier 自有来源进会话流（Host P0-A：source.kind =
// 'dsh-notifier'，淘汰 plugin kind），永不直接执行 shell；任何投递异常只回执用户，
// 绝不弄崩宿主。

import { stringsOf } from '../strings.mjs'
import { workspaceOf } from '../routing/session-registry.mjs'
import { projectTasks } from '../routing/task-projection.mjs'
import { CHANNEL_TYPES, REMOTE_LOG_DEFAULT_LINES, REMOTE_LOG_HARD_MAX_LINES, REMOTE_LOG_HARD_MAX_BYTES } from '../config.mjs'
import { maskSecrets } from '../redact.mjs'
import { chatScopeOf } from '../control/session-arbiter.mjs'
import { bindingKey as identityBindingKey } from './identity.mjs'
import { deleteDurable, setDurable } from './store.mjs'
import { MESSAGE_PRIORITY } from './bus.mjs'
import {
  normalizeImageAttachment, normalizeFileAttachment, normalizeAttachmentItem,
  downloadInboundImageBytes, downloadInboundFileBytes, INBOUND_KINDS,
  MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES,
} from './message.mjs'
import { readAttachments, admitInboundImage, admitInboundFile, buildRemoteUserMessage } from '../host/messages.mjs'

const DEFAULT_MERGE_WINDOW_MS = 1500
export const MAX_MERGE_KEYS = 256
export const MAX_MERGE_PARTS = 32
export const MAX_MERGE_UTF8_BYTES = 64 * 1024
export const MAX_MERGE_ABSOLUTE_AGE_MS = 30_000
/** 各 P0 通道「附件-only」占位正文（wechat/qq/dingtalk 沿用）；投递时不得把它当真实文本交给模型。 */
const IMAGE_PLACEHOLDER_TEXT = '[图片消息]'
const FILE_PLACEHOLDER_TEXT = '[文件消息]'
/** 占位正文白名单：仅在信封确有附件时才剥离，纯文本用户真发 `[文件消息]` 不受影响。 */
const ATTACHMENT_PLACEHOLDER_TEXTS = new Set([IMAGE_PLACEHOLDER_TEXT, FILE_PLACEHOLDER_TEXT])

// 入站解析来源层的展示标签随 lang 在使用点解析（t.inboundSourceLabels，与
// agent-router 的 source 值一一对应）。

/** zh 兜底（strings 未注入时的回落）：单一事实源 = stringsOf().conversation（无内联副本）。 */
const ZH_FALLBACK = stringsOf().conversation

/**
 * 归一信封上的全部附件（#36）：新结构 `envelope.attachments[]` 为规范形状，逐项经
 * normalizeAttachmentItem（未知 kind / 畸形项丢弃，fail-closed）；同时兼容过渡期的单项
 * `envelope.image` / `envelope.file`（wechat-ilink / dingtalk / wxpusher 等仍产单项形状）。
 * 同一 kind 已有新结构项时不重复追加旧字段，避免 QQ 同时填两处造成重复投递。
 * @param {object} envelope
 * @returns {Array<{ kind: 'image', image: object } | { kind: 'file', file: object }>}
 */
function collectAttachments(envelope) {
  const list = []
  if (Array.isArray(envelope?.attachments)) {
    for (const item of envelope.attachments) {
      const normalized = normalizeAttachmentItem(item)
      if (normalized !== null) list.push(normalized)
    }
  }
  if (!list.some((item) => item.kind === INBOUND_KINDS.image)) {
    const image = normalizeImageAttachment(envelope?.image)
    if (image !== null) list.unshift({ kind: INBOUND_KINDS.image, image })
  }
  if (!list.some((item) => item.kind === INBOUND_KINDS.file)) {
    const file = normalizeFileAttachment(envelope?.file)
    if (file !== null) list.push({ kind: INBOUND_KINDS.file, file })
  }
  return list
}

/** 纯附件（无正文）时的占位正文：有图片用图片占位，否则用文件占位。 */
const placeholderTextFor = (attachments) =>
  (attachments.some((item) => item.kind === INBOUND_KINDS.image) ? IMAGE_PLACEHOLDER_TEXT : FILE_PLACEHOLDER_TEXT)

/** 附件 admission 失败回执文案（按失败的附件种类取，zh/en 均来自 strings 表）。 */
function attachmentFailureText(t, failures) {
  const hasImage = failures.includes(INBOUND_KINDS.image)
  const hasFile = failures.includes(INBOUND_KINDS.file)
  if (hasImage && hasFile) return t.attachmentFetchFailed
  return hasFile ? t.fileFetchFailed : t.imageFetchFailed
}

/**
 * 注册会话路由器。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（ctx.agents / ctx.on）
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} deps.bus
 * @param {import('./store.mjs').store} deps.store - 绑定关系持久化（bind:<channel>:<userId> → sessionId）
 * @param {(channel: string, chatId: string, text: string) => void} [deps.reply] - 回执通道（命令反馈）
 * @param {object} [deps.config] - { mergeWindowMs?, steerPrefix? }
 * @param {object} [deps.logger]
 * @param {ReturnType<typeof import('../routing/agent-router.mjs').createAgentRouter>} [deps.router]
 *   - v0.3.2 入站解析链（bind > 通道默认 > 单 agent > 最近活跃）；缺省回落旧行为
 * @param {ReturnType<typeof import('../routing/session-registry.mjs').createSessionRegistry>} [deps.registry]
 *   - 会话台账（/agent 命令族数据源、活跃信号 touch、入站对话挂钩维护）；缺省时命令族降级提示
 * @param {() => string[]} [deps.channelTypes] - 全局已启用渠道类型（v0.3.2 出站解析的兜底池
 *   与过滤白名单）；缺省回落 config.mjs 的 CHANNEL_TYPES 全量（乐观池）
* @param {ReturnType<typeof import('../routing/task-selection.mjs').createTaskSelection>} [deps.taskSelection]
 *   - v0.10 任务选择（歧义前置）；非空时多活跃任务无绑定先下发选择卡
 * @param {(id: string) => boolean} [deps.attentionOf] - v0.10 待关注判定器（/tasks ⚠）
 * @param {ReturnType<typeof import('./identity.mjs').createIdentity>} [deps.identity]
 *   - Commit20：/log 的 owner 判定（channel-scoped）；缺省 fail-closed（拒绝）
 * @param {ReturnType<typeof import('../ledger.mjs').createLedger>} [deps.ledger]
 *   - Commit20：/log 的只读数据源（recent()）；缺省或未运行时回「暂不可用」
 * @param {{ enabled?: boolean, maxLines?: number, maxBytes?: number }} [deps.remoteLog]
 *   - Commit20：/log 开关与上限（resolved config；默认 enabled:false）；缺省视为未开启
 * @param {(url: string) => Promise<{data: Uint8Array, mediaType: string, size: number}|null>} [deps.downloadImageBytes]
 *   - Host P0-A 图片字节下载原语（测试替身注入点；缺省回落 message.mjs downloadInboundImageBytes）
 * @param {(url: string) => Promise<{data: Uint8Array, mediaType: string, size: number}|null>} [deps.downloadFileBytes]
 *   - #36 文件字节下载原语（测试替身注入点；缺省回落 message.mjs downloadInboundFileBytes）
 * @param {object} [strings] - stringsOf(lang) 全文案表（本函数读 conversation 节；
 *   缺省回落 ZH_FALLBACK）。装配层注入 stringsOf(config.lang) 全表；缺省路径输出与既有硬编码逐字节一致。
 * @returns {() => void} 反注册函数
 */
export function registerConversationRouter(deps, strings) {
  const { ctx, bus, store } = deps
  const t = strings?.conversation ?? ZH_FALLBACK
  const reply = typeof deps.reply === 'function' ? deps.reply : () => {}
  const cfg = deps.config ?? {}
  const router = deps.router ?? null
  const registry = deps.registry ?? null
  const control = deps.control ?? null
  // v0.10 任务选择（歧义前置）：非空时多活跃任务无绑定先下发选择卡；缺省回落旧行为。
  const taskSelection = deps.taskSelection ?? null
  // v0.10 待关注事项判定器（/tasks ⚠ 标记与投影 attention 字段）；缺省恒 false。
  const attentionOf = typeof deps.attentionOf === 'function' ? deps.attentionOf : () => false
  // Commit20：/log 远程日志回传。identity = owner 判定（channel-scoped）；ledger = 只读
  // recent() 数据源（可能是 null —— 账本未运行）；remoteLog = resolved 配置（默认 enabled:false）。
  // 三者任一缺失都 fail-closed（拒绝/未开启/暂不可用），绝不新增第二套鉴权。
  const identity = deps.identity ?? null
  const ledger = deps.ledger ?? null
  const remoteLog = (deps.remoteLog !== null && typeof deps.remoteLog === 'object' && !Array.isArray(deps.remoteLog)) ? deps.remoteLog : {}
  const remoteLogMaxLines = Number.isFinite(Number(remoteLog.maxLines))
    ? Math.min(REMOTE_LOG_HARD_MAX_LINES, Math.max(1, Math.trunc(Number(remoteLog.maxLines))))
    : REMOTE_LOG_HARD_MAX_LINES
  const remoteLogMaxBytes = Number.isFinite(Number(remoteLog.maxBytes))
    ? Math.min(REMOTE_LOG_HARD_MAX_BYTES, Math.max(256, Math.trunc(Number(remoteLog.maxBytes))))
    : REMOTE_LOG_HARD_MAX_BYTES
  // Host P0-A 图片字节下载（有界超时/大小/类型）：把实读字节收进内存交给 attachments
  // 做 durable admission。可注入 downloadImageBytes 换成测试替身/渠道专用下载器。
  const downloadImageBytes = typeof deps.downloadImageBytes === 'function' ? deps.downloadImageBytes : downloadInboundImageBytes
  // #36 文件字节下载：与图片同一套有界口径（SSRF/redirect/超时/实读字节上限），不限媒体类型。
  const downloadFileBytes = typeof deps.downloadFileBytes === 'function' ? deps.downloadFileBytes : downloadInboundFileBytes
  // Host P0-A attachment service：能力探测（缺失 = 图片能力降级为「正文照投 + 图片失败回执」）。
  const attachments = readAttachments(ctx)
  // mergeWindowMs 归一：undefined/null → 默认；0 合法（README 承诺「0 = 关闭合并」，立即投递）；
  // 非数字/NaN → 默认；负数 → 0（Math.max 兜底）。注意不能用 `Number(x) || 默认`——那会把
  // 显式 0 当 falsy 回落 1500，使下方 `mergeWindowMs === 0` 的立即投递分支永不可达（v0.3.2 审查修复）。
  const mergeWindowRaw = cfg.mergeWindowMs
  const mergeWindowNumber = Number(mergeWindowRaw)
  const mergeWindowMs = mergeWindowRaw === undefined || mergeWindowRaw === null || !Number.isFinite(mergeWindowNumber)
    ? DEFAULT_MERGE_WINDOW_MS
    : Math.max(0, mergeWindowNumber)
  const steerPrefix = typeof cfg.steerPrefix === 'string' && cfg.steerPrefix.length > 0 ? cfg.steerPrefix : '!'
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/conversation]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/conversation]', message) } catch { /* 控制台不可用不致命 */ }
  }
  // Host P0-A：异步投递链 fire-and-forget 统一兜底（总线 handler 同步、无法 await）。
  // 任何未捕获 rejection 只记 warn，绝不弄崩宿主/总线。
  const fireAsync = (promise) => {
    if (promise !== null && typeof promise?.catch === 'function') {
      promise.catch((error) => warn(`会话投递异步异常: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  // 全局渠道池（v0.3.2 出站解析的兜底池 + 过滤白名单）。缺省回落 config 的全量渠道类型
  // （乐观池：装配层不注入时宁可多列也不漏，resolveOutbound 自带「全局池内存在」过滤）。
  const channelTypesFn = typeof deps.channelTypes === 'function' ? deps.channelTypes : () => CHANNEL_TYPES
  /** 防御：注入函数抛错 / 返回非数组 → []（绝不弄崩命令族）。 */
  const globalTypes = () => {
    try {
      const list = channelTypesFn()
      return Array.isArray(list) ? list.filter((type) => typeof type === 'string' && type !== '') : []
    } catch { return [] }
  }

  // 最近活跃的根 agent：未显式 /bind 时的默认投递目标
  let latestSessionId = null
  const disposers = []

  const agentsOf = () => {
    try { return typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : [] } catch { return [] }
  }
  const agentOf = (sessionId) => {
    try { return typeof ctx?.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined } catch { return undefined }
  }
  // G-49：会话绑定持久化键。分量归一收敛到 identity.bindingKey（trim + channel 小写），
  // 与 agent-router resolveInbound L1 的读键同源——' user ' 与 'user' 写读同键永不裂
  // （休眠边界封口：现网适配器输出恰好归一，此改不改变现网行为）。
  const bindingKey = (envelope) => `bind:${identityBindingKey(envelope.channel, envelope.userId)}`

  // ---- v0.3.2 命令族支撑（军规：registry/router 任何缺失或抛错一律降级，绝不弄崩投递主线）----

  /** registry 方法防御壳：缺实例 / 缺方法 / 抛错 → undefined（调用方各自兜底）。 */
  const registryCall = (method, ...args) => {
    try {
      if (registry === null || typeof registry[method] !== 'function') return undefined
      return registry[method](...args)
    } catch (error) {
      warn(`registry.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  /** router 方法防御壳：同上。 */
  const routerCall = (method, ...args) => {
    try {
      if (router === null || typeof router[method] !== 'function') return undefined
      return router[method](...args)
    } catch (error) {
      warn(`router.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 会话的 workspace 名：registry 台账快照优先，缺档回落宿主 agent 的 cwd 末段。 */
  const workspaceOfSid = (sessionId) => {
    const record = registryCall('getSession', sessionId)
    if (typeof record?.workspace === 'string' && record.workspace !== '') return record.workspace
    const agent = agentOf(sessionId)
    return agent !== undefined ? workspaceOf(agent) : ''
  }

  /**
   * 当前对话的入站挂钩（与 bind:<channel>:<userId> 键同源，registry.attach/detach 用）。
   * G-49：分量归一镜像 identity.bindingKey 的规则（channel trim + 小写、userId trim）——
   * attach 与 detach 的分量必落在同一身份上，' user ' 与 'user' 同挂钩（否则覆盖绑定/
   * 解绑时摘不掉自己挂上的钩）。不从复合键反切分量（userId 可含冒号，反切会截断），
   * 规则漂移由 test/conversation.route.test.mjs 的 G-49 全链路用例锁死。
   */
  const inboundBindingOf = (envelope) => ({
    channel: String(envelope.channel ?? '').trim().toLowerCase(),
    userId: String(envelope.userId ?? '').trim(),
  })

  /**
   * 活跃会话快照（/agent 列表与 /agent use 的数据源）。registry 注入时用台账
   * （activeSessions 已按 lastActiveAt 降序）；缺省降级宿主 ctx.agents.list()
   * + workspaceOf(agent)（无活跃信号，排序退化为宿主列表顺序）。
   * @returns {{ infos: Array<{id: string, workspace: string}>, activitySorted: boolean }}
   */
  const activeSessionInfos = () => {
    if (registry !== null) {
      const ids = registryCall('activeSessions')
      if (Array.isArray(ids)) {
        return {
          infos: ids
            .filter((id) => typeof id === 'string' && id !== '')
            .map((id) => ({ id, workspace: workspaceOfSid(id) })),
          activitySorted: true,
        }
      }
    }
    return { infos: agentsOf().map((agent) => ({ id: agent.id, workspace: workspaceOf(agent) })), activitySorted: false }
  }

  /** 候选中取最近活跃者（§0.5-4「投最近活跃」）：台账有序直取首位，无信号时取末位启发式。 */
  const pickLatest = (infos, activitySorted) => {
    if (infos.length === 0) return null
    if (activitySorted) return infos[0].id
    const best = registryCall('latestActiveOf', infos.map((info) => info.id))
    if (typeof best === 'string' && best !== '') return best
    return infos[infos.length - 1].id // 无活跃信号：取列表末位（最近创建）启发式
  }

  /**
   * 入站去向解析（v0.3.2 §3 四层链）。router 注入时走完整链（L1 bind 读同一 store 键，
   * 行为与旧 boundSession 等价）；未注入时回落 v0.3.1 旧行为。解析异常回落旧链（绝不弄崩投递）。
   * @returns {{ sessionId: string|null, source: string, ambiguous: boolean, candidates?: string[] }}
   */
  const resolveTarget = (envelope) => {
    if (router !== null) {
      try {
        return router.resolveInbound(envelope.channel, String(envelope.userId ?? ''), { latestSessionId })
      } catch (error) {
        warn(`入站路由解析失败，回落默认链: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const bound = store.get(bindingKey(envelope))
    if (typeof bound === 'string' && bound !== '') return { sessionId: bound, source: 'bind', ambiguous: false }
    return { sessionId: latestSessionId, source: 'latest', ambiguous: false }
  }
  // 旧名兼容（/status 等沿用）
  const boundSession = (envelope) => resolveTarget(envelope).sessionId

  function handleCommand(envelope, text) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    const say = (message) => reply(envelope.channel, envelope.chatId, message)
    if (cmd === 'help') {
say(t.helpLines.join('\n'))
      return true
    }
    if (cmd === 'status') {
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      say([
        `${t.statusBindLabel}${store.get(bindingKey(envelope)) ?? t.bindUnset}`,
        `${t.statusTargetLabel}${bound ?? t.targetUnset}`,
        `${t.statusStateLabel}${agent !== undefined ? agent.status : t.statusNotFound}`,
        `${t.activeSessionsLabel}${agentsOf().map((agent) => `${agent.id}(${agent.status})`).join(t.joiner) || t.activeSessionsNone}`,
      ].join('\n'))
      return true
    }
    if (cmd === 'bind') {
      const target = args[0]
      if (target === undefined || target === '') {
        say(t.bindUsage)
        return true
      }
      if (agentOf(target) === undefined) {
        say(t.bindMissingSession(target))
        return true
      }
      // G-48：覆盖绑定先摘旧会话的入站挂钩。否则 store 换了目标，registry 反查表里同一
      // (channel,userId) 却同时挂在旧 sid 与新 sid 上（一 user 双挂）——旧会话看似仍
      // 挂着本对话，/route 与管理台会话视图永久失真。旧值 === 新目标时跳过（幂等重绑
      // 不做摘挂写放大）；旧值缺失（首绑）无钩可摘。registry.detachInbound 幂等：旧 sid
      // 无记录/无该挂钩时安全无操作，不抛。
      const previous = store.get(bindingKey(envelope))
      if (setDurable(store, bindingKey(envelope), target) !== true) {
        say('绑定保存失败，请稍后重试')
        return true
      }
      if (typeof previous === 'string' && previous !== '' && previous !== target) {
        registryCall('detachInbound', previous, inboundBindingOf(envelope))
      }
      // v0.3.2：同步维护台账入站挂钩与活跃信号（防御壳内降级，不影响绑定本身）
      registryCall('attachInbound', target, inboundBindingOf(envelope))
      registryCall('touch', target)
      say(t.boundReceipt(target))
      return true
    }
    if (cmd === 'unbind') {
      // 先读旧值再删：detachInbound 需要旧 sid 才能摘掉台账上的入站挂钩
      const key = bindingKey(envelope)
      const old = store.get(key)
      if (deleteDurable(store, key).durable !== true) {
        say('解绑保存失败，请稍后重试')
        return true
      }
      if (typeof old === 'string' && old !== '') {
        registryCall('detachInbound', old, inboundBindingOf(envelope))
      }
      say(t.unboundReceipt)
      return true
    }
    if (cmd === 'stop' && args.length === 0) {
      // G-04：/stop 是无参命令——只有裸 '/stop' 命中取消。带附言的 '/stop 一下别急'
      // 不再命中（收紧前 startsWith('/stop ') 会把它当取消指令，误杀长任务），
      // 落到函数尾部的未知命令路径：回执「未识别的命令」+ 按普通文本投递。
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      if (agent === undefined) { say(t.stopNone); return true }
      try {
        agent.cancel({ kind: 'user' }) // Host P0-B：structured AgentCancelCause（远程手机用户 = {kind:'user'}）
        say(t.stopRequested(bound))
      } catch (error) {
        warn(`/stop 失败: ${error instanceof Error ? error.message : String(error)}`)
        say(t.stopFailed)
      }
      return true
    }
    // ---- v0.3.2 会话路由命令族（设计稿 §4）：/agent [use|back] 与 /route ----
    if (cmd === 'agent') {
      const sub = String(args[0] ?? '').toLowerCase()
      if (sub === 'use') {
        // G-33：目标名可含空格（workspace 名如 "my space"）——args[1] 只取首词会截断，
        // 改为剩余参数整体作为 needle（matchSessionByNeedle 做精确/前缀匹配，本身 trim）。
        handleAgentUse(envelope, args.slice(1).join(' '), say)
        return true
      }
      if (sub === 'back') {
        handleAgentBack(envelope, say)
        return true
      }
      if (sub === '') {
        say(renderAgentList())
        return true
      }
      say(t.agentUsage)
      return true
    }
    if (cmd === 'route') {
      if (router === null) {
        say(t.routeUnavailable)
        return true
      }
      say(renderRoute(envelope))
      return true
    }
    // ---- v0.10 任务投影 / 任务选择（任务书提交5）----
    if (cmd === 'tasks') {
      say(renderTaskList())
      return true
    }
    // Commit19：/sessions —— 手机侧「用户任务概览」。与 /tasks 同源（projectTasks 单一数据源），
    // 但面向「我在忙什么 / 哪个会话待我处理 / 当前绑到哪」而非路由调试（那是 /agent 的职责）。
    if (cmd === 'sessions') {
      say(renderSessions(envelope))
      return true
    }
    // Commit20：/log —— 敏感诊断能力（默认关、owner-only、脱敏、有界）。与 /sessions 同处
    // 紧随 /tasks 之后；数据源是通知账本（非会话输出，口径见 renderLog）。
    if (cmd === 'log') {
      say(renderLog(envelope, args))
      return true
    }
    if (cmd === 'use') {
      fireAsync(handleTaskUse(envelope, args.join(' '), say))
      return true
    }
    // ---- v0.5 特性 C：/quiet /unquiet（设计稿 §4，目标解析复用 /agent use 智能匹配）----
    if (cmd === 'quiet' || cmd === 'unquiet') {
      const quiet = cmd === 'quiet'
      if (router === null) {
        say(t.quietUnavailable)
        return true
      }
      const target = args[0]
      if (typeof target !== 'string' || target.trim() === '') {
        say(t.quietUsage(cmd))
        return true
      }
      const matched = matchSessionByNeedle(target.trim())
      if (matched.sid === null) { say(matched.message); return true }
      const ok = routerCall('setSessionOutbound', matched.sid, { quiet })
      if (ok !== true) {
        say(t.quietWriteFailed(cmd))
        return true
      }
      const workspace = workspaceOfSid(matched.sid)
      const label = workspace === '' ? t.unknownWorkspace : workspace
      say([
        t.quietReceipt(quiet ? t.quietMarkMuted : t.quietMarkResumed, label, matched.sid, matched.matchedBy),
        quiet ? t.quietHint : '',
      ].filter((line) => line !== '').join('\n'))
      return true
    }
    // G-04：未知命令回执。/stop 收紧为仅裸 '/stop' 命中取消后，'/stop 等等' 这类带
    // 附言形态落到此路径——若只静默按普通文本投递，用户会误以为命令已被执行（回执黑洞）。
    // 回执仅告知未识别，「当普通文本处理（避免吞消息）」的既有语义保持不变
    // （若下方投递失败，routeUnsafe 还会另有回执）。
    say(t.unknownCommand(cmd))
    return false // 未知命令：当普通文本处理（避免吞消息）
  }

  /**
   * /agent 无参：活跃会话分组视图（设计稿 §4）。每行
   * 「workspace | sid（8 位前缀）| 状态 | 出站通道集合 | quiet 标记」，按 workspace 聚合、
   * 组内保持活跃降序。数据源 registry.activeSessions() + agentOf(id).status +
   * router.resolveOutbound(sid, workspace, globalTypes())；registry 缺省降级宿主 agent 列表；
   * router 缺省整体降级提示（出站集合无从解析）。
   */
  function renderAgentList() {
    if (router === null) {
      return t.agentListUnavailable
    }
    const { infos } = activeSessionInfos()
    const lines = [t.agentListHeader]
    if (registry === null) {
      lines.push(t.agentListDegraded)
    }
    if (infos.length === 0) {
      lines.push(t.agentListEmpty)
    }
    const groups = new Map() // workspace -> 该组行（保持活跃降序；组顺序 = 最近活跃组的 workspace 在前）
    for (const info of infos) {
      const key = info.workspace === '' ? t.unknownWorkspace : info.workspace
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(info)
    }
    for (const [workspace, rows] of groups) {
      for (const info of rows) {
        const status = agentOf(info.id)?.status ?? t.statusUnknown
        const outbound = routerCall('resolveOutbound', info.id, info.workspace, globalTypes())
        const channels = outbound !== undefined && Array.isArray(outbound.channelTypes)
          ? `[${outbound.channelTypes.join(', ')}]`
          : t.outboundUnavailable
        const quiet = outbound?.quiet === true ? 'quiet' : '-'
        lines.push(`  ${workspace} | ${info.id.slice(0, 8)} | ${status} | ${channels} | ${quiet}`)
      }
    }
    lines.push(t.agentListFooter)
    return lines.join('\n')
  }

  /**
   * /tasks：活跃任务投影（v0.10 任务投影只读视图与第 7 提交管理台同源的手机侧视图）。
   * 每行「编号. workspace | taskRef 前缀 | status | ⚠待关注」；编号供歧义选择卡/后续选择使用。
   */
  function renderTaskList() {
    const { tasks } = projectTasks({ registry, router, ctx, channelTypes: () => globalTypes(), attentionOf })
    if (tasks.length === 0) return '（没有活跃任务：先在宿主开一个会话，或 /bind <sessionId>）'
    const lines = ['活跃任务（回复编号选择，或用 /use <workspace|sid 前缀>）：']
    tasks.forEach((task, index) => {
      const workspace = task.workspace === '' ? '(未知 workspace)' : task.workspace
      const attention = task.attention === true ? ' ⚠' : ''
      lines.push(`  ${index + 1}. ${workspace} | ${String(task.taskRef).slice(0, 8)} | ${task.status}${attention}`)
    })
    return lines.join('\n')
  }

  /**
   * /sessions：手机侧用户任务概览（Commit19）。数据源**单一**——与 /tasks、管理台同用
   * `projectTasks`（registry + 宿主 agent 状态折叠出的只读派生视图），不读 store 的
   * route:sessions 内部键、不新增持久状态。每行「编号. [*] workspace」+「sid 前缀 · 状态 · [⚠]」：
   *   - `*`  标出 `resolveTarget(envelope)` 解析出的当前绑定会话（前缀匹配 taskRef）
   *   - `⚠`  标出有待关注事项（待决提问/审批），只给布尔标记，绝不显示待决内容
   *   - sid 只显示 8 位前缀（完整 id 属敏感面），切换交给既有 /use 或 /bind（footer 引导）
   * 排序沿用 projectTasks（活跃降序）；projectTasks 自身逐字段降级、绝不抛，故此处不 crash。
   */
  function renderSessions(envelope) {
    const { tasks } = projectTasks({ registry, router, ctx, channelTypes: () => globalTypes(), attentionOf })
    if (tasks.length === 0) return t.sessionsEmpty
    const current = resolveTarget(envelope).sessionId
    const lines = [t.sessionsTitle]
    tasks.forEach((task, index) => {
      const workspace = task.workspace === '' ? t.sessionsUnknownWorkspace : task.workspace
      const mark = current !== null && current !== undefined && String(task.taskRef) === String(current)
        ? t.sessionsCurrentMark
        : ''
      const prefix = String(task.taskRef).slice(0, 8)
      const status = typeof task.status === 'string' && task.status !== '' && task.status !== 'unknown'
        ? task.status
        : t.sessionsUnknownStatus
      const attention = task.attention === true ? t.sessionsAttentionMark : ''
      lines.push(t.sessionsRowHead(index + 1, mark, workspace))
      lines.push(t.sessionsRowBody(prefix, status, attention))
    })
    lines.push(t.sessionsFooter)
    return lines.join('\n')
  }

  /**
   * owner 判定：identity.list(channel) 里存在同 userId 且 role === 'owner' 的记录。
   * owner 是 **channel-scoped** 绑定（同 userId 在别的渠道的 owner 不算数）；
   * identity 缺失/list 抛错一律 fail-closed（false）。绝不告诉调用者「谁是 owner」。
   */
  function isOwner(envelope) {
    if (identity === null || typeof identity.list !== 'function') return false
    try {
      return identity.list(envelope.channel).some(
        (row) => String(row?.userId) === String(envelope.userId) && row?.role === 'owner',
      )
    } catch { return false }
  }

  /**
   * 解析 `/log N`：无参 → 缺省 20；正整数 → 原值（收集时再 clamp 到 maxLines）；
   * 0 / 负数 / 小数 / 非数字 / 多余参数 → null（调用方回 usage）。
   * 只接受纯十进制正整数字面量（拒绝 '+3'、'1e3'、'0x10' 等奇形，fail-closed 不猜）。
   */
  function parseLogCount(args) {
    if (args.length === 0) return REMOTE_LOG_DEFAULT_LINES
    if (args.length > 1) return null
    if (!/^\d+$/.test(args[0])) return null
    const value = Number(args[0])
    return value === 0 || !Number.isFinite(value) ? null : value
  }

  /**
   * UTF-8 安全字节截断（plan §11.20/§11.21）：先给 marker 预留字节，再按 **code point**
   * 递增累积到预算内——`text.slice(0, n)` 是 UTF-16 码元切法（会切出半个代理项且字节数不可控），
   * 这里用 `for...of`（按码点迭代）保证无孤立代理项。未超限原样返回，超限追加 marker。
   */
  function truncateUtf8(text, maxBytes, marker = '') {
    const encoder = new TextEncoder()
    if (encoder.encode(text).length <= maxBytes) return text
    const markerBytes = encoder.encode(marker).length
    const budget = Math.max(0, maxBytes - markerBytes)
    let out = ''
    let used = 0
    for (const ch of text) {
      const size = encoder.encode(ch).length
      if (used + size > budget) break
      out += ch
      used += size
    }
    return out + marker
  }

  /** 单条账本记录 → 一行投影（只 time/kind/level/title + delivered/failed 计数；无凭据、无原始错误）。 */
  function projectLogLine(entry) {
    const time = typeof entry.at === 'string' ? entry.at : ''
    const kind = typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : 'other'
    const level = typeof entry.level === 'string' ? entry.level : ''
    const title = typeof entry.title === 'string' ? entry.title : ''
    const delivered = Array.isArray(entry.delivered) ? entry.delivered.length : 0
    const failed = Array.isArray(entry.failed) ? entry.failed.length : 0
    return t.logLine(time, kind, level, title, delivered, failed)
  }

  /**
   * /log：敏感诊断能力（Commit20）。默认关 + owner-only + 脱敏 + 有界。
   * 数据源 = 通知账本 `ledger.recent()`——**账本没有 sessionId 语义**，故口径如实写作
   * 「最近通知/事件摘要」（plan §11.14），绝不谎称是「当前会话日志」；也绝不读
   * `session.events` / `snapshotEvents`（宿主面不可靠，plan §11.10）。
   * 截断顺序（plan §11.19）：collect N → project lines → join → redact → line cap → byte cap。
   * 顺序上「身份先通过 bus（陌生人根本进不了 command）」→ 本命令内 owner 判定 → 未开启 → 账本不可用。
   * 脱敏口径如实声明：`maskSecrets` 是**形态**打码（sk-/ghp_/xox/Bearer/长 hex|base64 等），
   * 不是语义扫描器——不保证逐字节抹掉任意 `foo=短值`，故 disabled/owner 闸与「有界」才是主防线。
   */
  function renderLog(envelope, args) {
    if (!isOwner(envelope)) return t.logOwnerOnly
    if (remoteLog.enabled !== true) return t.logDisabled
    if (ledger === null || typeof ledger.recent !== 'function') return t.logUnavailable
    const requested = parseLogCount(args)
    if (requested === null) return t.logUsage(REMOTE_LOG_DEFAULT_LINES, remoteLogMaxLines)
    let entries
    try {
      entries = ledger.recent(Math.min(requested, remoteLogMaxLines))
    } catch {
      return t.logUnavailable
    }
    const records = Array.isArray(entries) ? entries : []
    if (records.length === 0) return t.logEmpty
    const lines = [t.logSummaryHeader(records.length), ...records.map((entry) => projectLogLine(entry))]
    // 脱敏（标题仍可能含路径/token-like 文本，plan §11.17）：走项目正式入口 maskSecrets，
    // 在 join 之后整体过一遍（标题/kind 一视同仁），绝不复制 regex。
    const redacted = maskSecrets(lines.join('\n'))
    // line cap：防御性再截一次行数（header + maxLines），绝不因投影多吐行而放大。
    const capped = redacted.split('\n').slice(0, remoteLogMaxLines + 1).join('\n')
    // byte cap：UTF-8 安全截断（marker 预留字节），全程 ≤ maxBytes。
    return truncateUtf8(capped, remoteLogMaxBytes, t.logTruncated)
  }

  /** 把本对话绑定到指定会话（store bind 键 + 台账反查挂钩 + 活跃信号），复用 /bind 的摘挂语义。 */
  function applyBinding(envelope, sessionId) {
    const previous = store.get(bindingKey(envelope))
    if (setDurable(store, bindingKey(envelope), sessionId) !== true) return false
    if (typeof previous === 'string' && previous !== '' && previous !== sessionId) {
      registryCall('detachInbound', previous, inboundBindingOf(envelope))
    }
    registryCall('attachInbound', sessionId, inboundBindingOf(envelope))
    registryCall('touch', sessionId)
    return true
  }

  /** 选定会话后投递原消息（恰好一次，任务书「选择成功后原消息只投一次」）；附件可选随投。 */
  async function selectAndDeliver(envelope, sessionId, originalText, say, items = []) {
    const agent = agentOf(sessionId)
    if (agent === undefined) { say(`会话 ${sessionId} 不存在或已退出（用 /tasks 重选）`); return false }
    if (applyBinding(envelope, sessionId) !== true) {
      say('绑定保存失败，请稍后重试')
      return false
    }
    const outcome = await deliver(agent, originalText, items, (failures) => {
      try { say(attachmentFailureText(t, failures)) } catch { /* 回执失败不致命 */ }
    })
    if (outcome === 'error') { say('投递失败（详见宿主日志）'); return false }
    if (outcome === 'empty') { say(`已选择 ${sessionId}（原消息为空，未投递）`); return true }
    say(`已选择 ${sessionId} 并投递（仅一次）`)
    return true
  }

  /**
   * /use <needle>：选择任务（v0.10）。等价 /agent use 的智能绑定；若本对话有
   * 待决选择卡（歧义前置触发），则选定后把存起的原消息投一次并撤销待决。
   */
  async function handleTaskUse(envelope, target, say) {
    if (typeof target !== 'string' || target.trim() === '') {
      say('用法：/use <workspace 名 | sessionId | sid 前缀（≥4 位）>')
      return
    }
    const matched = matchSessionByNeedle(target.trim())
    if (matched.sid === null) { say(matched.message); return }
    const pending = taskSelection !== null ? taskSelection.get(envelope) : undefined
    if (pending !== undefined) {
      const taken = typeof taskSelection.take === 'function'
        ? taskSelection.take(envelope, matched.sid)
        : { ok: false, reason: 'storage-failed' }
      if (taken.ok !== true) {
        say(taken.reason === 'storage-failed' ? '任务选择保存失败，请稍后重试' : '该任务不在当前选择项中，请重新选择')
        return
      }
      await selectAndDeliver(envelope, matched.sid, taken.originalText, say, taken.attachments ?? [])
      return
    }
    if (applyBinding(envelope, matched.sid) !== true) {
      say('绑定保存失败，请稍后重试')
      return
    }
    const workspace = workspaceOfSid(matched.sid)
    say(`已选择 ${workspace === '' ? '(未知 workspace)' : workspace} / ${matched.sid}（${matched.matchedBy}）`)
  }

  /** 任务选择卡（歧义前置）：把候选任务渲染为编号列表供回复选择。 */
  function renderSelectionCard(candidates) {
    const lines = ['有多个活跃任务，请先选择要投递到哪一个（回复编号，或用 /use <workspace|sid 前缀>）：']
    candidates.forEach((id, index) => {
      const workspace = workspaceOfSid(id)
      const status = agentOf(id)?.status ?? '未知'
      lines.push(`  ${index + 1}. ${workspace === '' ? '(未知 workspace)' : workspace} | ${String(id).slice(0, 8)} | ${status}`)
    })
    lines.push('（原消息将在选择后只投递一次）')
    return lines.join('\n')
  }

  /**
   * 目标智能匹配（§0.5-5 解析顺序，/agent use 与 v0.5 /quiet|/unquiet 共用）：
   * workspace 名精确匹配（该 workspace 活跃会话取最近活跃者）> sessionId 精确 >
   * sid 前缀（≥4 位：唯一命中 / 多命中列候选 / 零命中提示）。
   * @param {string} needle - 用户输入的目标串。
   * @returns {{ sid: string, matchedBy: string } | { sid: null, message: string }}
   */
  const matchSessionByNeedle = (needle) => {
    const { infos, activitySorted } = activeSessionInfos()
    const ofWorkspace = infos.filter((info) => info.workspace !== '' && info.workspace === needle)
    if (ofWorkspace.length > 0) {
      const sid = pickLatest(ofWorkspace, activitySorted) // 同 workspace 多活跃会话 → 最近活跃者（§0.5-4）
      if (sid !== null) return { sid, matchedBy: t.matchedByWorkspace(needle) }
    }
    if (infos.some((info) => info.id === needle)) return { sid: needle, matchedBy: t.matchedBySessionId }
    if (needle.length >= 4) {
      const hits = infos.filter((info) => info.id.startsWith(needle)).map((info) => info.id)
      if (hits.length === 1) return { sid: hits[0], matchedBy: t.matchedBySidPrefix }
      if (hits.length > 1) {
        return {
          sid: null,
          message: [
            t.prefixAmbiguous(needle, hits.length),
            ...hits.map((id) => `  ${id}`),
            t.prefixHint,
          ].join('\n'),
        }
      }
    }
    return { sid: null, message: t.noMatch(needle) }
  }

  /**
   * /agent use <target>：智能绑定（§0.5-5 解析顺序，匹配逻辑见 matchSessionByNeedle）。
   * 成功后 store 写 bind 键 + 摘旧会话挂钩（G-48，覆盖绑定防双挂）+ registry.attachInbound
   * + touch，回执确认 workspace 与 sid。
   */
  function handleAgentUse(envelope, target, say) {
    if (typeof target !== 'string' || target.trim() === '') {
      say(t.agentUseUsage)
      return
    }
    const matched = matchSessionByNeedle(target.trim())
    if (matched.sid === null) { say(matched.message); return }
    const sid = matched.sid
    const workspace = workspaceOfSid(sid)
    // G-48：同 /bind——覆盖绑定先摘旧会话挂钩（防一 user 双挂；旧值 === 新目标跳过）
    const previous = store.get(bindingKey(envelope))
    if (setDurable(store, bindingKey(envelope), sid) !== true) {
      say('绑定保存失败，请稍后重试')
      return
    }
    if (typeof previous === 'string' && previous !== '' && previous !== sid) {
      registryCall('detachInbound', previous, inboundBindingOf(envelope))
    }
    registryCall('attachInbound', sid, inboundBindingOf(envelope))
    registryCall('touch', sid)
    say(t.agentUseBound(workspace === '' ? t.unknownWorkspace : workspace, sid, matched.matchedBy))
  }

  /** /agent back：读旧绑定 → 删 bind 键 + registry.detachInbound，回到通道默认路由。 */
  function handleAgentBack(envelope, say) {
    const key = bindingKey(envelope)
    const old = store.get(key)
    if (typeof old === 'string' && old !== '') {
      if (deleteDurable(store, key).durable !== true) {
        say('解绑保存失败，请稍后重试')
        return
      }
      registryCall('detachInbound', old, inboundBindingOf(envelope))
      say(t.agentBackBound(old))
    } else {
      say(t.agentBackUnbound)
    }
  }

  /**
   * /route：双向解析展示（排障用，§4）。出站段 = router.describe(当前解析到的 sid,
   * workspace, globalTypes()) 逐层来源（sid 为空时提示当前无目标会话）；入站段 =
   * resolveTarget 的来源层标签 + 目标 sid + ambiguous 标记 + getChannelDefault(channel)。
   */
  function renderRoute(envelope) {
    const resolved = resolveTarget(envelope)
    const sid = resolved.sessionId
    const lines = [t.routeOutboundHeader]
    if (sid === null) {
      lines.push(t.routeNoTarget)
    } else {
      const described = routerCall('describe', sid, workspaceOfSid(sid), globalTypes())
      for (const line of String(described ?? '').split('\n')) lines.push(`  ${line}`)
    }
    lines.push('', t.routeInboundHeader)
    lines.push(t.routeSourceLine(t.inboundSourceLabels?.[resolved.source] ?? String(resolved.source)))
    lines.push(t.routeTargetLine(sid))
    lines.push(t.routeAmbiguousLine(resolved.ambiguous))
    if (resolved.ambiguous && Array.isArray(resolved.candidates) && resolved.candidates.length > 0) {
      lines.push(t.routeCandidatesLine(resolved.candidates.join(t.joiner)))
    }
    const channelDefault = routerCall('getChannelDefault', envelope.channel)
    lines.push(t.routeChannelDefaultLine(envelope.channel, channelDefault))
    return lines.join('\n')
  }

  /**
   * 投递语义路由：! 前缀 steer；忙碌 inject；空闲 followup。items 为已受控归一的附件数组。
   * Host P0-A/#36：附件先「有界下载字节 → durable admission」，把 image/file attachment ref
   * 按入站顺序放进 UserMessage V4（buildRemoteUserMessage），绝不回退远程 URL；
   * text-only 不依赖 attachments。多附件顺序保持，逐个独立成败（部分失败不阻断其余）。
   * onAttachmentFailure（可选）：附件 admission 失败时回调（入参为失败附件的 kind 数组），
   * 正文仍照投；纯附件则「绝不塞空消息」（返回 'empty'）。
   * @returns {Promise<'steer'|'inject'|'followup'|'empty'|'error'>}
   */
  async function deliver(agent, text, items = [], onAttachmentFailure = null) {
    const wantsSteer = text.startsWith(steerPrefix)
    const body = (wantsSteer ? text.slice(steerPrefix.length) : text).trim()
    const parts = Array.isArray(items) ? items : []
    if (body === '' && parts.length === 0) return 'empty'
    // 纯附件占位正文（[图片消息] / [文件消息]）绝不作为真实文本交给模型：剥离为真实空文本。
    const realBody = parts.length > 0 && ATTACHMENT_PLACEHOLDER_TEXTS.has(body) ? '' : body

    const blocks = []
    const failures = []
    let aggregateBytes = 0
    for (const item of parts) {
      const admitted = await admitAttachmentBlock(item, MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES - aggregateBytes)
      if (admitted === null) failures.push(item.kind)
      else {
        blocks.push(admitted.block)
        aggregateBytes += admitted.size
      }
    }
    if (failures.length > 0) {
      if (typeof onAttachmentFailure === 'function') {
        try { onAttachmentFailure(failures) } catch { /* 回执失败不致命 */ }
      } else {
        warn(`附件 admission 失败（已按纯文本投递，附件未随附）: ${failures.join(',')}`)
      }
      if (realBody === '' && blocks.length === 0) return 'empty' // 纯附件全失败：绝不塞空消息
    }

    const payload = buildRemoteUserMessage({ text: realBody, blocks })
    try {
      if (wantsSteer) {
        agent.steer(payload) // 空闲时宿主内部等价 followup
        return 'steer'
      }
      const outcome = agent.status === 'running' ? 'inject' : 'followup'
      if (agent.status === 'running') {
        agent.inject(payload) // 忙碌：排队到下一步边界，不打断
      } else {
        agent.followup(payload) // 空闲：唤醒新 turn
      }
      return outcome
    } catch (error) {
      warn(`投递失败: ${error instanceof Error ? error.message : String(error)}`)
      return 'error'
    }
  }

  /**
   * 单项附件 → 有界字节 → durable attachment block；任一环节失败返回 null（fail-closed）。
   * 图片走 saveImage（媒体白名单在 host 层），文件走 saveFile（不限媒体类型）；
   * 文件名已在归一阶段经 sanitizeFileName 去路径/控制字符。
   */
  async function admitAttachmentBlock(item, remainingBytes) {
    if (attachments === null) return null // 无 attachment service：附件能力不可用
    if (item.kind === INBOUND_KINDS.image) {
      const bytes = await downloadImageBytes(item.image.url)
      if (bytes === null || bytes === undefined) return null
      if (!Number.isFinite(Number(bytes.size)) || bytes.size < 0 || bytes.size > remainingBytes) return null
      const ref = await admitInboundImage(attachments, bytes.data, bytes.mediaType)
      return ref === null ? null : { block: { type: 'image', attachment: ref }, size: bytes.size }
    }
    if (item.kind === INBOUND_KINDS.file) {
      const bytes = await downloadFileBytes(item.file.url)
      if (bytes === null || bytes === undefined) return null
      if (!Number.isFinite(Number(bytes.size)) || bytes.size < 0 || bytes.size > remainingBytes) return null
      const ref = await admitInboundFile(attachments, bytes.data, item.file.name)
      return ref === null ? null : { block: { type: 'file', attachment: ref }, size: bytes.size }
    }
    return null
  }

  // 合并窗：手机上打长句常拆多条；窗口内的连续消息合并为一条再投递。
  // `..` 结尾立即冲刷；`!!` 结尾立即冲刷并按 steer 投递。
  // G-51：键必须带 chatId 维度——`${channel}:${userId}:${String(chatId ?? '')}`。
  // 旧键 `${channel}:${userId}` 把同一用户「私聊 + 群」两个 chat 的碎片并进同一条合并线：
  // 私聊窗的半句被群窗的 terminator 顺手冲掉，或两个 chat 的碎片交叉拼接成一条混合投递
  // （跨 chat 串台）。加维度后：同 channel:userId:chatId 内照旧合并；同用户私聊 + 群
  // = 两条独立合并线、各自投递、回执回各自 chat。
  //   - chatId 缺失（undefined/null）→ String(chatId ?? '') = ''，仍聚合进同一 '' 维度
  //     （现状语义保持：无 chat 概念的适配器不会因本修裂窗）；
  //   - '' 与任何显式 chatId 是不同维度（缺维度的碎片不会并进显式 chat 的窗）。
  // 改这行键时三个分量一个都不能删：去 chatId 复活跨 chat 串台，去 userId 跨用户串台，
  // 去 channel 跨渠道串台。timer 回调闭包持有的就是设置它的那个 envelope，flush 用同一
  // 键函数反查，绝不找错窗。
  const pending = new Map() // `${channel}:${userId}:${String(chatId ?? '')}` -> { parts, timer, forceSteer }
  const mergeWindowKeyOf = (envelope) =>
    `${envelope.channel}:${envelope.userId}:${String(envelope.chatId ?? '')}`

  const utf8Bytes = (value) => Buffer.byteLength(String(value), 'utf8')
  const scheduleMerge = (entry) => {
    clearTimeout(entry.timer)
    const remainingAge = Math.max(1, entry.createdAt + MAX_MERGE_ABSOLUTE_AGE_MS - Date.now())
    entry.timer = setTimeout(() => flush(entry.envelope), Math.min(mergeWindowMs, remainingAge))
  }
  const createMergeEntry = (envelope, text, items, forceSteer = false) => {
    const part = truncateUtf8(text)
    const entry = {
      parts: part === '' ? [] : [part],
      bytes: utf8Bytes(part),
      timer: null,
      forceSteer,
      attachments: items,
      createdAt: Date.now(),
      envelope,
    }
    scheduleMerge(entry)
    return entry
  }
  const canAppend = (entry, text) => entry.parts.length < MAX_MERGE_PARTS
    && entry.bytes + utf8Bytes(text) + (entry.parts.length > 0 ? 1 : 0) <= MAX_MERGE_UTF8_BYTES
  function flush(envelope) {
    const key = mergeWindowKeyOf(envelope)
    const entry = pending.get(key)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(key)
    const text = entry.parts.join('\n').trim()
    if (text === '') return
    const merged = entry.forceSteer ? `${steerPrefix}${text}` : text
    fireAsync(route(envelope, merged, entry.attachments ?? []))
  }
  async function routeUnsafe(envelope, text, items = []) {
    if (text.startsWith('/')) {
      if (handleCommand(envelope, text)) return
    }
    // v0.10 编号回复消解任务选择卡（歧义前置）：有待决选择时先尝试按编号命中；
    // 命中即把存起的原消息投一次并返回（原消息只投一次）；编号越界提示有效范围，
    // 避免把「2」当新消息又 begin 覆盖待决。无待决（no-pending）时照常走下方路由。
    if (taskSelection !== null) {
      const selection = taskSelection.resolve(envelope, text)
      if (selection.ok === true) {
        await selectAndDeliver(envelope, selection.sessionId, selection.originalText,
          (message) => reply(envelope.channel, envelope.chatId, message), selection.attachments ?? [])
        return
      }
      if (selection.reason === 'storage-failed') {
        reply(envelope.channel, envelope.chatId, '任务选择保存失败，请稍后重试')
        return
      }
      if (selection.reason === 'invalid') {
        reply(envelope.channel, envelope.chatId,
          `请回复 1..${selection.candidates.length} 选择任务，或用 /use <workspace|sid 前缀>`)
        return
      }
    }
    // 完整解析结果（非仅 sid）：ambiguous 时投递后要回执消歧提示（§0.5-4）
    const resolved = resolveTarget(envelope)
    const bound = resolved.sessionId
    // v0.10 歧义前置（任务书提交5）：多活跃任务且无显式绑定时，不先投最近活跃再补提示——
    // 先下发任务选择卡（编号回复 / /use），选定后才把原消息投一次。
    if (resolved.ambiguous === true && taskSelection !== null
      && Array.isArray(resolved.candidates) && resolved.candidates.length > 1) {
      const begun = taskSelection.begin(envelope, resolved.candidates, text, items)
      if (begun !== null) {
        reply(envelope.channel, envelope.chatId, renderSelectionCard(begun.candidates))
        return
      }
      // begin 返回 null（候选被过滤空 / 触发文本为空）：回退旧「投最近活跃 + 消歧回执」。
    }
    if (bound === null) {
      reply(envelope.channel, envelope.chatId, t.noActiveSession)
      return
    }
    const agent = agentOf(bound)
    if (agent === undefined) {
      reply(envelope.channel, envelope.chatId, t.sessionGone(bound))
      return
    }
    const outcome = await deliver(agent, text, items, (failures) => {
      reply(envelope.channel, envelope.chatId, attachmentFailureText(t, failures))
    })
    if (outcome === 'error') {
      reply(envelope.channel, envelope.chatId, t.deliverFailed)
    } else if (outcome === 'empty') {
      // 空文本（如只有 !）：静默忽略
    } else {
      // 投递成功：刷新活跃信号（「投最近活跃」消歧的数据来源，§0.5-4；防御壳内降级）
      registryCall('touch', bound)
      if (resolved.ambiguous === true) {
        const count = Array.isArray(resolved.candidates) ? resolved.candidates.length : 1
        reply(envelope.channel, envelope.chatId, t.deliveredAmbiguous(bound, count))
      }
    }
  }

  // Control Core gate for session-affecting inbound text. Ordinary outbound
  // notifications never pass here; only remote control/conversation commands do.
  function route(envelope, text, items = []) {
    const trimmed = String(text ?? '').trim()
    // G-04：仅裸 '/stop' 归类为 stop 控制命令。'/stop 等等' 不再命中（旧 startsWith('/stop ')
    // 会把附言形态也送进 Control Core 当取消指令，误杀长任务），改走未知命令路径。
    const command = trimmed === '/stop' ? 'stop'
      : (trimmed.startsWith(steerPrefix) ? 'steer' : (trimmed.startsWith('/') ? null : 'ordinary-message'))
    if (control === null || command === null) return routeUnsafe(envelope, text, items)
    // QQ group/ambiguous envelopes must not fall through to the legacy route
    // when no session is resolved; consume with a receipt instead.
    if (String(envelope.channel ?? '').toLowerCase() === 'qq' && chatScopeOf(envelope) !== 'private') {
      reply(envelope.channel, envelope.chatId, chatScopeOf(envelope) === 'group'
        ? t.groupControlDenied
        : t.controlSourceUnverified)
      return
    }
    const target = resolveTarget(envelope)
    if (target.sessionId === null) return routeUnsafe(envelope, text, items)
    const receipt = control.handle({
      eventId: String(envelope.messageId ?? ''),
      command,
      channel: envelope.channel,
      // v0.8.7：绝不把 channel 当 accountId 兜底（硬性规则）。accountId 缺失时这里得到空串，
      // normalizeControlEvent 会以 missing_accountId fail-closed 拒绝——来源必须真实存在。
      accountId: String(envelope.accountId ?? ''),
      userId: String(envelope.userId ?? ''),
      chatId: String(envelope.chatId ?? ''),
      chatType: envelope.chatType,
      sessionId: String(target.sessionId),
      policyVersion: '1',
      pending: { status: 'pending', sessionId: String(target.sessionId), createdAt: Date.now() - 1, expiresAt: Date.now() + 10 * 60 * 1000 },
      settle: () => { fireAsync(routeUnsafe(envelope, text, items)); return true },
    })
    if (receipt.status === 'accepted') return
    if (receipt.reason === 'conversation_disabled') reply(envelope.channel, envelope.chatId, t.conversationDisabled)
    else if (receipt.reason === 'group_chat_disabled') reply(envelope.channel, envelope.chatId, t.groupControlDenied)
    else if (receipt.reason === 'not_paired') reply(envelope.channel, envelope.chatId, t.notPaired)
    else reply(envelope.channel, envelope.chatId, t.controlRejected)
  }

  // G-31：会话路由是消费链末位兜底（priority 100）——前面审批/提问未消费的消息才进 agent 会话。
  const disposeMessage = bus.onMessage((envelope) => {
    // v0.10 图片 / #36 图片+文件：归一全部附件随文投递。纯附件（无正文）用占位正文保底，
    // 绝不静默丢弃；占位正文在 deliver 中被剥离（Host P0-A/#36），不会当真实文本交给模型。
    const items = collectAttachments(envelope)
    const rawText = String(envelope.text ?? '').trim()
    const text = rawText === '' && items.length > 0 ? placeholderTextFor(items) : rawText
    if (text === '') return
    // 命令不进合并窗：立即处理
    if (text.startsWith('/')) {
      fireAsync(route(envelope, text, items))
      return
    }
    const key = mergeWindowKeyOf(envelope) // G-51：与 flush 同一键（含 chatId 维度）
    if (text.endsWith('..') || text.endsWith('!!')) {
      // 终止符：先并入再立即冲刷（!! 追加 steer 前缀）；附件取首条非空窗（合并窗内附件不叠加）
      const part = text.slice(0, -2).trim()
      let entry = pending.get(key)
      if (entry !== undefined && !canAppend(entry, part)) {
        flush(entry.envelope)
        entry = undefined
      }
      entry ??= createMergeEntry(envelope, '', [], false)
      const safePart = truncateUtf8(part, MAX_MERGE_UTF8_BYTES - entry.bytes - (entry.parts.length > 0 ? 1 : 0))
      if (safePart !== '') {
        entry.parts.push(safePart)
        entry.bytes += utf8Bytes(safePart) + (entry.parts.length > 1 ? 1 : 0)
      }
      entry.forceSteer = entry.forceSteer || text.endsWith('!!')
      if (entry.attachments.length === 0) entry.attachments = items
      pending.set(key, entry)
      flush(envelope)
      return
    }
    if (mergeWindowMs === 0) {
      fireAsync(route(envelope, text, items))
      return
    }
    let entry = pending.get(key)
    if (entry !== undefined) {
      if (!canAppend(entry, text) || Date.now() - entry.createdAt >= MAX_MERGE_ABSOLUTE_AGE_MS) {
        flush(entry.envelope)
        entry = undefined
      }
    }
    if (entry !== undefined) {
      entry.parts.push(text)
      entry.bytes += utf8Bytes(text) + 1
      if (entry.attachments.length === 0) entry.attachments = items
      scheduleMerge(entry)
      return
    }
    if (pending.size >= MAX_MERGE_KEYS) {
      const oldest = pending.values().next().value
      if (oldest !== undefined) flush(oldest.envelope)
    }
    pending.set(key, createMergeEntry(envelope, text, items))
  }, { priority: MESSAGE_PRIORITY.conversation })

  // 追踪最近活跃 agent（默认投递目标）；agent 退出时清理绑定与合并窗。
  // v0.7.3（#4）：DSH 的 agent/created | agent/disposed 事件签名是 (payload: { agent })，
  // 监听器收到的是载荷对象而非 agent 本身——旧代码 agent?.id 恒 undefined，
  // latestSessionId 永不赋值，未 /bind 用户的文本消息全部走到「没有活跃会话」被拒投
  // （现象：命令能回、文本全丢）。此处解包 payload.agent（兼容直接传 agent 的旧宿主）。
  const payloadAgent = (arg) => {
    const agent = arg?.agent ?? arg
    return (agent !== null && typeof agent === 'object' && agent.id !== undefined) ? agent : null
  }
  // 只追踪根 agent：后台 subagent 同样触发 agent/created，若不滤掉会把投递目标
  // 劫持到 subagent 会话。宿主暴露 ctx.agents.roots() 时用它判定；老宿主无此 API
  // 则退化为全量追踪（与修复前行为一致，仅解包修复生效）。
  const rootIds = () => {
    try {
      const roots = ctx?.agents?.roots?.()
      return (roots !== null && typeof roots === 'object') ? roots : null
    } catch { return null }
  }
  const trackAgent = (payload) => {
    const agent = payloadAgent(payload)
    if (agent === null) return
    const roots = rootIds()
    if (roots !== null) {
      const ids = (Array.isArray(roots) ? roots : Object.values(roots)).map((a) => a?.id)
      if (!ids.includes(agent.id)) return // subagent：不劫持默认投递目标
    }
    latestSessionId = agent.id
  }
  try {
    disposers.push(ctx.on('agent/created', trackAgent))
  } catch { /* 宿主无此事件：默认绑定不可用，仍可 /bind */ }
  try {
    disposers.push(ctx.on('agent/disposed', (payload) => {
      const agent = payloadAgent(payload)
      if (agent !== null && agent.id === latestSessionId) latestSessionId = null
      // 显式绑定到该 agent 的用户下次投递会收到「会话不存在」回执并自行 /bind，
      // 不在此清绑定：store 里的绑定在 agent 重启（同 id resume）后仍然有效。
    }))
  } catch { /* 同上 */ }

  return () => {
    disposeMessage?.()
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 反注册失败不致命 */ }
    }
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }
}
