# 钉钉 Stream 协议预审（2026-08-28）

官方入口：[Stream 模式接入](https://open.dingtalk.com/document/orgapp/stream-mode-access)、[机器人接收消息](https://open.dingtalk.com/document/orgapp/receive-messages)。本批次（W1，分支 `codex/fix-dingtalk-stream-protocol`）仲裁源是 npm 包 `dingtalk-stream` 官方 SDK 三个版本的 `dist/client.mjs` 源码核对（2.1.4 / v2.1.6-beta.1 / v2.1.7-beta.1，本地解包核对于 2026-08-28）；**全部结论未经真机验证**。动态官方文档页面仅能确认入口路径，帧级字段以 SDK 源码为准；无法从源码稳定复核的行为均标 `declared`，不得据此放宽护栏。

外链与源码证据登记（SDK 解包核对 2026-08-28；版本号以 npm registry 为准）：

| 来源 | 位置 | 证据摘录/限制 |
|---|---|---|
| dingtalk-stream 2.1.4 `dist/client.mjs` | getEndpoint（约 107 行） | `ua: this.config.ua` —— 建连 body 字段名是 `ua` |
| dingtalk-stream v2.1.6-beta.1 `dist/client.mjs` | getEndpoint（约 111 行） | 同上，`ua: this.config.ua` |
| dingtalk-stream v2.1.7-beta.1 `dist/client.mjs` | getEndpoint（约 191 行） | 同上，`ua: this.config.ua` |
| dingtalk-stream 三版 `dist/client.mjs` | onEvent/sendEventAck | `messageId: message.headers.messageId`、`data: JSON.stringify(ackData)` |
| dingtalk-stream 三版 `dist/client.mjs` | onSystem `case "ping"` | `sendFrame(socket, { code: 200, headers: downstream.headers, message: "OK", data: downstream.data })` |
| https://open.dingtalk.com/document/orgapp/stream-mode-access | Stream 模式接入 | 动态页面可确认接入入口；endpoint/ticket/心跳细节未能稳定导出，`declared` |
| https://open.dingtalk.com/document/orgapp/receive-messages | 机器人接收消息 | 消息体字段（conversationId/msgId/senderStaffId/msgtype 等）以页面 schema 为准；richText 模块结构 `declared` |

## 鉴权与建连

- token：`GET {oapi}/gettoken?appkey=&appsecret=` → `{ errcode: 0, access_token, expires_in }`；access_token 供被动回复/主动推送等业务 API 用，网关打开接口本身不走它。
- 网关：`POST {api}/v1.0/gateway/connections/open`，`Content-Type`/`Accept` 均 `application/json`，body `{ clientId, clientSecret, subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }], ua }` → `{ endpoint, ticket }`。
- **字段名就是 `ua`（G-10）**：三版 SDK getEndpoint 全系 `ua: this.config.ua`。旧实现注释所称「官方 SDK 拼写错误字段名 `uesrAgent`、服务端认的就是它、照抄勿改」经三版源码核对**查无实据**，系以讹传讹，已删除——勿再改回。
- WS：`new WebSocket(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)`；连接由原生 WebSocket 建立，凭证（appSecret/ticket）不进日志与 envelope。

## 下行帧形状与 ack（G-01）

- 帧为 JSON 字符串 `{ specVersion, type, headers, data }`。**messageId 只存在于 `headers.messageId`，顶层无该字段**（SDK `invokeCallback` 取 `message.headers.messageId`，三版一致）——顶层 `messageId` 是陷阱字段，读了恒为空。
- `data` 本身又是 JSON 字符串，需二次 parse 才得到业务消息对象。
- ack 回执形状（三版 SDK sendEventAck 一致）：`{ code: 200, headers: { contentType: 'application/json', messageId: message.headers.messageId }, data: JSON.stringify(<值>) }`。本批次仲裁落定 `data: JSON.stringify('OK')`（即字符串 `"OK"`）。
- 旧实现三重偏差均已修正：读顶层 messageId（恒空→实际从不回执）、回执头字段名误作 `requestId`、data 误发裸字符串 `'ack'`（未 JSON 化）。
- SDK 回执帧另带顶层 `message: "OK"` 字符串字段（v2.1.7-beta.1 `dist/client.mjs` 537-547 行等）；本实现按仲裁形态不含该字段，服务端是否强依赖未经真机验证（`declared`）。
- 未 ack 的业务帧服务端约 60s 重推：以 msgId 去重（60s 窗口吸收 + 表上限淘汰），bus 侧 24h 持久去重再兜一层。
- ACK 语义保持“先回执、后交业务层”：已收到且形状可解析的业务帧先按 `headers.messageId` 回 ACK，随后业务处理失败不会要求平台重投；业务层用 `msgId`/bus 去重保护重复帧。`data` 二次 JSON 解析失败会明确告警，因为 ACK 后该帧不会再由平台补投。

## 连接截止与停止（v0.13）

- gateway HTTP 受配置的有限请求超时约束；拿到 endpoint/ticket 后，WebSocket 必须在 10 秒内触发 `open`，否则主动关闭并进入既有有界指数退避重连。
- `stop()` 会先置停止标志，再清除 open/handshake 与 reconnect 定时器并关闭当前 socket；旧连接的迟到 message/close 由连接身份检查忽略，不得复活重连。
- 上述行为由 fake transport 合约测试覆盖，仍不等同于真实钉钉 Stream 长时 soak；帧级 ACK 接受性继续保留为 Phase F 项。

## SYSTEM 帧与双层心跳（G-02）

- SDK `onDownStream` 按 `msg.type` 分派：`SYSTEM` → onSystem、`EVENT` → queueEvent、`CALLBACK` → onCallback，三类互不混流。
- **应用层 SYSTEM 帧子类 ping 与传输层 WS 协议 ping/pong 是两码事，不得合并处理**：前者是业务帧流里的 JSON 帧（SDK onSystem `case "ping"`），后者由原生 WebSocket 自动应答（本实现不发心跳帧，与官方 SDK keepAlive:false 同态）。
- SYSTEM ping 须**原样回显** `{ code: 200, headers: frame.headers, data: frame.data }`——headers 与 data 必须等值回传（data 含必须回显的 opaque，不回显或改写会导致服务端判定连接异常）。
- SDK onSystem 按 `headers.topic` 分派子类；本批次仲裁结论点名 `headers.method` / `headers.event_type`，SDK 源码用 `headers.topic`，无真机帧样本可裁决——实现取 topic ∪ method ∪ event_type/eventType 并集防御性兼容。
- disconnect / KEEPALIVE / REGISTERED / CONNECTED 等 SYSTEM 子类：记 debug 日志后返回，**不进业务路径、不回显**（fail-closed）。

## data 二次 parse 失败的可观测性（G-42）

- `data` 非法 JSON 时：ack 已发则服务端不会重推，静默丢弃等于不可观测的黑洞。实现改为 warn 日志（含 messageId、frame.type、内容前 64 字符截断）后仍 return 不投递——丢消息至少可观测。

## 消息归一与 richText（G-23）

- 业务消息字段：`{ conversationId, msgId, senderStaffId, senderNick, sessionWebhook, sessionWebhookExpiredTime, robotCode, msgtype, text: { content } }`；`content` 首尾 trim。
- richText（msgtype `'richText'`）形态：`content.richText` 为模块数组，text 段 `{ text: '…' }`、图片段 `{ downloadCode: '…', type: 'picture' }`。实现遍历模块：text 段拼接进 envelope.text；图片段走既有 picture/image 管线（normalizeImageAttachment 白名单字段）。纯文本/纯图消息行为不变。
- 官方 downloadCode-only 图片段须另调文件下载接口才换得到临时 URL，本实现不发起该调用：解析不出安全 URL 即 fail-closed 丢弃该图片段，文本段照常投递（`declared`，未真机验证）。

## 出站回复与 messageId 合成

- 被动回复：`POST sessionWebhook`，头 `{ content-type, x-acs-dingtalk-access-token }`，body `{ msgparam: JSON.stringify({ content }), msgKey: 'sampleText' }`；webhook 到期（毫秒时间戳 < now）不回复、告警，改走主动推送兜底。
- **被动回复合成 messageId（G-24）**：`dt:reply-<ts36>-<seq36>`（时间戳 36 进制 + 模块级单调序号 36 进制）。旧 hash6(chatId:content) 在同会话同内容两次回复时必然同 ID（回执关联/去重会把两次回复折叠成一条）。
- 主动推送：`POST {api}/v1.0/robot/oToMessages/batchSend?robot_code=`（body 为单元素数组）；robotCode 从首条入站消息学习并落盘（store `dingtalk:robot-code`，跨重启恢复）。

## 能力分级与实现映射

`src/inbound/dingtalk-stream.mjs`（零 SDK 依赖裸协议实现）；测试 `test/inbound.dingtalk.test.mjs`。`realDeviceVerified=false`；心跳时序、重推间隔、richText 真机形态、SDK 顶层 `message` 字段依赖均 `declared`。

| 协议事实 | 待实现 seam | 禁止事项 |
|---|---|---|
| 建连 body 字段名 `ua`（三版 SDK 源码） | 真机建连抓包复核 | 改回 `uesrAgent`、照抄「官方拼写错误」谣言注释 |
| messageId 只在 headers.messageId | 顶层字段形态真机样本 | 读顶层 messageId、回执头用 requestId |
| ack data 为 JSON 字符串 `"OK"` | 服务端对 data 内容的判定真机验证 | 发裸 `'ack'`、不 JSON 化 |
| SYSTEM ping 原样回显 headers+data | topic/method/event_type 判定字段真机裁决 | 与 WS 协议层心跳合并处理、回显改写 opaque |
| data 二次 parse | —— | parse 失败静默吞掉 |
| richText 模块遍历归一 | downloadCode→URL 换取真机验证 | 猜测未文档化模块字段、非白名单 URL 入 envelope |

验收：`node --test test/inbound.dingtalk.test.mjs`；`npm test`。真实钉钉租户、心跳时序、60s 重推与 richText 图片段仍待真机验证。
