# 微信 iLink Bot 协议预审（2026-08-27）

官方公开文档不足，以下协议字段来自仓库现有实现注释及活跃开源实现交叉线索，均不得视为微信官方保证。未有可复核官方页面的项目标 `declared`，需真实设备验证后才能升级。

## 来源与证据

- 社区实现：[OpenClaw repository](https://github.com/openclaw/openclaw)（页面标题“openclaw”，查询 2026-08-27；用途：交叉核对 `get_updates_buf`、`sendmessage` 与 QR 状态命名；仓库滚动分支，commit 未固定，证据等级 `declared`）。
- 社区协议讨论：[wechatbot.dev](https://wechatbot.dev/)（标题“WeChat Bot”，查询 2026-08-27；站点当日无法稳定抓取，不能作为单独事实依据）。
- 本仓库移植注释：`src/inbound/_ilink-api.mjs`（来源标注 Hermes `weixin.py` 与 openclaw-weixin；查询 2026-08-27；摘录：“getupdates 长轮询 35s 挂起”“ret/errcode=-14 会话过期”“-2 + unknown error 实为 stale context_token”）。这是实现线索，不是官方承诺。

## 鉴权/登录（declared）

- QR-first 流程：GET `/ilink/bot/get_bot_qrcode?bot_type=3`，轮询 GET `/ilink/bot/get_qrcode_status?qrcode=<opaque>`；状态 `wait|scaned|scaned_but_redirect|expired|confirmed`。confirmed 负载可能包含 `ilink_user_id`、`bot_token`、`baseurl`；任何未知状态都要求重新扫码。
- API POST 头由现有实现固定：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`（登录前省略）、`X-WECHAT-UIN`（每请求随机 base64 uint32）、`iLink-App-Id: bot`、`iLink-App-ClientVersion: 0x020200`；body 自动附加 `base_info.channel_version: "2.2.0"`。这些字段仅有社区/逆向证据，必须保守处理并禁止日志泄露 token。

## 入站与出站形状（declared）

- 长轮询 POST `/ilink/bot/getupdates`，body `{get_updates_buf}`；响应 `{ret,errcode,msgs:[...],get_updates_buf}`。每条消息常见 `from_user_id`,`message_id`/`client_id`,`context_token`,`item_list`；文本 item `{type:1,text_item:{text}}`；图片 item `{type:2,image_item:{media_id,...}}`。未知字段不得进入 Control Core。
- 文本发送 POST `/ilink/bot/sendmessage`，body `msg`：`from_user_id:""`, `to_user_id`, `client_id`, `message_type:2`, `message_state:2`, `item_list:[{type:1,text_item:{text}}]`，按入站上下文回显 `context_token`。发送成功仅代表 API 接受，不代表用户看到。
- iLink 图片收发、文件/卡片、消息撤回均无可确认官方限制，能力 `declared`；当前 provider 仅结构化图片 envelope + 可选 media bridge，失败必须保留文本路径。

## 错误、重试、重复与会话

- `ret/errcode=-14`：会话过期，清理账号 cursor/context 并进入 `qr-required`；`-2 + errmsg="unknown error"`：按 stale context 处理并要求重新登录；其它 `-2`：限流，退避重试；未知错误不得自动批准或丢弃消息。
- 长轮询约 35 秒；超时视为空批次并原样保留 cursor。游标仅在整批消息交付成功后推进（at-least-once）；重复 `message_id` 由 inbound bus 去重，控制命令不得重复执行。
- `context_token` 必须长度/字符白名单校验并按账号命名空间保存；缺失或过期 token 时文本发送可失败，应回退桌面，不跨用户/账号复用。

## 能力分级与实现映射

`src/channels/wechat-ilink/protocol.mjs`：QR/cursor/context/image 归一化；`legacy-core.mjs`：轮询、重连、账号状态；`index.mjs`：provider facade。测试：`test/channels/wechat-ilink.test.mjs`, `test/inbound.wechat.test.mjs`。当前能力：文本、QR、重连、去重、账号隔离 `contract-tested`；`imageSend/fileSend/card/revoke/realDeviceVerified=declared`。

| 协议事实 | 待实现 seam | 禁止事项 |
|---|---|---|
| QR 状态/节点切换 | 真机扫码、过期与 redirect 验证 | 把未知状态当 confirmed |
| 35s long-poll/cursor | 真实断线与批次重放 | 先推进 cursor 再交付 |
| context_token 错误 | 真实 stale/限流区分 | 跨账号复用 token |
| 图片/文件结构 | 官方 schema 或设备抓包 | 猜字段、把 declared 标正式 |

验收：`node --test test/channels/wechat-ilink.test.mjs test/inbound.wechat.test.mjs`; `npm test`。必须另行记录真实设备 gap；在证据补齐前保持 fail-closed 与文本 fallback。
