# dsh-notifier knowledge base

这是人类和 agent 的导航页。每个问题尽量只指向一个权威来源；运行时真相仍是 `src/` 与 `test/`，版本真相是 `package.json`。

## 当前基线

- 当前发布候选线：`codex/stage5-wechat-ilink-hardening`，包版本字段 `0.9.0`，尚未发布。
- 当前测试：`1352`（1351 pass + 1 skip）。历史 npm `0.8.6` 契约为 909；两者按版本区分。
- 私有 `dsh-notifier-dev` 是工程协作仓库；公共 GitHub 仓库只是发布/源码镜像。
- Node.js ESM、Node `>=22`、无生产依赖、无构建步骤；27 个出站渠道，Telegram/Feishu/QQ Bot/WxPusher/WeChat iLink/DingTalk 六个入站控制通道。
- Web 管理台是唯一控制台，绑定 `127.0.0.1` 并使用 Bearer token；YAML 是高级/自动化入口。个人模式流程是配置通道 → 配对/扫码 → 测试发送 → 日常审批与 `ask_user`。
- Web/admin 的问题 choose/reject 已接 Control Core；desktop `ask_user` 没有安全宿主接口，不能声称桌面结算或双端共享。真机、provider 和 DSH 宿主协议验证仍未完成。

## 阅读顺序

1. [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)：安装与能力概览。
2. [guide.md](guide.md)：从安装、开启管理台到个人模式、配对、测试通知和日常使用。
3. [architecture.md](architecture.md) / [architecture-roadmap.md](architecture-roadmap.md)：已实现架构与规划方向（规划不等于已发布）。
4. [OPERATIONS.md](OPERATIONS.md) / [VERSIONING.md](VERSIONING.md)：运维、验证和发布规则。
5. [compatibility-matrix.md](compatibility-matrix.md)：渠道能力与边界。
6. [HANDOFF.md](../HANDOFF.md)：当前交接快照；[CHANGELOG.md](../CHANGELOG.md)：变更历史。

## 能力与安全摘要

- 出站统一经 adapter/spec 层，通知分为 `timeSensitive`、`active`、`passive`；入站审批、会话、问题共享 Control Core、token vault、身份绑定、来源聊天校验和首达结算。
- 身份至少按 `(channel,userId)` 隔离，携带账号/聊天时精确匹配 `(channel,accountId,userId,chatId)`。未知来源、缺关键字段、错误 token、过期或异常均 fail-closed。
- QQ C2C 按钮与 GROUP 文本 fallback、QQ/WeChat iLink/DingTalk 图片 envelope 属于 contract-tested；文件/媒体和 provider payload、重连、回调 ACK 仍是 `declared` 或未验证，禁止写成真机支持。
- `ctx.notifier` facade 具有冻结消费面、来源标签清洗、有限调用/字节/并发/队列预算；这些是支持路径约束，不是同进程插件的 OS 隔离边界。

## 权威规则

- 文档与源码冲突时先查源码和测试，再在同一变更中修文档。记忆文件保持短小、使用绝对日期，不记录聊天流水账。
- 状态写入必须保留无关 key、使用现有锁/合并行为，且不在日志/API 暴露凭证。公共仓库不作为开发 relay。
