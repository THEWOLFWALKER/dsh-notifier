// dsh-notifier v0.15 Stage 1 — Native 用户词汇表（唯一事实来源）。
//
// 为什么单独一个模块：`channel-view` / `private-chat-view` / `read-model` 都要把内部状态
// 翻成用户能直接行动的话。文案散落三处就会漂移（同一个内部状态在两个页面显示不同说法），
// 所以这里集中定义，其余 native 模块只引用不新增。
//
// 红线（05_USER_COPY_GATE）：
//  - 只讲用户看到什么、能做什么；不解释实现，不出现内部状态名/工程词；
//  - 错误文案先给下一步动作，再给原因；
//  - 平台官方字段名（App ID / Bot Token 等）允许出现，但必须同时给人话。
//
// 所有文案以 `{ en, zh }` 成对保存，由 `pick()` 按语言取出**字符串**——上层契约
// （07_BACKEND_CONTRACTS）把 stateText / title / message 都声明为 string。

/** 按语言取字符串；未知语言回落中文（绝不返回对象，绝不返回 undefined）。 */
export function pick(copy, lang = 'zh') {
  if (copy === null || copy === undefined) return ''
  if (typeof copy === 'string') return copy
  const key = lang === 'en' ? 'en' : 'zh'
  const value = copy[key] ?? copy.zh ?? copy.en
  return value === null || value === undefined ? '' : String(value)
}

/** 渠道对用户呈现的四种状态（契约封闭集，绝不新增第五种）。 */
export const CHANNEL_STATES = Object.freeze(['not-set', 'connecting', 'ready', 'needs-attention'])

/** 状态 → 用户词（禁止内部状态名）。 */
export const STATE_TEXT = Object.freeze({
  'not-set': Object.freeze({ en: 'Not set up', zh: '还没设置' }),
  connecting: Object.freeze({ en: 'Connecting', zh: '正在连接' }),
  ready: Object.freeze({ en: 'Ready to use', zh: '可以使用' }),
  'needs-attention': Object.freeze({ en: 'Needs attention', zh: '需要处理' }),
})

/**
 * 渠道状态对应的唯一主动作（每屏一个主动作）。
 * not-set → 去设置；needs-attention → 去处理。可用/连接中不需要额外动作。
 */
export const STATE_ACTION = Object.freeze({
  'not-set': Object.freeze({ id: 'setup', label: Object.freeze({ en: 'Set up', zh: '去设置' }) }),
  'needs-attention': Object.freeze({ id: 'fix', label: Object.freeze({ en: 'Fix it', zh: '去处理' }) }),
})

/** 测试结果四态的用户文案：先给下一步，再给原因（原因由调用方拼接）。 */
export const RECEIPT_TEXT = Object.freeze({
  sent: Object.freeze({
    title: Object.freeze({ en: 'Test message sent', zh: '测试已发出' }),
    message: Object.freeze({ en: 'Check your phone to see if it arrived', zh: '请在手机上查看是否收到' }),
  }),
  confirmed: Object.freeze({
    title: Object.freeze({ en: 'Receipt confirmed', zh: '已确认收到' }),
    message: Object.freeze({ en: 'Your device confirmed it arrived', zh: '你的设备已确认收到' }),
  }),
  unknown: Object.freeze({
    title: Object.freeze({ en: "Can't confirm yet", zh: '暂时不能确认结果' }),
    message: Object.freeze({ en: 'Check your phone, or send the test again', zh: '请稍后在手机上确认，或再发一次' }),
  }),
  failed: Object.freeze({
    title: Object.freeze({ en: 'Test did not go out', zh: '测试没有发出' }),
    message: Object.freeze({ en: 'Check the settings and try again', zh: '请检查填写的信息，再试一次' }),
  }),
})

/** 使用者权限 → 用户词（不出现 role/policy 等内部词）。 */
export const PERMISSION_TEXT = Object.freeze({
  owner: Object.freeze({ en: 'Can manage', zh: '可以管理' }),
  member: Object.freeze({ en: 'Gets notifications', zh: '可以接收通知' }),
})

/** 私聊控制是否已确认本人的用户词。 */
export const VERIFIED_TEXT = Object.freeze({
  yes: Object.freeze({ en: 'You are confirmed', zh: '已确认是你' }),
  no: Object.freeze({ en: 'Not confirmed yet', zh: '还没确认本人' }),
})

/**
 * 掩码平台身份（userId 等）。绝不回放完整值，也绝不在空值时编造。
 * ≤4 位全掩；更长保留首尾各 2 位。
 */
export function maskIdentity(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (text === '') return undefined
  if (text.length <= 4) return '••••'
  return `${text.slice(0, 2)}•••${text.slice(-2)}`
}

/** 相对时间（与既有 activity/tasks 投影同口径；未知时间返回 undefined，绝不伪造）。 */
export function relativeText(at, now = Date.now()) {
  const n = Number(at)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const sec = Math.max(0, Math.round((now - n) / 1000))
  if (sec < 60) return { en: 'just now', zh: '刚刚' }
  const min = Math.round(sec / 60)
  if (min < 60) return { en: `${min} min ago`, zh: `${min} 分钟前` }
  const hours = Math.round(min / 60)
  if (hours < 24) return { en: `${hours} h ago`, zh: `${hours} 小时前` }
  const days = Math.round(hours / 24)
  return { en: `${days} d ago`, zh: `${days} 天前` }
}

/** 错误文案：下一步动作在前，原因在后（无原因则只给动作）。 */
export function nextStepWithReason(nextStep, reason, lang = 'zh') {
  const step = pick(nextStep, lang)
  const why = reason === null || reason === undefined || reason === '' ? '' : pick(reason, lang)
  return why === '' ? step : `${step}（${why}）`
}

/**
 * 渠道目录：用户看到的名字、一句用途、品牌标识键与分组。
 *
 * 为什么集中在这里：picker 要「Logo + 名称 + 一句用途」，rail 要「真实 Logo + 名称」。
 * 若各页面各自维护名字，同一个渠道会在两处显示不同说法（05_USER_COPY_GATE 红线）。
 *
 * 红线：
 *  - 只给用户词，**不出现协议/实现名**（`webhook` 不是用户词，写成「自定义地址」）；
 *  - 名称是品牌名（Telegram / Bark / Server 酱），不是内部 type；
 *  - brand 是渲染真实 Logo 的键，客户端据此画品牌标记，禁用点状图标。
 *
 * group：`common` = 首次添加最常用的一屏；`other` = 其余通知方式。
 */
const CHANNEL_ENTRY = (name, usage, brand, group = 'other') => Object.freeze({
  name: Object.freeze(name),
  usage: Object.freeze(usage),
  brand,
  group,
})

export const CHANNEL_CATALOG = Object.freeze({
  telegram: CHANNEL_ENTRY(
    { en: 'Telegram', zh: 'Telegram' },
    { en: 'Instant alerts on your phone', zh: '手机上即时收到提醒' },
    'telegram', 'common',
  ),
  qq: CHANNEL_ENTRY(
    { en: 'QQ', zh: 'QQ' },
    { en: 'Alerts inside QQ', zh: '在 QQ 里接收提醒' },
    'qq', 'common',
  ),
  feishu: CHANNEL_ENTRY(
    { en: 'Feishu', zh: '飞书' },
    { en: 'Alerts inside Feishu', zh: '在飞书里接收提醒' },
    'feishu', 'common',
  ),
  wecom: CHANNEL_ENTRY(
    { en: 'WeCom', zh: '企业微信' },
    { en: 'Alerts inside WeCom', zh: '在企业微信里接收提醒' },
    'wecom', 'common',
  ),
  'wecom-app': CHANNEL_ENTRY(
    { en: 'WeCom app', zh: '企业微信应用' },
    { en: 'Alerts from a WeCom app', zh: '通过企业微信应用接收提醒' },
    'wecom', 'other',
  ),
  dingtalk: CHANNEL_ENTRY(
    { en: 'DingTalk', zh: '钉钉' },
    { en: 'Alerts inside DingTalk', zh: '在钉钉里接收提醒' },
    'dingtalk', 'common',
  ),
  wechat: CHANNEL_ENTRY(
    { en: 'WeChat', zh: '微信' },
    { en: 'Alerts inside WeChat', zh: '在微信里接收提醒' },
    'wechat', 'common',
  ),
  bark: CHANNEL_ENTRY(
    { en: 'Bark', zh: 'Bark' },
    { en: 'Push alerts to your iPhone', zh: '推送到你的 iPhone' },
    'bark', 'common',
  ),
  wxpusher: CHANNEL_ENTRY(
    { en: 'WxPusher', zh: 'WxPusher' },
    { en: 'Alerts through a WeChat public account', zh: '通过微信公众号接收提醒' },
    'wxpusher', 'common',
  ),
  serverchan: CHANNEL_ENTRY(
    { en: 'ServerChan', zh: 'Server 酱' },
    { en: 'Alerts through a WeChat service account', zh: '通过微信服务号接收提醒' },
    'serverchan', 'other',
  ),
  pushplus: CHANNEL_ENTRY(
    { en: 'PushPlus', zh: 'PushPlus' },
    { en: 'Alerts to WeChat', zh: '推送到微信' },
    'pushplus', 'other',
  ),
  pushdeer: CHANNEL_ENTRY(
    { en: 'PushDeer', zh: 'PushDeer' },
    { en: 'Alerts to several devices', zh: '推送到多个设备' },
    'pushdeer', 'other',
  ),
  pushover: CHANNEL_ENTRY(
    { en: 'Pushover', zh: 'Pushover' },
    { en: 'Alerts to iPhone and Android', zh: '推送到 iPhone 与安卓' },
    'pushover', 'other',
  ),
  gotify: CHANNEL_ENTRY(
    { en: 'Gotify', zh: 'Gotify' },
    { en: 'Alerts from your own server', zh: '从你自己的服务器推送' },
    'gotify', 'other',
  ),
  ntfy: CHANNEL_ENTRY(
    { en: 'ntfy', zh: 'ntfy' },
    { en: 'Alerts from a simple push service', zh: '通过轻量推送服务接收提醒' },
    'ntfy', 'other',
  ),
  chanify: CHANNEL_ENTRY(
    { en: 'Chanify', zh: 'Chanify' },
    { en: 'Alerts to your devices', zh: '推送到你的设备' },
    'chanify', 'other',
  ),
  bell: CHANNEL_ENTRY(
    { en: 'Bell', zh: 'Bell' },
    { en: 'Alerts to your devices', zh: '推送到你的设备' },
    'bell', 'other',
  ),
  igot: CHANNEL_ENTRY(
    { en: 'iGot', zh: 'iGot' },
    { en: 'Alerts to your iPhone', zh: '推送到你的 iPhone' },
    'igot', 'other',
  ),
  qmsg: CHANNEL_ENTRY(
    { en: 'Qmsg', zh: 'Qmsg 酱' },
    { en: 'Alerts inside QQ', zh: '在 QQ 里接收提醒' },
    'qmsg', 'other',
  ),
  onebot: CHANNEL_ENTRY(
    { en: 'OneBot', zh: 'OneBot' },
    { en: 'Alerts inside QQ', zh: '在 QQ 里接收提醒' },
    'qq', 'other',
  ),
  discord: CHANNEL_ENTRY(
    { en: 'Discord', zh: 'Discord' },
    { en: 'Alerts in a Discord channel', zh: '在 Discord 频道里接收提醒' },
    'discord', 'other',
  ),
  slack: CHANNEL_ENTRY(
    { en: 'Slack', zh: 'Slack' },
    { en: 'Alerts in a Slack channel', zh: '在 Slack 频道里接收提醒' },
    'slack', 'other',
  ),
  teams: CHANNEL_ENTRY(
    { en: 'Microsoft Teams', zh: 'Microsoft Teams' },
    { en: 'Alerts in a Teams channel', zh: '在 Teams 频道里接收提醒' },
    'teams', 'other',
  ),
  mattermost: CHANNEL_ENTRY(
    { en: 'Mattermost', zh: 'Mattermost' },
    { en: 'Alerts in a Mattermost channel', zh: '在 Mattermost 频道里接收提醒' },
    'mattermost', 'other',
  ),
  gchat: CHANNEL_ENTRY(
    { en: 'Google Chat', zh: 'Google Chat' },
    { en: 'Alerts in a Google Chat space', zh: '在 Google Chat 里接收提醒' },
    'gchat', 'other',
  ),
  'wps-bot': CHANNEL_ENTRY(
    { en: 'WPS bot', zh: 'WPS 机器人' },
    { en: 'Alerts inside WPS', zh: '在 WPS 里接收提醒' },
    'wps', 'other',
  ),
  xizhi: CHANNEL_ENTRY(
    { en: 'Xizhi', zh: '息知' },
    { en: 'Alerts to WeChat', zh: '推送到微信' },
    'xizhi', 'other',
  ),
  desktop: CHANNEL_ENTRY(
    { en: 'Desktop', zh: '桌面提醒' },
    { en: 'A pop-up on this computer', zh: '在这台电脑上弹出提醒' },
    'desktop', 'other',
  ),
  webhook: CHANNEL_ENTRY(
    { en: 'Custom address', zh: '自定义地址' },
    { en: 'Send events to your own service', zh: '把事件发到你自己的服务' },
    'custom', 'other',
  ),
})

/** 未知渠道的兜底：用 type 作名字，绝不编造用途（只给通用一句）。 */
function fallbackEntry(type) {
  const name = String(type ?? '')
  return {
    name: { en: name, zh: name },
    usage: { en: 'Alerts from this channel', zh: '通过这个渠道接收提醒' },
    brand: 'generic',
    group: 'other',
  }
}

/** type → 目录项（未知 type 返回兜底，绝不抛）。 */
export function channelEntryOf(type) {
  const key = String(type ?? '')
  return Object.prototype.hasOwnProperty.call(CHANNEL_CATALOG, key)
    ? CHANNEL_CATALOG[key]
    : fallbackEntry(key)
}

/** 渠道用户可见名（品牌名，不是内部 type）。 */
export function channelNameOf(type, lang = 'zh') {
  return pick(channelEntryOf(type).name, lang)
}

/** 渠道一句用途（picker 用）。 */
export function channelUsageOf(type, lang = 'zh') {
  return pick(channelEntryOf(type).usage, lang)
}

/** 渠道品牌标识键（渲染真实 Logo 用）。 */
export function channelBrandOf(type) {
  return String(channelEntryOf(type).brand ?? 'generic')
}

/** 渠道分组：common（常用）/ other（其他通知方式）。 */
export function channelGroupOf(type) {
  return channelEntryOf(type).group === 'common' ? 'common' : 'other'
}

/** 平台官方字段名（允许出现，且必须同时有 desc 人话）。 */
const FIELD_LABELS = Object.freeze({
  appId: { en: 'App ID', zh: 'App ID' },
  appSecret: { en: 'App Secret', zh: 'App Secret' },
  appKey: { en: 'App Key', zh: 'App Key' },
  appToken: { en: 'App Token', zh: 'App Token' },
  botToken: { en: 'Bot Token', zh: 'Bot Token' },
  gatewayKey: { en: 'Gateway key', zh: '网关密钥' },
  apiBase: { en: 'Server address', zh: '服务地址' },
  chatId: { en: 'Recipient ID', zh: '接收者 ID' },
  accountId: { en: 'Account name', zh: '账号名' },
  corpId: { en: 'CorpID', zh: 'CorpID' },
  agentId: { en: 'AgentId', zh: 'AgentId' },
  key: { en: 'Device key', zh: '设备密钥' },
  barkUrl: { en: 'Server address', zh: '服务地址' },
  device: { en: 'Device name', zh: '设备名' },
})

/**
 * 字段键 → 用户可见短标签。已知平台字段走官方名；未知键按 camelCase 拆词，
 * 绝不把原始键原样塞给用户（`botToken` 不是用户词）。
 */
export function fieldLabel(key) {
  const name = String(key ?? '')
  if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, name)) return FIELD_LABELS[name]
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return { en: name, zh: name }
  const text = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
  return { en: text, zh: text }
}
