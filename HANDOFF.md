# dsh-notifier 当前交接快照

更新时间：2026-08-27。当前发布候选线是 `codex/stage5-wechat-ilink-hardening`，包版本字段为 `0.9.0`。最新完整测试为 `1352`（1351 pass + 1 skip）；历史 npm `0.8.6` 契约为 909。

| 测试 | `npm test`：**1352 tests**（1351 pass + 1 skip，v0.9.0 发布候选） |

## 下一位开发者从这里开始

1. 项目地图见 [docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)。
2. 用户操作从 [docs/guide.md](docs/guide.md) 开始；运维和发布冒烟见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。
3. 稳定模块和数据流见 [docs/architecture.md](docs/architecture.md)，渠道边界见 [docs/compatibility-matrix.md](docs/compatibility-matrix.md)。
4. 版本/发布规则见 [docs/VERSIONING.md](docs/VERSIONING.md)；升级步骤见双语升级指南。

## 产品与架构现状

- Node.js ESM（Node `>=22`），无生产依赖、无构建步骤；27 个出站渠道由统一 adapter/spec 层装配。
- 入站控制通道为 Telegram、Feishu、QQ Bot、WxPusher、WeChat iLink、DingTalk。通知、审批、会话输入和 `ask_user` 共享状态、路由、账本与 Control Core。
- 身份是 `(channel, userId)` 绑定；涉及账号/聊天时继续精确匹配 `(channel, accountId, userId, chatId)`。未绑定、来源冲突、未知 `chatType`、缺关键来源字段均默认拒绝。
- Web 管理台是唯一控制台，且只监听 `127.0.0.1`、使用 Bearer token。个人模式首屏引导配置通道、配对成员、测试发送；会话/绑定等高级项按需展开。YAML 是高级/自动化入口，不是第二套控制台。
- Web/admin 已有脱敏问题列表及 choose/reject 结算（`/api/questions`、`/api/questions/:ref/settle`），结算始终经过 Control Core。桌面 `ask_user` 没有安全宿主接口，因此不得声称 desktop 可结算或已有双端共享；超时/失败必须交还桌面，绝不代答。

## 已完成范围（代码/契约证据）

- Control Core/session arbiter 已覆盖 token 单次核销、来源/会话/聊天精确绑定、首达采纳、竞态与失效 fail-closed；团队审批成员为有界精确三元组。
- Session control overlay 已经由 registry、router 和 loopback admin 持久化并做字段/来源隔离、记录级合并、拷贝读取和持久化失败传播；管理台只返回脱敏摘要。
- Telegram/Feishu provider facade、QQ C2C 按钮与 GROUP 文本 fallback、WeChat iLink/DingTalk 图片 envelope、WxPusher 本地 `accountId`、回调容量和插件 facade 边界均已契约测试。
- 已移除将 channel 名伪作 accountId 的兜底；Telegram/Feishu 直接按钮回调带 provider eventId；问题编号回复的账号透传和成功回执已修正。
- 管理台个人模式首屏、加载/空态/错误/禁用/窄屏/破坏性确认状态已覆盖 focused tests。所有通知渠道故障应隔离，不得阻塞启动或其他渠道。

## 不可越过的安全红线

- 入站默认拒绝；身份和回调必须绑定原始 channel/account/user/chat。token 有时限且单次使用，错误来源、异常、超时、畸形输入都回到桌面。
- Control Core 是审批与提问的唯一授权/结算边界；管理台不能直写答案或账本。`notifyAll().delivered` 只能说明渠道级结果，不能证明具体聊天送达。
- 凭证、token、完整用户/聊天/agent 标识不得出现在日志、API 响应、脱敏快照或 DOM。状态写入必须保留无关 key，并通过现有 store 锁与合并语义。
- `ctx.notifier` 预算、冻结 facade、回调容量和限流只是支持路径上的约束；同进程插件仍是受信边界，不宣称 OS 隔离。内部构造器只从 `dsh-notifier/internal` 暴露。

## 明确残余与验证缺口

- 所有当前证据主要是 mock/contract/seam tests。未完成真实 Telegram/Feishu/QQ/DingTalk/iLink/WxPusher 设备 payload、按钮 ACK、重连、媒体/文件限制和长连接验证；`declared` 能力不得写成正式支持。
- 未完成 DSH 宿主真实事件/桌面 toast（BurntToast/PowerShell）验证；桌面 `ask_user` 没有安全宿主接口。管理台真实浏览器操作、宿主重启读取 overlay、真实 provider 回调仍待做。
- npm registry 接受/干净 disposable profile 安装仍是发布门；工程树与 npm archive 若不一致，以工程树为准并记录差异。多 WxPusher 应用必须配置不同本地 `accountId`，否则共享 `default` 命名空间。

## 发布前步骤

```text
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
npm pack --dry-run --json
```

确认干净工作树、版本/测试数与 [docs/VERSIONING.md](docs/VERSIONING.md) 一致后，在 disposable DSH profile 安装 registry artifact，验证启动装配、一次出站测试和一次入站命令，再发布对应版本。

## 当前提交入口

继续开发前以源码和测试为准；当前长期方向仍是个人模式优先的跨 IM control-plane 路线图，详见 [docs/architecture-roadmap.md](docs/architecture-roadmap.md)。
