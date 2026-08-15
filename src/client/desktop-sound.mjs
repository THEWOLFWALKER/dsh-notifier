// dsh-notifier client/desktop-sound.mjs
// client 半骨架（阶段 2，实验性）：desktop 系统通知 / sound 提示音的纯逻辑半。
//
// 为什么只有纯逻辑：host 仓库是零依赖 ESM 插件，没有客户端构建管线；Web Notification /
// Web Audio / shell.overlay 组件必须跑在 DSH 客户端运行时里，由它按下面的契约挂载。
// 这里交付的是可单测的决策逻辑 + 挂载契约说明，宿主仓库绝不 ship 假的客户端代码。
//
// 挂载契约（客户端运行时实现方看这里）：
//   1. 通过 shell.overlay 注册一个隐形观察组件（不渲染 UI，只订阅）。
//   2. 用 useSessions / useWorkspaces 快照实现 out-of-view 抑制：
//      通知所属 session 若在当前视图内（聚焦/可见）→ 只走 bell，不弹 desktop。
//   3. desktop：new Notification(title, { body, tag })；tag 用于同会话通知互相替换
//      （同 tag 新通知替换旧的，不堆叠）。点击 → sessions.open(sessionId)；
//      新开窗口场景用 localStorage 暂存 sessionId 补跳。
//   4. sound：Web Audio 播 pickSoundForLevel(level).sound 对应音色；
//      首次用户手势时解锁 AudioContext（规避自动播放策略）。
//   5. requireManualDismiss: true 的通知（approval / error）常驻，不自动消失。

/** level → 提示音色 + 是否需要手动消除（approval/error 常驻，完成类自动消失）。 */
const LEVEL_SOUND = {
  timeSensitive: { sound: 'alert', requireManualDismiss: true },
  critical: { sound: 'alert', requireManualDismiss: true },
  active: { sound: 'chime', requireManualDismiss: false },
  passive: { sound: 'ping', requireManualDismiss: false },
}

/** 取某 level 的提示音决策；未知 level 回 passive 档（最轻）。 */
export function pickSoundForLevel(level) {
  return LEVEL_SOUND[level] ?? LEVEL_SOUND.passive
}

/**
 * 组装 Web Notification 载荷。
 * tag 是同会话替换的关键：优先 msg.group（会话分组键），否则用标题——
 * 同一会话的连续通知共用 tag，新的替换旧的，通知中心不堆叠。
 * @returns {{ title, body, tag }} 纯数据，可直接 new Notification(title, { body, tag })。
 */
export function buildDesktopNotification(message = {}) {
  const title = typeof message.title === 'string' ? message.title : ''
  const content = typeof message.content === 'string' ? message.content : ''
  const tag = (typeof message.group === 'string' && message.group !== '')
    ? message.group
    : (title !== '' ? title : 'dsh-notifier')
  return {
    title,
    body: content,
    tag,
    ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
  }
}

/** out-of-view 抑制判定：目标 session 在当前视图内则抑制 desktop 弹窗（只留 bell）。 */
export function shouldSuppressDesktop({ activeSessionId, visibleSessionIds = [], targetSessionId } = {}) {
  if (targetSessionId === undefined || targetSessionId === null) return false
  if (activeSessionId === targetSessionId) return true
  return visibleSessionIds.includes(targetSessionId)
}

/** 挂载契约快照（客户端实现方对照用，也供测试断言不漂移）。 */
export const CLIENT_OVERLAY_CONTRACT = Object.freeze({
  kind: 'shell.overlay',
  invisible: true,
  capabilities: ['desktop-notification', 'sound', 'out-of-view-suppression', 'click-to-open-session'],
  experimental: true,
})
