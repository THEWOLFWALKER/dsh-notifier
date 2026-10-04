// Explicit private-chat task selection. Account identity is stable across token rotation.
import { principalKey } from '../inbound/identity.mjs'
import { deleteDurable, setDurable } from '../inbound/store.mjs'

export function currentTaskKey(channel, userId, accountId) {
  const c = String(channel ?? '').trim().toLowerCase()
  const u = String(userId ?? '').trim()
  const a = String(accountId ?? '').trim()
  if (!c || !u || !a || a === 'default' || a.includes(':') || c.includes(':')) return null
  return `bind:${principalKey(c, a, u)}`
}

export function createCurrentTaskAuthority({ store = null, logger = null } = {}) {
  const read = k => { try { return store?.get?.(k) } catch { return undefined } }
  const refOf = v => typeof v === 'string' && v.trim() ? v : null
  function get({ channel, userId, accountId } = {}) {
    const key = currentTaskKey(channel, userId, accountId)
    if (!key) return null
    const selected = refOf(read(key))
    if (selected) return selected
    // Old channel:user rows have no trustworthy account owner. Ignore them; Native re-setup
    // writes the new principal key explicitly. Never infer a default account from old state.
    return null
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
