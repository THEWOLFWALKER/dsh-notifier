function relativeText(value, now = Date.now()) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const sec = Math.max(0, Math.round((now - n) / 1000))
  if (sec < 60) return { en: 'just now', zh: '刚刚' }
  const min = Math.round(sec / 60)
  if (min < 60) return { en: `${min} min ago`, zh: `${min} 分钟前` }
  const hours = Math.round(min / 60)
  if (hours < 24) return { en: `${hours} h ago`, zh: `${hours} 小时前` }
  const days = Math.round(hours / 24)
  return { en: `${days} d ago`, zh: `${days} 天前` }
}

export function createTaskProjection({ getTasks, now = Date.now } = {}) {
  return {
    list() {
      try {
        const snapshot = typeof getTasks === 'function' ? getTasks() : null
        const rows = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
        return rows.map((task) => {
          const n = Number(task?.lastActivityAt)
          return {
            taskRef: String(task?.taskRef ?? ''),
            ...(typeof task?.workspace === 'string' && task.workspace !== '' ? { workspace: task.workspace } : {}),
            status: typeof task?.status === 'string' ? task.status : 'unknown',
            attention: task?.attention === true,
            boundChannels: Array.isArray(task?.boundChannels) ? task.boundChannels.map(String) : [],
            ...(Number.isFinite(n) && n > 0 ? { lastActivityAt: new Date(n).toISOString(), relativeTime: relativeText(n, now()) } : {}),
          }
        })
      } catch {
        return []
      }
    },
  }
}
