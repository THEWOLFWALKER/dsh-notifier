// dsh-notifier inbound/telegram-bot.mjs
// Telegram 入站：getUpdates 长轮询（无公网要求，首选回传通道）。
//  - callback_query 按钮：callback_data 携带一次性 token，点击即裁决（首达采纳）
//  - message 文本：走 bus 白名单 + 去重后交给 conversation router
//  - offset cursor 持久化（store），重启不重复消费
// 军规：轮询循环里的任何异常只退避重试，绝不弄崩宿主；stop() 干净退出。

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
 * @param {typeof fetch} [options.fetchImpl] - 测试注入
 * @param {number} [options.errorBackoffMs=5000] - 轮询异常退避（测试可缩短）
 */
export function createTelegramInbound({ config, bus, vault, store = null, logger = null, fetchImpl, errorBackoffMs } = {}) {
  const apiBase = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const botToken = String(config.botToken ?? '')
  const backoffMs = Math.max(0, Number(errorBackoffMs) || DEFAULT_ERROR_BACKOFF_MS)
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:telegram]', message) } catch { /* 日志失败绝不致命 */ }
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

  async function handleUpdate(update) {
    if (update.callback_query !== undefined) {
      const query = update.callback_query
      const data = String(query.data ?? '')
      // callback_data 格式：ap:<decision>:<approvalKey>:<token>
      // 注意 approvalKey 自身含冒号（ap:<callId>:<n>），decision 取第二段、token 取末段、
      // 中间全部归 key（slice+join 重组），不能按固定长度切。
      const parts = data.split(':')
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
    const message = update.message
    if (message?.text !== undefined) {
      bus.accept({
        channel: 'telegram',
        userId: String(message.from?.id ?? ''),
        chatId: String(message.chat?.id ?? ''),
        messageId: `msg:${message.message_id}:${message.chat?.id ?? ''}`,
        text: String(message.text),
      })
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
        const result = await api('sendMessage', {
          chat_id: chatId,
          text: `🔐 ${title}\n\n${content}\n\n_decision: ${approvalKey}_`,
          parse_mode: 'markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 批准（本次）', callback_data: `ap:allowed-once:${approvalKey}:${token}` },
              { text: '❌ 拒绝', callback_data: `ap:rejected:${approvalKey}:${token}` },
            ]],
          },
        })
        return { messageId: result?.message_id }
      } catch (error) {
        warn(`审批卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
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

    /** 目标 chat 列表（配置 notifyChatIds）。 */
    notifyChatIds() {
      return Array.isArray(config.notifyChatIds) ? config.notifyChatIds.map(String) : []
    },
  }
}
