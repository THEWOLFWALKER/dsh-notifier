// dsh-notifier inbound/telegram-bot.mjs
// Telegram 入站：getUpdates 长轮询（无公网要求，首选回传通道）。
//  - callback_query 按钮：callback_data 携带一次性 token，点击即裁决（首达采纳）
//    · ap:<decision>:<approvalKey>:<token> —— 审批按钮（bus.decide）
//    · ac:<actionKey>:<token> —— v0.5 动作按钮（actions.dispatch，如「停止任务」）
//  - message 文本：走 bus 白名单 + 去重后交给 conversation router
//  - offset cursor 持久化（store），重启不重复消费
// 军规：轮询循环里的任何异常只退避重试，绝不弄崩宿主；stop() 干净退出。

import { createCallbackRefs } from './callback-refs.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const DEFAULT_API_BASE = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 25
const POLL_ABORT_MS = (POLL_TIMEOUT_S + 10) * 1000
const DEFAULT_ERROR_BACKOFF_MS = 5000

/**
 * 创建 Telegram 入站通道。
 * @param {object} options
 * @param {{ botToken: string, apiBase?: string, notifyChatIds?: (string|number)[] }} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {ReturnType<typeof import('./tokens.mjs').createTokenVault>} options.vault
 * @param {import('./store.mjs').store} [options.store] - offset cursor 持久化
 * @param {object} [options.logger]
 * @param {ReturnType<typeof import('../actions.mjs').createActionDispatcher>} [options.actions]
 *   - v0.5 动作分发器（可空：缺省时 ac: 回调分支不存在，行为与 v0.4.0 一致）
 * @param {typeof fetch} [options.fetchImpl] - 测试注入
 * @param {number} [options.errorBackoffMs=5000] - 轮询异常退避（测试可缩短）
 * @param {number} [options.callbackTtlMs] - 按钮短引用有效期（缺省 15min，略长于 token TTL）
 */
export function createTelegramInbound({ config, bus, vault, store = null, logger = null, fetchImpl, errorBackoffMs, actions = null, callbackTtlMs, identity = null } = {}) {
  const apiBase = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const botToken = String(config.botToken ?? '')
  const backoffMs = Math.max(0, Number(errorBackoffMs) || DEFAULT_ERROR_BACKOFF_MS)
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  // v0.6.2 按钮短引用注册表：callback_data 64 字节硬限的修复载体（见 callback-refs.mjs 头注）
  const refs = createCallbackRefs({ ttlMs: callbackTtlMs })
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:telegram]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:telegram]', message) } catch { /* 控制台不可用不致命 */ }
  }

  const api = async (method, body = {}) => {
    const controller = new AbortController()
    const long = method === 'getUpdates'
    const timer = setTimeout(() => controller.abort(), long ? POLL_ABORT_MS : 15000)
    try {
      const response = await doFetch(`${apiBase}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      if (payload?.ok !== true) {
        throw new Error(`telegram ${method} 失败: HTTP ${response.status} ${payload?.description ?? ''}`.trim())
      }
      return payload.result
    } finally {
      clearTimeout(timer)
    }
  }

  let running = false
  let loopPromise = null

  /**
   * callback_query 分发：v0.6.2 先展开短引用（r:<ref>，take 单次核销）再走既有
   * ap:/ac: 解析；旧格式完整 data（升级前在途卡片）不经注册表直落解析，双轨兼容。
   */
  async function handleCallbackData(query, rawData) {
    const data = String(rawData ?? '')
    const parts = data.split(':')
    if (parts[0] === 'r' && parts.length === 2) {
      const expanded = refs.take(parts[1])
      if (expanded === null) {
        await api('answerCallbackQuery', { callback_query_id: query.id, text: '该操作已处理或已过期（按钮单次有效）' }).catch(() => {})
        return
      }
      await handleCallbackData(query, expanded)
      return
    }
      // v0.5 动作按钮：ac:<actionKey>:<token>（actions 注入时才存在此分支）
      if (parts[0] === 'ac' && actions !== null && parts.length >= 3) {
        const actionKey = parts.slice(1, -1).join(':')
        const token = parts[parts.length - 1]
        const result = actions.dispatch({ actionKey, token, via: 'telegram:action', userId: query.from?.id })
        const actionText = result?.ok === true
          ? result.message
          : (result?.message ?? '该操作已处理或已过期')
        await api('answerCallbackQuery', { callback_query_id: query.id, text: actionText }).catch(() => {})
        if (query.message?.chat?.id !== undefined) {
          await api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `${actionText}\n（来源：telegram user ${query.from?.id ?? '?'}）`,
          }).catch(() => {})
        }
        return
      }
      // 审批按钮：ap:<decision>:<approvalKey>:<token>
      // 注意 approvalKey 自身含冒号（ap:<callId>:<n>），decision 取第二段、token 取末段、
      // 中间全部归 key（slice+join 重组），不能按固定长度切。
      if (parts[0] === 'ap' && parts.length >= 4) {
        const decision = parts[1]
        const approvalKey = parts.slice(2, -1).join(':')
        const token = parts[parts.length - 1]
        const verdict = bus.decide({
          approvalKey,
          decision,
          token,
          via: 'telegram',
          userId: query.from?.id,
        })
        const text = verdict.ok
          ? (decision === 'allowed-once' ? '✅ 已批准（单次有效）' : '❌ 已拒绝')
          : '该审批已处理或已过期（token 单次核销）'
        await api('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => {})
        if (query.message?.chat?.id !== undefined) {
          await api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `${text}\n（来源：telegram user ${query.from?.id ?? '?'}）`,
          }).catch(() => {})
        }
      }
      return
  }

  async function handleUpdate(update) {
    if (update.callback_query !== undefined) {
      await handleCallbackData(update.callback_query, String(update.callback_query.data ?? ''))
      return
    }
    const message = update.message
    if (message?.text !== undefined) {
      // v0.7：chatType 透传（/pair 私聊判定）；accept 返回值消费——拒绝/命令回执不再已读不回
      const envelope = {
        channel: 'telegram',
        userId: String(message.from?.id ?? ''),
        chatId: String(message.chat?.id ?? ''),
        chatType: String(message.chat?.type ?? ''),
        messageId: `msg:${message.message_id}:${message.chat?.id ?? ''}`,
        text: String(message.text),
      }
      const result = bus.accept(envelope)
      if (result?.reply !== undefined) {
        try {
          await api('sendMessage', { chat_id: envelope.chatId, text: String(result.reply).slice(0, 4000) })
        } catch (error) {
          warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`) // 回执失败不致命
        }
      }
    }
  }

  async function loop() {
    let offset = Number(store?.get('tg:offset', 0)) || 0
    while (running) {
      try {
        const updates = await api('getUpdates', {
          offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query'],
        })
        for (const update of updates ?? []) {
          offset = Math.max(offset, (update.update_id ?? 0) + 1)
          store?.set('tg:offset', offset)
          await handleUpdate(update)
        }
      } catch (error) {
        if (!running) break
        const reason = error instanceof Error ? error.message : String(error)
        warn(`轮询异常，${backoffMs / 1000}s 后重试: ${reason}`)
        if (/409/.test(reason)) {
          warn('409 冲突：该 bot 可能设置了 webhook。请到 @BotFather 删除 webhook（Delete Webhook）后使用长轮询')
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }

  return {
    /** 启动长轮询（幂等）。 */
    start() {
      if (running) return
      running = true
      loopPromise = loop()
    },

    /** 停止轮询并等待循环退出。 */
    async stop() {
      running = false
      // 不 abort 在途 fetch：等它自然结束（≤35s）；下次循环判断 running 退出
      if (loopPromise !== null) await loopPromise.catch(() => {})
      loopPromise = null
    },

    /**
     * 推送带审批按钮的卡片到指定 chat（approval router 调用）。
     * @returns {Promise<{ messageId: number } | null>} 失败返回 null（caller 降级）
     */
    async sendApprovalCard({ chatId, title, content, approvalKey, token }) {
      try {
        // v0.6.2：callback_data 只放短引用 r:<ref>（恒定 10 字节）——完整
        // ap:<decision>:<key>:<token> ≈ 131~165 字节，超 TG 64 字节硬限（真机 400
        // BUTTON_DATA_INVALID；mock fetch 不校验长度，单测测不出）。完整 data 存
        // 进程内注册表，点击时单次核销展开走既有解析，token 密码学与账本零改动。
        const result = await api('sendMessage', {
          chat_id: chatId,
          // v0.6.3：去掉 parse_mode markdown——approvalKey（ap:<callId>:<n>，callId 常含 _）
          // 与 reason（路径/反引号）未转义，legacy markdown 未配对 _/* 必 400 "can't parse
          // entities"，卡片静默降级纯文本（审查 R2 P1-2，与 v0.6.2 BUTTON_DATA_INVALID
          // 同类 mock 盲区：mock fetch 不解析 markdown，单测测不出）。纯文本无此面。
          text: `🔐 ${title}\n\n${content}\n\n_decision: ${approvalKey}_`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 批准（本次）', callback_data: `r:${refs.mint(`ap:allowed-once:${approvalKey}:${token}`)}` },
              { text: '❌ 拒绝', callback_data: `r:${refs.mint(`ap:rejected:${approvalKey}:${token}`)}` },
            ]],
          },
        })
        return { messageId: result?.message_id }
      } catch (error) {
        warn(`审批卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /**
     * v0.5 推送动作卡片（通知文本 + 自定义按钮行；event-listener 的 stall/心跳通知调用）。
     * @param {{ chatId: string, title: string, content: string, actions: { label: string, data: string }[] }} payload
     * @returns {Promise<{ messageId: number } | null>} 无有效按钮/失败返回 null（caller 降级）
     */
    async sendActionCard({ chatId, title, content, actions: buttons = [] }) {
      try {
        const rows = (Array.isArray(buttons) ? buttons : [])
          .filter((button) => button !== null && typeof button === 'object'
            && typeof button.label === 'string' && button.label.trim() !== ''
            && typeof button.data === 'string' && button.data !== '')
          // v0.6.2：同审批卡——ac:<key>:<token> 同样超限，一律经短引用压缩
          .map((button) => ({ text: button.label, callback_data: `r:${refs.mint(button.data)}` }))
        if (rows.length === 0) return null
        const result = await api('sendMessage', {
          chat_id: chatId,
          text: `${title}\n\n${content}`,
          reply_markup: { inline_keyboard: [rows] },
        })
        return { messageId: result?.message_id }
      } catch (error) {
        warn(`动作卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 把远端消息编辑为最终状态（桌面先处理时防止过期按钮二次审批）。 */
    async editResolved(chatId, messageId, text) {
      await api('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => {})
    },

    /**
     * 发一条普通文本到指定 chat（会话路由的命令回执用；失败静默——回执尽力而为）。
     * @returns {Promise<boolean>} 是否成功
     */
    async sendText(chatId, text) {
      try {
        await api('sendMessage', { chat_id: chatId, text: String(text ?? '').slice(0, 4000) })
        return true
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },

    /** v0.7 三级解析：绑定成员 → 配置 notifyChatIds（正数=用户）→（无全局回落，
     *  telegram 的 v0.6 契约本就没有 allowUsers 兜底，行为不变）。
     *  负数 id（-100…）是群/超级群/频道——渠道属性不是身份属性，走 extras 无条件保留
     *  （与 qq notifyGroups 同语义；R5 审查：首版全塞 configTargets，绑定接管用户目标
     *  后群目标被整体替换消失——群通知双杀 P1）。 */
    notifyTargets() {
      const chats = (Array.isArray(config.notifyChatIds) ? config.notifyChatIds : []).map(String)
      return resolveNotifyTargets({
        identity,
        channel: 'telegram',
        configTargets: chats.filter((id) => !id.startsWith('-')),
        extraTargets: chats.filter((id) => id.startsWith('-')),
        fallbackTargets: [],
      })
    },

    /** 目标 chat 列表（配置 notifyChatIds；legacy 契约保留——identity 未注入时二者等价）。 */
    notifyChatIds() {
      return Array.isArray(config.notifyChatIds) ? config.notifyChatIds.map(String) : []
    },
  }
}
