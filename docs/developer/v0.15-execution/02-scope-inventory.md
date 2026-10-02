# 范围清单：个人 vs 群用途（WP00 / WP07 输入）

本清单是 WP00 交付的“全目录个人/群用途表”初版，用于给 WP07（私聊准入与群功能退出）界定
**退出面**。判定只依据当前源码中可核对的证据；无法确证的渠道/字段标 `待 WP07 确认`，
不猜、不预判为“群专用”。

## 1. 入站控制通道（6 条，单一事实来源 `src/inbound/channels-registry.mjs:12`）

| 通道 | 展示名 | 连接 | 目标形态 | 退出动作 |
|---|---|---|---|---|
| `telegram` | Telegram | long-poll | 私聊（`chat.type=private`） | 群/未知来源拒绝，仅私聊进主路径 |
| `feishu` | 飞书 | WS | P2P | 群 `open_chat_id` 路径拒绝 |
| `qq` | QQ | WS | C2C | 群事件不触发业务；C2C 保留 |
| `wxpusher` | WxPusher | callback | UID 一对一；Topic 为广播 | Topic/广播入口退出，UID 保留 |
| `wechat` | 微信 iLink | long-poll | 一对一 | 群 item 拒绝 |
| `dingtalk` | 钉钉 | WS | 单聊 | 群会话拒绝 |

群敏感交互（审批/提问卡片）本就限定单聊（`capability-matrix.mjs:16-18` 注释），
退出后按钮化审批/提问只保留单聊来源校验路径。

## 2. 出站适配器（28 个，`src/adapters/spec-channels.mjs` / `capability-matrix.mjs:234`）

按**已核对的源码证据**分类；未取证的一律标“待确认”，不在 WP00 下结论。

| 类别 | 适配器 | 证据/说明 |
|---|---|---|
| 个人可直发 | `bark` `bell` `desktop` `pushplus` `serverchan` `chanify` `gotify` `ntfy` `pushdeer` `igot` `xizhi` | 个人推送端点，保留 |
| 个人/群双模 | `qmsg`（`group` 留空=单聊）、`pushover`（user 或 group key）、`onebot`（`messageType: private/group`）、`telegram`、`feishu`、`qq-bot`、`wxpusher`、`dingtalk`、`wecom-app` | 保留私聊语义，群语义退出/拒绝 |
| 仅群用途（拟退出） | `wecom`（企业微信群机器人 webhook，`spec-channels.mjs:173,177`）、`wps-bot`（WPS 协作群机器人，`spec-channels.mjs:464-511`） | 群机器人 webhook 仅能发到群；退出内建入口 |
| 待确认 | `discord` `slack` `teams` `gchat` `mattermost` `webhook` | 团队/空间平台且有 DM 能力，是否“仅群用途”需 WP07 逐适配器核对；`webhook` 按交接包只作**用户明确配置的个人接收端**，不提供群模板/集成 |

“28”是当前计数，不是要固守的目标；退出后能力目录由**实际清理结果**重新生成
（`scripts/gen-channel-matrix.mjs`）。

## 3. 群/Topic 代码退出面（grep 证据，逐文件处置属 WP07）

- `群|group|chatType|open_chat_id` 在 `src/` 命中约 500 处、38 个文件；
- `Topic|topic` 在 `src/` 命中约 59 处、13 个文件。

高命中、需重点处置的文件包括：`src/inbound/qq-gw.mjs`(57)、`src/inbound/feishu-bot.mjs`(43)、
`src/inbound/qq-gw.mjs`、`src/questions/router.mjs`(25)、`src/control/session-arbiter.mjs`(26)、
`src/security/network-policy.mjs`(26)、`src/inbound/target-guard.mjs`(20)、`src/inbound/commands.mjs`(21)、
`src/adapters/spec-channels.mjs`(64)、`src/config.mjs`(14)、`src/admin/ui/strings.mjs`(28)、
`src/inbound/dingtalk-stream.mjs`(6，含 topic)、`src/adapters/wxpusher.mjs`(8，含 Topic)。

WP07 逐个确认哪些是：
1. 必须删除的**群业务/群目标/群 UI**；
2. 只需保留的**拒绝/停用迁移**（fail-closed 拒绝分支、旧群配置迁移为 disabled/quarantined）；
3. 与群无关的误命中（如 `group` 仅表示聚合分组、`topic` 仅表示消息主题），不得误删。

## 4. 明确不做（范围外）

群聊、完整聊天客户端、强制多 bot UI、新自更新器、自研 Cloudflare OAuth、全面数据库化、
群 webhook 模板/集成。

## 5. 边界保留

- 邮件/本地桌面等**个人**通知渠道不因“不是 IM”而被误删。
- 通用 Webhook 仅作个人接收端；不扫描任意远端去“证明”其是否群发。
- 安全来源未知的控制入口（如不可信来源的 WxPusher UID 远控）关闭并标注外部证据缺口。

> 完成标准（WP07）：群事件/未知类型/群目标/Topic 均无业务触发、出站拒绝、迁移停用；
> 本地/私聊路径与个人渠道不受影响。逐适配器结论与证据补入 `ledger/audit-ledger.csv`。