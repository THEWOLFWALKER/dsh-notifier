// dsh-notifier adapters/spec-channels.mjs
// 声明表：每渠道一段纯数据（8-15 行），由 _engine.mjs 消费产出 resolve/send。
// 维护性红线（ADAPTER.md）：spec 渠道禁止写控制流，超过两个 if 降级为代码适配器；
// 错误文案含「去哪里拿凭证」指引；消费 msg.level / msg.silent 落渠道原生分级语义。
//
// 来源标注（协议知识移植，axios.post → 零依赖 fetch，见 THIRD_PARTY_NOTICES.md）：
//  - discord / wecom / ntfy / onebot / pushdeer / xizhi / qmsg / igot：
//    CaoMeiYouRen/push-all-in-one（MIT）src/push/{discord,wechat-robot,ntfy,one-bot,push-deer,xi-zhi,qmsg,i-got}.ts
//  - slack / chanify / pushover / gchat：hclonely/all-pusher-api（Apache-2.0）src/{Slack,Chanify,Pushover,GoogleChat}.ts
//  - gotify / teams / mattermost：各官方文档公开协议（POST 固定 URL + JSON + 2xx 即成功）

import { NotifyError, ERROR_CODES } from './_shared.mjs'

/** 标题与正文以单换行拼接（大多数 IM 渠道惯例）。 */
const joinText = (msg) => (msg.title.length > 0 ? `${msg.title}\n${msg.content}` : msg.content)

/** 标题与正文以空行分段（markdown 渠道惯例）。 */
const joinPara = (msg) => (msg.title.length > 0 ? `${msg.title}\n\n${msg.content}` : msg.content)

/** ntfy 优先级映射：1-5，5=响铃+振动，4=高，3=默认，2=低（静默）。silent 覆盖为 2。 */
const NTFY_PRIORITY = { critical: 5, timeSensitive: 5, active: 4, passive: 3 }
const ntfyPriority = (msg) => (msg.silent === true ? 2 : NTFY_PRIORITY[msg.level] ?? 3)

/** gotify 优先级映射：>4 高优先（客户端响铃），3-4 默认，<3 低。 */
const GOTIFY_PRIORITY = { critical: 8, timeSensitive: 8, active: 5, passive: 3 }
const gotifyPriority = (msg) => (msg.silent === true ? 2 : GOTIFY_PRIORITY[msg.level] ?? 4)

const is2xx = ({ status }) => status >= 200 && status < 300

/** OneBot user_id/group_id 数字化（QQ 号是数字，字符串数字也要转 number 保持协议一致）。 */
const qqId = (value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : String(value ?? ''))

// ---- wps-bot webhook 归一助手（v0.13.1：webhookKey+webhookHost 合并为单个 webhook 字段）----

/** WPS 协作群机器人官方域名白名单（S-02）：经典 WOA 两家 + WPS 协作机器人页面实际下发域名。 */
const WPS_OFFICIAL_HOSTS = new Set(['woa.wps.cn', 'xz.wps.cn', '365.kdocs.cn'])
/** galaxy WOA 群机器人标准路径。 */
const WPS_WEBHOOK_PATH = '/api/v1/webhook/send'

/**
 * 旧 webhookHost 归一（存量迁移用）：origin / 机器人页面完整 URL / 裸域名三种形态统一为
 * origin+标准路径（query 一律丢弃）。非法/非白名单返回 null（调用方决定如何报错）。
 */
function normalizeWpsWebhookHost(raw) {
  let candidate = String(raw ?? '').trim()
  if (candidate === '') return null
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  let parsed = null
  try { parsed = new URL(candidate) } catch { parsed = null }
  if (parsed === null || !WPS_OFFICIAL_HOSTS.has(parsed.hostname)) return null
  const path = parsed.pathname.includes(WPS_WEBHOOK_PATH)
    ? parsed.pathname.replace(/\/+$/, '')
    : WPS_WEBHOOK_PATH
  return `${parsed.origin}${path}`
}

/**
 * 新 webhook 字段归一：完整地址必须含 ?key=（key 即全部认证），域名白名单三家，
 * 统一为 origin+标准路径+?key=<urlencoded>（其余 query 丢弃，防旧 key 残留）。
 */
function normalizeWpsWebhook(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') {
    throw new NotifyError('wps-bot 未配置：webhook（群机器人完整 webhook 地址，含 ?key=）未填写——在 WPS 协作群添加群机器人后复制', ERROR_CODES.NOT_CONFIGURED)
  }
  let candidate = trimmed
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  let parsed = null
  try { parsed = new URL(candidate) } catch { parsed = null }
  if (parsed === null || !WPS_OFFICIAL_HOSTS.has(parsed.hostname)) {
    throw new NotifyError('wps-bot 未配置：webhook 只允许 WPS 官方域名 woa.wps.cn / xz.wps.cn / 365.kdocs.cn（直接粘贴机器人页面的完整 webhook 地址，含 ?key=）', ERROR_CODES.NOT_CONFIGURED)
  }
  const key = (parsed.searchParams.get('key') ?? '').trim()
  if (key === '') {
    throw new NotifyError('wps-bot 未配置：webhook 缺少 ?key=——在 WPS 协作群添加群机器人后复制完整地址，?key= 后面的 32 位 key 即认证凭证', ERROR_CODES.NOT_CONFIGURED)
  }
  const path = parsed.pathname.includes(WPS_WEBHOOK_PATH)
    ? parsed.pathname.replace(/\/+$/, '')
    : WPS_WEBHOOK_PATH
  return `${parsed.origin}${path}?key=${encodeURIComponent(key)}`
}

export const SPEC_CHANNELS = {
  // ---- IM webhook 型（URL 即凭证）----

  slack: {
    label: 'Slack',
    desc: 'Slack Incoming Webhook',
    ssrfGuard: true, // S-02：webhook 地址用户可配
    fields: {
      webhook: { required: true, secret: true, desc: 'Slack Incoming Webhook 完整地址：api.slack.com/apps → 你的 App → Incoming Webhooks → 添加到工作区后复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({ url: cfg.webhook, body: { text: joinPara(msg) } }),
    ok: ({ status }) => status === 200, // Slack 成功只回 200 纯文本 "ok"，无业务码
    fail: ({ status, text }) => (status === 403 ? 'webhook 无效或已失效（403）：到 Slack App → Incoming Webhooks 重新复制地址' : text.slice(0, 120)),
    // 边界显式报错（G-38）：Incoming Webhook 官方域名只有 hooks.slack.com——
    // 填成普通 chat.postMessage API 地址（或别的站）会 404/静默失败，校验给出定向指引。
    validate: (resolved) => {
      let host = ''
      try { host = new URL(resolved.webhook).hostname } catch { host = '' }
      if (host !== 'hooks.slack.com') {
        throw new NotifyError('slack 未配置：webhook 必须是 https://hooks.slack.com/services/ 开头的 Incoming Webhook 地址（API token 不走本渠道）', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },

  discord: {
    label: 'Discord',
    desc: 'Discord Webhook',
    ssrfGuard: true, // S-02：webhook 地址用户可配
    fields: {
      webhook: { required: true, secret: true, desc: 'Discord Webhook 完整地址：服务器设置 → 整合 → Webhook → 新建后复制' },
    },
    encode: 'json',
    // G-39：Discord content 硬上限 2000 字符——超限发送只回一句 400[Bulk edit]，
    // 建连前 fail-fast 给出当前长度，比远程报错可诊断。（单 if，不违声明表控制流军规）
    request: (cfg, msg) => {
      const content = joinText(msg)
      if (content.length > 2000) {
        throw new NotifyError(`discord 推送失败：内容超过 Discord 上限 2000 字符（当前 ${content.length}），请缩短正文`, ERROR_CODES.API_ERROR)
      }
      return { url: cfg.webhook, body: { content } }
    },
    ok: is2xx, // 成功回 204 No Content，无业务码
    fail: ({ status }) => (status === 404 ? 'webhook 已删除（404）：到 Discord 服务器设置重新创建 Webhook' : ''),
  },

  wecom: {
    label: '企业微信群机器人',
    desc: 'WeCom group robot webhook',
    ssrfGuard: true, // S-02：webhook 整地址用户可配（key 模式拼官方域名也会被同一闸校验，官方域名公网放行无副作用）
    fields: {
      webhook: { secret: true, desc: '机器人完整 webhook 地址（与 key 二选一）：企业微信群 → 群设置 → 添加群机器人 → 复制 webhook' },
      key: { secret: true, desc: '机器人 key（webhook 地址 ?key= 后面的部分，与 webhook 二选一）' },
    },
    encode: 'json',
    request: (cfg, msg) => ({
      url: cfg.webhook !== '' ? cfg.webhook : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(cfg.key)}`,
      body: { msgtype: 'markdown', markdown: { content: joinPara(msg) } },
    }),
    ok: ({ json }) => json?.errcode === 0,
    fail: ({ json }) => (json?.errcode === 93100 ? '机器人不可用（93100）：企业微信管理后台确认群机器人未被停用' : json?.errmsg),
    validate: (resolved) => {
      if (resolved.webhook === '' && resolved.key === '') {
        throw new NotifyError('wecom 未配置：webhook 与 key 必须填一个', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },

  mattermost: {
    label: 'Mattermost',
    desc: 'Mattermost incoming webhook',
    ssrfGuard: true, // S-02：server/webhook 均用户可配；内网 Mattermost 需 allowPrivateNetwork: true
    fields: {
      server: { desc: 'Mattermost 服务器地址（与 webhook 二选一时给全地址可省略），如 https://mm.example.com' },
      hookId: { secret: true, desc: 'Incoming Webhook 的 id：Mattermost → 集成 → Incoming Webhook 复制地址末段' },
      webhook: { secret: true, desc: 'Incoming Webhook 完整地址（与 server+hookId 二选一）' },
    },
    encode: 'json',
    // v0.6.5（审查 R4-3-P2-1）：删除 'https://mattermost.com' 缺省——Mattermost 无官方
    // 公共推送云，该缺省会把 hookId（凭证）误发到官网域名（第三方日志），且必 404。
    request: (cfg, msg) => ({
      url: cfg.webhook !== '' ? cfg.webhook : `${String(cfg.server).replace(/\/+$/, '')}/hooks/${encodeURIComponent(cfg.hookId)}`,
      body: { text: joinPara(msg) },
    }),
    ok: is2xx, // 成功回 200 纯文本 "ok"
    validate: (resolved) => {
      if (resolved.webhook === '' && resolved.hookId === '') {
        throw new NotifyError('mattermost 未配置：webhook 与 server+hookId 必须填一组', ERROR_CODES.NOT_CONFIGURED)
      }
      if (resolved.webhook === '' && resolved.server === '') {
        throw new NotifyError('mattermost 未配置：用 hookId 时必须同时填 server（自托管地址，如 https://mm.example.com）', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },

  gchat: {
    label: 'Google Chat',
    desc: 'Google Chat webhook (spaces)',
    ssrfGuard: true, // S-02：webhook 地址用户可配
    fields: {
      webhook: { required: true, secret: true, desc: 'Google Chat 空间 Incoming Webhook：空间名旁 ▾ → 应用和集成 → Webhook → 复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({ url: cfg.webhook, body: { text: joinText(msg) } }),
    ok: is2xx, // 成功回 200 JSON（含 space 信息），无业务码
  },

  teams: {
    label: 'Microsoft Teams',
    desc: 'Teams Workflows Incoming Webhook (Adaptive Card)',
    ssrfGuard: true, // S-02：webhook 地址用户可配
    fields: {
      webhook: { required: true, secret: true, desc: 'Teams Workflows Incoming Webhook URL：团队频道 → 管理 → 连接器/工作流 → 「将 webhook 请求发布到频道」创建后复制' },
    },
    encode: 'json',
    // Teams 只吃 Adaptive Card：文本块包一层 card（官方协议，非简化）。
    request: (cfg, msg) => ({
      url: cfg.webhook,
      body: {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              ...(msg.title.length > 0 ? [{ type: 'TextBlock', text: msg.title, weight: 'Bolder', wrap: true }] : []),
              { type: 'TextBlock', text: msg.content, wrap: true },
            ],
          },
        }],
      },
    }),
    ok: is2xx, // 成功回 200 纯文本 "1"
  },

  // ---- 消费级推送 App（直达手机）----

  ntfy: {
    label: 'ntfy',
    desc: 'ntfy push (public/self-hosted, topic)',
    ssrfGuard: true, // S-02：server 用户可配；内网自托管 ntfy 需 allowPrivateNetwork: true
    fields: {
      server: { default: 'https://ntfy.sh', desc: 'ntfy 服务器地址，默认公共站 ntfy.sh，自托管填自己的地址' },
      topic: { required: true, desc: '订阅 topic 名（手机 App 里订阅同名 topic 即可收到；自建服务器建议配 auth）' },
      auth: { secret: true, desc: '可选鉴权头原值，如 "Basic dXNlcjpwYXNz" 或 "Bearer tk_..."（自托管保护 topic 时用）' },
    },
    // v0.6.5（审查 R4-3-P1-1）：从「POST /<topic> + X-Title/X-Priority 头」改为 ntfy
    // 官方 JSON 发布协议（POST 服务根，topic/title/message/priority 全进 body）。
    // 原头协议的 x-title 经 undici fetch 的 ByteString 校验：非 ASCII 标题（中文！）
    // 直接抛 TypeError——中文标题通知 100% 失败，而 mock fetch 不构造真实 Headers，
    // 契约测试假绿掩盖了运行时必然故障（本项目主场景全是中文标题）。
    encode: 'json',
    request: (cfg, msg) => ({
      url: `${(cfg.server || 'https://ntfy.sh').replace(/\/+$/, '')}`,
      headers: { ...(cfg.auth !== '' ? { authorization: cfg.auth } : {}) },
      body: {
        topic: cfg.topic,
        ...(msg.title.length > 0 ? { title: msg.title } : {}),
        message: msg.content,
        priority: ntfyPriority(msg),
      },
    }),
    ok: is2xx,
    fail: ({ json }) => json?.error ?? json?.http_error,
  },

  gotify: {
    label: 'Gotify',
    desc: 'Gotify push (self-hosted, app token)',
    ssrfGuard: true, // S-02：server 用户可配；内网自托管 Gotify 需 allowPrivateNetwork: true
    fields: {
      server: { required: true, desc: 'Gotify 服务器地址，如 https://gotify.example.com（自托管，官方演示站 gotify.net 亦可）' },
      appToken: { required: true, secret: true, desc: '应用 token：Gotify Web → APPS → CREATE APPLICATION 后复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({
      url: `${cfg.server.replace(/\/+$/, '')}/message`,
      headers: { 'x-gotify-key': cfg.appToken },
      body: { title: msg.title, message: msg.content, priority: gotifyPriority(msg) },
    }),
    ok: is2xx, // 成功回 200 JSON（含消息 id），无业务码
  },

  pushover: {
    label: 'Pushover',
    desc: 'Pushover push (paid iOS/Android app)',
    fields: {
      token: { required: true, secret: true, desc: '应用 API token：pushover.net → Your Applications → Create 复制' },
      user: { required: true, secret: true, desc: '用户/群组 key：pushover.net 首页右上角复制（发送到群组则填群组 key）' },
    },
    encode: 'form',
    timeoutMs: 15000,
    request: (cfg, msg) => ({
      url: 'https://api.pushover.net/1/messages.json',
      body: {
        token: cfg.token,
        user: cfg.user,
        title: msg.title,
        message: msg.content,
        ...(msg.silent !== true && msg.level === 'timeSensitive' ? { sound: 'siren' } : {}),
      },
    }),
    ok: ({ json }) => json?.status === 1,
    fail: ({ json }) => (Array.isArray(json?.errors) ? json.errors.join('; ') : json?.errors),
  },

  chanify: {
    label: 'Chanify',
    desc: 'Chanify push (iOS)',
    ssrfGuard: true, // S-02：baseUrl 用户可配
    fields: {
      baseUrl: { default: 'https://api.chanify.net/v1/sender', desc: 'Chanify 服务地址，默认公共服务，自托管填自己的' },
      token: { required: true, secret: true, desc: '设备 token：Chanify iOS App → 通道 → 复制 Send Token' },
    },
    encode: 'form',
    // v0.6.5（审查 R4-3-P1-2）：去掉多拼的 /send 段。官方端点是
    // POST https://api.chanify.net/v1/sender/<token>（dev.chanify.net；移植来源
    // all-pusher-api 的 Chanify.ts 同样无 /send），原拼法真机必 404。
    request: (cfg, msg) => ({
      url: `${(cfg.baseUrl || 'https://api.chanify.net/v1/sender').replace(/\/+$/, '')}/${encodeURIComponent(cfg.token)}`,
      body: { title: msg.title, text: msg.content },
    }),
    ok: is2xx,
  },

  pushdeer: {
    label: 'PushDeer',
    desc: 'PushDeer push (iOS/macOS)',
    ssrfGuard: true, // S-02：endpoint 用户可配；自建服务在内网时需 allowPrivateNetwork: true
    fields: {
      pushKey: { required: true, secret: true, desc: 'PushKey：PushDeer App → Key 页复制（自建服务配合 endpoint 使用）' },
      endpoint: { default: 'https://api2.pushdeer.com', desc: '服务地址，默认官方，自建填自己的' },
    },
    encode: 'form',
    request: (cfg, msg) => ({
      url: `${(cfg.endpoint || 'https://api2.pushdeer.com').replace(/\/+$/, '')}/message/push`,
      body: { pushkey: cfg.pushKey, text: msg.title, desp: msg.content, type: 'markdown' },
    }),
    ok: ({ json }) => json?.code === 0,
    fail: ({ json }) => json?.error,
  },

  xizhi: {
    label: '息知',
    desc: 'XiZhi push (WeChat)',
    fields: {
      key: { required: true, secret: true, desc: '息知 key：xizhi.qqoq.net 微信扫码登录后复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({
      url: `https://xizhi.qqoq.net/${encodeURIComponent(cfg.key)}.send`,
      body: { title: msg.title, content: msg.content },
    }),
    ok: ({ json }) => json?.code === 200, // 注意：息知成功值是 200 不是 0
    fail: ({ json }) => json?.msg,
  },

  qmsg: {
    label: 'Qmsg酱',
    desc: 'Qmsg push (QQ)',
    fields: {
      key: { required: true, secret: true, desc: 'Qmsg key：qmsg.zendee.cn QQ 登录后复制' },
      qq: { required: true, desc: '接收消息的 QQ 号（群推送填群号并设 type: group），多个用英文逗号分隔' },
      type: { default: 'send', desc: 'send=私聊（默认）/ group=群聊' },
      bot: { desc: '指定发消息的机器人 QQ（可选，仅私有部署有效）' },
    },
    encode: 'form',
    request: (cfg, msg) => ({
      url: `https://qmsg.zendee.cn/${cfg.type || 'send'}/${encodeURIComponent(cfg.key)}`,
      body: { msg: joinText(msg), qq: cfg.qq, ...(cfg.bot !== '' ? { bot: cfg.bot } : {}) },
    }),
    // Qmsg 的 code 字段不可靠，官方建议以 success 字段判定。
    ok: ({ json }) => json?.success === true,
    fail: ({ json }) => json?.reason,
    // v0.6.5（审查 R4-3-P3-1）：type 是 URL 路径段，白名单防拼错路径静默 404。
    validate: (resolved) => {
      if (resolved.type !== 'send' && resolved.type !== 'group') {
        throw new NotifyError('qmsg 未配置：type 只能是 send（私聊）或 group（群聊）', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },

  igot: {
    label: 'iGot',
    desc: 'iGot push (iOS)',
    fields: {
      key: { required: true, secret: true, desc: 'iGot key：push.hellyw.com 微信扫码获取' },
    },
    encode: 'json',
    request: (cfg, msg) => ({
      url: `https://push.hellyw.com/${encodeURIComponent(cfg.key)}`,
      body: { title: msg.title, content: msg.content, automaticallyCopy: 0 },
    }),
    ok: ({ json }) => json?.ret === 0,
    fail: ({ json }) => json?.errMsg,
  },

  // ---- QQ OneBot 11（NapCat / LLOneBot 自托管）----

  onebot: {
    label: 'QQ OneBot 11',
    desc: 'OneBot v11 HTTP (NapCat/LLOneBot self-hosted)',
    // S-02：baseUrl 用户可配，但渠道本质是本机/内网服务（文档默认即 http://127.0.0.1:3000，
    // NapCat/LLOneBot 跑在同一台机器）——默认放行私网，否则开箱即用被 SSRF 闸打断。
    ssrfGuard: 'private-ok',
    fields: {
      baseUrl: { required: true, desc: 'OneBot 实现（NapCat/LLOneBot/go-cqhttp）的 HTTP 服务地址，如 http://127.0.0.1:3000' },
      accessToken: { secret: true, desc: '可选 access token（OneBot 配置里设置的鉴权 token）' },
      messageType: { default: 'private', desc: 'private=私聊（默认）/ group=群聊' },
      // type:'number'：QQ 号在 YAML/JSON 里数字与字符串两形态都常见，engine 双形态归一
      userId: { desc: '私聊目标 QQ 号（messageType: private 时必填）', type: 'number' },
      groupId: { desc: '群号（messageType: group 时必填）', type: 'number' },
    },
    encode: 'json',
    // v0.6.5（审查 R4-3-P2-3）：message 改用 OneBot 11 标准消息数组格式。原字符串直传
    // 时正文里的 [CQ:at,qq=all] / [CQ:image,file=http://...] 是协议元语法——notify 的
    // message 参数 agent/LLM 可控，prompt injection 可借通知渠道向 QQ 群注入 @全体
    // 或让受害者客户端向任意 URL 发起 GET。数组格式的 text 段无解析歧义，纯文本永远纯文本。
    request: (cfg, msg) => ({
      url: `${cfg.baseUrl.replace(/\/+$/, '')}/send_msg`,
      headers: cfg.accessToken !== '' ? { authorization: `Bearer ${cfg.accessToken}` } : {},
      body: {
        message_type: cfg.messageType || 'private',
        message: [{ type: 'text', data: { text: joinText(msg) } }],
        ...(cfg.messageType === 'group' ? { group_id: qqId(cfg.groupId) } : { user_id: qqId(cfg.userId) }),
      },
    }),
    ok: ({ json }) => json?.retcode === 0 && json?.status !== 'failed',
    fail: ({ json }) => (json?.retcode === 1404 ? 'OneBot 未实现该接口（1404）：确认 NapCat/LLOneBot 开启了 HTTP 服务与 send_msg' : json?.wording ?? json?.echo),
    validate: (resolved) => {
      // v0.6.5（审查 R4-3-P3-1）：messageType 白名单，拼错值会打出语义漂移的请求。
      if (resolved.messageType !== 'private' && resolved.messageType !== 'group') {
        throw new NotifyError('onebot 未配置：messageType 只能是 private（私聊）或 group（群聊）', ERROR_CODES.NOT_CONFIGURED)
      }
      // 数值字段缺失落 undefined（非 ''），空值判定必须双形态
      if (resolved.messageType === 'group' && (resolved.groupId === '' || resolved.groupId === undefined)) {
        throw new NotifyError('onebot 未配置：messageType 为 group 时 groupId（群号）未填写', ERROR_CODES.NOT_CONFIGURED)
      }
      if (resolved.messageType !== 'group' && (resolved.userId === '' || resolved.userId === undefined)) {
        throw new NotifyError('onebot 未配置：私聊推送 userId（QQ 号）未填写', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },

  // ---- WPS 协作群机器人（WOA webhook，key 即凭证）----
  // 协议移植自 galaxy modules/woa/woa.go + modules/logs/logSystem.go 的
  // `https://<host>/api/v1/webhook/send?key=<32位hex>`：
  //  - key 就是全部认证：无 cookie / 无 OAuth / 无签名，key 泄露=可向该群冒发消息；
  //  - text 类型 body 用 {msgtype:'text', text:{content}}，markdown 用
  //    {msgtype:'markdown', markdown:{text}}（kit 差异，勿混用）；正文支持
  //    <at user_id="-1">所有人</at> / <at email="xxx@wps.cn">名字</at> 提及语法；
  //  - galaxy 只按 HTTP 状态判定成功（不解析业务码），这里沿用 is2xx。
  //  - 官方域名实证三处：woa.wps.cn / xz.wps.cn（经典 WOA，galaxy 与 openapi 文档口径）、
  //    365.kdocs.cn/woa（WPS 协作机器人页面实际下发的地址）——白名单三家全收。
  //  - 公司真实机器人 key 在 galaxy kms/constant/woa.go（WOA_KEY_*）——那是活跃凭证，
  //    不得外传/复用，用户须在协作群里自建机器人拿自己的 key。
  'wps-bot': {
    label: 'WPS 协作群机器人',
    desc: 'WPS collaboration group robot webhook (WOA)',
    ssrfGuard: true, // S-02：webhook 用户可配（仅放行官方三家域名，见 validate）
    // v0.13.1（用户拍板）：官方固定端点渠道，不暴露 timeoutMs/allowPrivateNetwork 引擎
    // 调优选项——cfg 里同名键一律忽略（引擎 fixedOptions 语义），管理台键白名单同步收窄。
    fixedOptions: true,
    docUrl: 'https://365.kdocs.cn/3rd/open/documents/app-integration-dev/guide/robot/webhook',
    fields: {
      webhook: { required: true, secret: true, desc: 'WPS 协作群机器人完整 webhook 地址（含 ?key=）：在 WPS 协作群添加群机器人后复制，形如 https://365.kdocs.cn/woa/api/v1/webhook/send?key=<32 位 key>' },
      msgtype: { default: 'text', plain: true, desc: '消息类型：text（默认，标题+正文）或 markdown（富文本）' },
    },
    encode: 'json',
    // v0.13.1 存量兼容：旧双字段 webhookKey+webhookHost（YAML/state.json 遗留）在字段提取
    // 前合成完整 webhook URL；新 webhook 字段已配置时旧字段一律忽略（新字段优先）。
    // 旧 webhookHost 非白名单/不可解析时原样透传——validate 给出「只允许」指引，不静默纠偏。
    preresolve: (cfg) => {
      const key = String(cfg?.webhookKey ?? '').trim()
      if (key === '' || String(cfg?.webhook ?? '').trim() !== '') return cfg
      const hostRaw = String(cfg?.webhookHost ?? '').trim()
      const fallback = 'https://woa.wps.cn'
      const host = normalizeWpsWebhookHost(hostRaw === '' ? fallback : hostRaw) ?? (hostRaw === '' ? fallback : hostRaw)
      return { ...cfg, webhook: `${host}?key=${encodeURIComponent(key)}` }
    },
    // 单个 msgtype 分支（不超两个 if 军规）。webhook 已由 validate 归一为
    // origin+标准路径+?key=，这里直接使用。
    request: (cfg, msg) => {
      const url = cfg.webhook
      if (cfg.msgtype === 'markdown') {
        return { url, body: { msgtype: 'markdown', markdown: { text: joinPara(msg) } } }
      }
      return { url, body: { msgtype: 'text', text: { content: joinText(msg) } } }
    },
    ok: is2xx, // galaxy 只按 HTTP 状态判定（2xx 即成功，不解析业务码）
    fail: ({ status }) => (status === 401 || status === 403 || status === 404
      ? 'webhook key 无效或群机器人已失效：请到 WPS 协作群重新添加机器人，复制新 webhook 地址更新 webhook 字段'
      : ''),
    validate: (resolved) => {
      if (resolved.msgtype !== 'text' && resolved.msgtype !== 'markdown') {
        throw new NotifyError('wps-bot 未配置：msgtype 只能是 text（默认）或 markdown', ERROR_CODES.NOT_CONFIGURED)
      }
      // 完整 webhook 地址归一并回写 resolved（send 收到同一对象）：域名白名单写死官方
      // 三家防 key 被打到任意 host（slack hooks.slack.com 同款先例）；key 必填即认证；
      // 其余 query 一律丢弃，防旧 key 残留。
      resolved.webhook = normalizeWpsWebhook(resolved.webhook)
    },
  },
}
