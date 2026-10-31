# dsh-notifier 渠道协议专项静态审查

**审查目标**：`THEWOLFWALKER/dsh-notifier`，`main@9d69dd7a8908fcfec6e20d92d56509764a8f23ec`（版本元数据 `0.13.1`）  
**审查日期**：2026-10-31  
**性质**：严格只读，公开协议/官方 SDK × 固定源码对账；**未运行代码、测试、探针、安装脚本、宿主、服务端 API 或真实消息，也未修改任何项目或远端状态**。  
**不在范围内**：`dev`、重写分支、附件中的 dev ZIP。已知 deep-freeze 故障只列作前置阻断，不再次记为本报告新发现。

## 0. 结论与证据标准

固定版本登记 **28 个出站渠道和 6 个入站渠道**。实现大体遵循多家提供方的端点/鉴权基本形式，但**协议正确性尚不能等同于端到端送达**；出站受理、部分目标受理、终端实际展示、入站平台 ACK、业务成功分别是不同事件。

本审查采用以下等级：

- **D — 确定偏差**：固定实现与可核验第一方协议规范冲突，或实现自身的成功/去重判据确定地遗漏字段。影响是否真实触发仍取决于使用情景。
- **H — 兼容性假设 / 未证实依赖**：SDK 源码行为、未公开字段、厂商开关、日期变更或特定响应情形尚无固定版本官方证据；不得宣称已实机证明故障。
- **E — 可选增强**：与官方相容但当前未覆盖的能力、预检或可观测性；不自动列作缺陷。
- **U — 真实送达未知**：响应表明 HTTP 处理或提供方受理，**没有设备端送达确认**。所有当前 28 出站默认属于 U，除非某条路径另有明确的端到端回执，本次未发现能普适证明的路径。
- **N — 无适用官方规范**：本地行为/通用自定义 webhook 或协议公开材料不足；禁止拿社区实现推断第一方保证。

### 优先核查发现

| ID | 等级 | 受影响路径 | 证据化结论 | 影响与修复边界 |
|---|---|---|---|---|
| P-01 | **D** | QQ 出站 `qq-bot`；QQ 入站主动/按钮发送 | 发送成功检查没有要求响应具有非空 `id` 与合法存在的 `timestamp`；异常码判断只接受非空**字符串** `code`，不识别**数字**业务错误码。QQ 官方返回含 `id` 和 `timestamp`；旧版腾讯 bot-docs 类型表标 `timestamp:int`，2026 年较新 wiki 示例有 ISO 日期字符串口径，类型未能唯一锁定；错误码表为数字。 | 空对象、错误码为数值的响应可误记受理；静态修复必须分类型严格校验成功形状及错误联合类型，不以 2xx 单独结论。|
| P-02 | **D（声明错误）/H（实际重发）** | QQ 出站 | 注释宣称“`msg_seq + 内容`必然幂等”，但官方只承诺**被动回复 `msg_id + msg_seq`** 组合用于防重复，且重复发送会**失败**；主动消息未给出同等保证。 | 不得以冻结 `msg_seq` 视作可安全重试的证据。保留“超时结果未知、不得盲重发”，分段单独记录受理事实；对重复响应明确区分成功/冲突。|
| P-03 | **H（高影响官方状态冲突）** | QQ 主动通知 | 腾讯维护的发送文档公告“**2025-04-21 起不再提供主动推送能力**”；固定源码注释自述 2026-06 开放群主动消息，却缺对应第一方更新公告。本次不能证明 2026 已恢复。 | 不能把 QQ 无 `msg_id` 主动推送宣称普遍可用；必须区分被动回复、开放条件、群/单聊通知，获取正式恢复公告后才能升级结论。**不代表应删群通知。** |
| P-04 | **D** | WxPusher 出站 | 顶层 `code===1000` 即全体成功；第一方响应示例在 `data[]` 给出每个 UID/topic 的 `code/status`，顶层只证明任务创建。 | 多目标部分失败无法向上反映；需要逐目标解析、对账失败目标与已受理目标。真实送达仍未知。|
| P-05 | **D（请求字段类型）/H（服务端宽容）** | WxPusher 出站 | 项目 `topicIds` 经 `strArray()` 强制成为字符串数组；第一方示例为**数字主题 ID**（`[123]`）。 | JSON 类型静态不一致，服务端是否接受字符串**未验证**；严格保留/转换为官方数字类型，不因其“看起来能用”推断兼容。|
| P-06 | **D** | WPS 出站（启用签名时） | WPS 官方在开启“签名校验”时强制 `Content-Md5`、`Content-Type: application/json`、RFC GMT `DATE`、`Authorization=key:SHA1(secretKey+md5+type+date)`，±15 分钟。本实现只携带 URL `?key=`，无签名头；`is2xx` 不验证业务响应。 | **条件性确定不兼容**已开签名的 WPS 群机器人。未开启签名的 key-only URL 路径不能据此判无效；没有公开完整成功响应形状，不得凭空要求某个 `code`。|
| P-07 | **D（规范覆盖缺口）** | WPS、Feishu、Pushover、Server酱、Discord 等 | 全局默认按 1200 **Unicode 码点**分段；官方限制可能按 UTF-8 字节、标题独立字段、完整 JSON 大小或标题+正文总长计算。WPS **5000 字符/20 次每分钟**，飞书自定义机器人 **20KB body/100 次每分钟与 5 次每秒**；不具针对性预检/限频。 | 需在平台包装后检查**最终请求体**及标题/正文各域，按目标作用域预算，不可简单把共享分段数字当作兼容证明。 |
| P-08 | **D（本地状态键缺作用域）** | Telegram 入站及六渠道去重总线 | Telegram offset 写固定 `tg:offset`；通用 dedup key 为 `dedup:<channel>:<messageId>`，没有 `accountId`。 | 共享持久 Store 中多 Bot/多账号的游标及重放判定可能相互干扰；应保留旧游标迁移证据，按账号域分隔，不能直接清空跳过历史未处理事件。|
| P-09 | **H（固定 SDK 使用契约冲突）** | Feishu 入站按钮 | `EventDispatcher` 注册 `card.action.trigger` 于 `WSClient`。Lark 官方 Node SDK README 写明**长连接目前只支持事件订阅，不支持回调订阅**；卡片回调文档使用专属 `CardActionHandler`/HTTP 模式。本项目固定可选 SDK `1.73.0`，**本次未完整取得该 tarball 对应源码**，不可声称 1.73.0 运行必失败。 | 这是高风险传输层能力差异，应以锁定 SDK 源码/对应官方公告为裁决依据；不要凭已有 mock 通过证明线上回调可达。普通 Feishu 消息事件链与按钮回调分开评估。 |
| P-10 | **H（SDK 帧形状差异）** | DingTalk Stream 入站 | 官方维护的 Node SDK `send`/`sendEventAck` 与 SYSTEM ping 回执都包含顶层 `message:'OK'`；本项目回执**缺该字段**。`data:JSON.stringify('OK')` 对 CALLBACK 回复与 SDK `send(msgId,'OK')` 同态，不能错误地说其 data 必错。 | 缺顶层字段是确定的**SDK 结构差异**，服务端是否严格要求尚未证明；按当前 SDK frame 合同补齐。另：本项目先 ACK 再处理，故处理失败时丧失平台重投机会。|
| P-11 | **D（无法提供有保证的去重）/N（平台未定义）** | WxPusher 入站 | 官方 `send_up_cmd` 字段为 `uid/appId/appName/time/content`，**无稳定逐消息事件 ID**；没有发布可证实的“重复回调/重试/固定重投次数”合同。实现 `cmd:uid:time:hash(text):syntheticSeq++` 使同内容真消息不撞键，但重传同一事件也获得新键。 | **不能以内容哈希替代事件 ID**，否则两次真实同样消息（甚至同毫秒）被误吞。应明确采用“每次入站投递当成独立事件 + 控制业务不可逆动作的单次授权”，并披露无法判别真重发与重复真实消息。 |
| P-12 | **H / N** | WeChat iLink | `getupdates/sendmessage/context_token/client_id/ret -2/-14` 来自社区实现与逆向经验，**未找到这些端点及语义的微信第一方公开标准**。本项目分类器将缺失 `ret` 与 `errcode` 默认为 0，空对象也可被分类为成功。 | “空响应视成功”是本地校验漏洞，但**不能叫官方协议偏差**。保持“社区观察/证据不足”，拒绝把任何客户端 ID、游标或错误码当作腾讯保证。 |
| P-13 | **D（条件性接入）** | Discord Webhook 特殊频道、Teams 迁移 | Discord 默认 `wait=false` 返回 204（可能不确保保存），forum/media 目标需要 thread 参数；Teams 本项目采用 Workflows 新式卡片，方向正确，不能误判为已弃用的旧 Office365 Connector，然而工作流 HTTP 受理不保证卡片发布成功。 | 精确区分普通 Discord 频道与 forum thread、新 Teams Workflows 与弃用 legacy Connector，状态止于 provider-accepted。 |

## 1. 共用发送链的实际语义

- `src/notify.mjs` → `sendSegmented` → adapter 的发送函数 → `routing.sendWithRetry`。默认分段 **1200 码点**；已发送部分段失败，设置 `noRetry` 防整条重复；发送请求 Abort 超时视为**结果未知**并 `noRetry`。该策略合理但**不是提供方幂等证明**。
- 仅在配置 routing 后开启按消息优先级的重试：`timeSensitive` 总尝试最多 3 次、`active` 2 次、`passive` 1 次（配置可覆盖）。HTTP `429` 针对 Telegram JSON `parameters.retry_after` 会提取秒数，通用响应头 `Retry-After` **未在共用路径处理**，不可称 28 渠道全部遵守。
- `src/adapters/_engine.mjs`：声明式渠道按 `spec.ok` 判成功。`is2xx` 只是 HTTP 状态谓词；**不得把 WPS/Slack/Discord/Teams 的 is2xx 一概叫“协议错误”**，必须结合各家的官方响应合同及接入模式逐个判定。
- `src/notify.mjs` 已将 `accepted` 与 `confirmed` 区分，兼容字段 `delivered` **实际上是 `accepted` 的别名**。上层 UX 若把 `delivered` 展示为“用户已收到”就是语义夸大，而不是提供方交付回执。
- 不具 provider idempotency-key 合同的渠道，失败 5xx/断流/超时的结果都可能是“服务端已处理但本地没见响应”。共用无重复重发策略宜保守，不能凭内容哈希或请求序号自动声明 exactly-once。
- 群**通知**是部分合法出站能力（Feishu custom webhook/WeCom 群机器人/DingTalk/QQ/Slack 等）；群**控制**涉及身份与授权，是另一个功能范围。本审查不建议因控制风险删除合法群通知。

## 2. 优先出站渠道逐项对账（7 个）

### O01 `qq-bot`（QQ 官方机器人）

**实现规则**：`POST https://bots.qq.com/app/getAppAccessToken`（`appId/clientSecret`），再 `POST https://api.sgroup.qq.com/v2/{users|groups}/{openid}/messages`（`Authorization: QQBot <access_token>`）；默认群目标 `groupId`、可选单聊 `userId`，默认 Markdown `msg_type=2,markdown.content`（可设 text `msg_type=0`），拼 `title\ncontent`，按码点切 Markdown 3000 / text 2000；全局默认再切 1200；本实例 1050ms 发送间隔；`msg_seq` 有状态递增和异常冻结。2xx JSON 接收只排除非空字符串 `code`，**不要求 `id/timestamp`**。

**官方规则**：QQ 官方文档列发送单聊/群消息 URL、`msg_type`、`msg_id/event_id`（被动事件引用）、`msg_seq`、返回 `id:string` 和 `timestamp`（旧表标 int，较新 wiki 示例为时间字符串；需要按目标 API 版本裁决），示例错误 `22009/304082/304083`；重复 `msg_id+msg_seq` 会失败，**未给主动消息 `seq+内容` 恰好一次保证**；富媒体先取限时 `file_info`，不能用普通文本体冒充附件。旧主动推送停用公告时间 2025-04-21，当前可用性需以新一手解除公告为准。token 通过 `expires_in`（秒）有效期，主动/被动窗口与群/单聊不同。参见 [QQ发送总览](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)、[QQ Access Token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)。官方动态内容查阅 2026-10-31。

**一致与差异**：端点与认证基本一致；**D** 成功/错误码解析不完整；**D/H** 无被动 `msg_id` 的主动消息幂等注释不成立；**H** 主动推送是否开放不可从当前源码注释推定；**E** 不支持富媒体与官方卡片所有变体；长度“字符/码点”实际结算须以官方每消息场景为准。**影响**：错误“成功”，重复、限流或无法触达默认群。**修复边界**：合法成功必须匹配返回形状，时间戳类型采取按版本证据验证（不凭旧文档硬拒绝新版字符串），错误码兼容数字/字符串且保留平台原始类型；主动失败不得自动按 `msg_seq` 重发；按场景回报权限与禁用状态。

### O02 `wecom-app`（企业微信自建应用消息）

**实现规则**：`GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=&corpsecret=`；`POST /cgi-bin/message/send?access_token=`；body `touser` 默认 `@all`、`agentid` 数字、`msgtype=text|markdown`、正文 `title\ncontent`。要求数值 `errcode===0`，token 40014/42001 强制刷新并试一次。

**官方规则**：企业微信应用消息发给企业内部 UserID/部门/标签，应具备应用可见范围/有效接收人；接口成功的 `errcode` 不等于每个目标一定投递。部分响应可能携带 `invaliduser/invalidparty/invalidtag` 及许可证相关字段；但本次第一方动态文档正文未能独立稳定导出，对字段集合保留 **H**。官方入口：[企业微信开发者中心](https://developer.work.weixin.qq.com/document/path/90236)（动态页，查阅 2026-10-31，正文复核不足）。

**一致与差异**：token/endpoint/HTTP/类型大体一致；**H** 只判断 `errcode===0`，未区分多目标过滤或无效人；**E** 缺应用有效范围/字符串上限预校验；**U** 未知真实送达。**影响**：`@all` 配置可能包含不可达对象或超出预期通知范围。**修复边界**：确认官方当版部分失败字段及 UserID 作用域后做分类；保留群机器人 `wecom` 与 App 消息 `wecom-app` 两条独立链。

### O03 `wxpusher`

**实现规则**：`POST https://wxpusher.zjiecode.com/api/send/message`，JSON `appToken,content(title\ncontent),summary(title),contentType:1,uids:string[],topicIds:string[]`；顶层数值 `code===1000` 为成功。无每目标业务码、UTF-8 预算及整体 rateGate（入站回执另有 500ms gate）。

**官方规则**：`content` 原文 **≤40000 字符且 UTF-8 ≤65535 bytes**、转换后 HTML 也 ≤65535 bytes；`summary≤100字符`、`uid≤2000/请求`、`topicIds≤5/请求`，官方示例 topic ID 为整数；默认每 10 秒 20 次（约 2QPS）；成功顶层 `code:1000` 和 `data[]` **逐目标** `code/status/uid/topicId/messageContentId`，**任务已创建不等于送达**。发送状态查询接口已停用，不能自动轮询/重发。官方：[WxPusher 文档（维护日期 2026-10-10）](https://github.com/wxpusher/wxpusher-docs/blob/master/docs/README.md)、[API 精简页](https://wxpusher.zjiecode.com/docs/api-reference.html)，查阅 2026-10-31。

**一致与差异**：请求 URL/token/contentType 一致；**D** 丢逐目标结果；**D/H** `topicIds` 数字/字符串不一致，服务端宽容未知；**D/E** 无官方限流和 UTF-8 总体预检。**影响**：部分 UID 拒收却报整条成功；可能被限流或类型拒绝。**修复边界**：保持 UID 和 Topic 两类作用域；按每目标响应记账；预先验证序列化后长度/字节，并不伪造实际送达。

### O04 `telegram`

**实现规则**：`POST {apiBase}/bot{token}/sendMessage`，`chat_id` 必填，`text=title\n\ncontent`，不使用 parse_mode，静音转 `disable_notification:true`；要求 JSON `ok===true` 且 `result` 非 `undefined`；不验证 `result.message_id`、目标 chat。API token 不会按时间自动刷新（BotFather 管理/撤销）。

**官方规则**：HTTP Bot API `sendMessage`, 文本 **1–4096 字符（实体解析之后）**，返回成功是 Message 对象；被限流的错误响应可含 `parameters.retry_after`（秒）。`chat_id` 是具体 Bot 可到达的用户/会话，不等价于全局 user identity。`sendMessage` **无通用官方请求幂等键**。官方：[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)（动态文档，查阅 2026-10-31）。

**一致与差异**：标准 endpoint、鉴权和纯文本用法正确；**H** 仅检查 result 存在而不校验 Message 形状；**E** 格式化/附件 API 未实现；**U** 发送成功不保证用户端显示。**影响**：异常中间层伪造空 `result` 时误判；机器人缺 chat 权限时应保留明确失败。**修复边界**：校验官方 Message 至少 `message_id` + `chat`；保留 `retry_after` 而不盲重发。

### O05 `feishu`（飞书**自定义群机器人**，非入站应用机器人）

**实现规则**：`POST https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，`msg_type:interactive`，卡片 header plain_text title + Markdown 元素正文；可选 HMAC 加签，`timestamp` 秒、`sign=base64(HMAC_SHA256(key=timestamp+'\n'+secret, data=''))`；数值 `code===0` 视为 API 受理。`timeSensitive` 可内嵌 `<at user_id="...">`，但只在本群生效。

**官方规则**：自定义机器人**仅在创建的单个群**使用、无读取群消息/操控权限；单机器人每租户 **100/min、5/sec**，HTTP body **≤20KB**，加签时间 ±3600s，关键词/IP/签名安全设置可同时生效；卡片回调能力不能等同应用机器人回调。官方：[Custom bot usage guide，更新 2025-03-27](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)，查阅 2026-10-31。

**一致与差异**：URL、签名方向、响应业务码一致；**D/E** 缺 20KB/5QPS/100QPM 的 provider 预算门；**H** interactive 卡片具体 schema 版本与 @ 展示需按对应 Card Kit 版本核对；**U** 只证明群 webhook 受理。**影响**：长卡片或集中大量消息可拒收。**修复边界**：按最终 JSON UTF-8 总字节校验，不把群通知误扩展为用户私聊或原生业务控制。

### O06 `dingtalk`（钉钉**自定义群机器人**，非 Stream 应用机器人）

**实现规则**：`POST https://oapi.dingtalk.com/robot/send?access_token=<...>`；可选 `timestamp` 毫秒与 URL 参数 `sign`（密钥 HMAC-SHA256、base64 再 URL 编码），`{msgtype:'markdown', markdown:{title,text}, at:{isAtAll?}}`。成功数值 `errcode===0`，310000/120001 错误单列。

**官方规则**：群 webhook 的 token、可选加签/自定义关键词/IP 安全校验；markdown 标题与正文是不同字段，机器人独立于 Stream 应用入站。官方入口：[钉钉自定义机器人](https://open.dingtalk.com/document/robots/custom-robot-access)（动态页，查阅 2026-10-31；完整当版字段/流控限制未能独立导出，**H**）。

**一致与差异**：端点、签名基本同官方广泛使用形状；**H** 卡片与 Markdown 内容预算、服务端重试/频率需凭官方可读规格裁决；**U** `errcode=0` 不等于用户已读。**修复边界**：继续区分“群通知 webhook”和“Stream 私聊控制”身份/权限；不将平台通用 Markdown 概念等价为任意卡片支持。

### O07 `wps-bot`

**实现规则**：完整 webhook 归一到 `https://{woa.wps.cn|xz.wps.cn|365.kdocs.cn}/api/v1/webhook/send?key=...`；`POST` JSON text `{msgtype:'text',text:{content:title\ncontent}}` 或 Markdown `{msgtype:'markdown',markdown:{text:title\n\ncontent}}`。URL `key` 是唯一实现认证；返回只判断 `HTTP 2xx`，不读响应的官方语义。

**官方规则**：WPS 协作官方 webhook 文档列默认 `https://xz.wps.cn/api/v1/webhook/send?key=...`、每机器人 **20 条/分钟**、单条**≤5000字符**，text/Markdown/card 模式；可设置 IP 白名单或签名，后者必须有 `Content-Md5`(MD5 lowercase)、`Content-Type: application/json`、`DATE` GMT、`Authorization:key:sha1(secret+MD5+type+DATE)`，日期窗口 ±15min；**官方此页未稳定定义“2xx 附加何种业务 JSON 必须为成功”的约束**。官方：[WPS webhook 机器人](https://365.kdocs.cn/3rd/open/documents/app-integration-dev/guide/robot/webhook)（动态文档，查阅 2026-10-31）。

**一致与差异**：基本 URL/body 文本结构一致；**D** 签名安全模式不支持；**D/E** 无 5000 字符/20QPM 限制；**H** 2xx-only 是否掩盖业务失败因官方成功响应 schema 不明，**不能**编造 `code=0` 判据。**影响**：启签名的群机器人恒不兼容、超频/超长拒收、HTTP 假成功无法确认。**修复边界**：支持两种经官方定义的认证模式；优先校验长度/限频，成功体不足证据时只声明“HTTP accepted”。

## 3. 其余 21 个出站渠道逐项对账

> 下表所有行均按 **实现规则 / 官方规则 / 差异等级 / 影响 / 修复边界** 顺序给出。证据链接为第一方官网或项目维护仓库；没有可核验的第一方规范时如实标 **N**。除平台明示内容外，未为任何服务虚构固定 token TTL、Retry-After、幂等有效期或实际送达回执。

| 渠道 | 实现规则（endpoint / 身份 / 请求 / 响应） | 官方规则与证据 | 一致 / 差异 | 影响 | 修复边界 |
|---|---|---|---|---|---|
| **bark** | POST `https://api.day.app/<key>` 或自托管服务；JSON `title,body,group?,level?,device?`；数值 `code===200`。 | Bark 官方维护项目 [Finb/Bark](https://github.com/Finb/Bark) 支持密钥式推送与自建服务；响应/附件细则要以服务器版本为准。 | **基本一致；H/E** 私有服务器版本、URL key 与 token 轮换、扩展级别限制未固定。 | API 接受不保证 iOS 系统展示；没有附件/送达证明。 | 严格按服务版本回包，不把 `code=200` 展示为 APNs 送达。 |
| **bell** | 本地终端 `stdout` 输出 ANSI BEL `\x07` 1–5 次；`silent` 无操作；无 HTTP/token。 | 本地终端控制符，没有统一云 provider；实际提示音取决于终端。 | **N**；与云服务成功码不适用。 | 无头设备/重定向的终端可能不响。 | 将“write attempted”与“听见响铃”区别，不能构造 provider receipt。 |
| **chanify** | POST `https://api.chanify.net/v1/sender/<token>`，form `title,text`，仅 2xx。 | [Chanify 官方维护仓库](https://github.com/chanify/chanify) 规定 sender endpoint，Send Token 可按发行/服务端配置到期（官方项目说明常见 90 天，可调整）。 | URL 一致；**H/E** 未核验 2xx 响应字段、到期无刷新。 | token 失效/API 受理≠客户端通知。 | 记录 token 更换要求，服务端返回格式依固定实现核准。 |
| **desktop** | 本地 `osascript` / `notify-send` / Windows PowerShell BurntToast；标题 UTF-16 120、正文 500，silent 不调用。 | 操作系统/桌面环境各自实现，不存在一条跨平台 HTTP 标准；Windows 依赖用户环境已装模块。 | **N**；长度为**项目展示预算**而非厂商保证。 | 子进程 0 不能证明系统通知弹出。 | 分 OS 报可用性和错误；用户未经授权不执行安装。 |
| **discord** | POST 用户 webhook，JSON `content=title\nbody`，JS UTF-16 `length<=2000`；任意 2xx 成功。 | [Discord 官方 Webhook 规范](https://discord.com/developers/docs/resources/webhook#execute-webhook) 内容最长 2000；`wait=false` 默认常见 204、未必保证消息保存；论坛/媒体频道需线程参数。 | 普通 webhook 基本一致；**D（特殊频道）/H/U** 缺 `thread_id/thread_name`、204 非实际存储确认；无 `allowed_mentions`。 | 特殊频道发不了；文本可能触发 @ 提及；可能只成功排队。 | 线程目标显式配置，用户文本禁不必要全员提及（E），按是否请求 wait 和回包证据分级。 |
| **gchat** | POST Google Chat Space webhook 完整 URL，JSON `{text}`，只看 2xx。 | [Google Chat Webhook 官方文档](https://developers.google.com/workspace/chat/quickstart/webhooks)，空间级签发 URL；成功可有消息对象，OAuth 应用消息是另一身份类型。 | 基本一致；**H/E** 未检验返回 Message 名称、空间权限/内容限额。 | 空间机器人可用但无法按用户私聊控制。 | 遵守 Space 身份界限；别把 HTTP 2xx 称为已读。 |
| **gotify** | POST `server/message`，`X-Gotify-Key` app token，JSON `title,message,priority`，2xx 成功。 | [Gotify 官方文档](https://gotify.net/docs/pushmsg)、[服务源码](https://github.com/gotify/server)，应用 token 与消息 id；自建服务版本/订阅分别管理。 | endpoint/鉴权基本一致；**E** 可校验返回消息 id。 | 只证明服务器已存储/接受，终端可能离线。 | 以消息对象校验 provider accepted，不把 API token 当用户凭证。 |
| **igot** | POST `https://push.hellyw.com/<key>`，JSON `title,content,automaticallyCopy:0`，`ret===0`。 | **N**：此次未取得可追溯的提供方公开协议规格或版本化 SDK，不能以聚合项目移植注释代替。 | **证据不足**。 | 无法独立断言字段、长度/幂等或成功码符合当前服务。 | 保留现有兼容实现，但对外标“未获第一方规范验证”。 |
| **mattermost** | POST 自托管 `server/hooks/<hookId>` / webhook URL，JSON `{text}`，2xx 成功。 | [Mattermost 官方 Incoming Webhooks 文档](https://developers.mattermost.com/integrate/webhooks/incoming/)，常见成功为纯文本 `ok`，服务自托管/私网。 | endpoint/字段基本一致；**H** 只看 2xx 未确认 `ok` body。 | 代理或非标准服务返回 200 时可能误记。 | 有一手响应契约时验证 `ok`，区分 HTTP 成功与消息可见。 |
| **ntfy** | POST 配置 server 根路径，JSON `{topic,title?,message,priority}`、可选 Authorization，2xx 成功。 | [ntfy 官方 publish 文档](https://docs.ntfy.sh/publish/)，支持根路径 JSON、优先级和服务端可配置额度。 | 请求符合公开 JSON 发布模式；**H/E** 未用返回 `id`/错误字段，无法保证订阅者在线。 | 公开 topic 与权限取决于部署；同 topic 的消息不按文本幂等。 | per-server rate/size 与 JSON 回包可选校验，不声称端到端。 |
| **onebot** | POST 自托管 `/send_msg`，Bearer accessToken 可选，`message_type/private|group`、数字 `user_id/group_id`、消息数组纯 text；`retcode=0 && status!='failed'`。 | [OneBot v11 社区原规范 send_msg](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：QQ 号/群号是数字身份，返回 `message_id`；**非腾讯 QQ 官方 Bot API**。 | 形状一致；**H** 未强制 `status='ok'`/`data.message_id`，实现兼容差异来自 NapCat/LLOneBot。 | 自托管实现差异/错误 success 可混淆；无法假定发送回执跨服务统一。 | 按 OneBot v11 返回形状与实现版本验收，别把普通 QQ 号当 QQBot openid。 |
| **pushdeer** | POST `api2.pushdeer.com/message/push` 或自托管，form `pushkey,text:title,desp:content,type:markdown`；`code===0`。 | [PushDeer 原维护仓库](https://github.com/easychen/pushdeer) 接口吻合，但第一方仓库有**停止活跃维护**提示及特定客户端限制。 | 基本一致；**H** 托管可用性/客户端权限随产品现状。 | 成功推送队列不保证显示。 | 显示维护风险，不擅自删除渠道。 |
| **pushover** | POST `https://api.pushover.net/1/messages.json` form `token,user,title,message,sound?`；`status===1`。 | [Pushover 官方 Message API](https://pushover.net/api)：`message` 上限 **1024 字符**、title **250**（具体 UTF-8/转义计算依官方文档）；有每应用配额及可选 `Retry-After`，成功返回 `request`。 | URL/状态码一致；**D/E** 缺最终消息长度与标题分别预算；**E** 不消费 request 跟踪标识。 | 长标题/正文被拒，HTTP 成功仍未证明设备接收。 | 独立限制 `title`、`message`，保留 `request` 作为追踪而非 delivery receipt。 |
| **pushplus** | POST `https://www.pushplus.plus/send`，JSON `token,title,content,template,topic?,channel?,option?`；`code===200`。 | [PushPlus 官方 API 指南](https://www.pushplus.plus/doc/guide/api.html)，成功是**任务异步受理**，支持 query/不同渠道，渠道名称与版本相关。 | API 与业务码基本一致；**H/E** 未区分后续异步失败和选路字段版本。 | 代码成功并不等于公众号/客户端到达。 | `accepted` 单独列出，状态查询需官方接口保留有效的前提，不可无授权盲轮询。 |
| **qmsg** | POST `https://qmsg.zendee.cn/v3/send/<key>` form `{msg,group?}`，`success===true`；不支持旧版 `qq/bot` 目标参数。 | **N**：Qmsg v3 最新原始公开规格和响应契约未取得稳定第一方证据；仅有项目声明/迁移注释。 | **证据不足**，旧版兼容拒绝属于项目主动策略。 | v3 单聊默认收件者与群号配置的规则不可由旧接口推导。 | 以固定官方 v3 规格确认 key 与 target 绑定、成功字段、配额；不可代写未经证实 idempotency。 |
| **serverchan** | POST Turbo `sctapi.ftqq.com/<SCT>.send`、SC³ `https://<shard>.push.ft07.com/send/<sctp...>.send`，form `{title,desp}`，`code===0`。 | [Server酱官方使用文档](https://sct.ftqq.com/sendkey)、[维护方 SDK](https://github.com/easychen/serverchan-sdk)，不同 key 前缀不同 endpoint，标题单独有长度限制（官方指引常见 **32 字符**，详细当版配额依所选计划）。 | endpoint/key 区分一致；**E/H** 未预检标题限制、服务计划额度。 | 提示文本可能在 title 字段超限，无法凭正文分段避免。 | 独立 title 验证、不同服务方案独立限额。 |
| **slack** | POST `https://hooks.slack.com/services/...`（只允许该 host），`{text}`，**HTTP 200** 即成功。 | [Slack 官方 Incoming Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) 成功通常 HTTP200 纯文本 `ok`；GovSlack 使用专属域名/环境。 | 商用 Slack 基本一致；**D（特定环境）** GovSlack URL 被硬阻；**H** 不验 `ok` body。 | GovSlack 无法配置、非标准代理 200 可能假成功。 | 若声明支持 GovSlack 则增受控合法域名；原版不应泛开放任意域名；成功体可校验。 |
| **teams** | POST Microsoft Teams Workflows webhook，Adaptive Card `type:'message',attachments`，版本 `1.4`；2xx 成功。 | [Microsoft Workflows webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using?tabs=cURL)、[Microsoft 连接器迁移说明](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors)。旧 Office 365 Connectors 已退役/进入迁移；**Workflows 属有效新路径**。 | **方向一致**，不是 legacy connector；**H/U** Flow HTTP 受理不表示下游卡片投递成功，流程输入 schema 与权限可变。 | Workflows 运行失败仍可能得到触发受理。 | 路由为“触发工作流”，不要把工作流 HTTP 2xx 当作 Teams 频道消息已投递。 |
| **webhook** | 用户自定义 URL POST JSON `{title,content,timestamp,level?,group?}`，可配鉴权头；2xx 成功，SSRF 防护。 | **N**：不存在通用 webhook “成功 JSON”标准，目标系统自行规定鉴权、重试、签名、ACK。 | 只有**用户自定义合同**；**H** 2xx 能否代表业务处理取决于接收方。 | 对端 200 但应用失败可能漏报。 | 每个目标需显式配置的响应合同，否则只报告 HTTP accepted。 |
| **wecom**（企业微信群机器人） | POST `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=` 或完整 webhook，Markdown `{msgtype,markdown:{content}}`；数字 `errcode===0`。 | [企业微信开发者文档入口](https://developer.work.weixin.qq.com/document/path/91770)（动态/部分正文未获稳定抓取）；群 webhook URL 的 `key` 作用域是**单机器人群**。 | 形式基本一致；**H/E** Markdown 字节/字符预算及频率细节缺确证；无交互控制。 | 可以通知群，但不能从通知 URL 获得群成员控制权。 | 保留合法群通知，严格不导入群控制权限。 |
| **xizhi** | POST `https://xizhi.qqoq.net/<key>.send` JSON `title,content`，数值 `code===200`。 | **N**：未独立取得厂商维护的当前完整开放 API 契约。 | **证据不足**。 | 无法核实过期、接入限制、响应字段类型。 | 不能拿第三方“推送聚合”源码当官方签名/限额证明。 |

**注**：本节共 21 渠道；与上节 7 渠道合计 28。任何一行标“基本一致”只指已明确比对的**子项**，不代表全部九类协议规则都已被第一方文档公开。附件/上传/富媒体统一没有默认能力，不应因为通知 body 有图像 URL 就声称发送了原生附件。

## 4. 六入站渠道专项对账

### I01 `telegram` — `getUpdates` long polling

- **实现规则**：`POST /bot<TOKEN>/getUpdates`，`allowed_updates:['message','callback_query']`、`timeout` 长轮询；用 `update.update_id+1` 作为下一 offset，处理后 `setDurable(store,'tg:offset',...)`；文本 `message_id + chat.id` 合成去重键；按钮从 `callback_query.id` 获取事件身份，用 `callback_query.from.id` 与 `message.chat.id` 做来源比对，操作后 `answerCallbackQuery`，有 15 分钟短引用 `r:<ref>`；文本回执截断 4000 UTF-16 码元。
- **官方规则**：[Telegram Bot API Receiving Updates](https://core.telegram.org/bots/api#getupdates)、[callback query](https://core.telegram.org/bots/api#callbackquery)、[answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery)、[InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton)。`getUpdates` 与 webhook 互斥；更新最多留 **24h**；更新**通过调用大于该 update_id 的 offset 确认**，不等于本地保存成功；`callback_data` **1–64 UTF-8 bytes**、`answerCallbackQuery.text` **0–200 chars**；429 `parameters.retry_after`（秒），无一体化自动回调业务幂等。`update_id` 是 Bot 更新序列，`message_id` 至少需要与 chat 作用域复合；同聊天重投与重复实际用户动作不同。
- **差异与影响**：**D** 全局 `tg:offset` 漏 Bot 账号作用域，可能让另一 Bot 跳过更新；**D** 总线 dedup 漏 accountId；**H** 入站固定 5s 异常退避未使用 `retry_after`，网络层出站则部分支持；**H** 特殊分支内部提前 return 后是否发 `answerCallbackQuery` 需在 callback bridge 进一步追到返回契约，不能仅凭函数名认定全部 ACK；**E** 异常响应和内联消息缺 chat 时拒绝而非跨聊天核销。**修复边界**：offset 必须按 Bot identity 分隔，并保障迁移不跳进度；一条 callback 的业务处理与 Telegram UI ACK 独立入账。

### I02 `qq` — QQ Gateway WS

- **实现规则**：`GET gateway`，WS `HELLO→IDENTIFY/RESUME→HEARTBEAT`，`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` 的平台 `id`、`user_openid/member_openid/group_openid` 入总线；`INTERACTION_CREATE` callback 从 interaction id 取消息标识；先 `PUT /interactions/{id}` body `{code:0}`，再业务裁决；回执/卡片 `POST /v2/users|groups/.../messages`，`msg_seq` 按目标递增，Markdown 键盘回退文本。群通知与群控制范围分离。
- **官方规则**：[QQ WebSocket 事件订阅](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[C2C 事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)、[群@事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)；需要应用意图/权限，Gateway seq 和 session 用于恢复，`openid` 是该 QQBot API 的应用/场景身份，不能拿 QQ 号取代；交互回调要求及时 ACK；被动 C2C/群回复次数和窗口不相同。官方更细的按钮 payload 字节限制/intent 精确开放条件需区分平台配置与 SDK 版本。
- **差异与影响**：**D** 入站侧的 QQ 发消息也仅排除字符串 `code`，空 2xx 可合成假的 messageId；**H** 注释宣称 `msg_id+msg_seq` 去重但重复会报错，不能等同“已成功”；**H** 新版 Markdown+键盘是否所有 Bot 都开放依应用权限；**U** ACK 响应本身不是审批业务完成证明。**修复边界**：复用 QQ 返回体强校验；按钮确保来源 `(account,user,chat)` 与 token，群敏感控制独立关闭不删群通知。

### I03 `feishu` — 飞书应用 WS / 交互卡片

- **实现规则**：可选 `@larksuiteoapi/node-sdk@1.73.0`，`Client/WSClient/EventDispatcher`；`im.message.receive_v1` 处理文本（`message.message_id`、`sender.open_id`、chat_id），把 `card.action.trigger` 同样注册进 `EventDispatcher`；卡片 `value` 包含 action token、`srcChat`、`iat` 15 分钟窗口；P2P 投递用 `ou_`，事件 chat 是 `oc_`，故检查操作者 open_id；确认后异步 patch 终态卡片；失败可文本 fallback。
- **官方规则**：[飞书事件订阅入口](https://open.feishu.cn/document/server-docs/event-subscription/event-subscription-request)、[飞书 SDK（官方维护）](https://github.com/larksuite/node-sdk/blob/main/README.md)。标准 `im.message.receive_v1` 含 header.event_id、sender.open_id、message.message_id；WS 3s 处理窗口及重推可能性；官方 SDK README 当前明确说**长连接不支持回调订阅**，标准交互回调 handler 与普通事件 handler 不是一个入口。`open_id`、`chat_id`、`union_id` 作用域/接收类型不可互换。官方动态页及 SDK main 查阅 2026-10-31，**无法直接证明 pinned 1.73.0 实际发送卡片回调的能力**。
- **差异与影响**：**H 高风险** `card.action.trigger` 的 WS EventDispatcher 注册不符合 SDK README 所述的支持矩阵；**H** 合成 callback eventId `open_message_id+operator+action` 会折叠同卡同人两次真实点击（对此业务只许一次的审批可能恰好需要，但是不能叫“平台原生回调 ID”）；`iat` 是项目 TTL 非提供方签名回执。**修复边界**：分开“事件订阅/卡片回调”；先通过固定版公开 SDK 元数据裁决，不要因传输 callback 不可用否认普通飞书 IM 通信；审核来源/ACK/重投应是独立账本。

### I04 `dingtalk` — DingTalk Stream

- **实现规则**：`POST https://api.dingtalk.com/v1.0/gateway/connections/open`（`clientId/clientSecret/subscriptions:[CALLBACK topic=/v1.0/im/bot/messages/get]/ua`），随后连接 `endpoint?ticket=`；`frame.headers.messageId` 用于 ACK `{"code":200,"headers":{"contentType":"application/json","messageId":"..."},"data":"\"OK\""}`；SYSTEM ping 回显 headers/data，但无顶层 `message`；**业务帧一收到先 ACK，再 parse JSON，再 bus.accept**。按消息 `msg.msgId` 60s 局部去重 + 总线持久去重；来源 `senderStaffId`、`conversationId`、`conversationType`，`sessionWebhook` 仅短期回复可用。
- **官方规则**：[钉钉官方 Stream 入口](https://open.dingtalk.com/document/orgapp/stream-mode-access)、[官方维护 Node SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts#L669-L685)，`DWClientDownStream.headers.messageId` 为**传输帧** ID；SDK callback `send(messageId,'OK')` 响应的 `data=JSON.stringify('OK')`，带顶层 `message:'OK'`；SYSTEM ping 原样回显也带 `message:'OK'`。未 ACK 通常 60s 内重推，**ACK 后无法依赖重投兜底**。SDK repo 主分支版本不断更新，不可把滚动 main 冒充 npm 已固定运行版本。
- **差异与影响**：**H** 欠缺顶层 `message` 的回执与官方 SDK frame 不同，服务端是否接受尚无实证；**D（接收处理语义）** ACK 早于 JSON parse/业务存储，处理失败该帧在正常协议下不再重投；**H** 批量/并发/过期 sessionWebhook 依实际权限。**修复边界**：确认 callback ACK 与 event ACK 分别使用对应 SDK 形状；只有在业务接纳具备 durable 证明后 ACK，否则显式记录不可恢复消息；不混淆 `frame.headers.messageId` 与业务 `msgId`。

### I05 `wxpusher` — POST 上行指令 callback

- **实现规则**：HTTP POST 私密回调路径，`send_up_cmd` 提取 `data.uid/appId/time/content`，剥 `#{appId}` 前缀。持久绑定来自已确认 UID/白名单，不使用载荷 `data.appId` 当本地 accountId。来源保护主要靠随机 URL 路径、部署/IP allowlist；默认公网但无 allowlist 拒绝。合成 `messageId=cmd:uid:time:hash6(text):syntheticSeq++`，标 `messageIdSynthetic=true` 交总线短窗；HTTP handler 正常/内部异常都返回 `200`。
- **官方规则**：[WxPusher 官方 callback 文档](https://github.com/wxpusher/wxpusher-docs/blob/master/docs/README.md#上行消息用户发送消息回调) 列 `send_up_cmd {uid,appId,appName,time,content}`、`app_subscribe`；**未定义可靠 `message_id/event_id`、稳定事件序列号、响应 ACK 之后的重投或次数/期限**。示例 `time` 是**毫秒时间戳，不是唯一 ID**。WxPusher 提供的跳转链接 HMAC `ts/nonce/sv/sign` 是**跳转链接**安全机制，不能假装是 `send_up_cmd` callback 自带验签。官方文档维护 2026-10-10，查阅 2026-10-31。
- **差异与影响**：**N/D** 只能证明“每个 HTTP 投递生成一个不同的本地键”；完全**不能**保证“重投同一消息合并”。`uid+time+contentHash` 可能误吞**两次真实相同消息**；追加 seq 后会让真正的同一次重发被视为新消息。**任何一种不能从当前官方字段中无损判别**。IP/私密 URL 是接入防御不是提供方签名验证；平台 200 只是接收请求完成，不意味着业务已持久化且执行。**修复边界**：不得建议内容哈希作为可靠去重；对控制动作必须凭独立的一次性审批权能防重复副作用；记录来源信任级别与收到次数，用户允许的相同文本多次真实消息必须能够生效。

### I06 `wechat` — WeChat iLink 长轮询（非 WxPusher）

- **实现规则**：`GET /ilink/bot/get_bot_qrcode`、`GET /get_qrcode_status`，`POST /ilink/bot/getupdates` 携 `get_updates_buf`，`POST /ilink/bot/sendmessage` 携 `to_user_id/client_id/item_list/context_token`；会话 token 通过 `AuthorizationType: ilink_bot_token` 和 `Authorization: Bearer`，自定 `X-WECHAT-UIN`/版本头；`ret/errcode=-14/-2` 分错误分支。游标在处理后 durable 存储；`message_id/client_id` 缺失会使用 `hash6(text)` 合成入站 identity。
- **官方规则**：**N — 无法取得微信官方公开、版本化、可追溯的 iLink Bot API 完整规范**（端点、token 生命周期、context_token 必要性、-2/-14 分支、游标 ACK、事件 ID 作用域、服务端重复推送）。项目自身 `docs/protocol-preflight/wechat-ilink.md` 明确将这些记作社区实现证据 `declared`；[OpenClaw 项目](https://github.com/openclaw/openclaw) 是社区参照而非微信官方。不得把 WxPusher 对 iLink 的推广说明视作服务端协议保证。
- **差异与影响**：**本地确定性缺陷** `classifyIlinkResponse` 对缺 `ret/errcode` 默认为 0，空 JSON 可能通过成功判断；**H** `message_id/client_id` 的唯一性与类型不明；以内容哈希兜底仍可能误吞两条真实同文本消息；**U** `sendmessage` 成功最多代表接口受理。**修复边界**：缺成功必需字段按协议未知拒绝而非“猜成功”；缺事件 ID 时承认无可靠去重，允许两次真实相同消息进入业务，但控制命令副作用必须另有一次性授权。所有非一手协议行为明确标经验假设。

## 5. SDK 版本与接入限制对账

| Provider | 项目依赖/实现 | 第一方可核证材料 | 结论 |
|---|---|---|---|
| Feishu | npm optional `@larksuiteoapi/node-sdk` **精确 `1.73.0`**；`Client/WSClient/EventDispatcher` 动态加载 | 官方 [larksuite/node-sdk README](https://github.com/larksuite/node-sdk/blob/main/README.md)（**滚动 main**） | **H** 消息事件 WS 路径吻合；卡片 callback 经 `EventDispatcher` 的支持矩阵与当前 README 冲突。**未将 main 当成 pinned 1.73.0 源码**。 |
| DingTalk Stream | **无** `dingtalk-stream` 运行依赖；零 SDK 原生 WS | [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts)；本项目旧 preflight 比对 2.1.4、2.1.6-beta.1、2.1.7-beta.1 | 可借 SDK 确认 `ua`、`headers.messageId`、`data` 形态，仍有顶层 `message:'OK'` 差异；不能宣称“使用某固定钉钉 SDK”，实际上没安装。 |
| QQ | 原生 fetch/WebSocket（**无** QQ SDK pin） | [腾讯 QQ Bot docs](https://github.com/tencent-connect/bot-docs)；API v2 | 需锁定协议/权限及主动消息公告；SDK 版本一致性项目无对应项。 |
| Telegram | 原生 Bot API fetch（**无** Telegram SDK pin） | [Telegram Bot API](https://core.telegram.org/bots/api) 动态规格 | 接口版本随服务端升级，无客户端 SDK 的固定合同；更需按真实回包字段和错误码判别。 |
| WxPusher | 原生 fetch/HTTP server（**无** WxPusher SDK pin） | [官方 docs 维护 2026-10-10](https://github.com/wxpusher/wxpusher-docs/blob/master/docs/README.md) | 文档定义的 code/字段可核；上行缺事件 ID 的事实不得归因于某 SDK 缺陷。 |
| WeChat iLink | 社区移植裸 HTTP | 社区第三方；无可核版本化微信一手 Bot API | **N**，无法做严格 SDK 协议符合性判定。 |

**官方明确迁移/弃用**：QQ 主动推送官方文档载明 2025-04-21 停用（须和可能更新的开放公告对账）；Teams 旧 Office 365 Connectors 不可拿来评价本项目的 **Workflows**；WxPusher 旧“发送状态查询”已停止；PushDeer 官方维护状态变化对客户端可用性产生风险；Qmsg v3 配置迁移是项目支持边界；WeChat iLink 没有可确认第一方稳定化/弃用声明，不能杜撰。

## 6. 跨平台授权身份、限制与异常条件总表

| 主题 | 合同结论 | 审查意见 |
|---|---|---|
| 出站目标 ID | QQ `user_openid/group_openid`、OneBot QQ 号/群号、Telegram `chat_id`、Feishu `ou_/oc_`、WeCom 企业 UserID/AgentId、WxPusher UID/Topic、DingTalk `staffId/conversationId` 不可互换 | 配置与迁移必须保留 `(provider,account,targetType,targetId)`；不得用“字符串看起来相同”跨应用绑定。 |
| 标题/正文合计 | QQ/Telegram/Discord/WPS/Slack 等先拼合；Pushover/Server酱/DingTalk Markdown/Feishu 卡片标题另有字段 | 单一 `maxCodepoints=1200` **不证明**总请求长度合法；须在最终合成对象上校验相应单位。 |
| 长度单位 | WxPusher 同时按字符及 UTF-8 原文/转化后字节计；Telegram 4096 字符（entity parse 后）；Discord content 2000 字符；WPS 5000 字符；Feishu webhook 20KB；TG callback_data 64 UTF-8 bytes | JS `.length` 是 UTF-16 code unit、`Array.from` 是 Unicode code point、`TextEncoder` 是 UTF-8 bytes，不可混用。未能确认单位的 provider 不自行猜为码点。 |
| 附件 | QQ file_info 限时并与场景绑定；TG sendPhoto/sendDocument 是独立 API；Feishu IM 上传需 `file_key`; 各 webhook 不一定接受文件 | 当前纯文本链接或结构化图片**不等于**附件发送成功；要按 provider 原生能力单独声明。 |
| Rate / Retry-After | 官方限制可按 bot、群、UID、tenant、每 10 秒、单日分层；HTTP 429 可能有 header 或 JSON retry_after | 当前只有局部限速器、Telegram JSON retry_after 提取；对其他渠道 **H** 是否返回头；不强加未查到的数值。 |
| 幂等键 | QQ `msg_id+msg_seq` 是被动回复重复控制且重复可能失败；Telegram sendMessage 无通用幂等键；WxPusher 无标准 send 去重 ID；平台回包 messageId 与自造 hash 不同 | **没有官方幂等合同 = 不可自动重试当成 exactly-once**；超时“已发但未知”需独立记录。 |
| 事务部分成功 | 发送多目标（WxPusher/WeCom App）、分段消息、通知经 Workflow 二次分发都可能部分成功 | 不把 HTTP 2xx/顶层 code 视为全体最终送达，区分 acceptedTargets、failedTargets、unknownTargets、partialSegments。 |
| ACK 与重投 | Telegram offset 通过下一轮 getUpdates 偏移确认；DingTalk ACK 帧抑制重投；QQ 按钮 ACK 解 loading；飞书 SDK 事件 ACK 按 3 秒窗口；WxPusher HTTP 200 并无公开强制重试合同 | ACK 是**传输确认/用户界面响应**，不是业务完成/持久提交。不可先 ACK 再假定失败会重发。 |
| 来源验证 | `uid/open_id/staffId` 等都是 provider 转交的主体标识，必须有可证明来自 provider 的传输鉴权；WPS 群 webhook 只有出站，无群操作者身份 | WxPusher HTTP 无签名且 URL 泄漏后可伪造；需要区分秘密路径、源 IP 和真正的 HMAC signature，不假装它们同强度。 |

## 7. 证据出处和审查可复现性

### 固定项目源码（只读）

1. [固定 commit 的适配器目录](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/adapters)：`qq-bot.mjs`、`wecom-app.mjs`、`wxpusher.mjs`、`telegram.mjs`、`feishu.mjs`、`dingtalk.mjs`、`serverchan.mjs`、`pushplus.mjs`、`bark.mjs`、`desktop.mjs`、`bell.mjs`、`webhook.mjs`、`spec-channels.mjs`、`_engine.mjs`、`_shared.mjs`、`_tokens.mjs`。
2. [固定 commit 的入站目录](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/inbound)：`telegram-bot.mjs`、`qq-gw.mjs`、`feishu-bot.mjs`、`dingtalk-stream.mjs`、`wxpusher-callback.mjs`、`http-callback.mjs`、`_ilink-api.mjs`、`bus.mjs`、`capability-matrix.mjs`、`channels-registry.mjs`。
3. [固定 commit 的 iLink 模块](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/channels/wechat-ilink)：`legacy-core.mjs`、`protocol.mjs`。
4. [固定 commit 的 package.json](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/package.json)，[路由](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/routing.mjs)，[广播语义](https://github.com/THEWOLFWALKER/dsh-notifier/blob/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/src/notify.mjs)。
5. 仓库内现有 [protocol-preflight](https://github.com/THEWOLFWALKER/dsh-notifier/tree/9d69dd7a8908fcfec6e20d92d56509764a8f23ec/docs/protocol-preflight) 可当**项目历史自审线索**，不能代替当日厂商官方规范。没有引用已有测试的通过率，**本次全部 tests not-run**。

### 提供方第一方公开文档与 SDK（访问：2026-10-31，除写明更新日期外均为滚动/动态页面）

- **QQ**：[Tencent `bot-docs` 消息总览](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)、[QQBot Access Token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[官方 WebSocket 事件](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)（文档中“2025-04-21 主动推送停用”时间可独立核实）。
- **WxPusher**：[官方维护开发文档](https://github.com/wxpusher/wxpusher-docs/blob/master/docs/README.md)（注明更新 **2026-10-10**）、[平台 API reference](https://wxpusher.zjiecode.com/docs/api-reference.html)（支持逐 UID 任务创建语义）。
- **Telegram**：[官方 Bot API](https://core.telegram.org/bots/api) 及其 `#sendmessage`、`#getupdates`、`#inlinekeyboardbutton`、`#answercallbackquery` 节（持续更新版本，不伪造固定最后修改日期）。
- **Feishu**：[Custom bot usage guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)（官方页面标 **2025-03-27**）、[消息接收 API](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive-message)、[官方 Node SDK README](https://github.com/larksuite/node-sdk/blob/main/README.md)（main，**非** `1.73.0` 的封存包）。
- **DingTalk**：[Stream 模式](https://open.dingtalk.com/document/orgapp/stream-mode-access)、[官方 Node Stream SDK `src/client.ts`](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts)、[自定义机器人](https://open.dingtalk.com/document/robots/custom-robot-access)。
- **WPS**：[WPS 协作 webhook 官方规格](https://365.kdocs.cn/3rd/open/documents/app-integration-dev/guide/robot/webhook)（动态页面、未发现明确版本冻结日期）。
- **Discord**：[Discord Developer Webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook)；**Slack**：[Incoming Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)；**Google Chat**：[Webhook quickstart](https://developers.google.com/workspace/chat/quickstart/webhooks)；**Teams**：[Teams Webhook/Connector 迁移](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors)。
- **其他**：[ntfy](https://docs.ntfy.sh/publish/)、[Gotify](https://gotify.net/docs/pushmsg)、[Pushover](https://pushover.net/api)、[Chanify](https://github.com/chanify/chanify)、[PushDeer](https://github.com/easychen/pushdeer)、[PushPlus](https://www.pushplus.plus/doc/guide/api.html)、[Server酱](https://sct.ftqq.com/sendkey)、[OneBot v11](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)、[Mattermost](https://developers.mattermost.com/integrate/webhooks/incoming/)、[Bark](https://github.com/Finb/Bark)。
- **公开证据不足**：iGot、息知、Qmsg v3 当前官方规范及 Wx iLink 标准服务端契约；WeCom App 当版完整响应字段、部分钉钉自定义机器人与其它产品的精确大小/频率上限。此类项目绝不以第三方教程、聚合代码注释或本仓库单测假装官方已确认。

## 8. 结案边界

**本报告是协议静态对账，不是 runtime 事故证明**。确定性实现缺陷（QQ 错误码/成功形状、WxPusher 目标类型与逐目标状态、WPS 签名模式、跨账号 dedup/cursor、iLink 空回包）可以从源码和一手文档确定其逻辑差异；“厂商是否实际容忍、哪类 Bot 是否仍开通主动推送、设备是否真正看到消息、回调是否真实从 WS 到达”等一律保持 **H/U**。

特别是 WxPusher：**平台不提供稳定 callback event ID，也未公开能证明重复投递与真实重复消息的区分规则。任何方案都不能同时保证不丢两次真实相同指令且完美消除平台重投。**本报告明确拒绝将“内容哈希相同”作为事件同一性的根据。

**未执行**：代码、测试、SDK 安装/构建、host 启动、provider API、登录、探针、真实通知、提交/推送/发布；不包含任何动态验证结论。

### 9. 追加：QQ 2026 官方域名与返回字段版本冲突（不能当作“旧版必坏”）

在 2026 年公开 QQ 资料中，**腾讯旧版 `tencent-connect/bot-docs`** 首页仍列生产 `https://api.sgroup.qq.com`、沙箱 `https://sandbox.api.sgroup.qq.com`、token `https://bots.qq.com/app/getAppAccessToken`；而若干 2026 年对 QQ 官方 wiki 的逐页静态整理称其 **api-call-guide / access-token 页面已将统一 API 根列为 `https://api.bot.qq.com`**，并列出 `timestamp` 为 ISO 时间字符串的响应示例。当前审查环境无法直接展开这两页动态 QQ wiki 的官方正文，因此本报告不能用二手整理将旧域名定义为**已废弃且不可使用**，也不能将旧版 `timestamp:int` 宣称为 2026 唯一有效类型。

- **实现**：出站 `qq-bot` 默认 `apiBase=https://api.sgroup.qq.com` 可配置替换；token URL 固定 `bots.qq.com/app/getAppAccessToken`。QQ 入站 Gateway 也应独立审视其基础域名与实际 `GET /gateway` 响应，而非由出站域名直接推断。
- **证据等级**：**H** — 官方页面的历史与较新条目存在版本分歧；先验不能宣称官方 2026 一律强制更换或 timestamp 仅允许整数。静态可确定**无有效 `id` 的 2xx 必须不能冒充成功**，**数值 `code` 不可遗漏**。
- **修复边界**：以官方可访问的当版 `api-call-guide`、`access-token`、实际 message API 规范明确兼容域名和成功字段；不得借此静态研究调用 provider API 验证网络、也不得私自修改用户现有 host 和 IP 白名单。群通知默认配置与群控制权限是两回事。
- **对照链接**：[腾讯维护的旧版 README § IP 白名单及接口域名](https://github.com/tencent-connect/bot-docs/blob/main/docs/README.md)、[2026 QQ wiki API 调用指南（此次正文不可达）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[2026 QQ wiki 凭证指南（此次正文不可达）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)。查阅：2026-10-31。
