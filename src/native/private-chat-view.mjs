// dsh-notifier v0.15 Stage 1 — 私聊控制用户视图。
//
// 职责（03_ARCHITECTURE_REWRITE_PLAN）：只表达「是否已确认本人 / 当前任务 / 允许的使用者 /
// 待处理事项」四件事，**绝不**向浏览器返回 binding / session / principal / policy 等内部形状。
//
// 具体做法：
//  - 使用者对外只有不透明 id（成员键的哈希前缀），真实成员键留在服务端，由 `memberKeyOf()`
//    供 actions 解析——浏览器拿到的 id 既稳定又不泄漏内部键形状；
//  - 不出现 role / origin / pairedAt 等内部字段，只给用户词（可以管理 / 可以接收通知）；
//  - 待处理项只给「标题 + 来源 + 时间 + 可选项」，UI 永远看不到 interaction ledger 行。
//
// 纯投影：只读上游已脱敏投影，不写 store、不结算、不调 provider。

import { createHash } from 'node:crypto'
import { displayNameOf, toInboundChannelName } from '../inbound/capability-matrix.mjs'
import { PERMISSION_TEXT, VERIFIED_TEXT, maskIdentity, pick, relativeText } from './vocabulary.mjs'

const DEFAULT_ACCOUNT = 'default'

/** 首次启用向导最多展示几个候选任务（超出只影响「选择任务」步，不影响摘要）。 */
const TASK_CAP = 10

const sha = (value) => createHash('sha256').update(String(value)).digest('hex')

/** 内部成员键 → 不透明用户 id（稳定、不可逆、不泄漏键形状）。 */
function opaqueUserId(memberKey) {
  return `u_${sha(memberKey).slice(0, 12)}`
}

function channelLabelOf(channel, lang) {
  return displayNameOf(toInboundChannelName(channel), lang)
}

function safeList(source, method) {
  try {
    const rows = typeof source?.[method] === 'function' ? source[method]() : []
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

/**
 * @param {object} deps
 * @param {{ list: () => object[], listPending: () => object[] }} [deps.members] - 成员投影
 * @param {{ list: () => object[] }} [deps.questions] - 待决提问投影
 * @param {{ list: () => object[] }} [deps.tasks] - 任务投影（候选与标题来源）
 * @param {(owner: object) => string|null} [deps.selectedTaskRef] - 显式选择的当前任务 ref
 *   （current-task authority 的读投影）。**R1：当前任务只能来自这里**——没有显式选择即无当前
 *   任务，绝不从投影的 recent / first / attention 推导。
 * @param {() => boolean} [deps.isEnabled] - 私聊控制是否开启（默认按「有使用者」推断）
 * @param {() => number} [deps.now]
 */
export function createPrivateChatView({
  members = null,
  questions = null,
  tasks = null,
  selectedTaskRef = null,
  isEnabled = null,
  now = Date.now,
} = {}) {
  const memberRows = () => safeList(members, 'list')
  const pendingMemberRows = () => safeList(members, 'listPending')
  const questionRows = () => safeList(questions, 'list')
  const taskRows = () => safeList(tasks, 'list')

  const ownerOf = (rows) => rows.find((row) => row?.role === 'owner') ?? null

  /** 不透明 id → 真实成员键（仅服务端动作解析用；绝不进入任何对外载荷）。 */
  const memberKeyOf = (id) => {
    const wanted = String(id ?? '')
    for (const row of [...memberRows(), ...pendingMemberRows()]) {
      const key = String(row?.key ?? '')
      if (key !== '' && opaqueUserId(key) === wanted) return key
    }
    return null
  }

  const users = (lang) => memberRows().map((row) => {
    const key = String(row?.key ?? '')
    const label = typeof row?.label === 'string' && row.label.trim() !== '' ? row.label.trim() : null
    return {
      id: opaqueUserId(key),
      displayName: label ?? maskIdentity(row?.userId) ?? pick({ en: 'User', zh: '使用者' }, lang),
      permissionText: pick(PERMISSION_TEXT[row?.role] ?? PERMISSION_TEXT.member, lang),
    }
  })

  const titleOf = (task) => {
    const workspace = typeof task?.workspace === 'string' && task.workspace !== '' ? task.workspace : null
    return workspace ?? String(task?.taskRef ?? '')
  }

  /** 显式选择的当前任务 ref（owner 维度）；无显式选择 / 无 owner → null。 */
  const selectedRefOf = (owner) => {
    if (owner === null || typeof selectedTaskRef !== 'function') return null
    try {
      const ref = String(selectedTaskRef(owner) ?? '').trim()
      return ref === '' ? null : ref
    } catch { return null }
  }

  /**
   * 当前任务：**只**来自显式选择（R1）。显式 ref 指向的任务当前不活跃 → 视为未选择
   * （由 needsReselect 标记需重新选择）。绝不回退到投影的 attention / 首个任务。
   */
  const currentTaskOf = (owner) => {
    const ref = selectedRefOf(owner)
    if (ref === null) return undefined
    const row = taskRows().find((candidate) => String(candidate?.taskRef ?? '') === ref)
    if (row === undefined) return undefined
    return { id: ref, title: titleOf(row) }
  }

  /** 显式选择指向的任务已不在活跃任务集 → 需用户重新选择（旧绑定无稳定 task id）。 */
  const needsReselectOf = (owner) => {
    const ref = selectedRefOf(owner)
    if (ref === null) return false
    return !taskRows().some((candidate) => String(candidate?.taskRef ?? '') === ref)
  }

  /** 「选择任务」步的候选：当前活跃任务，去重保序、有界。 */
  const taskCandidates = () => {
    const seen = new Set()
    const out = []
    for (const row of taskRows()) {
      const id = String(row?.taskRef ?? '')
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      out.push({ id, title: titleOf(row) })
    }
    return out.slice(0, TASK_CAP)
  }

  /**
   * 首次启用向导（NATIVE_UX_V2：确认本人 → 选择任务 → 试用）。`step` 是**派生词**，
   * 不落盘：已确认本人且有当前任务即为「可以用了」（ready），此时页面只显示摘要。
   * 待确认身份与候选任务都给不透明 id，绝不出内部键。
   */
  const setup = (lang) => {
    const owner = ownerOf(memberRows())
    const verified = owner !== null
    const pendingIdentities = pendingMemberRows().map((row) => ({
      id: opaqueUserId(String(row?.key ?? '')),
      displayName: maskIdentity(row?.userId) ?? pick({ en: 'User', zh: '使用者' }, lang),
      sourceText: pick({
        en: `From ${channelLabelOf(row?.channel, 'en')}`,
        zh: `来自 ${channelLabelOf(row?.channel, 'zh')}`,
      }, lang),
    }))
    const step = !verified ? 'confirm' : (currentTaskOf(owner) ? 'ready' : 'task')
    return { step, pendingIdentities, tasks: taskCandidates() }
  }

  const pendingItems = (lang = 'zh') => {
    const items = []
    for (const row of questionRows()) {
      const options = Array.isArray(row?.options) ? row.options : []
      items.push({
        id: String(row?.ref ?? ''),
        title: String(row?.question ?? ''),
        sourceText: pick({ en: 'From a task', zh: '来自任务' }, lang),
        createdText: pick(relativeText(Date.parse(String(row?.createdAt ?? '')) || null, now()), lang),
        choices: [
          ...options.map((option) => ({
            id: String(option?.value ?? ''),
            label: String(option?.label ?? ''),
            kind: 'choose',
          })),
          { id: 'reject', label: pick({ en: 'Handle later', zh: '稍后处理' }, lang), kind: 'reject' },
        ],
      })
    }
    for (const row of pendingMemberRows()) {
      items.push({
        id: opaqueUserId(String(row?.key ?? '')),
        title: pick({ en: 'Someone wants to connect', zh: '有人想要连接' }, lang),
        sourceText: pick({
          en: `From ${channelLabelOf(row?.channel, 'en')}`,
          zh: `来自 ${channelLabelOf(row?.channel, 'zh')}`,
        }, lang),
        createdText: pick(relativeText(Number(row?.at), now()), lang),
        choices: [
          { id: 'approve', label: pick({ en: 'Confirm it is me', zh: '确认是我' }, lang), kind: 'choose' },
          { id: 'dismiss', label: pick({ en: 'Ignore', zh: '忽略' }, lang), kind: 'reject' },
        ],
      })
    }
    return items
  }

  return {
    /** 契约 PrivateChatSummary。 */
    summary(lang = 'zh') {
      const rows = memberRows()
      const owner = ownerOf(rows)
      const task = currentTaskOf(owner)
      const pendingCount = questionRows().length + pendingMemberRows().length
      const enabled = typeof isEnabled === 'function'
        ? isEnabled() === true
        : rows.length > 0 || pendingCount > 0
      const accountId = owner?.accountId === undefined || String(owner.accountId) === ''
        ? DEFAULT_ACCOUNT
        : String(owner.accountId)
      const channel = owner === null ? undefined : {
        id: `${String(owner.channel ?? '')}:${accountId}`,
        name: channelLabelOf(owner.channel, lang),
        accountName: accountId,
      }
      return {
        enabled,
        verified: owner !== null,
        verifiedText: pick(owner !== null ? VERIFIED_TEXT.yes : VERIFIED_TEXT.no, lang),
        ...(channel ? { channel } : {}),
        ...(task ? { currentTask: task } : {}),
        users: users(lang),
        pendingCount,
        // 首次启用向导的派生状态（确认本人 → 选择任务 → 可以用了）。
        setup: setup(lang),
      }
    },

    /** 契约 PendingItem[]（顺序稳定：提问在前，待确认身份在后）。 */
    pendingItems,

    /** 服务端专用：不透明 id → 真实成员键；供 actions 解析，绝不进入对外载荷。 */
    memberKeyOf,
  }
}
