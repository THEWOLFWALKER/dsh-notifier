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

import { buildApprovalAction, buildQuestionAction, parseApprovalAction, parseActionPayload, parseQuestionAction } from './_contract.mjs'
import { resolveNotifyTargets } from './target-guard.mjs'
import { stripCommandMention, stripLeadingMention } from './commands.mjs'
import { verdictFailureText } from './verdict-text.mjs'

const DEFAULT_DOMAIN = 'https://open.feishu.cn'
const SDK_PACKAGE = '@larksuiteoapi/node-sdk'

// G-17：飞书卡片 TTL 兜底（对齐 TG refs DEFAULT_TTL_MS 15min）。升级前在途卡片缺
// srcChat/iat 时兼容放行——TG 侧由 ref TTL 15min 天然封顶，飞书侧此前无等价约束，
// 旧卡片可被无限转发点击（跨会话裁决窗口无上限）。卡片 value 增带 iat 后窗口封顶，
// 两渠道强度对称。
const CARD_TTL_MS = 15 * 60 * 1000

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

/**
 * 从文本消息 content 里提取净文本（G-25：@提及占位 @_user_N 依据事件 mentions 映射「还原」为 @名字）。
 *
 * 飞书文本消息把 @提及 压成不透明占位符 @_user_N，真名放在事件 message.mentions[] 里
 * （官方《接收消息内容结构》：mentions[].key = '@_user_N'，mentions[].name = 展示名；
 * id 为 open_id 对象或字符串两种 schema 均有，此处只用 key/name）。旧实现把占位符
 * 直接删成空串：
 *   - '帮我提醒 @_user_2 开会' → '帮我提醒  开会'（连续双空格 + 谁被 @ 的语义全丢）
 *   - '/pair @_user_1 code'    → '/pair  code'（占位符虽被 parseCommand 的 \s+ 分词吸收，
 *     但消息里 @ 了谁这一信息彻底丢失）
 *
 * 【还原 vs 剥离——与 TG/钉钉的策略差异】飞书是「还原语义」不是「剥离」：TG/钉钉的 @ 是
 * 字面文本、渠道不带任何元数据，只能按形态剥（stripCommandMention/stripLeadingMention）；
 * 飞书有结构化 mentions 映射，能把不透明占位符还原成可读 '@名字'，保住「谁被提到」的语义，
 * 双空格随之消失。还原后才做通用的「行首机器人提及 = 寻址噪音」剥离（见 handleMessage）——
 * 那是所有渠道共用的寻址噪音规则，与这里的还原不冲突。
 *
 * mentions 缺失或该占位符不在映射里 → 退回旧行为（删成空串）：事件不带 mentions 时无从
 * 还原，宁可丢名字也不留 '@_user_1' 这种对用户无意义的占位符残片。
 *
 * @param {string} content - message.content（JSON 字符串，形如 {"text":"@_user_1 hi"}）
 * @param {Array<{key?: string, name?: string}>} [mentions] - 事件 message.mentions
 * @returns {string} 还原/剥离占位符后的净文本（trim 过）
 */
function extractText(content, mentions = []) {
  try {
    const parsed = JSON.parse(content ?? '')
    const text = typeof parsed?.text === 'string' ? parsed.text : ''
    if (text === '') return ''
    const byKey = new Map()
    for (const mention of Array.isArray(mentions) ? mentions : []) {
      const key = String(mention?.key ?? '')
      const name = String(mention?.name ?? '').trim()
      if (key !== '' && name !== '') byKey.set(key, `@${name}`)
    }
    if (byKey.size === 0) return text.replace(/@_user_\d+/g, '').trim()
    return text.replace(/@_user_\d+/g, (placeholder) => byKey.get(placeholder) ?? '').trim()
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
function buildCard({ title, content, approvalKey, token, chatId }) {
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
            value: { act: buildApprovalAction('allowed-once', approvalKey, token), srcChat: String(chatId ?? ''), iat: Date.now() },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { act: buildApprovalAction('rejected', approvalKey, token), srcChat: String(chatId ?? ''), iat: Date.now() },
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

/** 已作答态提问卡片（v0.8，防过期按钮二次点击）。 */
function buildQuestionResolvedCard(text) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '提问已作答' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

/**
 * v0.8 提问选项卡片（单选：每选项一个按钮，value.act = aq:<qKey>:<idx>:<token>）。
 * 多选暂无卡片形态（表单组件回调负载未实测）：caller 判 multiSelect 不发卡，编号兜底。
 */
function buildQuestionCard({ title, content, qKey, token, options = [], chatId }) {
  const actions = options.map((label, idx) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${idx + 1}. ${String(label).slice(0, 30)}` },
    type: 'default',
    value: { act: buildQuestionAction(qKey, String(idx), token), srcChat: String(chatId ?? ''), iat: Date.now() },
  }))
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: `❓ ${String(title ?? '').slice(0, 100)}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: String(content ?? '') } },
      { tag: 'hr' },
      { tag: 'action', actions },
    ],
  }
}

/** v0.5 动作卡片（通知文本 + 自定义按钮行；按钮 value.act = ac:<actionKey>:<token>）。 */
function buildActionCard({ title, content, actions: buttons = [], chatId }) {
  const actions = (Array.isArray(buttons) ? buttons : [])
    .filter((button) => button !== null && typeof button === 'object'
      && typeof button.label === 'string' && button.label.trim() !== ''
      && typeof button.data === 'string' && button.data !== '')
    .map((button) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: 'danger',
      // v0.8.4 F-08：动作卡同样嵌入来源会话（srcChat），callback 侧比对点击会话
      value: { act: button.data, srcChat: String(chatId ?? ''), iat: Date.now() },
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
 * @param {object} [options.questions]
 *   - v0.8 提问桥裁决入口（可空：缺省时 aq: 回调回「未知操作」，行为与 v0.7 一致）
 */
export function createFeishuInbound({ config, bus, fallbackTargets = [], logger = null, sdkLoader, actions = null, identity = null, questions = null, control = null, accountId = null } = {}) {
  const domain = (config.domain || DEFAULT_DOMAIN).replace(/\/+$/, '')
  const allowUsers = Array.isArray(config.allowUsers) ? config.allowUsers.map(String) : []
  // Stable per-provider account id, injected into every normalized indicator so shared
  // Control Core source binding accepts valid callbacks and rejects a different account.
  // Explicit config.accountId or config.appId wins; the EVENT payload is NEVER trusted as a
  // source. The facade owns the resolver and passes it down as a top-level option.
  const resolvedAccountId = String(accountId ?? config.accountId ?? config.appId ?? '').trim()
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
  // Truthful lifecycle for the provider facade's status(): idle → starting → connected,
  // or unavailable (SDK missing) / error (WS handshake failed) on startup failure, stopped on stop().
  let lifecycle = 'idle'

  async function ensureStarted() {
    const sdk = await loadSdk()
    if (sdk?.Client === undefined || sdk?.WSClient === undefined || sdk?.EventDispatcher === undefined) {
      throw new Error(`${SDK_PACKAGE} 接口不完整（缺 Client/WSClient/EventDispatcher）`)
    }
    client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret, domain })
    // v0.7.3（#1/#4/#6）：SDK 的 WSClient.start() → reConnect()/pullConnectConfig() 内部会调
    // this.logger.info/debug/error，传 logger: null 在 SDK 1.46+ 直接抛
    // "Cannot read properties of null (reading 'info')"，rejection 被外层吞掉后
    // 长连接静默永远连不上。改传 noop 实现（error 级转发到插件 warn，保留排障可见性）。
    const sdkWsLogger = {
      info() {}, warn() {}, debug() {}, trace() {},
      error: (...args) => warn(`飞书 SDK WSClient: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`),
    }
    wsClient = new sdk.WSClient({ appId: config.appId, appSecret: config.appSecret, domain, logger: sdkWsLogger })
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
      const isText = String(message.message_type ?? '') === 'text'
      if (!isText) {
        // G-26：非文本消息静默忽略 + 回执，不再注入占位符文本——占位符会进 agent
        // 语境被当指令解读（注入面）。回执尽力而为，失败只 warn。
        const chatId = String(message.chat_id ?? openId)
        if (client !== null) {
          client.im.v1.message.create({
            params: { receive_id_type: receiveIdTypeOf(chatId) },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: '暂不支持该消息类型' }) },
          }).catch((error) => {
            warn(`非文本回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        return
      }
      const text = stripCommandMention(stripLeadingMention(extractText(message.content, message.mentions)))
      if (text === '') return
      // bus 白名单 + 去重在 bus 层完成；本层只负责规范化 envelope。
      // v0.7：chat_type 透传（/pair 私聊判定）；accept 返回值消费——拒绝/命令回执不再已读不回
      const envelope = {
        channel: 'feishu',
        accountId: resolvedAccountId,
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

  /** 飞书群聊识别：群聊 open chat_id 以 oc_ 开头（用户 open_id 以 ou_ 开头）。 */
  function isGroupChatId(chatId) {
    return String(chatId ?? '').startsWith('oc_')
  }

  /**
   * 把卡片 patch 成终态（不 await，3s 内先回 toast）。patch 失败（网络/消息不可及）时
   * 向点击会话发「恰好一条」文本兜底，确保桌面侧终态仍触达用户——绝不静默吞掉。
   * @param {object} data - card.action.trigger 事件
   * @param {object} card - 终态卡片
   * @param {string} [fallbackText] - patch 失败时补发的单条文本（为空则不补发）
   */
  function patchResolvedCard(data, card, fallbackText = '') {
    // v0.7.3（#6）：长连接投递的 card.action.trigger 事件负载顶层没有 message_id，
    // 实际位于 data.context.open_message_id；旧顺序取顶层字段恒为空串，
    // 导致裁决后卡片永远 patch 不成终态（按钮可重复点）。
    const messageId = String(
      data?.context?.open_message_id
      ?? data?.message_id
      ?? data?.open_message_id
      ?? '',
    )
    if (messageId === '' || client === null) return
    client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }).catch(() => {
      // patch 失败：给点击会话补发单条文本（一次），让终态可见；不重试、不重复。
      if (fallbackText !== '') sendPlain(clickedChatOf(data), fallbackText)
    })
  }

  /** 从 card.action.trigger 事件里取「点击发生的会话」。真机长连接负载的会话 id 位于
   *  data.context.open_chat_id（与 open_message_id 同层）；顶层字段兜底保留。 */
  function clickedChatOf(data) {
    return String(
      data?.context?.open_chat_id
      ?? data?.open_chat_id
      ?? data?.chat_id
      ?? '',
    )
  }

  /**
   * v0.8.7：构造 Control Core 需要的稳定 eventId（approval/question spec 的 buildEvent 直取
   * input.eventId，缺失即 missing_eventId 拒绝）。只用真实字段：open_message_id（同卡片的
   * 重复投递事件应去重）+ operator.open_id（不同操作者各自独立事件）+ act（同一卡片上
   * 批准/拒绝/选项按钮互不抢占）。空串兜底反而会被 normalize 拒绝（fail-closed），不会误放行。
   */
  function callbackEventIdOf(data, act) {
    const messageId = String(
      data?.context?.open_message_id
      ?? data?.message_id
      ?? data?.open_message_id
      ?? '',
    )
    const operator = String(data?.operator?.open_id ?? data?.sender?.sender_id?.open_id ?? '')
    return `feishu:${messageId}:${operator}:${String(act ?? '')}`
  }

  /** 发一条普通文本（终态兜底 / 群聊降级通知共用；尽力而为，失败不抛）。 */
  function sendPlain(chatId, text) {
    if (client === null) return false
    const receiveId = String(chatId)
    return client.im.v1.message.create({
      params: { receive_id_type: receiveIdTypeOf(receiveId) },
      data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: String(text ?? '').slice(0, 4000) }) },
    }).then((response) => !(response?.code !== undefined && Number(response.code) !== 0))
      .catch((error) => {
        warn(`回执发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return false
      })
  }

  /**
   * Personal-mode approval/question fallbacks must never disclose their
   * contents to an entire Feishu group. Keep ordinary status/command text
   * available in groups; only the stable sensitive-control headings emitted
   * by the approval/question bridges are blocked here.
   */
  function isSensitiveControlText(text) {
    const value = String(text ?? '')
    return /(?:^|\n)(?:需要批准：|提问：)/.test(value)
  }

  /**
   * v0.8.3 SEC-1：来源会话校验。卡片 value 里记录了发送目标会话（srcChat）；
   * 点击会话不一致 → 拒绝（toast 提示），不进入裁决、不 patch 终态。
   * 老卡片无 srcChat（升级前在途）→ 显式 warn 后跳过校验（兼容，不打历史卡片）。
   * C1（P1-4，v0.8.7）：srcChat 在场而点击会话读不到（事件形状异常/负载缺
   * open_chat_id）原为放行，等于缺关键信息即绕过校验 —— 改为 fail-closed 拒绝
   * （宪法 #7）。三个调用点（ac:/aq:/ap:）都把 false 转成 toast，不裁决、不 patch、
   * 不核销 wait，用户回到原会话即可重试（宪法 #6 不锁死）。
   * @returns {boolean} true = 通过（可继续裁决）；false = 已拒绝
   */
  function sourceChatAllowed(value, data) {
    const srcChat = String(value?.srcChat ?? '')
    if (srcChat === '') {
      warn('卡片回调缺少来源会话元数据（srcChat），跳过来源校验（升级前在途卡片兼容）')
      return true
    }
    const clicked = clickedChatOf(data)
    if (clicked === '') {
      warn(`卡片回调缺少点击会话（open_chat_id），来源校验拒绝（srcChat=${srcChat}；不裁决、不 patch，回原会话可重试）`)
      return false
    }
    if (String(clicked) !== String(srcChat)) {
      warn(`卡片点击会话与来源会话不一致（clicked=${clicked} srcChat=${srcChat}），来源校验拒绝`)
      return false
    }
    return true
  }

  function handleCardAction(data) {
    try {
      const value = data?.action?.value ?? {}
      const raw = typeof value.act === 'string' ? value.act : ''
      // G-17：卡片 TTL 校验（与 TG refs 15min 对称）。带 iat 的新卡超过窗口即拒绝——
      // 转发点击跨会话裁决的兼容放行窗口封顶；缺 iat（升级前在途）warn 后兼容放行，
      // 与 srcChat 缺省策略一致（升级瞬间的在途卡片最多 15min 内自然衰减）。
      if (typeof value.iat === 'number') {
        if (Date.now() - value.iat > CARD_TTL_MS) {
          warn(`卡片已过期（iat=${value.iat}，TTL=${CARD_TTL_MS}ms）: ${raw.slice(0, 48)}`)
          return { toast: { type: 'info', content: '该操作已处理或已过期（请回桌面处理）' } }
        }
      } else {
        warn('卡片回调缺少签发时间（iat），跳过 TTL 校验（升级前在途卡片兼容）')
      }
      const action = parseActionPayload(raw)
      // v0.5 动作按钮：ac:<actionKey>:<token>（actions 注入时才处理）
      if (action !== null) {
        if (actions === null) return { toast: { type: 'info', content: '未知操作' } }
        if (!sourceChatAllowed(value, data)) {
          return { toast: { type: 'info', content: '请到原会话操作' } }
        }
        const result = actions.dispatch({
          actionKey: action.actionKey,
          token: action.token,
          via: 'feishu:action',
          userId: String(data?.operator?.open_id ?? '(unknown)'),
          accountId: resolvedAccountId,
          chatId: clickedChatOf(data),
          chatType: data?.context?.open_chat_type ?? data?.chat_type,
        })
        const text = result?.message ?? verdictFailureText(result?.reason, 'approval', '该操作已处理或已过期')
        patchResolvedCard(data, buildActionResolvedCard(`${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`), `${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`)
        return { toast: { type: result?.ok === true ? 'success' : 'info', content: text } }
      }
      // v0.8 提问作答按钮：aq:<qKey>:<idx>:<token>（questions 注入时才处理）
      const questionAction = parseQuestionAction(raw)
      if (questionAction !== null) {
        if (questions === null) return { toast: { type: 'info', content: '未知操作' } }
        if (!sourceChatAllowed(value, data)) {
          return { toast: { type: 'info', content: '请到原会话操作' } }
        }
        const verdict = control !== null
          ? control.handle({
            command: 'question-answer', eventId: callbackEventIdOf(data, raw), qKey: questionAction.qKey, optIdx: questionAction.optIdx,
            token: questionAction.token, via: 'feishu:button', channel: 'feishu',
            accountId: resolvedAccountId,
            userId: String(data?.operator?.open_id ?? ''), chatId: clickedChatOf(data),
            chatType: data?.context?.open_chat_type ?? data?.chat_type,
          })
          : questions.decide({
          qKey: questionAction.qKey,
          optIdx: questionAction.optIdx,
          token: questionAction.token,
          via: 'feishu:button',
          accountId: resolvedAccountId,
          userId: String(data?.operator?.open_id ?? '(unknown)'),
          chatId: clickedChatOf(data),
        })
        const text = verdict?.message ?? (verdict?.status === 'accepted' ? '✅ 已作答' : verdictFailureText(verdict?.reason, 'question', '该提问已回答或已过期'))
        patchResolvedCard(data, buildQuestionResolvedCard(`${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`), `${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`)
        return { toast: { type: verdict?.ok === true || verdict?.status === 'accepted' ? 'success' : 'info', content: text } }
      }
      const approvalAction = parseApprovalAction(raw)
      if (approvalAction === null) return { toast: { type: 'info', content: '未知操作' } }
      if (!sourceChatAllowed(value, data)) {
        return { toast: { type: 'info', content: '请到原会话操作' } }
      }
      const verdict = control !== null
        ? control.handle({
          command: 'approval', eventId: callbackEventIdOf(data, raw), approvalKey: approvalAction.approvalKey, decision: approvalAction.decision,
          token: approvalAction.token, via: 'feishu:button', channel: 'feishu',
          accountId: resolvedAccountId,
          userId: String(data?.operator?.open_id ?? ''), chatId: clickedChatOf(data),
          chatType: data?.context?.open_chat_type ?? data?.chat_type,
        })
        : bus.decide({
        approvalKey: approvalAction.approvalKey,
        decision: approvalAction.decision,
        token: approvalAction.token,
        via: 'feishu:button',
        accountId: resolvedAccountId,
        userId: String(data?.operator?.open_id ?? '(unknown)'),
        chatId: clickedChatOf(data),
      })
      // G-54：失败话术按 reason 分层，与 TG 同源（verdict-text.mjs），不再一律「已处理或已过期」。
      const text = verdict.ok
        ? (approvalAction.decision === 'allowed-once' ? '✅ 已批准（单次有效）' : '❌ 已拒绝')
        : (verdict.message ?? verdictFailureText(verdict.reason, 'approval'))
      // 卡片改成终态（patch 覆盖按钮，防过期按钮二次点击）；不 await，3s 内先回 toast
      patchResolvedCard(data, buildResolvedCard(`${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`), `${text}（来源：飞书用户 ${data?.operator?.open_id ?? '?'}）`)
      return { toast: { type: (verdict.ok === true || verdict.status === 'accepted') ? 'success' : 'info', content: text } }
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

    /** 真实生命周期态（供 provider facade 的 status() 使用：idle/starting/connected/unavailable/error/stopped）。 */
    clientState() { return lifecycle },

    /** 启动 WS 长连接（幂等；SDK 缺失时中文指引后静默不可用）。 */
    start() {
      if (running || startPromise !== null) return
      running = true
      lifecycle = 'starting'
      startPromise = (async () => {
        try {
          await ensureStarted()
          lifecycle = 'connected'
          warn('飞书 WebSocket 长连接已建立（事件订阅 + 卡片回调）')
        } catch (error) {
          running = false
          startPromise = null
          const reason = error instanceof Error ? error.message : String(error)
          lifecycle = /Cannot find package|Failed to resolve/.test(reason) ? 'unavailable' : 'error'
          warn(`飞书 inbound 启动失败（本通道不可用，不影响其他通道）: ${reason}${/Cannot find package|Failed to resolve/.test(reason) ? `；请安装 ${SDK_PACKAGE}（npm i ${SDK_PACKAGE}，或检查 --no-optional 安装）` : ''}`)
        }
      })()
    },

    /** 停止长连接（尽力而为；SDK 无优雅关闭时 terminate 底层 socket）。 */
    async stop() {
      running = false
      lifecycle = 'stopped'
      try {
        await startPromise
        // v0.7.3（#4）：@larksuiteoapi/node-sdk（1.46/1.61/1.73）的 WSClient 没有
        // close()/stop() 公开方法——宿主服务重激活时旧实例的 WS 永远不断开，
        // 泄漏僵尸连接（事件被随机分发到旧连接、旧实例写 state 覆盖新实例）。
        // 防御顺序：优雅方法优先，没有则 terminate SDK 内部持有的 ws 实例。
        if (wsClient !== null && typeof wsClient.close === 'function') await wsClient.close()
        else if (wsClient !== null && typeof wsClient.stop === 'function') await wsClient.stop()
        else {
          try { wsClient?.wsConfig?.getWSInstance?.()?.terminate?.() } catch { /* 尽力而为 */ }
        }
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

    /** 推送审批卡片（失败 null，caller 降级纯通知）。群聊（oc_*）敏感控制卡片在发送前降级为纯文本——不投放可被任一群成员误点的按钮。 */
    async sendApprovalCard({ chatId, title, content, approvalKey, token }) {
      if (client === null) return null
      // 群聊：个人模式敏感审批不发送任何内容；router 也会丢弃该目标，
      // 这里保留显式降级标记以防调用方绕过规划层后登记虚假的送达证据。
      if (isGroupChatId(chatId)) {
        warn(`飞书群聊跳过敏感审批（chat=${String(chatId).slice(0, 32)}；请使用私聊）`)
        return { downgraded: true, messageId: '' }
      }
      try {
        const messageId = await sendInteractive(chatId, buildCard({ title, content, approvalKey, token, chatId }))
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
      // 群聊：不发动作按钮（group sensitive control downgrade），仅纯文本冒烟——避免群内任意成员触发。
      if (isGroupChatId(chatId)) {
        const ok = await sendPlain(chatId, `${title}\n\n${content}\n（群聊通道降级为纯文本，请到私聊操作）`)
        return ok ? { messageId: `downgraded:${chatId}`, downgraded: true } : null
      }
      const card = buildActionCard({ title, content, actions: buttons, chatId })
      if (!Array.isArray(card.elements) || !card.elements.some((element) => element?.tag === 'action')) return null
      try {
        const messageId = await sendInteractive(chatId, card)
        return messageId !== '' ? { messageId } : null
      } catch (error) {
        warn(`动作卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /**
     * v0.8 推送提问选项卡片（单选按钮，一选项一钮）。
     * @returns {Promise<{ messageId: string } | null>} 多选（暂无卡片形态）/失败返回 null，
     *   caller 降级编号回复文案——选项卡为主，编号是兜底。
     */
    async sendQuestionCard({ chatId, title, content, qKey, token, options = [], multiSelect = false }) {
      // 群聊拦截发送（block）：提问按钮不应投放给整个群（任何成员都能作答）。
      if (isGroupChatId(chatId)) return null
      if (client === null || multiSelect === true) return null
      try {
        const messageId = await sendInteractive(chatId, buildQuestionCard({ title, content, qKey, token, options, chatId }))
        return messageId !== '' ? { messageId } : null
      } catch (error) {
        warn(`提问卡片发送失败: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    /** 把卡片改成终态（账本 pushedTo 行 target = {channel, chatId, userId, messageId, kind?}）。
     *  patch 失败时向原 chat 补发「恰好一条」文本兜底（桌面侧终态不静默丢失）。 */
    async editResolved(target, text) {
      if (client === null || target?.messageId === undefined) return
      // kind 'aq' = 提问卡片（终态文案用「提问已作答」头，不误标「审批已完成」）
      const card = target?.kind === 'aq'
        ? buildQuestionResolvedCard(text)
        : buildResolvedCard(text)
      try {
        await client.im.v1.message.patch({
          path: { message_id: String(target.messageId) },
          data: { content: JSON.stringify(card) },
        })
      } catch {
        // 单条文本兜底：patch 失败（消息不可及/网络），终态以文本形式送达一次。
        if (target?.chatId !== undefined) await sendPlain(target.chatId, `${text}\n（原卡片已不可编辑，此为准结果）`)
      }
    },

    /** 发普通文本（命令回执；尽力而为）。 */
    async sendText(chatId, text) {
      // questions/router uses sendText for numbered fallback after
      // sendQuestionCard returns null. Suppress that sensitive fallback in a
      // group while retaining ordinary status and command notifications.
      if (isGroupChatId(chatId) && isSensitiveControlText(text)) {
        warn(`飞书群聊跳过敏感控制文本（chat=${String(chatId).slice(0, 32)}；请使用私聊）`)
        return false
      }
      return sendPlain(chatId, text)
    },
  }
}
