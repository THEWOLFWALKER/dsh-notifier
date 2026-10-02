// Explicit private-chat task selection. Account identity is stable across token rotation.
import { principalKey, bindingKey } from '../inbound/identity.mjs'
import { deleteDurable, setDurable, transactDurable } from '../inbound/store.mjs'

export function currentTaskKey(channel, userId, accountId = 'default') {
  const c = String(channel ?? '').trim().toLowerCase()
  const u = String(userId ?? '').trim()
  const a = String(accountId ?? 'default').trim() || 'default'
  if (!c || !u || a.includes(':') || c.includes(':')) return null
  return `bind:${principalKey(c, a, u)}`
}

// Only canonical configured accounts prove legacy migration. Membership alone is not proof.
export function configuredTaskAccounts(store, channel) {
  try {
    const row = store?.get?.(`${channel}:account`)
    if (!row || typeof row !== 'object') return []
    const id = row.accountId || (['qq', 'feishu', 'dingtalk'].includes(channel) ? row.appId || row.clientId : null) || 'default'
    return [String(id)]
  } catch { return [] }
}

export function createCurrentTaskAuthority({ store = null, logger = null, accountsFor = c => configuredTaskAccounts(store, c) } = {}) {
  const read = k => { try { return store?.get?.(k) } catch { return undefined } }
  const refOf = v => typeof v === 'string' && v.trim() ? v : null
  function get({ channel, userId, accountId = 'default' } = {}) {
    const key = currentTaskKey(channel, userId, accountId)
    if (!key) return null
    const selected = refOf(read(key))
    if (selected) return selected
    const c = String(channel).trim().toLowerCase()
    const legacy = `bind:${bindingKey(c, userId)}`
    if (!refOf(read(legacy))) return null
    let accounts
    try { accounts = [...new Set(accountsFor(c).map(String))] } catch { return null }
    if (accounts.length !== 1 || accounts[0] !== (String(accountId ?? 'default').trim() || 'default')) return null
    try {
      const result = transactDurable(store, draft => {
        if (!refOf(draft[key]) && refOf(draft[legacy])) { draft[key] = draft[legacy]; delete draft[legacy] }
        return refOf(draft[key])
      })
      return result.committed ? result.value : null
    } catch { return null }
  }
  return {
    get,
    select({ channel, userId, accountId } = {}, taskRef) {
      const key = currentTaskKey(channel, userId, accountId)
      const ref = String(taskRef ?? '').trim()
      if (!key || !ref) return { ok: false, reason: 'invalid' }
      try { if (setDurable(store, key, ref) === true) return { ok: true, taskRef: ref } } catch {}
      try { logger?.warn?.('[dsh-notifier/current-task]', '当前任务保存失败') } catch {}
      return { ok: false, reason: 'storage-failed' }
    },
    clear(principal = {}) {
      const key = currentTaskKey(principal.channel, principal.userId, principal.accountId)
      if (!key) return { ok: false, existed: false }
      // Consume only a provably unique legacy row before clearing it.
      get(principal)
      try { const r = deleteDurable(store, key); return { ok: r.durable === true, existed: r.existed === true } }
      catch { return { ok: false, existed: false } }
    },
  }
}
