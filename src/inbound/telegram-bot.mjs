// dsh-notifier inbound/telegram-bot.mjs
// Telegram 入站：getUpdates 长轮询（无公网要求，首选回传通道）。
//  - callback_query 按钮：callback_data 携带一次性 token，点击即裁决（首达采纳）
//    · ap:<decision>:<approvalKey>:<token> —— 审批按钮（bus.decide）
//    · ac:<actionKey>:<token> —— v0.5 动作按钮（actions.dispatch，如「停止任务」）
//    · aq:<qKey>:<idx>:<token> —— v0.8 提问作答按钮（questions.decide）
//  - message 文本：走 bus 白名单 + 去重后交给 conversation router
//  - offset cursor 持久化（store），重启不重复消费
// 军规：轮询循环里的任何异常只退避重试，绝不弄崩宿主；stop() 干净退出。

import { createCallbackRefs } from './callback-refs.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'
import { buildQuestionAction } from './_contract.mjs'

const DEFAULT_API_BASE = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 25
const POLL_ABORT_MS = (POLL_TIMEOUT_S + 10) * 1000
const DEFAULT_ERROR_BACKOFF_MS = 5000
const TERMINAL_FALLBACK_SUFFIX = '（按钮失效）'

// P1-1 协议盲区护栏（2026-08-20，Trae1）：TG sendMessage 的 text 硬限 4096 字符，
// 超限必 400 "message is too long"。审批 reason / 提问 context 上游无长度上限
// （public 层各 20000 码点），长文案会让按钮卡在所有会话全军覆没——卡片 catch 后
// warn + 返回 null，静默退化为纯编号回复（mock fetch 不校验长度，单测测不出；
// 与 v0.6.2 BUTTON_DATA_INVALID、v0.6.3 legacy markdown 同类协议盲区）。
// 计数按 UTF-16 码元（对抗性 review 修正：TG 底层 UTF-16 存储，astral 字符 1 码点
// = 2 码元——只按码点数截到 4096 的全 emoji 文本实际 8192 码元，真机仍 400）；
// 切口回退到码点边界，绝不劈开 surrogate pair。
const TG_TEXT_LIMIT = 4096
const TG_TEXT_TRUNCATE_MARK = '…（内容过长，已截断）'

/** 卡片文本护栏：按 UTF-16 码元把 text 钳到 TG 4096 硬限内；超限截断并追加可见标记。 */
function clampTelegramText(text) {
  const s = String(text ?? '')
  if (s.length <= TG_TEXT_LIMIT) return s
  const markUnits = TG_TEXT_TRUNCATE_MARK.length
  let cut = TG_TEXT_LIMIT - markUnits
  // 切口若落在代理对中间（前一码元是高代理且后一码元是低代理），回退一位保码点完整
  if (cut > 0
    && s.charCodeAt(cut - 1) >= 0xD800 && s.charCodeAt(cut - 1) <= 0xDBFF
    && s.charCodeAt(cut) >= 0xDC00 && s.charCodeAt(cut) <= 0xDFFF) {
    cut -= 1
  }
  return `${s.slice(0, Math.max(0, cut))}${TG_TEXT_TRUNCATE_MARK}`
}

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
 * @param {object} [options.questions]
 *   - v0.8 提问桥裁决入口（可空：缺省时 aq: 回调分支不存在，行为与 v0.7 一致）
 * @param {typeof fetch} [options.fetchImpl] - 测试注入
 * @param {number} [options.errorBackoffMs=5000] - 轮询异常退避（测试可缩短）
 * @param {number} [options.callbackTtlMs] - 按钮短引用有效期（缺省 15min，略长于 token TTL）
 */
export function createTelegramInbound({ config, bus, vault, store = null, logger = null, fetchImpl, errorBackoffMs, actions = null, callbackTtlMs, identity = null, questions = null, control = null, accountId = null } = {}) {
  const apiBase = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  const botToken = String(config.botToken ?? '')
  const backoffMs = Math.max(0, Number(errorBackoffMs) || DEFAULT_ERROR_BACKOFF_MS)
  // Stable per-provider account id, injected into every normalized envelope so shared
  // Control Core source binding accepts valid callbacks and rejects a different account.
  // NEVER derived from botToken — account ids may appear in audit receipts and pushing a
  // secret there would leak it. Explicit config.accountId wins; otherwise a literal stable
  // default. The facade owns this decision and passes it down as a top-level option.
  const resolvedAccountId = String(accountId ?? config.accountId ?? '').trim() || 'default'
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  // v0.6.2 按钮短引用注册表：callback_data 64 字节硬限的修复载体（见 callback-refs.mjs 头注）
  const refs = createCallbackRefs({ ttlMs: callbackTtlMs })
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:telegram]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:telegram]', message) } catch { /* 控制台不可用不致命 */ }
  }

  const makeTerminalFallbackText = (text) => {
    const base = String(text ?? '')
    return base === '' ? TERMINAL_FALLBACK_SUFFIX : `${base}\n${TERMINAL_FALLBACK_SUFFIX}`
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
   * v0.8.3 SEC-1：短引用提升为「先 peek 元数据比对来源会话 → 一致才取核销展开」，
   * 转发点击收到「请到原会话操作」且不消费引用（原卡仍可正常点击）。
   */
  async function handleCallbackData(query, rawData) {
    const data = String(rawData ?? '')
    const parts = data.split(':')
    if (parts[0] === 'r' && parts.length === 2) {
      const peeked = refs.peek(parts[1])
      if (peeked === null) {
        await api('answerCallbackQuery', { callback_query_id: query.id, text: '该操作已处理或已过期（按钮单次有效）' }).catch(() => {})
        return
      }
      // SEC-1：卡片铸 ref 时记录了发送目标 chatId；点击所在 chat 不一致 → 直接拒绝，
      // 不消费引用、不进入既有裁决分支。
      // C1（P1-4，v0.8.7）：旧判据是三项合取，`clickedChat === undefined`（消息被删、
      // 事件形状异常、非 message 承载的回调）会把整式短路成 false → 放行，等于「缺点击
      // 会话即绕过来源校验」。现在拆成三级 fail-closed（宪法 #7「fail-open 要有度」）：
      //  · origin.chatId 缺失（升级前在途卡片，本仓库所有 mint 点都带 chatId）→ warn 后
      //    兼容放行，窗口由 ref TTL 15min 天然封顶（callback-refs.mjs DEFAULT_TTL_MS）
      //  · origin 在场但点击会话读不到 → 拒绝（不 take()，原卡在 TTL 内仍可正常点）
      //  · 两者都在场且不相等 → 拒绝（旧实现此路静默，现补 warn，宪法 #3）
      // 判据用显式 undefined/null 比较而非真值：chatId === 0 是合法会话，`!clickedChat`
      // 会把它误判成缺数据而拒掉真实点击。
      const clickedChat = query.message?.chat?.id
      const originChat = peeked.origin?.chatId
      if (originChat === null || originChat === undefined) {
        warn('按钮短引用缺少来源会话元数据（origin.chatId），跳过来源校验（升级前在途卡片兼容，ref TTL 内有效）')
      } else if (clickedChat === null || clickedChat === undefined) {
        warn(`按钮回调缺少点击会话（message.chat.id），来源校验拒绝（origin=${originChat}；不消费引用，原会话仍可点击）`)
        await api('answerCallbackQuery', { callback_query_id: query.id, text: '请到原会话操作' }).catch(() => {})
        return
      } else if (String(clickedChat) !== String(originChat)) {
        warn(`按钮点击会话与原会话不一致（clicked=${clickedChat} origin=${originChat}），来源校验拒绝（不消费引用）`)
        await api('answerCallbackQuery', { callback_query_id: query.id, text: '请到原会话操作' }).catch(() => {})
        return
      }
      const expanded = refs.take(parts[1])
      if (expanded === null) {
        await api('answerCallbackQuery', { callback_query_id: query.id, text: '该操作已处理或已过期（按钮单次有效）' }).catch(() => {})
        return
      }
      await handleCallbackData(query, expanded)
      return
    }
      // v0.5 动作按钮：ac:<actionKey>:<token>（actions 注入时才存在此分支）
      // v0.8.4 F-08：透传点击会话 chatId 供 actions.dispatch 做来源校验（转发拒绝）。
      if (parts[0] === 'ac' && actions !== null && parts.length >= 3) {
        const actionKey = parts.slice(1, -1).join(':')
        const token = parts[parts.length - 1]
        const result = actions.dispatch({ actionKey, token, via: 'telegram:action', userId: query.from?.id, accountId: resolvedAccountId, chatId: query.message?.chat?.id, ...(query.message?.chat?.type !== undefined ? { chatType: query.message.chat.type } : {}) })
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
      // v0.8 提问作答按钮：aq:<qKey>:<idx>:<token>（questions 注入时才存在此分支）
      if (parts[0] === 'aq' && questions !== null && parts.length >= 4) {
        const qKey = parts.slice(1, -2).join(':')
        const optIdx = parts[parts.length - 2]
        const token = parts[parts.length - 1]
        const verdict = control !== null
          ? control.handle({ command: 'question-answer', eventId: String(query.id ?? ''), qKey, optIdx, token, via: 'telegram', channel: 'telegram', accountId: resolvedAccountId, userId: String(query.from?.id ?? ''), chatId: String(query.message?.chat?.id ?? ''), chatType: query.message?.chat?.type })
          : questions.decide({ qKey, optIdx, token, via: 'telegram', accountId: resolvedAccountId, userId: query.from?.id, chatId: query.message?.chat?.id })
        const text = verdict?.message ?? (verdict?.status === 'accepted' ? '✅ 已作答' : '该提问已回答或已过期')
        await api('answerCallbackQuery', { callback_query_id: query.id, text: String(text).slice(0, 200) }).catch(() => {})
        if (query.message?.chat?.id !== undefined) {
          await api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `${text}\n（来源：telegram user ${query.from?.id ?? '?'}）`,
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
        // v0.8.7：callback_query.id 是 Telegram 官方唯一回调事件标识——必须作为 eventId 传入
        // Control Core（approval spec 的 buildEvent 直取 input.eventId，缺失即 missing_eventId
        // 拒绝，按钮将无法裁决）。
        const verdict = control !== null
          ? control.handle({ command: 'approval', eventId: String(query.id ?? ''), approvalKey, decision, token, via: 'telegram', channel: 'telegram', accountId: resolvedAccountId, userId: String(query.from?.id ?? ''), chatId: String(query.message?.chat?.id ?? ''), chatType: query.message?.chat?.type })
          : bus.decide({
          approvalKey,
          decision,
          token,
          via: 'telegram',
          accountId: resolvedAccountId,
          userId: query.from?.id,
          chatId: query.message?.chat?.id,
        })
        const text = verdict.ok === true || verdict.status === 'accepted'
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
        accountId: resolvedAccountId,
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
        // Process-before-commit: advance/persist the offset ONLY after an update has
        // actually been handled. If handling a control update throws (crash, adapter
        // error mid-callback) we do NOT advance, so Telegram long-poll redelivers it on
        // the next getUpdates instead of silently dropping an unaccepted command. A batch
        // that fails is left un-committed by breaking out; earlier updates in the same
        // batch are redelivered alongside it and deduped by bus messageId / control
        // eventId (documented redelivery dedup). Bounded: a persistent failure backs off
        // and keeps the loop alive without spinning hot or burning the connection.
        for (const update of updates ?? []) {
          const next = (update.update_id ?? 0) + 1
          try {
            await handleUpdate(update)
            offset = Math.max(offset, next)
            store?.set('tg:offset', offset)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            warn(`update ${update.update_id} 处理失败，offset 未前移（下轮重投，靠 messageId/eventId 去重）: ${reason}`)
            break
          }
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
    channel: 'telegram',

    /** Truthful lifecycle state for the provider facade's status() (polling vs idle). */
    clientState() { return running ? 'connected' : 'stopped' },

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
        const allowRef = refs.mint(`ap:allowed-once:${approvalKey}:${token}`, { chatId })
        const rejectRef = refs.mint(`ap:rejected:${approvalKey}:${token}`, { chatId })
        if (allowRef === null || rejectRef === null) {
          if (allowRef !== null) refs.take(allowRef)
          if (rejectRef !== null) refs.take(rejectRef)
          warn('审批按钮引用容量已满，本次降级为文本通知')
          return null
        }
        const result = await api('sendMessage', {
          chat_id: chatId,
          // v0.6.3：去掉 parse_mode markdown——approvalKey（ap:<callId>:<n>，callId 常含 _）
          // 与 reason（路径/反引号）未转义，legacy markdown 未配对 _/* 必 400 "can't parse
          // entities"，卡片静默降级纯文本（审查 R2 P1-2，与 v0.6.2 BUTTON_DATA_INVALID
          // 同类 mock 盲区：mock fetch 不解析 markdown，单测测不出）。纯文本无此面。
          // P1-1：text 经 clampTelegramText 钳 4096（reason 上游无上限，见常量区注释）。
          text: clampTelegramText(`🔐 ${title}\n\n${content}\n\n_decision: ${approvalKey}_`),
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 批准（本次）', callback_data: `r:${allowRef}` },
              { text: '❌ 拒绝', callback_data: `r:${rejectRef}` },
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
        const rowEntries = (Array.isArray(buttons) ? buttons : [])
          .filter((button) => button !== null && typeof button === 'object'
            && typeof button.label === 'string' && button.label.trim() !== ''
            && typeof button.data === 'string' && button.data !== '')
          // v0.6.2：同审批卡——ac:<key>:<token> 同样超限，一律经短引用压缩
          .map((button) => {
            const ref = refs.mint(button.data, { chatId })
            return ref === null ? { failed: true, ref: null } : { failed: false, ref, row: { text: button.label, callback_data: `r:${ref}` } }
          })
        if (rowEntries.some((entry) => entry.failed === true)) {
          for (const entry of rowEntries) if (entry.ref !== null) refs.take(entry.ref)
          warn('动作按钮引用容量已满，本次降级为文本通知')
          return null
        }
        const rows = rowEntries.map((entry) => entry.row)
        if (rows.length === 0) return null
        const result = await api('sendMessage', {
          chat_id: chatId,
          // P1-1：同审批卡，content 无上游上限，统一过 4096 钳制
          text: clampTelegramText(`${title}\n\n${content}`),
          reply_markup: { inline_keyboard: [rows] },
        })
        return { messageId: result?.message_id }
      } catch (error) {
        warn(`动作卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /**
     * v0.8 推送提问选项卡片（单选：每选项一行按钮，一选项一钮）。
     * @returns {Promise<{ messageId: number } | null>} 多选（暂无卡片形态）/无选项/失败
     *   返回 null，caller 降级编号回复文案——选项卡为主，编号是兜底。
     */
    async sendQuestionCard({ chatId, title, content, qKey, token, options = [], multiSelect = false }) {
      if (multiSelect === true) return null
      try {
        // v0.6.2 同审批卡：callback_data 只放短引用 r:<ref>（TG 64 字节硬限，P7）
        const rowEntries = options
          .map((label, idx) => {
            const ref = refs.mint(buildQuestionAction(qKey, String(idx), token), { chatId })
            return ref === null ? { failed: true, ref: null } : { failed: false, ref, row: {
              text: `${idx + 1}. ${String(label).slice(0, 60)}`,
              callback_data: `r:${ref}`,
            } }
          })
        if (rowEntries.some((entry) => entry.failed === true)) {
          for (const entry of rowEntries) if (entry.ref !== null) refs.take(entry.ref)
          warn('提问按钮引用容量已满，本次降级为编号通知')
          return null
        }
        const rows = rowEntries.map((entry) => entry.row)
        if (rows.length === 0) return null
        const result = await api('sendMessage', {
          chat_id: chatId,
          // P1-1：提问 context 无上游上限（ask_user 入参直传），统一过 4096 钳制
          text: clampTelegramText(`❓ ${title}\n\n${content}`),
          reply_markup: { inline_keyboard: rows.map((row) => [row]) }, // 一选项一行，手机端可读
        })
        return { messageId: result?.message_id }
      } catch (error) {
        warn(`提问卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /**
     * 把远端消息编辑为最终状态（桌面先处理时防止过期按钮二次审批）。
     * v0.8 契约对齐：normalizeInbound 非 legacy 路径传 (target, text) 两参——本通道
     * 自 v0.7 有 notifyTargets() 即非 legacy，旧三参 (chatId, messageId, text) 签名
     * 与契约错位（真机上 chat_id 收到 target 对象 → TG 400 被吞，超时/编号回复路径的
     * 终态编辑静默失败；mock fetch 不校验参数形状，单测测不出）。双形状防御解析。
     */
    async editResolved(targetOrChatId, messageIdOrText, maybeText) {
      const isTarget = targetOrChatId !== null && typeof targetOrChatId === 'object'
      const chatId = isTarget ? targetOrChatId.chatId : targetOrChatId
      const messageId = isTarget ? targetOrChatId.messageId : messageIdOrText
      const text = isTarget ? messageIdOrText : maybeText
      // Text-fallback ladder: edit the live card to a terminal state; if the edit fails
      // (message edited or deleted / 400), append the button-failure suffix and try a
      // second edit; if that too fails (message is gone), send ONE fresh text message so
      // the desktop-side outcome still reaches the user instead of vanishing silently.
      try {
        await api('editMessageText', { chat_id: chatId, message_id: messageId, text })
      } catch (error) {
        warn(`终态编辑失败，改发失效兜底: ${error instanceof Error ? error.message : String(error)}`)
        try {
          await api('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: makeTerminalFallbackText(text),
            reply_markup: { inline_keyboard: [] },
          })
        } catch (error2) {
          warn(`终态失效兜底再次失败，改发独立文本: ${error2 instanceof Error ? error2.message : String(error2)}`)
          try {
            await api('sendMessage', { chat_id: chatId, text: clampTelegramText(`${text}\n（操作已完成；原消息可能已删除）`) })
          } catch { /* 最后的兜底也失败则静默——总比二次报错强 */ }
        }
      }
    },

    /**
     * 发一条普通文本到指定 chat（会话路由的命令回执用；失败静默——回执尽力而为）。
     * @returns {Promise<boolean>} 是否成功
     */
    async sendText(chatId, text) {
      try {
        // clampTelegramText keeps the reply within the UTF-16 4096 hard limit and never
        // splits a surrogate pair (millions of astral emoji would otherwise 400 on device).
        await api('sendMessage', { chat_id: chatId, text: clampTelegramText(text) })
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
