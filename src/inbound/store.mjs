// dsh-notifier inbound/store.mjs
// 极简 JSON 文件持久化（零依赖）：pending 审批表、去重表、轮询 cursor 重启可恢复。
// 原子写：先写临时文件再 rename；文件权限 0600（v0.3.0 起存微信 iLink bot_token 等凭证）；
// 单键读写；文件损坏时回退空状态（fail-open 到「无记忆」，
// 但审批裁决状态丢失只会导致超时回退桌面，不会误批准——静默永不批准）。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** DSH 数据目录：$DSH_HOME（宿主约定）回退 ~/.dsh。 */
export function defaultStateDir() {
  const home = process.env.DSH_HOME
    ?? (process.env.HOME || process.env.USERPROFILE ? `${process.env.HOME || process.env.USERPROFILE}/.dsh` : null)
  return home !== null ? `${home}/dsh-notifier` : '.dsh-notifier'
}

/**
 * 创建键值 store。
 * @param {string} filePath - JSON 文件路径（目录自动创建）
 */
export function createStore(filePath) {
  const load = () => {
    try {
      if (!existsSync(filePath)) return {}
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      return (parsed !== null && typeof parsed === 'object') ? parsed : {}
    } catch {
      return {} // 损坏文件：回退空状态，绝不弄崩启动
    }
  }

  let state = load()

  const save = () => {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      try { chmodSync(tmp, 0o600) } catch { /* Windows/受限环境无 chmod：尽力而为 */ }
      renameSync(tmp, filePath)
    } catch {
      // 磁盘失败不致命：内存态继续工作（重启后丢失）
    }
  }

  return {
    get(key, fallback = undefined) {
      const value = state[key]
      return value === undefined ? fallback : value
    },
    set(key, value) {
      state[key] = value
      save()
    },
    delete(key) {
      const existed = key in state
      delete state[key]
      if (existed) save()
      return existed
    },
    keys(prefix = '') {
      return Object.keys(state).filter((key) => key.startsWith(prefix))
    },
    size() {
      return Object.keys(state).length
    },
    /** 清理超期的键（如去重窗口），返回清理数量。 */
    sweepPrefix(prefix, isExpired) {
      let removed = 0
      for (const key of Object.keys(state)) {
        if (!key.startsWith(prefix)) continue
        if (isExpired(key, state[key])) {
          delete state[key]
          removed += 1
        }
      }
      if (removed > 0) save()
      return removed
    },
  }
}
