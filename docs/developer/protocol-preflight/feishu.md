# 飞书开放平台（Lark）协议预审（2026-08-27）

官方入口：[事件订阅请求](https://open.feishu.cn/document/server-docs/event-subscription/event-subscription-request)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message-reply/create)。查询日期 2026-08-27；页面为动态文档，抓取仅能确认页面标题/路径，以下未能从页面稳定复核的数字限制均标 `declared`，不得据此放宽护栏。

外链证据登记（查询 2026-08-27；适用版本以飞书开放平台当前文档为准）：

| URL | 页面标题 | 证据摘录/限制 |
|---|---|---|
| https://open.feishu.cn/document/server-docs/event-subscription/event-subscription-request | 事件订阅请求 | 动态页面可确认事件订阅入口；challenge/签名/加密字段待租户实测，故相关限制 `declared` |
| https://open.feishu.cn/document/server-docs/im-v1/message/create | 发送消息 | IM v1 create message 端点；msg_type/content/receive_id_type 需按当前 schema，长度未稳定抓取，`declared` |
| https://open.feishu.cn/document/server-docs/im-v1/message-reply/create | 回复消息 | IM v1 reply 端点；权限与长度依租户，`declared` |

## 鉴权与登录

- 应用凭证是 `app_id`/`app_secret`；服务端通过 tenant access token（`POST /open-apis/auth/v3/tenant_access_token/internal`，JSON `app_id`,`app_secret`）换取 token，再以 `Authorization: Bearer <tenant_access_token>` 调用 IM API。凭证和 token 不进入日志、回调 envelope 或 admin 响应。
- 事件订阅支持长连接（SDK/WebSocket）或请求 URL。URL 验证请求包含 `challenge`；启用加密时需按 Encrypt Key 解密。HTTP 回调应校验飞书签名头 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature`（算法细节以官方事件订阅安全页为准）。本仓库当前 facade 使用既有 transport，签名/加密设备验证仍 `declared`。

证据：官方《事件订阅请求》（上述 URL，查询 2026-08-27；摘录可稳定确认标题与“事件订阅请求”路径；动态正文未能稳定导出）。因此实现只接受 transport 已验证的回调，不猜测任意 header 即可信。

## 入站事件与来源校验

- 典型事件 `im.message.receive_v1`：事件 envelope 含 `header.event_id`, `header.create_time`, `header.event_type`, `header.app_id`, `event.sender.sender_id.open_id`, `event.message.message_id`, `event.message.chat_id`, `event.message.chat_type`, `event.message.message_type`, `event.message.content`（content 通常是 JSON 字符串）。这些字段映射在 `src/inbound/feishu-bot.mjs`；缺 `open_id`、`chat_id` 或 action 时拒绝进入 Control Core。
- 卡片交互回调至少要求 `open_chat_id`（或 context.open_chat_id）、操作人 `operator.open_id`、`action.value.act`；`accountId` 只能来自已解析配置（appId/accountId），绝不使用事件自报字段。`src/channels/feishu/index.mjs` 的 `normalizeFeishuCallback` 已 contract-tested。
- 重复事件以 `header.event_id`/message_id 去重；unknown event_type、未知 action、缺来源字段均忽略并记录告警，不自动当作普通命令。

## 出站接口、卡片与文件

- 发送消息：`POST /open-apis/im/v1/messages?receive_id_type=<open_id|chat_id>`，Bearer tenant token；JSON `msg_type` 与 `content`（content 是 JSON 编码字符串）。回复使用 `/open-apis/im/v1/messages/{message_id}/reply`。卡片 `msg_type=interactive`，卡片 JSON 由官方 Card Kit 约束。
- 当前出站自定义机器人 webhook 使用 `POST https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，body `{msg_type:'interactive',card:{header,elements}}`；可选签名为 `timestamp`/`sign` 同 body。该形状由 `test/adapters.test.mjs` contract-tested。
- 文件上传/发送需要 tenant token、`/open-apis/im/v1/files` 等接口以及 `file_key`；本项目 `fileSend=declared`，未做真实设备或租户权限验证。卡片元素/文本长度和图片大小因租户与 Card Kit 版本而异，当前不宣称固定上限（`declared`）。

## 超时、重试、删除与降级

- API 返回 `code=0` 才视为成功；非零 code、HTTP 4xx/5xx、JSON malformed 均为失败。网络超时按现有 active/timeSensitive 重试策略，不能把“请求已发出”当送达。
- 飞书事件可能重试投递；必须以 event_id/message_id 去重，结算 token 仍 single-use + source-chat binding。回调 ACK/响应应尽快返回；超时重试不得重复执行控制命令。
- 消息删除/撤回接口及权限依租户角色；当前 facade 未实现删除能力，标 `declared`，不得把删除失败吞成成功。
- 卡片发送失败必须降级到纯文本编号；群聊/未知 chat 类型不得升级原生审批按钮。任何签名/解密不确定时 fail-closed。

## 能力分级与实现映射

`src/channels/feishu/index.mjs`：`websocket/richCards/cardUpdate/buttonCallbacks/sourceChatBinding/groupVisibility=contract-tested`；`fileSend=declared`，`realDeviceVerified=false`。旧 transport：`src/inbound/feishu-bot.mjs`；出站 webhook：`src/adapters/feishu.mjs`；测试：`test/channels/feishu.test.mjs`, `test/adapters.test.mjs`, `test/inbound.feishu.test.mjs`。

| 协议事实 | 待实现 seam | 禁止事项 |
|---|---|---|
| challenge/签名/加密 | 真实租户回调验证与重放窗口 | 未验签事件进入 Control Core |
| event_id/message_id 去重 | 跨进程去重与 ACK 重试实测 | 重复回调重复结算 |
| interactive card body | Card Kit 长度/版本矩阵 | 猜测未文档化字段 |
| 文件 API/权限 | file_key 上传下载真机验证 | 标记 fileSend 已支持 |

验收：`node --test test/channels/feishu.test.mjs test/inbound.feishu.test.mjs test/adapters.test.mjs`; `npm test`。真实飞书租户、签名、文件和卡片限制仍待验证。
