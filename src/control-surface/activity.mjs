const SECRETISH = /(?:token|secret|password|credential|authorization|cookie|webhook|chatid|userid|accountid|body|content|message)$/i
const ALLOWED_DETAIL_KEYS = new Set([
  'channel', 'direction', 'status', 'reason', 'delivered', 'skipped', 'failed',
  'saved', 'deleted', 'hotApplied', 'taskRef', 'workspace',
  'action', 'source', 'count',
])

const safePrimitive = (value) => {
  if (typeof value === 'string') return value.slice(0, 240)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean' || value === null) return value
  return undefined
}

function sanitizeDetail(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_DETAIL_KEYS.has(key) || SECRETISH.test(key)) continue
    if (Array.isArray(item)) {
      out[key] = item.slice(0, 16).map(safePrimitive).filter((v) => v !== undefined)
      continue
    }
    const safe = safePrimitive(item)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

function timeText(at, now) {
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return { en: 'just now', zh: '刚刚' }
  const min = Math.round(sec / 60)
  if (min < 60) return { en: `${min} min ago`, zh: `${min} 分钟前` }
  const hours = Math.round(min / 60)
  return { en: `${hours} h ago`, zh: `${hours} 小时前` }
}

function titleFor(row) {
  const channel = row.detail?.channel ? ` · ${row.detail.channel}` : ''
  const map = {
    'delivery-finished': { en: `Notification delivered${channel}`, zh: `通知已送达${channel}` },
    'delivery-failed': { en: `Notification delivery failed${channel}`, zh: `通知发送失败${channel}` },
    'channel-test-ok': { en: `Channel test succeeded${channel}`, zh: `渠道测试成功${channel}` },
    'channel-test-failed': { en: `Channel test failed${channel}`, zh: `渠道测试失败${channel}` },
    'channel-saved': { en: `Channel configuration saved${channel}`, zh: `渠道配置已保存${channel}` },
    'channel-removed': { en: `Channel configuration removed${channel}`, zh: `渠道配置已删除${channel}` },
    'question-settled': { en: 'Question handled', zh: '问题已处理' },
  }
  return map[row.action] ?? { en: row.action, zh: row.action }
}

export function createSurfaceActivity({ capacity = 100, now = Date.now } = {}) {
  const cap = Math.max(20, Math.min(500, Number(capacity) || 100))
  const rows = []
  let seq = 0

  const record = (category, action, detail = {}) => {
    const row = Object.freeze({
      id: String(++seq),
      atMs: now(),
      category: String(category || 'system'),
      action: String(action || 'unknown').slice(0, 64),
      detail: Object.freeze(sanitizeDetail(detail)),
    })
    rows.unshift(row)
    if (rows.length > cap) rows.length = cap
    return row
  }

  return {
    record,
    recordDelivery(sendRecord = {}) {
      const delivered = Array.isArray(sendRecord.delivered) ? sendRecord.delivered : []
      const failed = Array.isArray(sendRecord.failed)
        ? sendRecord.failed.map((item) => typeof item?.channel === 'string' ? item.channel : '').filter(Boolean)
        : []
      const skipped = Array.isArray(sendRecord.skipped) ? sendRecord.skipped : []
      return record('notification', failed.length > 0 ? 'delivery-failed' : 'delivery-finished', {
        delivered, failed, skipped, status: sendRecord.ok === false ? 'failed' : 'ok',
      })
    },
    list({ limit = 30, category = null } = {}) {
      const n = Math.max(1, Math.min(100, Number(limit) || 30))
      const wanted = typeof category === 'string' && category !== '' ? category : null
      return rows
        .filter((row) => wanted === null || row.category === wanted)
        .slice(0, n)
        .map((row) => ({
          id: row.id,
          at: new Date(row.atMs).toISOString(),
          timeText: timeText(row.atMs, now()),
          category: ['notification', 'control', 'configuration', 'system'].includes(row.category) ? row.category : 'system',
          level: row.detail?.status === 'failed' ? 'error' : (row.action.includes('failed') ? 'warn' : 'info'),
          title: titleFor(row),
          ...(row.detail?.reason ? { detail: { en: String(row.detail.reason), zh: String(row.detail.reason) } } : {}),
        }))
    },
  }
}
