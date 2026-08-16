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

export const SPEC_CHANNELS = {
  // ---- IM webhook 型（URL 即凭证）----

  slack: {
    label: 'Slack',
    desc: 'Slack Incoming Webhook',
    fields: {
      webhook: { required: true, secret: true, desc: 'Slack Incoming Webhook 完整地址：api.slack.com/apps → 你的 App → Incoming Webhooks → 添加到工作区后复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({ url: cfg.webhook, body: { text: joinPara(msg) } }),
    ok: ({ status }) => status === 200, // Slack 成功只回 200 纯文本 "ok"，无业务码
    fail: ({ status, text }) => (status === 403 ? 'webhook 无效或已失效（403）：到 Slack App → Incoming Webhooks 重新复制地址' : text.slice(0, 120)),
  },

  discord: {
    label: 'Discord',
    desc: 'Discord Webhook',
    fields: {
      webhook: { required: true, secret: true, desc: 'Discord Webhook 完整地址：服务器设置 → 整合 → Webhook → 新建后复制' },
    },
    encode: 'json',
    request: (cfg, msg) => ({ url: cfg.webhook, body: { content: joinText(msg) } }),
    ok: is2xx, // 成功回 204 No Content，无业务码
    fail: ({ status }) => (status === 404 ? 'webhook 已删除（404）：到 Discord 服务器设置重新创建 Webhook' : ''),
  },

  wecom: {
    label: '企业微信群机器人',
    desc: 'WeCom group robot webhook',
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
    fields: {
      baseUrl: { required: true, desc: 'OneBot 实现（NapCat/LLOneBot/go-cqhttp）的 HTTP 服务地址，如 http://127.0.0.1:3000' },
      accessToken: { secret: true, desc: '可选 access token（OneBot 配置里设置的鉴权 token）' },
      messageType: { default: 'private', desc: 'private=私聊（默认）/ group=群聊' },
      userId: { desc: '私聊目标 QQ 号（messageType: private 时必填）' },
      groupId: { desc: '群号（messageType: group 时必填）' },
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
      if (resolved.messageType === 'group' && resolved.groupId === '') {
        throw new NotifyError('onebot 未配置：messageType 为 group 时 groupId（群号）未填写', ERROR_CODES.NOT_CONFIGURED)
      }
      if (resolved.messageType !== 'group' && resolved.userId === '') {
        throw new NotifyError('onebot 未配置：私聊推送 userId（QQ 号）未填写', ERROR_CODES.NOT_CONFIGURED)
      }
    },
  },
}
