// dsh-notifier actions.mjs
// v0.5 动作闭环核心：通知按钮 → 内置处置动作（白名单，永无任意代码执行）。
// 信任链与审批（approval/router.mjs + inbound/tokens.mjs）完全同构：
//   ① 按钮真实性靠通道回调本身（bot 私聊 / 卡片操作者）——审批按钮已验证此链；
//   ② HMAC 一次性 token + TTL（默认 10min）——过期卡片点击得「已过期」终态文案；
//   ③ 账本单次核销——首达采纳，二次点击得「已处理」。
// 军规：dispatch 全 catch 绝不外抛（listener never throws）；账本/铸造失败只导致
// 「不发出卡片」，绝不影响通知文本主链路（文本 hint「回复 /stop 取消」全通道兜底）。

import { randomBytes } from 'node:crypto'

/**
 * 创建动作分发器。
 * @param {object} options
 * @param {ReturnType<typeof import('./inbound/tokens.mjs').createTokenVault>} [options.vault]
 *   一次性 token 铸造/核销（与审批共用同一 vault，key 命名空间 act: 隔离）。
 * @param {import('./inbound/store.mjs').store} [options.store] 动作账本（持久化跨重启）。
 * @param {object} [options.logger]
 */
export function createActionDispatcher({ vault = null, store = null, logger = null } = {}) {
  const handlers = new Map() // kind -> handler({ actionKey, payload, via, userId }) -> { ok?, message? }
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/actions]', message) } catch { /* 日志失败绝不致命 */ }
  }

  return {
    /** 注册动作 handler（内置白名单由装配层注册；重复注册后到者赢）。 */
    register(kind, handler) {
      if (typeof kind !== 'string' || kind.trim() === '' || typeof handler !== 'function') return false
      handlers.set(kind.trim(), handler)
      return true
    },

    /**
     * 铸造动作凭证：key = act:<kind>:<rand>（随机段跨重启唯一，counter 重置不碰撞）。
     * 未注册的 kind / vault 缺失 / 账本写入失败 → null（调用方降级为纯文本通知）。
     * @param {object} [meta] - v0.8.4 F-08 来源会话元数据 { channel, chatId }（可选）。
     *   单目标铸造时记录来源会话供 dispatch 校验；多目标广播由调用方随后 markSource 补记。
     * @returns {{ key: string, token: string } | null}
     */
    mintAction(kind, payload = {}, meta = {}) {
      try {
        const normalizedKind = typeof kind === 'string' ? kind.trim() : ''
        if (normalizedKind === '' || !handlers.has(normalizedKind)) return null
        if (vault === null || typeof vault.mint !== 'function') return null
        const key = `act:${normalizedKind}:${randomBytes(4).toString('hex')}`
        let token = null
        try {
          token = vault.mint(key)
        } catch (error) {
          warn(`token 铸造失败: ${error instanceof Error ? error.message : String(error)}`)
          return null
        }
        const srcChats = (meta !== null && typeof meta === 'object'
          && typeof meta.channel === 'string' && meta.channel !== ''
          && typeof meta.chatId === 'string' && meta.chatId !== '')
          ? { [meta.channel]: [meta.chatId] }
          : null
        try {
          const row = { kind: normalizedKind, payload, status: 'pending', createdAt: Date.now() }
          if (srcChats !== null) row.srcChats = srcChats
          store?.set(key, row)
        } catch (error) {
          // 账本失败 = 无法核销 = 绝不能发出卡片（发出即无首达保障）
          warn(`动作账本写入失败，降级不发卡片: ${error instanceof Error ? error.message : String(error)}`)
          return null
        }
        return { key, token }
      } catch {
        return null
      }
    },

    /**
     * v0.8.4 F-08：登记某动作已送达的 (channel, chatId)，供 dispatch 校验点击来源。
     * 多目标广播（同一动作卡发往多个通道/会话）由调用方在发送前登记、失败后撤销。
     */
    markSource(actionKey, channel, chatId) {
      try {
        if (typeof actionKey !== 'string' || actionKey === ''
          || typeof channel !== 'string' || channel === ''
          || typeof chatId !== 'string' || chatId === '') return
        const row = store?.get(actionKey)
        if (row === undefined || row.status !== 'pending') return
        const srcChats = (row.srcChats !== null && typeof row.srcChats === 'object' && !Array.isArray(row.srcChats))
          ? row.srcChats
          : {}
        const list = Array.isArray(srcChats[channel]) ? [...srcChats[channel]] : []
        if (!list.includes(chatId)) list.push(chatId)
        try { store.set(actionKey, { ...row, srcChats: { ...srcChats, [channel]: list } }) } catch { /* 落账失败不致命 */ }
      } catch {
        /* 来源登记失败不致命 */
      }
    },

    /**
     * v0.8.4 F-08：撤销某动作的 (channel, chatId) 来源登记（发送失败/降级时回滚）。
     */
    unmarkSource(actionKey, channel, chatId) {
      try {
        if (typeof actionKey !== 'string' || actionKey === ''
          || typeof channel !== 'string' || channel === ''
          || typeof chatId !== 'string' || chatId === '') return
        const row = store?.get(actionKey)
        if (row === undefined || row.status !== 'pending') return
        const srcChats = (row.srcChats !== null && typeof row.srcChats === 'object' && !Array.isArray(row.srcChats))
          ? row.srcChats
          : null
        if (srcChats === null) return
        const list = Array.isArray(srcChats[channel]) ? srcChats[channel].filter((item) => item !== chatId) : []
        const next = { ...srcChats }
        if (list.length === 0) delete next[channel]
        else next[channel] = list
        const nextRow = { ...row }
        if (Object.keys(next).length > 0) nextRow.srcChats = next
        else delete nextRow.srcChats
        try { store.set(actionKey, nextRow) } catch { /* 落账失败不致命 */ }
      } catch {
        /* 来源撤销失败不致命 */
      }
    },

    /**
     * 核销并执行动作（通道回调入口）。
     * @param {object} [opts.chatId] - v0.8.4 F-08 点击所在的会话（通道回调透传）。
     *   账本已记录来源会话（srcChats）时：点击会话必须在该通道允许集合内，否则拒绝
     *   （source-chat-mismatch）；缺点击会话（新卡必须带）→ 拒绝。无来源元数据的
     *   历史卡 → 显式 warn + 兼容放行（不打旧卡，绝不静默放行转发）。
     * @returns {{ ok: boolean, reason?: string, message: string }}
     *   ok = 本次点击是否生效（核销成功且 handler 已调用）；message 为给操作者的反馈文案。
     *   任何失败路径返回中文文案，绝不 throw。
     */
    dispatch({ actionKey, token, via = 'unknown', userId = '(unknown)', chatId = undefined } = {}) {
      try {
        if (typeof actionKey !== 'string' || actionKey === '') {
          return { ok: false, reason: 'malformed', message: '无效操作' }
        }
        if (vault === null || typeof vault.verify !== 'function') {
          return { ok: false, reason: 'no-vault', message: '该操作已失效' }
        }
        let verdict = null
        try {
          verdict = vault.verify(token)
        } catch (error) {
          warn(`token 核验异常: ${error instanceof Error ? error.message : String(error)}`)
          return { ok: false, reason: 'verify-error', message: '该操作已失效' }
        }
        if (verdict?.ok !== true) {
          const reason = String(verdict?.reason ?? 'bad-signature')
          return { ok: false, reason, message: '该操作已处理或已过期（token 单次核销）' }
        }
        if (verdict.key !== actionKey) {
          return { ok: false, reason: 'key-mismatch', message: '该操作已处理或已过期（token 单次核销）' }
        }
        const row = store?.get(actionKey)
        if (row === undefined) {
          // 账本行缺失（重启清账 / 极旧卡片）：按过期处理，绝不执行
          return { ok: false, reason: 'unknown-action', message: '该操作已过期' }
        }
        if (row.status !== 'pending') {
          return { ok: false, reason: 'already-resolved', message: '该操作已处理' }
        }
        // v0.8.4 F-08：来源会话校验（对齐 SEC-1 / questions.decide 的 chatId 比对）。
        // 账本无来源元数据 → 显式 warn + 兼容放行（升级前在途卡片不打历史，但也绝不
        // 静默——每次都告警，转发点击不会安静漏过）。新卡（有 srcChats）必须校验。
        const srcChats = (row.srcChats !== null && typeof row.srcChats === 'object' && !Array.isArray(row.srcChats))
          ? row.srcChats
          : null
        if (srcChats !== null) {
          const clickVia = String(via ?? '').split(':')[0]
          const allowed = Array.isArray(srcChats[clickVia]) ? srcChats[clickVia] : []
          if (chatId === undefined || chatId === null || String(chatId) === '') {
            // 新卡必须携带点击会话；缺失时无法确证来源，从严拒绝（含跨通道转发）。
            return { ok: false, reason: 'source-chat-required', message: '请到原会话操作' }
          }
          if (!allowed.includes(String(chatId))) {
            warn(`动作 ${actionKey} 点击会话拒绝（via ${clickVia}，chatId ${String(chatId)} 不在来源集合）`)
            return { ok: false, reason: 'source-chat-mismatch', message: '请到原会话操作' }
          }
        } else if (row.srcChats === undefined) {
          warn(`动作 ${actionKey} 账本缺来源会话元数据（srcChats），按历史卡兼容放行（转发风险请核对卡片来源）`)
        }
        const handler = handlers.get(row.kind)
        if (handler === undefined) {
          // 先落终态再反馈：防未知 kind 的重试风暴
          try { store.set(actionKey, { ...row, status: 'resolved', outcome: 'unknown-kind', via, resolvedAt: Date.now() }) } catch { /* 账本失败不致命 */ }
          return { ok: false, reason: 'unknown-kind', message: '未知操作类型' }
        }
        // 首达采纳：先落 resolved 再执行（并发双击只执行一次）
        try { store.set(actionKey, { ...row, status: 'resolved', outcome: 'executing', via, resolvedAt: Date.now() }) } catch { /* 账本失败不致命 */ }
        try {
          const result = handler({ actionKey, payload: row.payload, via, userId }) ?? {}
          const ok = result.ok !== false
          const message = typeof result.message === 'string' && result.message !== ''
            ? result.message
            : (ok ? '✅ 已执行' : '操作未生效')
          try { store.set(actionKey, { ...row, status: 'resolved', outcome: ok ? 'done' : 'handler-declined', via, resolvedAt: Date.now() }) } catch { /* 账本失败不致命 */ }
          warn(`动作 ${actionKey} 裁决 via ${via}（user ${userId}）: ${ok ? 'done' : 'handler-declined'}`)
          return { ok: true, message }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          try { store.set(actionKey, { ...row, status: 'resolved', outcome: 'handler-error', via, resolvedAt: Date.now() }) } catch { /* 账本失败不致命 */ }
          warn(`动作 handler 异常（已核销）: ${reason}`)
          return { ok: true, message: '动作已核销，但执行异常（任务状态请以 /agent 为准）' }
        }
      } catch (error) {
        warn(`dispatch 异常: ${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, reason: 'error', message: '处理异常，请重试' }
      }
    },

    /** 注销全部 handler（装配 teardown；核销链随 vault/store 生命周期）。 */
    dispose() {
      handlers.clear()
    },
  }
}
