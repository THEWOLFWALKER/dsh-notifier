// dsh-notifier inbound/feishu-bot.mjs
// 飞书（Lark）双向入站（v0.3.0 阶段 1）：官方开放平台应用 + WebSocket 长连接（免公网）。
//  - 事件订阅：im.message.receive_v1（私聊/群聊文本）→ bus.accept
//  - 审批卡片：interactive 卡片两按钮（value.act 与 telegram callback_data 同构，
//    复用 buildApprovalAction/parseApprovalAction + bus.decide 的 token 核销）
//  - v0.5 动作卡片：sendActionCard（自定义按钮行）+ ac: 回调分支（actions.dispatch）
//  - 卡片回调：card.action.trigger（新式卡片回调，支持长连接；旧式回调不支持）
//  - SDK 懒加载：@larksuiteoapi/node-sdk 为 optionalDependencies——未安装时中文指引并
//    优雅降级（返回不可用实例，不弄崩宿主）。飞书 WS 是私有 protobuf 帧（pbbp2），
//    手写客户端不现实，官方 SDK 是唯一 prod 依赖（体积由启用者自付）。
// 军规：handler 3s 内必须返回（超时服务端会重推，重推由 bus 的 messageId 去重吸收）；
// 任何异常只 warn，绝不弄崩宿主；stop() 干净退出。

import { buildApprovalAction, parseApprovalAction, parseActionPayload } from './_contract.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'

const DEFAULT_DOMAIN = 'https://open.feishu.cn'
const SDK_PACKAGE = '@larksuiteoapi/node-sdk'

/**
 * 解析并校验 inbound.feishu 配置。
 * @param {object} raw - inbound.feishu 原始配置
 * @param {{ envRefs?: (v: any) => any, credentials?: object }} [options]
 *   - envRefs：${ENV:NAME} 引用解析（index 装配时已先解析一遍则传恒等）
 *   - credentials：扫码落盘凭证回退（store 'feishu:account'，config 显式配置优先）
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function resolveFeishuInboundConfig(raw, { envRefs = (v) => v, credentials } = {}) {
  const cfg = (raw !== null && typeof raw === 'object') ? raw : {}
  const creds = (credentials !== null && typeof credentials === 'object') ? credentials : {}
  const appId = String(envRefs(cfg.appId ?? creds.appId ?? '')).trim()
  const appSecret = String(envRefs(cfg.appSecret ?? creds.appSecret ?? '')).trim()
  if (appId === '' || appSecret === '') {
    return { ok: false, reason: `飞书 inbound 需要 appId 与 appSecret（当前 appId ${appId !== '' ? '已配置' : '缺失'}，appSecret ${appSecret !== '' ? '已配置' : '缺失'}）。请在飞书开放平台创建企业自建应用并填入，或执行 node scripts/channel-login.mjs feishu 扫码一键创建自动写入` }
  }
  return {
    ok: true,
    config: {
      appId,
      appSecret,
      domain: String(envRefs(cfg.domain ?? '')).trim() || DEFAULT_DOMAIN,
      allowUsers: (Array.isArray(cfg.allowUsers) ? cfg.allowUsers : []).map((id) => String(id).trim()).filter((id) => id !== ''),
    },
  }
}

/** 从文本消息 content 里提取净文本（剥 @提及占位 @_user_N）。 */
function extractText(content) {
  try {
    const parsed = JSON.parse(content ?? '')
    const text = typeof parsed?.text === 'string' ? parsed.text : ''
    return text.replace(/@_user_\d+/g, '').trim()
  } catch {
    return ''
  }
}

/**
 * 按接收者 ID 前缀选 receive_id_type：
 * ou_ = open_id（私聊用户）、oc_ = chat_id（群聊，回执走这里）、on_ = union_id。
 * 兜底 open_id：notifyTargets 全部来自 allowUsers（open_id）。
 */
function receiveIdTypeOf(id) {
  if (id.startsWith('oc_')) return 'chat_id'
  if (id.startsWith('on_')) return 'union_id'
  return 'open_id'
}

/** 组装飞书 interactive 卡片（header + 说明 + 两按钮）。 */
function buildCard({ title, content, approvalKey, token }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `🔐 ${title}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 批准（本次）' },
            type: 'primary',
            value: { act: buildApprovalAction('allowed-once', approvalKey, token) },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { act: buildApprovalAction('rejected', approvalKey, token) },
          },
        ],
      },
    ],
  }
}

/** 已裁决态卡片（editResolved 用 patch 覆盖）。 */
function buildResolvedCard(text) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '审批已完成' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

/** 已处置态动作卡片（v0.5，防过期按钮二次点击）。 */
function buildActionResolvedCard(text) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '操作已完成' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

/** v0.5 动作卡片（通知文本 + 自定义按钮行；按钮 value.act = ac:<actionKey>:<token>）。 */
function buildActionCard({ title, content, actions: buttons = [] }) {
  const actions = (Array.isArray(buttons) ? buttons : [])
    .filter((button) => button !== null && typeof button === 'object'
      && typeof button.label === 'string' && button.label.trim() !== ''
      && typeof button.data === 'string' && button.data !== '')
    .map((button) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: 'danger',
      value: { act: button.data },
    }))
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: String(title ?? '') },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: String(content ?? '') } },
      ...(actions.length > 0 ? [{ tag: 'hr' }, { tag: 'action', actions }] : []),
    ],
  }
}

/**
 * 创建飞书入站通道（统一契约：channel/notifyTargets/sendApprovalCard/sendActionCard/editResolved/sendText）。
 * @param {object} options
 * @param {{ appId: string, appSecret: string, domain?: string, allowUsers?: string[] }} options.config
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} options.bus
 * @param {string[]} [options.fallbackTargets] - 未配置 allowUsers 时的卡片推送目标（全局白名单回落）
 * @param {object} [options.logger]
 * @param {() => Promise<object>} [options.sdkLoader] - SDK 懒加载器（测试注入；默认动态 import）
 * @param {ReturnType<typeof import('../actions.mjs').createActionDispatcher>} [options.actions]
 *   - v0.5 动作分发器（可空：缺省时 ac: 回调分支不存在，行为与 v0.4.0 一致）
 */
export function createFeishuInbound({ config, bus, fallbackTargets = [], logger = null, sdkLoader, actions = null, identity = null } = {}) {
  const domain = (config.domain || DEFAULT_DOMAIN).replace(/\/+$/, '')
  const allowUsers = Array.isArray(config.allowUsers) ? config.allowUsers.map(String) : []
  const warn = (message) => {
    try { logger?.warn?.('[dsh-notifier/inbound:feishu]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时轮询/装配告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/inbound:feishu]', message) } catch { /* 控制台不可用不致命 */ }
  }

  const loadSdk = sdkLoader ?? (async () => import(SDK_PACKAGE))
  let client = null // Lark.Client（发送消息）
  let wsClient = null // Lark.WSClient（长连接）
  let running = false
  let startPromise = null

  async function ensureStarted() {
    const sdk = await loadSdk()
    if (sdk?.Client === undefined || sdk?.WSClient === undefined || sdk?.EventDispatcher === undefined) {
      throw new Error(`${SDK_PACKAGE} 接口不完整（缺 Client/WSClient/EventDispatcher）`)
    }
    client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret, domain })
    wsClient = new sdk.WSClient({ appId: config.appId, appSecret: config.appSecret, domain, logger: null })
    await wsClient.start({
      eventDispatcher: new sdk.EventDispatcher({}).register({
        'im.message.receive_v1': (data) => handleMessage(data),
        'card.action.trigger': (data) => handleCardAction(data),
      }),
    })
  }

  function handleMessage(data) {
    try {
      const message = data?.message ?? {}
      const openId = String(data?.sender?.sender_id?.open_id ?? '')
      const messageId = String(message.message_id ?? '')
      if (messageId === '' || openId === '') return
      const text = String(message.message_type ?? '') === 'text'
        ? extractText(message.content)
        : `[不支持的消息类型：${message.message_type ?? 'unknown'}]`
      if (text === '') return
      // bus 白名单 + 去重在 bus 层完成；本层只负责规范化 envelope。
      // v0.7：chat_type 透传（/pair 私聊判定）；accept 返回值消费——拒绝/命令回执不再已读不回
      const envelope = {
        channel: 'feishu',
        userId: openId,
        chatId: String(message.chat_id ?? openId),
        chatType: String(message.chat_type ?? ''),
        messageId,
        text,
      }
      const result = bus.accept(envelope)
      if (result?.reply !== undefined && client !== null) {
        // 回执尽力而为：失败只 warn 不上抛（A listener never throws）
        const receiveId = envelope.chatId
        client.im.v1.message.create({
          params: { receive_id_type: receiveIdTypeOf(receiveId) },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: String(result.reply).slice(0, 4000) }) },
        }).catch((error) => {
          warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    } catch (error) {
      warn(`事件处理异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 把卡片 patch 成终态（不 await，3s 内先回 toast；失败静默）。 */
  function patchResolvedCard(data, card) {
    const messageId = String(data?.message_id ?? data?.open_message_id ?? '')
    if (messageId === '' || client === null) return
    client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }).catch(() => {})
  }

  function handleCardAction(data) {
    try {
      const value = data?.action?.value ?? {}
      const raw = typeof value.act === 'string' ? value.act : ''
      const action = parseActionPayload(raw)
      // v0.5 动作按钮：ac:<actionKey>:<token>（actions 注入时才处理）
      if (action !== null) {
        if (actions === null) return { toast: { type: 'info', content: '未知操作' } }
        const result = actions.dispatch({
          actionKey: action.actionKey,
          token: action.token,
          via: 'feishu:action',
          userId: String(data?.operator?.open_id ?? '(unknown)'),
        })
        const text = result?.message ?? '该操作已处理或已过期'
        patchResolvedCard(data, buildActionResolvedCard(`${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`))
        return { toast: { type: result?.ok === true ? 'success' : 'info', content: text } }
      }
      const approvalAction = parseApprovalAction(raw)
      if (approvalAction === null) return { toast: { type: 'info', content: '未知操作' } }
      const verdict = bus.decide({
        approvalKey: approvalAction.approvalKey,
        decision: approvalAction.decision,
        token: approvalAction.token,
        via: 'feishu:button',
        userId: String(data?.operator?.open_id ?? '(unknown)'),
      })
      const text = verdict.ok
        ? (approvalAction.decision === 'allowed-once' ? '✅ 已批准（单次有效）' : '❌ 已拒绝')
        : '该审批已处理或已过期（token 单次核销）'
      // 卡片改成终态（patch 覆盖按钮，防过期按钮二次点击）；不 await，3s 内先回 toast
      patchResolvedCard(data, buildResolvedCard(`${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`))
      return { toast: { type: verdict.ok ? 'success' : 'info', content: text } }
    } catch (error) {
      warn(`卡片回调异常: ${error instanceof Error ? error.message : String(error)}`)
      return { toast: { type: 'info', content: '处理异常，请重试' } }
    }
  }

  async function sendInteractive(chatId, card) {
    const receiveId = String(chatId)
    const response = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdTypeOf(receiveId) },
      data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    if (response?.code !== undefined && Number(response.code) !== 0) {
      throw new Error(`飞书发送失败：code=${response.code} msg=${response.msg ?? ''}`)
    }
    return String(response?.data?.message_id ?? '')
  }

  return {
    channel: 'feishu',

    /** 启动 WS 长连接（幂等；SDK 缺失时中文指引后静默不可用）。 */
    start() {
      if (running || startPromise !== null) return
      running = true
      startPromise = (async () => {
        try {
          await ensureStarted()
          warn('飞书 WebSocket 长连接已建立（事件订阅 + 卡片回调）')
        } catch (error) {
          running = false
          startPromise = null
          const reason = error instanceof Error ? error.message : String(error)
          warn(`飞书 inbound 启动失败（本通道不可用，不影响其他通道）: ${reason}${/Cannot find package|Failed to resolve/.test(reason) ? `；请安装 ${SDK_PACKAGE}（npm i ${SDK_PACKAGE}，或检查 --no-optional 安装）` : ''}`)
        }
      })()
    },

    /** 停止长连接（尽力而为：SDK 未暴露 stop 时只标记退出）。 */
    async stop() {
      running = false
      try {
        await startPromise
        if (wsClient !== null && typeof wsClient.close === 'function') await wsClient.close()
        else if (wsClient !== null && typeof wsClient.stop === 'function') await wsClient.stop()
      } catch { /* 关闭失败不致命 */ }
      wsClient = null
      client = null
      startPromise = null
    },

    /** 卡片推送目标（v0.7 三级解析）：绑定成员 → 通道 allowUsers → 全局回落（仅绑定表整体空）。 */
    notifyTargets() {
      return resolveNotifyTargets({
        identity,
        channel: 'feishu',
        configTargets: allowUsers,
        fallbackTargets,
      })
    },

    /** 推送审批卡片（失败 null，caller 降级纯通知）。 */
    async sendApprovalCard({ chatId, title, content, approvalKey, token }) {
      if (client === null) return null
      try {
        const messageId = await sendInteractive(chatId, buildCard({ title, content, approvalKey, token }))
        return messageId !== '' ? { messageId } : null
      } catch (error) {
        warn(`审批卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /**
     * v0.5 推送动作卡片（通知文本 + 自定义按钮行；event-listener 的 stall/心跳通知调用）。
     * @returns {Promise<{ messageId: string } | null>} 无有效按钮/失败返回 null（caller 降级）
     */
    async sendActionCard({ chatId, title, content, actions: buttons = [] }) {
      if (client === null) return null
      const card = buildActionCard({ title, content, actions: buttons })
      if (!Array.isArray(card.elements) || !card.elements.some((element) => element?.tag === 'action')) return null
      try {
        const messageId = await sendInteractive(chatId, card)
        return messageId !== '' ? { messageId } : null
      } catch (error) {
        warn(`动作卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 把卡片改成终态（账本 pushedTo 行 target = {channel, chatId, userId, messageId}）。 */
    async editResolved(target, text) {
      if (client === null || target?.messageId === undefined) return
      await client.im.v1.message.patch({
        path: { message_id: String(target.messageId) },
        data: { content: JSON.stringify(buildResolvedCard(text)) },
      }).catch(() => {})
    },

    /** 发普通文本（命令回执；尽力而为）。 */
    async sendText(chatId, text) {
      if (client === null) return false
      try {
        const receiveId = String(chatId)
        const response = await client.im.v1.message.create({
          params: { receive_id_type: receiveIdTypeOf(receiveId) },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: String(text ?? '').slice(0, 4000) }) },
        })
        return !(response?.code !== undefined && Number(response.code) !== 0)
      } catch (error) {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}
