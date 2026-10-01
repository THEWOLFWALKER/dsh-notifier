# QQ Bot protocol preflight (2026-08-27)

证据等级：`documented` = QQ 官方页面明确写出；`contract-tested` = 本仓库已有测试锁定；`declared` = 尚无可核验协议/真机证据，实施必须保守降级。

外链证据登记（均查询 2026-08-27；页面更新日期以 QQ 官方页面为准）：

| URL | 页面标题 | 证据摘录/适用限制 |
|---|---|---|
| https://bot.q.qq.com/wiki/develop/api-v2/ | 启动接入 | AppID/AppSecret；旧 Token 鉴权废弃，改用 Access Token |
| https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html | 获取访问凭证 | POST 换 token；`expires_in` ≤7200 秒；Authorization `QQBot ACCESS_TOKEN` |
| https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html | WebSocket 方式 | 网关 HELLO/IDENTIFY/RESUME/HEARTBEAT 与事件订阅（协议细节以当前页为准） |
| https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html | 消息收发概述 | C2C/群/频道场景；msg_id+msg_seq 去重；富媒体 file_info 有 TTL；撤回通常 2 分钟内 |
| https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html | 单聊消息事件 | C2C_MESSAGE_CREATE 字段与官方 JSON 示例；重复 msg_id 需结合 msg_seq |
| https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html | 群@机器人消息 | GROUP_AT_MESSAGE_CREATE；content 自动去 @ 前缀；group_openid/member_openid 来源 |
| https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html | 发送单聊消息 | POST 路径、msg_type 0/2/7、被动回复 60 分钟/最多 4 次、键盘 label ≤10 字符 |
| https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html | 发送群聊消息 | POST 路径、被动回复 5 分钟/最多 5 次、群主动频控 |

## 鉴权与登录（documented）

- 官方“启动接入”说明 AppID/AppSecret，旧 Token 鉴权已废弃；使用 `access_token`，请求头格式 `Authorization: QQBot ACCESS_TOKEN`。[QQ 官方《启动接入》](https://bot.q.qq.com/wiki/develop/api-v2/)（查询 2026-08-27；摘录：“Token 的鉴权方式已废弃，请使用更安全的 Access Token 鉴权方式”）
- `POST https://api.bot.qq.com/app/getAppAccessToken`，JSON `{appId,clientSecret}`，返回 `access_token`,`expires_in`（当前 ≤7200 秒）；过期前约 60 秒刷新。[《获取访问凭证》](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)（查询 2026-08-27；摘录：“expires_in…目前是 7200 秒之内的值”“Authorization…QQBot ACCESS_TOKEN”）
- 网关通过 `GET /gateway`，Authorization 头同上；WS HELLO→IDENTIFY/RESUME→HEARTBEAT，DISPATCH 序号用于恢复（网关页见 [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)）。实现不得把 appSecret/token 写日志。

## 入站事件（documented）

### C2C_MESSAGE_CREATE

事件体白名单：`id`, `author.user_openid`, `content`, `message_type`, `message_scene.ext`, `attachments`, `timestamp`。官方示例为 JSON 文本消息；`msg_id` 可能重复，须结合 `msg_seq` 去重。[单聊事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)（查询 2026-08-27；摘录：“相同 msg_id 可能重复推送…结合 msg_seq 做去重”）。来源身份是 `author.user_openid`，不可从正文或扩展字段自报。

### GROUP_AT_MESSAGE_CREATE

白名单：`id`, `author.member_openid`, `group_openid`, `content`（官方已去掉 @ 前缀）, `message_type`, `message_scene.ext`, `attachments`, `mentions`, `timestamp`。[群@事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)（查询 2026-08-27；摘录：“content 字段已自动去除@机器人的前缀”）。本项目当前群控制路径必须保持 fail-closed；缺失 `chatType`/未知群来源不可升级为审批。

## 出站接口与限制（documented）

- C2C：`POST /v2/users/{user_openid}/messages`；群：`POST /v2/groups/{group_openid}/messages`。请求体支持 `msg_type=0` 文本（`content`）、`2` Markdown、`7` 富媒体（`media.file_info`），可带 `msg_id`/`event_id`（二选一）、`msg_seq`。相同 `msg_id+msg_seq` 重复发送失败。[C2C 发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[群发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)（查询 2026-08-27）。
- 被动回复窗口：C2C 60 分钟、每消息最多 4 次；群 5 分钟、最多 5 次。主动频控：C2C 未认证 5 qps/30 qpm，单关系 20 qpm；群未认证 30 qpm，单关系 20 qpm；接口总频率 100 qps。主动消息可能因用户关闭接收而失败，必须把失败报告给上层而非静默成功。
- 富媒体先上传得到短时效 `file_info`；单聊/群上传接口不互通。消息撤回：机器人自发消息超过 2 分钟不可撤回。[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)（查询 2026-08-27；摘录：“file_info 有时效性（ttl）”“相同 msg_id+msg_seq 重复发送会失败”“发送超过 2 分钟不可撤回”）。
- 键盘按钮：`keyboard.content.rows[].buttons[]`; `action.type=1` 回调且 `action.data` 必填；`render_data.label` 最多 10 字符。按钮/卡片能力仅本仓库 QQ C2C contract tests 覆盖，未做真机验证，群目标继续文本编号 fallback。

## 回调来源校验、重试与未知项

- `INTERACTION_CREATE` 需先 ACK（官方网关交互页；实现窗口按 3 秒处理），再交给 Control Core；回调必须同时匹配原始 channel/account/user/chat、单次 HMAC token 和 action key。缺字段、未知 action、错误来源、超时均拒绝且不消耗 token。
- 相同事件可能重复；网络/HTTP 5xx 可有限重试，4xx 鉴权/参数错误不可盲重试。发送文本成功后不得因 ACK 重试造成重复；用 `msg_seq` 单调递增并记录结果。
- `message_type` 3/101/102/103、附件下载鉴权、全量群消息 `GROUP_MESSAGE_CREATE` 的实际权限在当前运行时未完整实现，标记 `declared`；未知字段必须隔离，不得映射成控制命令。

## 现有实现映射与验收

| 协议事实 | 现有文件/测试 | 待实现 seam | 禁止事项 |
|---|---|---|---|
| token 交换/刷新 | `src/inbound/qq-gw.mjs`, `src/adapters/_tokens.mjs` | token TTL/网关恢复真机验证 | 日志泄露 appSecret/token |
| C2C/群事件 | `src/inbound/qq-gw.mjs`, `test/inbound.qq.test.mjs` | 完整官方 payload fixture、真实 WS | 缺来源字段时放行 |
| Markdown/键盘 | `src/inbound/qq-gw.mjs`, `test/approval.qq-buttons.test.mjs` | 3 秒 ACK 与按钮长度真机 | 群按钮替代文本 fallback |
| 去重/撤回/频控 | `src/inbound/bus.mjs`, `src/adapters/qq-bot.mjs` | 真实 rate-limit/撤回响应 | 重试导致双发 |

验收命令：`node --test test/inbound.qq.test.mjs test/approval.qq-buttons.test.mjs`; 全量 `npm test`；真实 HTTP/WS、长度与撤回仍需设备验证。
