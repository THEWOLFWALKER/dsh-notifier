// dsh-notifier host/capability.mjs
// 窄宿主能力快照（任务书 v0.10 第 5 节）：供装配、管理台与诊断共用。
// 只做公开 seam 的特性检测——绝不读私有字段、绝不变更宿主过滤、绝不携带
// sessionId、正文、token、chatId、userId 或 provider 凭证。
//
// 能力检测失败只能降级对应能力，不得阻止通知与其他通道启动。

const isRecord = (value) => typeof value === 'object' && value !== null

/** 每类事件在快照里最多保留的键数（有界，防诊断面膨胀）。 */
export const MAX_RECEIVED_EVENT_KEYS = 64

/**
 * 宿主事件订阅模式：current / root / dual / unsupported。
 * - current: 当前（可能被 scope 过滤的）上下文有 .on
 * - root: 存在自反的 cordis root 上下文且其 .on 可用
 * - dual: current 与 root 都可用（组合订阅方必须自行按事件指纹去重）
 * - unsupported: 无可用的 .on
 */
export function detectEventsMode(ctx) {
  const current = isRecord(ctx) && typeof ctx.on === 'function'
  const root = isRecord(ctx) && isRecord(ctx.root) && ctx.root !== ctx
    && ctx.root.root === ctx.root && typeof ctx.root.on === 'function'
  if (current && root) return 'dual'
  if (root) return 'root'
  if (current) return 'current'
  return 'unsupported'
}

/**
 * 原生提问 seam 模式（仅描述宿主公开能力，不含插件 fallback）。
 * - provider-chain: ctx.userQuestions 同时暴露 ask 与 registerProvider
 * - native-event: 仅 ask（理论上的事件 + 回答接口形态）
 * - unsupported: 无 ctx.userQuestions
 */
export function detectQuestionsMode(ctx) {
  const uq = ctx?.userQuestions
  if (isRecord(uq) && typeof uq.ask === 'function') {
    return typeof uq.registerProvider === 'function' ? 'provider-chain' : 'native-event'
  }
  return 'unsupported'
}

/**
 * 会话续接（followup/inject/steer）能力。宿主 Agent API 通过 ctx.agents 暴露
 * 活跃会话查询（list/get）；投递能力本身在 agent 实例上，静态只能保守判定。
 * 任一不可用都标 unknown（能力可能缺失也可能只是当前无可探测对象），绝不标
 * available 谎报。
 */
export function detectConversationMode(ctx) {
  const agents = ctx?.agents
  const list = isRecord(agents) && typeof agents.list === 'function'
  const get = isRecord(agents) && typeof agents.get === 'function'
  const basis = list || get
  return {
    followup: basis ? 'available' : 'unknown',
    inject: basis ? 'available' : 'unknown',
    steer: basis ? 'available' : 'unknown',
  }
}

/** 宿主版本号探测（防御式，取不到返回 'unknown'）。 */
export function detectHostVersion(ctx) {
  const value = ctx?.version ?? ctx?.config?.version ?? ctx?.hostVersion
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return 'unknown'
}

const receivedRowOf = (row) => {
  if (row === null || typeof row !== 'object') return null
  const received = typeof row.received === 'number' ? row.received : 0
  if (received <= 0) return { received: 0 }
  const rowResult = { received }
  if (typeof row.lastAt === 'number' && row.lastAt > 0) rowResult.lastAt = row.lastAt
  return rowResult
}

/**
 * 从 host-events registrar 的事件统计生成有界「已收到」视图，只保留 received
 * 计数与最后到达时间；attempts/registered/failures 等装配诊断不进入面向用户
 * 的快照。键数有界（MAX_RECEIVED_EVENT_KEYS），杜绝诊断面单调膨胀。
 */
export function receivedEventsView(eventsSnapshot) {
  const source = isRecord(eventsSnapshot) ? (eventsSnapshot.events ?? eventsSnapshot) : {}
  const out = {}
  let inserted = 0
  for (const [event, row] of Object.entries(source)) {
    if (inserted >= MAX_RECEIVED_EVENT_KEYS) break
    const view = receivedRowOf(row)
    if (view === null) continue
    out[String(event)] = view
    inserted += 1
  }
  return out
}

/**
 * 组合出最终的宿主能力快照（纯函数，无副作用，可测试）。
 * @param {object} deps
 * @param {object} [deps.ctx] - cordis 上下文
 * @param {object} [deps.events] - registrar.snapshot() 的产物（events/context/scope）
 * @param {boolean} [deps.questionsFallbackEnabled=false] - 插件自有 ask_user fallback 是否可用
 * @param {'available'|'unavailable'|'unknown'} [deps.webLocal='unknown'] - Web 管理台是否本机可用
 * @param {'available'|'unavailable'|'unknown'} [deps.imageInput='unknown'] - 图片入站能力
 * @returns {{ host: {version: string}, events: {mode: string, received: object},
 *   questions: {mode: string, webLocal: string}, conversation: {mode: object},
 *   media: {imageInput: string} }}
 */
export function createHostCapabilitySnapshot(deps = {}) {
  const ctx = deps.ctx
  const hostQuestionsMode = detectQuestionsMode(ctx)
  const questionsMode = hostQuestionsMode === 'unsupported'
    && deps.questionsFallbackEnabled === true
    ? 'plugin-tool-fallback'
    : hostQuestionsMode
  const webLocal = deps.webLocal === 'available' || deps.webLocal === 'unavailable'
    ? deps.webLocal
    : 'unknown'
  const imageInput = deps.imageInput === 'available' || deps.imageInput === 'unavailable'
    ? deps.imageInput
    : 'unknown'
  return {
    host: { version: detectHostVersion(ctx) },
    events: {
      mode: detectEventsMode(ctx),
      received: receivedEventsView(deps.events),
    },
    questions: { mode: questionsMode, webLocal },
    conversation: { mode: detectConversationMode(ctx) },
    media: { imageInput },
  }
}