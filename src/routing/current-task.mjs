// dsh-notifier routing/current-task.mjs
// v0.15 Stage 2（Stage 1 review R1）：当前任务选择 authority。
//
// 「私聊控制投到哪个任务」是**用户显式选择**的事实，本模块是它唯一的写入者。硬规则：
//   - 绝不从 recent / first / latest active / array[0] 推导默认；
//   - 没有显式选择 = 未选择（UI 显示「尚未选择任务」，绝不自动绑定）；
//   - 旧绑定无法无歧义确定时，要求用户重新选择（由上层比对活跃任务集后标记）。
//
// 持久键与 conversation 的会话绑定同域：`bind:<channel>:<userId>`（G-49 单一键构造点
// identity.bindingKey）。两者描述的是同一个事实——「这条私聊消息投给哪个任务」——所以共用
// 同一写者；conversation 的 /bind、/use、/agent use 与本 authority 的 select 都只是「用户
// 显式选择」的入口，落盘一律经此模块，不再各自 setDurable。
//
// 军规：store 故障全防御（读按未选择、写返回 storage-failed，绝不抛）。

import { bindingKey } from '../inbound/identity.mjs'
import { deleteDurable, setDurable } from '../inbound/store.mjs'

/**
 * 当前任务键（唯一构造点）：`bind:<channel>:<userId>`，分量经 identity.bindingKey 归一。
 * @param {string} channel
 * @param {string} userId
 * @returns {string|null} 分量缺失返回 null（非法主体）
 */
export function currentTaskKey(channel, userId) {
  const normalizedChannel = String(channel ?? '').trim().toLowerCase()
  const normalizedUserId = String(userId ?? '').trim()
  if (normalizedChannel === '' || normalizedUserId === '') return null
  return `bind:${bindingKey(normalizedChannel, normalizedUserId)}`
}

/**
 * 创建当前任务选择 authority。
 * @param {object} [options]
 * @param {object} [options.store] - 键值存储（src/inbound/store.mjs 形态）
 * @param {{ warn?: (message: string) => void }} [options.logger]
 */
export function createCurrentTaskAuthority({ store = null, logger = null } = {}) {
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/current-task]', message) } catch { /* 日志失败不致命 */ }
  }
  const safeGet = (key) => {
    try { return store?.get?.(key) } catch { return undefined }
  }
  const safeSet = (key, value) => {
    try { return setDurable(store, key, value) === true } catch { return false }
  }
  const safeDelete = (key) => {
    try { return deleteDurable(store, key) } catch { return { existed: false, durable: false } }
  }

  return {
    /**
     * 读显式选择。无选择 / 主体非法返回 null——**绝不**推导任何默认。
     * @param {{ channel?: string, userId?: string }} principal
     * @returns {string|null} 显式选择的 taskRef
     */
    get({ channel, userId } = {}) {
      const key = currentTaskKey(channel, userId)
      if (key === null) return null
      const value = safeGet(key)
      return typeof value === 'string' && value.trim() !== '' ? value : null
    },

    /**
     * 显式选择任务（用户动作）。空 taskRef = 拒绝（想清空请 clear，空串不是选择）。
     * @param {{ channel?: string, userId?: string }} principal
     * @param {string} taskRef
     * @returns {{ ok: true, taskRef: string } | { ok: false, reason: 'invalid'|'storage-failed' }}
     */
    select({ channel, userId } = {}, taskRef) {
      const key = currentTaskKey(channel, userId)
      const ref = String(taskRef ?? '').trim()
      if (key === null || ref === '') return { ok: false, reason: 'invalid' }
      if (safeSet(key, ref) !== true) {
        warn('当前任务写入失败')
        return { ok: false, reason: 'storage-failed' }
      }
      return { ok: true, taskRef: ref }
    },

    /**
     * 清除显式选择（回到未选择）。
     * @param {{ channel?: string, userId?: string }} principal
     * @returns {{ ok: boolean, existed: boolean }}
     */
    clear({ channel, userId } = {}) {
      const key = currentTaskKey(channel, userId)
      if (key === null) return { ok: false, existed: false }
      const removed = safeDelete(key)
      if (removed.durable !== true) return { ok: false, existed: false }
      return { ok: true, existed: removed.existed === true }
    },
  }
}