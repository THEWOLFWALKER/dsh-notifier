# Telegram Bot API protocol preflight (2026-08-27)

来源：Telegram 官方 [Bot API](https://core.telegram.org/bots/api)，页面标题“Telegram Bot API”，查询 2026-08-27；页面变更记录显示 Bot API 10.2（2026-07-14）。

外链证据登记（均查询 2026-08-27，适用 Bot API 10.2）：

| URL | 页面标题 | 证据摘录/限制 |
|---|---|---|
| https://core.telegram.org/bots/api#receiving-updates | Receiving updates（Bot API） | `getUpdates` 与 webhook 互斥；updates 最多保留 24h；`update_id` 用于去重/排序 |
| https://core.telegram.org/bots/api#setwebhook | setWebhook（Bot API） | `secret_token` 会带 `X-Telegram-Bot-Api-Secret-Token` 请求头 |
| https://core.telegram.org/bots/api#sendmessage | sendMessage（Bot API） | text 1–4096 字符（实体解析后）；`disable_notification` 静默 |
| https://core.telegram.org/bots/api#inlinekeyboardbutton | InlineKeyboardButton（Bot API） | `callback_data` 1–64 bytes |
| https://core.telegram.org/bots/api#answercallbackquery | answerCallbackQuery（Bot API） | 必须响应 callback query 以消除客户端进度条；text 0–200 字符 |
| https://core.telegram.org/bots/api#deletemessage | deleteMessage（Bot API） | 通常仅可删除 48 小时内消息，权限依聊天类型 |

## 鉴权、入站与来源校验（documented）

- Bot token 由 BotFather 生成；REST URL 形如 `https://api.telegram.org/bot<TOKEN>/METHOD`. Token 仅放服务端 URL，绝不回显。
- `getUpdates`（long polling）与 webhook 互斥；Telegram 仅保留未取 updates 最多 24 小时。每个 `Update` 含递增 `update_id`，可用于忽略重复/乱序。[官方摘录](https://core.telegram.org/bots/api#receiving-updates)：“two mutually exclusive ways…updates…will not be kept longer than 24 hours”“update_id…ignore repeated updates”。
- Update 白名单：`update_id` + 一个可选载荷（通常 `message` 或 `callback_query`）。消息身份来自 `message.from.id`，会话来源来自 `message.chat.id`；按钮回调来自 `callback_query.from.id`、`callback_query.message.chat.id`、`callback_query.data`。缺任一关键来源字段必须拒绝。
- Webhook 可设置 `secret_token`；Telegram 会发送 `X-Telegram-Bot-Api-Secret-Token`，服务端需常量时间比较并拒绝不匹配请求。[官方 `setWebhook`](https://core.telegram.org/bots/api#setwebhook)（查询 2026-08-27；摘录：“request will contain a header X-Telegram-Bot-Api-Secret-Token”）。

## 出站接口与限制（documented）

- `sendMessage` 必填 `chat_id`,`text`；`text` 为 1–4096 字符（实体解析后）；`disable_notification=true` 静默发送。当前适配器故意不设 `parse_mode`，避免 Markdown 解析失败。[官方 `sendmessage`](https://core.telegram.org/bots/api#sendmessage)（查询 2026-08-27；摘录：“1-4096 characters after entities parsing”“disable_notification…silently”）。
- Inline keyboard 的 `callback_data` 为 1–64 bytes（不是字符数）；超限必须退回纯文本编号，不得截断 token。[官方 `InlineKeyboardButton`](https://core.telegram.org/bots/api#inlinekeyboardbutton)（查询 2026-08-27；摘录：“callback_data…1-64 bytes”）。
- 文件发送使用 `sendDocument`/`sendPhoto` 等，需要 `file_id`、URL 或 multipart `InputFile`；本仓库文件能力仍 `declared`，未做真实设备验证。
- `deleteMessage` 限制：消息发送少于 48 小时可删；机器人可删自己发出的私聊/群消息，删除他人消息需相应管理员权限。[官方 `deleteMessage`](https://core.telegram.org/bots/api#deletemessage)（查询 2026-08-27；摘录：“less than 48 hours ago”“Bots can delete outgoing messages…”）。删除失败不得影响控制结算。

## 回调、重试、重复与超时

- 收到 `callback_query` 后必须调用 `answerCallbackQuery`，否则客户端持续显示进度条；可不带 text。通知文本上限 0–200 字符。[官方 `answerCallbackQuery`](https://core.telegram.org/bots/api#answercallbackquery)（查询 2026-08-27；摘录：“necessary to react by calling answerCallbackQuery”）。
- HTTP `429` 返回 `parameters.retry_after` 秒；遵循该值并加小抖动，禁止立即热循环。网络超时可按现有 level 重试；成功响应后不重复发送。
- Update 去重键为 `update_id`；callback token 是单次 HMAC 且绑定 `(channel,accountId,userId,chatId)`。缺 `message.chat.id`（例如内联回调/已删除消息）时，对带来源记录的 token fail-closed。
- Telegram 不保证消息文本/键盘跨客户端完全一致；未知 Update 字段忽略，不得猜测为控制动作。

## 能力分级与映射

`src/channels/telegram/index.mjs` 已标 `commands/inlineButtons/messageEdit/textFallback/callbackChatBinding/reconnect=contract-tested`；`fileSend=declared`，`realDeviceVerified=false`。旧 transport 在 `src/inbound/telegram-bot.mjs`；出站在 `src/adapters/telegram.mjs`；测试 `test/channels/telegram.test.mjs`, `test/adapters.test.mjs`, `test/inbound.telegram.test.mjs`。

| 事实 | 待实现 seam | 禁止事项 |
|---|---|---|
| 4096 字符/64-byte callback | UTF-16/UTF-8 边界与真实 API 验证 | 截断 callback token |
| webhook secret header | 配置入口与常量时间校验 | 把 bot token 当 accountId |
| 429 retry_after/24h retention | 长轮询断线与真实 429 测试 | 无限重试、跨 chat 回放 |
| deleteMessage 48h/权限 | 删除失败可见性 | 把删除成功当作送达证明 |

验收：`node --test test/channels/telegram.test.mjs test/inbound.telegram.test.mjs test/adapters.test.mjs`; `npm test`。真实 Telegram webhook/429/文件上传仍待设备验证。
