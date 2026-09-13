// dsh-notifier routing/task-projection.mjs
// v0.10 任务投影（任务书提交5「移动任务路由」）：把会话台账 + 宿主 agent 状态折叠成一份
// **只读派生视图**，供手机 /tasks 列表、管理台任务页与歧义选择卡三处共用。
//
// 投影字段（设计冻结契约，逐项定义）：
//   - taskRef        会话 id（agent.id === session.id，稳定句柄）
//   - workspace      工作区名（registry 快照优先，缺档回落宿主 agent 的 cwd 末段）
//   - status         宿主 agent 状态（idle/running/…；取不到回落 'unknown'）
//   - attention      是否有待关注事项（待决提问/审批；布尔，由注入器派生）
//   - lastActivityAt 最近活跃时间戳（毫秒；缺档 0）
//   - boundChannels  该任务出站绑定的渠道类型（解析结果，非持久配置细节）
//
// 红线：投影是**派生的只读视图**，绝不把正文、凭证、回答、审批原因、绑定身份写进投影，
// 也绝不落盘——任何存储故障/宿主对象缺失只降级对应字段为安全占位，绝不抛。
//
// 与 session-registry / agent-router 的关系：本模块只**读**二者维护的台账与解析结果，
// 不持有、不写任何状态（任务选择的待决状态由 task-selection.mjs 独立持有）。

import { workspaceOf } from './session-registry.mjs'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 归一「渠道类型池」：支持数组或惰性 getter；非字符串项丢弃。 */
function globalTypesOf(channelTypes) {
  let list
  try {
    list = typeof channelTypes === 'function' ? channelTypes() : channelTypes
  } catch {
    list = []
  }
  if (!Array.isArray(list)) return []
  return list.filter((type) => typeof type === 'string' && type !== '')
}

/** 兜底取活跃会话 id + workspace（registry 缺档时回落宿主 ctx.agents.list）。 */
function activeInfosOf(registry, ctx) {
  const infos = []
  let activitySorted = false
  if (registry !== null && typeof registry?.activeSessions === 'function') {
    try {
      const ids = registry.activeSessions()
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id !== 'string' || id === '') continue
          let workspace = ''
          try {
            const record = registry.getSession(id)
            if (record !== undefined && typeof record?.workspace === 'string') workspace = record.workspace
          } catch { /* 台账读缺档：回落 agent cwd */ }
          infos.push({ id, workspace })
        }
        activitySorted = true
      }
    } catch { /* registry 抛错：回落宿主列表 */ }
  }
  if (infos.length === 0) {
    try {
      const list = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : []
      if (Array.isArray(list)) {
        for (const agent of list) {
          if (!isRecord(agent) || typeof agent.id !== 'string' || agent.id === '') continue
          infos.push({ id: agent.id, workspace: workspaceOf(agent) })
        }
      }
    } catch { /* 宿主列表不可用：空投影 */ }
  }
  return { infos, activitySorted }
}

/** 为补全 workspace 提供兜底（台账无快照时实时取 agent cwd 末段）。 */
function workspaceOfId(registry, ctx, id) {
  try {
    const record = registry?.getSession?.(id)
    if (record !== undefined && typeof record?.workspace === 'string' && record.workspace !== '') {
      return record.workspace
    }
  } catch { /* 台账读缺档 */ }
  try {
    const agent = ctx?.agents?.get?.(id)
    if (agent !== undefined && agent !== null) return workspaceOf(agent)
  } catch { /* 宿主读缺档 */ }
  return ''
}

/** 待关注事项判定（注入器；缺省恒 false）。 */
function attentionOfId(attentionOf, id) {
  try {
    return attentionOf(id) === true
  } catch {
    return false
  }
}

/**
 * 投影活跃任务为只读派生视图。
 *
 * @param {object} deps
 * @param {import('./session-registry.mjs').createSessionRegistry} [deps.registry] - 会话台账
 * @param {import('./agent-router.mjs').createAgentRouter} [deps.router] - 路由解析引擎（boundChannels）
 * @param {object} [deps.ctx] - cordis 上下文（agent 状态）
 * @param {string[]|(() => string[])} [deps.channelTypes] - 全局已启用渠道类型池（出站过滤白名单）
 * @param {(taskRef: string) => boolean} [deps.attentionOf] - 待关注事项判定器；缺省恒 false
 * @returns {{ tasks: Array<{ taskRef: string, workspace: string, status: string,
 *   attention: boolean, lastActivityAt: number, boundChannels: string[] }>, activitySorted: boolean }}
 *   tasks 按 activeSessions 顺序（已按 lastActivityAt 降序）；activitySorted 标记排序可信度。
 */
export function projectTasks(deps = {}) {
  const { registry = null, router = null, ctx = null, channelTypes = [], attentionOf } = deps
  const attentionFn = typeof attentionOf === 'function' ? attentionOf : () => false
  const globalTypes = globalTypesOf(channelTypes)
  const { infos, activitySorted } = activeInfosOf(registry, ctx)

  const tasks = infos.map((info) => {
    const workspace = (() => {
      if (info.workspace !== '') return info.workspace
      return workspaceOfId(registry, ctx, info.id)
    })()
    let status = 'unknown'
    try {
      const value = ctx?.agents?.get?.(info.id)?.status
      if (typeof value === 'string' && value !== '') status = value
    } catch { /* 宿主读缺档：unknown */ }
    let lastActivityAt = 0
    try {
      const record = registry?.getSession?.(info.id)
      // 台账内部字段为 lastActiveAt（session-registry §2 形状），投影对外字段为
      // lastActivityAt（契约冻结名）——此处只做一次字段名翻译，不带任何敏感数据。
      const value = record?.lastActiveAt
      if (typeof value === 'number' && Number.isFinite(value)) lastActivityAt = value
    } catch { /* 台账读缺档：0 */ }
    let boundChannels = []
    try {
      if (router !== null && typeof router.resolveOutbound === 'function') {
        const resolved = router.resolveOutbound(info.id, workspace, globalTypes)
        if (Array.isArray(resolved?.channelTypes)) boundChannels = resolved.channelTypes
      }
    } catch { /* 解析缺档：[] */ }
    return {
      taskRef: info.id,
      workspace,
      status,
      attention: attentionOfId(attentionFn, info.id),
      lastActivityAt,
      boundChannels,
    }
  })

  return { tasks, activitySorted }
}

/**
 * 任务投影的脱敏快照（管理台 / 诊断用）：与 projectTasks 同源，但把 boundChannels 之外的
 * 可用信息也归一到固定形状，并在缺档时给出可读的降级标记。此函数是管理台「任务状态」的
 * 单一数据源，确保 Web 与手机 /tasks 看到同一份只读事实。
 *
 * @param {object} deps - 同 projectTasks
 * @returns {{ tasks: Array<object>, count: number }}
 */
export function tasksSnapshot(deps = {}) {
  const { tasks, activitySorted } = projectTasks(deps)
  return {
    count: tasks.length,
    activitySorted,
    tasks: tasks.map((task) => ({ ...task })),
  }
}