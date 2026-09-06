// dsh-notifier inbound/capability-matrix.mjs
// 跨渠道能力矩阵（维护批 6 前置基础设施）：六入站通道的统一事实来源——
//   - 渠道命名与别名（出站 adapter type ↔ 入站 channel 名）
//   - 能力标记（buttons / actionCard / questionCard / imageInbound / fileInbound）
//   - 展示名（中文 / 英文）
//   - 连接类型（WS / long-poll / HTTP callback）
//
// 设计原则：
//  - 单一事实来源：approval/router.mjs 和 questions/router.mjs 里散存的
//    DISPLAY_NAMES、OUTBOUND_TO_INBOUND_ALIAS 全部迁到这里，后续只改一处；
//  - 渐进式接入：现有消费方先不改行为，新增矩阵作为查询 API，后续逐步替换散存常量；
//  - fail-closed：未知渠道的能力查询返回安全默认值（buttons=false 等）；
//  - 证据驱动：image/file 入站能力只在对应 transport 已接线并有契约测试后置为 true；
//    这不是实机验证声明，未知协议形状仍必须 fail-closed。
//
// ⚠️ 群聊敏感交互（审批/提问卡片）不在本矩阵的「能力」范围内——
//    群聊仅普通消息/普通通知（README 明确不建议敏感用途），
//    按钮化审批/提问仅限单聊场景，由各发送方在 pushedTo 校验层把关。

/** 六入站通道全集（单一事实来源 channels-registry，此处转发导出保持既有 import 兼容）。 */
export { INBOUND_CHANNELS, INBOUND_CHANNEL_SET } from './channels-registry.mjs'
import { INBOUND_CHANNELS } from './channels-registry.mjs'

/**
 * 出站 adapter type → 入站 channel 名的别名映射。
 * 同一 IM 平台在出站侧和入站侧可能用不同 type 名（如出站 qq-bot vs 入站 qq）。
 * 用于：编号回复双发去重、卡片目标跨域查询等。
 */
export const OUTBOUND_TO_INBOUND_ALIAS = Object.freeze({
  'qq-bot': 'qq',
  'feishu': 'feishu',     // 出站和入站同名，但显式登记保持矩阵完整
  'telegram': 'telegram', // 同上
  'wxpusher': 'wxpusher',
  'dingtalk': 'dingtalk',
})

/**
 * 入站 channel 名 → 出站 adapter type 的反向映射（从别名表推导）。
 * 未知入站名返回 null。
 */
export function inboundToOutboundType(inboundChannel) {
  const ch = String(inboundChannel ?? '')
  // 先查完全匹配
  for (const [outType, inType] of Object.entries(OUTBOUND_TO_INBOUND_ALIAS)) {
    if (inType === ch) return outType
  }
  // 再查同名（如 wechat 没有对应出站 adapter——返回 null）
  if (OUTBOUND_TO_INBOUND_ALIAS[ch] === ch) return ch
  return null
}

/**
 * 该入站通道的编号话术是否已由出站文本送达（同名出站 type 或别名对）。
 * 用于避免同号双发：出站 qq-bot 已发编号文案时，qq 入站不再重发一遍。
 * 与 questions/router.mjs 的 isCoveredByOutbound 语义一致，迁到这里作为公共 API。
 */
export function isCoveredByOutbound(inboundChannel, outboundTextTypes) {
  const types = Array.isArray(outboundTextTypes) ? outboundTextTypes : []
  if (types.includes(inboundChannel)) return true
  return types.some((type) => OUTBOUND_TO_INBOUND_ALIAS[type] === inboundChannel)
}

/** 渠道展示名（中文）——用于用户可见的文案、日志、管理台。 */
export const DISPLAY_NAMES_ZH = Object.freeze({
  telegram: 'Telegram',
  feishu: '飞书',
  qq: 'QQ',
  wxpusher: 'WxPusher',
  wechat: '微信',
  dingtalk: '钉钉',
})

/** 渠道展示名（英文）。 */
export const DISPLAY_NAMES_EN = Object.freeze({
  telegram: 'Telegram',
  feishu: 'Feishu',
  qq: 'QQ Bot',
  wxpusher: 'WxPusher',
  wechat: 'WeChat iLink',
  dingtalk: 'DingTalk',
})

/**
 * 取渠道展示名。未知渠道返回原文（防御式，绝不抛）。
 * @param {string} channel - 入站渠道名
 * @param {'zh'|'en'} [lang='zh'] - 语言
 */
export function displayNameOf(channel, lang = 'zh') {
  const key = String(channel ?? '')
  const name = lang === 'en' ? DISPLAY_NAMES_EN[key] : DISPLAY_NAMES_ZH[key]
  return name ?? key
}

/**
 * 连接类型枚举。
 * - 'ws': WebSocket 长连接（feishu SDK WS / qq 网关 / dingtalk stream）
 * - 'long-poll': HTTP 长轮询（telegram getUpdates / wechat iLink getupdates）
 * - 'callback': HTTP 回调（wxpusher webhook，需公网可达）
 */
export const CONNECTION_TYPES = Object.freeze({
  telegram: 'long-poll',
  feishu: 'ws',
  qq: 'ws',
  wxpusher: 'callback',
  wechat: 'long-poll',
  dingtalk: 'ws',
})

/**
 * 渠道能力表。
 *
 * 各字段含义：
 *  - buttons: 是否有原生按钮交互（审批/动作/提问卡片是否可发按钮）。
 *    false 的通道走「回复编号」兜底（审批 1/2、提问数字作答）。
 *  - approvalCard: 是否实现 sendApprovalCard（按钮化审批卡片）。
 *    注意：buttons=true 的通道必然 approvalCard=true，但 buttons=false 的通道
 *    也有 sendApprovalCard（实现为纯文本 + 编号回复指引），所以分开标记。
 *  - actionCard: 是否实现 sendActionCard（v0.5 通知动作卡，如停止按钮）。
 *  - questionCard: 是否实现 sendQuestionCard（v0.8 远程提问选项卡）。
 *  - imageInbound: 入站是否支持图片消息归一（kind:'image'）。
 *    true 表示已接线且有契约测试；它不等同于 `real-device-verified`。
 *  - fileInbound: 入站是否支持文件消息归一（kind:'file'）。同样是证据门。
 *  - sourceChatCheck: 按钮回调是否做来源会话校验（SEC-1，防转发点击）。
 *    无按钮通道此值无意义，但标记为 false 保持矩阵完整。
 */
const CHANNEL_CAPABILITIES = Object.freeze({
  telegram: {
    buttons: true,
    approvalCard: true,
    actionCard: true,
    questionCard: true,
    imageInbound: false, // 无证据门控（后续有真机证据再翻转）
    fileInbound: false,  // 同上
    sourceChatCheck: true, // callback-ref origin.chatId 比对
  },
  feishu: {
    buttons: true,
    approvalCard: true,
    actionCard: true,
    questionCard: true,
    imageInbound: false, // 无证据门控
    fileInbound: false,  // 同上
    sourceChatCheck: true, // srcChat vs context.open_chat_id 比对
  },
  qq: {
    buttons: true,       // v0.8.4：官方机器人 markdown+keyboard 回调按钮
    approvalCard: true,  // 单聊原生审批键盘；群聊按安全策略降级文本
    actionCard: false,
    questionCard: true,  // 单聊原生选项键盘；失败/群聊由 router 走编号文本
    imageInbound: true,  // contract-tested: QQ C2C `extra` 图片段
    fileInbound: false,  // 无证据
    sourceChatCheck: true, // 回调携带 user/chat，Control Core 绑定原始目标
  },
  wxpusher: {
    buttons: false,
    approvalCard: false,
    actionCard: false,
    questionCard: false,
    imageInbound: false, // 无证据
    fileInbound: false,  // 无证据
    sourceChatCheck: false,
  },
  wechat: {
    buttons: false,
    approvalCard: false,
    actionCard: false,
    questionCard: false,
    imageInbound: true,  // contract-tested: iLink text/image item_list
    fileInbound: false,  // 无证据
    sourceChatCheck: false,
  },
  dingtalk: {
    buttons: false,
    approvalCard: false,
    actionCard: false,
    questionCard: false,
    imageInbound: true,  // contract-tested: DingTalk picture/image URL fields
    fileInbound: false,  // 无证据
    sourceChatCheck: false,
  },
})

/**
 * 查询某渠道的能力。未知渠道返回全 false（fail-closed：绝不把未知渠道
 * 当成有按钮/有图片的，避免消费方误走高级路径后炸掉）。
 * @param {string} channel - 入站渠道名
 * @returns {{ buttons: boolean, approvalCard: boolean, actionCard: boolean,
 *             questionCard: boolean, imageInbound: boolean, fileInbound: boolean,
 *             sourceChatCheck: boolean }}
 */
export function capabilitiesOf(channel) {
  const caps = CHANNEL_CAPABILITIES[String(channel ?? '')]
  if (caps === undefined) {
    return Object.freeze({
      buttons: false,
      approvalCard: false,
      actionCard: false,
      questionCard: false,
      imageInbound: false,
      fileInbound: false,
      sourceChatCheck: false,
    })
  }
  return caps // 已 freeze
}

/**
 * 列出有指定能力的所有入站通道。
 * @param {keyof typeof CHANNEL_CAPABILITIES.telegram} capability
 * @returns {string[]}
 */
export function channelsWith(capability) {
  const result = []
  for (const ch of INBOUND_CHANNELS) {
    if (CHANNEL_CAPABILITIES[ch][capability]) result.push(ch)
  }
  return result
}

/**
 * 出站适配器全集（27 个）——用于矩阵工具和文档生成。
 * 从 config.mjs ADAPTERS 动态引入会产生循环依赖风险，
 * 这里显式列出（保持与 CHANNEL_TYPES 一致，由测试锁死）。
 */
export const OUTBOUND_CHANNELS = Object.freeze([
  'bark', 'bell', 'chanify', 'desktop', 'dingtalk', 'discord', 'feishu',
  'gchat', 'gotify', 'igot', 'mattermost', 'ntfy', 'onebot', 'pushdeer',
  'pushover', 'pushplus', 'qmsg', 'qq-bot', 'serverchan', 'slack', 'teams',
  'telegram', 'webhook', 'wecom', 'wecom-app', 'wxpusher', 'xizhi',
])

/**
 * 出站通道是否有对应入站通道（双向通道）。
 * 用于文档生成和管理台通道卡片的「入站」标识。
 */
export function hasInbound(outboundType) {
  return OUTBOUND_TO_INBOUND_ALIAS[outboundType] !== undefined
}
