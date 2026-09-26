// v0.13 canonical outbound configuration migration.
//
// YAML remains a static bootstrap source.  Persistent outbound state has one
// authority: channel:<type>:outbound.  The old Admin outbound key is removed
// during migration; <type>:account is retained because it is also the inbound
// credential domain for several channels, but is never read by the outbound
// runtime after migration.

import { isStorageUntrusted, transactDurable } from '../inbound/store.mjs'

export const STATE_SCHEMA_KEY = 'state:schema-version'
export const V013_MIGRATION_KEY = 'state:migration:v0.13'
export const STATE_SCHEMA_VERSION = 13

const DUAL_INBOUND_DOMAIN = new Set(['feishu', 'dingtalk'])
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
const canonicalKey = (type) => `channel:${type}:outbound`
const oldAdminKey = (type) => `admin:channel:${type}:outbound`

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return null }
}

function read(store, key) {
  try { return typeof store?.get === 'function' ? store.get(key) : undefined } catch { return undefined }
}

function migrationComplete(store) {
  const marker = plain(read(store, V013_MIGRATION_KEY))
  return marker?.status === 'complete' && Number(read(store, STATE_SCHEMA_KEY)) >= STATE_SCHEMA_VERSION
}

/**
 * Migrate legacy outbound state once, before runtime channel assembly.
 *
 * The operation is deliberately fail-closed: backup failure or transaction
 * failure leaves the old state untouched and returns ok:false.  Production
 * createStore supplies backup(); small legacy test doubles may omit it, in
 * which case the state marker still records that no file backup was possible.
 */
export function migrateCanonicalChannelConfig({
  store,
  channelTypes = [],
  adminEnabled = false,
  warn = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (migrationComplete(store)) return { ok: true, already: true, migrated: [] }
  if (typeof store?.bootStatus === 'function' && isStorageUntrusted(store.bootStatus())) {
    warn('state 不可信（读取失败或损坏），跳过 v0.13 通道配置迁移（保持 fail-closed）')
    return { ok: false, reason: 'state-untrusted', migrated: [] }
  }

  const backup = typeof store?.backup === 'function'
    ? (() => { try { return store.backup('pre-v0.13') } catch (error) { return { ok: false, error } } })()
    : { ok: true, path: null, unavailable: true }
  if (backup.ok !== true) {
    warn('v0.13 通道配置迁移前备份失败，未修改 state')
    return { ok: false, reason: 'backup-failed', migrated: [] }
  }

  const migrated = []
  const result = transactDurable(store, (draft) => {
    for (const type of channelTypes) {
      if (typeof type !== 'string' || type === '') continue
      const canonical = plain(draft[canonicalKey(type)])
      const oldAdmin = plain(draft[oldAdminKey(type)])

      // A canonical value already wins.  Old Admin state is still retired so
      // a later code path cannot accidentally resurrect it.
      if (canonical === null && oldAdmin !== null && adminEnabled === true) {
        draft[canonicalKey(type)] = clone(oldAdmin)
        migrated.push(type)
      } else if (canonical === null && !DUAL_INBOUND_DOMAIN.has(type) && adminEnabled === true) {
        // Non-dual <type>:account historically served as the Admin outbound
        // overlay.  Keep the key for inbound compatibility; runtime stops
        // reading it as soon as this marker commits.
        const account = plain(draft[`${type}:account`])
        if (account !== null) {
          draft[canonicalKey(type)] = clone(account)
          migrated.push(type)
        }
      }

      if (adminEnabled === true && Object.prototype.hasOwnProperty.call(draft, oldAdminKey(type))) {
        delete draft[oldAdminKey(type)]
      }
    }

    // If Admin is disabled while old Admin data exists, defer completion so a
    // later enabled boot can migrate it without reviving it while disabled.
    const deferred = adminEnabled !== true && channelTypes.some((type) =>
      typeof type === 'string' && Object.prototype.hasOwnProperty.call(draft, oldAdminKey(type)))
    if (deferred) return { deferred: true }

    draft[STATE_SCHEMA_KEY] = STATE_SCHEMA_VERSION
    draft[V013_MIGRATION_KEY] = {
      status: 'complete',
      version: '0.13.0',
      migratedAt: now(),
      migrated,
      backupPath: backup.path ?? null,
    }
    return { deferred: false }
  })

  if (result.ok !== true) {
    warn(`v0.13 通道配置迁移未落盘（${result.code ?? 'unknown'}），运行期不读取 legacy`)
    return { ok: false, reason: result.code ?? 'storage-failed', migrated: [] }
  }
  if (result.value?.deferred === true) return { ok: true, deferred: true, migrated: [] }
  return { ok: true, already: false, migrated, backupPath: backup.path ?? null }
}
