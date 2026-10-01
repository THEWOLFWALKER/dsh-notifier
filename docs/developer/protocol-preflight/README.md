# 协议预审索引（阶段 0）

查询日期：2026-08-27。此目录是后续实现的事实边界，不等于已支持声明。`documented` 仅表示来源页面明确写出；`contract-tested` 仅表示仓库测试覆盖；`declared` 必须保持安全 fallback，不能在发布说明中写成真机支持。

| 渠道 | 协议文档 | 当前 runtime 映射 | 现有测试 | 待实现 seam / 验收 | 禁止事项 |
|---|---|---|---|---|---|
| QQ Bot | [qq-bot.md](qq-bot.md)；QQ 官方页面 | `src/inbound/qq-gw.mjs`, `src/adapters/qq-bot.mjs` | `test/inbound.qq.test.mjs`, `test/approval.qq-buttons.test.mjs` | 真实 WS/ACK、频控、文件 TTL、撤回；跑 focused + `npm test` | 旧 Token、泄露 secret、群按钮替代文本、来源缺失放行 |
| Telegram | [telegram.md](telegram.md)；[Bot API](https://core.telegram.org/bots/api) | `src/inbound/telegram-bot.mjs`, `src/channels/telegram/`, `src/adapters/telegram.mjs` | `test/channels/telegram.test.mjs`, `test/inbound.telegram.test.mjs`, `test/adapters.test.mjs` | webhook secret、429、4096/64-byte 边界、文件真机 | 截断 callback token、bot token 当 accountId、无限重试 |
| 飞书 | [feishu.md](feishu.md)；开放平台动态文档 | `src/inbound/feishu-bot.mjs`, `src/channels/feishu/`, `src/adapters/feishu.mjs` | `test/channels/feishu.test.mjs`, `test/inbound.feishu.test.mjs`, `test/adapters.test.mjs` | 租户验签/加密、Card Kit 限制、文件权限、真实回调 | 未验签入 Control Core、猜测卡片字段、宣称 fileSend |
| 微信 iLink | [wechat-ilink.md](wechat-ilink.md)；社区逆向线索 | `src/channels/wechat-ilink/`, `src/inbound/_ilink-api.mjs` | `test/channels/wechat-ilink.test.mjs`, `test/inbound.wechat.test.mjs` | QR/节点、35s 长轮询、stale token、图片/文件/撤回真机 | 未知 QR 当成功、先推进 cursor、跨账号 token、把 declared 标正式 |
| 钉钉 Stream | [dingtalk.md](dingtalk.md)；dingtalk-stream 2.1.4/2.1.6-beta.1/2.1.7-beta.1 三版源码核对 | `src/inbound/dingtalk-stream.mjs` | `test/inbound.dingtalk.test.mjs` | 真机 10 分钟长连（ping 周期、60s 重推消失、ack 被接受、SYSTEM 帧 topic 字段裁决） | 顶层 messageId 契约、requestId 头字段名、裸 'ack' data、把 SDK 源码核对结论改回猜测 |

## 实现映射规则

1. 先在对应文档确认字段和证据等级，再修改 provider；仅 `documented` 或已有 `contract-tested` 字段可进入归一化白名单。
2. 所有回调先做来源 `(channel, accountId, userId, chatId)` 校验，再交 Control Core；缺字段、签名失败、未知 action、超时都 fail-closed。
3. 出站按现有 `src/` adapter 合约返回可观测失败；超时/429 仅有限重试，成功后不重复发送。卡片/按钮/文件失败必须回退文本，不得阻断其它渠道。
4. 新限制需 protocol-level 或真实设备证据；mock fetch 不能升级能力等级。完成后运行 focused tests、`npm test`、`node scripts/verify-release.mjs`、`node scripts/gen-channel-matrix.mjs --check`、`node --check src/index.mjs`。

## Fixture 约定

`test/fixtures/channels/` 中的 JSON 只保存官方示例或明确标注脱敏/社区来源的协议片段；不得放真实 token、用户 ID、图片 URL 签名或 state 文件。Fixture 不是能力声明，新增字段必须在对应文档记录来源 URL、标题、查询日期、证据摘录与适用版本。
