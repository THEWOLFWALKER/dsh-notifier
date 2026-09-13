# dsh-notifier knowledge base

这是人类和 agent 的导航页。每个问题尽量只指向一个权威来源；运行时真相仍是 `src/` 与 `test/`，版本真相是 `package.json`。

## 当前基线

- 当前发布线：`codex/mobile-task-loop-v010`，包版本字段 `0.10.0`（手机接管 DSH 任务闭环：宿主能力桥 + 原生提问桥 + Web-first 升级 + 任务路由 + 图片输入 + 管理台任务/宿主状态）；上一线 `codex/pr22-issue23-fix`（v0.9.7）已发布 2026-09-12。公共 GitHub 源码镜像（`main`）随本发布线同步，npm registry `latest` 待 `0.10.0` 发布。
- 当前测试：`1605`（1605 pass，v0.10.0 发布基线）。历史 npm `0.8.6` 契约为 909、`0.9.0` 为 1352、v0.9.5 为 1531、v0.9.6 为 1544、v0.9.7 为 1548；按版本区分。
- 私有 `dsh-notifier-dev` 是工程协作仓库；公共 GitHub 仓库只是发布/源码镜像。
- 生态收录：公开仓库描述/发现主题已按 v0.9.0 更新；Awesome DSH PR #3490 已提交，dshfind 等待下一轮目录同步。
- Node.js ESM、Node `>=22`、无生产依赖、无构建步骤；27 个出站渠道，Telegram/Feishu/QQ Bot/WxPusher/WeChat iLink/DingTalk 六个入站控制通道。
- Web 管理台是唯一控制台，绑定 `127.0.0.1` 并使用 Bearer token；YAML 是高级/自动化入口。个人模式流程是配置通道 → 配对/扫码 → 测试发送 → 日常审批与 `ask_user`。
- Web/admin 的问题 choose/reject 已接 Control Core；desktop `ask_user` 没有安全宿主接口，不能声称桌面结算或双端共享。真机、provider 和 DSH 宿主协议验证仍未完成。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：边界、工作流、验证命令。
2. [memory/README.md](memory/README.md) 与 [memory/project-state.md](memory/project-state.md)：当前事实和发布门。
3. [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)：安装与能力概览。
4. [guide.md](guide.md)：从安装、开启管理台到个人模式、配对、测试通知和日常使用。
5. [architecture.md](architecture.md) / [architecture-roadmap.md](architecture-roadmap.md)：已实现架构与规划方向（规划不等于已发布）。
6. [OPERATIONS.md](OPERATIONS.md) / [VERSIONING.md](VERSIONING.md)：运维、验证和发布规则。
7. [protocol-preflight/](protocol-preflight/) / [security/](security/) / [compatibility-matrix.md](compatibility-matrix.md)：协议、安全与兼容性证据。
8. [HANDOFF.md](../HANDOFF.md)：当前交接快照；[CHANGELOG.md](../CHANGELOG.md)：变更历史。

## 能力与安全摘要

- 出站统一经 adapter/spec 层，通知分为 `timeSensitive`、`active`、`passive`；入站审批、会话、问题共享 Control Core、token vault、身份绑定、来源聊天校验和首达结算。
- 身份至少按 `(channel,userId)` 隔离，携带账号/聊天时精确匹配 `(channel,accountId,userId,chatId)`。未知来源、缺关键字段、错误 token、过期或异常均 fail-closed。
- QQ C2C 按钮与 GROUP 文本 fallback、QQ/WeChat iLink/DingTalk 图片 envelope 属于 contract-tested；文件/媒体和 provider payload、重连、回调 ACK 仍是 `declared` 或未验证，禁止写成真机支持。
- `ctx.notifier` facade 具有冻结消费面、来源标签清洗、有限调用/字节/并发/队列预算；这些是支持路径约束，不是同进程插件的 OS 隔离边界。

## 权威规则

- 文档与源码冲突时先查源码和测试，再在同一变更中修文档。记忆文件保持短小、使用绝对日期，不记录聊天流水账。
- `docs/agent-taskpacks/` 只保留历史协作索引，不是当前执行入口；已完成旧 taskpack 与旧真机测试笔记已清理。
- 状态写入必须保留无关 key、使用现有锁/合并行为，且不在日志/API 暴露凭证。公共仓库不作为开发 relay。
